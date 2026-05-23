/**
 * EPG Parser Service - Main Orchestrator
 * Replaces Python epg_parser.py with Node.js implementation
 * Coordinates downloading, parsing, and database operations
 */

const crypto = require('crypto');
const logger = require('../config/logger');
const xmltvParser = require('./xmltvParser');
const epgDownloader = require('./epgDownloader');
const epgDatabaseService = require('./epgDatabaseService');
const configService = require('./configService');
const { pool } = require('./postgresService');

const STREAMING_ENABLED = process.env.EPG_REFRESH_STREAMING !== 'false';

/**
 * Generate source ID from URL (MD5 hash)
 *
 * @param {string} url - EPG source URL
 * @returns {string} Source ID
 */
function generateSourceId(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

/**
 * Parse and load EPG data from a single source
 *
 * @param {Object} sourceConfig - Source configuration
 * @param {string} sourceConfig.name - Source name
 * @param {string} sourceConfig.url - Source URL
 * @param {Object} options - Parsing options
 * @param {boolean} options.force - Force download even if cache is valid
 * @param {boolean} options.cache - Use caching (default: true)
 * @returns {Promise<Object>} Parsing result
 */
async function parseEpgSource(sourceConfig, options = {}) {
  const { force = false, cache = true, onProgress = null } = options;
  const startTime = Date.now();

  try {
    logger.info(`[EPG Parser] Starting parse for source: ${sourceConfig.name}`);

    // 1. Generate source ID
    const sourceId = generateSourceId(sourceConfig.url);

    // 2. Register source in database
    await epgDatabaseService.saveSource({
      id: sourceId,
      name: sourceConfig.name,
      url: sourceConfig.url,
      filePath: null,
      channelCount: 0,
      programCount: 0
    });

    // 3. Download/cache EPG file
    if (onProgress) onProgress(`Downloading ${sourceConfig.name}...`);

    // Wrap onProgress to include source name in all messages
    const wrappedProgress = onProgress ? (msg) => {
      // If message already includes source name, use as-is
      if (msg.includes(sourceConfig.name)) {
        onProgress(msg);
      } else {
        // Prepend source name to progress messages
        onProgress(`[${sourceConfig.name}] ${msg}`);
      }
    } : null;

    const filePath = await epgDownloader.download(sourceConfig.url, {
      force,
      cache,
      onProgress: wrappedProgress
    });

    if (!filePath) {
      throw new Error('Failed to download EPG file');
    }

    // 4. Update source with file path
    await epgDatabaseService.saveSource({
      id: sourceId,
      name: sourceConfig.name,
      url: sourceConfig.url,
      filePath: filePath,
      channelCount: 0,
      programCount: 0
    });

    // 5. Per-source replace: clear only this source's existing rows
    //    so the guide stays available for other sources while this
    //    one refreshes.
    //
    //    Post-034: epg_programs is partitioned by source_id. We
    //    TRUNCATE the source's partition instead of DELETE-ing —
    //    instant, no dead tuples, sibling partitions untouched. The
    //    epgDatabaseService.ensureProgramsPartition call is a no-op
    //    on pre-034 databases; if the partition exists we TRUNCATE
    //    it, otherwise we fall back to the old DELETE path.
    if (STREAMING_ENABLED) {
      if (onProgress) onProgress(`Clearing old data for ${sourceConfig.name}...`);
      const partitionName = await epgDatabaseService.ensureProgramsPartition(sourceId);
      if (partitionName) {
        // ONLY clause keeps TRUNCATE scoped to the partition itself —
        // without it Postgres would cascade-truncate the parent's
        // partitions which would be catastrophic.
        await pool.query(`TRUNCATE TABLE ONLY "${partitionName}"`);
      } else {
        await pool.query('DELETE FROM epg_programs WHERE source_id = $1', [sourceId]);
      }
      await pool.query('DELETE FROM epg_channels WHERE source_id = $1', [sourceId]);
    }

    // 6. Parse EVERYTHING in single pass (channels + programs)
    logger.info(`[EPG Parser] Parsing ${sourceConfig.name} from ${filePath}...`);
    if (onProgress) onProgress(`Parsing ${sourceConfig.name}...`);
    const parseFn = STREAMING_ENABLED
      ? xmltvParser.parseSinglePassStreaming
      : xmltvParser.parseSinglePass;
    const result = await parseFn(filePath, sourceId, wrappedProgress, epgDatabaseService);

    if (result.channelCount === 0) {
      logger.warn(`[EPG Parser] No channels found in ${sourceConfig.name}`);
      return {
        success: false,
        sourceId,
        sourceName: sourceConfig.name,
        channelCount: 0,
        programCount: 0,
        duration: Date.now() - startTime,
        error: 'No channels found'
      };
    }

    // Update source statistics
    await epgDatabaseService.updateSourceStats(
      sourceId,
      result.channelCount,
      result.programCount
    );

    const duration = Date.now() - startTime;
    logger.info(`[EPG Parser] ✓ Successfully processed ${sourceConfig.name} in ${(duration / 1000).toFixed(1)}s`);
    logger.info(`[EPG Parser] Extracted ${result.channelCount} channels and ${result.programCount} programs`);

    return {
      success: true,
      sourceId,
      sourceName: sourceConfig.name,
      channelCount: result.channelCount,
      programCount: result.programCount,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`[EPG Parser] Failed to process ${sourceConfig.name}: ${error.message}`);

    // In streaming mode we've already cleared old rows and may have
    // streamed partial new rows before failing. Clean those up so
    // the source ends up empty rather than half-populated. Use the
    // same partition-TRUNCATE-or-DELETE strategy as the success path.
    if (STREAMING_ENABLED) {
      try {
        const sourceId = generateSourceId(sourceConfig.url);
        const partitionName = await epgDatabaseService.ensureProgramsPartition(sourceId);
        if (partitionName) {
          await pool.query(`TRUNCATE TABLE ONLY "${partitionName}"`);
        } else {
          await pool.query('DELETE FROM epg_programs WHERE source_id = $1', [sourceId]);
        }
        await pool.query('DELETE FROM epg_channels WHERE source_id = $1', [sourceId]);
      } catch (cleanupErr) {
        logger.warn(`[EPG Parser] Failure-cleanup error for ${sourceConfig.name}: ${cleanupErr.message}`);
      }
    }

    return {
      success: false,
      sourceName: sourceConfig.name,
      error: error.message,
      duration
    };
  }
}

/**
 * Parse and load EPG data from all configured sources
 *
 * @param {Object} options - Parsing options
 * @param {boolean} options.force - Force download even if cache is valid
 * @param {boolean} options.cache - Use caching (default: true)
 * @param {boolean} options.dropIndexes - Drop indexes before bulk load (default: true)
 * @returns {Promise<Object>} Parsing results for all sources
 */
async function parseAllSources(options = {}) {
  const { force = false, cache = true, dropIndexes = true, onProgress = null } = options;
  const startTime = Date.now();

  // Helper to broadcast progress
  const broadcastProgress = (message) => {
    logger.info(`[EPG Parser] ${message}`);
    if (onProgress && typeof onProgress === 'function') {
      onProgress(message);
    }
  };

  try {
    broadcastProgress('Starting EPG refresh for all sources...');

    // Load EPG sources from config
    const sources = await configService.getEpgSources();
    broadcastProgress(`Found ${sources.length} EPG sources to process`);

    if (sources.length === 0) {
      broadcastProgress('No EPG sources configured');
      return {
        success: true,
        results: [],
        summary: {
          totalSources: 0,
          successfulSources: 0,
          failedSources: 0,
          totalChannels: 0,
          totalPrograms: 0,
          totalDuration: 0
        }
      };
    }

    // Streaming mode replaces data one source at a time (inside parseEpgSource)
    // so the guide stays available and a single source failure doesn't wipe
    // everything. Legacy mode keeps the global drop/truncate behaviour.
    if (!STREAMING_ENABLED) {
      if (dropIndexes) {
        broadcastProgress('Dropping indexes for bulk load performance...');
        await epgDatabaseService.dropIndexes();
      }
      broadcastProgress('Clearing all existing EPG data...');
      await epgDatabaseService.truncateAllEpgData();
      broadcastProgress('EPG data cleared, ready for fresh import');
    } else {
      broadcastProgress('Streaming refresh enabled — data will be replaced per source');
    }

    // Process each source sequentially (to avoid overwhelming the system)
    const results = [];

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      broadcastProgress(`Processing source ${i + 1}/${sources.length}: ${source.name}`);

      try {
        const result = await parseEpgSource(source, { force, cache, onProgress: broadcastProgress });
        results.push(result);

        if (result.success) {
          broadcastProgress(`✓ Completed ${source.name}: ${result.channelCount} channels, ${result.programCount} programs`);
        } else {
          broadcastProgress(`✗ Failed ${source.name}: ${result.error || 'Unknown error'}`);
        }
      } catch (error) {
        logger.error(`[EPG Parser] Error processing ${source.name}: ${error.message}`);
        broadcastProgress(`✗ Failed ${source.name}: ${error.message}`);
        results.push({
          success: false,
          sourceName: source.name,
          error: error.message
        });
      }
    }

    // Recreate indexes after bulk loading (legacy path only — streaming mode
    // never drops them).
    if (!STREAMING_ENABLED && dropIndexes) {
      broadcastProgress('Recreating indexes...');
      await epgDatabaseService.recreateIndexes();
    }

    // Calculate statistics
    const successful = results.filter(r => r.success).length;
    const totalChannels = results.reduce((sum, r) => sum + (r.channelCount || 0), 0);
    const totalPrograms = results.reduce((sum, r) => sum + (r.programCount || 0), 0);
    const totalDuration = Date.now() - startTime;

    const completionMsg = `EPG refresh complete! Processed ${successful}/${sources.length} sources - ${totalChannels} channels, ${totalPrograms} programs in ${(totalDuration / 1000).toFixed(1)}s`;
    broadcastProgress(completionMsg);

    return {
      success: successful > 0,
      results,
      summary: {
        totalSources: sources.length,
        successfulSources: successful,
        failedSources: sources.length - successful,
        totalChannels,
        totalPrograms,
        totalDuration
      }
    };
  } catch (error) {
    const errorMsg = `Fatal error during EPG refresh: ${error.message}`;
    logger.error(`[EPG Parser] ${errorMsg}`);
    broadcastProgress(`✗ ${errorMsg}`);
    throw error;
  }
}

/**
 * Get EPG parser statistics
 *
 * @returns {Promise<Object>} EPG statistics
 */
async function getStats() {
  try {
    const dbStats = await epgDatabaseService.getStats();
    const cacheStats = epgDownloader.getCacheStats();

    return {
      database: dbStats,
      cache: cacheStats
    };
  } catch (error) {
    logger.error(`[EPG Parser] Error getting stats: ${error.message}`);
    throw error;
  }
}

/**
 * Clear EPG cache
 *
 * @param {string|null} url - Specific URL to clear, or null for all
 * @returns {boolean} Success status
 */
async function clearCache(url = null) {
  try {
    return epgDownloader.clearCache(url);
  } catch (error) {
    logger.error(`[EPG Parser] Error clearing cache: ${error.message}`);
    return false;
  }
}

module.exports = {
  parseEpgSource,
  parseAllSources,
  getStats,
  clearCache,
  generateSourceId
};
