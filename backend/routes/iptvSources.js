const express = require('express');
const router = express.Router();
const iptvDatabaseService = require('../services/iptvDatabase');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const epgService = require('../services/epgService');
const logger = require('../config/logger');
const postgresService = require('../services/postgresService');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

// Promisify execFile for stream testing
const execFileAsync = promisify(execFile);

/**
 * Lookup server location from IP address using free ip-api.com service
 * @param {string} url - The server URL
 * @returns {Promise<{country: string, city: string} | null>}
 */
async function lookupServerLocation(url) {
    try {
        // Extract hostname from URL
        const urlObj = new URL(url.startsWith('http') ? url : `http://${url}`);
        let hostname = urlObj.hostname;

        // If it's already an IP, use it directly
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        let ip = hostname;

        if (!ipRegex.test(hostname)) {
            // Resolve hostname to IP
            try {
                const addresses = await dns.resolve4(hostname);
                if (addresses && addresses.length > 0) {
                    ip = addresses[0];
                }
            } catch (dnsError) {
                logger.warn(`DNS lookup failed for ${hostname}: ${dnsError.message}`);
                return null;
            }
        }

        // Use ip-api.com (free, no API key needed, 45 requests/minute limit)
        const axios = require('axios');
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,city`, {
            timeout: 5000
        });

        if (response.data && response.data.status === 'success') {
            return {
                country: response.data.country || null,
                city: response.data.city || null
            };
        }
        return null;
    } catch (error) {
        logger.warn(`Failed to lookup server location: ${error.message}`);
        return null;
    }
}

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

        await iptvDatabaseService.deleteSource(sourceId, userId);
        logger.info(`Deleted source ${sourceId} for user ${userId}`);

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
 * Helper function to update refresh status to error in database
 * Called on all failure paths to ensure consistent error tracking
 */
async function updateRefreshStatusError(sourceId, errorMessage, refreshStartTime) {
    try {
        const refreshDuration = Date.now() - refreshStartTime;
        await iptvDatabaseService.pool.query(`
            UPDATE iptv_sources
            SET last_refresh_status = 'error',
                last_refresh_error = $1,
                last_refresh_attempt = CURRENT_TIMESTAMP,
                last_refresh_duration_ms = $3,
                failure_count = COALESCE(failure_count, 0) + 1,
                last_failure_time = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [errorMessage, sourceId, refreshDuration]);
    } catch (updateError) {
        logger.error(`Failed to update refresh status: ${updateError.message}`);
    }
}

/**
 * POST /api/iptv/sources/:sourceId/refresh-account-info
 * Re-fetch channels and account information from Xtream API or Stalker portal
 */
