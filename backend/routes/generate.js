// routes/generate.js
/**
 * Generate Route - handles generating new XTREAM credentials
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../config/logger');
const { generateCredentials } = require('../utils/storageUtils');
const { UPLOADS_DIR } = require('../config/constants');
const { authMiddleware } = require('../middleware/authMiddleware');
const postgresService = require('../services/postgresService');
const liveEventsService = require('../services/liveEventsService');
const publishedEpgService = require('../services/publishedEpgService');
const { generateXmltvFromDatabase } = require('../utils/xmltvGenerator');

// Module loaded timestamp - this executes IMMEDIATELY when module is required
const MODULE_LOAD_TIME = new Date().toISOString();
logger.debug(`generate.js module loaded at ${MODULE_LOAD_TIME}`);

/**
 * Get the local network IP address of the server
 * (Same logic as /api/network-info endpoint used for Chromecast)
 */
function getServerIpAddress() {
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];

  // Find all non-internal IPv4 addresses
  Object.keys(networkInterfaces).forEach(interfaceName => {
    networkInterfaces[interfaceName].forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });

  // Return the first valid address, or localhost if none found
  return addresses.length > 0 ? addresses[0] : 'localhost';
}

/**
 * Detect if program content is actually LIVE (sports, live events)
 * Uses category and title pattern matching
 */
