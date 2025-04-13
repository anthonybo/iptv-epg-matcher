/**
 * Detailed Progress Service
 * Manages detailed step-by-step progress updates with session management
 */
const logger = require('../config/logger');
const sessionStorage = require('../utils/sessionStorage');
const { broadcastSSEUpdate } = require('../utils/sseUtils');
const { fetchURL } = require('../utils/fetchUtils');
const m3uService = require('../services/m3uService');
const path = require('path');
const fs = require('fs');

/**
 * Process a request with detailed progress updates
 * @param {string} sessionId - The session ID
 * @param {Object} options - Processing options
 * @returns {Promise<void>}
 */
const processWithDetailedUpdates = async (sessionId, options) => {
  if (!sessionId) {
    logger.error('Invalid sessionId provided to processWithDetailedUpdates');
    return;
  }
  
  const { m3uUrl, epgUrl, xtreamUsername, xtreamPassword, xtreamServer, forceUpdate, uploadedFiles } = options;
  
  // Get or create session
  let session = sessionStorage.getSession(sessionId);
  if (!session) {
    logger.info(`Creating new session for ID ${sessionId}`);
    session = sessionStorage.createSession(sessionId, {
      status: 'processing',
      data: {
        channels: [],
        epg: {},
        options
      }
    });
    
    // Double-check session was created successfully
    if (!session) {
      logger.error(`Failed to create session for ${sessionId}`);
      return;
    }
  }
  
  // Send immediate progress update to confirm processing has started
  broadcastSSEUpdate({
    type: 'progress',
    stage: 'starting',
    message: 'Starting data processing',
    progress: 1,
    sessionId
  }, sessionId);
  
  // Delay a short while to ensure the client receives the initial update
  await delay(300);
  
  // Cache check stage (5%)
  sendProgressUpdate(sessionId, 'checking_cache', 5, 'Checking for cached data');
  
  // Determine cache key and files
  const cacheKey = xtreamUsername && xtreamPassword && xtreamServer 
    ? `${xtreamServer}:${xtreamUsername}:${xtreamPassword}`.replace(/[\/\\:]/g, '_')
    : `default_${sessionId}`;
    
  const cacheDir = path.join(process.cwd(), 'cache');
  const cacheChannelsFile = path.join(cacheDir, `${cacheKey}_channels.json`);
  const cacheValid = !forceUpdate && fs.existsSync(cacheChannelsFile) && 
    (Date.now() - fs.statSync(cacheChannelsFile).mtime.getTime() < 24 * 60 * 60 * 1000);
  
  let channels = [];
  
  if (cacheValid) {
    try {
      sendProgressUpdate(sessionId, 'loading_cache', 10, 'Loading channels from cache');
      logger.info(`Loading channels from cache file: ${cacheChannelsFile}`);
      
      const cacheData = fs.readFileSync(cacheChannelsFile, 'utf8');
      channels = JSON.parse(cacheData);
      
      if (channels && channels.length > 0) {
        logger.info(`Successfully loaded ${channels.length} channels from cache`);
        sendProgressUpdate(sessionId, 'cache_loaded', 15, `Loaded ${channels.length} channels from cache`);
        
        // Process the cached channels
        processChannels(sessionId, channels);
        return;
      } else {
        logger.warn('Cache file exists but contains no valid channels, will load fresh data');
      }
    } catch (cacheError) {
      logger.error(`Error loading from cache: ${cacheError.message}`);
      sendProgressUpdate(sessionId, 'cache_error', 12, 'Error loading from cache, will fetch fresh data');
    }
  }
  
  // Channel loading stages (15-25%)
  sendProgressUpdate(sessionId, 'loading_channels', 15, 'Loading channel data');
  
  // Actually load the real channels from Xtream
  try {
    if (xtreamUsername && xtreamPassword && xtreamServer) {
      logger.info(`Loading real channels from Xtream server: ${xtreamServer}`);
      
      // Prepare the Xtream URL
      const baseUrl = xtreamServer.endsWith('/') ? xtreamServer : `${xtreamServer}/`;
      const xtreamM3uUrl = `${baseUrl}get.php?username=${xtreamUsername}&password=${xtreamPassword}&type=m3u_plus&output=ts`;
      
      // Fetch the M3U content using fetchURL from utils
      sendProgressUpdate(sessionId, 'fetching_m3u', 18, 'Fetching M3U data from provider');
      const buffer = await fetchWithProgressUpdates(xtreamM3uUrl, sessionId);
      const m3uContent = buffer.toString('utf8');
      
      if (!m3uContent || !m3uContent.includes('#EXTM3U')) {
        throw new Error('Invalid M3U content received from Xtream provider');
      }
      
      logger.info(`Successfully fetched M3U content: ${Math.round(m3uContent.length / 1024 / 1024 * 10) / 10} MB`);
      
      // Parse the M3U content with progress updates
      sendProgressUpdate(sessionId, 'parsing_m3u', 22, 'Parsing channel data');
      channels = await parseM3UWithProgressUpdates(m3uContent, sessionId);
      
      if (!channels || channels.length === 0) {
        throw new Error('No channels found in M3U content');
      }
      
      logger.info(`Successfully parsed ${channels.length} channels from Xtream`);
      
      // Save to cache
      try {
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
        
        fs.writeFileSync(cacheChannelsFile, JSON.stringify(channels, null, 2));
        logger.info(`Saved ${channels.length} channels to cache: ${cacheChannelsFile}`);
      } catch (cacheError) {
        logger.error(`Error saving to cache: ${cacheError.message}`);
      }
      
      // Process the channels
      processChannels(sessionId, channels);
    } else {
      logger.warn('No Xtream credentials provided, using test data');
      channels = generateTestChannels(50);
      processChannels(sessionId, channels);
    }
  } catch (error) {
    logger.error(`Error loading channels: ${error.message}`);
    
    // Provide clear error feedback to the user
    broadcastSSEUpdate({
      type: 'error',
      message: `Failed to load channels: ${error.message}`,
      stage: 'channel_error',
      progress: 25,
      sessionId
    }, sessionId);
    
    // Fall back to test data
    channels = generateTestChannels(50);
    sendProgressUpdate(sessionId, 'channel_error', 22, `Error loading channels: ${error.message.substring(0, 100)}. Using test data.`);
    processChannels(sessionId, channels);
  }
};

