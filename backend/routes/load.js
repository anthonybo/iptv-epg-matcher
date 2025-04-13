/**
 * Load Route - handles loading channels and EPG data
 */
const { EXTERNAL_EPG_URLS, CACHE_DIR, CACHE_TTL } = require('../config/constants');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { eventBus } = require('../utils/eventBus');
const logger = require('../config/logger');
const { getCacheKey, createSession, getSession, updateSession } = require('../utils/storageUtils');
const { fetchURL } = require('../utils/fetchUtils');
const { parseM3U, loadXtreamM3U } = require('../services/m3uService');
const { loadXtreamEPG, loadAllExternalEPGs } = require('../services/epgService');
const {
    isCacheValid,
    readCache,
    writeCache,
    readEpgSourcesCache,
    getChannelsCachePath,
    getEpgSourcesCachePath
} = require('../services/cacheService');
const { finalizeProcessing } = require('../services/dataProcessingService');
const { broadcastSSEUpdate } = require('../utils/sseUtils'); // Import the broadcastSSEUpdate function
const { processWithDetailedUpdates } = require('../services/detailedProgressService');

// Set up upload middleware
const upload = multer({ dest: 'uploads/' });

/**
 * Debug helper to log status in a highly visible way
 */
function debugLog(message, data = null) {
    const stars = '*'.repeat(20);
    console.log(`\n${stars}\n${message}\n${stars}`);
    logger.info(`DEBUG: ${message}`, data || {});
}

// Format file size for display
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/**
 * Fetch with progress updates
 * @param {string} url - URL to fetch
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Buffer|string>} Response content
 */
async function fetchWithProgress(url, progressCallback) {
    const https = require('https');
    const http = require('http');

    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const client = isHttps ? https : http;

        logger.debug(`Starting fetch for URL: ${url}`);

        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*'
            },
            timeout: 30000 // 30 seconds timeout
        }, (res) => {
            // Check for HTTP errors
            if (res.statusCode < 200 || res.statusCode >= 300) {
                logger.error(`HTTP error: ${res.statusCode} ${res.statusMessage}`);
                return reject(new Error(`HTTP error: ${res.statusCode} ${res.statusMessage}`));
            }

            const chunks = [];
            let receivedBytes = 0;
            const totalBytes = parseInt(res.headers['content-length'] || '0', 10);

            // Log response details
            logger.debug(`Response received: ${res.statusCode} ${res.statusMessage}, Content-Length: ${totalBytes}`);

            res.on('data', (chunk) => {
                chunks.push(chunk);
                receivedBytes += chunk.length;
                progressCallback(receivedBytes, totalBytes);
            });

            res.on('end', () => {
                logger.debug(`Download complete: ${receivedBytes} bytes received`);
                const buffer = Buffer.concat(chunks);
                resolve(buffer);
            });

            res.on('error', (err) => {
                logger.error(`Response error: ${err.message}`);
                reject(err);
            });
        });

        req.on('error', (err) => {
            logger.error(`Request error for ${url}: ${err.message}`);
            reject(err);
        });

        req.on('timeout', () => {
            logger.error(`Request timeout for ${url}`);
            req.destroy();
            reject(new Error(`Request timeout after 30 seconds: ${url}`));
        });
    });
}

// Parse M3U with progress updates
async function parseM3UWithProgress(m3uContent, progressCallback) {
    return new Promise((resolve) => {
        const lines = m3uContent.split('\n').map(line => line.trim());
        const channels = [];
        let channelCount = 0;
        let currentChannel = null;
        let processedLines = 0;
        const totalLines = lines.length;

        // Process in batches to allow UI updates
        function processNextBatch(startIndex, batchSize = 1000) {
            const endIndex = Math.min(startIndex + batchSize, totalLines);

            for (let i = startIndex; i < endIndex; i++) {
                const line = lines[i];
                processedLines++;

                // Progress callback
                if (processedLines % 5000 === 0 || processedLines === totalLines) {
                    progressCallback(processedLines, totalLines, processedLines / totalLines);
                }

                // Skip empty lines or the M3U header
                if (!line || line.startsWith('#EXTM3U')) continue;

                // Parse #EXTINF lines
                if (line.startsWith('#EXTINF')) {
                    channelCount++;
                    const extInfMatch = line.match(/^#EXTINF:-?\d+\s*(.*?),(.+)/);
                    if (!extInfMatch) {
                        logger.warn(`Invalid #EXTINF line at ${i}: ${line}`);
                        continue;
                    }

                    const attributesStr = extInfMatch[1];
                    const name = extInfMatch[2].trim();

                    // Parse attributes (e.g., tvg-id="...", group-title="...")
                    const attributes = {};
                    const attrMatches = attributesStr.matchAll(/(\w+-\w+|\w+)="([^"]*)"/g);
                    for (const match of attrMatches) {
                        attributes[match[1]] = match[2];
                    }

                    const tvgId = attributes['tvg-id'] || `channel_${crypto.createHash('md5').update(name + channelCount).digest('hex')}`;
                    const groupTitle = attributes['group-title'] || 'Uncategorized';
                    const tvgName = attributes['tvg-name'] || name;

                    currentChannel = { tvgId, name: tvgName, groupTitle };
                }
                // Parse the URL (the line after #EXTINF)
                else if (currentChannel && line && !line.startsWith('#')) {
                    currentChannel.url = line;
                    channels.push(currentChannel);
                    currentChannel = null;
                }
            }

            // Continue with next batch or resolve
            if (endIndex < totalLines) {
                setTimeout(() => processNextBatch(endIndex), 0);
            } else {
                const uniqueChannels = Array.from(new Map(channels.map(ch => [ch.tvgId, ch])).values());
                logger.debug(`Filtered ${channelCount} M3U entries to ${uniqueChannels.length} unique channels`);
                resolve(uniqueChannels);
            }
        }

        // Start processing
        processNextBatch(0);
    });
}

