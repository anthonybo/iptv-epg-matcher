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

        logger.info(`User ${userId} deleting source ${sourceId}`);

        // Get source details before deleting to clean up cache
        // Use getUserIPTVSources to ensure user owns this source
        const userSources = await iptvDatabaseService.getUserIPTVSources(userId);
        const source = userSources.find(s => s.id === sourceId);

        if (source) {
            logger.info(`Source ${sourceId} details:`, {
                type: source.type,
                url: source.url,
                has_mac: !!source.mac_address,
                has_username: !!source.username
            });

            // Generate cache key based on source type
            let cacheKey;
            if (source.type === 'xtream' && source.url && source.username && source.password) {
                cacheKey = `${source.url}:${source.username}:${source.password}`.replace(/[\/\\:]/g, '_');
                logger.info(`Generated Xtream cache key: ${cacheKey}`);
            } else if (source.type === 'stalker' && source.url && source.mac_address) {
                cacheKey = `${source.url}:${source.mac_address}`.replace(/[\/\\:]/g, '_');
                logger.info(`Generated Stalker cache key: ${cacheKey}`);
            } else {
                logger.warn(`Could not generate cache key for source ${sourceId} (type: ${source.type})`);
            }

            // Delete cache file if cacheKey exists
            if (cacheKey) {
                const path = require('path');
                const fs = require('fs');
                const cacheDir = path.join(process.cwd(), 'cache');
                const cacheFile = path.join(cacheDir, `${cacheKey}_channels.json`);

                logger.info(`Looking for cache file: ${cacheFile}`);

                if (fs.existsSync(cacheFile)) {
                    try {
                        fs.unlinkSync(cacheFile);
                        logger.info(`✓ Deleted cache file for source ${sourceId}: ${cacheFile}`);
                    } catch (cacheError) {
                        logger.warn(`✗ Failed to delete cache file: ${cacheError.message}`);
                    }
                } else {
                    logger.info(`Cache file does not exist: ${cacheFile}`);
                }
            }
        } else {
            logger.warn(`Source ${sourceId} not found in database`);
        }

        await iptvDatabaseService.deleteUserSource(userId, sourceId);
        logger.info(`Deleted user preference for user ${userId}, source ${sourceId}`);

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
 * Re-fetch channels and account information from Xtream API or Stalker portal
 */
