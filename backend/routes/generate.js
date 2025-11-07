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
const iptvDatabaseService = require('../services/iptvDatabaseService');
const liveEventsService = require('../services/liveEventsService');

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

    const db = await iptvDatabaseService.connect();

    // Get all credentials for this user
    const credentials = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          id,
          username,
          password,
          credential_id,
          channel_count,
          created_at,
          last_accessed
        FROM generated_credentials
        WHERE user_id = ?
        ORDER BY created_at DESC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    // Add URLs to each credential
    const serverIp = getServerIpAddress();
    const port = process.env.PORT || 5001;
    const baseUrl = process.env.BASE_URL || `http://${serverIp}:${port}`;

    const credentialsWithUrls = credentials.map(cred => ({
      ...cred,
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

    const db = await iptvDatabaseService.connect();

    // Delete the credential (only if it belongs to this user)
    const result = await new Promise((resolve, reject) => {
      db.run(`
        DELETE FROM generated_credentials
        WHERE credential_id = ? AND user_id = ?
      `, [credentialId, userId], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    if (result === 0) {
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

    // Connect to database
    const db = await iptvDatabaseService.connect();

    // Get all matched channels for this user from the database
    const matchedChannels = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          m.iptv_channel_id,
          m.iptv_channel_name,
          m.epg_channel_id,
          m.epg_channel_name,
          m.epg_source_name,
          m.epg_source_id,
          m.use_dummy_epg,
          c.name,
          c.logo,
          c.url,
          c.group_title,
          c.enable_live_prefix,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          s.username as source_username,
          s.password as source_password,
          s.type as source_type,
          s.auto_detect_live
        FROM epg_matches m
        JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE m.user_id = ?
        ORDER BY c.name
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (!matchedChannels || matchedChannels.length === 0) {
      logger.warn(`No matched channels found for user ${userId}`);
      return res.status(400).json({
        error: 'No matched channels found. Please match channels in the Guide first.',
        matchCount: 0
      });
    }

    logger.info(`Found ${matchedChannels.length} matched channels for user ${userId}`);

    // Fetch currently live events from database for LIVE prefix detection
    const liveEvents = await liveEventsService.getCurrentlyLiveEvents();
    logger.info(`Loaded ${liveEvents.length} currently live events for LIVE prefix detection`);

    // Helper function to check if program title matches any live event
    const matchesLiveEvent = (programTitle) => {
      if (!programTitle || liveEvents.length === 0) return false;

      const titleLower = programTitle.toLowerCase();

      // Check if program title contains both team names from any live event
      for (const event of liveEvents) {
        const homeTeamLower = (event.home_team || '').toLowerCase();
        const awayTeamLower = (event.away_team || '').toLowerCase();

        if (homeTeamLower && awayTeamLower &&
            titleLower.includes(homeTeamLower) &&
            titleLower.includes(awayTeamLower)) {
          return true;
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
      const tvgName = channel.name || channel.iptv_channel_name;
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
    const epgDbPath = path.join(__dirname, '../data/epg.db');
    const sqlite3 = require('sqlite3').verbose();
    const epgDb = new sqlite3.Database(epgDbPath);

    let epgPrograms = await new Promise((resolve, reject) => {
      if (epgChannelIds.length === 0) {
        return resolve([]);
      }

      const placeholders = epgChannelIds.map(() => '?').join(',');
      epgDb.all(`
        SELECT channel_id, title, start, stop, description, category
        FROM programs
        WHERE channel_id IN (${placeholders})
        AND substr(stop, 1, 14) >= strftime('%Y%m%d%H%M%S', 'now')
        ORDER BY channel_id, start
        LIMIT 1000
      `, epgChannelIds, (err, rows) => {
        if (err) {
          logger.warn(`Error fetching EPG data: ${err.message}`);
          resolve([]);
        } else {
          logger.info(`Fetched ${rows ? rows.length : 0} EPG programs for XMLTV generation`);
          resolve(rows || []);
        }
      });
    });

    epgDb.close();

    // Generate dummy EPG programs for channels with use_dummy_epg=1
    const dummyEpgChannels = matchedChannels.filter(ch => ch.use_dummy_epg === 1);
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
              return `${year}${month}${dayNum}${hours}${minutes}${seconds} +0000`;
            };

            epgPrograms.push({
              channel_id: channel.epg_channel_id || `dummy_${channel.iptv_channel_id}`,
              title: channel.name || channel.iptv_channel_name,
              start: formatXmltvTime(startDate),
              stop: formatXmltvTime(stopDate),
              description: `Streaming on ${channel.name || channel.iptv_channel_name}`,
              category: channel.group_title || 'Live TV'
            });
          }
        }
      });
      logger.info(`Added ${epgPrograms.length} total programs (real + dummy)`);
    }

    // Build XMLTV format EPG
    const xmlLines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
      '<tv generator-info-name="IPTV EPG Matcher">'
    ];

    // Add channel definitions
    const uniqueChannelIds = new Set();
    matchedChannels.forEach(ch => {
      // Add regular EPG channel definitions
      if (ch.epg_channel_id && !uniqueChannelIds.has(ch.epg_channel_id)) {
        uniqueChannelIds.add(ch.epg_channel_id);
        xmlLines.push(`  <channel id="${escapeXml(ch.epg_channel_id)}">`);
        xmlLines.push(`    <display-name>${escapeXml(ch.name || ch.epg_channel_name)}</display-name>`);
        if (ch.logo) {
          xmlLines.push(`    <icon src="${escapeXml(ch.logo)}" />`);
        }
        xmlLines.push(`  </channel>`);
      }

      // Add dummy EPG channel definitions for channels without EPG match
      if (ch.use_dummy_epg === 1 && !ch.epg_channel_id) {
        const dummyChannelId = `dummy_${ch.iptv_channel_id}`;
        if (!uniqueChannelIds.has(dummyChannelId)) {
          uniqueChannelIds.add(dummyChannelId);
          xmlLines.push(`  <channel id="${escapeXml(dummyChannelId)}">`);
          xmlLines.push(`    <display-name>${escapeXml(ch.name || ch.iptv_channel_name)}</display-name>`);
          if (ch.logo) {
            xmlLines.push(`    <icon src="${escapeXml(ch.logo)}" />`);
          }
          xmlLines.push(`  </channel>`);
        }
      }
    });

    // Create a map of epg_channel_id to channel settings for LIVE prefix feature
    const channelSettings = {};
    matchedChannels.forEach(ch => {
      const channelId = ch.epg_channel_id || (ch.use_dummy_epg === 1 ? `dummy_${ch.iptv_channel_id}` : null);
      if (channelId) {
        channelSettings[channelId] = {
          enableLivePrefix: ch.enable_live_prefix === 1,
          autoDetectLive: ch.auto_detect_live === 1
        };
      }
    });

    // Add program data
    const nowTimestamp = Date.now();
    epgPrograms.forEach(prog => {
      // Parse XMLTV timestamp to check if program is currently airing
      const parseXmltvTime = (xmltvTime) => {
        // Format: YYYYMMDDHHMMSS +TZTZ
        const dateStr = xmltvTime.substring(0, 14);
        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(4, 6)) - 1;
        const day = parseInt(dateStr.substring(6, 8));
        const hour = parseInt(dateStr.substring(8, 10));
        const minute = parseInt(dateStr.substring(10, 12));
        const second = parseInt(dateStr.substring(12, 14));
        return new Date(Date.UTC(year, month, day, hour, minute, second)).getTime();
      };

      const startTime = parseXmltvTime(prog.start);
      const stopTime = parseXmltvTime(prog.stop);
      const isCurrentlyAiring = nowTimestamp >= startTime && nowTimestamp < stopTime;

      // Check if program matches a currently live event in database
      const isLiveEvent = isCurrentlyAiring && matchesLiveEvent(prog.title);

      // Check if LIVE prefix should be added
      const settings = channelSettings[prog.channel_id];
      const shouldAddLivePrefix = settings && isCurrentlyAiring &&
        (settings.enableLivePrefix || (settings.autoDetectLive && isLiveEvent));

      // Prepend small caps "LIVE" to title if applicable
      const title = shouldAddLivePrefix
        ? `ʟɪᴠᴇ ${prog.title || 'Unknown'}`
        : prog.title || 'Unknown';

      xmlLines.push(`  <programme start="${prog.start}" stop="${prog.stop}" channel="${escapeXml(prog.channel_id)}">`);
      xmlLines.push(`    <title>${escapeXml(title)}</title>`);
      if (prog.description) {
        xmlLines.push(`    <desc>${escapeXml(prog.description)}</desc>`);
      }
      if (prog.category) {
        xmlLines.push(`    <category>${escapeXml(prog.category)}</category>`);
      }
      xmlLines.push(`  </programme>`);
    });

    xmlLines.push('</tv>');
    const epgContent = xmlLines.join('\n');

    // Save generated files
    const credentialId = `${userId}_${Date.now()}`;
    const m3uFilePath = path.join(UPLOADS_DIR, `${credentialId}.m3u`);
    const epgFilePath = path.join(UPLOADS_DIR, `${credentialId}.xml`);

    fs.writeFileSync(m3uFilePath, m3uContent);
    fs.writeFileSync(epgFilePath, epgContent);

    // Store credentials in database for XTREAM API access
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT OR REPLACE INTO generated_credentials
        (user_id, username, password, credential_id, m3u_file, epg_file, channel_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [userId, username, password, credentialId, m3uFilePath, epgFilePath, matchedChannels.length], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // XTREAM API server URL (base URL without credentials)
    const xtreamServerUrl = `${baseUrl}/api/xtream`;

    // Full M3U and EPG URLs (for reference/download)
    const m3uUrl = `${baseUrl}/api/xtream/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    const epgUrl = `${baseUrl}/api/xtream/xmltv.php?username=${username}&password=${password}`;

    logger.info(`Using base URL: ${baseUrl} (server IP: ${serverIp})`);
    logger.info(`Generated XTREAM credentials for user ${userId}: ${matchedChannels.length} channels, username=${username}`);

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

    const db = await iptvDatabaseService.connect();

    // Get all existing credentials for this user
    const existingCredentials = await new Promise((resolve, reject) => {
      db.all(`
        SELECT id, username, password, credential_id, m3u_file, epg_file
        FROM generated_credentials
        WHERE user_id = ?
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    if (existingCredentials.length === 0) {
      logger.warn(`No existing credentials found for user ${userId}`);
      return res.status(400).json({
        error: 'No existing credentials to update. Create new credentials from the Credentials tab first.',
        updatedCount: 0
      });
    }

    logger.info(`Found ${existingCredentials.length} credentials to update for user ${userId}`);

    // Get all matched channels for this user
    const matchedChannels = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          m.iptv_channel_id,
          m.iptv_channel_name,
          m.epg_channel_id,
          m.epg_channel_name,
          m.epg_source_name,
          m.epg_source_id,
          m.use_dummy_epg,
          c.name,
          c.logo,
          c.url,
          c.group_title,
          c.enable_live_prefix,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          s.username as source_username,
          s.password as source_password,
          s.type as source_type,
          s.auto_detect_live
        FROM epg_matches m
        JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE m.user_id = ?
        ORDER BY c.name
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (!matchedChannels || matchedChannels.length === 0) {
      logger.warn(`No matched channels found for user ${userId}`);
      return res.status(400).json({
        error: 'No matched channels found. Please match channels in the Guide first.',
        matchCount: 0
      });
    }

    // Fetch currently live events from database for LIVE prefix detection
    const liveEvents = await liveEventsService.getCurrentlyLiveEvents();
    logger.info(`Loaded ${liveEvents.length} currently live events for LIVE prefix detection`);

    // Helper function to check if program title matches any live event
    const matchesLiveEvent = (programTitle) => {
      if (!programTitle || liveEvents.length === 0) return false;

      const titleLower = programTitle.toLowerCase();

      // Check if program title contains both team names from any live event
      for (const event of liveEvents) {
        const homeTeamLower = (event.home_team || '').toLowerCase();
        const awayTeamLower = (event.away_team || '').toLowerCase();

        if (homeTeamLower && awayTeamLower &&
            titleLower.includes(homeTeamLower) &&
            titleLower.includes(awayTeamLower)) {
          return true;
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
        logger.info(`Attempting to update credential ${cred.credential_id}...`);
        // Generate M3U content
        const m3uLines = ['#EXTM3U'];
        matchedChannels.forEach(channel => {
          const tvgId = channel.epg_channel_id || '';
          const tvgName = channel.name || channel.iptv_channel_name;
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

        const epgDbPath = path.join(__dirname, '../data/epg.db');
        const sqlite3 = require('sqlite3').verbose();
        const epgDb = new sqlite3.Database(epgDbPath);

        let epgPrograms = await new Promise((resolve, reject) => {
          if (epgChannelIds.length === 0) {
            return resolve([]);
          }

          const placeholders = epgChannelIds.map(() => '?').join(',');
          epgDb.all(`
            SELECT channel_id, title, start, stop, description, category
            FROM programs
            WHERE channel_id IN (${placeholders})
            AND substr(stop, 1, 14) >= strftime('%Y%m%d%H%M%S', 'now')
            ORDER BY channel_id, start
            LIMIT 1000
          `, epgChannelIds, (err, rows) => {
            if (err) {
              logger.warn(`Error fetching EPG data: ${err.message}`);
              resolve([]);
            } else {
              resolve(rows || []);
            }
          });
        });

        epgDb.close();

        // Generate dummy EPG programs for channels with use_dummy_epg=1
        const dummyEpgChannels = matchedChannels.filter(ch => ch.use_dummy_epg === 1);
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
                  return `${year}${month}${dayNum}${hours}${minutes}${seconds} +0000`;
                };

                epgPrograms.push({
                  channel_id: channel.epg_channel_id || `dummy_${channel.iptv_channel_id}`,
                  title: channel.name || channel.iptv_channel_name,
                  start: formatXmltvTime(startDate),
                  stop: formatXmltvTime(stopDate),
                  description: `Streaming on ${channel.name || channel.iptv_channel_name}`,
                  category: channel.group_title || 'Live TV'
                });
              }
            }
          });
          logger.info(`Added ${epgPrograms.length} total programs (real + dummy)`);
        }

        // Build XMLTV
        const xmlLines = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
          '<tv generator-info-name="IPTV EPG Matcher">'
        ];

        const uniqueChannelIds = new Set();
        matchedChannels.forEach(ch => {
          // Add regular EPG channel definitions
          if (ch.epg_channel_id && !uniqueChannelIds.has(ch.epg_channel_id)) {
            uniqueChannelIds.add(ch.epg_channel_id);
            xmlLines.push(`  <channel id="${escapeXml(ch.epg_channel_id)}">`);
            xmlLines.push(`    <display-name>${escapeXml(ch.name || ch.epg_channel_name)}</display-name>`);
            if (ch.logo) {
              xmlLines.push(`    <icon src="${escapeXml(ch.logo)}" />`);
            }
            xmlLines.push(`  </channel>`);
          }

          // Add dummy EPG channel definitions for channels without EPG match
          if (ch.use_dummy_epg === 1 && !ch.epg_channel_id) {
            const dummyChannelId = `dummy_${ch.iptv_channel_id}`;
            if (!uniqueChannelIds.has(dummyChannelId)) {
              uniqueChannelIds.add(dummyChannelId);
              xmlLines.push(`  <channel id="${escapeXml(dummyChannelId)}">`);
              xmlLines.push(`    <display-name>${escapeXml(ch.name || ch.iptv_channel_name)}</display-name>`);
              if (ch.logo) {
                xmlLines.push(`    <icon src="${escapeXml(ch.logo)}" />`);
              }
              xmlLines.push(`  </channel>`);
            }
          }
        });

        // Create a map of epg_channel_id to channel settings for LIVE prefix feature
        const channelSettings = {};
        matchedChannels.forEach(ch => {
          const channelId = ch.epg_channel_id || (ch.use_dummy_epg === 1 ? `dummy_${ch.iptv_channel_id}` : null);
          if (channelId) {
            channelSettings[channelId] = {
              enableLivePrefix: ch.enable_live_prefix === 1,
              autoDetectLive: ch.auto_detect_live === 1
            };
          }
        });

        // Add program data with LIVE prefix support
        const nowTimestamp = Date.now();
        epgPrograms.forEach(prog => {
          // Parse XMLTV timestamp to check if program is currently airing
          const parseXmltvTime = (xmltvTime) => {
            // Format: YYYYMMDDHHMMSS +TZTZ
            const dateStr = xmltvTime.substring(0, 14);
            const year = parseInt(dateStr.substring(0, 4));
            const month = parseInt(dateStr.substring(4, 6)) - 1;
            const day = parseInt(dateStr.substring(6, 8));
            const hour = parseInt(dateStr.substring(8, 10));
            const minute = parseInt(dateStr.substring(10, 12));
            const second = parseInt(dateStr.substring(12, 14));
            return new Date(Date.UTC(year, month, day, hour, minute, second)).getTime();
          };

          const startTime = parseXmltvTime(prog.start);
          const stopTime = parseXmltvTime(prog.stop);
          const isCurrentlyAiring = nowTimestamp >= startTime && nowTimestamp < stopTime;

          // Check if program matches a currently live event in database
          const isLiveEvent = isCurrentlyAiring && matchesLiveEvent(prog.title);

          // Check if LIVE prefix should be added
          const settings = channelSettings[prog.channel_id];
          const shouldAddLivePrefix = settings && isCurrentlyAiring &&
            (settings.enableLivePrefix || (settings.autoDetectLive && isLiveEvent));

          // Prepend small caps "LIVE" to title if applicable
          const title = shouldAddLivePrefix
            ? `ʟɪᴠᴇ ${prog.title || 'Unknown'}`
            : prog.title || 'Unknown';

          xmlLines.push(`  <programme start="${prog.start}" stop="${prog.stop}" channel="${escapeXml(prog.channel_id)}">`);
          xmlLines.push(`    <title>${escapeXml(title)}</title>`);
          if (prog.description) {
            xmlLines.push(`    <desc>${escapeXml(prog.description)}</desc>`);
          }
          if (prog.category) {
            xmlLines.push(`    <category>${escapeXml(prog.category)}</category>`);
          }
          xmlLines.push(`  </programme>`);
        });

        xmlLines.push('</tv>');
        const epgContent = xmlLines.join('\n');

        // Update files
        fs.writeFileSync(cred.m3u_file, m3uContent);
        fs.writeFileSync(cred.epg_file, epgContent);

        // Update database record
        await new Promise((resolve, reject) => {
          db.run(`
            UPDATE generated_credentials
            SET channel_count = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [matchedChannels.length, cred.id], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

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

/**
 * Helper function to escape XML special characters
 */
function escapeXml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
