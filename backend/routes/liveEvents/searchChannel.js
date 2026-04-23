/**
 * POST /api/live-events/search-channel
 * Search IPTV channels by free-form query and return candidates ranked by
 * fuzzy relevance against the query terms.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { execFileAsync, httpAgent, httpsAgent } = require('../../utils/streamAgents');
const { extractSearchTerms, calculateRelevanceScore } = require('../../utils/channelScoring');

/**
 * POST /api/live-events/search-channel
 * Search for a channel by name and return a working stream
 * Avoids sources already in use in multiview
 * Uses incremental batching - fetches 50 channels at a time, tests them,
 * and continues fetching more batches until a working stream is found or all exhausted
 */
router.post('/search-channel', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { query, excludeSourceIds = [], excludeChannelIds = [], minQuality = 0, searchOffset = 0 } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    }

    const searchQuery = query.trim();
    const minHeight = parseInt(minQuality) || 0;
    const startOffset = parseInt(searchOffset) || 0;

    logger.info(`[Find Alternative] Received search request: query="${searchQuery}", offset=${startOffset}, minQuality=${minHeight}p`);

    // Fetch blacklisted channels
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    // Extract search terms using fuzzy matching logic (handles event names like "Temple Owls at Villanova Wildcats")
    const eventMatch = searchQuery.match(/^(.+?)\s+(?:at|vs\.?|@)\s+(.+?)$/i);
    let searchTerms;
    let homeTeam = null;
    let awayTeam = null;

    if (eventMatch) {
      awayTeam = eventMatch[1].trim();
      homeTeam = eventMatch[2].trim();
      const homeTerms = extractSearchTerms(homeTeam);
      const awayTerms = extractSearchTerms(awayTeam);
      searchTerms = [...new Set([...homeTerms, ...awayTerms])];
      logger.info(`Search channel: Detected event format - home: "${homeTeam}", away: "${awayTeam}", terms: ${searchTerms.join(', ')}`);
    } else {
      searchTerms = [searchQuery];
      logger.info(`Search channel: Simple search for "${searchQuery}"`);
    }

    logger.info(`Searching for channel: "${searchQuery}" (excludedSources: ${excludeSourceIds.length}, excludedChannels: ${excludeChannelIds.length}, minQuality: ${minHeight}p)`);

    // Build base query parameters (without LIMIT/OFFSET which will be added per batch)
    const channelConditions = searchTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
    const searchParams = searchTerms.map(term => `%${term}%`);
    let baseQueryParams = [userId, ...searchParams];

    // Build scoring conditions for SQL
    let scoringCase = null;
    if (homeTeam && awayTeam) {
      scoringCase = 'CASE ';
      scoringCase += `WHEN LOWER(c.name) LIKE LOWER('%${homeTeam.replace(/'/g, "''")}%') AND LOWER(c.name) LIKE LOWER('%${awayTeam.replace(/'/g, "''")}%') THEN 3 `;
      scoringCase += `WHEN LOWER(c.name) LIKE LOWER('%${homeTeam.replace(/'/g, "''")}%') THEN 2 `;
      scoringCase += 'ELSE 1 END';
    }

    // Build source exclusion clause
    let sourceExclusion = '';
    if (excludeSourceIds.length > 0) {
      const sourceParamIndex = baseQueryParams.length + 1;
      const sourcePlaceholders = excludeSourceIds.map((_, i) => `$${sourceParamIndex + i}`).join(', ');
      sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
      baseQueryParams.push(...excludeSourceIds);
    }

    // Build channel exclusion clause
    let channelExclusion = '';
    if (excludeChannelIds.length > 0) {
      const channelParamIndex = baseQueryParams.length + 1;
      const channelPlaceholders = excludeChannelIds.map((_, i) => `$${channelParamIndex + i}`).join(', ');
      channelExclusion = `AND c.channel_id NOT IN (${channelPlaceholders})`;
      baseQueryParams.push(...excludeChannelIds);
    }

    // Build blacklist conditions
    let blacklistConditions = '1=1';
    if (blacklistedChannels.length > 0) {
      const startParamIndex = baseQueryParams.length + 1;
      const blacklistPlaceholders = blacklistedChannels.map((name, i) => {
        return `c.name != $${startParamIndex + i}`;
      });
      baseQueryParams.push(...blacklistedChannels);
      blacklistConditions = blacklistPlaceholders.join(' AND ');
    }

    const orderClause = scoringCase ? `${scoringCase} DESC, c.name` : 'c.name';

    // Helper function to test a single channel
    const testSingleChannel = async (channel, index) => {
      try {
        let testUrl = channel.url;

        // Build proper URL for XTREAM sources
        if (channel.source_type === 'xtream' && channel.source_url && channel.source_username && channel.source_password) {
          const baseUrl = channel.source_url.replace(/\/$/, '');
          const streamId = channel.url.split('/').pop();
          testUrl = `${baseUrl}/live/${channel.source_username}/${channel.source_password}/${streamId}`;
        }

        // Handle Stalker portals
        if (channel.source_type === 'stalker' && testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
          try {
            const createLinkResponse = await axios.get(testUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                'X-User-Agent': 'Model: MAG250; Link: WiFi',
                'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
              },
              timeout: 5000,
              httpAgent,
              httpsAgent
            });

            const linkData = createLinkResponse.data;
            if (linkData?.js?.cmd) {
              const freshCmd = linkData.js.cmd;
              const match = freshCmd.match(/ffmpeg\s+(.+)/);
              if (match && match[1]) {
                let freshUrl = match[1];

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
          } catch (stalkerError) {
            return { success: false, reason: `Stalker refresh failed: ${stalkerError.message}`, index };
          }
        }

        // Validate with ffprobe
        const ffprobeArgs = [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          '-read_intervals', '%+#1',
          '-timeout', '5000000'
        ];

        if (channel.source_type === 'stalker') {
          ffprobeArgs.push('-headers', `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`);
        }

        ffprobeArgs.push(testUrl);

        const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
          timeout: 5000,
          maxBuffer: 1024 * 1024
        });

        const probeData = JSON.parse(stdout);
        const videoStream = probeData.streams && probeData.streams.find(s => s.codec_type === 'video');
        const hasAudio = probeData.streams && probeData.streams.some(s => s.codec_type === 'audio');

        if (videoStream) {
          const streamHeight = videoStream.height || 0;
          return { success: true, height: streamHeight, hasAudio, channel, index };
        }

        return { success: false, reason: hasAudio ? 'Audio-only stream (no video)' : 'No video stream', index };
      } catch (error) {
        return { success: false, reason: error.message.split('\n')[0], index };
      }
    };

    // Incremental batch processing
    const BATCH_SIZE = 50;
    const PARALLEL_TESTS = 5;
    const MAX_BATCHES = 20; // Safety limit: 20 batches = 1000 channels max
    let currentDbOffset = startOffset;
    let totalChannelsTested = 0;
    let totalChannelsMatched = 0;
    let lowQualitySkipped = 0;

    for (let batchNum = 0; batchNum < MAX_BATCHES; batchNum++) {
      // Fetch next batch from database
      const limitParamIndex = baseQueryParams.length + 1;
      const offsetParamIndex = baseQueryParams.length + 2;
      const batchQueryParams = [...baseQueryParams, BATCH_SIZE, currentDbOffset];

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
        WHERE s.user_id = $1
          AND (${channelConditions})
          ${sourceExclusion}
          ${channelExclusion}
          AND ${blacklistConditions}
        ORDER BY ${orderClause}
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      `, batchQueryParams);

      let channels = channelsResult.rows || [];

      if (channels.length === 0) {
        // No more channels to fetch
        if (batchNum === 0) {
          return res.json({
            success: false,
            error: 'No channels found',
            message: `No channels found matching "${searchQuery}"`
          });
        }
        break;
      }

      totalChannelsMatched += channels.length;
      logger.info(`[Batch ${batchNum + 1}] Fetched ${channels.length} channels (offset: ${currentDbOffset})`);

      // Apply relevance scoring for event searches
      if (homeTeam || awayTeam) {
        channels = channels.map(channel => {
          const score = calculateRelevanceScore(channel.name, homeTeam, awayTeam);
          return { ...channel, relevanceScore: score };
        });

        channels.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // For event searches with both teams, require higher relevance to avoid
        // false positives like "Louisville" matching "Louis" or "Yorkshire" matching "York"
        // Score 200 = at least one full team name matched, or both teams partially matched
        // Score 100 = only one partial match (too loose for event searches)
        const minScore = (homeTeam && awayTeam) ? 200 : 100;
        const beforeFilter = channels.length;
        channels = channels.filter(c => c.relevanceScore >= minScore);

        if (beforeFilter > channels.length) {
          logger.info(`[Batch ${batchNum + 1}] Filtered ${beforeFilter - channels.length} low-relevance channels (minScore: ${minScore})`);
        }

        if (channels.length === 0) {
          logger.info(`[Batch ${batchNum + 1}] All channels filtered by relevance (minScore: ${minScore}), fetching next batch...`);
          currentDbOffset += BATCH_SIZE;
          continue;
        }

        if (batchNum === 0) {
          const topChannels = channels.slice(0, 5).map(c => `${c.name.substring(0, 40)}: ${c.relevanceScore}`);
          logger.info(`Top scoring channels: ${topChannels.join(' | ')}`);
        }
      }

      // Test channels in parallel batches
      for (let i = 0; i < channels.length; i += PARALLEL_TESTS) {
        const chunk = channels.slice(i, i + PARALLEL_TESTS);
        const results = await Promise.all(chunk.map((channel, chunkIndex) => {
          const globalIndex = i + chunkIndex;
          logger.info(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);
          return testSingleChannel(channel, globalIndex);
        }));

        totalChannelsTested += chunk.length;

        // Check results for a working channel
        const successfulResults = results.filter(r => r.success).sort((a, b) => a.index - b.index);

        for (const result of successfulResults) {
          const channel = result.channel;
          const streamHeight = result.height;

          // Check quality requirement
          if (minHeight > 0 && streamHeight < minHeight) {
            logger.info(`✗ Channel ${channel.name} quality too low: ${streamHeight}p < ${minHeight}p`);
            lowQualitySkipped++;
            continue;
          }

          logger.info(`✓ Found working channel: ${channel.name} (${streamHeight}p) after testing ${totalChannelsTested} channels`);

          // Calculate next offset for future searches
          const nextSearchOffset = currentDbOffset + i + result.index + 1;

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
              sourceUrl: channel.source_url,
              sourceUsername: channel.source_username,
              sourcePassword: channel.source_password,
              sourceMac: channel.source_mac,
              category: channel.category,
              quality: streamHeight,
              searchQuery: searchQuery,
              searchOffset: nextSearchOffset
            }
          });
        }

        // Log failed results
        for (const result of results) {
          if (!result.success) {
            const channel = channels[result.index];
            if (channel) {
              logger.info(`✗ Channel ${channel.name} failed: ${result.reason}`);
            }
          }
        }
      }

      // Move to next batch
      currentDbOffset += BATCH_SIZE;

      // If we got fewer than BATCH_SIZE, we've exhausted results
      if (channelsResult.rows.length < BATCH_SIZE) {
        break;
      }
    }

    // Build informative error message
    let errorMessage;
    if (lowQualitySkipped > 0 && minHeight > 0) {
      errorMessage = `Tested ${totalChannelsTested} channels matching "${searchQuery}" - ${lowQualitySkipped} were working but below ${minHeight}p quality`;
    } else {
      errorMessage = `Tested ${totalChannelsTested} of ${totalChannelsMatched} channels matching "${searchQuery}" but none were working`;
    }

    logger.info(`[Find Alternative] Search exhausted: ${errorMessage}`);

    return res.json({
      success: false,
      error: 'No working streams found',
      message: errorMessage
    });

  } catch (error) {
    logger.error('Search channel failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
