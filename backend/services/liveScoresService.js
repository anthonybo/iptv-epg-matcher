/**
 * Live Scores Service
 * Fetches and updates live scores from ESPN scoreboard API
 * Runs as a background job to keep scores updated every 30 seconds
 */

const axios = require('axios');
const logger = require('../config/logger');
const postgresService = require('./postgresService');
const { SPORTS_TO_FETCH } = require('./liveEventsService');

// ESPN API configuration
const ESPN_BASE_URL = 'http://site.api.espn.com/apis/site/v2/sports';

// Source of truth lives in liveEventsService — these two used to be two
// hand-maintained copies and drifted, causing leagues like NCAA Lacrosse,
// AFL, EFL Championship, IndyCar etc. to be inserted into live_events
// (by the events service) but never have their is_live flag flipped
// (because this service didn't know about them). Reuse the same list.
const SPORTS_CONFIG = SPORTS_TO_FETCH;

// Background update interval reference
let updateInterval = null;
let isUpdating = false;

// Adaptive polling - slow down when no live games
let currentIntervalMs = 30000;
const FAST_INTERVAL_MS = 30000;  // 30 seconds when games are live
const SLOW_INTERVAL_MS = 300000; // 5 minutes when no games are live
let consecutiveNoLiveGames = 0;
const SLOW_DOWN_THRESHOLD = 3; // Switch to slow mode after 3 updates with no live games

/**
 * Parse ESPN status to user-friendly format
 * @param {object} status - ESPN status object
 * @param {object} competition - ESPN competition object
 * @returns {object} Parsed status info
 */
function parseGameStatus(status, competition) {
  const statusType = status?.type?.name || 'STATUS_SCHEDULED';
  const statusState = status?.type?.state || 'pre';
  const statusDescription = status?.type?.description || 'Scheduled';
  const clock = status?.displayClock || '';
  const period = status?.period || 0;

  let gameStatus = statusDescription;
  let gameClock = '';
  let isLive = false;

  // Determine if game is live based on state
  if (statusState === 'in') {
    isLive = true;

    // Build game clock based on sport type
    if (clock && period) {
      // Format varies by sport
      gameClock = `${clock} - P${period}`;
    } else if (clock) {
      gameClock = clock;
    } else if (period) {
      gameClock = `Period ${period}`;
    }
  } else if (statusState === 'post') {
    gameStatus = 'Final';
    isLive = false;
  } else if (statusState === 'pre') {
    gameStatus = 'Scheduled';
    isLive = false;
  }

  return {
    statusType,
    gameStatus,
    gameClock,
    isLive
  };
}

/**
 * Fetch scores from ESPN for a specific sport/league
 * @param {string} sport - Sport type
 * @param {string} league - League code
 * @returns {Promise<Array>} Array of score updates
 */
async function fetchScoresFromESPN(sport, league) {
  try {
    // Match liveEventsService — boxing/wrestling have no league segment.
    const url = league
      ? `${ESPN_BASE_URL}/${sport}/${league}/scoreboard`
      : `${ESPN_BASE_URL}/${sport}/scoreboard`;

    const response = await axios.get(url, { timeout: 8000 });

    if (!response.data || !response.data.events) {
      return [];
    }

    const scoreUpdates = [];

    for (const event of response.data.events) {
      const competition = event.competitions?.[0];
      if (!competition) continue;

      const competitors = competition.competitors || [];
      const homeTeam = competitors.find(c => c.homeAway === 'home');
      const awayTeam = competitors.find(c => c.homeAway === 'away');

      const homeScore = homeTeam?.score ? parseInt(homeTeam.score, 10) : null;
      const awayScore = awayTeam?.score ? parseInt(awayTeam.score, 10) : null;

      const statusInfo = parseGameStatus(competition.status, competition);

      scoreUpdates.push({
        eventId: `espn_${event.id}`,
        homeScore,
        awayScore,
        gameStatus: statusInfo.gameStatus,
        gameClock: statusInfo.gameClock,
        statusType: statusInfo.statusType,
        isLive: statusInfo.isLive
      });
    }

    return scoreUpdates;
  } catch (error) {
    // Only log errors for non-404s (some leagues may not have active games)
    if (error.response?.status !== 404) {
      logger.debug(`Error fetching scores for ${sport}/${league}:`, error.message);
    }
    return [];
  }
}

/**
 * Update scores in database for all sports
 * @returns {Promise<object>} Update statistics
 */
