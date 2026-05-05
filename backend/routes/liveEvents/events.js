/**
 * Live-event metadata routes: refresh, current, upcoming, and per-sport summary.
 * Split out of the original monolithic routes/liveEvents.js.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const liveEventsService = require('../../services/liveEventsService');
const postgresService = require('../../services/postgresService');
const iptvDatabaseService = require('../../services/iptvDatabase');
const { expandBroadcaster, hasAlias, BROADCASTER_ALIASES } = require('../../utils/broadcasterAliases');

/**
 * POST /api/live-events/refresh
 * Manually trigger live events refresh from TheSportsDB API
 */
router.post('/refresh', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Refresh live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`User ${userId} triggered live events refresh`);

    // Trigger refresh (ESPN API automatically returns today's and upcoming games)
    const result = await liveEventsService.refreshLiveEvents();

    if (result.success) {
      return res.json({
        success: true,
        message: `Successfully fetched ${result.totalFetched} events, stored ${result.totalStored} events`,
        ...result
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        message: 'Failed to refresh live events'
      });
    }
  } catch (error) {
    logger.error('Refresh live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/current
 * Get currently live events
 */
router.get('/current', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get current live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const liveEvents = await liveEventsService.getCurrentlyLiveEvents();

    res.json({
      success: true,
      events: liveEvents,
      count: liveEvents.length
    });
  } catch (error) {
    logger.error('Get current live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/upcoming
 * Get upcoming events in the next N hours
 */
router.get('/upcoming', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get upcoming live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hoursAhead = parseInt(req.query.hours) || 24;
    const db = await iptvDatabaseService.connect();

    const now = new Date().toISOString();
    const futureTime = new Date(Date.now() + (hoursAhead * 60 * 60 * 1000)).toISOString();

    const events = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM live_events
        WHERE event_start >= ? AND event_start <= ?
        ORDER BY event_start
      `, [now, futureTime], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json({
      success: true,
      events,
      count: events.length,
      hoursAhead
    });
  } catch (error) {
    logger.error('Get upcoming live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/live-sports-summary
 * Get summary of currently live sports with event counts
 * Optionally exclude events already in multiview
 */
router.get('/live-sports-summary', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get live sports summary: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get excluded event IDs from query params
    const excludeEventIds = req.query.excludeEventIds
      ? (Array.isArray(req.query.excludeEventIds) ? req.query.excludeEventIds : [req.query.excludeEventIds])
      : [];

    logger.info(`Getting live sports summary (excluding ${excludeEventIds.length} events)`);

    // Strict: only events ESPN is actively reporting as state='in'
    // (is_live=TRUE). The "or-inside-advertised-window" predicate we
    // used to have here pulled multi-day tournaments (PGA, LPGA, F1
    // weekends, tennis tournaments) into the summary between rounds
    // — making the ticker say "Round 2 Final" alongside live games.
    // event_end half-hour floor catches stale is_live=TRUE rows.
    //
    // $1 = halfHourAgo (anti-stale floor), then exclude event ids.
    const exclusionClause = excludeEventIds.length > 0
      ? `AND event_id NOT IN (${excludeEventIds.map((_, i) => `$${i + 2}`).join(', ')})`
      : '';
    const query = `
      SELECT
        sport_type,
        league_name,
        COUNT(*) as event_count
      FROM live_events
      WHERE is_live = TRUE
        AND event_end >= $1
        AND (status_type IS NULL OR status_type NOT LIKE '%FINAL%')
      ${exclusionClause}
      GROUP BY sport_type, league_name
      HAVING COUNT(*) > 0
      ORDER BY COUNT(*) DESC, sport_type, league_name
    `;
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const params = [halfHourAgo, ...excludeEventIds];

    const result = await postgresService.query(query, params);
    const sportsSummary = result.rows || [];

    logger.info(`Found ${sportsSummary.length} sport/league combinations with live events`);

    res.json({
      success: true,
      sports: sportsSummary,
      count: sportsSummary.length,
      excludedCount: excludeEventIds.length
    });
  } catch (error) {
    logger.error('Get live sports summary failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/today
 * Return ALL events whose event_start falls on the current local date —
 * live, scheduled-not-yet-started, AND finished. Powers the "All Games
 * Today" debug modal in multi-view, so the user can pick a specific
 * game (even one already played) and exercise the same channel-finder
 * pipeline as the ticker click. Useful for testing search / scoring
 * fixes outside of a live event window.
 *
 * Window is anchored to the user's clock by accepting a `?date=YYYY-MM-DD`
 * query param (caller supplies their local date); falls back to the
 * server's local date when omitted. Either way we expand to UTC start/end
 * for the SQL comparison so games that wrap past midnight UTC still
 * land on the right calendar day.
 */
router.get('/today', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get today live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const dateParam = String(req.query.date || '').trim();
    const localDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? new Date(`${dateParam}T00:00:00`)
      : new Date(); // server local "now"

    const start = new Date(localDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(localDate);
    end.setHours(23, 59, 59, 999);

    // Cast event_start to the same anchor: any event starting between
    // local-midnight and local-end-of-day counts as "today". The DB
    // stores TIMESTAMP without time zone (UTC by convention) so we
    // compare against ISO strings in UTC.
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
        home_score,
        away_score,
        game_status,
        game_clock,
        status_type,
        is_live,
        broadcasts
      FROM live_events
      WHERE event_start >= $1 AND event_start <= $2
      ORDER BY is_live DESC, event_start ASC
    `, [start.toISOString(), end.toISOString()]);

    res.json({
      success: true,
      events: result.rows || [],
      count: (result.rows || []).length,
      date: localDate.toISOString().slice(0, 10)
    });
  } catch (error) {
    logger.error('Get today live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/broadcaster-coverage
 *
 * Combine three sources to give an at-a-glance view of how well our
 * broadcaster aliases cover the codes ESPN actually returns:
 *
 *   1. live_events.broadcasts                — every code ESPN has emitted
 *      across stored events (what's in the wild)
 *   2. broadcaster_match_stats               — what happened when search
 *      tried to resolve those codes (matched / failed)
 *   3. broadcasterAliases.expandBroadcaster — what our static alias
 *      table maps each code to (or "verbatim" if unmapped)
 *
 * Each row in the response represents one (code, sport, league) tuple
 * with its aliases (current static expansion) plus whatever runtime
 * stats we've accumulated so far.
 */
router.get('/broadcaster-coverage', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Pull every (code, sport, league) ever seen, plus event count.
    const observedResult = await postgresService.query(`
      SELECT
        bc                          AS broadcaster_code,
        COALESCE(sport_type, '')    AS sport_type,
        COALESCE(league_name, '')   AS league_name,
        COUNT(*)                    AS event_count,
        MIN(event_start)::date      AS earliest_event,
        MAX(event_start)::date      AS latest_event
      FROM live_events,
           LATERAL UNNEST(broadcasts) AS bc
      WHERE broadcasts IS NOT NULL
        AND ARRAY_LENGTH(broadcasts, 1) > 0
      GROUP BY bc, sport_type, league_name
    `);

    // Pull all stats rows.
    const statsResult = await postgresService.query(`
      SELECT
        broadcaster_code, sport_type, league_name,
        alias_count, search_count,
        match_via_this_count, match_via_other_count, fail_count,
        first_seen, last_seen
      FROM broadcaster_match_stats
    `);
    const statsByKey = new Map();
    for (const row of statsResult.rows || []) {
      const key = `${row.broadcaster_code}\x00${row.sport_type || ''}\x00${row.league_name || ''}`;
      statsByKey.set(key, row);
    }

    // Outer-join: every observed code, with stats if present + aliases
    // computed from the static table.
    const rows = [];
    for (const obs of observedResult.rows || []) {
      const key = `${obs.broadcaster_code}\x00${obs.sport_type}\x00${obs.league_name}`;
      const stats = statsByKey.get(key);
      const aliases = expandBroadcaster(obs.broadcaster_code) || [];
      // is_aliased = "did the dict explicitly know about this code".
      // Can't infer from aliases-vs-input because the dict legitimately
      // has entries like 'ESPN': ['ESPN'] where the alias list equals
      // the input — those should still count as aliased.
      const isAliased = hasAlias(obs.broadcaster_code);
      const failRate = stats && stats.search_count > 0
        ? Number(stats.fail_count) / Number(stats.search_count)
        : null;
      rows.push({
        broadcaster_code: obs.broadcaster_code,
        sport_type:  obs.sport_type  || null,
        league_name: obs.league_name || null,
        event_count: Number(obs.event_count),
        earliest_event: obs.earliest_event,
        latest_event:   obs.latest_event,

        is_aliased:  isAliased,
        aliases,                                // current static expansion
        alias_count: isAliased ? aliases.length : 0,

        // Runtime stats (null if this code has never been searched yet)
        search_count:          stats ? Number(stats.search_count)          : 0,
        match_via_this_count:  stats ? Number(stats.match_via_this_count)  : 0,
        match_via_other_count: stats ? Number(stats.match_via_other_count) : 0,
        fail_count:            stats ? Number(stats.fail_count)            : 0,
        fail_rate:             failRate,
        first_seen:            stats ? stats.first_seen : null,
        last_seen:             stats ? stats.last_seen  : null
      });
    }

    // Summary buckets — high-signal counters for the UI header.
    const summary = {
      total_rows:        rows.length,
      total_codes:       new Set(rows.map((r) => r.broadcaster_code)).size,
      aliased_codes:     new Set(rows.filter((r) => r.is_aliased).map((r) => r.broadcaster_code)).size,
      unaliased_codes:   new Set(rows.filter((r) => !r.is_aliased).map((r) => r.broadcaster_code)).size,
      searched:          rows.filter((r) => r.search_count > 0).length,
      never_searched:    rows.filter((r) => r.search_count === 0).length,
      ever_failed:       rows.filter((r) => r.fail_count > 0).length,
      always_failed:     rows.filter((r) => r.search_count > 0 && r.fail_count === r.search_count).length,
      catalog_size:      Object.keys(BROADCASTER_ALIASES).length
    };

    // Sort: unaliased + always-failed first (most actionable), then by
    // event_count desc (most-seen-but-still-broken second).
    rows.sort((a, b) => {
      const aPriority = (a.is_aliased ? 0 : 100) +
                        (a.always_failed ? 50 : 0) +
                        (a.fail_count > 0 ? 10 : 0);
      const bPriority = (b.is_aliased ? 0 : 100) +
                        (b.always_failed ? 50 : 0) +
                        (b.fail_count > 0 ? 10 : 0);
      if (aPriority !== bPriority) return bPriority - aPriority;
      if (a.event_count !== b.event_count) return b.event_count - a.event_count;
      return String(a.broadcaster_code).localeCompare(String(b.broadcaster_code));
    });

    res.json({ success: true, summary, rows });
  } catch (error) {
    logger.error('Broadcaster coverage failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