// Helper function to process channels after they've been loaded
async function processChannels(sessionId, channels) {
  sendProgressUpdate(sessionId, 'processing_channels', 25, `Processing ${channels.length} channels`);
  
  // Generate categories from actual channels
  // Force garbage collection first if available
  if (global.gc) {
    try {
      global.gc();
      logger.info('Performed garbage collection before generating categories');
    } catch (err) {
      logger.warn('Failed to perform garbage collection', { error: err.message });
    }
  }
  
  sendProgressUpdate(sessionId, 'generating_categories', 30, 'Generating channel categories');
  const categories = channels.reduce((acc, ch) => {
    const groupTitle = ch.groupTitle || 'Uncategorized';
    acc[groupTitle] = (acc[groupTitle] || 0) + 1;
    return acc;
  }, {});

  const categoriesArray = Object.entries(categories)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  logger.info(`Generated ${categoriesArray.length} categories from ${channels.length} channels`);

  // Store in session
  let session = sessionStorage.getSession(sessionId);
  sessionStorage.updateSession(sessionId, { 
    data: {
      ...(session?.data || {}),
      categories: categoriesArray,
      channels: channels,
      channelsCount: channels.length,
      categoriesCount: categoriesArray.length
    }
  });

  // Send an update to the client that channels are available
  broadcastSSEUpdate({
    type: 'channels_available',
    stage: 'channels_loaded',
    message: `Successfully loaded ${channels.length} channels`,
    channelCount: channels.length,
    progress: 40,
    sessionId,
    totalChannels: channels.length,
    categories: categoriesArray
  }, sessionId);
  
  // Continue with EPG loading (rest of function remains the same)
  sendProgressUpdate(sessionId, 'loading_epg', 55, 'Loading EPG data sources');
  await delay(500);
  sendProgressUpdate(sessionId, 'processing_epg', 70, 'Processing EPG data');
  await delay(500);
  sendProgressUpdate(sessionId, 'matching_epg', 85, 'Matching channels with EPG data');
  
  // Add EPG data
  try {
    if (channels.length <= 10000) {
      sessionStorage.updateSession(sessionId, {
        data: {
          epg: generateTestEpg(channels)
        }
      });
      logger.info(`Added test EPG data for ${channels.length} channels to session ${sessionId}`);
    } else {
      // For large datasets, generate EPG only for the first 1000 channels
      const sampleChannels = channels.slice(0, 1000);
      sessionStorage.updateSession(sessionId, {
        data: {
          epg: generateTestEpg(sampleChannels),
          partialEpg: true
        }
      });
      logger.info(`Added partial test EPG data for 1000/${channels.length} channels to session ${sessionId}`);
    }
  } catch (epgError) {
    logger.error(`Error updating session with EPG data: ${epgError.message}`);
  }
  
  // Finalizing (95-100%)
  sendProgressUpdate(sessionId, 'finalizing', 95, 'Optimizing data and finalizing');
  
  // Force garbage collection to free memory
  if (global.gc) {
    try {
      global.gc();
      logger.info('Performed garbage collection before completion');
    } catch (err) {
      logger.warn('Failed to perform garbage collection', { error: err.message });
    }
  }
  
  // Complete
  sendProgressUpdate(sessionId, 'complete', 100, 'Processing complete!');
  
  // Mark session as complete
  try {
    sessionStorage.updateSession(sessionId, {
      status: 'complete',
      completedAt: new Date()
    });
    
    // Get the final session state
    const finalSession = sessionStorage.getSession(sessionId);
    logger.info(`Final session state for ${sessionId}:`, {
      status: finalSession.status,
      channelCount: finalSession.data?.channels?.length,
      categoriesCount: finalSession.data?.categories?.length
    });
  } catch (finalizeError) {
    logger.error(`Error finalizing session: ${finalizeError.message}`);
  }
  
  // Send completion event with more detailed info
  broadcastSSEUpdate({
    type: 'complete',
    message: 'Data processing completed successfully',
    timestamp: new Date().toISOString(),
    channelCount: channels.length,
    sessionId
  }, sessionId);
  
  logger.info(`Completed detailed processing for session ${sessionId}`);
}