async function updateAllScores() {
  // Prevent concurrent updates
  if (isUpdating) {
    logger.debug('Score update already in progress, skipping...');
    return { skipped: true };
  }

  isUpdating = true;
  const startTime = Date.now();

  try {
    // Fetch scores for all sports in parallel (batched to avoid overwhelming ESPN)
    const allUpdates = [];
    const batchSize = 5;
    for (let i = 0; i < SPORTS_CONFIG.length; i += batchSize) {
      const batch = SPORTS_CONFIG.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(({ sport, league }) => fetchScoresFromESPN(sport, league))
      );
      for (const scoreUpdates of results) allUpdates.push(...scoreUpdates);
    }

    // Single batched UPDATE instead of one query per event. Previously
    // 436 events × ~50ms per round-trip = 22-32s, which overlapped the
    // 30s polling interval and starved every other DB consumer (search,
    // ticker, etc.). With unnest() arrays this collapses to one query
    // that runs in well under a second.
    let totalUpdated = 0;
    let liveGames = 0;
    if (allUpdates.length > 0) {
      const eventIds   = allUpdates.map((u) => u.eventId);
      const homeScores = allUpdates.map((u) => u.homeScore);
      const awayScores = allUpdates.map((u) => u.awayScore);
      const statuses   = allUpdates.map((u) => u.gameStatus);
      const clocks     = allUpdates.map((u) => u.gameClock);
      const stypes     = allUpdates.map((u) => u.statusType);
      const isLives    = allUpdates.map((u) => Boolean(u.isLive));

      const result = await postgresService.query(`
        UPDATE live_events AS le
        SET
          home_score        = data.home_score,
          away_score        = data.away_score,
          game_status       = data.game_status,
          game_clock        = data.game_clock,
          status_type       = data.status_type,
          is_live           = data.is_live,
          scores_updated_at = CURRENT_TIMESTAMP
        FROM (
          SELECT * FROM unnest(
            $1::text[], $2::int[], $3::int[], $4::text[],
            $5::text[], $6::text[], $7::boolean[]
          ) AS u(event_id, home_score, away_score, game_status, game_clock, status_type, is_live)
        ) AS data
        WHERE le.event_id = data.event_id
        RETURNING le.event_id, le.is_live
      `, [eventIds, homeScores, awayScores, statuses, clocks, stypes, isLives]);

      totalUpdated = result.rowCount || 0;
      liveGames = (result.rows || []).filter((r) => r.is_live === true).length;
    }

    const duration = Date.now() - startTime;
    logger.info(`Scores updated: ${totalUpdated} events, ${liveGames} live games (${duration}ms)`);

    // Adaptive polling: adjust interval based on whether there are live games
    if (liveGames > 0) {
      consecutiveNoLiveGames = 0;
      if (currentIntervalMs !== FAST_INTERVAL_MS) {
        currentIntervalMs = FAST_INTERVAL_MS;
        restartWithNewInterval();
        logger.info(`[Scores] Live games detected, switching to fast polling (${FAST_INTERVAL_MS/1000}s)`);
      }
    } else {
      consecutiveNoLiveGames++;
      if (consecutiveNoLiveGames >= SLOW_DOWN_THRESHOLD && currentIntervalMs !== SLOW_INTERVAL_MS) {
        currentIntervalMs = SLOW_INTERVAL_MS;
        restartWithNewInterval();
        logger.info(`[Scores] No live games, switching to slow polling (${SLOW_INTERVAL_MS/1000}s)`);
      }
    }

    return {
      success: true,
      totalUpdated,
      liveGames,
      duration
    };
  } catch (error) {
    logger.error('Error updating scores:', error);
    return {
      success: false,
      error: error.message
    };
  } finally {
    isUpdating = false;
  }
}

/**
 * Restart the background updates with a new interval
 * Used for adaptive polling
 */
function restartWithNewInterval() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      updateAllScores();
    }, currentIntervalMs);
  }
}

/**
 * Get all live games with scores
 * @returns {Promise<Array>} Array of live games with scores
 */
