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
 * Sanitizes a string to be safe for use in filenames
 * 
 * @param {string} filename - Input string
 * @returns {string} Safe filename
 */
function sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

/**
 * Writes large EPG sources in chunks to avoid string length limitations
 * 
 * @param {Object} source - EPG source data
 * @param {string} sourceKey - Source identifier
 * @param {string} chunkDir - Directory to store chunks
 * @returns {Object} Metadata about the chunked source
 */
function writeChunkedCache(source, sourceKey, chunkDir) {
    try {
        logger.info(`Using chunked storage for large source: ${sourceKey}`);
        const safeName = sanitizeFilename(sourceKey);
        const metadata = {
            isChunked: true,
            sourceKey: sourceKey,
            chunks: [],
            channelCount: source.channels ? source.channels.length : 0,
            programCount: source.programs ? source.programs.length : 0,
            timestamp: Date.now()
        };

        // Create chunk directory if it doesn't exist
        if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
        }
        
        // Write channels chunk
        if (source.channels && Array.isArray(source.channels)) {
            const channelsChunkPath = path.join(chunkDir, `${safeName}_channels.json`);
            fs.writeFileSync(channelsChunkPath, JSON.stringify({
                type: 'channels',
                data: source.channels
            }));
            metadata.chunks.push({
                type: 'channels',
                path: path.relative(CACHE_DIR, channelsChunkPath)
            });
            logger.debug(`Wrote ${source.channels.length} channels to chunk ${channelsChunkPath}`);
        }
        
        // Write channelMap chunk
        if (source.channelMap && Object.keys(source.channelMap).length > 0) {
            const channelMapChunkPath = path.join(chunkDir, `${safeName}_channel_map.json`);
            fs.writeFileSync(channelMapChunkPath, JSON.stringify({
                type: 'channelMap',
                data: source.channelMap
            }));
            metadata.chunks.push({
                type: 'channelMap',
                path: path.relative(CACHE_DIR, channelMapChunkPath)
            });
            logger.debug(`Wrote channel map with ${Object.keys(source.channelMap).length} entries to chunk ${channelMapChunkPath}`);
        }
        
        // Write programMap chunk
        if (source.programMap && Object.keys(source.programMap).length > 0) {
            const programMapChunkPath = path.join(chunkDir, `${safeName}_program_map.json`);
            fs.writeFileSync(programMapChunkPath, JSON.stringify({
                type: 'programMap',
                data: source.programMap
            }));
            metadata.chunks.push({
                type: 'programMap',
                path: path.relative(CACHE_DIR, programMapChunkPath)
            });
            logger.debug(`Wrote program map with ${Object.keys(source.programMap).length} entries to chunk ${programMapChunkPath}`);
        }
        
        // Write programs in multiple chunks if needed
        if (source.programs && Array.isArray(source.programs)) {
            const CHUNK_SIZE = 100000; // Adjust based on program size
            const chunks = Math.ceil(source.programs.length / CHUNK_SIZE);
            
            for (let i = 0; i < chunks; i++) {
                const startIdx = i * CHUNK_SIZE;
                const endIdx = Math.min((i + 1) * CHUNK_SIZE, source.programs.length);
                const programsChunk = source.programs.slice(startIdx, endIdx);
                
                const programsChunkPath = path.join(chunkDir, `${safeName}_programs_${i}.json`);
                fs.writeFileSync(programsChunkPath, JSON.stringify({
                    type: 'programs',
                    chunkIndex: i,
                    totalChunks: chunks,
                    startIndex: startIdx,
                    endIndex: endIdx - 1,
                    count: programsChunk.length,
                    data: programsChunk
                }));
                
                metadata.chunks.push({
                    type: 'programs',
                    chunkIndex: i,
                    totalChunks: chunks,
                    count: programsChunk.length,
                    path: path.relative(CACHE_DIR, programsChunkPath)
                });
                
                logger.debug(`Wrote programs chunk ${i+1}/${chunks} with ${programsChunk.length} programs to ${programsChunkPath}`);
            }
        }
        
        // Write metadata file
        const metadataPath = path.join(chunkDir, `${safeName}_metadata.json`);
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
        
        logger.info(`Successfully stored large source ${sourceKey} in ${metadata.chunks.length} chunks`);
        return metadata;
    } catch (e) {
        logger.error(`Failed to write chunked cache for ${sourceKey}: ${e.message}`, { 
            error: e.message, 
            stack: e.stack 
        });
        return null;
    }
}

