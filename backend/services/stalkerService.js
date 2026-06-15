const fetch = require('node-fetch');
const logger = require('../config/logger');

/**
 * Stalker Middleware Service
 * Handles communication with MAG/Stalker middleware portals
 */

/**
 * Authenticate with Stalker portal and get token
 * @param {string} portalUrl - Portal URL (e.g., http://portal.url/stalker_portal/)
 * @param {string} macAddress - MAC address
 * @returns {Promise<{token: string, profileId: string}>}
 */
async function authenticateStalker(portalUrl, macAddress) {
  // Ensure portal URL ends with /
  const baseUrl = portalUrl.endsWith('/') ? portalUrl : `${portalUrl}/`;

  // Normalize MAC address format
  const normalizedMac = normalizeMacAddress(macAddress);

  logger.info(`Authenticating Stalker portal: ${baseUrl}`);

  // First request: Handshake to get token
  // Try portal.php endpoint first (newer Stalker portals), fallback to server/load.php
  const handshakeUrl = `${baseUrl}portal.php?type=stb&action=handshake`;

  // Retry logic for handshake - portals can return 500 errors when under load
  const maxRetries = 3;
  const retryDelays = [1000, 2000, 4000]; // 1s, 2s, 4s delays
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Fetching Stalker handshake (attempt ${attempt}/${maxRetries}): ${handshakeUrl}`);

      const handshakeResponse = await fetch(handshakeUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
          'X-User-Agent': 'Model: MAG250; Link: WiFi',
          'Cookie': `mac=${normalizedMac}; stb_lang=en; timezone=America/New_York`
        },
        timeout: 15000 // 15 second timeout
      });

      if (!handshakeResponse.ok) {
        const errorText = await handshakeResponse.text();
        const statusCode = handshakeResponse.status;

        // Only retry on 5xx errors (server errors) - don't retry 4xx (client errors)
        if (statusCode >= 500 && attempt < maxRetries) {
          logger.warn(`Stalker handshake returned ${statusCode}, retrying in ${retryDelays[attempt - 1]}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt - 1]));
          continue;
        }

        logger.error(`Stalker handshake HTTP error (${statusCode}): ${errorText.substring(0, 500)}`);
        throw new Error(`Stalker handshake failed: ${statusCode} ${handshakeResponse.statusText}`);
      }

      // Try to parse JSON, log the raw response if it fails
      let handshakeData;
      try {
        const responseText = await handshakeResponse.text();
        logger.debug(`Stalker handshake raw response (${responseText.length} chars): ${responseText.substring(0, 500)}`);
        handshakeData = JSON.parse(responseText);
      } catch (jsonError) {
        logger.error(`Failed to parse Stalker handshake response as JSON: ${jsonError.message}`);
        throw new Error(`Invalid JSON response from Stalker portal`);
      }

      if (!handshakeData || !handshakeData.js) {
        throw new Error('Invalid Stalker handshake response');
      }

      // Extract token from response
      const token = handshakeData.js.token || null;
      const profileId = handshakeData.js.id || '1';

      if (!token) {
        throw new Error('Failed to obtain Stalker authentication token');
      }

      logger.info('Stalker authentication successful');

      return { token, profileId, baseUrl };

    } catch (error) {
      lastError = error;

      // Retry on network errors (ECONNRESET, ETIMEDOUT, etc.)
      const isNetworkError = error.code === 'ECONNRESET' ||
                            error.code === 'ETIMEDOUT' ||
                            error.code === 'ECONNREFUSED' ||
                            error.type === 'request-timeout';

      if (isNetworkError && attempt < maxRetries) {
        logger.warn(`Stalker handshake network error (${error.code || error.type}), retrying in ${retryDelays[attempt - 1]}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt - 1]));
        continue;
      }

      // Don't retry - throw immediately
      logger.error(`Stalker authentication error: ${error.message}`);
      throw error;
    }
  }

  // If we get here, all retries failed
  logger.error(`Stalker authentication failed after ${maxRetries} attempts: ${lastError?.message}`);
  throw lastError || new Error('Stalker authentication failed after retries');
}

/**
 * Get account information from Stalker portal
 * @param {string} portalUrl - Portal URL
 * @param {string} macAddress - MAC address
 * @param {string} token - Authentication token
 * @returns {Promise<Object>} Account info
 */
async function getStalkerAccountInfo(portalUrl, macAddress, token) {
  try {
    const baseUrl = portalUrl.endsWith('/') ? portalUrl : `${portalUrl}/`;
    const normalizedMac = normalizeMacAddress(macAddress);

    const url = `${baseUrl}portal.php?type=account_info&action=get_main_info`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': 'Model: MAG250; Link: WiFi',
        'Cookie': `mac=${normalizedMac}; stb_lang=en; timezone=America/New_York`,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      logger.warn(`Failed to get Stalker account info: ${response.status}`);
      return {
        exp_date: null,
        account_status: 'Active',
        is_trial: false
      };
    }

    const data = await response.json();
    logger.debug('Stalker account info:', data);

    return {
      exp_date: data.account_info?.end_date || null,
      account_status: data.account_info?.status || 'Active',
      is_trial: data.account_info?.is_trial === '1' || false
    };
  } catch (error) {
    logger.error(`Error getting Stalker account info: ${error.message}`);
    // Return default values if account info fails
    return {
      exp_date: null,
      account_status: 'Active',
      is_trial: false
    };
  }
}

/**
 * Get channel categories/genres from Stalker portal
 * @param {string} baseUrl - Base portal URL
 * @param {string} macAddress - MAC address
 * @param {string} token - Authentication token
 * @returns {Promise<Array>} Array of categories
 */
async function getStalkerCategories(baseUrl, macAddress, token) {
  try {
    const normalizedMac = normalizeMacAddress(macAddress);
    const url = `${baseUrl}portal.php?type=itv&action=get_genres`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': 'Model: MAG250; Link: WiFi',
        'Cookie': `mac=${normalizedMac}; stb_lang=en; timezone=America/New_York`,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get Stalker categories: ${response.status}`);
    }

    const data = await response.json();
    logger.debug(`Stalker categories response:`, data);

    if (!data || !data.js) {
      return [];
    }

    // Transform to standard format
    return data.js.map(cat => ({
      id: cat.id || cat.genre_id || cat.title,
      name: cat.title || cat.name || 'Unknown',
      alias: cat.alias || null
    }));
  } catch (error) {
    logger.error(`Error getting Stalker categories: ${error.message}`);
    return [];
  }
}