// Load EPG sources progressively
async function loadExternalEPGsProgressively(urls, progressCallback) {
    const epgSources = {};

    // Process one source at a time
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const sourceProgress = i / urls.length;

        // Skip if we've loaded enough sources
        if (Object.keys(epgSources).length >= 3) {
            progressCallback(url, 'source_skipped', sourceProgress, {
                message: `Skipping source ${url} - already loaded enough sources`,
                skipped: true
            });
            continue;
        }

        progressCallback(url, 'source_start', sourceProgress, {
            message: `Starting to load EPG source: ${url}`,
            index: i + 1,
            total: urls.length
        });

        try {
            // Fetch data
            progressCallback(url, 'source_fetching', sourceProgress, {
                message: `Fetching data from ${url}`,
                stage: 'download',
                stageProgress: 0
            });

            // Fetch with progress
            const epgBuffer = await fetchWithProgress(url, (bytesLoaded, totalBytes) => {
                const fetchProgress = bytesLoaded / Math.max(totalBytes, 1);
                progressCallback(url, 'source_downloading', sourceProgress + (fetchProgress * 0.4 / urls.length), {
                    message: `Downloading EPG: ${formatSize(bytesLoaded)} of ${formatSize(totalBytes)}`,
                    bytesLoaded,
                    totalBytes,
                    stage: 'download',
                    stageProgress: fetchProgress
                });
            });

            // Check if empty
            if (!epgBuffer || epgBuffer.length === 0) {
                progressCallback(url, 'source_failed', sourceProgress + (0.4 / urls.length), {
                    message: `Empty response from ${url}`,
                    stage: 'error',
                    error: 'Empty response'
                });
                continue;
            }

            // Handle gzipped content
            let epgContent;
            try {
                progressCallback(url, 'source_processing', sourceProgress + (0.4 / urls.length), {
                    message: url.endsWith('.gz') ? `Unzipping data from ${url}` : `Processing data from ${url}`,
                    stage: 'processing',
                    stageProgress: 0
                });

                if (url.endsWith('.gz')) {
                    epgContent = zlib.gunzipSync(epgBuffer).toString('utf8');
                    progressCallback(url, 'source_unzipped', sourceProgress + (0.5 / urls.length), {
                        message: `Unzipped to ${formatSize(epgContent.length)} bytes`,
                        stage: 'processing',
                        stageProgress: 0.5
                    });
                } else {
                    epgContent = epgBuffer.toString('utf8');
                    progressCallback(url, 'source_decoded', sourceProgress + (0.5 / urls.length), {
                        message: `Decoded ${formatSize(epgContent.length)} bytes`,
                        stage: 'processing',
                        stageProgress: 0.5
                    });
                }
            } catch (e) {
                progressCallback(url, 'source_processing_failed', sourceProgress + (0.5 / urls.length), {
                    message: `Failed to process data: ${e.message}`,
                    stage: 'error',
                    error: e.message
                });
                continue;
            }

            // Check for valid XML
            if (!epgContent.includes('<?xml') || !epgContent.includes('<tv')) {
                progressCallback(url, 'source_invalid_xml', sourceProgress + (0.5 / urls.length), {
                    message: `Invalid XML structure in EPG from ${url}`,
                    stage: 'error',
                    error: 'Invalid XML'
                });
                continue;
            }

            // Parse EPG with progress updates
            progressCallback(url, 'source_parsing', sourceProgress + (0.5 / urls.length), {
                message: `Parsing EPG data from ${url}`,
                stage: 'parsing',
                stageProgress: 0
            });

            // Parse progressively to avoid blocking UI
            const parsedEPG = await parseEPGProgressively(epgContent, (progress, details) => {
                const parseProgress = sourceProgress + (0.5 / urls.length) + (progress * 0.4 / urls.length);
                progressCallback(url, 'source_parsing_progress', parseProgress, {
                    message: details.message,
                    stage: 'parsing',
                    stageProgress: progress,
                    details
                });
            });

            // Check if valid
            if (!parsedEPG || parsedEPG.channels.length === 0) {
                progressCallback(url, 'source_parse_failed', sourceProgress + (0.9 / urls.length), {
                    message: `No channels found in EPG from ${url}`,
                    stage: 'error',
                    error: 'No channels found'
                });
                continue;
            }

            // Success - add to sources
            epgSources[url] = parsedEPG;
            progressCallback(url, 'source_complete', sourceProgress + (1.0 / urls.length), {
                message: `Successfully loaded EPG from ${url}`,
                stage: 'complete',
                success: true,
                data: parsedEPG,
                channelCount: parsedEPG.channels.length,
                programCount: parsedEPG.programs.length
            });

            // Force garbage collection after large source
            if (global.gc) {
                global.gc();
            }
        } catch (e) {
            progressCallback(url, 'source_error', sourceProgress + (0.9 / urls.length), {
                message: `Error loading EPG from ${url}: ${e.message}`,
                stage: 'error',
                error: e.message
            });
        }
    }

    return epgSources;
}