router.post('/sources/:sourceId/refresh-account-info', requireAuth, async (req, res) => {
    const sourceId = parseInt(req.params.sourceId);
    const refreshStartTime = Date.now();

    try {
        const userId = req.user.id;

        // Get source details from database
        const sources = await iptvDatabaseService.getUserIPTVSources(userId);
        const source = sources.find(s => s.id === sourceId);

        logger.info(`[REFRESH DEBUG] Found ${sources.length} sources for user ${userId}`);
        logger.info(`[REFRESH DEBUG] Looking for source ID ${sourceId}`);
        logger.info(`[REFRESH DEBUG] Source found: ${JSON.stringify(source, null, 2)}`);

        if (!source) {
            // Source not found - can't update DB status since we don't know if it exists
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
        } else if (source.type === 'stalker' && source.url && (source.mac_address || source.mac)) {
            const macAddress = source.mac_address || source.mac;
            cacheKey = `${source.url}:${macAddress}`.replace(/[\/\\:]/g, '_');
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
        logger.info(`[REFRESH DEBUG] Source mac: ${source.mac}`);

        if (source.type === 'xtream') {
            if (!source.url || !source.username || !source.password) {
                const errorMsg = 'Xtream source missing required credentials';
                logger.error(`[REFRESH DEBUG] ${errorMsg}`);
                await updateRefreshStatusError(sourceId, errorMsg, refreshStartTime);
                return res.status(400).json({
                    success: false,
                    error: errorMsg
                });
            }
        } else if (source.type === 'stalker') {
            // Check both mac_address and mac columns (PostgreSQL has both)
            const macAddress = source.mac_address || source.mac;
            if (!source.url || !macAddress) {
                const errorMsg = 'Stalker source missing required credentials (URL or MAC address)';
                logger.error(`[REFRESH DEBUG] Stalker source validation failed - url: ${!!source.url}, mac_address: ${!!source.mac_address}, mac: ${!!source.mac}`);
                await updateRefreshStatusError(sourceId, errorMsg, refreshStartTime);
                return res.status(400).json({
                    success: false,
                    error: errorMsg
                });
            }
            // Normalize to mac_address for consistency
            if (!source.mac_address && source.mac) {
                source.mac_address = source.mac;
            }
        } else {
            const errorMsg = `Unsupported source type: ${source.type}. Can only refresh Xtream or Stalker sources`;
            logger.error(`[REFRESH DEBUG] ${errorMsg}`);
            await updateRefreshStatusError(sourceId, errorMsg, refreshStartTime);
            return res.status(400).json({
                success: false,
                error: errorMsg
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
        const groupTitle = ch => ch.groupTitle || ch.group || 'Uncategorized';
        const dbChannels = channelsResult.channels
            .filter(ch => ch.name && ch.name.trim() !== '') // Filter out channels with null/empty names
            .map(ch => ({
                id: ch.id || ch.name,
                name: ch.name,
                logo: ch.logo || '',
                url: ch.url,
                group_title: groupTitle(ch),
                category: groupTitle(ch),
                tvg_id: ch.epgChannelId || '',
                tvg_name: ch.name,
                source_type: source.type,
                source_username: source.username || null,
                source_password: source.password || null,
                source_url: source.url,
                source_mac: source.mac_address || null
            }));

        const filteredCount = channelsResult.channels.length - dbChannels.length;
        if (filteredCount > 0) {
            logger.warn(`Filtered out ${filteredCount} channels with null/empty names`);
        }

        await iptvDatabaseService.saveChannels(sourceId, dbChannels);
        logger.info(`Saved ${dbChannels.length} channels for source ${sourceId}`);

        // Lookup server location if not already set
        let locationUpdate = '';
        let locationParams = [];
        if (!source.server_country && source.url) {
            const location = await lookupServerLocation(source.url);
            if (location) {
                locationUpdate = ', server_country = $3, server_city = $4';
                locationParams = [location.country, location.city];
                logger.info(`Found server location for source ${sourceId}: ${location.city}, ${location.country}`);
            }
        }

        // Update refresh status to success and reset failure count
        const refreshDuration = Date.now() - refreshStartTime;
        await iptvDatabaseService.pool.query(`
            UPDATE iptv_sources
            SET last_refresh_status = 'success',
                last_refresh_error = NULL,
                last_refresh_attempt = CURRENT_TIMESTAMP,
                last_successful_refresh = CURRENT_TIMESTAMP,
                last_refresh_duration_ms = $2,
                failure_count = 0
                ${locationUpdate}
            WHERE id = $1
        `, [sourceId, refreshDuration, ...locationParams]);

        // Get the updated source with channel count
        const updatedSource = await iptvDatabaseService.getUserSources(userId, null);
        const refreshedSource = updatedSource.find(s => s.id === parseInt(sourceId));

        res.json({
            success: true,
            message: 'Channels and account information refreshed successfully',
            channelCount: dbChannels.length,
            categoryCount: categories.length,
            accountInfo,
            source: refreshedSource // Include updated source with channel count
        });
    } catch (error) {
        logger.error(`Error refreshing source data: ${error.message}`);

        // Update refresh status to error and increment failure count
        await updateRefreshStatusError(sourceId, error.message, refreshStartTime);

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

        // Update channel live prefix in PostgreSQL
        await postgresService.query(`
            UPDATE iptv_channels
            SET enable_live_prefix = $1
            WHERE channel_id = $2
            AND source_id IN (
                SELECT id FROM iptv_sources WHERE user_id = $3
            )
        `, [enableLivePrefix, channelId, userId]);

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

/**
 * POST /api/iptv/sources/:sourceId/test-streams
 * Test stream connectivity for a source (on-demand, triggered by user)
 * Prioritizes US channels for better success rates
 */
router.post('/sources/:sourceId/test-streams', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceId = parseInt(req.params.sourceId);

        // Get source info
        const sources = await iptvDatabaseService.getUserSources(userId, null);
        const source = sources.find(s => s.id === sourceId);

        if (!source) {
            return res.status(404).json({
                success: false,
                error: 'Source not found'
            });
        }

        // Get channels for this source (include source metadata for URL building)
        const channelsResult = await iptvDatabaseService.pool.query(`
            SELECT channel_id, name, stream_url, group_title,
                   source_type, source_url, source_username, source_password, source_mac
            FROM iptv_channels
            WHERE source_id = $1
        `, [sourceId]);

        const channels = channelsResult.rows;

        if (channels.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No channels found for this source. Try refreshing first.'
            });
        }

        // Initialize diagnostics
        const streamDiagnostics = {
            tested: 0,
            passed: 0,
            failed: 0,
            results: [],
            errorBreakdown: {
                auth: 0,
                timeout: 0,
                connection: 0,
                notFound: 0,
                noVideo: 0,
                other: 0
            },
            serverLocation: null,
            suggestions: [],
            overallStatus: 'unknown'
        };

        // Get server location
        if (source.server_country || source.server_city) {
            streamDiagnostics.serverLocation = {
                country: source.server_country,
                city: source.server_city
            };
        } else {
            const location = await lookupServerLocation(source.url);
            if (location) {
                streamDiagnostics.serverLocation = location;
            }
        }

        // Smart channel selection: prioritize US channels
        const usPatterns = [
            /\bUS\b/i, /\bUSA\b/i, /\bUnited States\b/i, /\bAmerica\b/i,
            /\bCBS\b/i, /\bNBC\b/i, /\bABC\b/i, /\bFOX\b/i, /\bESPN\b/i,
            /\bCNN\b/i, /\bHBO\b/i, /\bShowtime\b/i, /\bNFL\b/i, /\bNBA\b/i,
            /\bMLB\b/i, /\bNHL\b/i, /\bHD\b/i, /\bFHD\b/i
        ];

        // Score channels by likelihood of being US/working
        const scoredChannels = channels.map(ch => {
            let score = 0;
            const name = ch.name || '';
            const group = ch.group_title || '';
            const combined = `${name} ${group}`;

            for (const pattern of usPatterns) {
                if (pattern.test(combined)) {
                    score += 10;
                }
            }

            // Prefer channels with HD in name (usually more reliable)
            if (/HD|FHD|4K/i.test(name)) {
                score += 5;
            }

            // Penalize channels that look like they might be regional/foreign
            if (/\b(UK|CA|MX|AR|BR|DE|FR|IT|ES|PT|RU|IN|PK)\b/i.test(combined)) {
                score -= 5;
            }

            return { ...ch, score };
        });

        // Sort by score descending, then shuffle within score tiers for variety
        scoredChannels.sort((a, b) => b.score - a.score);

        // Take top 20 by score, then randomly pick 5 from those
        const topChannels = scoredChannels.slice(0, Math.min(20, scoredChannels.length));
        const channelsToTest = [];
        const testCount = Math.min(5, topChannels.length);

        for (let i = 0; i < testCount; i++) {
            const randomIndex = Math.floor(Math.random() * topChannels.length);
            channelsToTest.push(topChannels.splice(randomIndex, 1)[0]);
        }

        logger.info(`Testing ${channelsToTest.length} streams for source ${sourceId} (${source.name})`);

        // Test each channel
        for (const testChannel of channelsToTest) {
            streamDiagnostics.tested++;
            const result = {
                channelName: testChannel.name,
                category: testChannel.group_title || 'Unknown',
                status: 'unknown',
                error: null,
                errorType: null,
                resolution: null,
                responseTime: null
            };

            const startTime = Date.now();

            try {
                let streamUrl = testChannel.stream_url;
                let ffprobeHeaders = null;

                // Build URL based on source type (matching liveEvents.js logic)
                if (!streamUrl || testChannel.source_type === 'xtream') {
                    if (testChannel.source_type === 'xtream' && testChannel.source_url && testChannel.source_username && testChannel.source_password) {
                        // Extract channel number from channel_id (e.g., "xtream_12345" -> "12345")
                        const channelNum = testChannel.channel_id.replace(/^xtream_/, '');
                        const baseUrl = testChannel.source_url.replace(/\/+$/, '');
                        streamUrl = `${baseUrl}/live/${testChannel.source_username}/${testChannel.source_password}/${channelNum}.ts`;
                    }
                }

                // Handle Stalker portal - need to get fresh token
                if (testChannel.source_type === 'stalker' && streamUrl && streamUrl.includes('portal.php') && streamUrl.includes('action=create_link')) {
                    try {
                        const axios = require('axios');
                        const stalkerHeaders = {
                            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                            'X-User-Agent': 'Model: MAG250; Link: WiFi'
                        };
                        if (testChannel.source_mac) {
                            stalkerHeaders['Cookie'] = `mac=${testChannel.source_mac}; stb_lang=en; timezone=America/New_York`;
                        }

                        const createLinkResponse = await axios.get(streamUrl, {
                            headers: stalkerHeaders,
                            timeout: 5000
                        });

                        if (createLinkResponse.data?.js?.cmd) {
                            const freshCmd = createLinkResponse.data.js.cmd;
                            // Extract fresh play_token from response
                            const freshTokenMatch = freshCmd.match(/play_token=([^&\s"]+)/);
                            const freshToken = freshTokenMatch ? freshTokenMatch[1] : null;

                            // Extract stream ID from ORIGINAL URL
                            const originalCmdMatch = streamUrl.match(/cmd=([^&]+)/);
                            if (originalCmdMatch && freshToken) {
                                const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                                const originalStreamMatch = originalCmd.match(/stream=(\d+)/);
                                const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                                if (originalStreamId) {
                                    const baseUrlMatch = freshCmd.match(/http[s]?:\/\/[^\/]+/);
                                    const macParam = testChannel.source_mac ? `mac=${testChannel.source_mac}` : '';
                                    if (baseUrlMatch) {
                                        streamUrl = `${baseUrlMatch[0]}/play/live.php?${macParam}&stream=${originalStreamId}&extension=ts&play_token=${freshToken}`;
                                        ffprobeHeaders = `Cookie: mac=${testChannel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`;
                                    }
                                }
                            }

                            // Fallback: try to extract URL directly from response
                            if (!streamUrl || streamUrl.includes('portal.php')) {
                                const match = freshCmd.match(/http[s]?:\/\/[^\s"]+/);
                                if (match && !match[0].includes('stream=&')) {
                                    streamUrl = match[0];
                                    ffprobeHeaders = `Cookie: mac=${testChannel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`;
                                }
                            }
                        }
                    } catch (stalkerError) {
                        result.status = 'failed';
                        result.error = `Stalker auth failed: ${stalkerError.message}`;
                        result.errorType = 'connection';
                        streamDiagnostics.errorBreakdown.connection++;
                        streamDiagnostics.failed++;
                        streamDiagnostics.results.push(result);
                        continue;
                    }
                }

                if (!streamUrl) {
                    result.status = 'failed';
                    result.error = 'No stream URL available';
                    result.errorType = 'other';
                    streamDiagnostics.errorBreakdown.other++;
                    streamDiagnostics.failed++;
                    streamDiagnostics.results.push(result);
                    continue;
                }

                logger.info(`Testing stream: ${testChannel.name} (${testChannel.source_type}) URL: ${streamUrl?.substring(0, 100)}...`);

                // Use ffprobe to validate stream (matching liveEvents.js args)
                const FFPROBE_TIMEOUT = 5000;
                const ffprobeArgs = [
                    '-v', 'error',
                    '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height,codec_name',
                    '-of', 'json',
                    '-timeout', String(FFPROBE_TIMEOUT * 1000)
                ];

                if (ffprobeHeaders) {
                    ffprobeArgs.push('-headers', ffprobeHeaders);
                }
                ffprobeArgs.push(streamUrl);

                const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
                    timeout: FFPROBE_TIMEOUT + 2000,
                    maxBuffer: 1024 * 1024
                });

                result.responseTime = Date.now() - startTime;
                const probeData = JSON.parse(stdout);
                const videoStream = probeData.streams?.[0];

                if (videoStream) {
                    result.status = 'passed';
                    result.resolution = videoStream.height ? `${videoStream.height}p` : 'unknown';
                    streamDiagnostics.passed++;
                    logger.info(`Stream test PASSED: ${testChannel.name} (${result.resolution})`);
                } else {
                    result.status = 'failed';
                    result.error = 'No video stream found';
                    result.errorType = 'noVideo';
                    streamDiagnostics.errorBreakdown.noVideo++;
                    streamDiagnostics.failed++;
                }
            } catch (streamError) {
                result.responseTime = Date.now() - startTime;
                result.status = 'failed';
                const errorMsg = streamError.message || String(streamError);
                result.error = errorMsg.split('\n')[0].substring(0, 200);

                if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
                    result.errorType = 'auth';
                    result.error = 'HTTP 401 Unauthorized';
                    streamDiagnostics.errorBreakdown.auth++;
                } else if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
                    result.errorType = 'auth';
                    result.error = 'HTTP 403 Forbidden';
                    streamDiagnostics.errorBreakdown.auth++;
                } else if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
                    result.errorType = 'notFound';
                    result.error = 'HTTP 404 Not Found';
                    streamDiagnostics.errorBreakdown.notFound++;
                } else if (errorMsg.includes('timed out') || errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
                    result.errorType = 'timeout';
                    result.error = 'Connection timed out';
                    streamDiagnostics.errorBreakdown.timeout++;
                } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ECONNRESET') || errorMsg.includes('ENOTFOUND')) {
                    result.errorType = 'connection';
                    result.error = 'Connection failed';
                    streamDiagnostics.errorBreakdown.connection++;
                } else {
                    result.errorType = 'other';
                    streamDiagnostics.errorBreakdown.other++;
                }

                streamDiagnostics.failed++;
                logger.warn(`Stream test FAILED: ${testChannel.name} - ${result.error}`);
            }

            streamDiagnostics.results.push(result);
        }

        // Determine overall status
        const passRate = streamDiagnostics.tested > 0 ? streamDiagnostics.passed / streamDiagnostics.tested : 0;

        if (passRate === 1) {
            streamDiagnostics.overallStatus = 'healthy';
        } else if (passRate >= 0.5) {
            streamDiagnostics.overallStatus = 'partial';
            streamDiagnostics.suggestions.push('Some channels are working. Dead channels are normal for IPTV (30-50% is common).');
        } else if (passRate > 0) {
            streamDiagnostics.overallStatus = 'degraded';
            streamDiagnostics.suggestions.push('Most channels failed. This source may have issues.');
        } else {
            streamDiagnostics.overallStatus = 'failing';
        }

        // Generate suggestions based on error patterns
        if (streamDiagnostics.failed > 0 && streamDiagnostics.errorBreakdown.auth > 0) {
            const authPercent = Math.round((streamDiagnostics.errorBreakdown.auth / streamDiagnostics.failed) * 100);
            if (authPercent >= 50) {
                streamDiagnostics.suggestions.push('Authentication errors detected. Possible causes:');
                streamDiagnostics.suggestions.push('• Your IP may be geo-blocked - try using a VPN');
                if (streamDiagnostics.serverLocation?.city || streamDiagnostics.serverLocation?.country) {
                    streamDiagnostics.suggestions.push(`• Suggested VPN location: ${streamDiagnostics.serverLocation.city || streamDiagnostics.serverLocation.country}`);
                }
                streamDiagnostics.suggestions.push('• Check for concurrent connection limits');
                streamDiagnostics.suggestions.push('• Verify subscription is active');
            }
        }

        if (streamDiagnostics.errorBreakdown.timeout > streamDiagnostics.tested * 0.5) {
            streamDiagnostics.suggestions.push('Many timeout errors. Server may be slow or overloaded.');
        }

        if (streamDiagnostics.errorBreakdown.connection > streamDiagnostics.tested * 0.5) {
            streamDiagnostics.suggestions.push('Connection errors. Server may be down or blocked by ISP.');
        }

        logger.info(`Stream test complete for source ${sourceId}: ${streamDiagnostics.passed}/${streamDiagnostics.tested} passed (${streamDiagnostics.overallStatus})`);

        res.json({
            success: true,
            diagnostics: streamDiagnostics
        });
    } catch (error) {
        logger.error(`Error testing streams: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to test streams'
        });
    }
});

module.exports = router;