router.post('/sources/:sourceId/refresh-account-info', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);

        // Get source details from database
        const sources = await iptvDatabaseService.getUserIPTVSources(userId);
        const source = sources.find(s => s.id === sourceId);

        logger.info(`[REFRESH DEBUG] Found ${sources.length} sources for user ${userId}`);
        logger.info(`[REFRESH DEBUG] Looking for source ID ${sourceId}`);
        logger.info(`[REFRESH DEBUG] Source found: ${JSON.stringify(source, null, 2)}`);

        if (!source) {
            return res.status(404).json({
                success: false,
                error: 'Source not found'
            });
        }

        // Delete cache file BEFORE refreshing to ensure fresh data
        const path = require('path');
        const fs = require('fs');
        const cacheDir = path.join(process.cwd(), 'cache');

        let cacheKey;
        if (source.type === 'xtream' && source.url && source.username && source.password) {
            cacheKey = `${source.url}:${source.username}:${source.password}`.replace(/[\/\\:]/g, '_');
        } else if (source.type === 'stalker' && source.url && source.mac_address) {
            cacheKey = `${source.url}:${source.mac_address}`.replace(/[\/\\:]/g, '_');
        }

        if (cacheKey) {
            const cacheFile = path.join(cacheDir, `${cacheKey}_channels.json`);
            if (fs.existsSync(cacheFile)) {
                try {
                    fs.unlinkSync(cacheFile);
                    logger.info(`Deleted cache file before refresh: ${cacheFile}`);
                } catch (cacheError) {
                    logger.warn(`Failed to delete cache file before refresh: ${cacheError.message}`);
                }
            } else {
                logger.info(`No cache file to delete: ${cacheFile}`);
            }
        }

        // Check source type and validate credentials
        logger.info(`[REFRESH DEBUG] Source type: ${source.type}`);
        logger.info(`[REFRESH DEBUG] Source URL: ${source.url}`);
        logger.info(`[REFRESH DEBUG] Source mac_address: ${source.mac_address}`);

        if (source.type === 'xtream') {
            if (!source.url || !source.username || !source.password) {
                logger.error('[REFRESH DEBUG] Xtream source validation failed - missing credentials');
                return res.status(400).json({
                    success: false,
                    error: 'Xtream source missing required credentials'
                });
            }
        } else if (source.type === 'stalker') {
            if (!source.url || !source.mac_address) {
                logger.error(`[REFRESH DEBUG] Stalker source validation failed - url: ${!!source.url}, mac_address: ${!!source.mac_address}`);
                return res.status(400).json({
                    success: false,
                    error: 'Stalker source missing required credentials'
                });
            }
        } else {
            logger.error(`[REFRESH DEBUG] Unknown source type: ${source.type}`);
            return res.status(400).json({
                success: false,
                error: 'Can only refresh Xtream or Stalker sources'
            });
        }

        logger.info(`Refreshing channels and account info for ${source.type} source ${sourceId}`);

        let channelsResult;
        let accountInfo;
        let categories;

        if (source.type === 'xtream') {
            // 1. Fetch fresh channels from Xtream API (force refresh to bypass cache)
            channelsResult = await epgService.loadXtreamEPG(
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

            // 2. Fetch fresh account info
            accountInfo = await epgService.fetchXtreamAccountInfo(
                source.url,
                source.username,
                source.password
            );
        } else if (source.type === 'stalker') {
            // 1. Fetch fresh channels from Stalker portal
            const stalkerService = require('../services/stalkerService');
            const stalkerResult = await stalkerService.loadStalkerEPG(
                source.url,
                source.mac_address,
                {
                    onProgress: (progress) => {
                        logger.info(`Stalker refresh progress: ${progress.message}`);
                    }
                }
            );

            if (!stalkerResult.success || !stalkerResult.channels) {
                throw new Error(stalkerResult.error || 'Failed to fetch channels from Stalker portal');
            }

            channelsResult = stalkerResult;
            accountInfo = stalkerResult.accountInfo;
            categories = stalkerResult.categories;
        }

        // Debug logging
        logger.info(`Received ${channelsResult.channels.length} channels from ${source.type} source`);
        if (channelsResult.channels.length > 0) {
            logger.info(`Sample channel data: ${JSON.stringify(channelsResult.channels[0], null, 2)}`);

            // Count how many channels have groups
            const channelsWithGroups = channelsResult.channels.filter(ch => (ch.group || ch.groupTitle) && (ch.group || ch.groupTitle) !== 'Uncategorized').length;
            logger.info(`Channels with valid groups: ${channelsWithGroups} / ${channelsResult.channels.length}`);
        }

        // 3. Update source with account info (this will also delete old channels)
        const sourceInfo = {
            user_id: userId,
            name: source.name,
            url: source.url,
            type: source.type,
            ...accountInfo
        };

        // Add type-specific credentials
        if (source.type === 'xtream') {
            sourceInfo.username = source.username;
            sourceInfo.password = source.password;
        } else if (source.type === 'stalker') {
            sourceInfo.mac_address = source.mac_address;
        }

        await iptvDatabaseService.saveSource(sourceInfo);
        logger.info(`Updated source ${sourceId} with fresh account info`);

        // 4. Generate categories from channels (if not already provided by Stalker)
        if (!categories) {
            const categoryMap = channelsResult.channels.reduce((acc, ch) => {
                const groupTitle = ch.groupTitle || ch.group || 'Uncategorized';
                acc[groupTitle] = (acc[groupTitle] || 0) + 1;
                return acc;
            }, {});

            logger.info(`Category breakdown: ${JSON.stringify(categoryMap, null, 2)}`);

            categories = Object.entries(categoryMap)
                .map(([name, count]) => ({
                    id: name,
                    name,
                    count
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        logger.info(`Generated ${categories.length} categories`);
        await iptvDatabaseService.saveCategories(sourceId, categories);
        logger.info(`Saved ${categories.length} categories for source ${sourceId}`);

        // 5. Transform and save channels
        const dbChannels = channelsResult.channels.map(ch => ({
            id: ch.id || ch.name,
            name: ch.name,
            logo: ch.logo || '',
            url: ch.url,
            group: { title: ch.groupTitle || ch.group || 'Uncategorized' },
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

/**
 * PATCH /api/iptv/sources/:sourceId/auto-detect-live
 * Update auto-detect live setting for a source
 */
router.patch('/sources/:sourceId/auto-detect-live', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);
        const { autoDetectLive } = req.body;

        if (typeof autoDetectLive !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'autoDetectLive must be a boolean'
            });
        }

        await iptvDatabaseService.updateSourceAutoDetectLive(userId, sourceId, autoDetectLive);

        res.json({
            success: true,
            message: `Auto-detect live ${autoDetectLive ? 'enabled' : 'disabled'} for source`
        });
    } catch (error) {
        logger.error(`Error updating source auto-detect live: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update auto-detect live setting'
        });
    }
});

/**
 * PATCH /api/iptv/channels/:channelId/live-prefix
 * Update live prefix setting for a channel
 */
router.patch('/channels/:channelId/live-prefix', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const channelId = req.params.channelId;
        const { enableLivePrefix } = req.body;

        if (typeof enableLivePrefix !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'enableLivePrefix must be a boolean'
            });
        }

        await iptvDatabaseService.updateChannelLivePrefix(userId, channelId, enableLivePrefix);

        res.json({
            success: true,
            message: `Live prefix ${enableLivePrefix ? 'enabled' : 'disabled'} for channel`
        });
    } catch (error) {
        logger.error(`Error updating channel live prefix: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to update live prefix setting'
        });
    }
});

module.exports = router;