/**
 * Reads a chunked EPG source from disk
 * 
 * @param {Object} metadata - Metadata about the chunked source
 * @param {string} chunkDir - Directory containing chunks
 * @returns {Object} Reconstructed EPG source data
 */
function readChunkedCache(metadata, chunkDir) {
    try {
        logger.info(`Reading chunked source: ${metadata.sourceKey}`);
        
        // Initialize the reconstructed source
        const source = {
            channels: [],
            programs: [],
            channelMap: {},
            programMap: {}
        };
        
        // Process each chunk
        for (const chunk of metadata.chunks) {
            const chunkPath = path.join(CACHE_DIR, chunk.path);
            
            if (!fs.existsSync(chunkPath)) {
                logger.warn(`Chunk file not found: ${chunkPath}`);
                continue;
            }
            
            try {
                const chunkData = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
                
                // Process based on chunk type
                switch (chunk.type) {
                    case 'channels':
                        source.channels = chunkData.data || [];
                        logger.debug(`Loaded ${source.channels.length} channels from chunk`);
                        break;
                    
                    case 'channelMap':
                        source.channelMap = chunkData.data || {};
                        logger.debug(`Loaded channel map with ${Object.keys(source.channelMap).length} entries from chunk`);
                        break;
                    
                    case 'programMap':
                        source.programMap = chunkData.data || {};
                        logger.debug(`Loaded program map with ${Object.keys(source.programMap).length} entries from chunk`);
                        break;
                    
                    case 'programs':
                        // Add programs to the array
                        if (chunkData.data && Array.isArray(chunkData.data)) {
                            source.programs.push(...chunkData.data);
                            logger.debug(`Loaded ${chunkData.data.length} programs from chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`);
                        }
                        break;
                    
                    default:
                        logger.warn(`Unknown chunk type: ${chunk.type}`);
                }
            } catch (chunkError) {
                logger.error(`Error loading chunk ${chunk.path}: ${chunkError.message}`);
            }
        }
        
        logger.info(`Successfully reconstructed chunked source ${metadata.sourceKey}: ${source.channels.length} channels, ${source.programs.length} programs`);
        return source;
    } catch (e) {
        logger.error(`Failed to read chunked cache: ${e.message}`, { error: e.message, stack: e.stack });
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
                    
                    // Get statistics before potentially modifying the source
                    const channelCount = source.channels ? source.channels.length : 0;
                    const programCount = source.programs ? source.programs.length : 0;
                    totalChannels += channelCount;
                    totalPrograms += programCount;

                    // Determine if this source is too large for standard caching
                    const isLargeSource = 
                        (channelCount > 10000) || 
                        (programCount > 500000) || 
                        (source.isLargeSource === true);

                    // Add index info
                    sourceIndex[sourceKey] = {
                        index: index,
                        channelCount,
                        programCount,
                        timestamp: Date.now()
                    };
                    
                    if (isLargeSource) {
                        // Use chunked approach for large sources
                        logger.info(`Source ${sourceKey} is very large, using chunked storage`);
                        const metadata = writeChunkedCache(source, sourceKey, chunkDir);
                        
                        if (metadata) {
                            // Update the index with chunked metadata
                            sourceIndex[sourceKey].isChunked = true;
                            sourceIndex[sourceKey].chunksMetadataPath = path.relative(CACHE_DIR, path.join(chunkDir, `${sanitizeFilename(sourceKey)}_metadata.json`));
                            logger.info(`Added chunked source ${sourceKey} to index`);
                        } else {
                            // Mark as uncacheable but available
                            sourceIndex[sourceKey].uncacheable = true;
                            sourceIndex[sourceKey].error = "Failed to cache large source";
                            logger.warn(`Source ${sourceKey} marked as uncacheable but available in memory`);
                        }
                    } else {
                        // Standard approach for normal-sized sources
                        const chunkPath = path.join(chunkDir, `source_${index}_${sanitizeFilename(sourceKey)}.json`);
                        sourceIndex[sourceKey].chunkPath = path.relative(CACHE_DIR, chunkPath);
                        
                        // Write the source data to its own file
                        fs.writeFileSync(chunkPath, JSON.stringify(source));
                        logger.info(`Cached EPG source to ${chunkPath}`, {
                            sourceKey,
                            channelCount,
                            programCount
                        });
                    }
                } catch (err) {
                    logger.warn(`Skipped caching source ${sourceKey}: ${err.message}`);
                    // Mark as uncacheable but available
                    sourceIndex[sourceKey] = {
                        index: index,
                        channelCount: source.channels ? source.channels.length : 0,
                        programCount: source.programs ? source.programs.length : 0,
                        uncacheable: true,
                        error: err.message
                    };
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
 * Supports chunked large sources
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

        // Track source loading status
        const sourceResults = {
            success: 0,
            failed: 0,
            skipped: 0,
            uncacheable: 0
        };

        // Load each source
        for (const sourceKey of Object.keys(indexData.sources)) {
            try {
                const sourceInfo = indexData.sources[sourceKey];

                // Handle uncacheable sources - they will be reloaded but not treated as missing
                if (sourceInfo.uncacheable) {
                    logger.info(`Source ${sourceKey} was marked as uncacheable but available in memory`);
                    sourceResults.uncacheable++;
                    continue;
                }

                // Handle chunked large sources
                if (sourceInfo.isChunked && sourceInfo.chunksMetadataPath) {
                    const metadataPath = path.join(CACHE_DIR, sourceInfo.chunksMetadataPath);
                    
                    if (!fs.existsSync(metadataPath)) {
                        logger.warn(`Chunked metadata file not found: ${metadataPath}`);
                        sourceResults.failed++;
                        continue;
                    }
                    
                    try {
                        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                        const chunkedSource = readChunkedCache(metadata, chunkDir);
                        
                        if (chunkedSource && chunkedSource.channels && chunkedSource.channels.length > 0) {
                            sources[sourceKey] = chunkedSource;
                            sourceResults.success++;
                            logger.info(`Successfully loaded chunked source ${sourceKey}`);
                        } else {
                            logger.warn(`Failed to load chunked source ${sourceKey}`);
                            sourceResults.failed++;
                        }
                        continue;
                    } catch (chunkErr) {
                        logger.error(`Error loading chunked source ${sourceKey}: ${chunkErr.message}`);
                        sourceResults.failed++;
                        continue;
                    }
                }

                // Standard single-file sources
                if (!sourceInfo.chunkPath) {
                    logger.warn(`Missing chunk path for source ${sourceKey}`);
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

        logger.info(`Loaded ${sourceResults.success} sources from cache. Failed: ${sourceResults.failed}, Skipped: ${sourceResults.skipped}, Uncacheable but available: ${sourceResults.uncacheable}`);

        // Check for critical sources
        // Only consider sources that were actually in the index and not marked as uncacheable
        const criticalSources = ['strongepg', 'epgshare01'];
        const indexedSourceKeys = Object.keys(indexData.sources);
        
        // Check which critical sources were in the index and not marked as uncacheable
        const expectedCriticalSources = indexedSourceKeys.filter(key =>
            criticalSources.some(critical => key.includes(critical)) &&
            !indexData.sources[key].uncacheable
        );
        
        // Check if we're missing any critical sources that should be available
        const missingSources = expectedCriticalSources.filter(criticalKey => 
            !Object.keys(sources).some(key => key === criticalKey)
        );

        if (Object.keys(sources).length === 0) {
            logger.warn(`No sources loaded from cache, forcing reload`);
            return null;
        }
        
        if (missingSources.length > 0) {
            logger.warn(`Missing critical sources that were in the index: ${missingSources.join(', ')}, forcing reload`);
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

module.exports = {
    isCacheValid,
    readCache,
    writeCache,
    writeChunkedCache,
    readChunkedCache,
    readEpgSourcesCache,
    getChannelsCachePath,
    getEpgSourcesCachePath,
    sanitizeFilename
};