// Parse EPG progressively
async function parseEPGProgressively(epgContent, progressCallback) {
    return new Promise((resolve) => {
        // Use a worker to parse in background
        const worker = new Worker('./workers/epgParser.js');

        worker.on('message', (result) => {
            if (result.type === 'progress') {
                progressCallback(result.progress, result.details);
            } else if (result.type === 'complete') {
                resolve(result.data);
                worker.terminate();
            } else if (result.type === 'error') {
                logger.error(`EPG parsing error: ${result.error}`);
                resolve(null);
                worker.terminate();
            }
        });

        worker.on('error', (error) => {
            logger.error(`EPG parser worker error: ${error.message}`);
            resolve(null);
        });

        // Start parsing
        worker.postMessage({ epgContent });
    });
}

/**
 * POST /api/load
 * Loads channels and EPG data from various sources
 * With completely rewritten cache/reload logic
 */
router.post('/', upload.single('m3uFile'), async (req, res) => {
    // Extract parameters from request
    const { sessionId, m3uUrl, epgUrl, xtreamUsername, xtreamPassword, xtreamServer, forceUpdate = false } = req.body;
    const m3uFile = req.file; // Access uploaded file from multer

    // Log what was received for debugging
    logger.debug(`Received load request:`, {
        hasSessionId: !!sessionId,
        hasM3uFile: !!m3uFile,
        hasM3uUrl: !!m3uUrl,
        hasEpgUrl: !!epgUrl,
        hasXtreamCreds: !!(xtreamUsername && xtreamPassword && xtreamServer)
    });

    if (!sessionId) {
        logger.error('No session ID provided in load request');
        return res.status(400).json({
            success: false,
            error: 'No session ID provided'
        });
    }

    logger.info(`Starting load process for session ${sessionId}`);
    
    // Send an immediate response to the client
    res.status(200).json({
        success: true,
        message: 'Load process started',
        sessionId
    });
    
    // Start a progress update right away
    broadcastSSEUpdate({
        type: 'progress',
        stage: 'starting',
        progress: 5,
        message: 'Starting data loading process...',
        sessionId
    }, sessionId);
    
    // Continue processing in the background
    try {
        // Use the detailed progress service to handle the loading process
        processWithDetailedUpdates(sessionId, {
            m3uFile, // Pass the file object from multer
            m3uUrl,
            epgUrl,
            xtreamUsername,
            xtreamPassword,
            xtreamServer,
            forceUpdate
        });
        
        logger.info(`Background processing started for session ${sessionId}`);
    } catch (error) {
        logger.error(`Error starting background processing for session ${sessionId}:`, { error: error.message });
        
        // Send an error update through SSE
        broadcastSSEUpdate({
            type: 'error',
            message: `Failed to start processing: ${error.message}`,
            sessionId
        }, sessionId);
    }
});

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

