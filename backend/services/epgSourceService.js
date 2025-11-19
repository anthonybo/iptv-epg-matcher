/**
 * EPG Source Service
 * Handles EPG source management, refresh operations, and status tracking
 */

const logger = require('../utils/logger');
const postgresService = require('./postgresService');
const epgParserService = require('./epgParserService');
const cacheService = require('./cacheService');
const { broadcastSSEUpdate } = require('../utils/sseUtils');

// Load EPG sources from config file (single source of truth)
const EPG_SOURCES_CONFIG = require('../config/epg_sources.json');

// Track running EPG refresh process
let epgRefreshStatus = {
  isRunning: false,
  startedAt: null,
  currentSource: 0,
  totalSources: 0,
  lastMessage: null,
  completedSources: [],
  lastResults: null
};

/**
 * Get only enabled sources (including user-added sources)
 */
async function getEnabledEpgSources() {
  // Get config-based sources
  const configSources = EPG_SOURCES_CONFIG.sources
    .filter(source => source.enabled)
    .map(source => source.url);

  // Get user-added sources from database
  try {
    const result = await postgresService.query(
      'SELECT url FROM user_epg_sources WHERE enabled = true'
    );
    const userSources = result.rows || [];

    if (userSources && userSources.length > 0) {
      const userUrls = userSources.map(s => s.url);
      logger.info(`[EPG Sources] Adding ${userUrls.length} user EPG sources to bulk refresh`);
      return [...configSources, ...userUrls];
    }
  } catch (err) {
    logger.warn(`[EPG Sources] Could not load user EPG sources: ${err.message}`);
  }

  return configSources;
}

/**
 * Get all sources (including disabled ones) with metadata
 */
function getAllEpgSourcesWithMetadata() {
  return EPG_SOURCES_CONFIG.sources;
}

/**
 * Get current EPG refresh status
 */
function getEpgRefreshStatus() {
  return {
    isRunning: epgRefreshStatus.isRunning,
    startedAt: epgRefreshStatus.startedAt,
    currentSource: epgRefreshStatus.currentSource,
    totalSources: epgRefreshStatus.totalSources,
    lastMessage: epgRefreshStatus.lastMessage,
    completedSources: epgRefreshStatus.completedSources || [],
    lastResults: epgRefreshStatus.lastResults
  };
}

/**
 * Helper function to broadcast to all connected clients
 */
function broadcastToAllClients(eventType, data) {
  logger.info(`[Broadcast Helper] Calling broadcastSSEUpdate with eventType: ${eventType}, data type: ${data.type}`);
  broadcastSSEUpdate(data, null);
}

/**
 * Run the EPG parser with progress tracking
 */
