/**
 * TheSportsDB free-tier adapter (api key "3" — public/educational tier).
 *
 * Fills gaps in ESPN coverage. ESPN doesn't cover cricket leagues like
 * IPL/PSL/Big Bash, has spotty international soccer beyond the top
 * European leagues, and basically nothing for handball/snooker/darts/
 * netball. TheSportsDB has all of these.
 *
 * Endpoints we use (all free-tier):
 *   - eventsday.php?d=YYYY-MM-DD&s=Sport — schedule for a sport on a day
 *   - eventstv.php?d=YYYY-MM-DD          — broadcasters for ALL events
 *     on a day, every sport. Returns up to ~hundreds of records per
 *     day with idEvent → strChannel + strCountry, batch-friendly.
 *   - lookuptv.php?id=<idEvent>          — broadcasters for one event,
 *     used as a per-event fallback when the daily prefetch missed.
 *
 * What we do with this:
 *   - Fetch yesterday + today + tomorrow per sport so the rolling
 *     event window matches our 3-hour refresh cadence
 *   - Prefetch broadcasters for the whole window once per refresh via
 *     eventstv.php (costs 3 HTTP calls total instead of N per-event
 *     lookuptv.php calls)
 *   - Stitch the broadcaster lookup back into normaliseEvent() so the
 *     emitted events carry broadcasts[] = strChannel-list. The
 *     downstream search-channel matcher already handles broadcasts[]
 *     just like it does ESPN's `broadcasts` field.
 *   - Mark as is_live based on (now within startTime + duration) since
 *     the free tier has no live-score endpoint. Orchestrator may
 *     overwrite this if a more authoritative source confirms.
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

/**
 * Fetch ALL broadcaster records for a given date across every sport
 * via eventstv.php?d=YYYY-MM-DD. Returns a Map keyed by idEvent
 * (string, no `sportsdb_` prefix) → array of {channel, country}
 * objects. Multiple broadcasters per event are common (one per
 * region) and we keep all of them — the matcher will pick whichever
 * the user's IPTV lineup actually carries.
 *
 * The free-tier endpoint is Cloudflare-rate-limited (HTTP 429 / 1015
 * "you are being rate limited"). We surface that distinctly so the
 * caller can back off, and the upsert in liveEventsService preserves
 * existing broadcasts on empty payload — so a 1015 here is annoying
 * but not destructive.
 */
async function fetchBroadcastersForDate(dateStr) {
    const url = `${BASE_URL}/eventstv.php?d=${dateStr}`;
    const map = new Map();
    try {
        const resp = await axios.get(url, {
            timeout: 8000,
            // Cloudflare returns the 1015 message as a text/plain body
            // with HTTP 200 sometimes — guard against bad JSON.
            transformResponse: [(data) => {
                if (typeof data === 'string' && data.startsWith('error code:')) return { __rateLimited: true };
                try { return JSON.parse(data); } catch { return null; }
            }]
        });
        if (resp.data?.__rateLimited) {
            logger.warn(`[TheSportsDB] eventstv ${dateStr}: rate-limited (1015) — broadcasters skipped this tick`);
            return map;
        }
        const records = Array.isArray(resp.data?.tvevents) ? resp.data.tvevents : [];
        for (const r of records) {
            if (!r.idEvent || !r.strChannel) continue;
            const list = map.get(r.idEvent) || [];
            list.push({
                channel: String(r.strChannel).trim(),
                country: r.strCountry ? String(r.strCountry).trim() : null
            });
            map.set(r.idEvent, list);
        }
        if (map.size > 0) {
            logger.info(`[TheSportsDB] eventstv ${dateStr}: ${records.length} TV records → ${map.size} unique events`);
        }
    } catch (e) {
        if (e.response?.status === 429) {
            logger.warn(`[TheSportsDB] eventstv ${dateStr}: rate-limited (429)`);
        } else if (e.response?.status !== 404) {
            logger.debug(`[TheSportsDB] eventstv ${dateStr}: ${e.message}`);
        }
    }
    return map;
}

/**
 * Per-event fallback when the daily prefetch missed an event (which
 * happens for some long-tail leagues). Rate-limited to 1 req/sec by
 * the calling code via Promise serialisation. Cached in-memory for
 * the life of the request.
 */