// Process data with progress updates
async function processDataWithProgressUpdates(sessionId, options) {
    const {
        m3uUrl, epgUrl, xtreamUsername, xtreamPassword, xtreamServer,
        forceUpdate, uploadedFiles
    } = options;

    // Send initial progress update
    broadcastSSEUpdate({
        type: 'progress',
        stage: 'init',
        message: 'Initializing processing',
        progress: 0,
        detail: 'Setting up session and checking cache validity'
    }, sessionId);

    try {
        // Check if we should use the cache
        const cacheKey = getCacheKey(xtreamUsername, xtreamPassword, xtreamServer);
        const cacheChannelsFile = getChannelsCachePath(cacheKey);
        const cacheEpgSourcesFile = getEpgSourcesCachePath(cacheKey);
        const shouldUseCache = !forceUpdate && isCacheValid(cacheChannelsFile);
        
        // Update frontend about cache check
        broadcastSSEUpdate({
            type: 'progress',
            stage: 'cache_check',
            message: shouldUseCache ? 'Found valid cache, will use cached data' : 'No valid cache found, will load fresh data',
            progress: 5,
            detail: `Cache key: ${cacheKey.substring(0, 8)}...`
        }, sessionId);
        
        let channels = null;
        let epgSources = {};
        let m3uContent = null;

        // Send initial progress update
        broadcastSSEUpdate({
            type: 'progress',
            stage: 'init',
            message: 'Initializing processing',
            progress: 0
        }, sessionId);

        try {
            // Check if we should use the cache
            const cacheKey = getCacheKey(xtreamUsername, xtreamPassword, xtreamServer);
            const cacheChannelsFile = getChannelsCachePath(cacheKey);
            const cacheEpgSourcesFile = getEpgSourcesCachePath(cacheKey);
            const shouldUseCache = !forceUpdate && isCacheValid(cacheChannelsFile);
            let shouldLoadFresh = false;
            
            if (shouldUseCache) {
                logger.info(`Using cached channel data (valid for ${Math.round(CACHE_TTL / (1000 * 60 * 60))} hours)`);
                
                // Try to load from cache first
                try {
                    const cachedChannels = readCache(cacheChannelsFile);
                    if (cachedChannels && Array.isArray(cachedChannels) && cachedChannels.length > 0) {
                        channels = cachedChannels;
                        logger.info(`Successfully loaded ${channels.length} channels from cache`);
                        
                        // Create session with the cached channels
                        let session = getSession(sessionId);
                        if (!session) {
                            createSession(sessionId, {
                                channels,
                                epgSources: {},
                                xtreamUsername,
                                xtreamPassword,
                                xtreamServer
                            });
                            logger.info(`Created new session with ID: ${sessionId} using cached channels`);
                        } else {
                            updateSession(sessionId, {
                                channels,
                                xtreamUsername,
                                xtreamPassword,
                                xtreamServer
                            });
                            logger.info(`Updated existing session with ID: ${sessionId} using cached channels`);
                        }
                        
                        // Generate categories from cached channels
                        const categories = channels.reduce((acc, ch) => {
                            const groupTitle = ch.groupTitle || 'Uncategorized';
                            acc[groupTitle] = (acc[groupTitle] || 0) + 1;
                            return acc;
                        }, {});
                        
                        const categoriesArray = Object.entries(categories)
                            .map(([name, count]) => ({ name, count }))
                            .sort((a, b) => a.name.localeCompare(b.name));
                        
                        // Update session with categories
                        updateSession(sessionId, { categories: categoriesArray });
                        
                        // Send an update to the client that channels are available
                        broadcastSSEUpdate({
                            type: 'channels_available',
                            stage: 'channels_loaded',
                            message: `Successfully loaded ${channels.length} channels from cache`,
                            channelCount: channels.length,
                            progress: 30,
                            sessionId,
                            totalChannels: channels.length,
                            categories: categoriesArray,
                            cached: true
                        });
                        
                        // Now proceed to EPG loading
                    } else {
                        logger.warn('Cache exists but data is invalid, loading fresh data');
                        shouldLoadFresh = true;
                    }
                } catch (cacheError) {
                    logger.error(`Error loading from cache: ${cacheError.message}`);
                    shouldLoadFresh = true;
                }
            } else {
                logger.info('Cache invalid or force update requested, loading fresh channel data');
                shouldLoadFresh = true;
            }
            
            // Load fresh data if cache was invalid or missing
            if (shouldLoadFresh && xtreamUsername && xtreamPassword && xtreamServer) {
                const baseUrl = xtreamServer.endsWith('/') ? xtreamServer : `${xtreamServer}/`;

                logger.info(`Loading Xtream channels from: ${baseUrl}`);
                broadcastSSEUpdate({
                    type: 'progress',
                    stage: 'loading_xtream',
                    message: 'Loading channels from Xtream provider',
                    progress: 10,
                    sessionId
                });

                try {
                    // Get the M3U URL for Xtream
                    const xtreamM3uUrl = `${baseUrl}get.php?username=${xtreamUsername}&password=${xtreamPassword}&type=m3u_plus&output=ts`;
                    logger.info(`Fetching M3U from Xtream URL: ${xtreamM3uUrl}`);

                    // Fetch the M3U content
                    m3uContent = await fetch(xtreamM3uUrl)
                        .then(response => {
                            if (!response.ok) {
                                throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
                            }
                            return response.text();
                        });

                    if (!m3uContent || !m3uContent.includes('#EXTM3U')) {
                        throw new Error('Invalid M3U content received from Xtream provider');
                    }

                    logger.info(`Successfully fetched M3U content: ${m3uContent.length} bytes`);
                    logger.debug(`M3U first 200 chars: ${m3uContent.substring(0, 200)}`);

                    // Parse the M3U content
                    const m3uParser = require('../epgUtils');
                    channels = m3uParser.parseM3U(m3uContent, logger);

                    if (!channels || channels.length === 0) {
                        throw new Error('No channels found in M3U content');
                    }

                    logger.info(`Successfully parsed ${channels.length} channels from Xtream`);

                    // Create session or update existing one - CRITICAL FIX: Use the provided sessionId
                    let session = getSession(sessionId);
                    if (!session) {
                        // Create new session using the EXISTING sessionId, not generating a new one
                        createSession(sessionId, {
                            channels,
                            epgSources,
                            xtreamUsername,
                            xtreamPassword,
                            xtreamServer
                        });
                        logger.info(`Created new session with ID: ${sessionId}`);
                        
                        // Save to cache for future use
                        try {
                            if (channels && channels.length > 0) {
                                logger.info(`Saving ${channels.length} channels to cache for 24h`);
                                // Make directory if it doesn't exist
                                if (!fs.existsSync(path.dirname(cacheChannelsFile))) {
                                    fs.mkdirSync(path.dirname(cacheChannelsFile), { recursive: true });
                                }
                                writeCache(cacheChannelsFile, channels);
                                logger.info(`Successfully saved channels to ${cacheChannelsFile}`);
                            }
                        } catch (cacheErr) {
                            logger.error(`Error saving channels to cache: ${cacheErr.message}`, { error: cacheErr });
                        }
                    } else {
                        // Update existing session
                        updateSession(sessionId, {
                            channels,
                            xtreamUsername,
                            xtreamPassword,
                            xtreamServer
                        });
                        logger.info(`Updated existing session with ID: ${sessionId}`);
                        
                        // Save to cache for future use
                        try {
                            if (channels && channels.length > 0) {
                                logger.info(`Saving ${channels.length} channels to cache for 24h`);
                                // Make directory if it doesn't exist
                                if (!fs.existsSync(path.dirname(cacheChannelsFile))) {
                                    fs.mkdirSync(path.dirname(cacheChannelsFile), { recursive: true });
                                }
                                writeCache(cacheChannelsFile, channels);
                                logger.info(`Successfully saved channels to ${cacheChannelsFile}`);
                            }
                        } catch (cacheErr) {
                            logger.error(`Error saving channels to cache: ${cacheErr.message}`, { error: cacheErr });
                        }
                    }

                    // Generate categories
                    const categories = channels.reduce((acc, ch) => {
                        const groupTitle = ch.groupTitle || 'Uncategorized';
                        acc[groupTitle] = (acc[groupTitle] || 0) + 1;
                        return acc;
                    }, {});

                    const categoriesArray = Object.entries(categories)
                        .map(([name, count]) => ({ name, count }))
                        .sort((a, b) => a.name.localeCompare(b.name));

                    // Update session with categories
                    updateSession(sessionId, { categories: categoriesArray });

                    // Send an update to the client that channels are available
                    broadcastSSEUpdate({
                        type: 'channels_available',
                        stage: 'channels_loaded',
                        message: `Successfully loaded ${channels.length} channels from Xtream`,
                        channelCount: channels.length,
                        progress: 30,
                        sessionId,
                        totalChannels: channels.length,
                        categories: categoriesArray
                    });

                    // Now load EPG data using existing logic
                    // Try loading EPG sources
                    try {
                        logger.info(`Loading EPG sources for session ${sessionId}`);

                        // Initialize empty EPG sources object in session if it doesn't exist
                        let session = getSession(sessionId);
                        if (session && !session.epgSources) {
                            session.epgSources = {};
                            updateSession(sessionId, { epgSources: session.epgSources });
                        }

                        // Load external EPG sources
                        broadcastSSEUpdate({
                            type: 'progress',
                            stage: 'loading_epg',
                            message: 'Loading EPG sources for program data',
                            progress: 40,
                            sessionId
                        });

                        // Check if we can use cached EPG data
                        const shouldUseEpgCache = !forceUpdate && isCacheValid(cacheEpgSourcesFile);
                        
                        if (shouldUseEpgCache) {
                            logger.info(`Using cached EPG data (valid for ${Math.round(CACHE_TTL / (1000 * 60 * 60))} hours)`);
                            
                            try {
                                const cachedEpgSources = readEpgSourcesCache(cacheEpgSourcesFile);
                                if (cachedEpgSources && Object.keys(cachedEpgSources).length > 0) {
                                    logger.info(`Successfully loaded ${Object.keys(cachedEpgSources).length} EPG sources from cache`);
                                    
                                    // Update session with cached EPG data
                                    session = getSession(sessionId);
                                    if (session) {
                                        session.epgSources = cachedEpgSources;
                                        updateSession(sessionId, { epgSources: session.epgSources });
                                        
                                        // Notify client about each source
                                        Object.keys(cachedEpgSources).forEach(sourceKey => {
                                            broadcastSSEUpdate({
                                                type: 'epg_source_available',
                                                source: sourceKey,
                                                sourceDetails: {
                                                    channelCount: cachedEpgSources[sourceKey].channels?.length || 0,
                                                    programCount: cachedEpgSources[sourceKey].programs?.length || 0
                                                },
                                                progress: 50,
                                                sessionId,
                                                cached: true
                                            });
                                        });
                                        
                                        broadcastSSEUpdate({
                                            type: 'progress',
                                            stage: 'epg_cache_loaded',
                                            message: `Loaded ${Object.keys(cachedEpgSources).length} EPG sources from cache`,
                                            progress: 70,
                                            sessionId,
                                            sourcesCount: Object.keys(cachedEpgSources).length
                                        });
                                        
                                        // No need to load fresh EPG data - finish the process
                                        // Send complete message
                                        broadcastSSEUpdate({
                                            type: 'complete',
                                            message: `Processing complete. Using cached data for ${channels.length} channels and ${Object.keys(cachedEpgSources).length} EPG sources.`,
                                            progress: 100,
                                            sessionId,
                                            channelCount: channels.length,
                                            totalChannels: channels.length,
                                            stage: 'complete',
                                            fromCache: true
                                        });
                                        
                                        return;
                                    }
                                } else {
                                    logger.warn('EPG cache exists but data is invalid or empty, loading fresh data');
                                }
                            } catch (epgCacheError) {
                                logger.error(`Error loading EPG cache: ${epgCacheError.message}`);
                            }
                        }
                        
                        // If we get here, load fresh EPG data
                        logger.info('Loading fresh EPG data from external sources');
                        
                        // Load EPG data from the external sources defined in constants.js
                        const { EXTERNAL_EPG_URLS } = require('../config/constants');
                        
                        // First add test EPG source for immediate feedback
                        const testEpgSource = require('../services/epgService').createTestEpgSource();
                        
                        // Update the session with this test EPG source
                        session = getSession(sessionId);
                        if (session) {
                            session.epgSources = session.epgSources || {};
                            session.epgSources['TEST_SOURCE'] = testEpgSource;
                            
                            // Load each EPG source individually for better control
                            // This prevents one failing source from affecting others
                            const loadEpgSourcesSequentially = async () => {
                                const epgService = require('../services/epgService');
                                
                                // Process sources one by one to avoid memory issues
                                for (let i = 0; i < EXTERNAL_EPG_URLS.length; i++) {
                                    const url = EXTERNAL_EPG_URLS[i];
                                    
                                    try {
                                        // Skip after loading MAX_EPG_SOURCES (from constants.js)
                                        const MAX_SOURCES = 3; // Hard limit for safety
                                        if (Object.keys(session.epgSources).length >= MAX_SOURCES) {
                                            logger.info(`Reached maximum number of EPG sources (${MAX_SOURCES}), skipping remaining sources`);
                                            break;
                                        }
                                        
                                        // Update progress
                                        broadcastSSEUpdate({
                                            type: 'progress',
                                            stage: 'loading_epg_source',
                                            message: `Loading EPG source ${i+1}/${EXTERNAL_EPG_URLS.length}: ${url}`,
                                            progress: 40 + (i * 40 / EXTERNAL_EPG_URLS.length),
                                            source: url,
                                            sourceIndex: i,
                                            sessionId
                                        });
                                        
                                        // Load single source
                                        const source = await epgService.loadExternalEPG(url);
                                        
                                        if (source) {
                                            // Generate a friendly source name
                                            const urlObj = new URL(url);
                                            const sourceName = urlObj.hostname.replace(/\..+$/, '');
                                            const sourceKey = sourceName || `source_${i+1}`;
                                            
                                            // Add to session
                                            const updatedSession = getSession(sessionId);
                                            if (updatedSession) {
                                                updatedSession.epgSources[sourceKey] = source;
                                                updateSession(sessionId, { epgSources: updatedSession.epgSources });
                                                
                                                // Notify client
                                                broadcastSSEUpdate({
                                                    type: 'epg_source_available',
                                                    source: sourceKey,
                                                    sourceDetails: {
                                                        channelCount: source.channels?.length || 0,
                                                        programCount: source.programs?.length || 0,
                                                        url: url
                                                    },
                                                    progress: 60,
                                                    sessionId
                                                });
                                                
                                                logger.info(`Added EPG source ${sourceKey} to session ${sessionId}: ${source.channels?.length || 0} channels, ${source.programs?.length || 0} programs`);
                                                
                                                // Save to cache for future use
                                                try {
                                                    // Ensure cache directory exists
                                                    if (!fs.existsSync(path.dirname(cacheEpgSourcesFile))) {
                                                        fs.mkdirSync(path.dirname(cacheEpgSourcesFile), { recursive: true });
                                                    }
                                                    
                                                    // Create or update EPG sources cache file
                                                    let epgSourcesCache = {};
                                                    if (fs.existsSync(cacheEpgSourcesFile)) {
                                                        try {
                                                            epgSourcesCache = JSON.parse(fs.readFileSync(cacheEpgSourcesFile, 'utf8'));
                                                        } catch (parseErr) {
                                                            logger.warn(`Error parsing EPG cache, creating new one: ${parseErr.message}`);
                                                        }
                                                    }
                                                    
                                                    // Add this source to the cache
                                                    epgSourcesCache[sourceKey] = source;
                                                    
                                                    // Write back to file
                                                    fs.writeFileSync(cacheEpgSourcesFile, JSON.stringify(epgSourcesCache));
                                                    logger.info(`Saved EPG source ${sourceKey} to cache file`);
                                                } catch (cacheErr) {
                                                    logger.error(`Error saving EPG source to cache: ${cacheErr.message}`);
                                                }
                                            }
                                            
                                            // Force garbage collection after each source
                                            if (global.gc) {
                                                global.gc();
                                                logger.info(`Performed garbage collection after loading source ${sourceKey}`);
                                            }
                                        }
                                    } catch (err) {
                                        logger.error(`Error loading EPG source ${url}: ${err.message}`);
                                        // Continue with next source even if this one fails
                                    }
                                }
                                
                                logger.info(`Completed loading ${Object.keys(getSession(sessionId).epgSources).length} EPG sources for session ${sessionId}`);
                            };
                            
                            // Start the loading process in the background
                            loadEpgSourcesSequentially().catch(err => {
                                logger.error(`Error in EPG sources loading sequence: ${err.message}`);
                            });
                                
                            updateSession(sessionId, { epgSources: session.epgSources });
                            logger.info(`Added test EPG source to session ${sessionId}`);

                            // Notify the client
                            broadcastSSEUpdate({
                                type: 'epg_source_available',
                                source: 'TEST_SOURCE',
                                sourceDetails: {
                                    channelCount: testEpgSource.channels.length,
                                    programCount: testEpgSource.programs.length
                                },
                                progress: 50,
                                sessionId
                            });
                        }
                    } catch (epgError) {
                        logger.error(`Error loading EPG sources: ${epgError.message}`, {
                            error: epgError.message,
                            stack: epgError.stack
                        });

                        // Continue anyway as channels are loaded
                        broadcastSSEUpdate({
                            type: 'warning',
                            message: `Warning: Channels loaded but EPG data could not be loaded: ${epgError.message}`,
                            progress: 60,
                            sessionId
                        });
                    }

                } catch (error) {
                    logger.error(`Error loading channels from Xtream: ${error.message}`, {
                        error: error.message,
                        stack: error.stack,
                        xtreamServer: baseUrl
                    });

                    broadcastSSEUpdate({
                        type: 'error',
                        message: `Failed to load channels from Xtream: ${error.message}`,
                        error: error.message,
                        sessionId
                    });

                    // Even if channel loading fails, continue with EPG processing
                }
            }

            // Now continue with the regular flow - determine if we need to load EPG from cache
            // Note: We're using the cache paths from earlier, no need to redefine them
            
            // Only try cache for EPG data if we haven't already checked it
            const shouldTryCache = !forceUpdate && isCacheValid(cacheEpgSourcesFile);

            broadcastSSEUpdate({
                type: 'progress',
                stage: 'cache_check',
                message: shouldTryCache ? 'Valid EPG cache found, attempting to load' : 'Loading fresh EPG data',
                usingCache: shouldTryCache,
                progress: 70,
                sessionId
            });

            // Load any cached EPG data if available
            if (shouldTryCache) {
                try {
                    const cachedEpgSources = readEpgSourcesCache(cacheEpgSourcesFile);
                    if (cachedEpgSources) {
                        let session = getSession(sessionId);
                        if (session) {
                            session.epgSources = session.epgSources || {};

                            // Merge cached sources with existing ones
                            Object.keys(cachedEpgSources).forEach(sourceKey => {
                                session.epgSources[sourceKey] = cachedEpgSources[sourceKey];

                                // Notify about each source
                                broadcastSSEUpdate({
                                    type: 'epg_source_available',
                                    source: sourceKey,
                                    sourceDetails: {
                                        channelCount: cachedEpgSources[sourceKey].channels?.length || 0,
                                        programCount: cachedEpgSources[sourceKey].programs?.length || 0
                                    },
                                    progress: 75,
                                    sessionId
                                });
                            });

                            updateSession(sessionId, { epgSources: session.epgSources });
                            logger.info(`Loaded ${Object.keys(cachedEpgSources).length} EPG sources from cache for session ${sessionId}`);
                        }
                    }
                } catch (cacheError) {
                    logger.error(`Error loading EPG cache: ${cacheError.message}`, {
                        error: cacheError.message,
                        stack: cacheError.stack
                    });
                }
            }

            // When processing is complete, send final update
            if (channels && channels.length > 0) {
                broadcastSSEUpdate({
                    type: 'complete',
                    message: `Processing complete. ${channels.length} channels loaded.`,
                    progress: 100,
                    sessionId,
                    channelCount: channels.length,
                    totalChannels: channels.length,
                    stage: 'complete'
                });
            }

            // Call finalizeProcessing to send completion events to frontend
            finalizeProcessing(sessionId);

        } catch (error) {
            logger.error('Processing failed', { error: error.message, stack: error.stack });

            broadcastSSEUpdate({
                type: 'error',
                message: `Processing failed: ${error.message}`,
                error: error.message
            }, sessionId);
        }
    } catch (error) {
        logger.error('Processing failed', { error: error.message, stack: error.stack });

        broadcastSSEUpdate({
            type: 'error',
            message: `Processing failed: ${error.message}`,
            error: error.message,
            stage: 'error',
            detail: 'See server logs for more information'
        }, sessionId);
    }
}

