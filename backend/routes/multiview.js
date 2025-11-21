/**
 * Multiview Routes
 * API endpoints for managing user's multiview streams
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * GET /api/multiview
 * Get all multiview streams for the current user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');
    const result = await postgresService.query(
      `SELECT
        channel_id as id,
        name,
        logo,
        url,
        source_id as "sourceId",
        source_type as "sourceType",
        source_url as "sourceUrl",
        source_username as "sourceUsername",
        source_password as "sourcePassword",
        source_mac as "sourceMac",
        source_name as "sourceName",
        espn_event_id as "espnEventId",
        espn_event_name as "espnEventName",
        EXTRACT(EPOCH FROM added_at) * 1000 as "addedAt"
       FROM multiview_streams
       WHERE user_id = $1
       ORDER BY added_at ASC`,
      [userId]
    );

    res.json({
      success: true,
      streams: result.rows
    });
  } catch (error) {
    logger.error('Get multiview streams failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/multiview
 * Add a stream to multiview
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channel } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!channel || !channel.id || !channel.url) {
      return res.status(400).json({ error: 'Invalid channel data' });
    }

    const postgresService = require('../services/postgresService');

    // Insert or ignore if already exists
    await postgresService.query(
      `INSERT INTO multiview_streams (
        user_id, channel_id, name, logo, url,
        source_id, source_type, source_url, source_username, source_password, source_mac, source_name,
        espn_event_id, espn_event_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (user_id, channel_id, source_id) DO NOTHING`,
      [
        userId,
        channel.id,
        channel.name,
        channel.logo || null,
        channel.url,
        channel.sourceId || channel.source_id,
        channel.sourceType || channel.source_type,
        channel.sourceUrl || channel.source_url || null,
        channel.sourceUsername || channel.source_username || null,
        channel.sourcePassword || channel.source_password || null,
        channel.sourceMac || channel.source_mac || null,
        channel.sourceName || channel.source_name || null,
        channel.espnEventId || null,
        channel.espnEventName || null
      ]
    );

    logger.info(`User ${userId} added stream to multiview: ${channel.name}`);

    res.json({
      success: true,
      message: 'Stream added to multiview'
    });
  } catch (error) {
    logger.error('Add to multiview failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/multiview/:channelId/:sourceId
 * Remove a stream from multiview
 */
router.delete('/:channelId/:sourceId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelId, sourceId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');

    const result = await postgresService.query(
      'DELETE FROM multiview_streams WHERE user_id = $1 AND channel_id = $2 AND source_id = $3',
      [userId, channelId, parseInt(sourceId)]
    );

    logger.info(`User ${userId} removed stream from multiview: ${channelId}`);

    res.json({
      success: true,
      message: 'Stream removed from multiview',
      deleted: result.rowCount > 0
    });
  } catch (error) {
    logger.error('Remove from multiview failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/multiview
 * Clear all multiview streams
 */
router.delete('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');

    const result = await postgresService.query(
      'DELETE FROM multiview_streams WHERE user_id = $1',
      [userId]
    );

    logger.info(`User ${userId} cleared all multiview streams (${result.rowCount} deleted)`);

    res.json({
      success: true,
      message: 'All streams cleared',
      deletedCount: result.rowCount
    });
  } catch (error) {
    logger.error('Clear multiview failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
