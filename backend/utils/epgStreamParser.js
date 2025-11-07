/**
 * EPG Stream Parser
 * Utility for parsing large EPG XML files in a streaming manner
 */
const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');
const { Transform } = require('stream');
const logger = require('../config/logger');
const { CACHE_DIR } = require('../config/constants');
const saxjs = require('sax');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const https = require('https');
const constants = require('../config/constants');

/**
 * Create a temporary file for saving downloaded content
 * @returns {Object} Object with file path and write stream
 */
function createTempFile() {
    const tempDir = path.join(CACHE_DIR, 'temp');
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Create a unique filename
    const tempFile = path.join(tempDir, `epg_${Date.now()}_${Math.floor(Math.random() * 10000)}.xml`);
    const writeStream = fs.createWriteStream(tempFile);
    
    return { path: tempFile, writeStream };
}

/**
 * Parse EPG XML in a streaming manner to handle very large files
 * @param {string} filePath - Path to the XML file
 * @param {boolean} isGzipped - Whether the file is gzipped
 * @param {Function} progressCallback - Optional callback for progress updates
 * @returns {Promise<Object>} Parsed EPG data
 */
async function parseEpgStream(filePath, isGzipped = false, progressCallback = null) {
    return new Promise((resolve, reject) => {
        // Track start time for performance monitoring
        const startTime = Date.now();
        
        // Initialize data structures for efficient processing
        const results = {
            channels: [],
            programs: [],
            channelMap: new Map(),
            programMap: new Map()
        };
        
        // Create a read stream from the file
        const fileStream = fs.createReadStream(filePath, {
            highWaterMark: constants.STREAM_PARSER_BUFFER_SIZE || 16 * 1024 // Configurable buffer size
        });

        const cleanupStreams = () => {
            fileStream.off('error', handleStreamError);
            if (gunzipStream) {
                gunzipStream.off('error', handleStreamError);
            }
        };

        let hasErrored = false;
        const handleStreamError = (err) => {
            if (hasErrored) {
                return;
            }
            hasErrored = true;
            cleanupStreams();
            try {
                fileStream.destroy();
            } catch (_) {}
            if (gunzipStream) {
                try {
                    gunzipStream.destroy();
                } catch (_) {}
            }
            logger.error(`Stream error while reading ${filePath}: ${err.message}`);
            reject(err);
        };

        fileStream.on('error', handleStreamError);

        // If gzipped, pipe through zlib decompression
        let readStream = fileStream;
        let gunzipStream = null;
        if (isGzipped) {
            gunzipStream = zlib.createGunzip({
                chunkSize: constants.STREAM_PARSER_BUFFER_SIZE || 16 * 1024
            });
            gunzipStream.on('error', handleStreamError);
            readStream = fileStream.pipe(gunzipStream);
        }
        
        // SAX parser configuration
        const parser = saxjs.createStream(constants.STREAM_PARSER_NORMALIZE !== undefined ? 
            constants.STREAM_PARSER_NORMALIZE : false, {
            trim: true,
            position: false // Don't track position to save memory
        });
        
        // Keep track of current parsing state
        let currentChannel = null;
        let currentProgram = null;
        let currentTag = null;
        let currentCData = '';
        let textBuffer = '';
        
        // Keep track of stats for performance monitoring and progress reporting
        let channelCount = 0;
        let programCount = 0;
        let lastReportedProgress = 0;
        
        // Process batches to avoid memory spikes
        const batchSize = constants.STREAM_PARSER_BATCH_SIZE || 1000;
        let pendingPrograms = [];
        
        // Helper function to fragment and safely process very large text strings
        const processLargeText = (text, maxLength = 512 * 1024) => { // Reduce max length to 512KB
            if (!text) return '';
            if (text.length <= maxLength) return text;
            
            // Log a warning for very large text content
            logger.warn(`Found very large text content (${text.length} bytes), truncating to prevent memory issues`);
            
            // For extremely large strings, just truncate instead of trying to chunk
            if (text.length > 10 * maxLength) {
                logger.warn(`Text content is extremely large (${text.length} bytes), hard truncating to ${maxLength} bytes`);
                return text.slice(0, maxLength) + '...';
            }
            
            try {
                // Fragment large text into smaller chunks
                const chunks = [];
                for (let i = 0; i < text.length; i += maxLength) {
                    chunks.push(text.slice(i, i + maxLength));
                }
                
                // Join the chunks back together, limiting to the first 3 chunks
                if (chunks.length > 3) {
                    logger.warn(`Truncating very large XML text content from ${text.length} to ${3 * maxLength} characters`);
                    return chunks.slice(0, 3).join('') + '...';
                }
                
                return chunks.join('');
            } catch (error) {
                logger.error(`Error processing large text: ${error.message}`);
                return text.slice(0, maxLength) + '...';
            }
        };
        
        // Process an entire batch of pending programs
        const processProgramBatch = () => {
            if (pendingPrograms.length === 0) return;

            // Add programs to channel mapping
            pendingPrograms.forEach(program => {
                const channelId = program.channel || program.$?.channel;
                if (!results.programMap.has(channelId)) {
                    results.programMap.set(channelId, []);
                }

                // Add to the program array for this channel
                results.programMap.get(channelId).push(program);

                // Add to full programs array too
                results.programs.push(program);
            });
            
            programCount += pendingPrograms.length;
            pendingPrograms = [];
            
            // Force garbage collection on a schedule to prevent memory issues
            if (programCount % (constants.FORCE_GC_AFTER_PROGRAMS || 50000) === 0 && global.gc) {
                try {
                    global.gc();
                    logger.debug(`Forced garbage collection after ${programCount} programs`);
                } catch (e) {
                    // Ignore GC errors
                }
            }
            
            // Report progress
            if (progressCallback && 
                (programCount - lastReportedProgress > 5000 || 
                Date.now() - startTime > 10000)) {
                lastReportedProgress = programCount;
                
                progressCallback({
                    stage: 'parsing',
                    percent: Math.min(35 + Math.floor((programCount / 10000) * 5), 95),
                    message: `Parsing EPG data: ${channelCount} channels and ${programCount} programs processed`,
                    details: { channelCount, programCount }
                });
            }
        };
        
        // Parse opening tags
        parser.on('opentag', (node) => {
            currentTag = node.name.toLowerCase();
            currentCData = '';
            textBuffer = '';

            if (currentTag === 'channel') {
                currentChannel = {
                    id: node.attributes?.id || node.attributes?.ID || 'unknown',
                    names: [],
                    icons: []
                };
            } else if (currentTag === 'programme') {
                currentProgram = {
                    channel: node.attributes?.channel || node.attributes?.CHANNEL || '',
                    start: node.attributes?.start || node.attributes?.START || '',
                    stop: node.attributes?.stop || node.attributes?.STOP || '',
                    titles: [],
                    descriptions: [],
                    categories: []
                };
            }
        });
        
        // Handle text content in chunks to avoid memory issues with large strings
        parser.on('text', (text) => {
            // Buffer the text content - may receive multiple chunks for large text
            textBuffer += text;
        });
        
        // Handle CDATA with safety limits for very large content
        parser.on('cdata', (cdata) => {
            currentCData = processLargeText(cdata);
        });
        
        // Parse closing tags
        parser.on('closetag', (tagName) => {
            tagName = tagName.toLowerCase();
            
            // Process any buffered text with limits for large content
            const safeText = processLargeText(textBuffer);
            
            if (tagName === 'channel') {
                const channelId = currentChannel?.id || currentChannel?.$?.id;
                if (currentChannel && channelId) {
                    results.channels.push(currentChannel);
                    results.channelMap.set(channelId, currentChannel);
                    channelCount++;
                }
                currentChannel = null;
            } else if (tagName === 'programme') {
                const programChannel = currentProgram?.channel || currentProgram?.$?.channel;
                if (currentProgram && programChannel) {
                    pendingPrograms.push(currentProgram);

                    // Process in batches to manage memory
                    if (pendingPrograms.length >= batchSize) {
                        processProgramBatch();
                    }
                }
                currentProgram = null;
            } else if (currentChannel && tagName === 'display-name') {
                if (safeText.trim()) {
                    currentChannel.names.push(safeText.trim());
                }
            } else if (currentChannel && tagName === 'icon' && currentTag === 'icon') {
                if (parser.tag && parser.tag.attributes && parser.tag.attributes.src) {
                    currentChannel.icons.push(parser.tag.attributes.src);
                }
            } else if (currentProgram && tagName === 'title') {
                const title = (currentCData || safeText).trim();
                if (title) {
                    currentProgram.titles.push(title);
                }
            } else if (currentProgram && tagName === 'desc') {
                const desc = (currentCData || safeText).trim();
                if (desc) {
                    currentProgram.descriptions.push(desc);
                }
            } else if (currentProgram && tagName === 'category') {
                const category = (currentCData || safeText).trim();
                if (category) {
                    currentProgram.categories.push(category);
                }
            }
            
            // Reset buffer after processing
            textBuffer = '';
            currentCData = '';
        });
        
        // Handle end of document
        parser.on('end', () => {
            cleanupStreams();
            // Process any remaining programs
            processProgramBatch();
            
            // Post-process channels to simplify structure
            results.channels = results.channels.map(channel => {
                const channelId = channel.id || channel.$?.id;
                return {
                    id: channelId,
                    name: channel.names[0] || '',
                    altNames: channel.names.slice(1),
                    icon: channel.icons[0] || '',
                    allNames: channel.names.join(' ')
                };
            });
            
            // Post-process programs to simplify structure and limit memory usage
            const maxProgramsPerChannel = constants.MAX_PROGRAMS_PER_CHANNEL || 500;
            results.programMap.forEach((programs, channelId) => {
                // Sort by start time
                programs.sort((a, b) => {
                    const aStart = a.start || a.$?.start || '';
                    const bStart = b.start || b.$?.start || '';
                    return aStart.localeCompare(bStart);
                });

                // Limit the number of programs per channel
                if (programs.length > maxProgramsPerChannel) {
                    logger.debug(`Limiting channel ${channelId} from ${programs.length} to ${maxProgramsPerChannel} programs`);
                    results.programMap.set(channelId, programs.slice(0, maxProgramsPerChannel));
                }

                // Simplify structure for each program
                results.programMap.set(channelId, programs.map(program => {
                    return {
                        channel: program.channel || program.$?.channel,
                        start: program.start || program.$?.start,
                        stop: program.stop || program.$?.stop,
                        title: program.titles[0] || '',
                        description: program.descriptions[0] || '',
                        category: program.categories[0] || ''
                    };
                }));
            });
            
            // Clean up temporary file if it exists
            if (filePath.includes('temp_epg_')) {
                try {
                    fs.unlinkSync(filePath);
                    logger.debug(`Removed temporary file: ${filePath}`);
                } catch (err) {
                    logger.warn(`Failed to remove temporary file ${filePath}: ${err.message}`);
                }
            }
            
            // Convert Maps back to objects for compatibility
            const finalResult = {
                channels: results.channels,
                programs: results.programs,
                channelMap: Object.fromEntries(results.channelMap),
                programMap: Object.fromEntries(results.programMap)
            };
            
            resolve(finalResult);
        });
        
        // Handle errors
        parser.on('error', (err) => {
            logger.error(`XML parsing error: ${err.message}`);
            handleStreamError(err);
        });
        
        // Start parsing
        readStream.pipe(parser);
    });
}