/**
 * Debug tool - route for sending test progress events
 */
router.get('/debug-progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  logger.info(`Sending debug progress sequence to session ${sessionId}`);
  
  // Send a sequence of progress events with a small delay
  let progress = 0;
  const stages = [
    'init', 'loading_channels', 'parsing_channels', 
    'channels_loaded', 'loading_epg', 'epg_loaded', 'complete'
  ];
  
  // Send initial response
  res.json({ 
    message: 'Debug progress sequence started',
    sessionId,
    willSend: stages.length + ' events'
  });
  
  // Send progress events with delays
  let i = 0;
  const interval = setInterval(() => {
    if (i >= stages.length) {
      clearInterval(interval);
      return;
    }
    
    progress = Math.min(100, Math.round((i / (stages.length - 1)) * 100));
    
    broadcastSSEUpdate({
      type: 'progress',
      stage: stages[i],
      message: `Debug progress: ${stages[i]} (${progress}%)`,
      progress,
      detail: `This is a test progress event for stage ${stages[i]}`
    }, sessionId);
    
    logger.info(`Sent debug progress for stage ${stages[i]}: ${progress}%`);
    i++;
    
    // Send completion event at the end
    if (i === stages.length) {
      setTimeout(() => {
        broadcastSSEUpdate({
          type: 'complete',
          message: 'Debug sequence complete',
          progress: 100
        }, sessionId);
        logger.info(`Sent debug completion event for session ${sessionId}`);
      }, 1000);
    }
  }, 1500); // 1.5 second between events
});

