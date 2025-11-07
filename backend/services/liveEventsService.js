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
const iptvDatabaseService = require('./iptvDatabaseService');

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

    const db = await iptvDatabaseService.connect();
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

              // Insert or replace event
              await new Promise((resolve, reject) => {
                db.run(`
                  INSERT OR REPLACE INTO live_events
                  (event_id, event_name, sport_type, league_name, home_team, away_team, event_start, event_end, source, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
                ], (err) => {
                  if (err) reject(err);
                  else {
                    totalStored++;
                    resolve();
                  }
                });
              });
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
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM live_events WHERE event_end < ?`, [oneDayAgo], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

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
    const db = await iptvDatabaseService.connect();
    const now = new Date().toISOString();

    const events = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM live_events
        WHERE event_start <= ? AND event_end >= ?
        ORDER BY event_start
      `, [now, now], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    return events;
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

module.exports = {
  refreshLiveEvents,
  getCurrentlyLiveEvents,
  isProgramLive
};
