/**
 * POST /api/live-events/random-working-stream
 * Find a random working stream from currently live events.
 * Optionally filter by sport/league and exclude events already in multiview.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { execFileAsync, httpAgent, httpsAgent } = require('../../utils/streamAgents');
const { extractSearchTerms } = require('../../utils/channelScoring');
const teamMatcher = require('../../utils/teamMatcher');
const teamAliasesService = require('../../services/teamAliasesService');

/**
 * POST /api/live-events/random-working-stream
 * Find a random working stream from currently live events
 * Optionally filter by sport/league and exclude events already in multiview
 */
router.post('/random-working-stream', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Random working stream: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { sportType, leagueName, excludeEventIds = [], excludeSourceIds = [] } = req.body;

    // Fetch blacklisted channels from database
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    logger.info(`Finding random working stream (sport: ${sportType || 'any'}, league: ${leagueName || 'any'}, excludedEvents: ${excludeEventIds.length}, excludedSources: ${excludeSourceIds.length}, blacklistedChannels: ${blacklistedChannels.length})`);

    // Build query for currently live events (PostgreSQL). "Live" =
    // advertised window OR ESPN's is_live flag — keeps MLS/soccer
    // games in scope when stoppage time has pushed past event_end.
    const conditions = [
      '((event_start <= $1 AND event_end >= $2) OR (is_live = TRUE AND event_end >= $3))',
      "(status_type IS NULL OR status_type NOT LIKE '%FINAL%')"
    ];
    const now = new Date().toISOString();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const params = [now, now, halfHourAgo];
    let paramIndex = 4;

    if (sportType) {
      conditions.push(`sport_type = $${paramIndex}`);
      params.push(sportType);
      paramIndex++;
    }

    if (leagueName) {
      conditions.push(`league_name = $${paramIndex}`);
      params.push(leagueName);
      paramIndex++;
    }

    if (excludeEventIds.length > 0) {
      const placeholders = excludeEventIds.map((_, i) => `$${paramIndex + i}`).join(', ');
      conditions.push(`event_id NOT IN (${placeholders})`);
      params.push(...excludeEventIds);
    }

    // Get all matching live events
    const eventsResult = await postgresService.query(`
      SELECT * FROM live_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY RANDOM()
    `, params);

    const events = eventsResult.rows || [];

    if (events.length === 0) {
      logger.info('No events found matching criteria');
      return res.status(404).json({
        success: false,
        error: 'No live events found matching criteria',
        message: sportType
          ? `No live ${sportType} events available`
          : 'No live events available'
      });
    }

    logger.info(`Found ${events.length} matching live events, testing channels...`);

    // Try to find a working channel from each event (randomized order)
    for (const event of events) {
      // Extract team names and keywords (same logic as /:eventId/channels)
      const homeTeam = event.home_team || '';
      const awayTeam = event.away_team || '';

      // Use the new extractSearchTerms function for robust term extraction
      const homeTerms = extractSearchTerms(homeTeam);
      const awayTerms = extractSearchTerms(awayTeam);
      const searchTerms = [...new Set([...homeTerms, ...awayTerms])]; // Dedupe

      if (searchTerms.length === 0) {
        logger.debug(`Event ${event.event_id} has no team names, skipping`);
        continue;
      }

      // Search for matching channels (PostgreSQL)
      const channelConditions = searchTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
      const searchParams = searchTerms.map(term => `%${term}%`);

      // Build source exclusion clause
      let sourceExclusion = '';
      let queryParams = [userId, ...searchParams];

      if (excludeSourceIds.length > 0) {
        logger.debug(`Excluding sources: ${excludeSourceIds.join(', ')}`);
        const sourceParamIndex = queryParams.length + 1;
        const sourcePlaceholders = excludeSourceIds.map((_, i) => `$${sourceParamIndex + i}`).join(', ');
        sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
        queryParams.push(...excludeSourceIds);
      } else {
        logger.debug('No sources to exclude');
      }

      // Use blacklist from frontend (user-customizable)
      let blacklistConditions = '1=1'; // Default to no blacklist filtering

      if (blacklistedChannels && blacklistedChannels.length > 0) {
        blacklistConditions = blacklistedChannels.map((name, i) => {
          const paramIndex = queryParams.length + 1 + i;
          queryParams.push(name);
          return `c.name != $${paramIndex}`;
        }).join(' AND ');

        logger.debug(`Blacklisting ${blacklistedChannels.length} channels: ${blacklistedChannels.join(', ')}`);
      }

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
        WHERE s.user_id = $1 AND (${channelConditions}) ${sourceExclusion} AND ${blacklistConditions}
        ORDER BY RANDOM()
      `, queryParams);

      let channels = channelsResult.rows || [];

      if (channels.length === 0) {
        logger.debug(`No channels found for event ${event.event_id}`);
        continue;
      }

      // Alias-aware ranking so the best candidates get ffprobed first
      // (matchup channels > team channels > EPG-confirmed generics >
      // everything else). Falls back to the original random order when
      // the league isn't in team_aliases.
      let homeBundle = null;
      let awayBundle = null;
      if (event.league_name) {
        try {
          [homeBundle, awayBundle] = await Promise.all([
            teamAliasesService.getAliasesForTeam(event.league_name, event.home_team),
            teamAliasesService.getAliasesForTeam(event.league_name, event.away_team)
          ]);
        } catch (err) {
          logger.warn(`[RandomWorkingStream] Alias lookup failed: ${err.message}`);
        }
      }

      if (homeBundle && awayBundle) {
        // EPG lookup for "what's airing right now" on each candidate.
        const epgByTvgId = new Map();
        const tvgIds = channels.map(c => c.epg_channel_id).filter(Boolean);
        if (tvgIds.length > 0) {
          try {
            const { rows } = await postgresService.query(
              `SELECT DISTINCT ON (channel_id) channel_id, title
                 FROM epg_programs
                WHERE channel_id = ANY($1)
                  AND start_time <= NOW()
                  AND stop_time > NOW()
                ORDER BY channel_id, start_time DESC`,
              [tvgIds]
            );
            for (const r of rows) epgByTvgId.set(r.channel_id, r.title);
          } catch (err) {
            logger.warn(`[RandomWorkingStream] EPG lookup failed: ${err.message}`);
          }
        }

        const ctx = { sportType: event.sport_type, leagueName: event.league_name };
        channels = channels.map(c => {
          const program = epgByTvgId.get(c.epg_channel_id) || null;
          const r = teamMatcher.matchChannel(
            { name: c.name, currentProgramTitle: program },
            homeBundle.tiered,
            awayBundle.tiered,
            ctx
          );
          return { ...c, _matchScore: r.score, _matchDetails: r.details };
        });
        channels.sort((a, b) => b._matchScore - a._matchScore);
        channels = channels.filter(c => c._matchScore >= 50);
        const top = channels.slice(0, 5).map(c => `${c.name.substring(0, 40)}:${c._matchScore}`);
        if (top.length) logger.info(`[RandomWorkingStream] Top candidates for "${event.event_name}": ${top.join(' | ')}`);
      }

      logger.info(`Found ${channels.length} channels for event ${event.event_name}, testing streams...`);

      // Validate streams using ffprobe for M3U/XTREAM (industry standard for IPTV validation)
      // For Stalker, use simpler HTTP validation since ffprobe struggles with portal auth

      for (const channel of channels) {
        try {
          logger.debug(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);

          // Build the actual stream URL based on source type
          let testUrl = channel.url;

          if (channel.source_type === 'xtream' && channel.source_url && channel.source_username && channel.source_password) {
            // For XTREAM sources, construct the proper live stream URL
            const baseUrl = channel.source_url.replace(/\/$/, '');
            const streamId = channel.url.split('/').pop();
            testUrl = `${baseUrl}/live/${channel.source_username}/${channel.source_password}/${streamId}`;
          }

          // Use different validation based on source type
          if (channel.source_type === 'stalker') {
            // Stalker: request fresh link from portal, then validate with ffprobe
            // Stalker URLs are portal.php?action=create_link which returns a token
            if (testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
              logger.debug(`Requesting fresh Stalker token from portal...`);

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

              if (!linkData?.js?.cmd) {
                throw new Error('Invalid create_link response - no cmd found');
              }

              // Extract actual stream URL from cmd
              const freshCmd = linkData.js.cmd;
              const match = freshCmd.match(/ffmpeg\s+(.+)/);
              if (!match || !match[1]) {
                throw new Error('Could not extract stream URL from cmd');
              }

              let freshUrl = match[1];

              // Extract play_token from fresh URL
              const freshTokenMatch = freshUrl.match(/play_token=([^&]+)/);
              const freshToken = freshTokenMatch ? freshTokenMatch[1] : null;

              // Some Stalker portals return empty stream parameter - need to use original
              const originalCmdMatch = testUrl.match(/cmd=([^&]+)/);
              if (originalCmdMatch && freshToken) {
                const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                if (originalStreamId) {
                  // Check if fresh URL has empty stream parameter
                  if (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/)) {
                    logger.debug(`Portal returned empty stream ID - using original: ${originalStreamId}`);
                    freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
                  }
                }
              }

              // Replace localhost with actual server if needed
              if (freshUrl.includes('localhost')) {
                const sourceUrl = new URL(testUrl);
                const serverAddress = `${sourceUrl.protocol}//${sourceUrl.host}`;
                freshUrl = freshUrl.replace(/http:\/\/localhost/g, serverAddress);
              }

              // Now validate the fresh stream URL with ffprobe
              testUrl = freshUrl;
              logger.debug(`Got fresh Stalker URL with token: ${freshUrl.substring(0, 100)}...`);
            }

            // Validate Stalker stream with ffprobe now that we have the real URL
            const ffprobeArgs = [
              '-v', 'error',
              '-print_format', 'json',
              '-show_streams',
              '-show_packets',
              '-read_intervals', '%+4',
              '-rw_timeout', '5000000',
              '-headers', `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`,
              testUrl
            ];

            const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
              timeout: 10000,
              maxBuffer: 1024 * 1024
            });

            const probeData = JSON.parse(stdout);

            if (!probeData.streams || probeData.streams.length === 0) {
              throw new Error('No streams found in ffprobe output');
            }

            const hasVideo = probeData.streams.some(s => s.codec_type === 'video');
            const hasAudio = probeData.streams.some(s => s.codec_type === 'audio');

            if (!hasVideo && !hasAudio) {
              throw new Error('No valid video or audio streams detected');
            }

            logger.info(`✓ Channel ${channel.name} is WORKING! Streams: ${probeData.streams.length} (video: ${hasVideo}, audio: ${hasAudio})`);
          } else {
            // M3U/XTREAM: use ffprobe for proper stream validation
            const ffprobeArgs = [
              '-v', 'error',              // Show errors only
              '-print_format', 'json',    // JSON output for parsing
              '-show_streams',            // Show stream info
              '-read_intervals', '%+#1',  // Read only first packet
              '-timeout', '8000000',      // 8 second timeout (in microseconds)
              testUrl
            ];

            const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
              timeout: 10000,  // 10 second process timeout
              maxBuffer: 1024 * 1024 // 1MB buffer
            });

            // Parse ffprobe output
            const probeData = JSON.parse(stdout);

            if (!probeData.streams || probeData.streams.length === 0) {
              throw new Error('No streams found in ffprobe output');
            }

            // Check if there's at least one video or audio stream
            const hasVideo = probeData.streams.some(s => s.codec_type === 'video');
            const hasAudio = probeData.streams.some(s => s.codec_type === 'audio');

            if (!hasVideo && !hasAudio) {
              throw new Error('No valid video or audio streams detected');
            }

            logger.info(`✓ Channel ${channel.name} is WORKING! Streams: ${probeData.streams.length} (video: ${hasVideo}, audio: ${hasAudio})`);
          }

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
              espnEventId: event.event_id,
              espnEventName: event.event_name
            },
            event: {
              id: event.event_id,
              name: event.event_name,
              homeTeam: event.home_team,
              awayTeam: event.away_team,
              league: event.league_name,
              sport: event.sport_type
            }
          });
        } catch (testError) {
          logger.debug(`✗ Channel ${channel.name} test failed: ${testError.message}`);
          continue;
        }
      }
    }

    // No working channel found
    logger.info('No working channels found for any matching events');
    res.status(404).json({
      success: false,
      error: 'No working streams found',
      message: 'Could not find a working stream for the selected sport'
    });
  } catch (error) {
    logger.error('Random working stream failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
