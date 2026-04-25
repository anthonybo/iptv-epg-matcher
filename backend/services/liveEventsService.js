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

// Sports to fetch from ESPN.
//
// Each entry probed against site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard.
// In-season endpoints return events; off-season ones return zero events
// without erroring, so it's safe to keep them all year. Each new entry
// costs one HTTP request per refresh tick (every 3h + on startup).
const SPORTS_TO_FETCH = [
  // American Football
  { sport: 'football', league: 'nfl', name: 'NFL' },
  { sport: 'football', league: 'college-football', name: 'NCAAF' },

  // Basketball
  { sport: 'basketball', league: 'nba', name: 'NBA' },
  { sport: 'basketball', league: 'wnba', name: 'WNBA' },
  { sport: 'basketball', league: 'mens-college-basketball', name: 'NCAAB' },
  { sport: 'basketball', league: 'womens-college-basketball', name: 'WCAAB' },
  { sport: 'basketball', league: 'nbl', name: 'NBL (Australia)' },
  { sport: 'basketball', league: 'euroleague', name: 'EuroLeague' },
  { sport: 'basketball', league: 'eurocup', name: 'EuroCup' },

  // Hockey
  { sport: 'hockey', league: 'nhl', name: 'NHL' },
  { sport: 'hockey', league: 'mens-college-hockey', name: 'NCAA Men\'s Hockey' },
  { sport: 'hockey', league: 'womens-college-hockey', name: 'NCAA Women\'s Hockey' },
  { sport: 'hockey', league: 'ahl', name: 'AHL' },

  // Baseball / Softball
  { sport: 'baseball', league: 'mlb', name: 'MLB' },
  { sport: 'baseball', league: 'college-baseball', name: 'College Baseball' },
  { sport: 'baseball', league: 'college-world-series', name: 'College World Series' },
  { sport: 'baseball', league: 'world-baseball-classic', name: 'World Baseball Classic' },
  { sport: 'softball', league: 'college-softball', name: 'College Softball' },
  { sport: 'softball', league: 'college-womens-college-world-series', name: 'WCWS' },
  { sport: 'softball', league: 'usssa-pro', name: 'USSSA Pro Softball' },

  // Soccer — Domestic top flights
  { sport: 'soccer', league: 'usa.1', name: 'MLS' },
  { sport: 'soccer', league: 'usa.2', name: 'USL Championship' },
  { sport: 'soccer', league: 'usa.nwsl', name: 'NWSL' },
  { sport: 'soccer', league: 'usa.ncaa.m.1', name: 'NCAA Men\'s Soccer' },
  { sport: 'soccer', league: 'usa.ncaa.w.1', name: 'NCAA Women\'s Soccer' },
  { sport: 'soccer', league: 'usa.open', name: 'US Open Cup' },
  { sport: 'soccer', league: 'eng.1', name: 'Premier League' },
  { sport: 'soccer', league: 'eng.2', name: 'EFL Championship' },
  { sport: 'soccer', league: 'eng.3', name: 'EFL League One' },
  { sport: 'soccer', league: 'eng.fa', name: 'FA Cup' },
  { sport: 'soccer', league: 'eng.league_cup', name: 'EFL Cup' },
  { sport: 'soccer', league: 'esp.1', name: 'La Liga' },
  { sport: 'soccer', league: 'esp.2', name: 'La Liga 2' },
  { sport: 'soccer', league: 'esp.copa_del_rey', name: 'Copa del Rey' },
  { sport: 'soccer', league: 'ger.1', name: 'Bundesliga' },
  { sport: 'soccer', league: 'ger.2', name: '2. Bundesliga' },
  { sport: 'soccer', league: 'ger.dfb_pokal', name: 'DFB Pokal' },
  { sport: 'soccer', league: 'ita.1', name: 'Serie A' },
  { sport: 'soccer', league: 'ita.2', name: 'Serie B' },
  { sport: 'soccer', league: 'ita.coppa_italia', name: 'Coppa Italia' },
  { sport: 'soccer', league: 'fra.1', name: 'Ligue 1' },
  { sport: 'soccer', league: 'fra.2', name: 'Ligue 2' },
  { sport: 'soccer', league: 'fra.coupe_de_france', name: 'Coupe de France' },
  { sport: 'soccer', league: 'ned.1', name: 'Eredivisie' },
  { sport: 'soccer', league: 'por.1', name: 'Primeira Liga' },
  { sport: 'soccer', league: 'sco.1', name: 'Scottish Premiership' },
  { sport: 'soccer', league: 'bel.1', name: 'Belgian Pro League' },
  { sport: 'soccer', league: 'aut.1', name: 'Austrian Bundesliga' },
  { sport: 'soccer', league: 'swi.1', name: 'Swiss Super League' },
  { sport: 'soccer', league: 'turkey.1', name: 'Turkish Süper Lig' },
  { sport: 'soccer', league: 'rus.1', name: 'Russian Premier League' },
  { sport: 'soccer', league: 'mex.1', name: 'Liga MX' },
  { sport: 'soccer', league: 'mex.2', name: 'Ascenso MX' },
  { sport: 'soccer', league: 'arg.1', name: 'Argentine Primera' },
  { sport: 'soccer', league: 'bra.1', name: 'Brasileirão Série A' },
  { sport: 'soccer', league: 'bra.2', name: 'Brasileirão Série B' },
  { sport: 'soccer', league: 'aus.1', name: 'A-League' },
  { sport: 'soccer', league: 'jpn.1', name: 'J League' },
  { sport: 'soccer', league: 'kor.1', name: 'K League' },
  { sport: 'soccer', league: 'chn.1', name: 'Chinese Super League' },
  { sport: 'soccer', league: 'sau.1', name: 'Saudi Pro League' },
  { sport: 'soccer', league: 'uae.1', name: 'UAE Pro League' },
  { sport: 'soccer', league: 'qat.1', name: 'Qatar Stars League' },

  // Soccer — Continental / international
  { sport: 'soccer', league: 'uefa.champions', name: 'Champions League' },
  { sport: 'soccer', league: 'uefa.europa', name: 'Europa League' },
  { sport: 'soccer', league: 'uefa.europa.conf', name: 'Europa Conference League' },
  { sport: 'soccer', league: 'uefa.nations', name: 'UEFA Nations League' },
  { sport: 'soccer', league: 'uefa.euro', name: 'UEFA Euro' },
  { sport: 'soccer', league: 'fifa.world', name: 'FIFA World Cup' },
  { sport: 'soccer', league: 'fifa.womens.world', name: 'FIFA Women\'s World Cup' },
  { sport: 'soccer', league: 'fifa.cwc', name: 'FIFA Club World Cup' },
  { sport: 'soccer', league: 'conmebol.libertadores', name: 'Copa Libertadores' },
  { sport: 'soccer', league: 'conmebol.sudamericana', name: 'Copa Sudamericana' },
  { sport: 'soccer', league: 'concacaf.champions', name: 'Concacaf Champions Cup' },
  { sport: 'soccer', league: 'concacaf.gold', name: 'Gold Cup' },

  // Combat Sports
  { sport: 'mma', league: 'ufc', name: 'UFC' },
  { sport: 'mma', league: 'pfl', name: 'PFL' },
  { sport: 'mma', league: 'bellator', name: 'Bellator' },
  { sport: 'boxing', league: '', name: 'Boxing' },
  { sport: 'wrestling', league: '', name: 'Wrestling' },

  // Golf
  { sport: 'golf', league: 'pga', name: 'PGA Tour' },
  { sport: 'golf', league: 'lpga', name: 'LPGA Tour' },
  { sport: 'golf', league: 'european-tour', name: 'DP World Tour' },
  { sport: 'golf', league: 'champions-tour', name: 'PGA Champions Tour' },
  { sport: 'golf', league: 'korn-ferry', name: 'Korn Ferry Tour' },
  { sport: 'golf', league: 'liv-golf', name: 'LIV Golf' },
  { sport: 'golf', league: 'the-masters', name: 'The Masters' },
  { sport: 'golf', league: 'the-open', name: 'The Open Championship' },
  { sport: 'golf', league: 'us-open', name: 'US Open Golf' },
  { sport: 'golf', league: 'pga-championship', name: 'PGA Championship' },

  // Tennis
  { sport: 'tennis', league: 'atp', name: 'ATP' },
  { sport: 'tennis', league: 'wta', name: 'WTA' },
  { sport: 'tennis', league: 'atp-doubles', name: 'ATP Doubles' },
  { sport: 'tennis', league: 'wta-doubles', name: 'WTA Doubles' },
  { sport: 'tennis', league: 'mens-grand-slam', name: 'Men\'s Grand Slam' },
  { sport: 'tennis', league: 'womens-grand-slam', name: 'Women\'s Grand Slam' },

  // Motorsports
  { sport: 'racing', league: 'f1', name: 'Formula 1' },
  { sport: 'racing', league: 'irl', name: 'IndyCar' },
  { sport: 'racing', league: 'nascar-premier', name: 'NASCAR Cup' },
  { sport: 'racing', league: 'nascar-secondary', name: 'NASCAR Xfinity' },
  { sport: 'racing', league: 'nascar-truck', name: 'NASCAR Truck' },
  { sport: 'racing', league: 'nhra', name: 'NHRA' },
  { sport: 'racing', league: 'motogp', name: 'MotoGP' },
  { sport: 'racing', league: 'formula-e', name: 'Formula E' },

  // Lacrosse
  { sport: 'lacrosse', league: 'mens-college-lacrosse', name: 'NCAA Men\'s Lacrosse' },
  { sport: 'lacrosse', league: 'womens-college-lacrosse', name: 'NCAA Women\'s Lacrosse' },
  { sport: 'lacrosse', league: 'pll', name: 'Premier Lacrosse League' },
  { sport: 'lacrosse', league: 'nll', name: 'National Lacrosse League' },

  // Volleyball
  { sport: 'volleyball', league: 'mens-college-volleyball', name: 'NCAA Men\'s Volleyball' },
  { sport: 'volleyball', league: 'womens-college-volleyball', name: 'NCAA Women\'s Volleyball' },
  { sport: 'volleyball', league: 'pvf', name: 'Pro Volleyball Federation' },
  { sport: 'volleyball', league: 'lovb', name: 'League One Volleyball' },

  // Rugby
  { sport: 'rugby', league: 'super-rugby', name: 'Super Rugby' },
  { sport: 'rugby', league: 'world-rugby', name: 'World Rugby' },
  { sport: 'rugby', league: '180659', name: 'Six Nations' },
  { sport: 'rugby-league', league: 'nrl', name: 'NRL' },

  // Cricket
  { sport: 'cricket', league: 'ipl', name: 'IPL' },
  { sport: 'cricket', league: 'big-bash', name: 'Big Bash' },
  { sport: 'cricket', league: 'world-cup', name: 'Cricket World Cup' },
  { sport: 'cricket', league: 'eng.county-championship', name: 'County Championship' },

  // Australian Rules
  { sport: 'australian-football', league: 'afl', name: 'AFL' },
  { sport: 'australian-football', league: 'aflw', name: 'AFLW' },

  // Field Hockey
  { sport: 'field-hockey', league: 'mens-college-field-hockey', name: 'NCAA Men\'s Field Hockey' },
  { sport: 'field-hockey', league: 'womens-college-field-hockey', name: 'NCAA Women\'s Field Hockey' },

  // Olympics
  { sport: 'olympics', league: 'summer', name: 'Summer Olympics' },
  { sport: 'olympics', league: 'winter', name: 'Winter Olympics' },

  // Horse Racing
  { sport: 'horse-racing', league: 'horse-racing', name: 'Horse Racing' },
  { sport: 'horse-racing', league: 'triple-crown', name: 'Triple Crown' },

  // Esports
  { sport: 'esports', league: 'esports', name: 'Esports' },
];

