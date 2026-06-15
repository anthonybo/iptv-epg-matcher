/**
 * Metrics API Routes - Real-time monitoring dashboard endpoints
 */

const express = require('express');
const router = express.Router();
const metricsService = require('../services/metricsService');
const logger = require('../config/logger');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');

/**
 * GET /api/metrics
 * Get current metrics snapshot
 * Requires authentication
 */
router.get('/', authMiddleware, requireAuth, (req, res) => {
  try {
    const snapshot = metricsService.getSnapshot();
    res.json(snapshot);
  } catch (error) {
    logger.error(`Error getting metrics snapshot: ${error.message}`);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

/**
 * GET /api/metrics/stream
 * Server-Sent Events endpoint for real-time metrics updates
 * Broadcasts metrics every 2 seconds
 * Requires authentication
 */
router.get('/stream', authMiddleware, requireAuth, (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent Nginx buffering
  res.flushHeaders();

  logger.debug(`[Metrics SSE] Client connected from ${req.ip}`);

  // Function to send metrics update
  const sendMetrics = () => {
    try {
      if (!res.finished) {
        const snapshot = metricsService.getSnapshot();
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }
    } catch (error) {
      logger.error(`[Metrics SSE] Error sending metrics: ${error.message}`);
      clearInterval(metricsInterval);
      clearInterval(heartbeatInterval);
    }
  };

  // Send metrics immediately
  sendMetrics();

  // Send metrics every 10 seconds (reduced from 2s to reduce load)
  const metricsInterval = setInterval(sendMetrics, 10000);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeatInterval = setInterval(() => {
    if (!res.finished) {
      try {
        res.write(`:heartbeat ${new Date().toISOString()}\n\n`);
      } catch (error) {
        logger.error(`[Metrics SSE] Error sending heartbeat: ${error.message}`);
        clearInterval(metricsInterval);
        clearInterval(heartbeatInterval);
      }
    } else {
      clearInterval(metricsInterval);
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(metricsInterval);
    clearInterval(heartbeatInterval);
    logger.debug(`[Metrics SSE] Client disconnected from ${req.ip}`);
  });

  // Handle errors
  res.on('error', (err) => {
    logger.error(`[Metrics SSE] Response error: ${err.message}`);
    clearInterval(metricsInterval);
    clearInterval(heartbeatInterval);
  });
});

/**
 * GET /api/metrics/timeseries/:type
 * Get in-memory time-series data for graphs (last 10 minutes)
 * Types: bandwidth, streams, requests, memory
 * Requires authentication
 */
router.get('/timeseries/:type', authMiddleware, requireAuth, (req, res) => {
  try {
    const { type } = req.params;
    const minutes = parseInt(req.query.minutes) || 10;

    const validTypes = ['bandwidth', 'streams', 'requests', 'memory'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be one of: ' + validTypes.join(', ') });
    }

    const data = metricsService.getTimeSeries(type, minutes);
    res.json({ type, data });
  } catch (error) {
    logger.error(`Error getting time-series data: ${error.message}`);
    res.status(500).json({ error: 'Failed to get time-series data' });
  }
});

/**
 * GET /api/metrics/history/bandwidth
 * Get historical bandwidth data from database
 * Query params: from, to, limit
 * Requires authentication
 */
router.get('/history/bandwidth', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { from, to, limit = 1000 } = req.query;
    const db = await require('../services/iptvDatabase').connect();

    let query = 'SELECT * FROM metrics_bandwidth WHERE 1=1';
    const params = [];

    if (from) {
      query += ' AND timestamp >= ?';
      params.push(parseInt(from));
    }

    if (to) {
      query += ' AND timestamp <= ?';
      params.push(parseInt(to));
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = await db.all(query, params);
    res.json({ data: rows.reverse() });
  } catch (error) {
    logger.error(`Error getting historical bandwidth data: ${error.message}`);
    res.status(500).json({ error: 'Failed to get historical data' });
  }
});

/**
 * GET /api/metrics/history/requests
 * Get historical request data from database
 * Query params: from, to, limit
 * Requires authentication
 */
router.get('/history/requests', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { from, to, limit = 1000 } = req.query;
    const db = await require('../services/iptvDatabase').connect();

    let query = 'SELECT * FROM metrics_requests WHERE 1=1';
    const params = [];

    if (from) {
      query += ' AND timestamp >= ?';
      params.push(parseInt(from));
    }

    if (to) {
      query += ' AND timestamp <= ?';
      params.push(parseInt(to));
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = await db.all(query, params);
    res.json({ data: rows.reverse() });
  } catch (error) {
    logger.error(`Error getting historical request data: ${error.message}`);
    res.status(500).json({ error: 'Failed to get historical data' });
  }
});

/**
 * GET /api/metrics/history/system
 * Get historical system metrics from database
 * Query params: from, to, limit
 * Requires authentication
 */
router.get('/history/system', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { from, to, limit = 1000 } = req.query;
    const db = await require('../services/iptvDatabase').connect();

    let query = 'SELECT * FROM metrics_system WHERE 1=1';
    const params = [];

    if (from) {
      query += ' AND timestamp >= ?';
      params.push(parseInt(from));
    }

    if (to) {
      query += ' AND timestamp <= ?';
      params.push(parseInt(to));
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = await db.all(query, params);
    res.json({ data: rows.reverse() });
  } catch (error) {
    logger.error(`Error getting historical system data: ${error.message}`);
    res.status(500).json({ error: 'Failed to get historical data' });
  }
});

/**
 * GET /api/metrics/history/streams
 * Get historical stream sessions from database
 * Query params: from, to, limit, type, userId
 * Requires authentication
 */
router.get('/history/streams', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { from, to, limit = 100, type, userId } = req.query;
    const db = await require('../services/iptvDatabase').connect();

    let query = 'SELECT * FROM metrics_streams WHERE 1=1';
    const params = [];

    if (from) {
      query += ' AND start_time >= ?';
      params.push(parseInt(from));
    }

    if (to) {
      query += ' AND start_time <= ?';
      params.push(parseInt(to));
    }

    if (type) {
      query += ' AND stream_type = ?';
      params.push(type);
    }

    if (userId) {
      query += ' AND user_id = ?';
      params.push(parseInt(userId));
    }

    query += ' ORDER BY start_time DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = await db.all(query, params);
    res.json({ data: rows });
  } catch (error) {
    logger.error(`Error getting historical stream data: ${error.message}`);
    res.status(500).json({ error: 'Failed to get historical data' });
  }
});

