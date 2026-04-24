/**
 * Live Events Service
 * Fetches live sports events from external APIs and stores them in database
 *
 * Primary source: TheSportsDB API (https://www.thesportsdb.com/)
 * Fallback options:
 * - ESPN API: http://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
 * - GitHub sports schedule repos (various)
 */

const axios = require('axios');
const logger = require('../config/logger');
const postgresService = require('./postgresService');

// ESPN API configuration (unofficial but reliable, no auth required)
const ESPN_BASE_URL = 'http://site.api.espn.com/apis/site/v2/sports';

// Sports to fetch from ESPN
const SPORTS_TO_FETCH = [
  // American Football
  { sport: 'football', league: 'nfl', name: 'NFL' },
  { sport: 'football', league: 'college-football', name: 'NCAAF' },

  // Basketball
  { sport: 'basketball', league: 'nba', name: 'NBA' },
  { sport: 'basketball', league: 'mens-college-basketball', name: 'NCAAB' },
  { sport: 'basketball', league: 'womens-college-basketball', name: 'WCAAB' },
  { sport: 'basketball', league: 'wnba', name: 'WNBA' },

  // Hockey
  { sport: 'hockey', league: 'nhl', name: 'NHL' },

  // Soccer (expanded)
  { sport: 'soccer', league: 'eng.1', name: 'Premier League' },
  { sport: 'soccer', league: 'usa.1', name: 'MLS' },
  { sport: 'soccer', league: 'esp.1', name: 'La Liga' },
  { sport: 'soccer', league: 'ger.1', name: 'Bundesliga' },
  { sport: 'soccer', league: 'ita.1', name: 'Serie A' },
  { sport: 'soccer', league: 'fra.1', name: 'Ligue 1' },
  { sport: 'soccer', league: 'uefa.champions', name: 'Champions League' },
  { sport: 'soccer', league: 'uefa.europa', name: 'Europa League' },
  { sport: 'soccer', league: 'mex.1', name: 'Liga MX' },
  { sport: 'soccer', league: 'eng.2', name: 'EFL Championship' },
  { sport: 'soccer', league: 'ned.1', name: 'Eredivisie' },
  { sport: 'soccer', league: 'por.1', name: 'Primeira Liga' },

  // Combat Sports (Note: Boxing not supported by ESPN API)
  { sport: 'mma', league: 'ufc', name: 'UFC' },

  // Golf
  { sport: 'golf', league: 'pga', name: 'PGA' },
  { sport: 'golf', league: 'lpga', name: 'LPGA' },

  // Tennis
  { sport: 'tennis', league: 'atp', name: 'ATP' },
  { sport: 'tennis', league: 'wta', name: 'WTA' },

  // Baseball
  { sport: 'baseball', league: 'mlb', name: 'MLB' },
  { sport: 'baseball', league: 'college-baseball', name: 'College Baseball' },

  // Motorsports
  { sport: 'racing', league: 'f1', name: 'Formula 1' },
  { sport: 'racing', league: 'irl', name: 'IndyCar' },

  // College Sports
  { sport: 'lacrosse', league: 'mens-college-lacrosse', name: 'NCAA Men\'s Lacrosse' },
  { sport: 'volleyball', league: 'womens-college-volleyball', name: 'NCAA Women\'s Volleyball' },

  // Other Sports
  { sport: 'australian-football', league: 'afl', name: 'AFL' },
];

/**
 * Fetch events from ESPN API for a specific sport/league
 * @param {string} sport - Sport type (e.g., 'football', 'basketball', 'hockey')
 * @param {string} league - League code (e.g., 'nfl', 'nba', 'nhl')
 * @returns {Promise<Array>} Array of events
 */
async function fetchEventsFromESPN(sport, league) {
  try {
    const url = `${ESPN_BASE_URL}/${sport}/${league}/scoreboard`;
    logger.info(`Fetching events from ESPN: ${url}`);

    const response = await axios.get(url, { timeout: 10000 });

    if (response.data && response.data.events) {
      return response.data.events;
    }

    return [];
  } catch (error) {
    logger.error(`Error fetching ${league.toUpperCase()} events from ESPN:`, {
      message: error.message,
      status: error.response?.status
    });
    return [];
  }
}