async function fetchBroadcastersForEvent(idEvent, cache) {
    if (cache.has(idEvent)) return cache.get(idEvent);
    const url = `${BASE_URL}/lookuptv.php?id=${encodeURIComponent(idEvent)}`;
    try {
        const resp = await axios.get(url, {
            timeout: 6000,
            transformResponse: [(data) => {
                if (typeof data === 'string' && data.startsWith('error code:')) return { __rateLimited: true };
                try { return JSON.parse(data); } catch { return null; }
            }]
        });
        if (resp.data?.__rateLimited) {
            cache.set(idEvent, []);
            return [];
        }
        const records = Array.isArray(resp.data?.tvevent) ? resp.data.tvevent : [];
        const list = records
            .filter((r) => r.strChannel)
            .map((r) => ({
                channel: String(r.strChannel).trim(),
                country: r.strCountry ? String(r.strCountry).trim() : null
            }));
        cache.set(idEvent, list);
        return list;
    } catch (e) {
        cache.set(idEvent, []);
        return [];
    }
}

function normaliseEvent(raw, sportName, broadcasters = []) {
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
        // Broadcaster names from eventstv/lookuptv (may be empty for
        // events the free tier doesn't track).
        broadcasts: broadcasters.map((b) => b.channel),
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

    // Step 1: Prefetch broadcasters for the whole 3-day window in
    // parallel. Three HTTP calls vs N per-event lookuptv.php calls.
    const tvMaps = await Promise.all(dateStrs.map(fetchBroadcastersForDate));
    // Merge per-day maps into a single idEvent → broadcasts list.
    const broadcastersByEventId = new Map();
    for (const m of tvMaps) {
        for (const [k, v] of m.entries()) {
            const existing = broadcastersByEventId.get(k) || [];
            // Dedupe by channel name (events sometimes show up on two
            // adjacent dates if scheduled near midnight UTC).
            const merged = [...existing];
            for (const entry of v) {
                if (!merged.some((e) => e.channel === entry.channel)) merged.push(entry);
            }
            broadcastersByEventId.set(k, merged);
        }
    }

    // Step 2: Per-sport fetch the schedule (existing behaviour).
    const all = [];
    const perEventCache = new Map();
    let perEventLookups = 0;

    for (const sport of SPORTS) {
        try {
            const perDate = await Promise.all(
                dateStrs.map((d) => fetchEventsForSportOnDate(sport, d))
            );
            const flat = perDate.flat();
            const normalised = [];
            for (const raw of flat) {
                let broadcasters = broadcastersByEventId.get(raw.idEvent) || [];
                // Per-event fallback only if the daily prefetch missed
                // this id AND the event is happening "soon" (within the
                // is_live window of now). Avoids wasting RPS on past
                // events that nobody will click anyway.
                if (broadcasters.length === 0 && raw.strTimestamp) {
                    const startMs = new Date(
                        raw.strTimestamp.includes('Z') ? raw.strTimestamp : `${raw.strTimestamp}Z`
                    ).getTime();
                    const dur = (SPORT_DURATION_HOURS[sport] || DEFAULT_DURATION_HOURS) * 60 * 60 * 1000;
                    const isWithinLiveWindow =
                        Date.now() >= startMs && Date.now() <= startMs + dur;
                    if (isWithinLiveWindow && perEventLookups < 30) {
                        broadcasters = await fetchBroadcastersForEvent(raw.idEvent, perEventCache);
                        perEventLookups++;
                        // Conservative spacing to respect ~2 RPS soft cap.
                        await new Promise((r) => setTimeout(r, 600));
                    }
                }
                const ev = normaliseEvent(raw, sport, broadcasters);
                if (ev) normalised.push(ev);
            }
            if (normalised.length > 0) {
                const withBroadcasters = normalised.filter((e) => e.broadcasts.length > 0).length;
                logger.info(`[TheSportsDB] ${sport}: ${normalised.length} events (${withBroadcasters} with broadcasters)`);
            }
            all.push(...normalised);
        } catch (e) {
            logger.warn(`[TheSportsDB] Error fetching ${sport}: ${e.message}`);
        }
    }

    if (perEventLookups > 0) {
        logger.info(`[TheSportsDB] per-event broadcaster lookups: ${perEventLookups}`);
    }

    return all;
}

module.exports = {
    name: 'sportsdb',
    sports: SPORTS,
    enabled: () => true,
    fetchEvents,
};