/**
 * Get channels from Stalker portal
 * @param {string} baseUrl - Base portal URL
 * @param {string} macAddress - MAC address
 * @param {string} token - Authentication token
 * @param {Array} categories - Categories to map channel groups
 * @param {Function} onProgress - Optional progress callback function
 * @returns {Promise<Array>} Array of channels
 */
async function getStalkerChannels(baseUrl, macAddress, token, categories = [], onProgress = null) {
  try {
    const normalizedMac = normalizeMacAddress(macAddress);

    // Create unique source identifier from baseUrl to prevent channel ID conflicts
    const crypto = require('crypto');
    const sourceHash = crypto.createHash('md5').update(baseUrl).digest('hex').substring(0, 8);

    // Create category lookup map
    const categoryMap = {};
    categories.forEach(cat => {
      categoryMap[cat.id] = cat.name;
    });

    // Use get_all_channels action to fetch ALL channels in ONE request (much faster!)
    logger.info('Fetching ALL Stalker channels in one request using get_all_channels...');
    const url = `${baseUrl}portal.php?type=itv&action=get_all_channels&JsHttpRequest=1-xml`;

    // Retry logic for handling transient errors and corrupted responses
    const maxRetries = 3;
    let lastError = null;
    let data = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff: 2s, 4s, 8s
          logger.info(`Retry attempt ${attempt}/${maxRetries} after ${delayMs}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // Create an AbortController for timeout handling
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
        }, 120000); // 120 second timeout for large responses (up to 50k channels)

        let response;
        try {
          logger.info(`Attempt ${attempt}: Requesting channel data from Stalker portal...`);
          response = await fetch(url, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
              'X-User-Agent': 'Model: MAG250; Link: WiFi',
              'Cookie': `mac=${normalizedMac}; stb_lang=en; timezone=America/New_York`,
              'Authorization': `Bearer ${token}`
            },
            signal: controller.signal
          });
        } catch (fetchError) {
          clearTimeout(timeout);
          if (fetchError.name === 'AbortError') {
            throw new Error('Request timeout - portal took longer than 120 seconds to respond');
          }
          throw fetchError;
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          throw new Error(`Failed to get Stalker channels: ${response.status}`);
        }

        // Download response and parse with streaming parser for memory efficiency
        logger.info(`Downloading channel data from Stalker portal...`);
        const responseText = await response.text();
        const responseSize = (responseText.length / 1024 / 1024).toFixed(2);
        logger.info(`Downloaded ${responseSize} MB of channel data, parsing with streaming parser...`);

        try {
          const { JSONParser } = require('@streamparser/json');

          // Configure parser to extract the data array
          const parser = new JSONParser({
            paths: ['$.js.data.*'], // Only emit individual channel objects from data array
            keepStack: false // Don't keep full stack for memory efficiency
          });

          let channelCount = 0;
          const parsedChannels = [];

          // Set up value handler to collect channels
          // Note: In streamparser-json v0.11+, callbacks use individual arguments, not object destructuring
          parser.onValue = (value, key, parent, stack) => {
            // Only process values from the data array (not the full object)
            if (value && typeof value === 'object') {
              parsedChannels.push(value);
              channelCount++;

              // Progress logging every 5000 channels
              if (channelCount % 5000 === 0) {
                logger.info(`Parsing progress: ${channelCount} channels processed`);

                // Call progress callback if provided
                if (onProgress) {
                  onProgress({
                    message: `Parsed ${channelCount} channels...`,
                    progress: 0
                  });
                }
              }
            }
          };

          // Set up error handler
          parser.onError = (err) => {
            logger.error(`Parser error: ${err.message}`);
          };

          // Parse in chunks to avoid blocking event loop
          const chunkSize = 1024 * 100; // 100KB chunks
          for (let i = 0; i < responseText.length; i += chunkSize) {
            const chunk = responseText.slice(i, i + chunkSize);
            parser.write(chunk);
          }

          // Signal end of parsing
          parser.end();

          logger.info(`Successfully parsed ${channelCount} channels from ${responseSize} MB response`);

          // Reconstruct data object structure
          data = {
            js: {
              data: parsedChannels,
              total_items: channelCount
            }
          };

          break; // Success! Exit retry loop

        } catch (parseError) {
          const errorMessage = parseError.message || 'Unknown parsing error';
          logger.error(`JSON parsing error: ${errorMessage}`);
          throw new Error(`Failed to parse JSON: ${errorMessage}`);
        }

      } catch (attemptError) {
        lastError = attemptError;
        logger.warn(`Attempt ${attempt}/${maxRetries} failed: ${attemptError.message}`);

        // Don't retry on certain errors
        if (attemptError.message.includes('401') || attemptError.message.includes('403')) {
          logger.error('Authentication error - not retrying');
          break;
        }

        if (attempt === maxRetries) {
          logger.error(`All ${maxRetries} attempts failed`);
          throw new Error(`Failed to fetch Stalker channels after ${maxRetries} attempts: ${lastError.message}`);
        }
      }
    }

    if (!data) {
      throw new Error(`Failed to fetch valid data: ${lastError?.message || 'Unknown error'}`);
    }

    if (!data || !data.js) {
      logger.warn('No channel data in response');
      return [];
    }

    // Handle response format
    let allChannels = [];
    if (Array.isArray(data.js)) {
      allChannels = data.js;
    } else if (typeof data.js === 'object') {
      if (data.js.data && Array.isArray(data.js.data)) {
        allChannels = data.js.data;
      } else {
        allChannels = Object.values(data.js);
      }
    }

    logger.info(`Successfully loaded ${allChannels.length} channels in one request!`);

    // Transform to standard channel format, filtering out channels with invalid data
    const channels = allChannels
      .filter(channel => {
        // Unwrap if channel is wrapped in {value: ...} object
        const ch = channel.value || channel;

        // Filter out channels with no name or no cmd (stream command)
        if (!ch.name || ch.name.trim() === '') {
          return false;
        }
        if (!ch.cmd || ch.cmd.trim() === '') {
          return false;
        }
        return true;
      })
      .map(channel => {
        // Unwrap if channel is wrapped in {value: ...} object
        const ch = channel.value || channel;
        const categoryName = categoryMap[ch.tv_genre_id] || 'Uncategorized';

        return {
          id: `stalker_${sourceHash}_${ch.id}`,
          name: ch.name,
          logo: ch.logo || '',
          groupTitle: categoryName,  // Use groupTitle instead of group for consistency
          url: buildStalkerStreamUrl(baseUrl, ch.id, ch.cmd, normalizedMac),
          epgChannelId: ch.xmltv_id || ch.epg_id || '',
          number: ch.number || 0,
          cmd: ch.cmd || ''
        };
      });

    const filteredCount = allChannels.length - channels.length;
    if (filteredCount > 0) {
      logger.warn(`Filtered out ${filteredCount} invalid Stalker channels (empty name or cmd)`);
    }

    logger.info(`Successfully loaded ${channels.length} valid channels from Stalker portal`);
    return channels;
  } catch (error) {
    logger.error(`Error getting Stalker channels: ${error.message}`);
    throw error;
  }
}

/**
 * Build stream URL for Stalker channel
 * @param {string} baseUrl - Base portal URL
 * @param {string} channelId - Channel ID
 * @param {string} cmd - Stream command
 * @param {string} macAddress - MAC address
 * @returns {string} Stream URL
 */
function buildStalkerStreamUrl(baseUrl, channelId, cmd, macAddress) {
  // For Stalker middleware, we need to construct the create_link URL
  // This will be used by the player to get the actual stream URL
  return `${baseUrl}portal.php?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&forced_storage=&disable_ad=0&download=0&JsHttpRequest=1-xml`;
}

/**
 * Normalize MAC address to standard format (XX:XX:XX:XX:XX:XX)
 * @param {string} mac - MAC address in various formats
 * @returns {string} Normalized MAC address
 */
function normalizeMacAddress(mac) {
  // Remove all non-hex characters
  const cleanMac = mac.replace(/[^0-9A-Fa-f]/g, '');

  // Ensure it's 12 characters
  if (cleanMac.length !== 12) {
    throw new Error(`Invalid MAC address: ${mac}. Must be 12 hex characters.`);
  }

  // Format as XX:XX:XX:XX:XX:XX
  return cleanMac.match(/.{1,2}/g).join(':').toUpperCase();
}

/**
 * Load channels and account info from Stalker portal
 * Main entry point for loading Stalker EPG data
 * @param {string} portalUrl - Portal URL
 * @param {string} macAddress - MAC address
 * @param {Object} options - Additional options (including onProgress callback)
 * @returns {Promise<{success: boolean, channels: Array, categories: Array, accountInfo: Object}>}
 */
async function loadStalkerEPG(portalUrl, macAddress, options = {}) {
  try {
    logger.info(`Starting Stalker EPG load for portal: ${portalUrl}`);

    // Step 1: Authenticate and get token
    const { token, profileId, baseUrl } = await authenticateStalker(portalUrl, macAddress);

    // Step 2: Get account information
    const accountInfo = await getStalkerAccountInfo(baseUrl, macAddress, token);

    // Step 3: Get categories
    const categories = await getStalkerCategories(baseUrl, macAddress, token);
    logger.info(`Loaded ${categories.length} categories from Stalker portal`);

    // Step 4: Get channels with progress callback
    const channels = await getStalkerChannels(baseUrl, macAddress, token, categories, options.onProgress);
    logger.info(`Loaded ${channels.length} channels from Stalker portal`);

    return {
      success: true,
      channels,
      categories,
      accountInfo,
      token,
      profileId
    };
  } catch (error) {
    logger.error(`Stalker EPG load failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      channels: [],
      categories: [],
      accountInfo: {}
    };
  }
}

module.exports = {
  loadStalkerEPG,
  authenticateStalker,
  getStalkerAccountInfo,
  getStalkerCategories,
  getStalkerChannels,
  normalizeMacAddress
};