/**
 * Download and parse an EPG file using streaming
 * @param {string} url - URL of the EPG file
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object>} Parsed EPG data
 */
async function downloadAndParseEpg(url, progressCallback = null) {
    const fetch = require('node-fetch');
    const logger = require('../config/logger');
    let AbortControllerImpl = globalThis.AbortController;
    if (!AbortControllerImpl) {
        AbortControllerImpl = require('abort-controller');
    }

    const insecureHosts = constants.INSECURE_EPG_SOURCES || [];
    let httpsAgent;
    if (insecureHosts.some((host) => host && url.includes(host))) {
        httpsAgent = new https.Agent({ rejectUnauthorized: false });
        logger.warn(`Skipping TLS verification for ${url}`);
    }
    
    let tempFile = null;

    try {
        // Start download
        logger.info(`Starting streaming download of ${url}`);
        
        if (progressCallback) {
            progressCallback({
                stage: 'download_start',
                percent: 5,
                message: `Starting download of EPG data from ${url}`,
                details: { url }
            });
        }
        
        // Create temp file for storing download
        tempFile = createTempFile();
        
        // Detect if URL ends with .gz to determine if gzipped
        const isGzipped = url.toLowerCase().endsWith('.gz');
        
        // Create abort controller with a long timeout
        const controller = new AbortControllerImpl();
        const timeout = setTimeout(() => {
            controller.abort();
            logger.error(`Download timeout for ${url} after ${constants.STREAM_TIMEOUT || 180000}ms`);
        }, constants.STREAM_TIMEOUT || 180000); // 3 minute timeout
        
        // Fetch the file with streaming
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'EPG-Matcher/1.0',
                'Accept': 'application/xml, text/xml, */*',
                'Accept-Encoding': 'gzip, deflate'
            },
            signal: controller.signal,
            compress: true, // Allow automatic compression handling
            agent: httpsAgent
        });
        
        // Clear timeout as fetch completed
        clearTimeout(timeout);
        
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }
        
        // Check content type and encoding to better detect compression
        const contentType = response.headers.get('content-type') || '';
        const contentEncoding = response.headers.get('content-encoding') || '';
        
        // Update gzip detection logic
        const isActuallyGzipped = isGzipped || 
            contentEncoding.includes('gzip') || 
            contentType.includes('gzip') ||
            contentType.includes('application/x-gzip');
            
        logger.info(`Detected ${isActuallyGzipped ? 'gzipped' : 'uncompressed'} EPG data, content-encoding: ${contentEncoding}, content-type: ${contentType}`);
        
        // Check for content-length header
        const contentLength = response.headers.get('content-length');
        let totalSize = contentLength ? parseInt(contentLength, 10) : 0;
        let downloadedSize = 0;
        let lastReportedProgress = Date.now();
        let lastReportedPercent = 0;
        
        // Create a transform stream to track download progress with better error handling
        const progressTracker = new Transform({
            highWaterMark: 64 * 1024, // Increase buffer size
            transform(chunk, encoding, callback) {
                try {
                    // Update downloaded size
                    downloadedSize += chunk.length;
                    
                    // Calculate progress percentage
                    const percent = totalSize > 0 ? Math.floor((downloadedSize / totalSize) * 100) : -1;
                    const now = Date.now();
                    
                    // Report progress every 5% or every 3 seconds, whichever comes first
                    if (percent >= lastReportedPercent + 5 || now - lastReportedProgress > 3000) {
                        lastReportedProgress = now;
                        lastReportedPercent = percent;
                        
                        // Human-readable sizes
                        const downloadedMB = (downloadedSize / (1024 * 1024)).toFixed(2);
                        const totalMB = totalSize > 0 ? (totalSize / (1024 * 1024)).toFixed(2) : 'unknown';
                        
                        if (progressCallback) {
                            progressCallback({
                                stage: 'downloading',
                                percent: Math.min(5 + Math.floor((percent > 0 ? percent : downloadedSize / (10 * 1024 * 1024)) * 0.25), 30),
                                message: percent > 0 
                                    ? `Downloading EPG data: ${downloadedMB}MB / ${totalMB}MB (${percent}%)`
                                    : `Downloading EPG data: ${downloadedMB}MB (size unknown)`,
                                details: { 
                                    downloadedSize, 
                                    totalSize,
                                    percent,
                                    isGzipped: isActuallyGzipped
                                }
                            });
                        }
                    }
                    
                    // Pass the chunk through
                    callback(null, chunk);
                } catch (error) {
                    logger.error(`Error in progress tracker: ${error.message}`);
                    callback(error);
                }
            }
        });
        
        try {
            // Set up the download pipeline with improved buffer size and error handling
            logger.info(`Starting download pipeline for ${url}, gzipped: ${isActuallyGzipped}`);
            
            // Force garbage collection before large operation if available
            if (global.gc) {
                try {
                    global.gc();
                    logger.debug('Forced garbage collection before download');
                } catch (gcError) {
                    logger.warn(`Failed to force garbage collection: ${gcError.message}`);
                }
            }
            
            // Write directly to temp file regardless of compression
            // The parseEpgStream function will handle decompression based on isGzipped flag
            await pipeline(
                response.body,
                progressTracker,
                tempFile.writeStream
            );
            
            logger.info(`Download complete: ${(downloadedSize / (1024 * 1024)).toFixed(2)}MB in ${((Date.now() - lastReportedProgress) / 1000).toFixed(1)}s (${(downloadedSize / (Date.now() - lastReportedProgress) * 1000 / (1024 * 1024)).toFixed(2)} MB/s)`);
        } catch (pipelineError) {
            logger.error(`Error in download pipeline: ${pipelineError.message}`, { stack: pipelineError.stack });
            throw pipelineError;
        }
        
        // Report download complete
        if (progressCallback) {
            progressCallback({
                stage: 'download_complete',
                percent: 30,
                message: `Download complete, parsing EPG data`,
                details: { 
                    downloadedSize,
                    totalSize: totalSize || downloadedSize,
                    filePath: tempFile.path,
                    isGzipped: isActuallyGzipped
                }
            });
        }
        
        logger.info(`Download complete, parsing EPG data from ${tempFile.path}`);

        const gzipRecoverableError = /(incorrect header check|invalid stored block lengths|unexpected end of file)/i;
        let result;
        try {
            // Now parse the downloaded file using streaming
            result = await parseEpgStream(tempFile.path, isActuallyGzipped, (parseProgress) => {
                if (progressCallback) {
                    const progressData = parseProgress || {};
                    // Map parse progress to overall progress (30-95%)
                    const scaledPercent = 30 + Math.floor((progressData.percent || 0) * 0.65);

                    progressCallback({
                        ...progressData,
                        percent: Math.min(scaledPercent, 95)
                    });
                }
            });
        } catch (parseError) {
            if (isActuallyGzipped && gzipRecoverableError.test(parseError.message || '')) {
                logger.warn(`Failed to parse ${url} as gzip (${parseError.message}). Retrying as plain XML.`);
                result = await parseEpgStream(tempFile.path, false, (parseProgress) => {
                    if (progressCallback) {
                        const progressData = parseProgress || {};
                        const scaledPercent = 30 + Math.floor((progressData.percent || 0) * 0.65);

                        progressCallback({
                            ...progressData,
                            percent: Math.min(scaledPercent, 95),
                            message: `Retrying parse without gzip: ${progressData.message || ''}`.trim()
                        });
                    }
                });
            } else {
                throw parseError;
            }
        }

        // Report completion
        if (progressCallback) {
            // Calculate total program count
            let programCount = 0;
            if (result.programMap) {
                // If it's already an object (from Object.fromEntries)
                if (typeof result.programMap === 'object' && !Array.isArray(result.programMap) && !(result.programMap instanceof Map)) {
                    programCount = Object.values(result.programMap).reduce((sum, programs) => sum + (Array.isArray(programs) ? programs.length : 0), 0);
                } 
                // If it's still a Map
                else if (result.programMap instanceof Map) {
                    programCount = Array.from(result.programMap.values()).reduce((sum, programs) => sum + (Array.isArray(programs) ? programs.length : 0), 0);
                }
            } else {
                programCount = result.programs.length;
            }

            progressCallback({
                stage: 'complete',
                percent: 100,
                message: `Parsing complete. Found ${result.channels.length} channels and ${programCount} programs`,
                details: {
                    channelCount: result.channels.length,
                    programCount,
                    isGzipped: isActuallyGzipped,
                    url
                }
            });
        }

        // Clean up temp file
        try {
            fs.unlinkSync(tempFile.path);
            logger.debug(`Removed temporary file: ${tempFile.path}`);
        } catch (cleanupError) {
            logger.warn(`Failed to clean up temporary file: ${cleanupError.message}`);
        }

        return result;
    } catch (error) {
        logger.error(`Failed to download and parse EPG: ${error.message}`, { 
            stack: error.stack,
            url
        });

        try {
            if (tempFile && tempFile.path && fs.existsSync(tempFile.path)) {
                fs.unlinkSync(tempFile.path);
            }
        } catch (_) {}
        
        if (progressCallback) {
            progressCallback({
                stage: 'error',
                percent: 0,
                message: `Error: ${error.message}`,
                details: { 
                    error: error.message,
                    url
                }
            });
        }
        
        throw error;
    }
}

module.exports = {
    parseEpgStream,
    downloadAndParseEpg
}; 