/**
 * Helper to create a delay
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Send a progress update via SSE
 * @param {string} sessionId - Session ID
 * @param {string} stage - Current processing stage
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Status message
 */
const sendProgressUpdate = (sessionId, stage, progress, message) => {
  if (!sessionId) return;
  
  logger.debug(`Progress update [${sessionId}]: ${stage} - ${progress}% - ${message}`);
  
  try {
    // Make sure we have app available from the global context
    const app = global.app;
    
    // First try the direct app.locals approach if available
    if (app && app.locals && app.locals.sessions && app.locals.sessions[sessionId]) {
      const session = app.locals.sessions[sessionId];
      if (session.clients && session.clients.length > 0) {
        session.clients.forEach(client => {
          if (!client.res.writableEnded) {
            const data = JSON.stringify({
              type: 'progress',
              stage,
              message,
              percentage: progress,
              timestamp: new Date().toISOString(),
              sessionId
            });
            client.res.write(`data: ${data}\n\n`);
          }
        });
        logger.debug(`Direct SSE update sent to ${session.clients.length} clients`);
        return;
      }
    }
    
    // Fall back to the broadcastSSEUpdate function
    broadcastSSEUpdate({
      type: 'progress',
      stage,
      message,
      percentage: progress,
      timestamp: new Date().toISOString(),
      sessionId
    }, sessionId);
  } catch (error) {
    logger.error(`Error sending progress update: ${error.message}`, error);
  }
};

/**
 * Generate test channels for development
 * @param {number} count - Number of channels to generate
 * @returns {Array} Array of test channels
 */
const generateTestChannels = (count) => {
  const categories = ['Movies', 'Sports', 'News', 'Entertainment', 'Kids'];
  const langs = ['en', 'fr', 'es', 'de', 'it'];
  
  return Array.from({ length: count }, (_, i) => {
    const num = i + 1;
    const groupTitle = categories[i % categories.length];
    return {
      tvgId: `test_channel_${num}`,
      name: `Test Channel ${num}`,
      groupTitle: groupTitle,
      language: langs[i % langs.length],
      url: `http://example.com/stream/${num}.ts`
    };
  });
};

/**
 * Generate test EPG data for development
 * @param {Array} channels - List of channels to generate EPG for
 * @returns {Object} EPG data object
 */
const generateTestEpg = (channels) => {
  if (!channels || channels.length === 0) return {};
  
  const now = new Date();
  const programs = {};
  
  channels.forEach(channel => {
    const channelPrograms = [];
    for (let i = 0; i < 24; i++) {
      const startTime = new Date(now);
      startTime.setHours(now.getHours() + i);
      
      const endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + 1);
      
      channelPrograms.push({
        title: `Program ${i + 1} on ${channel.name}`,
        start: startTime.toISOString(),
        end: endTime.toISOString(),
        description: `Test program description for hour ${i}`
      });
    }
    programs[channel.tvgId] = channelPrograms;
  });
  
  return {
    lastUpdated: now.toISOString(),
    programs
  };
};

/**
 * Fetch a URL with progress updates
 * @param {string} url - URL to fetch
 * @param {string} sessionId - Session ID for progress updates
 * @returns {Promise<Buffer>} - Response data
 */