/**
 * GET /api/metrics/stats/summary
 * Get summary statistics for a time period
 * Query params: from, to
 * Requires authentication
 */
router.get('/stats/summary', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const db = await require('../services/iptvDatabase').connect();
    const params = [];

    // Stream statistics
    let streamQuery = 'SELECT COUNT(*) as total_streams, SUM(bytes_transferred) as total_bytes, AVG(duration_seconds) as avg_duration, stream_type FROM metrics_streams WHERE 1=1';

    if (from) {
      streamQuery += ' AND start_time >= ?';
      params.push(parseInt(from));
    }

    if (to) {
      streamQuery += ' AND start_time <= ?';
      params.push(parseInt(to));
    }

    streamQuery += ' GROUP BY stream_type';

    const streamStats = await db.all(streamQuery, params);

    // Peak bandwidth
    const bandwidthQuery = `SELECT MAX(download_mbps) as peak_download, MAX(upload_mbps) as peak_upload, AVG(download_mbps) as avg_download FROM metrics_bandwidth WHERE 1=1${from ? ' AND timestamp >= ?' : ''}${to ? ' AND timestamp <= ?' : ''}`;
    const bandwidthStats = await db.get(bandwidthQuery, params);

    // Top channels
    const topChannelsQuery = `SELECT channel_name, COUNT(*) as plays, SUM(bytes_transferred) as total_bytes FROM metrics_streams WHERE 1=1${from ? ' AND start_time >= ?' : ''}${to ? ' AND start_time <= ?' : ''} GROUP BY channel_name ORDER BY plays DESC LIMIT 10`;
    const topChannels = await db.all(topChannelsQuery, params);

    res.json({
      streamStats,
      bandwidthStats,
      topChannels
    });
  } catch (error) {
    logger.error(`Error getting summary statistics: ${error.message}`);
    res.status(500).json({ error: 'Failed to get summary statistics' });
  }
});

/**
 * POST /api/metrics/page-view
 * Track a page view
 * Requires authentication
 */
router.post('/page-view', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { sessionId, page } = req.body;

    logger.debug(`[Metrics] Page view tracking request: sessionId=${sessionId}, page=${page}, user=${req.user?.username || req.user?.email}`);

    if (!sessionId || !page) {
      logger.warn('[Metrics] Page view request missing sessionId or page');
      return res.status(400).json({ error: 'sessionId and page are required' });
    }

    const userId = req.user?.id || null;
    const userName = req.user?.username || req.user?.email || null;
    const ip = req.ip || req.connection?.remoteAddress || 'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // Track session
    await metricsService.trackSession(sessionId, userId, userName, page, ip, userAgent);

    // Track page view
    await metricsService.trackPageView(sessionId, userId, page);

    logger.debug(`[Metrics] Successfully tracked page view: ${page} for user ${userName}`);

    res.json({ success: true });
  } catch (error) {
    logger.error(`[Metrics] Error tracking page view: ${error.message}`, error);
    res.status(500).json({ error: 'Failed to track page view' });
  }
});

/**
 * GET /api/metrics/sessions/active
 * Get active user sessions (from cache)
 * Requires authentication
 */
router.get('/sessions/active', authMiddleware, requireAuth, (req, res) => {
  try {
    logger.debug('[Metrics] Fetching active sessions from cache');
    const sessions = metricsService.getActiveSessions();

    logger.debug(`[Metrics] Found ${sessions.length} active sessions`);

    // Format sessions for display
    const formattedSessions = sessions.map(session => ({
      sessionId: session.session_id,
      userId: session.user_id,
      userName: session.user_name,
      currentPage: session.current_page,
      ip: session.client_ip,
      firstSeen: session.first_seen,
      lastSeen: session.last_seen,
      duration: Math.floor((session.last_seen - session.first_seen) / 1000),
      isActive: session.is_active === 1
    }));

    res.json({ sessions: formattedSessions });
  } catch (error) {
    logger.error(`[Metrics] Error getting active sessions: ${error.message}`, error);
    res.status(500).json({ error: 'Failed to get active sessions' });
  }
});

/**
 * POST /api/metrics/reset
 * Reset all metrics (useful for testing)
 * Requires authentication
 * Only available in development
 */
router.post('/reset', authMiddleware, requireAuth, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  try {
    metricsService.reset();
    logger.info(`[Metrics] Metrics reset by user ${req.user?.username || req.user?.email}`);
    res.json({ success: true, message: 'Metrics reset successfully' });
  } catch (error) {
    logger.error(`Error resetting metrics: ${error.message}`);
    res.status(500).json({ error: 'Failed to reset metrics' });
  }
});

module.exports = router;
