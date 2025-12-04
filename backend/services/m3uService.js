/**
 * M3U Service - handles parsing and generation of M3U files
 */
const crypto = require('crypto');
const xml2js = require('xml2js');
const logger = require('../config/logger');
const { fetchURL } = require('../utils/fetchUtils');

/**
 * Parses M3U content into structured channel data
 * 
 * @param {string} m3uContent - M3U file content
 * @returns {Array} Array of parsed channels
 */
function parseM3U(m3uContent) {
  const lines = m3uContent.split('\n').map(line => line.trim());
  const channels = [];
  let channelCount = 0;
  let currentChannel = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

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

  const uniqueChannels = Array.from(new Map(channels.map(ch => [ch.tvgId, ch])).values());
  logger.debug(`Filtered ${channelCount} M3U entries to ${uniqueChannels.length} unique channels`);
  return uniqueChannels;
}

/**
 * Loads M3U content from an Xtream provider
 * First tries JSON API (player_api.php), falls back to M3U endpoint (get.php)
 *
 * @param {string} baseUrl - Xtream base URL
 * @param {string} username - Xtream username
 * @param {string} password - Xtream password
 * @returns {Promise<string>} M3U content
 */
async function loadXtreamM3U(baseUrl, username, password) {
  const fetch = require('node-fetch');
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  // Try JSON API first (player_api.php) - more reliable, less likely to be blocked by Cloudflare
  try {
    const jsonApiUrl = `${normalizedBaseUrl}player_api.php?username=${username}&password=${password}&action=get_live_streams`;
    logger.info(`Trying Xtream JSON API: ${jsonApiUrl}`);

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
        logger.info(`Successfully fetched ${jsonData.length} channels from Xtream JSON API`);

        // Get categories for proper group names
        let catMap = {};
        try {
          const catUrl = `${normalizedBaseUrl}player_api.php?username=${username}&password=${password}&action=get_live_categories`;
          const catResponse = await fetch(catUrl, {
            timeout: 30000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          });
          if (catResponse.ok) {
            const categories = await catResponse.json();
            if (Array.isArray(categories)) {
              categories.forEach(cat => {
                catMap[cat.category_id] = cat.category_name;
              });
              logger.info(`Loaded ${categories.length} category names`);
            }
          }
        } catch (catError) {
          logger.warn(`Could not fetch categories: ${catError.message}`);
        }

        // Convert JSON to M3U format
        let m3uContent = '#EXTM3U\n';
        jsonData.forEach(ch => {
          const groupTitle = catMap[ch.category_id] || 'Uncategorized';
          const tvgId = ch.epg_channel_id || '';
          const tvgLogo = ch.stream_icon || '';
          m3uContent += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${ch.name}" tvg-logo="${tvgLogo}" group-title="${groupTitle}",${ch.name}\n`;
          m3uContent += `${normalizedBaseUrl}${username}/${password}/${ch.stream_id}.ts\n`;
        });

        logger.info(`Generated M3U content from JSON API: ${Math.round(m3uContent.length / 1024)} KB`);
        return m3uContent;
      }
    }
  } catch (jsonError) {
    logger.warn(`JSON API failed, falling back to M3U: ${jsonError.message}`);
  }

  // Fall back to M3U endpoint
  const xtreamM3uUrl = `${normalizedBaseUrl}get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
  logger.info(`Falling back to M3U endpoint: ${xtreamM3uUrl}`);

  try {
    const response = await fetchURL(xtreamM3uUrl);
    const buffer = await response.arrayBuffer();
    const content = Buffer.from(buffer).toString('utf8');

    // Basic validation - check that it contains #EXTM3U
    if (!content || !content.includes('#EXTM3U')) {
      logger.error(`Invalid M3U content received from ${baseUrl}. First 100 chars: ${content.substring(0, 100)}`);
      throw new Error('Invalid M3U content received from Xtream provider');
    }

    logger.info(`Successfully loaded M3U content from Xtream: ${Math.round(content.length / 1024)} KB`);
    return content;
  } catch (error) {
    logger.error(`Error loading M3U from Xtream: ${error.message}`);
    throw error;
  }
}

/**
 * Matches channels with EPG data
 * 
 * @param {Array} channels - Channels to match
 * @param {Object} xtreamEPG - EPG data from Xtream
 * @param {Object} externalEPG - EPG data from external source
 * @param {Object} matchedChannels - User-provided channel matches
 * @returns {Array} Updated channels with matched EPG
 */
function matchChannels(channels, xtreamEPG, externalEPG, matchedChannels = {}) {
  const epgChannels = { 
    ...(xtreamEPG.channels || []), 
    ...(externalEPG.channels || []) 
  };
  
  const updatedChannels = channels.map(ch => {
    const matchedId = matchedChannels[ch.tvgId] || ch.tvgId;
    const epgChannel = epgChannels.find(epgCh => epgCh.$ && epgCh.$.id === matchedId);
    if (epgChannel) {
      ch.tvgId = matchedId;
    }
    return ch;
  });

  logger.info(`Matched ${Object.keys(matchedChannels).length} channels with EPG`);
  return updatedChannels;
}

/**
 * Generates EPG XML content from channels
 * 
 * @param {Array} channels - Channels to include in EPG
 * @returns {string} XML EPG content
 */
function generateEPG(channels) {
  const xmlBuilder = new xml2js.Builder();
  const epg = {
    tv: {
      channel: channels.map(ch => ({
        $: { id: ch.tvgId },
        'display-name': [ch.name]
      })),
      programme: []
    }
  };

  return xmlBuilder.buildObject(epg);
}

/**
 * Generates M3U content from channels
 * 
 * @param {Array} channels - Channels to include in M3U
 * @returns {string} M3U content
 */
function generateM3U(channels) {
  return `#EXTM3U\n${channels.map(ch => 
    `#EXTINF:-1 tvg-id="${ch.tvgId}" tvg-name="${ch.name}" group-title="${ch.groupTitle}",${ch.name}\n${ch.url}`
  ).join('\n')}`;
}

module.exports = {
  parseM3U,
  loadXtreamM3U,
  matchChannels,
  generateEPG,
  generateM3U
};