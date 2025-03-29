/**
 * Cache Service - handles file caching operations with support for large data
 */
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { CACHE_DIR, CACHE_TTL } = require('../config/constants');

/**
 * Checks if a cache file exists and is not expired
 * 
 * @param {string} filePath - Path to the cache file
 * @returns {boolean} True if valid cache exists
 */
function isCacheValid(filePath) {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    const stats = fs.statSync(filePath);
    const cacheAge = Date.now() - stats.mtimeMs;
    return cacheAge < CACHE_TTL;
}

/**
 * Reads data from cache file
 * 
 * @param {string} filePath - Path to the cache file
 * @returns {any} Parsed cache data
 */
function readCache(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        logger.error(`Failed to read cache: ${e.message}`, { filePath });
        return null;
    }
}

/**
 * Writes data to cache file with support for large datasets
 * Implements chunking to handle large EPG datasets
 * 
 * @param {string} filePath - Path to the cache file
 * @param {any} data - Data to cache
 * @returns {boolean} True if cache was written successfully
 */
function writeCache(filePath, data) {
    try {
        // Special handling for epgSources which can be extremely large
        if (filePath.includes('epgSources') && typeof data === 'object') {
            // Create a subdirectory for chunked EPG sources
            const chunkDir = `${filePath}_chunks`;
            if (!fs.existsSync(chunkDir)) {
                fs.mkdirSync(chunkDir, { recursive: true });
            }

            // Store metadata and index in the main file
            const sourceIndex = {};
            let totalChannels = 0;
            let totalPrograms = 0;

            // Process each EPG source separately
            Object.keys(data).forEach((sourceKey, index) => {
                try {
                    const source = data[sourceKey];
                    const chunkPath = path.join(chunkDir, `source_${index}_${sanitizeFilename(sourceKey)}.json`);

                    // Get statistics before potentially modifying the source
                    const channelCount = source.channels ? source.channels.length : 0;
                    const programCount = source.programs ? source.programs.length : 0;
                    totalChannels += channelCount;
                    totalPrograms += programCount;

                    // Add index info
                    sourceIndex[sourceKey] = {
                        chunkPath: path.relative(CACHE_DIR, chunkPath),
                        channelCount,
                        programCount,
                        timestamp: Date.now()
                    };

                    // Write the source data to its own file
                    fs.writeFileSync(chunkPath, JSON.stringify(source));
                    logger.info(`Cached EPG source to ${chunkPath}`, {
                        sourceKey,
                        channelCount,
                        programCount
                    });
                } catch (err) {
                    logger.warn(`Skipped caching source ${sourceKey}: ${err.message}`);
                }
            });

            // Write the index file
            fs.writeFileSync(filePath, JSON.stringify({
                _cacheType: 'epgSourceIndex',
                _totalSources: Object.keys(sourceIndex).length,
                _totalChannels: totalChannels,
                _totalPrograms: totalPrograms,
                _timestamp: Date.now(),
                sources: sourceIndex
            }));

            logger.info(`Cached EPG source index to ${filePath}`, {
                sourceCount: Object.keys(sourceIndex).length,
                totalChannels,
                totalPrograms
            });
            return true;
        } else {
            // Standard caching for other types of data
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            logger.info(`Cached data to ${filePath}`);
            return true;
        }
    } catch (e) {
        logger.error(`Failed to write cache: ${e.message}`, { filePath });
        return false;
    }
}

/**
 * Reads EPG sources from cache with improved error handling
 * 
 * @param {string} filePath - Path to the cache file
 * @returns {object|null} The combined EPG sources or null if cache read fails
 */
