// Add imports for iptv database service
const iptvDbService = require('./iptvDatabaseService');
// ... existing code ...

/**
 * Process M3U data for a session
 */
async function processM3UForSession(sessionId, m3uData, options = {}) {
    try {
        logger.info(`Processing M3U data for session ${sessionId}`);
        
        // Parse the M3U file
        const channels = parseM3U(m3uData);
        logger.info(`Parsed ${channels.length} channels from M3U data`);
        
        // Create source info for database
        const sourceInfo = {
            name: options.name || 'M3U Import',
            url: options.url || 'direct-upload',
            username: options.username || '',
            password: options.password || '',
            type: 'm3u'
        };
        
        // Connect to database
        await iptvDbService.connect();
        
        // Save source to database
        const sourceId = await iptvDbService.saveSource(sourceInfo);
        logger.info(`Saved M3U source to database with ID ${sourceId}`);
        
        // Generate categories from channels
        const categories = generateCategoriesFromChannels(channels);
        
        // Save categories to database
        await iptvDbService.saveCategories(sourceId, categories.map(cat => ({
            id: cat.id || cat.name,
            name: cat.name
        })));
        
        // Save channels to database
        await iptvDbService.saveChannels(sourceId, channels);
        
        // Associate source with session
        await iptvDbService.associateSourceWithSession(sessionId, sourceId);
        
        // Return the processed data
        return {
            sourceId,
            channelCount: channels.length,
            categoryCount: categories.length
        };
    } catch (error) {
        logger.error(`Error processing M3U for session ${sessionId}: ${error.message}`);
        throw error;
    }
}

/**
 * Process Xtream data for a session
 */
async function processXtreamForSession(sessionId, xtreamData, options = {}) {
    try {
        logger.info(`Processing Xtream data for session ${sessionId} from ${xtreamData.url}`);
        
        // Create source info for database
        const sourceInfo = {
            name: options.name || 'Xtream Provider',
            url: xtreamData.url,
            username: xtreamData.username,
            password: xtreamData.password,
            type: 'xtream'
        };
        
        // Connect to database
        await iptvDbService.connect();
        
        // Save source to database
        const sourceId = await iptvDbService.saveSource(sourceInfo);
        logger.info(`Saved Xtream source to database with ID ${sourceId}`);
        
        // Fetch channels from API
        const { channels, categories } = await fetchXtreamData(xtreamData);
        
        // Save categories to database
        await iptvDbService.saveCategories(sourceId, categories);
        
        // Save channels to database
        await iptvDbService.saveChannels(sourceId, channels);
        
        // Associate source with session
        await iptvDbService.associateSourceWithSession(sessionId, sourceId);
        
        // Return the processed data
        return {
            sourceId,
            channelCount: channels.length,
            categoryCount: categories.length
        };
    } catch (error) {
        logger.error(`Error processing Xtream for session ${sessionId}: ${error.message}`);
        throw error;
    }
}

/**
 * Get channels for a session from the database
 */
async function getChannelsForSession(sessionId, options = {}) {
    try {
        // Connect to database
        await iptvDbService.connect();
        
        // Get channels from database
        return await iptvDbService.getChannelsForSession(sessionId, options);
    } catch (error) {
        logger.error(`Error getting channels for session ${sessionId}: ${error.message}`);
        throw error;
    }
}

/**
 * Get categories for a session from the database
 */
async function getCategoriesForSession(sessionId) {
    try {
        // Connect to database
        await iptvDbService.connect();
        
        // Get categories from database
        return await iptvDbService.getCategoriesForSession(sessionId);
    } catch (error) {
        logger.error(`Error getting categories for session ${sessionId}: ${error.message}`);
        throw error;
    }
}

/**
 * Search channels by name for a session from the database
 */
async function searchChannels(sessionId, query, limit = 100) {
    try {
        // Connect to database
        await iptvDbService.connect();
        
        // Search channels from database
        return await iptvDbService.searchChannels(sessionId, query, limit);
    } catch (error) {
        logger.error(`Error searching channels for session ${sessionId}: ${error.message}`);
        throw error;
    }
}

/**
 * Update EPG channel ID mapping in the database
 */
async function updateChannelEpgMapping(sessionId, channelId, epgChannelId) {
    try {
        // Connect to database
        await iptvDbService.connect();
        
        // Update mapping in database
        return await iptvDbService.updateChannelEpgMapping(sessionId, channelId, epgChannelId);
    } catch (error) {
        logger.error(`Error updating EPG mapping for channel ${channelId}: ${error.message}`);
        throw error;
    }
}

// Add new functions to module.exports
module.exports = {
    // ... existing exports ...
    processM3UForSession,
    processXtreamForSession,
    getChannelsForSession,
    getCategoriesForSession,
    searchChannels,
    updateChannelEpgMapping
}; 