/**
 * Blacklist routes: maintain the per-user list of channel names to skip
 * during auto-fill / random-stream discovery.
 * Split out of the original monolithic routes/liveEvents.js.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');

/**
 * GET /api/live-events/blacklist
 * Get all blacklisted channels for the current user
 */
router.get('/blacklist', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await postgresService.query(
      'SELECT id, channel_name, created_at FROM blacklisted_channels WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json({
      success: true,
      blacklist: result.rows
    });
  } catch (error) {
    logger.error('Get blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/live-events/blacklist
 * Add a channel to the blacklist
 */
router.post('/blacklist', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelName } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!channelName || typeof channelName !== 'string') {
      return res.status(400).json({ error: 'Channel name is required' });
    }


    // Insert or ignore if already exists
    await postgresService.query(
      'INSERT INTO blacklisted_channels (user_id, channel_name) VALUES ($1, $2) ON CONFLICT (user_id, channel_name) DO NOTHING',
      [userId, channelName]
    );

    logger.info(`User ${userId} blacklisted channel: ${channelName}`);

    res.json({
      success: true,
      message: 'Channel blacklisted successfully'
    });
  } catch (error) {
    logger.error('Add to blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/live-events/blacklist/:channelName
 * Remove a channel from the blacklist
 */
router.delete('/blacklist/:channelName', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelName } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }


    const result = await postgresService.query(
      'DELETE FROM blacklisted_channels WHERE user_id = $1 AND channel_name = $2',
      [userId, channelName]
    );

    logger.info(`User ${userId} removed channel from blacklist: ${channelName}`);

    res.json({
      success: true,
      message: 'Channel removed from blacklist',
      deleted: result.rowCount > 0
    });
  } catch (error) {
    logger.error('Remove from blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
