// routes/xtream.js
/**
 * Xtream Routes - handles Xtream API compatibility
 * Implements XTREAM API for generated credentials stored in database
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const logger = require('../config/logger');
const iptvDatabaseService = require('../services/iptvDatabase');
const postgresService = require('../services/postgresService');
const metricsService = require('../services/metricsService');
const publishedEpgService = require('../services/publishedEpgService');
const { generateXmltvFromDatabase } = require('../utils/xmltvGenerator');

// Connection pooling agents for efficient HTTP/HTTPS requests
// This prevents opening too many concurrent connections and reuses existing ones
const httpAgent = new http.Agent({
  keepAlive: true,           // Reuse connections
  maxSockets: 10,            // Max 10 concurrent connections per host
  maxFreeSockets: 5,         // Keep 5 idle connections ready for reuse
  timeout: 60000,            // 60 second timeout
  keepAliveMsecs: 30000      // Send keep-alive packets every 30s
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000,
  keepAliveMsecs: 30000
});

logger.info('[XTREAM] HTTP/HTTPS connection pooling enabled (maxSockets: 10, keepAlive: true)');

/**
 * Validate credentials and get credential info from database
 */
async function validateCredentials(username, password) {
  try {
    const result = await postgresService.query(`
      SELECT * FROM credentials
      WHERE username = $1 AND password = $2
    `, [username, password]);

    const credential = result.rows[0];

    if (credential) {
      // Update last_used timestamp
      await postgresService.query(`
        UPDATE credentials
        SET last_used = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [credential.id]);
    }

    return credential;
  } catch (error) {
    logger.error('Error validating credentials:', error);
    return null;
  }
}

/**
 * GET /api/xtream/player_api.php
 * Xtream-compatible endpoint for player API info
 */
router.get('/player_api.php', async (req, res) => {
  const { username, password, action } = req.query;

  if (!username || !password) {
    logger.error('Missing credentials for XTREAM player API');
    return res.status(400).json({ error: 'Missing username or password' });
  }

  const credential = await validateCredentials(username, password);

  if (!credential) {
    logger.error('Invalid credentials for XTREAM player API', { username });
    return res.status(403).json({ error: 'Invalid credentials' });
  }

  logger.debug('Serving XTREAM player API', { username, action, channelCount: credential.channel_count });

  // Handle different actions
  if (action === 'get_live_categories') {
    // Return categories for the channels
    const db = await iptvDatabaseService.connect();

    const categories = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT c.group_title
        FROM epg_matches m
        JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
        WHERE m.user_id = ?
        ORDER BY c.group_title
      `, [credential.user_id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    // Format categories for XTREAM API
    const formattedCategories = categories.map((cat, index) => ({
      category_id: String(index + 1),
      category_name: cat.group_title || 'Uncategorized',
      parent_id: 0
    }));

    // Add "All" category at the beginning
    formattedCategories.unshift({
      category_id: "0",
      category_name: "All",
      parent_id: 0
    });

    return res.json(formattedCategories);
  }

  if (action === 'get_live_streams') {
    // Return channel list from PostgreSQL
    const categoryId = req.query.category_id;

    let query = `
      SELECT
        m.iptv_channel_id,
        m.epg_channel_id,
        c.name,
        c.logo_url as logo,
        c.group_title
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      WHERE m.user_id = $1
    `;

    const params = [credential.user_id];

    // Filter by category if specified and not "All"
    if (categoryId && categoryId !== '0') {
      query += ` AND c.group_title = (
        SELECT DISTINCT group_title FROM iptv_channels
        JOIN epg_matches ON iptv_channels.channel_id = epg_matches.iptv_channel_id
        WHERE epg_matches.user_id = $2
        ORDER BY group_title
        LIMIT 1 OFFSET $3
      )`;
      params.push(credential.user_id, parseInt(categoryId) - 1);
    }

    query += ' ORDER BY c.name';

    const result = await postgresService.query(query, params);
    const channels = result.rows;

    // Get unique category mapping for category IDs
    const categoryMap = new Map();
    let catIndex = 1;

    channels.forEach(ch => {
      const catName = ch.group_title || 'Uncategorized';
      if (!categoryMap.has(catName)) {
        categoryMap.set(catName, String(catIndex++));
      }
    });

    // Format channels for XTREAM API
    const formattedChannels = channels.map((ch, index) => ({
      num: index + 1,
      name: ch.name,
      stream_type: "live",
      stream_id: index + 1,
      stream_icon: ch.logo || '',
      epg_channel_id: ch.epg_channel_id || '',
      added: credential.created_at,
      category_id: categoryMap.get(ch.group_title || 'Uncategorized') || '1',
      custom_sid: "",
      tv_archive: 0,
      direct_source: "",
      tv_archive_duration: 0,
      // Store the actual channel ID for streaming
      channel_id: ch.iptv_channel_id
    }));

    return res.json(formattedChannels);
  }

  if (action === 'get_short_epg' || action === 'get_simple_data_table') {
    // Return EPG data for channels
    const { stream_id, limit } = req.query;
    logger.info(`EPG request: action=${action}, stream_id=${stream_id || 'all'}, limit=${limit || 100}`);
    const db = await iptvDatabaseService.connect();

    // Get the channel(s) to fetch EPG for
    let channels = [];

    if (stream_id) {
      // Get specific channel by stream_id
      const allChannels = await new Promise((resolve, reject) => {
        db.all(`
          SELECT
            m.epg_channel_id,
            c.name
          FROM epg_matches m
          JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
          WHERE m.user_id = ?
          ORDER BY c.name
        `, [credential.user_id], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      const channel = allChannels[parseInt(stream_id) - 1];
      if (channel && channel.epg_channel_id) {
        channels = [channel];
      }
    } else {
      // Get all channels with EPG
      channels = await new Promise((resolve, reject) => {
        db.all(`
          SELECT
            m.epg_channel_id,
            c.name
          FROM epg_matches m
          JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
          WHERE m.user_id = ? AND m.epg_channel_id IS NOT NULL
          ORDER BY c.name
        `, [credential.user_id], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    }

    if (channels.length === 0) {
      return res.json({ epg_listings: [] });
    }

    // EPG data now comes from Postgres (epg_programs), not the legacy
    // sqlite epg.db. start_time/stop_time are real timestamps in PG;
    // we format them back to the XMLTV string shape (YYYYMMDDHHMMSS)
    // the downstream formatter already expects, so nothing below
    // changes. NOW() filter replaces the old substr(stop,...) string
    // comparison.
    const epgChannelIds = channels.map(ch => ch.epg_channel_id).filter(Boolean);

    if (epgChannelIds.length === 0) {
      return res.json({ epg_listings: [] });
    }

    const programLimit = limit ? parseInt(limit) : 100;

    let programs = [];
    try {
      // epg_programs is LIST-partitioned by source_id across 100+
      // partitions. A channel_id-only filter can't prune them, so the
      // planner fans out across every partition — cheap when warm but
      // a multi-second cold-start (it touches all partitions' index
      // pages). Resolve the channels' source_id(s) first so we can add
      // a source_id predicate that prunes the scan to the one or few
      // partitions that actually hold these channels' programs.
      const srcRes = await postgresService.query(
        `SELECT DISTINCT source_id FROM epg_channels WHERE id = ANY($1::text[])`,
        [epgChannelIds]
      );
      const sourceIds = srcRes.rows.map(r => r.source_id).filter(Boolean);

      const params = [epgChannelIds, programLimit];
      let sourceClause = '';
      if (sourceIds.length > 0) {
        params.push(sourceIds);
        sourceClause = `AND source_id = ANY($${params.length}::text[])`;
      }

      const result = await postgresService.query(`
        SELECT channel_id,
               title,
               to_char(start_time, 'YYYYMMDDHH24MISS') AS start,
               to_char(stop_time,  'YYYYMMDDHH24MISS') AS stop,
               description
          FROM epg_programs
         WHERE channel_id = ANY($1::text[])
           ${sourceClause}
           AND stop_time >= NOW()
         ORDER BY channel_id, start_time
         LIMIT $2
      `, params);
      programs = result.rows || [];
    } catch (err) {
      logger.error(`Error fetching EPG data from Postgres: ${err.message}`);
      programs = [];
    }

    // Format EPG data for XTREAM API
    const epgListings = {};

    logger.info(`Found ${programs.length} EPG programs for XTREAM API`);

    programs.forEach(prog => {
      if (!epgListings[prog.channel_id]) {
        epgListings[prog.channel_id] = [];
      }

      // Extract timestamp without timezone (format: "YYYYMMDDHHmmss +ZZZZ" or "YYYYMMDDHHmmss -ZZZZ")
      const startStr = prog.start.split(' ')[0]; // Remove timezone part
      const stopStr = prog.stop.split(' ')[0];

      // Convert XMLTV timestamp format (YYYYMMDDHHmmss) to ISO format
      const startTimestamp = startStr.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6Z');
      const stopTimestamp = stopStr.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6Z');

      epgListings[prog.channel_id].push({
        id: `${prog.channel_id}_${startStr}`,
        epg_id: prog.channel_id,
        title: prog.title || 'Unknown',
        lang: 'en',
        start: startStr,
        end: stopStr,
        description: prog.description || '',
        channel_id: prog.channel_id,
        start_timestamp: Math.floor(new Date(startTimestamp).getTime() / 1000),
        stop_timestamp: Math.floor(new Date(stopTimestamp).getTime() / 1000)
      });
    });

    return res.json({ epg_listings: epgListings });
  }

  // Default response - return user and server info
  const response = {
    user_info: {
      username: credential.username,
      password: credential.password,
      message: "Success",
      auth: 1,
      status: "Active",
      exp_date: null, // Unlimited
      is_trial: "0",
      active_cons: "1",
      max_connections: "3",
      created_at: credential.created_at,
      allowed_output_formats: ["m3u8", "ts"]
    },
    server_info: {
      url: `${req.protocol}://${req.get('host')}/api/xtream`,
      port: "80",
      https_port: "443",
      server_protocol: req.protocol,
      rtmp_port: "1935",
      timestamp_now: Math.floor(Date.now() / 1000),
      time_now: new Date().toISOString(),
      timezone: "UTC"
    }
  };

  res.json(response);
});

/**
 * GET /api/xtream/get.php
 * Xtream-compatible endpoint for M3U playlist
 */
router.get('/get.php', async (req, res) => {
  const { username, password, type = 'm3u_plus', output = 'ts' } = req.query;

  if (!username || !password) {
    logger.error('Missing credentials for XTREAM M3U');
    return res.status(400).send('Missing username or password');
  }

  const credential = await validateCredentials(username, password);

  if (!credential) {
    logger.error('Invalid credentials for XTREAM M3U', { username });
    return res.status(403).send('Invalid credentials');
  }

  logger.debug('Serving XTREAM M3U', { username, type, output, channelCount: credential.channel_count });

  // Read M3U file from disk
  try {
    if (!credential.m3u_file || !fs.existsSync(credential.m3u_file)) {
      logger.error('M3U file not found', { file: credential.m3u_file });
      return res.status(404).send('M3U file not found');
    }

    const m3uContent = fs.readFileSync(credential.m3u_file, 'utf8');

    res.set('Content-Type', 'application/x-mpegurl');
    res.set('Content-Disposition', `attachment; filename="playlist_${username}.m3u"`);
    res.send(m3uContent);
  } catch (error) {
    logger.error('Error reading M3U file:', error);
    res.status(500).send('Error reading M3U file');
  }
});

/**
 * GET /api/xtream/xmltv.php
 * Xtream-compatible endpoint for EPG data
 */
router.get('/xmltv.php', async (req, res) => {
  const { username, password } = req.query;

  if (!username || !password) {
    logger.error('Missing credentials for XTREAM EPG');
    return res.status(400).send('Missing username or password');
  }

  const credential = await validateCredentials(username, password);

  if (!credential) {
    logger.error('Invalid credentials for XTREAM EPG', { username });
    return res.status(403).send('Invalid credentials');
  }

  logger.debug('Serving XTREAM EPG', { username, credentialId: credential.id });

  // Generate XMLTV from database (replaces static file)
  try {
    // Get matched channels with dummy EPG flags and live prefix settings
    const channelsResult = await postgresService.query(`
      SELECT
        m.iptv_channel_id,
        m.epg_channel_id,
        m.use_dummy_epg,
        c.name as channel_name,
        c.logo_url,
        c.enable_live_prefix,
        s.auto_detect_live
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
    `, [credential.user_id]);

    const matchedChannels = channelsResult.rows || [];

    // Load live events for LIVE prefix detection
    const liveEventsService = require('../services/liveEventsService');
    const liveEvents = await liveEventsService.getAllEvents();

    // Helper function to check if a program matches a live event
    const matchesLiveEvent = (channelName, programStartTime, programStopTime) => {
      if (!liveEvents || liveEvents.length === 0) return false;

      for (const event of liveEvents) {
        const eventStart = new Date(event.event_start).getTime();
        const eventEnd = new Date(event.event_end).getTime();

        // Check if program time overlaps with event time
        if (programStartTime < eventEnd && programStopTime > eventStart) {
          // Simple check: does channel name contain team names?
          const homeTeam = (event.home_team || '').toLowerCase();
          const awayTeam = (event.away_team || '').toLowerCase();
          const channelLower = channelName.toLowerCase();

          if ((homeTeam && channelLower.includes(homeTeam)) ||
              (awayTeam && channelLower.includes(awayTeam))) {
            return true;
          }
        }
      }
      return false;
    };

    // Get LIVE EPG data for channels with real EPG
    const realEpgResult = await postgresService.query(`
      SELECT
        m.iptv_channel_id,
        m.epg_channel_id,
        c.name as channel_name,
        c.logo_url,
        p.title,
        p.description,
        p.start_time,
        p.stop_time,
        p.categories
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      JOIN epg_programs p ON m.epg_channel_id = p.channel_id
      WHERE m.user_id = $1
      AND m.use_dummy_epg = false
      AND p.stop_time >= NOW() - INTERVAL '12 hours'
      ORDER BY m.iptv_channel_id, p.start_time
    `, [credential.user_id]);

    let epgData = realEpgResult.rows || [];

    // Generate dummy EPG for channels with use_dummy_epg=true
    const dummyChannels = matchedChannels.filter(ch => ch.use_dummy_epg === true);
    if (dummyChannels.length > 0) {
      logger.info(`Generating dummy EPG for ${dummyChannels.length} channels`);

      const now = new Date();
      dummyChannels.forEach(channel => {
        // Generate 7 days of dummy programs (3-hour blocks)
        for (let day = 0; day < 7; day++) {
          for (let hour = 0; hour < 24; hour += 3) {
            const startDate = new Date(now);
            startDate.setUTCDate(startDate.getUTCDate() + day);
            startDate.setUTCHours(hour, 0, 0, 0);

            const stopDate = new Date(startDate);
            stopDate.setUTCHours(stopDate.getUTCHours() + 3);

            // Format as PostgreSQL timestamp string
            const formatTimestamp = (date) => {
              const pad = (n) => String(n).padStart(2, '0');
              return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
            };

            // Check if this time slot overlaps with a live event
            const programStartTime = startDate.getTime();
            const programStopTime = stopDate.getTime();
            const isLiveEvent = matchesLiveEvent(channel.channel_name, programStartTime, programStopTime);

            // Apply LIVE prefix if channel has enable_live_prefix and matches a live event
            const shouldAddLivePrefix = (channel.enable_live_prefix === true || channel.auto_detect_live === true) && isLiveEvent;
            const title = shouldAddLivePrefix ? `ʟɪᴠᴇ ${channel.channel_name}` : channel.channel_name;

            epgData.push({
              iptv_channel_id: channel.iptv_channel_id,
              epg_channel_id: channel.epg_channel_id || `dummy_${channel.iptv_channel_id}`,
              channel_name: channel.channel_name,
              logo_url: channel.logo_url,
              title: title,
              description: `Streaming on ${channel.channel_name}`,
              start_time: formatTimestamp(startDate),
              stop_time: formatTimestamp(stopDate),
              categories: 'Live TV'
            });
          }
        }
      });

      logger.info(`Total programs after adding dummy EPG: ${epgData.length}`);
    }

    if (!epgData || epgData.length === 0) {
      logger.warn('No EPG data found for credential', { credentialId: credential.id });
      // Return empty but valid XMLTV
      const emptyXmltv = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="IPTV Guru"></tv>';
      res.set('Content-Type', 'application/xml');
      res.set('Content-Disposition', `attachment; filename="epg_${username}.xml"`);
      return res.send(emptyXmltv);
    }

    // Generate XMLTV from live database + dummy data
    const xmltvContent = generateXmltvFromDatabase(epgData);

    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="epg_${username}.xml"`);
    res.send(xmltvContent);

    logger.info(`Served XMLTV for credential ${credential.id}: ${epgData.length} programs`);
  } catch (error) {
    logger.error('Error generating XMLTV from database:', error);
    res.status(500).send('Error generating EPG');
  }
});

/**
 * GET /api/xtream/live/:username/:password/:streamId.:extension
 * Standard XTREAM API live stream endpoint
 */
router.get('/live/:username/:password/:streamFile', async (req, res) => {
  try {
    const { username, password, streamFile } = req.params;

    // Parse stream ID and extension from filename (e.g., "123.ts")
    const match = streamFile.match(/^(\d+)\.(ts|m3u8)$/);
    if (!match) {
      logger.error('Invalid stream file format', { streamFile });
      return res.status(400).json({ error: 'Invalid stream format' });
    }

    const streamId = parseInt(match[1]);
    const extension = match[2];

    const credential = await validateCredentials(username, password);

    if (!credential) {
      logger.error('Invalid credentials for XTREAM live stream', { username });
      return res.status(403).json({ error: 'Invalid credentials' });
    }

    logger.info(`XTREAM live stream request for stream ID ${streamId} with username ${username}`);

    // Get the channel list to map stream_id to actual channel_id
    const db = await iptvDatabaseService.connect();

    const channels = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          m.iptv_channel_id,
          c.name,
          c.logo_url as logo,
          c.stream_url as url,
          c.source_username,
          c.source_password,
          c.source_mac,
          c.source_type
        FROM epg_matches m
        JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE m.user_id = ?
        ORDER BY c.name
      `, [credential.user_id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    // Stream IDs are 1-indexed, array is 0-indexed
    const channel = channels[streamId - 1];

    if (!channel) {
      logger.error(`Channel not found for stream ID: ${streamId}`);
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (!channel.url) {
      logger.error(`No stream URL for channel ${channel.iptv_channel_id}`);
      return res.status(400).json({ error: 'No stream URL for this channel' });
    }

    logger.info(`Proxying XTREAM live stream for channel: ${channel.name} from URL: ${channel.url}`);

    // Handle Stalker portal URLs - request FRESH link from portal
    let streamUrl = channel.url;
    if (channel.url.includes('portal.php') && channel.url.includes('action=create_link')) {
      try {
        logger.info(`Requesting fresh Stalker link from portal...`);

        // Make request to create_link to get fresh token
        const createLinkResponse = await fetch(channel.url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
          },
          agent: channel.url.startsWith('https') ? httpsAgent : httpAgent
        });

        if (createLinkResponse.ok) {
          const linkData = await createLinkResponse.json();
          logger.info(`create_link response:`, linkData);

          if (linkData && linkData.js && linkData.js.cmd) {
            const freshCmd = linkData.js.cmd;
            const match = freshCmd.match(/ffmpeg\s+(.+)/);
            if (match && match[1]) {
              let freshUrl = match[1];
              logger.info(`Got FRESH Stalker stream URL: ${freshUrl}`);

              // Extract play_token from fresh URL
              const freshTokenMatch = freshUrl.match(/play_token=([^&]+)/);
              const freshToken = freshTokenMatch ? freshTokenMatch[1] : null;

              // Extract stream ID from ORIGINAL cmd parameter in channel.url
              // Some Stalker portals return empty stream parameter in create_link response
              const originalCmdMatch = channel.url.match(/cmd=([^&]+)/);
              if (originalCmdMatch && freshToken) {
                const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                logger.info(`Original cmd: ${originalCmd}`);
                const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                if (originalStreamId) {
                  // Check if fresh URL has empty stream parameter
                  if (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/)) {
                    logger.info(`Portal returned empty stream ID - using original stream ID: ${originalStreamId}`);
                    freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
                    logger.info(`Fixed stream URL: ${freshUrl}`);
                  }
                }
              }

              streamUrl = freshUrl;
            }
          }
        } else {
          logger.warn(`Failed to get fresh link: ${createLinkResponse.status}`);
          // Fall back to parsing stored URL
          const url = new URL(channel.url);
          const cmd = url.searchParams.get('cmd');
          if (cmd) {
            const match = cmd.match(/ffmpeg\s+(.+)/);
            if (match && match[1]) {
              streamUrl = match[1];
              logger.info(`Using stored Stalker stream URL: ${streamUrl}`);
            }
          }
        }

        // Replace localhost with actual server address if needed
        if (streamUrl.includes('localhost')) {
          const sourceUrl = new URL(channel.url);
          const serverAddress = `${sourceUrl.protocol}//${sourceUrl.host}`;
          streamUrl = streamUrl.replace(/http:\/\/localhost/g, serverAddress);
          logger.info(`Replaced localhost with server address: ${streamUrl}`);
        }
      } catch (error) {
        logger.error(`Error getting fresh Stalker link: ${error.message}`);
      }
    }

    // Set streaming headers
    res.setHeader('Content-Type', extension === 'ts' ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Fetch and proxy the stream
    const { PassThrough } = require('stream');

    // Set headers based on source type
    const streamHeaders = {};

    // For Stalker streams, include proper authentication headers
    if (channel.source_type === 'stalker') {
      streamHeaders['User-Agent'] = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
      streamHeaders['X-User-Agent'] = 'Model: MAG250; Link: WiFi';

      if (channel.source_mac) {
        streamHeaders['Cookie'] = `mac=${channel.source_mac}; stb_lang=en; timezone=America/New_York`;
      }
    } else {
      // For XTREAM and other sources, use standard browser User-Agent
      streamHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36';
    }

    const streamResponse = await fetch(streamUrl, {
      method: 'GET',
      headers: streamHeaders,
      timeout: 60000,
      agent: streamUrl.startsWith('https') ? httpsAgent : httpAgent
    });

    if (!streamResponse.ok) {
      logger.error(`Failed to fetch stream: ${streamResponse.status} ${streamResponse.statusText}`);
      return res.status(502).json({
        error: 'Failed to fetch stream from source',
        status: streamResponse.status,
        message: streamResponse.statusText
      });
    }

    const passThrough = new PassThrough();

    // Track stream start for metrics
    const streamKey = `xtream_api_${username}_${streamId}_${Date.now()}`;
    metricsService.trackStreamStart(streamKey, {
      channel: channel.name,
      channelId: streamId,
      source: channel.source_name || channel.source_type || 'XTREAM',
      sourceId: channel.source_id,
      user: username,
      userId: credential?.user_id,
      ip: req.ip || req.connection.remoteAddress,
      type: 'xtream_api'
    });

    // Track bandwidth as data flows
    passThrough.on('data', (chunk) => {
      metricsService.trackBandwidth(streamKey, chunk.length, 0);
    });

    // Handle errors on the source stream
    streamResponse.body.on('error', (err) => {
      logger.error(`Source stream error for stream ID ${streamId}: ${err.message}`);
      metricsService.trackStreamEnd(streamKey);
      passThrough.destroy(err);
    });

    // Handle errors on the response stream
    res.on('error', (err) => {
      logger.error(`Response stream error for stream ID ${streamId}: ${err.message}`);
      metricsService.trackStreamEnd(streamKey);
      streamResponse.body.destroy();
      passThrough.destroy();
    });

    // Handle client disconnect
    req.on('close', () => {
      try {
        logger.info(`Stream closed for stream ID ${streamId}`);
        metricsService.trackStreamEnd(streamKey);
        streamResponse.body.destroy();
        passThrough.destroy();
      } catch (err) {
        logger.error(`Error closing stream: ${err.message}`);
      }
    });

    // Pipe through our pass-through stream for better control
    streamResponse.body.pipe(passThrough).pipe(res);

    // Set a timeout on the whole operation
    const streamTimeout = setTimeout(() => {
      logger.warn(`Stream timeout for stream ID ${streamId}`);
      metricsService.trackStreamEnd(streamKey);
      streamResponse.body.destroy(new Error('Stream timeout'));
      passThrough.destroy(new Error('Stream timeout'));
    }, 300000); // 5 minute timeout

    // Clear timeout when stream ends or errors
    passThrough.on('end', () => {
      logger.info(`Stream completed successfully for stream ID ${streamId}`);
      metricsService.trackStreamEnd(streamKey);
      clearTimeout(streamTimeout);
    });

    passThrough.on('error', () => {
      clearTimeout(streamTimeout);
    });

  } catch (error) {
    logger.error(`XTREAM live stream error: ${error.message}`, {
      error: error.message,
      stack: error.stack
    });

    if (!res.headersSent) {
      return res.status(500).json({ error: error.message });
    }
  }
});

/**
 * GET /api/xtream/stream/:channelId
 * Proxy stream for a channel with XTREAM credentials (used by M3U)
 */
router.get('/stream/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { username, password } = req.query;

    logger.info(`[STREAM] Incoming request for channel: ${channelId}, username: ${username}, has password: ${!!password}`);

    if (!username || !password) {
      logger.error('[STREAM] Missing credentials for XTREAM stream');
      return res.status(400).json({ error: 'Missing username or password' });
    }

    const credential = await validateCredentials(username, password);

    if (!credential) {
      logger.error(`[STREAM] Invalid credentials for XTREAM stream, username: ${username}`);
      return res.status(403).json({ error: 'Invalid credentials' });
    }

    logger.info(`[STREAM] Valid credentials for user ${credential.user_id}, fetching channel ${channelId}`);

    // Get the channel from the database
    const db = await iptvDatabaseService.connect();

    const channel = await new Promise((resolve, reject) => {
      db.get(`
        SELECT
          c.channel_id,
          c.name,
          c.logo_url as logo,
          c.stream_url as url,
          c.group_title,
          c.source_username,
          c.source_password,
          c.source_mac,
          c.source_type,
          s.user_id
        FROM iptv_channels c
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE c.channel_id = ? AND s.user_id = ?
      `, [channelId, credential.user_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!channel) {
      logger.error(`[STREAM] Channel not found or not owned by user: ${channelId} (user_id: ${credential.user_id})`);
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (!channel.url) {
      logger.error(`[STREAM] No stream URL for channel ${channelId}`);
      return res.status(400).json({ error: 'No stream URL for this channel' });
    }

    logger.info(`[STREAM] Proxying stream for channel: ${channel.name} from URL: ${channel.url}`);

    // Handle Stalker portal URLs - request FRESH link from portal
    let streamUrl = channel.url;
    if (channel.url.includes('portal.php') && channel.url.includes('action=create_link')) {
      try {
        logger.info(`[STREAM] Requesting fresh Stalker link from portal...`);

        // Make request to create_link to get fresh token
        const createLinkResponse = await fetch(channel.url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
          },
          agent: channel.url.startsWith('https') ? httpsAgent : httpAgent
        });

        if (createLinkResponse.ok) {
          const linkData = await createLinkResponse.json();
          logger.info(`[STREAM] create_link response:`, linkData);

          if (linkData && linkData.js && linkData.js.cmd) {
            const freshCmd = linkData.js.cmd;
            const match = freshCmd.match(/ffmpeg\s+(.+)/);
            if (match && match[1]) {
              let freshUrl = match[1];
              logger.info(`[STREAM] Got FRESH Stalker stream URL: ${freshUrl}`);

              // Extract play_token from fresh URL
              const freshTokenMatch = freshUrl.match(/play_token=([^&]+)/);
              const freshToken = freshTokenMatch ? freshTokenMatch[1] : null;

              // Extract stream ID from ORIGINAL cmd parameter in channel.url
              // Some Stalker portals return empty stream parameter in create_link response
              const originalCmdMatch = channel.url.match(/cmd=([^&]+)/);
              if (originalCmdMatch && freshToken) {
                const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                logger.info(`[STREAM] Original cmd: ${originalCmd}`);
                const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                if (originalStreamId) {
                  // Check if fresh URL has empty stream parameter
                  if (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/)) {
                    logger.info(`[STREAM] Portal returned empty stream ID - using original stream ID: ${originalStreamId}`);
                    freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
                    logger.info(`[STREAM] Fixed stream URL: ${freshUrl}`);
                  }
                }
              }

              streamUrl = freshUrl;
            }
          }
        } else {
          logger.warn(`[STREAM] Failed to get fresh link: ${createLinkResponse.status}`);
          // Fall back to parsing stored URL
          const url = new URL(channel.url);
          const cmd = url.searchParams.get('cmd');
          if (cmd) {
            const match = cmd.match(/ffmpeg\s+(.+)/);
            if (match && match[1]) {
              streamUrl = match[1];
              logger.info(`[STREAM] Using stored Stalker stream URL: ${streamUrl}`);
            }
          }
        }

        // Replace localhost with actual server address if needed
        if (streamUrl.includes('localhost')) {
          const sourceUrl = new URL(channel.url);
          const serverAddress = `${sourceUrl.protocol}//${sourceUrl.host}`;
          streamUrl = streamUrl.replace(/http:\/\/localhost/g, serverAddress);
          logger.info(`[STREAM] Replaced localhost with server address: ${streamUrl}`);
        }
      } catch (error) {
        logger.error(`Error getting fresh Stalker link: ${error.message}`);
      }
    }

    // Set streaming headers
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Fetch and proxy the stream
    const { PassThrough } = require('stream');

    // Set headers based on source type
    const streamHeaders = {};

    // For Stalker streams, include proper authentication headers
    if (channel.source_type === 'stalker') {
      streamHeaders['User-Agent'] = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
      streamHeaders['X-User-Agent'] = 'Model: MAG250; Link: WiFi';

      if (channel.source_mac) {
        streamHeaders['Cookie'] = `mac=${channel.source_mac}; stb_lang=en; timezone=America/New_York`;
      }
    } else {
      // For XTREAM and other sources, use standard browser User-Agent
      streamHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36';
    }

    const streamResponse = await fetch(streamUrl, {
      method: 'GET',
      headers: streamHeaders,
      timeout: 60000,
      agent: streamUrl.startsWith('https') ? httpsAgent : httpAgent
    });

    if (!streamResponse.ok) {
      logger.error(`Failed to fetch stream: ${streamResponse.status} ${streamResponse.statusText}`);
      return res.status(502).json({
        error: 'Failed to fetch stream from source',
        status: streamResponse.status,
        message: streamResponse.statusText
      });
    }

    const passThrough = new PassThrough();

    // Track stream start for metrics
    const streamKey = `xtream_direct_${channelId}_${Date.now()}`;
    metricsService.trackStreamStart(streamKey, {
      channel: channel.name,
      channelId: channelId,
      source: channel.source_name || channel.source_type || 'XTREAM',
      sourceId: channel.source_id,
      user: null,
      userId: null,
      ip: req.ip || req.connection.remoteAddress,
      type: 'xtream_direct'
    });

    // Track bandwidth as data flows
    passThrough.on('data', (chunk) => {
      metricsService.trackBandwidth(streamKey, chunk.length, 0);
    });

    // Handle errors on the source stream
    streamResponse.body.on('error', (err) => {
      logger.error(`Source stream error for channel ${channelId}: ${err.message}`);
      metricsService.trackStreamEnd(streamKey);
      passThrough.destroy(err);
    });

    // Handle errors on the response stream
    res.on('error', (err) => {
      logger.error(`Response stream error for channel ${channelId}: ${err.message}`);
      metricsService.trackStreamEnd(streamKey);
      streamResponse.body.destroy();
      passThrough.destroy();
    });

    // Handle client disconnect
    req.on('close', () => {
      try {
        logger.info(`Stream closed for channel ${channelId}`);
        metricsService.trackStreamEnd(streamKey);
        streamResponse.body.destroy();
        passThrough.destroy();
      } catch (err) {
        logger.error(`Error closing stream: ${err.message}`);
      }
    });

    // Pipe through our pass-through stream for better control
    streamResponse.body.pipe(passThrough).pipe(res);

    // Set a timeout on the whole operation
    const streamTimeout = setTimeout(() => {
      logger.warn(`Stream timeout for channel ${channelId}`);
      metricsService.trackStreamEnd(streamKey);
      streamResponse.body.destroy(new Error('Stream timeout'));
      passThrough.destroy(new Error('Stream timeout'));
    }, 300000); // 5 minute timeout

    // Clear timeout when stream ends or errors
    passThrough.on('end', () => {
      logger.info(`Stream completed successfully for channel ${channelId}`);
      metricsService.trackStreamEnd(streamKey);
      clearTimeout(streamTimeout);
    });

    passThrough.on('error', () => {
      clearTimeout(streamTimeout);
    });

  } catch (error) {
    logger.error(`Stream proxy error: ${error.message}`, {
      error: error.message,
      stack: error.stack
    });

    if (!res.headersSent) {
      return res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;