const runEpgParser = async (options = {}) => {
  // Check if already running
  if (epgRefreshStatus.isRunning) {
    logger.warn('EPG refresh already in progress, ignoring duplicate request');
    throw new Error('EPG refresh already in progress');
  }

  try {
    epgRefreshStatus = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      currentSource: 0,
      totalSources: 0,
      lastMessage: 'Starting EPG refresh...',
      completedSources: [],
      lastResults: null
    };

    // Broadcast start
    broadcastToAllClients('epg-progress', {
      type: 'epg-progress',
      message: 'Starting EPG refresh...',
      timestamp: new Date().toISOString()
    });

    // Parse all sources with progress callback
    const results = await epgParserService.parseAllSources({
      force: options.force || false,
      cache: true,
      dropIndexes: true,
      onProgress: (message) => {
        // Update status
        epgRefreshStatus.lastMessage = message;

        // Extract source progress from message like "Processing source 2/7: EPG.pw - US"
        const sourceMatch = message.match(/Processing source (\d+)\/(\d+):/);
        if (sourceMatch) {
          epgRefreshStatus.currentSource = parseInt(sourceMatch[1]);
          epgRefreshStatus.totalSources = parseInt(sourceMatch[2]);
        }

        // Extract total sources from message like "Found 7 EPG sources to process"
        const totalMatch = message.match(/Found (\d+) EPG sources to process/);
        if (totalMatch) {
          epgRefreshStatus.totalSources = parseInt(totalMatch[1]);
        }

        // Extract completed source info from message like "✓ Completed EPG Share 01 - All Sources: 15279 channels, 50000 programs"
        const completedMatch = message.match(/✓ Completed (.+?):\s*(\d+) channels?,\s*(\d+) programs?/);
        if (completedMatch) {
          const sourceName = completedMatch[1];
          const channelCount = parseInt(completedMatch[2]);
          const programCount = parseInt(completedMatch[3]);

          epgRefreshStatus.completedSources.push({
            name: sourceName,
            channelCount: channelCount,
            programCount: programCount,
            status: 'complete'
          });

          logger.info(`[EPG Progress] Marked source as complete: ${sourceName} (${channelCount} channels, ${programCount} programs)`);
        }

        // Extract failed source info from message like "✗ Failed EPG Share 01: error message"
        const failedMatch = message.match(/✗ Failed (.+?):\s*(.+)$/);
        if (failedMatch) {
          const sourceName = failedMatch[1];
          const errorMessage = failedMatch[2];

          epgRefreshStatus.completedSources.push({
            name: sourceName,
            channelCount: 0,
            programCount: 0,
            status: 'failed',
            error: errorMessage
          });

          logger.info(`[EPG Progress] Marked source as failed: ${sourceName} - ${errorMessage}`);
        }

        // Debug log
        logger.info(`[EPG Progress Callback] Broadcasting: ${message}`);

        // Broadcast to frontend
        broadcastToAllClients('epg-progress', {
          type: 'epg-progress',
          message: message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Store results and reset running status
    epgRefreshStatus.isRunning = false;
    epgRefreshStatus.lastResults = results;

    if (!results.success) {
      const errorMsg = `EPG refresh completed with errors: ${results.summary.failedSources}/${results.summary.totalSources} sources failed`;
      logger.warn(errorMsg);

      // Broadcast completion with warnings
      broadcastToAllClients('epg-complete', {
        type: 'epg-complete',
        message: errorMsg,
        summary: results.summary,
        timestamp: new Date().toISOString()
      });

      return {
        success: false,
        message: errorMsg,
        results: results
      };
    }

    const successMsg = `EPG refresh completed: ${results.summary.successfulSources}/${results.summary.totalSources} sources successful, ${results.summary.totalChannels} channels, ${results.summary.totalPrograms} programs`;
    logger.info(successMsg);

    // Broadcast completion
    broadcastToAllClients('epg-complete', {
      type: 'epg-complete',
      message: successMsg,
      summary: results.summary,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      message: successMsg,
      results: results
    };
  } catch (error) {
    epgRefreshStatus.isRunning = false;
    logger.error(`EPG refresh error: ${error.message}`);

    // Broadcast error
    broadcastToAllClients('epg-error', {
      type: 'epg-error',
      message: `EPG refresh failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });

    throw error;
  }
};

/**
 * Get all EPG sources with database stats merged in
 */
const getEpgSourcesWithStats = async (userId = null) => {
  try {
    // Get sources from the database (PostgreSQL)
    const result = await postgresService.query(`
      SELECT id, name, url, last_updated, channel_count, program_count
      FROM epg_sources
    `);
    const dbSources = result.rows;

    // Create a map of database sources by URL for quick lookup
    const dbSourceMap = {};
    dbSources.forEach(source => {
      if (source.url) {
        dbSourceMap[source.url] = source;
      }
    });

    // Merge config sources with database data
    const allSourcesMetadata = getAllEpgSourcesWithMetadata();
    const sources = allSourcesMetadata.map((configSource, index) => {
      const dbSource = dbSourceMap[configSource.url];

      return {
        id: dbSource?.id || `source_${index + 1}`,
        name: configSource.name || dbSource?.name || configSource.url.split('/').pop(),
        url: configSource.url,
        enabled: configSource.enabled,
        verified: configSource.verified,
        notes: configSource.notes,
        last_updated: dbSource?.last_updated || null,
        channel_count: dbSource?.channel_count || 0,
        program_count: dbSource?.program_count || 0,
        channelCount: dbSource?.channel_count || 0,
        programCount: dbSource?.program_count || 0,
        isUserSource: false
      };
    });

    // Add user EPG sources if authenticated
    if (userId) {
      const userSourcesResult = await postgresService.query(`
        SELECT id, url, name, enabled, created_at, updated_at
        FROM user_epg_sources
        WHERE user_id = $1
        ORDER BY created_at DESC
      `, [userId]);
      const userSources = userSourcesResult.rows || [];

      // Add user sources to the list
      userSources.forEach(userSource => {
        const dbSource = dbSourceMap[userSource.url];

        // Try to get from cache if not in database
        let channelCount = dbSource?.channel_count || 0;
        let programCount = dbSource?.program_count || 0;
        let lastUpdated = dbSource?.last_updated || null;

        logger.debug(`[EPG Sources] Processing user source: ${userSource.url}, dbSource exists: ${!!dbSource}, dbChannels: ${channelCount}, dbPrograms: ${programCount}`);

        if (!dbSource || channelCount === 0) {
          const cachedData = cacheService.readEpgSourceCache(userSource.url);
          logger.debug(`[EPG Sources] Cache lookup for ${userSource.url}: ${cachedData ? 'FOUND' : 'NOT FOUND'}`, cachedData || {});
          if (cachedData) {
            channelCount = cachedData.channelCount || 0;
            programCount = cachedData.programCount || 0;
            lastUpdated = cachedData.lastUpdated || lastUpdated;
            logger.info(`[EPG Sources] Using cached data for ${userSource.url}: ${channelCount} channels, ${programCount} programs`);
          }
        }

        sources.push({
          id: `user_${userSource.id}`,
          name: userSource.name,
          url: userSource.url,
          enabled: Boolean(userSource.enabled),
          verified: false,
          notes: 'User-added source',
          last_updated: lastUpdated,
          channel_count: channelCount,
          program_count: programCount,
          channelCount: channelCount,
          programCount: programCount,
          isUserSource: true,
          created_at: userSource.created_at,
          updated_at: userSource.updated_at
        });
      });
    }

    return sources;
  } catch (error) {
    logger.error(`Error getting EPG sources with stats: ${error.message}`);
    throw error;
  }
};

module.exports = {
  getEnabledEpgSources,
  getAllEpgSourcesWithMetadata,
  getEpgRefreshStatus,
  runEpgParser,
  getEpgSourcesWithStats
};