/**
 * Get display name for sport type
 * @param {string} sport - Sport type from ESPN (e.g., 'football', 'soccer', 'basketball')
 * @returns {string} Display name (e.g., 'Football', 'Soccer', 'Basketball')
 */
function getSportDisplayName(sport) {
  const sportMap = {
    'football': 'Football',
    'basketball': 'Basketball',
    'hockey': 'Hockey',
    'soccer': 'Soccer',
    'baseball': 'Baseball',
    'mma': 'MMA',
    'golf': 'Golf',
    'tennis': 'Tennis',
    'racing': 'Racing',
    'lacrosse': 'Lacrosse',
    'volleyball': 'Volleyball',
    'australian-football': 'Australian Football'
  };
  return sportMap[sport] || sport;
}

/**
 * Parse ESPN event to our format
 * @param {object} event - Event from ESPN API
 * @param {string} sportType - Sport type (e.g., 'football', 'soccer')
 * @param {string} leagueName - League name (e.g., 'NFL', 'Premier League')
 * @returns {object} Parsed event
 */
function parseESPNEvent(event, sportType, leagueName) {
  // Extract team names from the event
  const competitors = event.competitions?.[0]?.competitors || [];
  const homeTeam = competitors.find(c => c.homeAway === 'home');
  const awayTeam = competitors.find(c => c.homeAway === 'away');

  const homeTeamName = homeTeam?.team?.displayName || 'Unknown';
  const awayTeamName = awayTeam?.team?.displayName || 'Unknown';

  // Parse event time (ESPN uses ISO 8601 format)
  const eventDate = event.date; // ISO 8601 string
  const eventStartUTC = new Date(eventDate);

  // Estimate end time based on sport type (3 hours for most sports)
  const eventEndUTC = new Date(eventStartUTC.getTime() + (3 * 60 * 60 * 1000));

  return {
    event_id: `espn_${event.id}`,
    event_name: event.name || `${homeTeamName} vs ${awayTeamName}`,
    sport_type: getSportDisplayName(sportType),
    league_name: leagueName,
    home_team: homeTeamName,
    away_team: awayTeamName,
    event_start: eventStartUTC.toISOString(),
    event_end: eventEndUTC.toISOString(),
    source: 'espn'
  };
}

/**
 * Fetch and store live events from ESPN
 * ESPN API returns events for today and upcoming games
 * @returns {Promise<object>} Stats about fetched events
 */