async function getLiveScores() {
  try {
    // Strict: only games actually in-play right now. is_live=TRUE is
    // the source of truth — the score updater flips it based on
    // ESPN's state field. Anti-stale guard: event_end >= NOW − 30 min
    // so a forgotten is_live=TRUE from a game that ended hours ago
    // can't linger. STATUS_FINAL gate trims the half-hour stale
    // window for events ESPN has already moved to FINAL.
    //
    // Why not the wider "advertised-window OR is_live" predicate the
    // top-bar route used to use? Because that pulled multi-day
    // tournaments (PGA, LPGA, WTA, F1 weekends) into the ticker even
    // between rounds — Round 2 finishes Friday night, Round 3 starts
    // Saturday morning, but the 4-day window has the tournament
    // showing as "live" the whole time. Top-bar predicate was
    // tightened in the same change to match this strict version.
    const result = await postgresService.query(`
      SELECT
        event_id,
        event_name,
        sport_type,
        league_name,
        home_team,
        away_team,
        home_score,
        away_score,
        game_status,
        game_clock,
        is_live,
        event_start,
        scores_updated_at
      FROM live_events
      WHERE is_live = TRUE
        AND event_end >= NOW() - INTERVAL '30 minutes'
        AND (status_type IS NULL OR status_type NOT LIKE '%FINAL%')
      ORDER BY sport_type, league_name, event_start
    `);

    return result.rows || [];
  } catch (error) {
    logger.error('Error fetching live scores:', error);
    return [];
  }
}

/**
 * Get scores for a specific event
 * @param {string} eventId - Event ID
 * @returns {Promise<object|null>} Score data or null
 */
async function getScoreByEventId(eventId) {
  try {
    const result = await postgresService.query(`
      SELECT
        event_id,
        event_name,
        sport_type,
        league_name,
        home_team,
        away_team,
        home_score,
        away_score,
        game_status,
        game_clock,
        status_type,
        is_live,
        event_start,
        event_end,
        scores_updated_at
      FROM live_events
      WHERE event_id = $1
    `, [eventId]);

    return result.rows[0] || null;
  } catch (error) {
    logger.error(`Error fetching score for ${eventId}:`, error);
    return null;
  }
}

/**
 * Get all events with their current scores (live and recent)
 * @returns {Promise<Array>} Array of events with scores
 */
async function getAllScores() {
  try {
    const result = await postgresService.query(`
      SELECT
        event_id,
        event_name,
        sport_type,
        league_name,
        home_team,
        away_team,
        home_score,
        away_score,
        game_status,
        game_clock,
        status_type,
        is_live,
        event_start,
        event_end,
        scores_updated_at
      FROM live_events
      WHERE event_start >= NOW() - INTERVAL '12 hours'
        AND event_start <= NOW() + INTERVAL '24 hours'
      ORDER BY
        is_live DESC,
        event_start ASC
    `);

    return result.rows || [];
  } catch (error) {
    logger.error('Error fetching all scores:', error);
    return [];
  }
}

/**
 * Start the background score update job
 * @param {number} intervalMs - Update interval in milliseconds (default 30000 = 30s)
 */
function startBackgroundUpdates(intervalMs = 30000) {
  if (updateInterval) {
    logger.warn('Background score updates already running');
    return;
  }

  logger.info(`Starting background score updates (every ${intervalMs / 1000}s)`);

  // Run immediately on start
  updateAllScores();
  cleanupStaleLiveFlags();

  // Then run on interval
  updateInterval = setInterval(() => {
    updateAllScores();
    cleanupStaleLiveFlags();
  }, intervalMs);
}

/**
 * Clean up rows where `is_live = TRUE` but the game actually ended
 * a while ago. ESPN can drop a game off its scoreboard (once final)
 * before our poller runs against it, which leaves the `is_live` flag
 * stuck on for hours or days. Without this sweep, the ticker and
 * summary queries would still surface finished games. Runs on the
 * same interval as the score updater.
 */
async function cleanupStaleLiveFlags() {
  try {
    const { rowCount } = await postgresService.query(`
      UPDATE live_events
         SET is_live = FALSE,
             updated_at = CURRENT_TIMESTAMP
       WHERE is_live = TRUE
         AND event_end < NOW() - INTERVAL '30 minutes'
    `);
    if (rowCount > 0) {
      logger.info(`[LiveScores] Cleaned ${rowCount} stale is_live flags (event_end >30min ago)`);
    }
  } catch (err) {
    logger.warn(`[LiveScores] Stale-flag cleanup failed: ${err.message}`);
  }
}

/**
 * Stop the background score update job
 */
function stopBackgroundUpdates() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    logger.info('Background score updates stopped');
  }
}

/**
 * Check if background updates are running
 * @returns {boolean}
 */
function isBackgroundUpdatesRunning() {
  return updateInterval !== null;
}

module.exports = {
  updateAllScores,
  getLiveScores,
  getScoreByEventId,
  getAllScores,
  startBackgroundUpdates,
  stopBackgroundUpdates,
  isBackgroundUpdatesRunning
};