/**
 * Fetch events from ESPN API for a specific sport/league
 * @param {string} sport - Sport type (e.g., 'football', 'basketball', 'hockey')
 * @param {string} league - League code (e.g., 'nfl', 'nba', 'nhl')
 * @returns {Promise<Array>} Array of events
 */
async function fetchEventsFromESPN(sport, league) {
  try {
    // A few endpoints (boxing, wrestling) don't have a league component.
    // ESPN 404s on the double-slash form, so skip the league segment.
    const url = league
      ? `${ESPN_BASE_URL}/${sport}/${league}/scoreboard`
      : `${ESPN_BASE_URL}/${sport}/scoreboard`;
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
    'softball': 'Softball',
    'mma': 'MMA',
    'boxing': 'Boxing',
    'wrestling': 'Wrestling',
    'golf': 'Golf',
    'tennis': 'Tennis',
    'racing': 'Racing',
    'lacrosse': 'Lacrosse',
    'volleyball': 'Volleyball',
    'rugby': 'Rugby',
    'rugby-league': 'Rugby League',
    'cricket': 'Cricket',
    'australian-football': 'Australian Football',
    'field-hockey': 'Field Hockey',
    'olympics': 'Olympics',
    'horse-racing': 'Horse Racing',
    'esports': 'Esports'
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
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const homeTeam = competitors.find(c => c.homeAway === 'home');
  const awayTeam = competitors.find(c => c.homeAway === 'away');

  const homeTeamName = homeTeam?.team?.displayName || 'Unknown';
  const awayTeamName = awayTeam?.team?.displayName || 'Unknown';

  // Parse event time (ESPN uses ISO 8601 format)
  const eventDate = event.date; // ISO 8601 string
  const eventStartUTC = new Date(eventDate);

  // ESPN ships an explicit endDate for multi-day events (golf
  // tournaments, F1 race weekends, tennis tournaments, etc.). For
  // single-game team sports it's omitted. Without honoring it we used
  // start+3h for a 4-day golf tournament — which puts event_end days
  // in the past, and the cleanup `DELETE WHERE event_end < oneDayAgo`
  // immediately nukes the row. That's why PGA / LPGA / tennis stayed
  // missing from the ticker even though `Found 1 events for PGA` was
  // in the logs.
  const eventEndUTC = event.endDate
    ? new Date(event.endDate)
    : new Date(eventStartUTC.getTime() + (3 * 60 * 60 * 1000));

  // Broadcasters airing the game. Two ESPN fields can carry it; merge
  // and dedupe.  Examples: "ESPN", "ESPN+", "B1G+", "ACC Extra", "TBS".
  // This is what lets the search-channel matcher target the actual
  // network without playing fuzzy-match roulette against team names.
  const broadcasts = new Set();
  for (const b of competition?.broadcasts || []) {
    for (const n of b.names || []) {
      if (n) broadcasts.add(String(n).trim());
    }
  }
  for (const g of competition?.geoBroadcasts || []) {
    const name = g?.media?.shortName || g?.media?.callLetters;
    if (name) broadcasts.add(String(name).trim());
  }

  return {
    event_id: `espn_${event.id}`,
    event_name: event.name || `${homeTeamName} vs ${awayTeamName}`,
    sport_type: getSportDisplayName(sportType),
    league_name: leagueName,
    home_team: homeTeamName,
    away_team: awayTeamName,
    event_start: eventStartUTC.toISOString(),
    event_end: eventEndUTC.toISOString(),
    source: 'espn',
    broadcasts: Array.from(broadcasts)
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
                (event_id, event_name, sport_type, league_name, home_team, away_team, event_start, event_end, source, broadcasts, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
                ON CONFLICT (event_id) DO UPDATE SET
                  event_name = EXCLUDED.event_name,
                  sport_type = EXCLUDED.sport_type,
                  league_name = EXCLUDED.league_name,
                  home_team = EXCLUDED.home_team,
                  away_team = EXCLUDED.away_team,
                  event_start = EXCLUDED.event_start,
                  event_end = EXCLUDED.event_end,
                  source = EXCLUDED.source,
                  broadcasts = EXCLUDED.broadcasts,
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
                parsed.source,
                parsed.broadcasts
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
  isProgramLive,
  SPORTS_TO_FETCH
};
