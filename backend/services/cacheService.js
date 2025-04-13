/**
 * Cache Service - handles file caching operations with support for large data
 */
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { CACHE_DIR, CACHE_TTL } = require('../config/constants');
const crypto = require('crypto');

/**
 * Check if a cache file exists and is not expired
 * @param {string} cacheFilePath - Path to the cache file
 * @param {number} ttlHours - Time to live in hours (default 24)
 * @returns {boolean} - True if cache is valid, false otherwise
 */
function isCacheValid(cacheFilePath, ttlHours = 24) {
  try {
    if (!fs.existsSync(cacheFilePath)) {
      logger.debug(`Cache miss: File does not exist: ${cacheFilePath}`);
      return false;
    }

    const stats = fs.statSync(cacheFilePath);
    const fileAge = Date.now() - stats.mtimeMs;
    const ttlMs = ttlHours * 60 * 60 * 1000;
    const isValid = fileAge < ttlMs;
    
    if (isValid) {
      const remainingValidTime = ttlMs - fileAge;
      const remainingHours = Math.round(remainingValidTime / (60 * 60 * 1000) * 10) / 10;
      logger.info(`Cache hit: ${cacheFilePath} (valid for ${remainingHours} more hours, TTL: ${ttlHours}h)`);
      
      // Try to read file size for better logging
      try {
        const fileSizeBytes = stats.size;
        const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024) * 100) / 100;
        logger.debug(`Cache file size: ${fileSizeMB} MB`);
      } catch (err) {
        // Ignore file size errors
      }
    } else {
      logger.debug(`Cache expired: ${cacheFilePath} (TTL: ${ttlHours}h, age: ${Math.round(fileAge / (60 * 60 * 1000) * 10) / 10}h)`);
    }
    
    return isValid;
  } catch (error) {
    logger.error(`Error checking cache validity: ${error.message}`);
    return false;
  }
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

                logger.debug(`Wrote programs chunk ${i + 1}/${chunks} with ${programsChunk.length} programs to ${programsChunkPath}`);
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
      for (const chunk of metadata.chunks || []) {
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
                logger.debug(`Loaded ${chunkData.data.length} programs from chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks || 1}`);
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
                        channelCount: source?.channels ? source.channels.length : 0,
                        programCount: source?.programs ? source.programs.length : 0,
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
 * Loads EPG sources from cache with progress updates
 * 
 * @param {string} sourcesFile - Path to the EPG sources cache file
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object|null>} EPG sources or null if loading fails
 */