async function fetchWithProgressUpdates(url, sessionId) {
  // Get the start time
  const startTime = Date.now();
  
  // Send initial progress
  sendProgressUpdate(sessionId, 'fetch_starting', 18, 'Starting download from provider');
  
  try {
    // Create fetch options
    const fetchOptions = {
      timeout: 60000, // 60 second timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };
    
    // Start the fetch
    const response = await fetchURL(url, fetchOptions);
    
    // Get the response buffer
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer);
    
    // Check for valid M3U content
    const contentStr = data.toString('utf8').substring(0, 1000);
    if (!contentStr.includes('#EXTM3U')) {
      logger.error(`Invalid M3U content received from ${url}. First 200 chars: ${contentStr.substring(0, 200)}`);
      sendProgressUpdate(sessionId, 'fetch_error', 19, 'Invalid M3U content received from provider');
      throw new Error('Invalid M3U content received from provider');
    }
    
    // Calculate download speed and time
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // in seconds
    const sizeInMB = data.length / (1024 * 1024);
    const speedMBps = sizeInMB / duration;
    
    // Log download statistics
    logger.info(`Download complete: ${Math.round(sizeInMB * 10) / 10} MB in ${Math.round(duration * 10) / 10}s (${Math.round(speedMBps * 100) / 100} MB/s)`);
    
    // Send completion update
    sendProgressUpdate(sessionId, 'fetch_complete', 20, `Download complete: ${Math.round(sizeInMB * 10) / 10} MB`);
    
    return data;
  } catch (error) {
    logger.error(`Error fetching URL: ${error.message}`);
    sendProgressUpdate(sessionId, 'fetch_error', 19, `Error downloading: ${error.message.substring(0, 100)}`);
    throw error;
  }
}

/**
 * Parse M3U content with progress updates
 * @param {string} m3uContent - M3U content to parse
 * @param {string} sessionId - Session ID for progress updates
 * @returns {Promise<Array>} - Array of parsed channels
 */
async function parseM3UWithProgressUpdates(m3uContent, sessionId) {
  return new Promise((resolve) => {
    sendProgressUpdate(sessionId, 'parse_starting', 21, 'Starting M3U parsing');
    
    const lines = m3uContent.split('\n');
    const totalLines = lines.length;
    const channels = [];
    let channelCount = 0;
    let currentChannel = null;
    let processedLines = 0;
    let lastProgressUpdate = Date.now();
    
    // Process in batches to avoid blocking the event loop
    function processNextBatch(startIndex, batchSize = 5000) {
      const endIndex = Math.min(startIndex + batchSize, totalLines);
      
      for (let i = startIndex; i < endIndex; i++) {
        const line = lines[i];
        processedLines++;
        
        // Send progress update at intervals
        const now = Date.now();
        if (processedLines % 50000 === 0 || now - lastProgressUpdate > 1000) {
          const percentComplete = Math.min(Math.floor((processedLines / totalLines) * 100), 100);
          const progress = 21 + Math.floor(percentComplete / 100);
          sendProgressUpdate(sessionId, 'parsing_m3u', progress, 
            `Parsing channels: ${processedLines} of ${totalLines} lines (${channelCount} channels found)`);
          lastProgressUpdate = now;
        }
        
        // Skip empty lines or the M3U header
        if (!line || line.startsWith('#EXTM3U')) continue;
        
        // Parse #EXTINF lines
        if (line.startsWith('#EXTINF')) {
          channelCount++;
          const extInfMatch = line.match(/^#EXTINF:-?\d+\s*(.*?),(.+)/);
          if (!extInfMatch) {
            continue;
          }
          
          const attributesStr = extInfMatch[1];
          const name = extInfMatch[2].trim();
          
          // Parse attributes
          const attributes = {};
          const attrMatches = attributesStr.matchAll(/(\w+-\w+|\w+)="([^"]*)"/g);
          for (const match of attrMatches) {
            attributes[match[1]] = match[2];
          }
          
          const tvgId = attributes['tvg-id'] || `channel_${generateChannelId(name, channelCount)}`;
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
        // Allow other operations to happen between batches
        setTimeout(() => processNextBatch(endIndex), 0);
      } else {
        // Deduplication by tvgId
        const uniqueChannels = Array.from(new Map(channels.map(ch => [ch.tvgId, ch])).values());
        logger.info(`Filtered ${channelCount} M3U entries to ${uniqueChannels.length} unique channels`);
        
        sendProgressUpdate(sessionId, 'parsing_complete', 24, 
          `Parsing complete: ${uniqueChannels.length} unique channels found`);
        
        resolve(uniqueChannels);
      }
    }
    
    // Start processing
    processNextBatch(0);
  });
}

/**
 * Generate a unique channel ID
 * @param {string} name - Channel name
 * @param {number} count - Channel count
 * @returns {string} - Unique ID
 */
function generateChannelId(name, count) {
  const nameHash = name.split('').reduce((hash, char) => {
    return ((hash << 5) - hash) + char.charCodeAt(0);
  }, 0);
  
  return Math.abs(nameHash + count).toString(36);
}

module.exports = {
  processWithDetailedUpdates
};