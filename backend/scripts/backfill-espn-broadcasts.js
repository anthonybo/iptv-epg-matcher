#!/usr/bin/env node
/**
 * Backfill ESPN scoreboard history into live_events.broadcasts.
 *
 * The cron-driven liveEventsService only fetches today + ~7 days
 * forward, so the broadcasters table starts thin. This script walks
 * backwards over the last N days (default 30) and forward N/2 days,
 * pulling ESPN's scoreboard with `?dates=YYYYMMDD` for each league
 * we care about. Every event lands in live_events via the normal
 * UPSERT path, which means the broadcaster_match_stats summary at
 * /api/live-events/broadcaster-coverage immediately reflects a much
 * wider sample of broadcaster codes.
 *
 * Usage:
 *   node backend/scripts/backfill-espn-broadcasts.js [--days N] [--leagues LIST]
 *
 *   --days N        How many days back to walk (default 30). Forward
 *                   coverage is automatically added (N/2 ahead).
 *   --leagues LIST  Comma-separated keys (e.g. nhl,nba,mlb,nfl).
 *                   Defaults to all leagues in espnSource.SPORTS_TO_FETCH.
 *
 * The script throttles to CONCURRENCY parallel HTTP requests so we
 * don't hammer ESPN. ESPN's public scoreboard endpoint doesn't appear
 * to rate-limit aggressively but be polite anyway.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const logger = require('../config/logger');
const postgresService = require('../services/postgresService');
const espnSource = require('../services/eventSources/espnSource');

const ESPN_BASE_URL = 'http://site.api.espn.com/apis/site/v2/sports';

// How many ESPN HTTP requests we'll have outstanding at any one time.
// 8 is a comfortable middle: fast enough to do 60 leagues × 45 days in
// a few minutes, slow enough that ESPN doesn't 429 us.
const CONCURRENCY = 8;

function parseArgs() {
    const argv = process.argv.slice(2);
    const args = { days: 30, leagues: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--days' && argv[i + 1]) { args.days = parseInt(argv[i + 1], 10); i += 1; }
        else if (argv[i] === '--leagues' && argv[i + 1]) { args.leagues = argv[i + 1].split(',').map((s) => s.trim().toLowerCase()); i += 1; }
    }
    return args;
}

function ymd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

async function fetchOne(sport, league, dateStr) {
    const url = league
        ? `${ESPN_BASE_URL}/${sport}/${league}/scoreboard?dates=${dateStr}`
        : `${ESPN_BASE_URL}/${sport}/scoreboard?dates=${dateStr}`;
    try {
        const resp = await axios.get(url, { timeout: 10000 });
        return resp.data?.events || [];
    } catch (e) {
        if (e.response?.status !== 404) {
            // 404 is normal — many leagues have no events on a given day
            logger.debug(`[Backfill] ${sport}/${league} ${dateStr}: ${e.message}`);
        }
        return [];
    }
}

// The same UPSERT shape liveEventsService uses, copied here so we don't
// pull in the whole refresh-orchestration loop. Field set must stay in
// sync with liveEventsService.refreshLiveEvents — only the columns
// listed below get written.
async function upsertEvent(e) {
    await postgresService.query(`
        INSERT INTO live_events (
            event_id, event_name, sport_type, league_name,
            home_team, away_team, event_start, event_end,
            source, broadcasts, canonical_id, sources,
            is_live, home_score, away_score, status_type,
            game_clock, game_status, scores_updated_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (event_id) DO UPDATE SET
            event_name  = EXCLUDED.event_name,
            sport_type  = EXCLUDED.sport_type,
            league_name = EXCLUDED.league_name,
            home_team   = EXCLUDED.home_team,
            away_team   = EXCLUDED.away_team,
            event_start = EXCLUDED.event_start,
            event_end   = EXCLUDED.event_end,
            source      = EXCLUDED.source,
            -- Sticky broadcasts: don't wipe out previously-fetched
            -- broadcaster data with an empty fetch.
            broadcasts  = CASE
                WHEN EXCLUDED.broadcasts IS NOT NULL
                     AND array_length(EXCLUDED.broadcasts, 1) > 0
                THEN EXCLUDED.broadcasts
                ELSE live_events.broadcasts
            END,
            canonical_id = EXCLUDED.canonical_id,
            sources      = EXCLUDED.sources,
            -- Don't overwrite is_live/scores from a HISTORICAL backfill
            -- — those are wallclock-relative. The score updater handles
            -- live state separately.
            updated_at   = CURRENT_TIMESTAMP
    `, [
        e.sourceEventId, e.eventName, e.sportType, e.leagueName,
        e.homeTeam, e.awayTeam, e.eventStart, e.eventEnd,
        e.sourceName, e.broadcasts || [], e.canonicalId, e.sources || [e.sourceEventId],
        e.isLive ?? false, e.homeScore ?? null, e.awayScore ?? null, e.statusType ?? null,
        e.gameClock ?? null, e.gameStatus ?? null
    ]);
}

async function main() {
    const args = parseArgs();
    const { SPORTS_TO_FETCH, normaliseEvent } = espnSource;

    let leagues = SPORTS_TO_FETCH;
    if (args.leagues) {
        leagues = SPORTS_TO_FETCH.filter((l) => args.leagues.includes(l.league.toLowerCase()) || args.leagues.includes(l.name.toLowerCase()));
    }
    if (leagues.length === 0) {
        logger.error('[Backfill] No leagues matched the --leagues filter');
        process.exit(1);
    }

    // Date window: N days back + N/2 forward (catches near-future
    // events not yet in the cron's 7-day window).
    const back  = Math.max(1, args.days);
    const fwd   = Math.max(1, Math.floor(args.days / 2));
    const today = new Date(); today.setHours(12, 0, 0, 0); // noon UTC-ish to avoid TZ edges
    const dates = [];
    for (let i = -back; i <= fwd; i += 1) {
        const d = new Date(today.getTime() + i * 86400000);
        dates.push(ymd(d));
    }

    const tasks = [];
    for (const league of leagues) {
        for (const dateStr of dates) {
            tasks.push({ league, dateStr });
        }
    }

    logger.info(`[Backfill] ${leagues.length} leagues × ${dates.length} dates = ${tasks.length} requests (concurrency: ${CONCURRENCY})`);

    let done = 0;
    let totalEvents = 0;
    let totalBroadcasts = 0;

    // Simple async pool: kick off CONCURRENCY workers, each pulls from
    // the task queue until empty. axios is non-blocking so this gives
    // us steady-state ~CONCURRENCY in flight without a heavyweight
    // p-limit dep.
    const queue = tasks.slice();
    async function worker(workerId) {
        while (queue.length > 0) {
            const task = queue.shift();
            if (!task) break;
            const { league, dateStr } = task;
            const espnEvents = await fetchOne(league.sport, league.league, dateStr);
            for (const ev of espnEvents) {
                const norm = normaliseEvent(ev, league.sport, league.name);
                if (!norm) continue;
                try {
                    await upsertEvent(norm);
                    totalEvents += 1;
                    if (norm.broadcasts && norm.broadcasts.length > 0) totalBroadcasts += 1;
                } catch (err) {
                    logger.warn(`[Backfill] upsert failed ${norm.sourceEventId}: ${err.message}`);
                }
            }
            done += 1;
            if (done % 50 === 0 || done === tasks.length) {
                logger.info(`[Backfill] ${done}/${tasks.length} requests done — ${totalEvents} events stored, ${totalBroadcasts} with broadcasters`);
            }
        }
    }

    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
    await Promise.all(workers);

    logger.info(`[Backfill] Done: ${totalEvents} events stored, ${totalBroadcasts} carried broadcaster data`);

    // Quick coverage summary for the operator's terminal.
    const covRes = await postgresService.query(`
        SELECT COUNT(DISTINCT bc) AS unique_codes,
               COUNT(*)         AS total_observations
          FROM live_events,
               LATERAL UNNEST(broadcasts) AS bc
         WHERE broadcasts IS NOT NULL AND array_length(broadcasts, 1) > 0
    `);
    const cov = covRes.rows[0];
    logger.info(`[Backfill] Total broadcaster pool now: ${cov.unique_codes} unique codes across ${cov.total_observations} (event,code) observations`);

    process.exit(0);
}

main().catch((err) => {
    logger.error('[Backfill] Fatal:', err);
    process.exit(1);
});
