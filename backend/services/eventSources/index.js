/**
 * Event-source orchestrator. Runs every enabled adapter in parallel,
 * dedupes the results by canonical_id (SHA1 of sport+teams+startHour),
 * and emits a single merged event list to the caller.
 *
 * Conflict resolution when two sources emit the same canonical_id:
 *   - the first source's metadata is kept (event_name, league, etc.)
 *   - subsequent sources can OVERRIDE live state if their data is
 *     fresher/more authoritative — currently MLB Stats wins for
 *     Baseball, NHL wins for Hockey
 *   - broadcasts are merged across all sources (NHL has good data,
 *     ESPN has good data, union them)
 *   - sourceEventIds are accumulated in `sources` so we know who
 *     contributed
 *
 * To add a new adapter: drop it in this directory exporting
 * `{ name, sports, enabled, fetchEvents }` and add it to ADAPTERS.
 */

const logger = require('../../config/logger');

const espnSource = require('./espnSource');
const theSportsDbSource = require('./theSportsDbSource');
const mlbStatsSource = require('./mlbStatsSource');
const nhlSource = require('./nhlSource');
const footballDataSource = require('./footballDataSource');
const apiSportsSource = require('./apiSportsSource');
const cricApiSource = require('./cricApiSource');
const riotEsportsSource = require('./riotEsportsSource');
const openLigaDbSource = require('./openLigaDbSource');

const ADAPTERS = [
    espnSource,
    theSportsDbSource,
    mlbStatsSource,
    nhlSource,
    openLigaDbSource,
    // env-gated — return [] unless their key is set
    footballDataSource,
    apiSportsSource,
    cricApiSource,
    riotEsportsSource,
];

// For sports where one source is consistently more accurate, prefer
// its live state / score over ESPN's. This map says "for these sports,
// THIS source wins on live-state conflicts".
const SPORT_SOURCE_PRIORITY = {
    Baseball: 'mlbstats',
    Hockey: 'nhl',
};

/**
 * Run every enabled adapter, gather their events, merge by canonical_id.
 * Returns a single array of merged event objects ready for upsert into
 * live_events.
 */
async function fetchAllEvents() {
    const enabled = ADAPTERS.filter((a) => {
        try { return a.enabled(); }
        catch (e) {
            logger.warn(`[EventSources] ${a.name}.enabled() threw: ${e.message}`);
            return false;
        }
    });
    logger.info(`[EventSources] Running ${enabled.length}/${ADAPTERS.length} adapters: ${enabled.map((a) => a.name).join(', ')}`);

    const results = await Promise.all(
        enabled.map(async (a) => {
            const start = Date.now();
            try {
                const events = await a.fetchEvents();
                logger.info(`[EventSources] ${a.name}: ${events?.length || 0} events in ${Date.now() - start}ms`);
                return { name: a.name, events: Array.isArray(events) ? events : [] };
            } catch (e) {
                logger.warn(`[EventSources] ${a.name} threw: ${e.message}`);
                return { name: a.name, events: [] };
            }
        })
    );

    // Merge by canonical_id. First source wins by default; priority
    // sources win for live state.
    const byCanonical = new Map();
    let totalRaw = 0;
    for (const { name, events } of results) {
        for (const e of events) {
            totalRaw++;
            if (!e.canonicalId) {
                // Adapter didn't compute a canonical id — keep it in
                // its own slot (won't dedup). Common for non-team
                // events (golf tournaments, races) where teams aren't
                // a useful key.
                byCanonical.set(`raw:${e.sourceEventId}`, {
                    ...e,
                    sources: [e.sourceEventId],
                });
                continue;
            }

            const existing = byCanonical.get(e.canonicalId);
            if (!existing) {
                byCanonical.set(e.canonicalId, {
                    ...e,
                    sources: [e.sourceEventId],
                });
                continue;
            }

            // Merge. Track every source that emitted this game.
            existing.sources.push(e.sourceEventId);

            // Union broadcasters.
            if (e.broadcasts?.length) {
                const merged = new Set([...(existing.broadcasts || []), ...e.broadcasts]);
                existing.broadcasts = Array.from(merged);
            }

            // Live state: defer to the priority source for this sport.
            const winnerName = SPORT_SOURCE_PRIORITY[e.sportType];
            if (winnerName === e.sourceName) {
                existing.isLive = e.isLive;
                existing.statusType = e.statusType;
                existing.gameClock = e.gameClock || existing.gameClock;
                existing.gameStatus = e.gameStatus || existing.gameStatus;
                if (e.homeScore != null) existing.homeScore = e.homeScore;
                if (e.awayScore != null) existing.awayScore = e.awayScore;
            }
        }
    }

    const merged = Array.from(byCanonical.values());
    logger.info(`[EventSources] Merged ${totalRaw} raw → ${merged.length} unique events (${totalRaw - merged.length} duplicates collapsed)`);
    return merged;
}

module.exports = {
    fetchAllEvents,
    ADAPTERS,
};
