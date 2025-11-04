const express = require('express');
const router = express.Router();
const iptvDatabaseService = require('../services/iptvDatabaseService');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const epgService = require('../services/epgService');
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
 * PUT /api/iptv/sources/:sourceId/credentials
 * Update source credentials (URL, username, password)
 */
router.put('/sources/:sourceId/credentials', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);
        const { url, username, password } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL is required'
            });
        }

        // Update credentials in database
        await iptvDatabaseService.updateSourceCredentials(userId, sourceId, {
            url,
            username,
            password
        });

        res.json({
            success: true,
            message: 'Source credentials updated successfully'
        });
    } catch (error) {
        logger.error(`Error updating source credentials: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update source credentials'
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
 * POST /api/iptv/sources/:sourceId/refresh-account-info
 * Re-fetch channels and account information from Xtream API
 */
router.post('/sources/:sourceId/refresh-account-info', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);

        // Get source details from database
        const sources = await iptvDatabaseService.getUserIPTVSources(userId);
        const source = sources.find(s => s.id === sourceId);

        if (!source) {
            return res.status(404).json({
                success: false,
                error: 'Source not found'
            });
        }

        // Check if this is an Xtream source
        if (source.type !== 'xtream' || !source.url || !source.username || !source.password) {
            return res.status(400).json({
                success: false,
                error: 'Can only refresh data for Xtream sources with valid credentials'
            });
        }

        logger.info(`Refreshing channels and account info for source ${sourceId}`);

        // 1. Fetch fresh channels from Xtream API (force refresh to bypass cache)
        const channelsResult = await epgService.loadXtreamEPG(
            source.url,
            source.username,
            source.password,
            {
                onProgress: () => {}, // No-op progress callback
                maxChannelsToProcess: 0, // No limit
                forceRefresh: true // Force fresh fetch from API, bypass cache
            }
        );

        if (!channelsResult.success || !channelsResult.channels) {
            throw new Error('Failed to fetch channels from Xtream API');
        }

        // Debug logging
        logger.info(`Received ${channelsResult.channels.length} channels from Xtream API`);
        if (channelsResult.channels.length > 0) {
            logger.info(`Sample channel data: ${JSON.stringify(channelsResult.channels[0], null, 2)}`);

            // Count how many channels have groups
            const channelsWithGroups = channelsResult.channels.filter(ch => ch.group && ch.group !== 'Uncategorized').length;
            logger.info(`Channels with valid groups: ${channelsWithGroups} / ${channelsResult.channels.length}`);
        }

        // 2. Fetch fresh account info
        const accountInfo = await epgService.fetchXtreamAccountInfo(
            source.url,
            source.username,
            source.password
        );

        // 3. Update source with account info (this will also delete old channels)
        const sourceInfo = {
            name: source.name,
            url: source.url,
            username: source.username,
            password: source.password,
            type: source.type,
            ...accountInfo
        };

        await iptvDatabaseService.saveSource(sourceInfo);
        logger.info(`Updated source ${sourceId} with fresh account info`);

        // 4. Generate categories from channels
        const categoryMap = channelsResult.channels.reduce((acc, ch) => {
            const groupTitle = ch.group || 'Uncategorized';
            acc[groupTitle] = (acc[groupTitle] || 0) + 1;
            return acc;
        }, {});

        logger.info(`Category breakdown: ${JSON.stringify(categoryMap, null, 2)}`);

        const categories = Object.entries(categoryMap)
            .map(([name, count]) => ({
                id: name,
                name,
                count
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        logger.info(`Generated ${categories.length} categories`);
        await iptvDatabaseService.saveCategories(sourceId, categories);
        logger.info(`Saved ${categories.length} categories for source ${sourceId}`);

        // 5. Transform and save channels
        const dbChannels = channelsResult.channels.map(ch => ({
            id: ch.id || ch.name,
            name: ch.name,
            logo: ch.logo || '',
            url: ch.url,
            group: { title: ch.group || 'Uncategorized' },
            tvg: { id: ch.epgChannelId || '' },
            categories: []
        }));

        await iptvDatabaseService.saveChannels(sourceId, dbChannels);
        logger.info(`Saved ${dbChannels.length} channels for source ${sourceId}`);

        res.json({
            success: true,
            message: 'Channels and account information refreshed successfully',
            channelCount: dbChannels.length,
            categoryCount: categories.length,
            accountInfo
        });
    } catch (error) {
        logger.error(`Error refreshing source data: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to refresh source data: ' + error.message
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