function detectLiveContent(title, category) {
  if (!title) return false;

  const titleLower = title.toLowerCase();
  const categoryLower = (category || '').toLowerCase();

  // Skip if title already has LIVE prefix (avoid double prefix)
  // Check for both regular "Live:" and small caps "ʟɪᴠᴇ"
  if (/^live:?\s/i.test(title) || title.startsWith('ʟɪᴠᴇ ')) {
    return false;
  }

  // Check title for live sports patterns - STRONGEST INDICATOR
  const livePatterns = [
    / vs\.?\s/i,          // "Team A vs Team B" or "Team A vs. Team B"
    / @ /i,               // "Team A @ Team B"
  ];

  const hasVsPattern = livePatterns.some(pattern => pattern.test(title));

  // Strong indicator - if has vs/@ pattern, it's very likely live sports
  if (hasVsPattern) {
    // But exclude if it says "next game" or similar
    const excludeNext = ['next game', 'upcoming', 'scheduled'];
    const hasExcludeNext = excludeNext.some(pattern => titleLower.includes(pattern));
    return !hasExcludeNext;
  }

  // For titles without vs/@ pattern, be more strict
  // Only match if it has sports category AND specific live event keywords
  const sportsCategories = [
    'sport', 'sports', 'live sport'
  ];

  const hasSportsCategory = sportsCategories.some(sport => categoryLower.includes(sport));

  if (hasSportsCategory) {
    // Keywords that indicate it's a live broadcast (not just sports content)
    const liveBroadcastKeywords = [
      'qualifying', 'practice session', 'free practice',
      'championship', 'playoff', 'semifinal', 'quarterfinal', 'final round'
    ];

    const hasLiveBroadcastKeyword = liveBroadcastKeywords.some(keyword => titleLower.includes(keyword));

    // Exclude obvious non-live content
    const excludePatterns = [
      'replay', 'repeat', 'highlights', 'classic', 'rewind',
      'encore', 'recorded', 'best of', 'top 10', 'greatest',
      'next game', 'upcoming', 'documentary', 'news', 'talk show'
    ];

    const isExcluded = excludePatterns.some(pattern => titleLower.includes(pattern));

    return !isExcluded && hasLiveBroadcastKeyword;
  }

  return false;
}

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * GET /api/generate
 * Get all generated XTREAM credentials for the authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get credentials: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get all credentials for this user from PostgreSQL
    const result = await postgresService.query(`
      SELECT
        id,
        username,
        password,
        created_at,
        last_used as last_accessed
      FROM credentials
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    const credentials = result.rows || [];

    // Add URLs to each credential
    const serverIp = getServerIpAddress();
    const port = process.env.PORT || 5001;
    const baseUrl = process.env.BASE_URL || `http://${serverIp}:${port}`;

    const credentialsWithUrls = credentials.map(cred => ({
      ...cred,
      credential_id: cred.username,  // For backwards compatibility with frontend
      xtreamUrl: `${baseUrl}/api/xtream`,
      xtreamEpgUrl: `${baseUrl}/api/xtream/xmltv.php?username=${cred.username}&password=${cred.password}`,
      m3uUrl: `${baseUrl}/api/xtream/get.php?username=${cred.username}&password=${cred.password}&type=m3u_plus&output=ts`
    }));

    res.json({
      credentials: credentialsWithUrls,
      count: credentialsWithUrls.length
    });
  } catch (error) {
    logger.error('Get credentials failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/generate/:credentialId
 * Delete a generated credential
 */
router.delete('/:credentialId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { credentialId } = req.params;

    if (!userId) {
      logger.error('Delete credential: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Delete the credential from PostgreSQL (only if it belongs to this user)
    // Note: PostgreSQL credentials table uses 'username' as unique key, not 'credential_id'
    const result = await postgresService.query(`
      DELETE FROM credentials
      WHERE username = $1 AND user_id = $2
    `, [credentialId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Credential not found or access denied' });
    }

    logger.info(`Deleted credential ${credentialId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Credential deleted successfully'
    });
  } catch (error) {
    logger.error('Delete credential failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/generate
 * Generates new XTREAM credentials based on user's matched channels from database
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Generate: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`Generating XTREAM credentials for user ${userId}`);

    // Get all matched channels for this user from PostgreSQL
    const result = await postgresService.query(`
      SELECT
        m.iptv_channel_id,
        m.epg_channel_id,
        CASE WHEN m.use_dummy_epg THEN 1 ELSE 0 END as use_dummy_epg,
        c.name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        CASE WHEN c.enable_live_prefix THEN 1 ELSE 0 END as enable_live_prefix,
        s.id as source_id,
        s.name as source_name,
        s.url as source_url,
        s.username as source_username,
        s.password as source_password,
        s.type as source_type,
        CASE WHEN s.auto_detect_live THEN 1 ELSE 0 END as auto_detect_live
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `, [userId]);

    const matchedChannels = result.rows;

    if (!matchedChannels || matchedChannels.length === 0) {
      logger.warn(`No matched channels found for user ${userId}`);
      return res.status(400).json({
        error: 'No matched channels found. Please match channels in the Guide first.',
        matchCount: 0
      });
    }

    logger.info(`Found ${matchedChannels.length} matched channels for user ${userId}`);

    // Fetch ALL events from database for LIVE prefix detection (not just currently live)
    // This allows us to pre-generate XMLTV with LIVE prefixes for scheduled events
    const liveEvents = await liveEventsService.getAllEvents();
    logger.info(`Loaded ${liveEvents.length} total events for LIVE prefix detection`);

    // Robust tokenization system for matching
    const STOP_WORDS = new Set(['vs', 'at', 'v', '@', 'the', 'a', 'an', 'and', 'or', 'of', 'game', 'next', 'live', 'team', 'match', 'vs.']);
    const MASCOTS = new Set([
      'aggies', 'anteaters', 'bears', 'bruins', 'bulldogs', 'cardinals', 'cougars', 'crimson', 'tide',
      'ducks', 'eagles', 'falcons', 'gators', 'hawkeyes', 'huskies', 'jayhawks', 'knights', 'lions',
      'longhorns', 'mountaineers', 'musketeers', 'nittany', 'panthers', 'razorbacks', 'rebels',
      'seminoles', 'sooners', 'spartans', 'sun', 'devils', 'tar', 'heels', 'terrapins', 'tigers', 'trojans',
      'utes', 'volunteers', 'wildcats', 'wolverines', 'badgers', 'buckeyes', 'cornhuskers', 'cyclones',
      'fighting', 'irish', 'golden', 'hokies', 'horned', 'frogs', 'hurricanes', 'orange', 'orangemen',
      'red', 'raiders', 'scarlet', 'demon', 'deacons', 'blue', 'gamecocks', 'hoosiers',
      'boilermakers', 'gophers', 'huskers', 'thundering', 'herd', 'mean', 'green', 'hawks',
      'chanticleers', 'ragin', 'cajuns', 'warhawks', 'foxes', 'gaels', 'flames', 'blackhawks',
      'fc', 'cf', 'united', 'city', 'town', 'hotspur', 'wanderers', 'athletic', 'rovers'
    ]);

    // Common 2-letter abbreviations that should be kept (soccer clubs, cities)
    const VALID_SHORT_TOKENS = new Set(['fc', 'ac', 'dc', 'la', 'ny', 'sf', 'kc']);

    // Tokenize text into significant words
    const tokenize = (text) => {
      if (!text) return [];

      // Convert to lowercase, remove punctuation, split into words
      const words = text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
        .split(/\s+/)               // Split on whitespace
        .filter(word => {
          // Keep words with 3+ chars, OR 2-char words in the valid short tokens list
          return (word.length >= 3 || VALID_SHORT_TOKENS.has(word)) && word.length > 0;
        })
        .filter(word => !STOP_WORDS.has(word))  // Remove stop words
        .filter(word => !MASCOTS.has(word))  // Remove mascots
        .filter(word => !/^\d+$/.test(word));  // Remove pure numbers

      return words;
    };

    // Robust token-based matching for live events
    const matchesLiveEvent = (programTitle, channelName, programStartTime, programStopTime) => {

      if (liveEvents.length === 0) {
        return false;
      }

      const titleTokens = tokenize(programTitle);
      const channelTokens = tokenize(channelName);

      // Check if program time overlaps with any live event
      for (const event of liveEvents) {
        const homeTeam = event.home_team || '';
        const awayTeam = event.away_team || '';
        const eventStart = new Date(event.event_start).getTime();
        const eventEnd = new Date(event.event_end).getTime();


        // MUST have true time overlap (not just touching at a boundary)
        const programOverlapsEvent = programStartTime && programStopTime &&
          (programStartTime < eventEnd && programStopTime > eventStart);


        if (!programOverlapsEvent) {
          continue; // Skip if program doesn't air when event is live
        }

        // Tokenize team names
        const homeTokens = tokenize(homeTeam);
        const awayTokens = tokenize(awayTeam);


        // METHOD 1: Token-based title matching
        // Check if significant words from BOTH teams appear in the title
        if (titleTokens.length > 0 && homeTokens.length > 0 && awayTokens.length > 0) {
          // Count how many tokens from each team appear in the title
          const homeMatches = homeTokens.filter(token => titleTokens.includes(token)).length;
          const awayMatches = awayTokens.filter(token => titleTokens.includes(token)).length;


          // Smart threshold: require at least 1 token match, or 50% of tokens for multi-word teams
          // This prevents false matches while still handling variations
          // Examples:
          // - "Chicago" (1 token) -> need 1 match
          // - "UC Davis" (2 tokens) -> need 1 match (50% of 2)
          // - "North Carolina" (2 tokens) -> need 1 match
          // - "Tampa Bay Lightning" (3 tokens after filtering) -> need 2 matches (50% of 3, rounded up)
          const homeThreshold = Math.max(1, Math.ceil(homeTokens.length * 0.5));
          const awayThreshold = Math.max(1, Math.ceil(awayTokens.length * 0.5));


          if (homeMatches >= homeThreshold && awayMatches >= awayThreshold) {
            return true;
          }
        }

        // METHOD 2: Channel-based matching
        // Only apply to dedicated sports channels to avoid false matches on city names
        // (e.g., "FOX PHOENIX" shouldn't match "Green Bay Phoenix" team)
        const isSportsChannel = /\b(nhl|nba|mlb|nfl|espn|sports?|team|hockey|basketball|football|baseball|soccer)\b/i.test(channelName);


        if (isSportsChannel && channelTokens.length > 0) {
          const titleLower = programTitle.toLowerCase();
          // Expanded placeholder detection to catch more variations
          const isPlaceholder = /\b(next\s+game|upcoming|coming\s+up|scheduled|preview|pre-?game|post-?game)\b/i.test(titleLower);


          // Only match if it's not a placeholder program
          if (!isPlaceholder) {
            const homeInChannel = homeTokens.some(token => channelTokens.includes(token));
            const awayInChannel = awayTokens.some(token => channelTokens.includes(token));


            if (homeInChannel || awayInChannel) {
              return true;
            }
          }
        }
      }

      return false;
    };

    // Generate new credentials
    const { username, password } = generateCredentials();

    // Get server info for stream URLs
    const serverIp = getServerIpAddress();
    const port = process.env.PORT || 5001;
    const baseUrl = process.env.BASE_URL || `http://${serverIp}:${port}`;

    // Generate M3U playlist content with proxied stream URLs
    const m3uLines = ['#EXTM3U'];

    matchedChannels.forEach(channel => {
      // Build EXTINF line with channel metadata
      const tvgId = channel.epg_channel_id || '';
      const tvgName = channel.name;
      const tvgLogo = channel.logo || '';
      const groupTitle = channel.group_title || 'Matched Channels';

      m3uLines.push(
        `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${tvgLogo}" group-title="${groupTitle}",${tvgName}`
      );

      // Use proxied stream URL instead of direct URL
      const streamUrl = `${baseUrl}/api/xtream/stream/${encodeURIComponent(channel.iptv_channel_id)}?username=${username}&password=${password}`;
      m3uLines.push(streamUrl);
    });

    const m3uContent = m3uLines.join('\n');

    // Generate EPG XML content for matched channels
    const epgChannelIds = [...new Set(matchedChannels.map(ch => ch.epg_channel_id).filter(Boolean))];

    // Get EPG data from the EPG database
    let epgPrograms = [];
    if (epgChannelIds.length > 0) {
      const placeholders = epgChannelIds.map((_, i) => `$${i + 1}`).join(',');
      const result = await postgresService.query(`
        SELECT
          channel_id,
          title,
          TO_CHAR(start_time AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || ' +0000' as start,
          TO_CHAR(stop_time AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || ' +0000' as stop,
          description,
          categories as category
        FROM epg_programs
        WHERE channel_id IN (${placeholders})
        AND stop_time >= NOW()
        ORDER BY channel_id, start_time
        LIMIT 1000
      `, epgChannelIds);

      epgPrograms = result.rows || [];
      logger.info(`Fetched ${epgPrograms.length} EPG programs for XMLTV generation`);
    }

    // Generate dummy EPG programs for channels with use_dummy_epg=1
    // Note: PostgreSQL CASE returns integer, but pg library might convert to string
    const dummyEpgChannels = matchedChannels.filter(ch => ch.use_dummy_epg == 1 || ch.use_dummy_epg === true);

    if (dummyEpgChannels.length > 0) {
      logger.info(`Generating dummy EPG for ${dummyEpgChannels.length} channels`);

      const now = new Date();
      dummyEpgChannels.forEach(channel => {
        // Generate 7 days of dummy programs (3-hour blocks)
        for (let day = 0; day < 7; day++) {
          for (let hour = 0; hour < 24; hour += 3) {
            const startDate = new Date(now);
            startDate.setDate(startDate.getDate() + day);
            startDate.setHours(hour, 0, 0, 0);

            const stopDate = new Date(startDate);
            stopDate.setHours(stopDate.getHours() + 3);

            // Format as XMLTV timestamp: YYYYMMDDHHMMSS +TZTZ
            const formatXmltvTime = (date) => {
              const pad = (n) => String(n).padStart(2, '0');
              const year = date.getFullYear();
              const month = pad(date.getMonth() + 1);
              const dayNum = pad(date.getDate());
              const hours = pad(date.getHours());
              const minutes = pad(date.getMinutes());
              const seconds = pad(date.getSeconds());

              // Get timezone offset in minutes, then convert to +HHMM format
              const offsetMinutes = -date.getTimezoneOffset(); // Negative because getTimezoneOffset returns negative for positive offsets
              const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
              const offsetMins = Math.abs(offsetMinutes) % 60;
              const offsetSign = offsetMinutes >= 0 ? '+' : '-';
              const offsetStr = `${offsetSign}${pad(offsetHours)}${pad(offsetMins)}`;

              return `${year}${month}${dayNum}${hours}${minutes}${seconds} ${offsetStr}`;
            };

            // Check if this dummy program should have LIVE prefix
            const programStartTime = startDate.getTime();
            const programStopTime = stopDate.getTime();

            const isLiveEvent = matchesLiveEvent(channel.name, channel.name, programStartTime, programStopTime);

            // Apply LIVE prefix if channel has enable_live_prefix and matches a live event
            const shouldAddLivePrefix = (channel.enable_live_prefix == 1 || channel.enable_live_prefix === true) && isLiveEvent;
            const title = shouldAddLivePrefix ? `ʟɪᴠᴇ ${channel.name}` : channel.name;

            epgPrograms.push({
              channel_id: channel.epg_channel_id || `dummy_${channel.iptv_channel_id}`,
              title: title,
              start: formatXmltvTime(startDate),
              stop: formatXmltvTime(stopDate),
              description: `Streaming on ${channel.name}`,
              category: channel.group_title || 'Live TV'
            });
          }
        }
      });
      logger.debug(`Added dummy EPG: ${epgPrograms.length} total programs (real + dummy)`);
    }

    // Save M3U file only (XMLTV is now generated dynamically from database)
    const credentialId = `${userId}_${Date.now()}`;
    const m3uFilePath = path.join(UPLOADS_DIR, `${credentialId}.m3u`);

    fs.writeFileSync(m3uFilePath, m3uContent);

    // Store credentials in PostgreSQL for XTREAM API access
    const credentialResult = await postgresService.query(`
      INSERT INTO credentials
      (user_id, username, password, m3u_file, created_at, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (username) DO UPDATE SET
        password = EXCLUDED.password,
        m3u_file = EXCLUDED.m3u_file,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [userId, username, password, m3uFilePath]);

    const dbCredentialId = credentialResult.rows[0].id;

    // Publish EPG data to database (replaces static XMLTV file for dynamic serving)
    logger.debug(`Publishing EPG to database for credential ${dbCredentialId}`);
    try {
      // Transform epgPrograms to include channel metadata for published_epg table
      const epgProgramsWithMetadata = epgPrograms.map(prog => {
        // Find matching channel info
        const channel = matchedChannels.find(ch =>
          (ch.epg_channel_id && ch.epg_channel_id === prog.channel_id) ||
          (`dummy_${ch.iptv_channel_id}` === prog.channel_id)
        );

        return {
          ...prog,
          iptv_channel_id: channel ? channel.iptv_channel_id : prog.channel_id,
          epg_channel_id: prog.channel_id,
          channel_name: channel ? channel.name : prog.title,
          logo_url: channel ? channel.logo : null
        };
      });

      await publishedEpgService.publishEpgForCredential(
        dbCredentialId,
        userId,
        matchedChannels,
        epgProgramsWithMetadata
      );
      logger.info(`Successfully published ${epgProgramsWithMetadata.length} EPG programs to database`);
    } catch (publishError) {
      logger.warn(`Error publishing EPG to database, falling back to XMLTV file: ${publishError.message}`);
      // Continue anyway - XMLTV file is still written as fallback
    }

    // XTREAM API server URL (base URL without credentials)
    const xtreamServerUrl = `${baseUrl}/api/xtream`;

    // Full M3U and EPG URLs (for reference/download)
    const m3uUrl = `${baseUrl}/api/xtream/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    const epgUrl = `${baseUrl}/api/xtream/xmltv.php?username=${username}&password=${password}`;

    logger.debug(`Using base URL: ${baseUrl} (server IP: ${serverIp})`);
    logger.info(`Generated XTREAM credentials for user ${userId}: ${matchedChannels.length} channels`);

    res.json({
      xtreamUrl: xtreamServerUrl,      // Base XTREAM server URL
      xtreamEpgUrl: epgUrl,             // EPG URL with credentials
      m3uUrl: m3uUrl,                   // Direct M3U URL (for download)
      username,
      password,
      channelCount: matchedChannels.length,
      downloadUrl: `/api/download/${credentialId}`,
      notes: `Generated with ${matchedChannels.length} matched channels`
    });
  } catch (error) {
    logger.error('Generate failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/generate/update-all
 * Updates all existing XTREAM credentials for the user with current matched channels
 */
router.post('/update-all', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Update all: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`Updating all XTREAM credentials for user ${userId}`);

    // Get all existing credentials for this user from PostgreSQL
    const credResult = await postgresService.query(`
      SELECT id, username, password, m3u_file
      FROM credentials
      WHERE user_id = $1
    `, [userId]);

    const existingCredentials = credResult.rows || [];

    if (existingCredentials.length === 0) {
      logger.warn(`No existing credentials found for user ${userId}`);
      return res.status(400).json({
        error: 'No existing credentials to update. Create new credentials from the Credentials tab first.',
        updatedCount: 0
      });
    }

    logger.info(`Found ${existingCredentials.length} credentials to update for user ${userId}`);

    // Get all matched channels for this user from PostgreSQL
    const result2 = await postgresService.query(`
      SELECT
        m.iptv_channel_id,
        m.epg_channel_id,
        CASE WHEN m.use_dummy_epg THEN 1 ELSE 0 END as use_dummy_epg,
        c.name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        CASE WHEN c.enable_live_prefix THEN 1 ELSE 0 END as enable_live_prefix,
        s.id as source_id,
        s.name as source_name,
        s.url as source_url,
        s.username as source_username,
        s.password as source_password,
        s.type as source_type,
        CASE WHEN s.auto_detect_live THEN 1 ELSE 0 END as auto_detect_live
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `, [userId]);

    const matchedChannels = result2.rows;

    if (!matchedChannels || matchedChannels.length === 0) {
      logger.warn(`No matched channels found for user ${userId}`);
      return res.status(400).json({
        error: 'No matched channels found. Please match channels in the Guide first.',
        matchCount: 0
      });
    }

    // Fetch ALL events from database for LIVE prefix detection (not just currently live)
    // This allows us to pre-generate XMLTV with LIVE prefixes for scheduled events
    const liveEvents = await liveEventsService.getAllEvents();
    logger.info(`Loaded ${liveEvents.length} total events for LIVE prefix detection`);

    // Robust tokenization system for matching
    const STOP_WORDS = new Set(['vs', 'at', 'v', '@', 'the', 'a', 'an', 'and', 'or', 'of', 'game', 'next', 'live', 'team', 'match', 'vs.']);
    const MASCOTS = new Set([
      'aggies', 'anteaters', 'bears', 'bruins', 'bulldogs', 'cardinals', 'cougars', 'crimson', 'tide',
      'ducks', 'eagles', 'falcons', 'gators', 'hawkeyes', 'huskies', 'jayhawks', 'knights', 'lions',
      'longhorns', 'mountaineers', 'musketeers', 'nittany', 'panthers', 'razorbacks', 'rebels',
      'seminoles', 'sooners', 'spartans', 'sun', 'devils', 'tar', 'heels', 'terrapins', 'tigers', 'trojans',
      'utes', 'volunteers', 'wildcats', 'wolverines', 'badgers', 'buckeyes', 'cornhuskers', 'cyclones',
      'fighting', 'irish', 'golden', 'hokies', 'horned', 'frogs', 'hurricanes', 'orange', 'orangemen',
      'red', 'raiders', 'scarlet', 'demon', 'deacons', 'blue', 'gamecocks', 'hoosiers',
      'boilermakers', 'gophers', 'huskers', 'thundering', 'herd', 'mean', 'green', 'hawks',
      'chanticleers', 'ragin', 'cajuns', 'warhawks', 'foxes', 'gaels', 'flames', 'blackhawks',
      'fc', 'cf', 'united', 'city', 'town', 'hotspur', 'wanderers', 'athletic', 'rovers'
    ]);

    // Common 2-letter abbreviations that should be kept (soccer clubs, cities)
    const VALID_SHORT_TOKENS = new Set(['fc', 'ac', 'dc', 'la', 'ny', 'sf', 'kc']);

    // Tokenize text into significant words
    const tokenize = (text) => {
      if (!text) return [];

      // Convert to lowercase, remove punctuation, split into words
      const words = text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
        .split(/\s+/)               // Split on whitespace
        .filter(word => {
          // Keep words with 3+ chars, OR 2-char words in the valid short tokens list
          return (word.length >= 3 || VALID_SHORT_TOKENS.has(word)) && word.length > 0;
        })
        .filter(word => !STOP_WORDS.has(word))  // Remove stop words
        .filter(word => !MASCOTS.has(word))  // Remove mascots
        .filter(word => !/^\d+$/.test(word));  // Remove pure numbers

      return words;
    };

    // Robust token-based matching for live events
    const matchesLiveEvent = (programTitle, channelName, programStartTime, programStopTime) => {

      if (liveEvents.length === 0) {
        return false;
      }

      const titleTokens = tokenize(programTitle);
      const channelTokens = tokenize(channelName);

      // Check if program time overlaps with any live event
      for (const event of liveEvents) {
        const homeTeam = event.home_team || '';
        const awayTeam = event.away_team || '';
        const eventStart = new Date(event.event_start).getTime();
        const eventEnd = new Date(event.event_end).getTime();


        // MUST have true time overlap (not just touching at a boundary)
        const programOverlapsEvent = programStartTime && programStopTime &&
          (programStartTime < eventEnd && programStopTime > eventStart);


        if (!programOverlapsEvent) {
          continue; // Skip if program doesn't air when event is live
        }

        // Tokenize team names
        const homeTokens = tokenize(homeTeam);
        const awayTokens = tokenize(awayTeam);


        // METHOD 1: Token-based title matching
        // Check if significant words from BOTH teams appear in the title
        if (titleTokens.length > 0 && homeTokens.length > 0 && awayTokens.length > 0) {
          // Count how many tokens from each team appear in the title
          const homeMatches = homeTokens.filter(token => titleTokens.includes(token)).length;
          const awayMatches = awayTokens.filter(token => titleTokens.includes(token)).length;


          // Smart threshold: require at least 1 token match, or 50% of tokens for multi-word teams
          // This prevents false matches while still handling variations
          // Examples:
          // - "Chicago" (1 token) -> need 1 match
          // - "UC Davis" (2 tokens) -> need 1 match (50% of 2)
          // - "North Carolina" (2 tokens) -> need 1 match
          // - "Tampa Bay Lightning" (3 tokens after filtering) -> need 2 matches (50% of 3, rounded up)
          const homeThreshold = Math.max(1, Math.ceil(homeTokens.length * 0.5));
          const awayThreshold = Math.max(1, Math.ceil(awayTokens.length * 0.5));


          if (homeMatches >= homeThreshold && awayMatches >= awayThreshold) {
            return true;
          }
        }

        // METHOD 2: Channel-based matching
        // Only apply to dedicated sports channels to avoid false matches on city names
        // (e.g., "FOX PHOENIX" shouldn't match "Green Bay Phoenix" team)
        const isSportsChannel = /\b(nhl|nba|mlb|nfl|espn|sports?|team|hockey|basketball|football|baseball|soccer)\b/i.test(channelName);


        if (isSportsChannel && channelTokens.length > 0) {
          const titleLower = programTitle.toLowerCase();
          // Expanded placeholder detection to catch more variations
          const isPlaceholder = /\b(next\s+game|upcoming|coming\s+up|scheduled|preview|pre-?game|post-?game)\b/i.test(titleLower);


          // Only match if it's not a placeholder program
          if (!isPlaceholder) {
            const homeInChannel = homeTokens.some(token => channelTokens.includes(token));
            const awayInChannel = awayTokens.some(token => channelTokens.includes(token));


            if (homeInChannel || awayInChannel) {
              return true;
            }
          }
        }
      }

      return false;
    };

    logger.info(`Found ${matchedChannels.length} matched channels for user ${userId}`);

    // Get server info for stream URLs
    const serverIp = getServerIpAddress();
    const port = process.env.PORT || 5001;
    const baseUrl = process.env.BASE_URL || `http://${serverIp}:${port}`;

    // Update each credential
    let updatedCount = 0;
    const updateErrors = [];
    for (const cred of existingCredentials) {
      try {
        logger.debug(`Attempting to update credential ${cred.credential_id}...`);
        // Generate M3U content
        const m3uLines = ['#EXTM3U'];
        matchedChannels.forEach(channel => {
          const tvgId = channel.epg_channel_id || '';
          const tvgName = channel.name;
          const tvgLogo = channel.logo || '';
          const groupTitle = channel.group_title || 'Matched Channels';

          m3uLines.push(
            `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${tvgLogo}" group-title="${groupTitle}",${tvgName}`
          );

          const streamUrl = `${baseUrl}/api/xtream/stream/${encodeURIComponent(channel.iptv_channel_id)}?username=${cred.username}&password=${cred.password}`;
          m3uLines.push(streamUrl);
        });
        const m3uContent = m3uLines.join('\n');

        // Generate EPG XML content
        const epgChannelIds = [...new Set(matchedChannels.map(ch => ch.epg_channel_id).filter(Boolean))];

        let epgPrograms = [];
        if (epgChannelIds.length > 0) {
          const placeholders = epgChannelIds.map((_, i) => `$${i + 1}`).join(',');
          const result = await postgresService.query(`
            SELECT
              channel_id,
              title,
              TO_CHAR(start_time AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || ' +0000' as start,
              TO_CHAR(stop_time AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || ' +0000' as stop,
              description,
              categories as category
            FROM epg_programs
            WHERE channel_id IN (${placeholders})
            AND stop_time >= NOW()
            ORDER BY channel_id, start_time
            LIMIT 1000
          `, epgChannelIds);

          epgPrograms = result.rows || [];
        }

        // Generate dummy EPG programs for channels with use_dummy_epg=1
        // Note: PostgreSQL CASE returns integer, but pg library might convert to string
        const dummyEpgChannels = matchedChannels.filter(ch => ch.use_dummy_epg == 1 || ch.use_dummy_epg === true);

        if (dummyEpgChannels.length > 0) {
          logger.debug(`Generating dummy EPG for ${dummyEpgChannels.length} channels`);

          const now = new Date();
          dummyEpgChannels.forEach(channel => {
            // Generate 7 days of dummy programs (3-hour blocks)
            for (let day = 0; day < 7; day++) {
              for (let hour = 0; hour < 24; hour += 3) {
                const startDate = new Date(now);
                startDate.setDate(startDate.getDate() + day);
                startDate.setHours(hour, 0, 0, 0);

                const stopDate = new Date(startDate);
                stopDate.setHours(stopDate.getHours() + 3);

                // Format as XMLTV timestamp: YYYYMMDDHHMMSS +TZTZ
                const formatXmltvTime = (date) => {
                  const pad = (n) => String(n).padStart(2, '0');
                  const year = date.getFullYear();
                  const month = pad(date.getMonth() + 1);
                  const dayNum = pad(date.getDate());
                  const hours = pad(date.getHours());
                  const minutes = pad(date.getMinutes());
                  const seconds = pad(date.getSeconds());

                  // Get timezone offset in minutes, then convert to +HHMM format
                  const offsetMinutes = -date.getTimezoneOffset(); // Negative because getTimezoneOffset returns negative for positive offsets
                  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
                  const offsetMins = Math.abs(offsetMinutes) % 60;
                  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
                  const offsetStr = `${offsetSign}${pad(offsetHours)}${pad(offsetMins)}`;

                  return `${year}${month}${dayNum}${hours}${minutes}${seconds} ${offsetStr}`;
                };

                // Check if this dummy program should have LIVE prefix
                const programStartTime = startDate.getTime();
                const programStopTime = stopDate.getTime();
                const isLiveEvent = matchesLiveEvent(channel.name, channel.name, programStartTime, programStopTime);

                // Apply LIVE prefix if channel has enable_live_prefix and matches a live event
                const shouldAddLivePrefix = (channel.enable_live_prefix == 1 || channel.enable_live_prefix === true) && isLiveEvent;
                const title = shouldAddLivePrefix ? `ʟɪᴠᴇ ${channel.name}` : channel.name;

                epgPrograms.push({
                  channel_id: channel.epg_channel_id || `dummy_${channel.iptv_channel_id}`,
                  title: title,
                  start: formatXmltvTime(startDate),
                  stop: formatXmltvTime(stopDate),
                  description: `Streaming on ${channel.name}`,
                  category: channel.group_title || 'Live TV'
                });
              }
            }
          });
          logger.debug(`Added dummy EPG: ${epgPrograms.length} total programs (real + dummy)`);
        }

        // Update M3U file only (XMLTV is now generated dynamically from database)
        fs.writeFileSync(cred.m3u_file, m3uContent);

        // Publish EPG data to database (replaces static XMLTV file for dynamic serving)
        logger.debug(`Publishing EPG to database for credential ${cred.id}`);
        try {
          // Transform epgPrograms to include channel metadata for published_epg table
          const epgProgramsWithMetadata = epgPrograms.map(prog => {
            // Find matching channel info
            const channel = matchedChannels.find(ch =>
              (ch.epg_channel_id && ch.epg_channel_id === prog.channel_id) ||
              (`dummy_${ch.iptv_channel_id}` === prog.channel_id)
            );

            return {
              ...prog,
              iptv_channel_id: channel ? channel.iptv_channel_id : prog.channel_id,
              epg_channel_id: prog.channel_id,
              channel_name: channel ? channel.name : prog.title,
              logo_url: channel ? channel.logo : null
            };
          });

          await publishedEpgService.publishEpgForCredential(
            cred.id,
            userId,
            matchedChannels,
            epgProgramsWithMetadata
          );
          logger.info(`Successfully published ${epgProgramsWithMetadata.length} EPG programs to database for credential ${cred.id}`);
        } catch (publishError) {
          logger.error(`Error publishing EPG to database for credential ${cred.id}: ${publishError.message}`);
          // Continue anyway - XMLTV file is still written as fallback
        }

        // Update database record in PostgreSQL
        await postgresService.query(`
          UPDATE credentials
          SET updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [cred.id]);

        updatedCount++;
        logger.info(`Successfully updated credential ${cred.credential_id} for user ${userId}`);
      } catch (error) {
        logger.error(`Error updating credential ${cred.credential_id}:`, error);
        updateErrors.push({
          credential: cred.credential_id,
          error: error.message,
          stack: error.stack
        });
      }
    }

    logger.info(`Update summary: ${updatedCount} succeeded, ${updateErrors.length} failed`);

    logger.info(`Successfully updated ${updatedCount} credentials for user ${userId}`);

    if (updatedCount === 0) {
      logger.warn(`No credentials were actually updated for user ${userId}`);
      const errorDetails = updateErrors.length > 0
        ? `Errors: ${updateErrors.map(e => e.error).join(', ')}`
        : 'Please check your credentials in the Credentials tab.';
      return res.status(400).json({
        success: false,
        error: `No credentials were updated. ${errorDetails}`,
        updatedCount: 0,
        errors: updateErrors
      });
    }

    res.json({
      success: true,
      updatedCount,
      channelCount: matchedChannels.length,
      message: `Updated ${updatedCount} credential(s) with ${matchedChannels.length} channels`
    });
  } catch (error) {
    logger.error('Update all failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
