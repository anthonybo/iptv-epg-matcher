/**
 * TheSportsDB free-tier adapter (api key "3" — public/educational tier).
 *
 * Fills gaps in ESPN coverage. ESPN doesn't cover cricket leagues like
 * IPL/PSL/Big Bash, has spotty international soccer beyond the top
 * European leagues, and basically nothing for handball/snooker/darts/
 * netball. TheSportsDB has all of these.
 *
 * Free tier limitations:
 *   - eventsday.php returns scheduled events for a given date + sport
 *   - NO live scores (paid tier only) — we get the matchup but not
 *     the running score
 *   - 30-second rate limit between calls is courteous
 *
 * What we do with this:
 *   - Fetch yesterday + today + tomorrow per sport so the rolling
 *     event window matches our 3-hour refresh cadence
 *   - Mark events as `source = 'sportsdb'` so the orchestrator can
 *     dedupe against ESPN events on canonicalKey
 *   - Mark them as is_live based on (now within startTime + duration)
 *     since we don't have a real live signal
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const BASE_URL = 'https://www.thesportsdb.com/api/v1/json/3';

// Sports to fetch from TheSportsDB. These are the gap fills — sports
// ESPN handles poorly or not at all. Keep narrow to avoid duplicates
// with ESPN; the orchestrator dedups by canonicalKey anyway, but a
// scoped list is cheaper.
const SPORTS = [
    'Cricket',
    'Handball',
    'Snooker',
    'Darts',
    'Netball',
    'Table Tennis',
    'Squash',
    'Badminton',
    'Ice Hockey',          // duplicates ESPN NHL but covers KHL, SHL, Liiga, etc.
    'Basketball',          // duplicates NBA but covers EuroLeague, ACB, etc.
];

// Estimate event duration per sport so we can derive is_live without
// a live-score endpoint. Padded generously — better to flag a stale
// event as still-live than miss a real live one.
const SPORT_DURATION_HOURS = {
    Cricket: 5,        // T20 ~3.5h, ODI ~8h, Test all day — average it
    Handball: 2,
    Snooker: 4,
    Darts: 3,
    Netball: 1.5,
    'Table Tennis': 1.5,
    Squash: 1.5,
    Badminton: 1.5,
    'Ice Hockey': 3,
    Basketball: 2.5,
};
const DEFAULT_DURATION_HOURS = 3;

function todayDateStrings() {
    const now = new Date();
    const out = [];
    for (let offset = -1; offset <= 1; offset++) {
        const d = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}

async function fetchEventsForSportOnDate(sport, dateStr) {
    const url = `${BASE_URL}/eventsday.php?d=${dateStr}&s=${encodeURIComponent(sport)}`;
    try {
        const resp = await axios.get(url, { timeout: 8000 });
        return Array.isArray(resp.data?.events) ? resp.data.events : [];
    } catch (e) {
        if (e.response?.status !== 404) {
            logger.debug(`[TheSportsDB] ${sport} ${dateStr}: ${e.message}`);
        }
        return [];
    }
}

function normaliseEvent(raw, sportName) {
    const home = raw.strHomeTeam || '';
    const away = raw.strAwayTeam || '';
    if (!home || !away || !raw.strTimestamp) return null;

    const startTime = raw.strTimestamp.includes('Z')
        ? raw.strTimestamp
        : `${raw.strTimestamp}Z`;
    const startMs = new Date(startTime).getTime();
    if (isNaN(startMs)) return null;

    const durationH = SPORT_DURATION_HOURS[sportName] || DEFAULT_DURATION_HOURS;
    const endTime = new Date(startMs + durationH * 60 * 60 * 1000).toISOString();

    const homeScore = raw.intHomeScore != null ? parseInt(raw.intHomeScore, 10) : null;
    const awayScore = raw.intAwayScore != null ? parseInt(raw.intAwayScore, 10) : null;

    return {
        sourceEventId: `sportsdb_${raw.idEvent}`,
        canonicalId: canonicalKey({
            sport: sportName,
            home,
            away,
            startTime,
        }),
        sourceName: 'sportsdb',
        eventName: raw.strEvent || `${home} vs ${away}`,
        sportType: sportName,
        leagueName: raw.strLeague || sportName,
        homeTeam: home,
        awayTeam: away,
        eventStart: startTime,
        eventEnd: endTime,
        homeScore: Number.isFinite(homeScore) ? homeScore : null,
        awayScore: Number.isFinite(awayScore) ? awayScore : null,
        broadcasts: [],   // free tier has no broadcaster info
        // No live score endpoint — derive isLive from time window. The
        // orchestrator may overwrite this if another source confirms.
        isLive: Date.now() >= startMs && Date.now() <= startMs + durationH * 60 * 60 * 1000,
        statusType: null,
        gameClock: null,
        gameStatus: null,
    };
}

async function fetchEvents() {
    const dateStrs = todayDateStrings();
    const all = [];

    // Sequential per sport (TheSportsDB asks for ≥1 req/30s but in
    // practice tolerates much more — still keep sequential to be a
    // good citizen). Within a sport we do all 3 dates in parallel.
    for (const sport of SPORTS) {
        try {
            const perDate = await Promise.all(
                dateStrs.map((d) => fetchEventsForSportOnDate(sport, d))
            );
            const flat = perDate.flat();
            const normalised = flat.map((e) => normaliseEvent(e, sport)).filter(Boolean);
            if (normalised.length > 0) {
                logger.info(`[TheSportsDB] ${sport}: ${normalised.length} events across ${dateStrs.length} days`);
            }
            all.push(...normalised);
        } catch (e) {
            logger.warn(`[TheSportsDB] Error fetching ${sport}: ${e.message}`);
        }
    }

    return all;
}

module.exports = {
    name: 'sportsdb',
    sports: SPORTS,
    enabled: () => true,
    fetchEvents,
};
