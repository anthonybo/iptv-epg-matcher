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

    // Build exclusion clause for PostgreSQL — placeholders start at $4
    // now that the live predicate takes three positional params instead
    // of two (now, now, halfHourAgo).
    const exclusionClause = excludeEventIds.length > 0
      ? `AND event_id NOT IN (${excludeEventIds.map((_, i) => `$${i + 4}`).join(', ')})`
      : '';

    // "Live" = inside advertised window OR ESPN says is_live. Without
    // the OR branch, MLS games in stoppage time disappear from this
    // summary while still showing up in the live-scores ticker (which
    // reads is_live directly). The half-hour floor on event_end keeps
    // stale is_live flags from pulling in games that finished hours ago.
    const query = `
      SELECT
        sport_type,
        league_name,
        COUNT(*) as event_count
      FROM live_events
      WHERE ((event_start <= $1 AND event_end >= $2)
          OR (is_live = TRUE AND event_end >= $3))
        AND (status_type IS NULL OR status_type NOT LIKE '%FINAL%')
      ${exclusionClause}
      GROUP BY sport_type, league_name
      HAVING COUNT(*) > 0
      ORDER BY COUNT(*) DESC, sport_type, league_name
    `;
    const now = new Date().toISOString();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const params = [now, now, halfHourAgo, ...excludeEventIds];

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

module.exports = router;
