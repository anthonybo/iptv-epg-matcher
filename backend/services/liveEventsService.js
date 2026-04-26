/**
 * Live Events Service
 *
 * Orchestrates the multi-source event pipeline:
 *   - eventSources/* adapters (ESPN, TheSportsDB, MLB Stats, NHL,
 *     OpenLigaDB, Football-Data, API-Sports, Riot, CricAPI) emit
 *     normalised events
 *   - the orchestrator merges them by canonical_id (sport+teams+
 *     start-hour hash) so the same MLB game from ESPN + MLB Stats
 *     becomes one row
 *   - we upsert the merged events into live_events
 *
 * Kept as a thin wrapper here so callers (the cron schedule, the
 * `/api/live-events/refresh` route, etc.) don't have to know about
 * the adapter layer.
 *
 * Source-specific config lives in `eventSources/`. This file is for
 * orchestration + DB plumbing + helper queries used elsewhere
 * (getCurrentlyLiveEvents, isProgramLive).
 */

const logger = require('../config/logger');
const postgresService = require('./postgresService');
const eventSources = require('./eventSources');
const espnSource = require('./eventSources/espnSource');

/**
 * Run every enabled adapter, merge results, and upsert into live_events.
 */
async function refreshLiveEvents() {
    try {
        logger.info('Starting live events refresh');
        const events = await eventSources.fetchAllEvents();

        let stored = 0;
        let errors = 0;

        for (const e of events) {
            try {
                // Adapters emit live-state too (is_live, scores, clock).
                // Write them so non-ESPN events have a live signal —
                // the score updater is still ESPN-only and only touches
                // ESPN events, so for sportsdb/openliga/mlbstats/nhl we
                // need the refresh tick to set is_live or those rows
                // never light up in the ticker.
                await postgresService.query(`
                    INSERT INTO live_events (
                        event_id, event_name, sport_type, league_name,
                        home_team, away_team, event_start, event_end,
                        source, broadcasts, canonical_id, sources,
                        is_live, home_score, away_score, status_type,
                        game_clock, game_status, scores_updated_at,
                        updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                            $13, $14, $15, $16, $17, $18, CURRENT_TIMESTAMP,
                            CURRENT_TIMESTAMP)
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
                        canonical_id = EXCLUDED.canonical_id,
                        sources = EXCLUDED.sources,
                        is_live = EXCLUDED.is_live,
                        home_score = EXCLUDED.home_score,
                        away_score = EXCLUDED.away_score,
                        status_type = EXCLUDED.status_type,
                        game_clock = EXCLUDED.game_clock,
                        game_status = EXCLUDED.game_status,
                        scores_updated_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    e.sourceEventId,
                    e.eventName,
                    e.sportType,
                    e.leagueName,
                    e.homeTeam,
                    e.awayTeam,
                    e.eventStart,
                    e.eventEnd,
                    e.sourceName,
                    e.broadcasts || [],
                    e.canonicalId,
                    e.sources || [e.sourceEventId],
                    e.isLive ?? false,
                    e.homeScore ?? null,
                    e.awayScore ?? null,
                    e.statusType ?? null,
                    e.gameClock ?? null,
                    e.gameStatus ?? null,
                ]);
                stored++;
            } catch (err) {
                logger.error(`[LiveEvents] Failed to upsert ${e.sourceEventId}: ${err.message}`);
                errors++;
            }
        }

        // Cleanup: drop events that ended more than 1 day ago. Honors
        // the API-provided endDate for multi-day tournaments (golf, F1
        // weekends, tennis tournaments) thanks to adapters putting the
        // real endDate in eventEnd.
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const cleanup = await postgresService.query(
            'DELETE FROM live_events WHERE event_end < $1',
            [oneDayAgo]
        );
        if (cleanup.rowCount > 0) {
            logger.info(`[LiveEvents] Cleaned up ${cleanup.rowCount} expired events`);
        }

        logger.info(`Live events refresh complete: fetched=${events.length}, stored=${stored}, errors=${errors}`);
        return {
            success: true,
            totalFetched: events.length,
            totalStored: stored,
            errors,
        };
    } catch (error) {
        logger.error('Error refreshing live events:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get currently live events from database
 */
async function getCurrentlyLiveEvents() {
    try {
        const now = new Date().toISOString();
        // "Live" = either inside the advertised time window OR a source
        // says is_live=TRUE. Needed because:
        //   - MLS and other soccer routinely run past event_end (stoppage
        //     + halftime often push 2h+); our stored event_end is an
        //     estimate, so the ticker (which reads is_live directly from
        //     ESPN's scoreboard) would keep showing the game live while
        //     this query already dropped it.
        //   - Inverse happens too: games go in-progress slightly before
        //     our stored event_start during pregame transitions.
        const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

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
 */
async function isProgramLive(programTitle) {
    try {
        const liveEvents = await getCurrentlyLiveEvents();
        if (!liveEvents || liveEvents.length === 0) return false;

        const titleLower = programTitle.toLowerCase();
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
 * Get all events from database
 */
async function getAllEvents() {
    try {
        const result = await postgresService.query(`
            SELECT
                event_id, event_name, sport_type, league_name,
                home_team, away_team, event_start, event_end, source
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
    // Re-export so existing imports keep working — liveScoresService
    // pulls SPORTS_TO_FETCH from here as a single source of truth.
    SPORTS_TO_FETCH: espnSource.SPORTS_TO_FETCH,
};