async function loadEpgSourcesWithProgress(sourcesFile, progressCallback) {
    try {
        logger.info(`Loading EPG sources from ${sourcesFile} with progress updates`);

        // First read the index file
        const indexData = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));

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
        const chunkDir = `${sourcesFile}_chunks`;

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

        // Process each source with progress updates
        const sourceKeys = Object.keys(indexData.sources);
        for (let i = 0; i < sourceKeys.length; i++) {
            const sourceKey = sourceKeys[i];
            const sourceInfo = indexData.sources[sourceKey];

            // Calculate progress
            const progress = {
                current: i + 1,
                total: sourceKeys.length,
                percent: ((i + 1) / sourceKeys.length) * 100
            };

            // Call progress callback to update the client
            if (progressCallback) {
                progressCallback(sourceKey, progress);
            }

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
            try {
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

        // Only consider it a success if we loaded some sources
        if (Object.keys(sources).length === 0) {
            logger.warn(`No sources loaded from cache, forcing reload`);
            return null;
        }

        return sources;
    } catch (e) {
        logger.error(`Failed to read EPG sources cache with progress: ${e.message}`, { stack: e.stack });
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
 * Gets the path for EPG source cache
 * @param {string} sourceUrl - The source URL
 * @returns {string} Path to the cache file
 */
function getEpgSourceCachePath(sourceUrl) {
    // Create a hash of the URL to use as filename
    const hash = crypto.createHash('md5').update(sourceUrl).digest('hex');
    return path.join(CACHE_DIR, `epg_source_${hash}.json`);
}

/**
 * Writes EPG source data to cache
 * @param {string} url - The source URL
 * @param {Object} data - The data to cache
 * @param {Object} options - Cache options
 * @param {boolean} options.checkSize - Whether to check file size before writing
 * @param {number} options.maxSizeMB - Maximum file size in MB
 * @returns {boolean} True if successful, false otherwise
 */
function writeEpgSourceCache(url, data, options = {}) {
  try {
    if (!url || !data) {
      logger.error('Invalid parameters for writeEpgSourceCache');
      return false;
    }
    
    const { checkSize = true, maxSizeMB = 100 } = options;
    
    // Ensure cache directory exists
    const cacheDir = path.dirname(getEpgSourceCachePath(url));
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      logger.debug(`Created cache directory: ${cacheDir}`);
    }
    
    // Calculate metadata
    const channelCount = data.channels?.length || 0;
    let programCount = 0;
    
    // Count programs across all channels
    if (data.channels && Array.isArray(data.channels)) {
      programCount = data.channels.reduce((total, channel) => {
        return total + (channel.programs?.length || 0);
      }, 0);
    }
    
    // Prepare cache data with metadata
    const cacheObject = {
      url,
      cached: new Date().toISOString(),
      channelCount,
      programCount,
      data
    };
    
    // Check estimated size before writing
    if (checkSize) {
      const jsonString = JSON.stringify(cacheObject);
      const estimatedSizeMB = jsonString.length / (1024 * 1024);
      
      if (estimatedSizeMB > maxSizeMB) {
        logger.warn(`EPG source ${url} exceeds max cache size (${estimatedSizeMB.toFixed(2)}MB > ${maxSizeMB}MB). Using chunked cache instead.`);
        
        // For large EPG sources, use chunked caching
        return writeChunkedCache(getEpgSourceCachePath(url), cacheObject);
      }
    }
    
    // Write to file
    const cachePath = getEpgSourceCachePath(url);
    fs.writeFileSync(cachePath, JSON.stringify(cacheObject));
    
    logger.info(`Cached EPG source ${url} (${channelCount} channels, ${programCount} programs, ${new Date().toISOString()})`);
    return true;
  } catch (error) {
    logger.error(`Failed to write EPG source cache for ${url}: ${error.message}`);
    return false;
  }
}

/**
 * Reads EPG source data from cache with improved format checking
 * @param {string} url - URL of the EPG source
 * @returns {Object|null} - EPG source data or null if not in cache
 */
function readEpgSourceCache(url) {
  try {
    // Get cache file path
    const cachePath = getEpgSourceCachePath(url);
    
    // Check if cache is valid
    if (!isCacheValid(cachePath)) {
      logger.debug(`EPG cache for ${url} is invalid or expired`);
      return null;
    }
    
    // Read cache file
    const data = fs.readFileSync(cachePath, 'utf8');
    const epgData = JSON.parse(data);
    
    // Validate basic structure - accept more flexible formats
    if (!epgData) {
      logger.warn(`EPG cache for ${url} is empty`);
      return null;
    }
    
    // Allow for different valid formats:
    // 1. Direct channels array with url property
    // 2. Object with channels property
    // 3. Object with tv property containing channels (xml2js format)
    
    // Check if it's a valid EPG data object in any format
    if (
      (epgData.channels && Array.isArray(epgData.channels)) || 
      (epgData.tv && epgData.tv.channel && Array.isArray(epgData.tv.channel)) ||
      (Array.isArray(epgData) && epgData.length > 0 && epgData[0].$ && epgData[0].$.id)
    ) {
      // Add source URL if missing
      if (!epgData.url) {
        epgData.url = url;
      }
      
      logger.info(`Successfully loaded cached EPG data for ${url}`);
      return epgData;
    }
    
    logger.warn(`Invalid EPG cache format for ${url}`);
    return null;
  } catch (error) {
    logger.error(`Error reading EPG cache for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Gets the number of hours remaining in the cache TTL
 * @param {string} cachePath - Path to cache file
 * @returns {number} Hours remaining in cache TTL
 */
function getCacheRemainingHours(cachePath) {
  // If file doesn't exist, cache is expired
  if (!fs.existsSync(cachePath)) {
    return 0;
  }

  try {
    // Try to read metadata from cache file
    const stats = fs.statSync(cachePath);
    const lastModified = stats.mtime;
    
    // Handle case where lastModified is missing or invalid
    if (!lastModified || isNaN(lastModified.getTime())) {
      logger.warn(`Invalid lastModified timestamp for ${cachePath}`);
      return 0; // Treat as expired
    }

    const now = new Date();
    const ageHours = (now - lastModified) / (1000 * 60 * 60);
    
    // Get TTL from constants with a fallback of 24 hours
    const { EPG_CACHE_TTL_HOURS = 24 } = require('../config/constants');
    
    // Return remaining hours
    return Math.max(0, EPG_CACHE_TTL_HOURS - ageHours);
  } catch (error) {
    logger.warn(`Error checking cache TTL for ${cachePath}: ${error.message}`);
    return 0; // Treat as expired on error
  }
}

/**
 * Validates if the provided data has a valid EPG cache structure
 * @param {Object} data - The data to validate
 * @returns {boolean} - Whether the data has a valid structure
 */
function isValidCacheStructure(data) {
  if (!data) return false;
  
  // Accept various valid formats
  const hasChannelsArray = Array.isArray(data.channels);
  const hasXml2jsFormat = data.tv && Array.isArray(data.tv.channel);
  const isChannelsArray = Array.isArray(data) && data.length > 0 && data[0].id;
  
  return hasChannelsArray || hasXml2jsFormat || isChannelsArray;
}

/**
 * Reads and validates JSON data from a file
 * @param {string} filePath - Path to the JSON file to read
 * @returns {Object|null} - Parsed JSON data or null if invalid/not found
 */
function readJsonFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      logger.debug(`File not found: ${filePath}`);
      return null;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content || content.trim() === '') {
      logger.debug(`Empty file: ${filePath}`);
      return null;
    }
    
    const data = JSON.parse(content);
    
    // Validate the cache structure
    if (!isValidCacheStructure(data)) {
      logger.warn(`Invalid EPG cache format in: ${filePath}`);
      return null;
    }
    
    return data;
  } catch (error) {
    logger.error(`Error reading JSON from ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Invalidates a cache by removing the cache file
 * @param {string} cacheKey - The cache key to invalidate
 * @returns {boolean} - Whether the cache was successfully invalidated
 */
function invalidateCache(cacheKey) {
  try {
    const cachePath = path.join(getCacheDir(), `${cacheKey}.json`);
    
    // Check if it's a directory-based cache
    const cacheDir = path.join(getCacheDir(), cacheKey);
    
    // Remove file-based cache if it exists
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      logger.info(`Cache invalidated: ${cacheKey}`);
      return true;
    }
    
    // Remove directory-based cache if it exists
    if (fs.existsSync(cacheDir)) {
      // Remove the directory and its contents
      fs.rmSync(cacheDir, { recursive: true, force: true });
      logger.info(`Directory cache invalidated: ${cacheKey}`);
      return true;
    }
    
    logger.debug(`Nothing to invalidate for cache key: ${cacheKey}`);
    return false;
  } catch (error) {
    logger.error(`Error invalidating cache for ${cacheKey}: ${error.message}`);
    return false;
  }
}

module.exports = {
    isCacheValid,
    readCache,
    writeCache,
    writeChunkedCache,
    readChunkedCache,
    readEpgSourcesCache,
    loadEpgSourcesWithProgress,
    getChannelsCachePath,
    getEpgSourcesCachePath,
    sanitizeFilename,
    getEpgSourceCachePath,
    writeEpgSourceCache,
    readEpgSourceCache,
    getCacheRemainingHours,
    readJsonFromFile,
    isValidCacheStructure,
    invalidateCache
  };