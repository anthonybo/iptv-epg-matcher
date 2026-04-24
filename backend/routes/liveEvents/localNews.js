/**
 * Local-news route: find a local news channel based on the user's location.
 * Split out of the original monolithic routes/liveEvents.js.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { authMiddleware } = require('../../middleware/authMiddleware');
const { execFileAsync } = require('../../utils/streamAgents');

/**
 * POST /api/live-events/local-news
 * Find a local news channel based on user's location
 * Uses local_news_stations lookup table for accurate matching
 */
router.post('/local-news', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { excludeSourceIds = [], excludeChannelIds = [], minQuality = 0 } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    logger.info(`[Local News] User ${userId} searching for local news channels`);

    // Get user's current location
    const locationResult = await postgresService.query(
      `SELECT city, state, state_abbrev as "stateAbbrev"
       FROM user_locations
       WHERE user_id = $1 AND is_current = true
       LIMIT 1`,
      [userId]
    );

    if (locationResult.rows.length === 0) {
      return res.json({
        success: false,
        error: 'No location set',
        message: 'Please set your location first to find local news'
      });
    }

    const { city, state, stateAbbrev } = locationResult.rows[0];
    logger.info(`[Local News] Searching for news in ${city}, ${state} (${stateAbbrev})`);

    // Get local stations for this location from lookup table
    // First try exact city match, then fall back to same state
    const stationsResult = await postgresService.query(
      `SELECT call_sign, network, city, state, state_abbrev, channel_number
       FROM local_news_stations
       WHERE state_abbrev = $1
       ORDER BY
         CASE WHEN LOWER(city) = LOWER($2) THEN 0 ELSE 1 END,
         network`,
      [stateAbbrev, city]
    );

    if (stationsResult.rows.length === 0) {
      logger.warn(`[Local News] No stations in database for ${stateAbbrev}`);
      return res.json({
        success: false,
        message: `No local news stations configured for ${state}. Try a nearby major city.`
      });
    }

    const localStations = stationsResult.rows;
    const callSigns = localStations.map(s => s.call_sign);
    logger.info(`[Local News] Found ${localStations.length} stations for ${stateAbbrev}: ${callSigns.join(', ')}`);

    // Get user's IPTV sources
    const sourcesResult = await postgresService.query(
      'SELECT id, type, url, username, password, mac_address, name FROM iptv_sources WHERE user_id = $1',
      [userId]
    );

    if (sourcesResult.rows.length === 0) {
      return res.json({
        success: false,
        error: 'No IPTV sources',
        message: 'Please add an IPTV source first'
      });
    }

    // Filter out excluded sources
    const excludeSet = new Set(excludeSourceIds.map(id => parseInt(id)));
    logger.info(`[Local News] Total sources: ${sourcesResult.rows.length}, excluding: [${[...excludeSet].join(', ')}]`);
    const availableSources = sourcesResult.rows.filter(s => !excludeSet.has(s.id));
    logger.info(`[Local News] Available sources after filtering: ${availableSources.map(s => s.id).join(', ')}`);

    if (availableSources.length === 0) {
      return res.json({
        success: false,
        message: 'All sources are excluded'
      });
    }

    // Build regex pattern to match any of the call signs
    // Match call signs as word boundaries to avoid false positives
    const callSignPattern = callSigns.map(cs => cs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    logger.info(`[Local News] Searching ${availableSources.length} sources with regex pattern: \\y(${callSignPattern})\\y`);

    // Search for channels matching our known call signs
    const excludeChannelSet = new Set(excludeChannelIds);
    let candidateChannels = [];

    for (const source of availableSources) {
      try {
        logger.info(`[Local News] Searching source ${source.id} (${source.name || source.url})`);
        // Query channels that match any of our known call signs
        // Support both xtream_ and stalker_ channel IDs
        const channelsResult = await postgresService.query(
          `SELECT
            c.channel_id, c.name, c.stream_url, c.logo_url, c.category, c.group_title,
            c.source_type, c.source_username, c.source_password, c.source_url, c.source_mac,
            s.id as source_id, s.name as source_name, s.type, s.url, s.username, s.password, s.mac_address
           FROM iptv_channels c
           JOIN iptv_sources s ON c.source_id = s.id
           WHERE s.id = $1
           AND (c.channel_id LIKE 'xtream_%' OR c.channel_id LIKE 'stalker_%')
           AND UPPER(c.name) ~ $2
           AND LOWER(c.name) NOT LIKE '%sport%'
           AND LOWER(c.name) NOT LIKE '%nfl %'
           AND LOWER(c.name) NOT LIKE '%nba %'
           AND LOWER(c.name) NOT LIKE '%mlb %'
           AND LOWER(c.name) NOT LIKE '%nhl %'
           LIMIT 100`,
          [source.id, `\\y(${callSignPattern})\\y`]
        );

        logger.info(`[Local News] Source ${source.id} returned ${channelsResult.rows.length} channels`);

        for (const channel of channelsResult.rows) {
          if (excludeChannelSet.has(channel.channel_id)) continue;

          // Determine which call sign matched and get station info
          const matchedStation = localStations.find(s =>
            channel.name.toUpperCase().includes(s.call_sign)
          );

          // Score: exact city match = 100, same state = 50
          const isExactCity = matchedStation && matchedStation.city.toLowerCase() === city.toLowerCase();
          const score = isExactCity ? 100 : 50;

          candidateChannels.push({
            ...channel,
            localScore: score,
            matchedStation,
            source_id: source.id,
            source_name: source.name,
            source_type: source.type,
            source_url: source.url,
            source_username: source.username,
            source_password: source.password,
            source_mac: source.mac_address
          });
        }
      } catch (sourceError) {
        logger.warn(`[Local News] Error searching source ${source.id}:`, sourceError.message);
      }
    }

    // Sort by score (exact city first) then diversify by server
    candidateChannels.sort((a, b) => b.localScore - a.localScore);

    // Diversify by server URL to avoid testing all from one dead server
    const diversifyByServer = (channels, limit) => {
      const serverGroups = new Map();
      for (const channel of channels) {
        const serverKey = channel.stream_url?.split('/live/')[0] || 'unknown';
        if (!serverGroups.has(serverKey)) {
          serverGroups.set(serverKey, []);
        }
        serverGroups.get(serverKey).push(channel);
      }

      const diversified = [];
      let hasMore = true;
      let idx = 0;
      while (hasMore && diversified.length < limit) {
        hasMore = false;
        for (const [server, chans] of serverGroups) {
          if (idx < chans.length && diversified.length < limit) {
            diversified.push(chans[idx]);
            hasMore = true;
          }
        }
        idx++;
      }
      return diversified;
    };

    // Log server distribution for debugging
    const serverCounts = new Map();
    for (const ch of candidateChannels) {
      const server = ch.stream_url?.split('/live/')[0] || 'unknown';
      serverCounts.set(server, (serverCounts.get(server) || 0) + 1);
    }
    logger.info(`[Local News] Server distribution: ${[...serverCounts.entries()].map(([s,c]) => `${s}:${c}`).join(', ')}`);

    candidateChannels = diversifyByServer(candidateChannels, 50);

    logger.info(`[Local News] Found ${candidateChannels.length} candidate channels after diversification`);

    // Log top candidates for debugging
    if (candidateChannels.length > 0) {
      const topChannels = candidateChannels.slice(0, 10).map(c => `${c.name} (score:${c.localScore})`);
      logger.info(`[Local News] Top candidates: ${topChannels.join(', ')}`);
    }

    if (candidateChannels.length === 0) {
      return res.json({
        success: false,
        message: `No news channels found for ${city}, ${state}`
      });
    }

    // Test channels until we find a working one
    const minHeight = parseInt(minQuality) || 0;
    const PARALLEL_TESTS = 5;
    const FFPROBE_TIMEOUT = 5000;

    for (let i = 0; i < candidateChannels.length; i += PARALLEL_TESTS) {
      const batch = candidateChannels.slice(i, i + PARALLEL_TESTS);

      const testPromises = batch.map(async (channel, index) => {
        try {
          // Build stream URL
          let streamUrl = channel.stream_url;
          let ffprobeHeaders = null;

          if (!streamUrl) {
            // Build URL based on source type
            if (channel.source_type === 'xtream' && channel.source_url && channel.source_username && channel.source_password) {
              const channelNum = channel.channel_id.replace(/^xtream_/, '');
              const baseUrl = channel.source_url.replace(/\/+$/, '');
              streamUrl = `${baseUrl}/live/${channel.source_username}/${channel.source_password}/${channelNum}.ts`;
            }
          }

          // Handle Stalker portal - need to get fresh token
          if (channel.source_type === 'stalker' && streamUrl && streamUrl.includes('portal.php') && streamUrl.includes('action=create_link')) {
            try {
              const axios = require('axios');
              const stalkerHeaders = {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                'X-User-Agent': 'Model: MAG250; Link: WiFi'
              };
              if (channel.source_mac) {
                stalkerHeaders['Cookie'] = `mac=${channel.source_mac}; stb_lang=en; timezone=America/New_York`;
              }

              const createLinkResponse = await axios.get(streamUrl, {
                headers: stalkerHeaders,
                timeout: 5000
              });

              if (createLinkResponse.data?.js?.cmd) {
                const freshCmd = createLinkResponse.data.js.cmd;
                // Extract fresh play_token from response
                const freshTokenMatch = freshCmd.match(/play_token=([^&\s"]+)/);
                const freshToken = freshTokenMatch ? freshTokenMatch[1] : null;

                // Extract stream ID from ORIGINAL URL (some portals return empty stream in response)
                const originalCmdMatch = streamUrl.match(/cmd=([^&]+)/);
                if (originalCmdMatch && freshToken) {
                  const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                  // Extract the original stream ID
                  const originalStreamMatch = originalCmd.match(/stream=(\d+)/);
                  const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                  if (originalStreamId) {
                    // Build fresh URL with original stream ID and fresh token
                    const baseUrlMatch = freshCmd.match(/http[s]?:\/\/[^\/]+/);
                    const macParam = channel.source_mac ? `mac=${channel.source_mac}` : '';
                    if (baseUrlMatch) {
                      streamUrl = `${baseUrlMatch[0]}/play/live.php?${macParam}&stream=${originalStreamId}&extension=ts&play_token=${freshToken}`;
                      ffprobeHeaders = `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`;
                    }
                  }
                }

                // Fallback: try to extract URL directly from response if above didn't work
                if (!streamUrl || streamUrl.includes('portal.php')) {
                  const match = freshCmd.match(/http[s]?:\/\/[^\s"]+/);
                  if (match && !match[0].includes('stream=&')) {
                    streamUrl = match[0];
                    ffprobeHeaders = `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`;
                  }
                }
              }
            } catch (stalkerErr) {
              return { success: false, reason: `Stalker auth failed: ${stalkerErr.message}`, index };
            }
          }

          if (!streamUrl) {
            return { success: false, reason: 'No stream URL', index };
          }

          // Test with ffprobe (execFileAsync is imported from streamAgents
          // at the top of this file). A leftover local redeclaration via
          // `promisify(execFile)` was throwing a ReferenceError on every
          // attempt after the route-split refactor, which is why every
          // news channel was being reported dead and the endpoint always
          // returned "No working news streams found".
          const ffprobeArgs = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,codec_name',
            '-of', 'json',
            '-timeout', String(FFPROBE_TIMEOUT * 1000)
          ];

          if (ffprobeHeaders) {
            ffprobeArgs.push('-headers', ffprobeHeaders);
          }
          ffprobeArgs.push(streamUrl);

          const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, { timeout: FFPROBE_TIMEOUT + 2000 });

          const probeData = JSON.parse(stdout);
          const videoStream = probeData.streams?.[0];

          if (videoStream) {
            const height = videoStream.height || 0;
            if (minHeight > 0 && height < minHeight) {
              return { success: false, reason: `Quality too low (${height}p)`, index };
            }
            return { success: true, height, channel, index };
          }

          return { success: false, reason: 'No video stream', index };
        } catch (error) {
          return { success: false, reason: error.message, index };
        }
      });

      const results = await Promise.all(testPromises);

      // Log failed tests for debugging
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        logger.info(`[Local News] Batch ${Math.floor(i / PARALLEL_TESTS) + 1} failures: ${failed.map(f => `${batch[f.index]?.name}: ${f.reason}`).join(', ')}`);
      }

      const workingResult = results.find(r => r.success);

      if (workingResult) {
        const channel = workingResult.channel;

        logger.info(`[Local News] Found working news channel: ${channel.name} (${workingResult.height}p)`);

        return res.json({
          success: true,
          channel: {
            id: channel.channel_id,
            name: channel.name,
            logo: channel.logo_url,
            url: channel.stream_url,
            category: channel.category,
            sourceId: channel.source_id,
            sourceType: channel.source_type,
            sourceUrl: channel.source_url,
            sourceUsername: channel.source_username,
            sourcePassword: channel.source_password,
            sourceMac: channel.source_mac,
            sourceName: channel.source_name,
            quality: workingResult.height,
            localScore: channel.localScore
          },
          location: { city, state, stateAbbrev },
          message: `Found local news for ${city}, ${state}`
        });
      }
    }

    return res.json({
      success: false,
      message: `No working news streams found for ${city}, ${state}. Try adding more IPTV sources.`
    });

  } catch (error) {
    logger.error('[Local News] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