async function refreshLiveEvents() {
  try {
    logger.info('Starting live events refresh from ESPN API');

    const today = new Date();
    let totalFetched = 0;
    let totalStored = 0;
    let errors = 0;

    // Fetch events for each sport (no rate limiting needed for ESPN)
    for (const { sport, league, name } of SPORTS_TO_FETCH) {
      try {
        const events = await fetchEventsFromESPN(sport, league);

        if (events && events.length > 0) {
          totalFetched += events.length;
          logger.info(`Found ${events.length} events for ${name}`);

          // Store each event in database
          for (const event of events) {
            try {
              const parsed = parseESPNEvent(event, sport, name);

              // Insert or update event in PostgreSQL
              await postgresService.query(`
                INSERT INTO live_events
                (event_id, event_name, sport_type, league_name, home_team, away_team, event_start, event_end, source, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
                ON CONFLICT (event_id) DO UPDATE SET
                  event_name = EXCLUDED.event_name,
                  sport_type = EXCLUDED.sport_type,
                  league_name = EXCLUDED.league_name,
                  home_team = EXCLUDED.home_team,
                  away_team = EXCLUDED.away_team,
                  event_start = EXCLUDED.event_start,
                  event_end = EXCLUDED.event_end,
                  source = EXCLUDED.source,
                  updated_at = CURRENT_TIMESTAMP
              `, [
                parsed.event_id,
                parsed.event_name,
                parsed.sport_type,
                parsed.league_name,
                parsed.home_team,
                parsed.away_team,
                parsed.event_start,
                parsed.event_end,
                parsed.source
              ]);

              totalStored++;
            } catch (storeError) {
              logger.error(`Error storing event ${event.id}:`, storeError.message);
              errors++;
            }
          }
        } else {
          logger.info(`No events found for ${name}`);
        }
      } catch (sportError) {
        logger.error(`Error fetching ${name}:`, sportError.message);
        errors++;
      }
    }

    // Clean up old events (remove events that ended more than 1 day ago)
    const oneDayAgo = new Date(today.getTime() - (24 * 60 * 60 * 1000)).toISOString();
    await postgresService.query(`
      DELETE FROM live_events WHERE event_end < $1
    `, [oneDayAgo]);

    logger.info(`Live events refresh complete: fetched=${totalFetched}, stored=${totalStored}, errors=${errors}`);

    return {
      success: true,
      totalFetched,
      totalStored,
      errors
    };
  } catch (error) {
    logger.error('Error refreshing live events:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get currently live events from database
 * @returns {Promise<Array>} Array of currently live events
 */
async function getCurrentlyLiveEvents() {
  try {
    const now = new Date().toISOString();

    // "Live" = either inside the advertised time window OR ESPN says
    // `is_live = TRUE`. Needed because:
    //   - MLS and other soccer routinely run past event_end (stoppage
    //     + halftime often push 2h+); our stored event_end is an
    //     estimate, so the ticker (which reads is_live directly from
    //     ESPN's scoreboard) would keep showing the game live while
    //     this query already dropped it.
    //   - Inverse happens too: games go in-progress slightly before
    //     our stored event_start during pregame transitions.
    //
    // Boundary guard: don't let `is_live = TRUE` pull in rows that
    // finished hours ago (stale ESPN flag) — clamp to a reasonable
    // window via event_end >= NOW − 30 min as a safety net.
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    // status_type gate prevents stale `is_live = TRUE` after ESPN has
    // already moved the event into STATUS_FINAL from lingering in the
    // ticker / live-events page for the 30 min after actual final.
    const result = await postgresService.query(`
      SELECT * FROM live_events
      WHERE ((event_start <= $1 AND event_end >= $2)
          OR (is_live = TRUE AND event_end >= $3))
        AND (status_type IS NULL OR status_type NOT LIKE '%FINAL%')
      ORDER BY event_start
    `, [now, now, halfHourAgo]);

    return result.rows || [];
  } catch (error) {
    logger.error('Error getting currently live events:', error);
    return [];
  }
}

/**
 * Check if a program title matches any currently live event
 * @param {string} programTitle - Program title to check
 * @returns {Promise<boolean>} True if matches a live event
 */
async function isProgramLive(programTitle) {
  try {
    const liveEvents = await getCurrentlyLiveEvents();

    if (!liveEvents || liveEvents.length === 0) {
      return false;
    }

    const titleLower = programTitle.toLowerCase();

    // Check if program title contains both team names from any live event
    for (const event of liveEvents) {
      const homeTeamLower = (event.home_team || '').toLowerCase();
      const awayTeamLower = (event.away_team || '').toLowerCase();

      if (homeTeamLower && awayTeamLower &&
          titleLower.includes(homeTeamLower) &&
          titleLower.includes(awayTeamLower)) {
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error('Error checking if program is live:', error);
    return false;
  }
}

/**
 * Get all events from database (not just currently live)
 * @returns {Promise<Array>} Array of all events
 */
async function getAllEvents() {
  try {
    const result = await postgresService.query(`
      SELECT
        event_id,
        event_name,
        sport_type,
        league_name,
        home_team,
        away_team,
        event_start,
        event_end,
        source
      FROM live_events
      ORDER BY event_start
    `);

    return result.rows || [];
  } catch (error) {
    logger.error('Error fetching all events from database:', error);
    return [];
  }
}

module.exports = {
  refreshLiveEvents,
  getCurrentlyLiveEvents,
  getAllEvents,
  isProgramLive
};
