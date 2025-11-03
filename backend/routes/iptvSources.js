const express = require('express');
const router = express.Router();
const iptvDatabaseService = require('../services/iptvDatabaseService');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const logger = require('../config/logger');

// Apply auth middleware to all routes in this router
router.use(authMiddleware);

/**
 * GET /api/iptv/sources
 * Get all IPTV sources for the authenticated user
 */
router.get('/sources', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sources = await iptvDatabaseService.getUserIPTVSources(userId);

        res.json({
            success: true,
            sources,
            count: sources.length
        });
    } catch (error) {
        logger.error(`Error getting user IPTV sources: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve IPTV sources'
        });
    }
});

/**
 * POST /api/iptv/sources/:sourceId/activate
 * Toggle source active state
 */
router.post('/sources/:sourceId/activate', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);
        const { isActive } = req.body;

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'isActive must be a boolean'
            });
        }

        await iptvDatabaseService.toggleSourceActive(userId, sourceId, isActive);

        res.json({
            success: true,
            message: `Source ${isActive ? 'activated' : 'deactivated'} successfully`
        });
    } catch (error) {
        logger.error(`Error toggling source active state: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update source state'
        });
    }
});

/**
 * PUT /api/iptv/sources/:sourceId/priority
 * Update source priority
 */
router.put('/sources/:sourceId/priority', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);
        const { priority } = req.body;

        if (typeof priority !== 'number' || priority < 1) {
            return res.status(400).json({
                success: false,
                error: 'Priority must be a positive number'
            });
        }

        await iptvDatabaseService.updateSourcePriority(userId, sourceId, priority);

        res.json({
            success: true,
            message: 'Source priority updated successfully'
        });
    } catch (error) {
        logger.error(`Error updating source priority: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update source priority'
        });
    }
});

/**
 * PUT /api/iptv/sources/:sourceId/nickname
 * Update source nickname
 */
router.put('/sources/:sourceId/nickname', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);
        const { nickname } = req.body;

        if (!nickname || typeof nickname !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Nickname must be a non-empty string'
            });
        }

        await iptvDatabaseService.updateSourceNickname(userId, sourceId, nickname.trim());

        res.json({
            success: true,
            message: 'Source nickname updated successfully'
        });
    } catch (error) {
        logger.error(`Error updating source nickname: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update source nickname'
        });
    }
});

/**
 * PUT /api/iptv/sources/reorder
 * Batch update priorities for multiple sources (for drag-and-drop reordering)
 */
router.put('/sources/reorder', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { sources } = req.body;

        if (!Array.isArray(sources)) {
            return res.status(400).json({
                success: false,
                error: 'sources must be an array'
            });
        }

        // Validate all entries
        for (const source of sources) {
            if (!source.sourceId || typeof source.priority !== 'number') {
                return res.status(400).json({
                    success: false,
                    error: 'Each source must have sourceId and priority'
                });
            }
        }

        // Update all priorities
        for (const source of sources) {
            await iptvDatabaseService.updateSourcePriority(userId, source.sourceId, source.priority);
        }

        res.json({
            success: true,
            message: 'Source priorities updated successfully'
        });
    } catch (error) {
        logger.error(`Error reordering sources: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to reorder sources'
        });
    }
});

/**
 * DELETE /api/iptv/sources/:sourceId
 * Remove source from user's account
 */
router.delete('/sources/:sourceId', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);

        await iptvDatabaseService.deleteUserSource(userId, sourceId);

        res.json({
            success: true,
            message: 'Source removed from your account successfully'
        });
    } catch (error) {
        logger.error(`Error deleting user source: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to remove source'
        });
    }
});

/**
 * GET /api/iptv/alternate-feeds
 * Get alternate feeds for a channel across user's sources
 * Query params: channelName (required), epgChannelId (optional)
 */
router.get('/alternate-feeds', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { channelName, epgChannelId } = req.query;

        if (!channelName) {
            return res.status(400).json({
                success: false,
                error: 'channelName query parameter is required'
            });
        }

        const feeds = await iptvDatabaseService.getAlternateFeeds(
            userId,
            channelName,
            epgChannelId || null
        );

        res.json({
            success: true,
            feeds,
            count: feeds.length
        });
    } catch (error) {
        logger.error(`Error fetching alternate feeds: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch alternate feeds'
        });
    }
});

module.exports = router;
