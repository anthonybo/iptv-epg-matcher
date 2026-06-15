/**
 * Detailed Progress Service
 * Manages detailed step-by-step progress updates with session management
 */
const logger = require('../config/logger');
const sessionStorage = require('../utils/session');
const { broadcastSSEUpdate } = require('../utils/sseUtils');
const { fetchURL } = require('../utils/fetchUtils');
const m3uService = require('../services/m3uService');
const iptvDatabaseService = require('../services/iptvDatabase');
const epgService = require('../services/epgService');
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
  
  const { m3uUrl, epgUrl, xtreamUsername, xtreamPassword, xtreamServer, portalUrl, macAddress, forceUpdate, uploadedFiles, userId } = options;
  
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
    : portalUrl && macAddress
      ? `${portalUrl}:${macAddress}`.replace(/[\/\\:]/g, '_')
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
        processChannels(sessionId, channels, userId, options);
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

      // Try JSON API first (player_api.php) - more reliable, less likely to be blocked by Cloudflare
      let useJsonApi = false;
      const jsonApiUrl = `${baseUrl}player_api.php?username=${xtreamUsername}&password=${xtreamPassword}&action=get_live_streams`;

      sendProgressUpdate(sessionId, 'fetching_channels', 18, 'Fetching channel data from provider');

      try {
        logger.debug(`Trying Xtream JSON API for server: ${xtreamServer}`);
        const fetch = require('node-fetch');
        const jsonResponse = await fetch(jsonApiUrl, {
          timeout: 60000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, */*'
          }
        });

        if (jsonResponse.ok) {
          const jsonData = await jsonResponse.json();
          if (Array.isArray(jsonData) && jsonData.length > 0) {
            useJsonApi = true;
            logger.info(`Successfully fetched ${jsonData.length} channels from Xtream JSON API`);

            // Convert JSON API format to our channel format
            // IMPORTANT: Each channel must have a unique 'id' field using xtream_{stream_id}
            // This prevents duplicate channel IDs when the same channel name appears multiple times
            sendProgressUpdate(sessionId, 'parsing_channels', 22, 'Processing channel data');
            channels = jsonData.map(ch => ({
              id: `xtream_${ch.stream_id}`,  // Unique ID based on stream_id
              name: ch.name,
              url: `${baseUrl}live/${xtreamUsername}/${xtreamPassword}/${ch.stream_id}.ts`,
              logo: ch.stream_icon || '',
              groupTitle: ch.category_id ? `Category ${ch.category_id}` : 'Uncategorized',
              epgChannelId: ch.epg_channel_id || '',
              tvgId: ch.epg_channel_id || '',
              tvgName: ch.name,
              streamId: ch.stream_id,
              categoryId: ch.category_id
            }));

            // Try to get categories for proper group names
            try {
              const catUrl = `${baseUrl}player_api.php?username=${xtreamUsername}&password=${xtreamPassword}&action=get_live_categories`;
              const catResponse = await fetch(catUrl, {
                timeout: 30000,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
              });
              if (catResponse.ok) {
                const categories = await catResponse.json();
                if (Array.isArray(categories)) {
                  const catMap = {};
                  categories.forEach(cat => {
                    catMap[cat.category_id] = cat.category_name;
                  });
                  // Update channel group titles with actual category names
                  channels.forEach(ch => {
                    if (ch.categoryId && catMap[ch.categoryId]) {
                      ch.groupTitle = catMap[ch.categoryId];
                    }
                  });
                  logger.info(`Applied ${categories.length} category names to channels`);
                }
              }
            } catch (catError) {
              logger.warn(`Could not fetch categories: ${catError.message}`);
            }
          }
        }
      } catch (jsonError) {
        logger.warn(`JSON API failed, falling back to M3U: ${jsonError.message}`);
      }

      // Fall back to M3U endpoint if JSON API didn't work
      if (!useJsonApi) {
        const xtreamM3uUrl = `${baseUrl}get.php?username=${xtreamUsername}&password=${xtreamPassword}&type=m3u_plus&output=ts`;
        logger.info(`Falling back to M3U endpoint for server: ${xtreamServer}`);

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
      }

      if (!channels || channels.length === 0) {
        throw new Error('No channels found from Xtream provider');
      }

      logger.info(`Successfully loaded ${channels.length} channels from Xtream`);
      
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
      processChannels(sessionId, channels, userId, options);
    } else if (portalUrl && macAddress) {
      // Load channels from Stalker/MAG portal
      logger.info(`Loading channels from Stalker portal: ${portalUrl}`);

      const stalkerService = require('./stalkerService');

      sendProgressUpdate(sessionId, 'loading_stalker', 18, 'Connecting to Stalker portal');

      // Create progress callback for Stalker pagination
      const onProgress = (progressInfo) => {
        const { channelsLoaded, totalChannels, page, message } = progressInfo;
        // Map progress from 18% to 24% based on channel loading progress
        const baseProgress = 18;
        const progressRange = 6; // 18% to 24%
        const loadProgress = Math.floor((channelsLoaded / totalChannels) * progressRange);
        const currentProgress = Math.min(baseProgress + loadProgress, 24);

        sendProgressUpdate(
          sessionId,
          'loading_stalker_channels',
          currentProgress,
          `${message} - ${Math.floor((channelsLoaded / totalChannels) * 100)}%`
        );
      };

      const stalkerResult = await stalkerService.loadStalkerEPG(portalUrl, macAddress, { onProgress });

      if (!stalkerResult.success) {
        throw new Error(stalkerResult.error || 'Failed to load from Stalker portal');
      }

      channels = stalkerResult.channels;

      if (!channels || channels.length === 0) {
        throw new Error('No channels found from Stalker portal');
      }

      logger.info(`Successfully loaded ${channels.length} channels from Stalker portal`);

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

      // Process the channels with Stalker account info
      processChannels(sessionId, channels, userId, { ...options, stalkerAccountInfo: stalkerResult.accountInfo, stalkerCategories: stalkerResult.categories });
    } else {
      logger.error('No IPTV credentials provided');
      broadcastSSEUpdate({
        type: 'error',
        message: 'No IPTV credentials provided',
        stage: 'channel_error',
        sessionId
      }, sessionId);
      return;
    }
  } catch (error) {
    logger.error(`Error loading channels: ${error.message}`);

    // Provide clear error feedback to the user
    broadcastSSEUpdate({
      type: 'error',
      message: `Error loading channels: ${error.message}`,
      stage: 'channel_error',
      sessionId
    }, sessionId);
    return;
  }
};

// Helper function to process channels after they've been loaded
async function processChannels(sessionId, channels, userId = null, options = {}) {
  sendProgressUpdate(sessionId, 'processing_channels', 25, `Processing ${channels.length} channels`);
  
  // Generate categories from actual channels
  // Force garbage collection first if available
  if (global.gc) {
    try {
      global.gc();
      logger.debug('Performed garbage collection before generating categories');
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
      logger.debug(`Added test EPG data for ${channels.length} channels to session ${sessionId}`);
    } else {
      // For large datasets, generate EPG only for the first 1000 channels
      const sampleChannels = channels.slice(0, 1000);
      sessionStorage.updateSession(sessionId, {
        data: {
          epg: generateTestEpg(sampleChannels),
          partialEpg: true
        }
      });
      logger.debug(`Added partial test EPG data for 1000/${channels.length} channels to session ${sessionId}`);
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
      logger.debug('Performed garbage collection before completion');
    } catch (err) {
      logger.warn('Failed to perform garbage collection', { error: err.message });
    }
  }
  
  // Progress — NOT 'complete' yet. Channel rows haven't been persisted to the DB,
  // so iptv_sources.channel_count is still null. If we broadcast 'complete' here
  // the frontend refreshes the source list while the count is 0. The authoritative
  // `complete` event is the broadcastSSEUpdate({type:'complete'}) below, after
  // saveChannels has run.
  sendProgressUpdate(sessionId, 'persisting', 97, 'Saving channels to database…');

  // Mark session as complete
  try {
    sessionStorage.updateSession(sessionId, {
      status: 'complete',
      completedAt: new Date()
    });
    
    // Get the final session state
    const finalSession = sessionStorage.getSession(sessionId);
    logger.debug(`Final session state for ${sessionId}: status=${finalSession.status}, channels=${finalSession.data?.channels?.length}, categories=${finalSession.data?.categories?.length}`);
  } catch (finalizeError) {
    logger.error(`Error finalizing session: ${finalizeError.message}`);
  }
  
  // Save channels to database for persistence
  try {
    if (channels && channels.length > 0) {
      logger.info(`Saving ${channels.length} channels to database for persistence${userId ? ` (user ${userId})` : ''}`);

      // Get credentials from options parameter FIRST (passed from load request),
      // then fallback to session data if not in options
      const session = sessionStorage.getSession(sessionId);
      logger.debug(`Session data keys: ${Object.keys(session?.data || {}).join(', ')}`);
      logger.debug(`Options keys: ${Object.keys(options || {}).join(', ')}`);

      const sessionData = session?.data || {};
      const xtreamServer = options.xtreamServer || sessionData.xtreamServer || sessionData.options?.xtreamServer;
      const xtreamUsername = options.xtreamUsername || sessionData.xtreamUsername || sessionData.options?.xtreamUsername;
      const xtreamPassword = options.xtreamPassword || sessionData.xtreamPassword || sessionData.options?.xtreamPassword;
      const m3uUrl = options.m3uUrl || sessionData.m3uUrl || sessionData.options?.m3uUrl;
      const portalUrl = options.portalUrl || sessionData.portalUrl || sessionData.options?.portalUrl;
      const macAddress = options.macAddress || sessionData.macAddress || sessionData.options?.macAddress;

      logger.debug(`Source info from options/session: type=${xtreamServer ? 'xtream' : portalUrl ? 'stalker' : m3uUrl ? 'm3u' : 'unknown'}, hasXtreamServer=${!!xtreamServer}, hasPortal=${!!portalUrl}, hasM3u=${!!m3uUrl}, sessionId=${sessionId}`);

      // Create source info
      const sourceInfo = {
        user_id: userId,
        name: xtreamServer || portalUrl || m3uUrl || sessionId,
        url: xtreamServer || portalUrl || m3uUrl || sessionId,
        username: xtreamUsername || '',
        password: xtreamPassword || '',
        mac_address: macAddress || null,
        type: xtreamServer ? 'xtream' : portalUrl ? 'stalker' : m3uUrl ? 'm3u' : 'unknown'
      };

      // Fetch account info from Xtream API if this is an Xtream source
      if (xtreamServer && xtreamUsername && xtreamPassword) {
        logger.debug('Fetching account info from Xtream API');
        try {
          const accountInfo = await epgService.fetchXtreamAccountInfo(
            xtreamServer,
            xtreamUsername,
            xtreamPassword
          );

          // Add account info to sourceInfo
          Object.assign(sourceInfo, accountInfo);
          logger.debug('Account info fetched successfully');
        } catch (accountError) {
          logger.warn(`Could not fetch account info: ${accountError.message}`);
        }
      }

      // Fetch account info from Stalker portal if this is a Stalker source
      if (portalUrl && macAddress && options.stalkerAccountInfo) {
        logger.debug('Using Stalker account info from portal response');
        Object.assign(sourceInfo, options.stalkerAccountInfo);
      }

      // Save source
      const savedSource = await iptvDatabaseService.saveSource(sourceInfo);
      const sourceId = savedSource.id || savedSource; // Handle both object and ID return types
      logger.info(`Source saved with ID: ${sourceId}`);

      // Transform and save channels with source metadata
      const dbChannels = channels.map(ch => ({
        id: ch.tvgId || ch.id || ch.name,
        name: ch.name,
        logo: ch.tvgLogo || ch.logo || '',
        url: ch.url,
        group_title: ch.groupTitle || ch.group?.title || ch.group_title || '',
        tvg_id: ch.epgChannelId || ch.tvgId || '',
        tvg_name: ch.name,
        categories: ch.categories || [],
        // Add source metadata for multiview
        source_type: sourceInfo.type,
        source_url: sourceInfo.url,
        source_username: sourceInfo.username || null,
        source_password: sourceInfo.password || null,
        source_mac: sourceInfo.mac_address || null
      }));

      // Pass an onProgress callback so the SSE pipe can update the
      // BulkAdd modal's "Saving to database…" row in real time.
      // Without this the row sits at "97% · Still working on saving
      // to database" for 5+ minutes with nothing on the wire — the
      // user had no way to tell working from frozen.
      await iptvDatabaseService.saveChannels(sourceId, dbChannels, {
        onProgress: ({ saved, total }) => {
          // The progress band 97→99% is reserved for the INSERT loop.
          // We map saved/total into that 2-point window so the
          // existing 'persisting' step retains its position in the
          // overall pipeline visual. The text gives the user the
          // concrete numbers ("4,200 / 8,238 channels saved (51%)").
          const innerPct = total > 0 ? Math.floor((saved / total) * 100) : 0;
          const outerPct = 97 + Math.floor((innerPct / 100) * 2); // 97..99
          sendProgressUpdate(
            sessionId,
            'persisting',
            outerPct,
            `Saving channels to database… ${saved.toLocaleString()} / ${total.toLocaleString()} (${innerPct}%)`
          );
        }
      });
      logger.info(`Successfully saved ${dbChannels.length} channels to database`);

      // Associate session with source
      await iptvDatabaseService.associateSourceWithSession(sessionId, sourceId);
      logger.debug(`Associated session ${sessionId} with source ${sourceId}`);

      // If user is authenticated, create user preference for this source
      if (userId) {
        try {
          await iptvDatabaseService.createUserIPTVPreference(userId, sourceId, {
            nickname: sourceInfo.name,
            isActive: true
          });
          logger.debug(`Created user preference for user ${userId}, source ${sourceId}`);
        } catch (prefError) {
          // Don't fail the whole operation if preference creation fails
          logger.warn(`Failed to create user preference: ${prefError.message}`);
        }
      }

    }
  } catch (dbError) {
    logger.error(`Error saving to database: ${dbError.message}`, { stack: dbError.stack });
    // Don't fail the whole process if database save fails
  }

  // Send completion event with more detailed info (no stream diagnostics)
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
    // Determine event type based on stage
    const eventType = stage === 'error' || stage === 'fetch_error' || stage === 'channel_error' || stage === 'cache_error'
      ? 'error'
      : stage === 'complete'
        ? 'complete'
        : 'progress';

    // Make sure we have app available from the global context
    const app = global.app;

    // First try the direct app.locals approach if available
    if (app && app.locals && app.locals.sessions && app.locals.sessions[sessionId]) {
      const session = app.locals.sessions[sessionId];
      if (session.clients && session.clients.length > 0) {
        session.clients.forEach(client => {
          if (!client.res.writableEnded) {
            const data = JSON.stringify({
              type: eventType,
              stage,
              message,
              percentage: progress,
              timestamp: new Date().toISOString(),
              sessionId
            });
            // Send with named event type for error and complete events
            if (eventType !== 'progress') {
              client.res.write(`event: ${eventType}\n`);
            }
            client.res.write(`data: ${data}\n\n`);
          }
        });
        logger.debug(`Direct SSE update (${eventType}) sent to ${session.clients.length} clients`);
        return;
      }
    }

    // Fall back to the broadcastSSEUpdate function
    broadcastSSEUpdate({
      type: eventType,
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
    
    const lines = m3uContent.split('\n').map(line => line.trim());
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