/**
 * Get channels for a specific session
 */
router.get('/channels/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error('Invalid session ID provided for channels request', { sessionId });
    return res.status(400).json({ error: 'Invalid session ID', details: 'A valid session ID is required' });
  }

  const session = getSession(sessionId);
  if (!session) {
    logger.error('Session not found for channels request', { sessionId });
    return res.status(404).json({ error: 'Session not found', details: 'The requested session does not exist' });
  }

  // ...existing code...
});

/**
 * Handles the detailed progress updates
 * @param {string} sessionId - The session ID
 */
function startDetailedProgress(sessionId) {
    // Validate sessionId at entry point
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.error('Invalid session ID for detailed progress', { 
            sessionId: String(sessionId),
            callstack: new Error().stack
        });
        return;
    }

    logger.info(`Starting detailed processing for session ${sessionId}`);

    // Mock progress updates with different stages
    const session = getSession(sessionId);
    
    if (!session) {
        logger.warn(`Session not found: ${sessionId}`);
        logger.warn('No session found for ID ' + sessionId + ', creating minimal session');
        createSession(sessionId, {
            m3uUrl: '',
            epgUrl: '',
            xtreamUsername: '',
            xtreamPassword: '',
            xtreamServer: '',
            forceUpdate: false
        });
    }
    
    // Store timeout IDs so they can be cleared if needed
    const timeoutIds = [];
    
    // Send initial progress (0%)
    sendProgressUpdate(sessionId, 'starting', 0, 'Initializing data processing');
    
    // Cache check stage (5%)
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'checking_cache', 5, 'Checking cache for existing data');
    }, 0));
    
    // Channel loading stage (15-25%)
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'loading_channels', 15, 'Loading channel data');
    }, 1000));
    
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'loading_channels', 25, 'Processing channel data');
    }, 2000));
    
    // EPG loading stage (40-85%)
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'loading_epg', 40, 'Loading EPG data');
    }, 3000));
    
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'processing_epg', 55, 'Processing EPG data');
    }, 4000));
    
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'processing_epg', 70, 'Matching channels with EPG');
    }, 5000));
    
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'processing_epg', 85, 'Finalizing EPG processing');
    }, 6000));
    
    // Final stages (95-100%)
    timeoutIds.push(setTimeout(() => {
        sendProgressUpdate(sessionId, 'finalizing', 95, 'Optimizing data structures');
    }, 7000));
    
    // Critical: prevent closures from capturing the wrong sessionId
    const finalSessionId = sessionId;
    
    timeoutIds.push(setTimeout(() => {
        // Clone the session ID to avoid any reference issues
        const actualSessionId = String(finalSessionId);
        
        sendProgressUpdate(actualSessionId, 'complete', 100, 'Processing complete!');
        
        // Send completion message - immediately capture session ID to avoid issues
        (function completeProcessing(sid) {
            if (!sid || sid === 'null' || sid === 'undefined') {
                logger.error('Invalid session ID in completion handler', {
                    providedSessionId: String(sid),
                    callstack: new Error().stack
                });
                return;
            }
            
            // Send completion after a short delay to ensure progress is processed first
            process.nextTick(() => {
                try {
                    broadcastSSEUpdate({
                        type: 'complete',
                        message: 'Data processing completed successfully',
                        timestamp: new Date().toISOString()
                    }, sid);
                    
                    logger.info(`Completed detailed processing for session ${sid}`);
                } catch (error) {
                    logger.error(`Error in final broadcast: ${error.message}`, { 
                        sessionId: sid,
                        error: error.message,
                        stack: error.stack
                    });
                }
            });
        })(actualSessionId);
        
        // Add timeout reference to session for cleanup
        updateSession(actualSessionId, { timeoutIds });
        
    }, 8000));
}

/**
 * Helper function to send progress updates
 * @param {string} sessionId - The session ID
 * @param {string} stage - Current processing stage
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Progress message
 */
function sendProgressUpdate(sessionId, stage, progress, message) {
    // Safety check with debug info
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.error('Attempted to send progress update with invalid session ID', { 
            sessionId: String(sessionId),
            stage,
            progress,
            callstack: new Error().stack
        });
        return;
    }

    logger.debug(`Sending progress update for session ${sessionId}: ${stage} - ${progress}%`);
    
    try {
        // Clone the sessionId to ensure it's a separate value
        const sid = String(sessionId);
        
        broadcastSSEUpdate({
            type: 'progress',
            timestamp: new Date().toISOString(),
            stage,
            progress,
            message
        }, sid);
    } catch (error) {
        logger.error(`Error sending progress update: ${error.message}`, {
            sessionId, 
            stage,
            progress,
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = router;