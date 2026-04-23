/**
 * Random-sports-channel route: pick a random working channel for a sport/league.
 * Split out of the original monolithic routes/liveEvents.js.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { execFileAsync, httpAgent, httpsAgent } = require('../../utils/streamAgents');

/**
 * POST /api/live-events/random-sports-channel
 * Get a random working sports channel (not tied to live events)
 */
router.post('/random-sports-channel', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { excludeSourceIds = [] } = req.body;


    // Fetch blacklisted channels
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    // Build blacklist conditions
    let blacklistConditions = '1=1';
    let queryParams = [userId];

    if (blacklistedChannels.length > 0) {
      blacklistConditions = blacklistedChannels.map((name, i) => {
        queryParams.push(name);
        return `c.name != $${i + 2}`;
      }).join(' AND ');
    }

    // Add excluded source IDs to query params
    let sourceExclusion = '';
    if (excludeSourceIds.length > 0) {
      const sourceParamIndex = queryParams.length + 1;
      const sourcePlaceholders = excludeSourceIds.map((_, i) => `$${sourceParamIndex + i}`).join(', ');
      sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
      queryParams.push(...excludeSourceIds);
    }

    logger.info(`Finding random working sports channel (excludedSources: ${excludeSourceIds.length}, blacklistedChannels: ${blacklistedChannels.length})`);

    // Query for random sports channels (get multiple to test)
    const result = await postgresService.query(
      `SELECT
        c.channel_id as id,
        c.name,
        c.logo_url as logo,
        c.stream_url as url,
        s.id as source_id,
        s.type as source_type,
        s.url as source_url,
        s.username as source_username,
        s.password as source_password,
        s.mac_address as source_mac,
        s.name as source_name
       FROM iptv_channels c
       JOIN iptv_sources s ON c.source_id = s.id
       WHERE s.user_id = $1
         AND (
           c.group_title ILIKE '%sport%'
           OR c.name ILIKE '%sport%'
           OR c.name ILIKE '%nfl%'
           OR c.name ILIKE '%nba%'
           OR c.name ILIKE '%nhl%'
           OR c.name ILIKE '%mlb%'
           OR c.name ILIKE '%espn%'
           OR c.name ILIKE '%fox sports%'
         )
         ${sourceExclusion}
         AND ${blacklistConditions}
       ORDER BY RANDOM()
       LIMIT 20`,
      queryParams
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        error: 'No sports channels found'
      });
    }

    logger.info(`Found ${result.rows.length} sports channels, testing streams...`);

    // Test each channel until we find a working one
    for (const channel of result.rows) {
      try {
        logger.info(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);

        let testUrl = channel.url;

        // Build proper URL for XTREAM sources
        if (channel.source_type === 'xtream' && channel.source_url && channel.source_username && channel.source_password) {
          const baseUrl = channel.source_url.replace(/\/$/, '');
          const streamId = channel.url.split('/').pop();
          testUrl = `${baseUrl}/live/${channel.source_username}/${channel.source_password}/${streamId}`;
        }

        // Validate stream with ffprobe
        if (channel.source_type === 'stalker') {
          // Stalker: request fresh link from portal first
          if (testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
            logger.info(`Requesting fresh Stalker token...`);

            const createLinkResponse = await axios.get(testUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                'X-User-Agent': 'Model: MAG250; Link: WiFi',
                'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
              },
              timeout: 10000,
              httpAgent,
              httpsAgent
            });

            const linkData = createLinkResponse.data;

            if (linkData?.js?.cmd) {
              const freshCmd = linkData.js.cmd;
              const match = freshCmd.match(/ffmpeg\s+(.+)/);
              if (match && match[1]) {
                let freshUrl = match[1];

                // Fix empty stream parameter if needed
                const originalCmdMatch = testUrl.match(/cmd=([^&]+)/);
                if (originalCmdMatch) {
                  const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                  const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                  if (originalStreamMatch && (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/))) {
                    freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamMatch[1]}$1`);
                  }
                }

                testUrl = freshUrl;
              }
            }
          }

          // Validate with ffprobe
          const ffprobeArgs = [
            '-v', 'error',
            '-print_format', 'json',
            '-show_streams',
            '-read_intervals', '%+#1',
            '-timeout', '8000000',
            '-headers', `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`,
            testUrl
          ];

          const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
            timeout: 10000,
            maxBuffer: 1024 * 1024
          });

          const probeData = JSON.parse(stdout);
          if (!probeData.streams || probeData.streams.length === 0) {
            throw new Error('No streams found');
          }

          const hasVideo = probeData.streams.some(s => s.codec_type === 'video');
          const hasAudio = probeData.streams.some(s => s.codec_type === 'audio');

          if (!hasVideo && !hasAudio) {
            throw new Error('No valid streams');
          }

          logger.info(`✓ Channel ${channel.name} is WORKING!`);
        } else {
          // M3U/XTREAM validation
          const ffprobeArgs = [
            '-v', 'error',
            '-print_format', 'json',
            '-show_streams',
            '-read_intervals', '%+#1',
            '-timeout', '8000000',
            testUrl
          ];

          const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
            timeout: 10000,
            maxBuffer: 1024 * 1024
          });

          const probeData = JSON.parse(stdout);
          if (!probeData.streams || probeData.streams.length === 0) {
            throw new Error('No streams found');
          }

          const hasVideo = probeData.streams.some(s => s.codec_type === 'video');
          const hasAudio = probeData.streams.some(s => s.codec_type === 'audio');

          if (!hasVideo && !hasAudio) {
            throw new Error('No valid streams');
          }

          logger.info(`✓ Channel ${channel.name} is WORKING!`);
        }

        // Found a working channel!
        return res.json({
          success: true,
          channel: {
            id: channel.id,
            name: channel.name,
            logo: channel.logo,
            url: channel.url,
            sourceId: channel.source_id,
            sourceType: channel.source_type,
            sourceUrl: channel.source_url,
            sourceUsername: channel.source_username,
            sourcePassword: channel.source_password,
            sourceMac: channel.source_mac,
            sourceName: channel.source_name
          }
        });

      } catch (error) {
        logger.info(`✗ Channel ${channel.name} failed: ${error.message}`);
        continue; // Try next channel
      }
    }

    // No working channels found
    logger.info('No working sports channels found after testing all candidates');
    return res.json({
      success: false,
      error: 'No working sports channels found'
    });

  } catch (error) {
    logger.error('Random sports channel failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
