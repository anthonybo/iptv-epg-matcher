/**
 * POST /api/live-events/random-any-channel
 * Find a random working channel from all available channels (not just live events).
 * Useful for testing the blacklist feature when no live events are available.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { execFileAsync, httpAgent, httpsAgent } = require('../../utils/streamAgents');

/**
 * POST /api/live-events/random-any-channel
 * Find a random working channel from all available channels (not just live events)
 * Useful for testing blacklist feature when no live events are available
 */
router.post('/random-any-channel', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Random any channel: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { excludeSourceIds = [], minQuality = 0 } = req.body;
    const minHeight = parseInt(minQuality) || 0;

    // Fetch blacklisted channels from database
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    logger.info(`Finding random channel from all channels (excludedSources: ${excludeSourceIds.length}, blacklistedChannels: ${blacklistedChannels.length}, minQuality: ${minHeight}p)`);

    // Build source exclusion clause
    let sourceExclusion = '';
    let queryParams = [userId];

    if (excludeSourceIds.length > 0) {
      const sourceParamIndex = queryParams.length + 1;
      const sourcePlaceholders = excludeSourceIds.map((_, i) => `$${sourceParamIndex + i}`).join(', ');
      sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
      queryParams.push(...excludeSourceIds);
    }

    // Build blacklist conditions
    let blacklistConditions = '1=1';
    if (blacklistedChannels.length > 0) {
      const blacklistParamIndex = queryParams.length + 1;
      blacklistConditions = blacklistedChannels.map((name, i) => {
        return `c.name != $${blacklistParamIndex + i}`;
      }).join(' AND ');
      queryParams.push(...blacklistedChannels);

      logger.info(`Blacklisting ${blacklistedChannels.length} channels`);
    }

    // Test streams using same validation logic as random-working-stream

    // Track tested channel IDs to avoid duplicates across batches
    const testedChannelIds = new Set();
    let totalTested = 0;
    const maxBatches = 5; // Reduced batches since we test in parallel now
    const batchSize = 20; // Smaller batches for parallel testing
    const PARALLEL_TESTS = 3; // Test 3 channels at a time (reduced to prevent network saturation)

    // Helper function to test a single channel
    const testSingleChannel = async (channel) => {
      try {
        let testUrl = channel.url;

        // Handle Stalker portals - need to refresh token
        if (channel.source_type === 'stalker' && testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
          try {
            const createLinkResponse = await axios.get(testUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
                'X-User-Agent': 'Model: MAG250; Link: WiFi',
                'Cookie': `mac=${channel.source_mac}; stb_lang=en; timezone=America/New_York`
              },
              timeout: 5000,
              httpAgent,
              httpsAgent
            });

            const linkData = createLinkResponse.data;
            if (!linkData.js || !linkData.js.cmd) {
              return { success: false, reason: 'Stalker token refresh - no cmd' };
            }

            const freshCmd = linkData.js.cmd;
            const cmdMatch = freshCmd.match(/ffmpeg\s+(.+)/);
            if (!cmdMatch) {
              return { success: false, reason: 'Stalker token refresh - could not parse cmd' };
            }

            let freshUrl = cmdMatch[1];

            // Fix empty stream parameter bug
            const originalCmdMatch = testUrl.match(/cmd=([^&]+)/);
            if (originalCmdMatch) {
              const originalCmd = decodeURIComponent(originalCmdMatch[1]);
              const streamIdMatch = originalCmd.match(/stream=([^&]+)/);
              if (streamIdMatch && streamIdMatch[1]) {
                const originalStreamId = streamIdMatch[1];
                if (freshUrl.includes('stream=&')) {
                  freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
                }
              }
            }

            testUrl = freshUrl;
          } catch (stalkerError) {
            return { success: false, reason: `Stalker token refresh failed - ${stalkerError.message}` };
          }
        }

        // Validate stream with ffprobe
        const ffprobeArgs = [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          '-read_intervals', '%+#1',
          '-timeout', '8000000'
        ];

        // Add headers for Stalker streams
        if (channel.source_type === 'stalker' && channel.source_mac) {
          ffprobeArgs.push('-headers', `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`);
        }

        ffprobeArgs.push(testUrl);

        const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
          timeout: 8000, // Reduced timeout for faster testing
          maxBuffer: 1024 * 1024
        });

        const probeData = JSON.parse(stdout);
        const videoStream = probeData.streams && probeData.streams.find(s => s.codec_type === 'video');
        const hasAudio = probeData.streams && probeData.streams.some(s => s.codec_type === 'audio');

        // MUST have video - audio-only streams (like radio) are not valid for IPTV
        if (videoStream) {
          const streamHeight = videoStream.height || 0;
          return { success: true, height: streamHeight, hasAudio, channel };
        }

        return { success: false, reason: hasAudio ? 'Audio-only stream (no video)' : 'No video stream' };
      } catch (error) {
        return { success: false, reason: error.message.split('\n')[0] };
      }
    };

    for (let batch = 0; batch < maxBatches; batch++) {
      // Get random channels
      const channelsResult = await postgresService.query(`
        SELECT
          c.channel_id as id,
          c.name,
          c.logo_url as logo,
          c.stream_url as url,
          c.tvg_id as epg_channel_id,
          c.group_title as category,
          s.id as source_id,
          s.name as source_name,
          s.type as source_type,
          s.url as source_url,
          s.username as source_username,
          s.password as source_password,
          s.mac_address as source_mac
        FROM iptv_channels c
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE s.user_id = $1 ${sourceExclusion} AND ${blacklistConditions}
        ORDER BY RANDOM()
        LIMIT ${batchSize}
      `, queryParams);

      let channels = channelsResult.rows || [];

      if (channels.length === 0) {
        if (batch === 0) {
          return res.status(404).json({
            success: false,
            error: 'No channels found',
            message: 'No channels available after filtering'
          });
        }
        break; // No more channels to test
      }

      // Filter out already tested channels
      channels = channels.filter(ch => !testedChannelIds.has(ch.id));
      channels.forEach(ch => testedChannelIds.add(ch.id));

      logger.info(`Batch ${batch + 1}/${maxBatches}: Testing ${channels.length} channels in parallel... (totalTested so far: ${totalTested})`);

      // Test channels in parallel with concurrency limit
      for (let i = 0; i < channels.length; i += PARALLEL_TESTS) {
        const chunk = channels.slice(i, i + PARALLEL_TESTS);
        const results = await Promise.all(chunk.map(async (channel) => {
          totalTested++;
          logger.info(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);
          const result = await testSingleChannel(channel);
          return { channel, result };
        }));

        // Check results for a working channel
        for (const { channel, result } of results) {
          if (result.success) {
            const streamHeight = result.height;

            // Check quality requirement
            if (minHeight > 0 && streamHeight < minHeight) {
              logger.info(`✗ Channel ${channel.name} quality too low: ${streamHeight}p < ${minHeight}p`);
              continue;
            }

            logger.info(`✓ Stream validated for ${channel.name} (${streamHeight}p, audio: ${result.hasAudio})`);

            return res.json({
              success: true,
              channel: {
                id: channel.id,
                name: channel.name,
                logo: channel.logo,
                url: channel.url,
                sourceId: channel.source_id,
                sourceName: channel.source_name,
                sourceType: channel.source_type,
                category: channel.category,
                quality: streamHeight
              }
            });
          } else {
            logger.info(`✗ Channel ${channel.name} failed: ${result.reason}`);
          }
        }
      }
    }

    logger.info(`Random any channel: Finished testing ${totalTested} channels across ${maxBatches} batches, no working streams found`);
    return res.status(404).json({
      success: false,
      error: 'No working streams found',
      message: minHeight > 0
        ? `Tested ${totalTested} channels but none met the ${minHeight}p quality requirement`
        : `Tested ${totalTested} channels but none were working`
    });
  } catch (error) {
    logger.error('Random any channel failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
