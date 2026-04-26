/**
 * LiveSoccerTV broadcaster enricher.
 *
 * Used as an on-demand fallback in the search-channel route: when a
 * user clicks a soccer event whose `broadcasts` field is empty (ESPN
 * doesn't supply broadcasters for non-major-European soccer, and
 * TheSportsDB's eventstv.php is rate-limited frequently), pivot off
 * LiveSoccerTV's region-aware "what TV channel is this match on"
 * data via the `livesoccertv-parser` npm package.
 *
 * Cached aggressively because:
 *   - LiveSoccerTV is a scraped site; we want to avoid hammering it
 *   - The broadcaster assignment for a given match doesn't change
 *     after the schedule is published
 *
 * Cache key: `${country}:${homeSlug}:${dateYMD}` — matches the
 * granularity of the upstream getMatches() API.
 */

const { getMatches } = require('livesoccertv-parser');
const logger = require('../config/logger');

// League → country mapping. The package expects a country slug.
// Continental and FIFA tournaments are routed to a generic 'world'
// listing (livesoccertv supports 'champions-league' etc. as the team
// slug) but the package's primary mode is country+team.
const LEAGUE_TO_COUNTRY = {
  'Premier League':       'england',
  'EFL Championship':     'england',
  'EFL League One':       'england',
  'FA Cup':               'england',
  'EFL Cup':              'england',
  'La Liga':              'spain',
  'La Liga 2':            'spain',
  'Copa del Rey':         'spain',
  'Bundesliga':           'germany',
  '2. Bundesliga':        'germany',
  'DFB Pokal':            'germany',
  'Serie A':              'italy',
  'Serie B':              'italy',
  'Coppa Italia':         'italy',
  'Ligue 1':              'france',
  'Ligue 2':              'france',
  'Coupe de France':      'france',
  'Eredivisie':           'netherlands',
  'Primeira Liga':        'portugal',
  'Scottish Premiership': 'scotland',
  'Belgian Pro League':   'belgium',
  'Austrian Bundesliga':  'austria',
  'Swiss Super League':   'switzerland',
  'Turkish Süper Lig':    'turkey',
  'Russian Premier League': 'russia',
  'MLS':                  'usa',
  'USL Championship':     'usa',
  'NWSL':                 'usa',
  'US Open Cup':          'usa',
  'Liga MX':              'mexico',
  'Ascenso MX':           'mexico',
  'Argentine Primera':    'argentina',
  'Brasileirão Série A':  'brazil',
  'Brasileirão Série B':  'brazil',
  'A-League':             'australia',
  'J League':             'japan',
  'K League':             'south-korea',
  'Chinese Super League': 'china',
  'Saudi Pro League':     'saudi-arabia',
  'UAE Pro League':       'united-arab-emirates',
  'Qatar Stars League':   'qatar'
};

function teamSlug(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const cache = new Map();
const TTL_MS = 60 * 60 * 1000; // 1 hour
let lastCallAt = 0;
const MIN_INTERVAL_MS = 1000; // 1 RPS courtesy

/**
 * Look up broadcasters for a soccer event by querying LiveSoccerTV.
 * Returns the resolved broadcaster string array, or [] when nothing
 * found / unsupported league / scraping failure. Always resolves
 * within ~3s (request timeout + 1s spacing).
 */
async function lookupSoccerBroadcasters(event) {
  if (!event || event.sportType !== 'Soccer') return [];
  const country = LEAGUE_TO_COUNTRY[event.leagueName];
  if (!country) return [];
  const home = teamSlug(event.homeTeam);
  if (!home) return [];

  const date = (event.eventStart || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const key = `${country}:${home}:${date}`;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && (now - cached.ts) < TTL_MS) {
    return cached.broadcasts;
  }

  // 1 RPS courtesy throttle. Acquire the slot then proceed.
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  try {
    // Wrap getMatches in our own timeout so a slow/hung scrape doesn't
    // block the user's click forever.
    const matches = await Promise.race([
      getMatches(country, home, { timezone: 'UTC' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
    ]);

    if (!Array.isArray(matches) || matches.length === 0) {
      cache.set(key, { ts: now, broadcasts: [] });
      return [];
    }

    // Find the match in the response that matches our event's away
    // team — getMatches returns ALL of `home`'s matches and we want
    // the specific one. Fall back to the first if we can't pinpoint.
    const awayLower = String(event.awayTeam || '').toLowerCase();
    const match =
      matches.find((m) => String(m.game || '').toLowerCase().includes(awayLower)) ||
      matches[0];

    const tvs = Array.isArray(match?.tvs) ? match.tvs.filter(Boolean).map(String) : [];
    cache.set(key, { ts: now, broadcasts: tvs });
    if (tvs.length > 0) {
      logger.info(`[LiveSoccerTV] ${event.homeTeam} vs ${event.awayTeam}: ${tvs.length} broadcasters → ${tvs.slice(0, 5).join(', ')}`);
    }
    return tvs;
  } catch (e) {
    cache.set(key, { ts: now, broadcasts: [] });
    logger.debug(`[LiveSoccerTV] ${country}/${home}: ${e.message}`);
    return [];
  }
}

module.exports = { lookupSoccerBroadcasters, LEAGUE_TO_COUNTRY };