function readEpgSourcesCache(filePath) {
    try {
        logger.info(`Reading EPG sources cache from ${filePath}`);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            logger.error(`EPG sources cache file not found: ${filePath}`);
            return null;
        }

        // Parse the index file
        const indexData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Validate cache structure
        if (indexData._cacheType !== 'epgSourceIndex') {
            logger.error(`Invalid EPG cache structure: missing _cacheType`);
            return null;
        }

        if (!indexData.sources || typeof indexData.sources !== 'object') {
            logger.error(`Invalid EPG cache structure: missing or invalid sources object`);
            return null;
        }

        const sources = {};
        const chunkDir = `${filePath}_chunks`;

        // Check if chunk directory exists
        if (!fs.existsSync(chunkDir)) {
            logger.error(`EPG chunks directory not found: ${chunkDir}`);
            return null;
        }

        // Get list of chunk files to check availability
        const chunkFiles = fs.readdirSync(chunkDir);

        // Track source loading status
        const sourceResults = {
            success: 0,
            failed: 0,
            skipped: 0
        };

        // Load each source from its chunk file
        for (const sourceKey of Object.keys(indexData.sources)) {
            try {
                const sourceInfo = indexData.sources[sourceKey];

                if (!sourceInfo || !sourceInfo.chunkPath) {
                    logger.warn(`Invalid source info for ${sourceKey}`);
                    sourceResults.skipped++;
                    continue;
                }

                const chunkPath = path.join(CACHE_DIR, sourceInfo.chunkPath);

                if (!fs.existsSync(chunkPath)) {
                    logger.warn(`Chunk file not found for source ${sourceKey}: ${chunkPath}`);
                    sourceResults.skipped++;
                    continue;
                }

                // Read and parse the source data
                const sourceData = fs.readFileSync(chunkPath, 'utf8');
                sources[sourceKey] = JSON.parse(sourceData);

                // Validate basic source structure
                if (!sources[sourceKey].channels || !Array.isArray(sources[sourceKey].channels)) {
                    logger.warn(`Invalid source structure for ${sourceKey}: missing channels array`);
                    delete sources[sourceKey];
                    sourceResults.failed++;
                    continue;
                }

                logger.debug(`Loaded EPG source from ${chunkPath}`, {
                    sourceKey,
                    channelCount: sources[sourceKey].channels.length,
                    channelMapSize: sources[sourceKey].channelMap ? Object.keys(sources[sourceKey].channelMap).length : 0,
                    programCount: sources[sourceKey].programs ? sources[sourceKey].programs.length : 0
                });

                sourceResults.success++;

            } catch (err) {
                logger.error(`Failed to load source ${sourceKey}: ${err.message}`);
                sourceResults.failed++;
            }
        }

        logger.info(`Loaded ${sourceResults.success} sources from cache. Failed: ${sourceResults.failed}, Skipped: ${sourceResults.skipped}`);

        // Check if we should force a reload
        const criticalSources = ['strongepg.ip-ddns.com', 'epgshare01.online'];
        const anyMissing = criticalSources.some(critical =>
            !Object.keys(sources).some(key => key.includes(critical))
        );

        if (Object.keys(sources).length === 0 || anyMissing) {
            logger.warn(`No sources loaded or critical sources missing, forcing reload`);
            return null;
        }

        return sources;
    } catch (e) {
        logger.error(`Failed to read EPG sources cache: ${e.message}`, { stack: e.stack });
        return null;
    }
}

/**
 * Gets the path to cache file for channels
 * 
 * @param {string} cacheKey - Cache key
 * @returns {string} Path to cache file
 */
function getChannelsCachePath(cacheKey) {
    return path.join(CACHE_DIR, `${cacheKey}_channels.json`);
}

/**
 * Gets the path to cache file for EPG sources
 * 
 * @param {string} cacheKey - Cache key
 * @returns {string} Path to cache file
 */
function getEpgSourcesCachePath(cacheKey) {
    return path.join(CACHE_DIR, `${cacheKey}_epgSources.json`);
}

/**
 * Sanitizes a string to be safe for use in filenames
 * 
 * @param {string} filename - Input string
 * @returns {string} Safe filename
 */
function sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

module.exports = {
    isCacheValid,
    readCache,
    writeCache,
    readEpgSourcesCache,
    getChannelsCachePath,
    getEpgSourcesCachePath
};