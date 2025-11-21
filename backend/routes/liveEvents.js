/**
 * Live Events Routes
 * API endpoints for managing live sports events data
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const liveEventsService = require('../services/liveEventsService');

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * POST /api/live-events/refresh
 * Manually trigger live events refresh from TheSportsDB API
 */
router.post('/refresh', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Refresh live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`User ${userId} triggered live events refresh`);

    // Trigger refresh (ESPN API automatically returns today's and upcoming games)
    const result = await liveEventsService.refreshLiveEvents();

    if (result.success) {
      return res.json({
        success: true,
        message: `Successfully fetched ${result.totalFetched} events, stored ${result.totalStored} events`,
        ...result
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        message: 'Failed to refresh live events'
      });
    }
  } catch (error) {
    logger.error('Refresh live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/current
 * Get currently live events
 */
router.get('/current', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get current live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const liveEvents = await liveEventsService.getCurrentlyLiveEvents();

    res.json({
      success: true,
      events: liveEvents,
      count: liveEvents.length
    });
  } catch (error) {
    logger.error('Get current live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/upcoming
 * Get upcoming events in the next N hours
 */
router.get('/upcoming', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get upcoming live events: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hoursAhead = parseInt(req.query.hours) || 24;
    const iptvDatabaseService = require('../services/iptvDatabase');
    const db = await iptvDatabaseService.connect();

    const now = new Date().toISOString();
    const futureTime = new Date(Date.now() + (hoursAhead * 60 * 60 * 1000)).toISOString();

    const events = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM live_events
        WHERE event_start >= ? AND event_start <= ?
        ORDER BY event_start
      `, [now, futureTime], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json({
      success: true,
      events,
      count: events.length,
      hoursAhead
    });
  } catch (error) {
    logger.error('Get upcoming live events failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/live-sports-summary
 * Get summary of currently live sports with event counts
 * Optionally exclude events already in multiview
 */
router.get('/live-sports-summary', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get live sports summary: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get excluded event IDs from query params
    const excludeEventIds = req.query.excludeEventIds
      ? (Array.isArray(req.query.excludeEventIds) ? req.query.excludeEventIds : [req.query.excludeEventIds])
      : [];

    logger.info(`Getting live sports summary (excluding ${excludeEventIds.length} events)`);

    const postgresService = require('../services/postgresService');

    // Build exclusion clause for PostgreSQL
    const exclusionClause = excludeEventIds.length > 0
      ? `AND event_id NOT IN (${excludeEventIds.map((_, i) => `$${i + 3}`).join(', ')})`
      : '';

    // Get currently live events grouped by sport and league
    const query = `
      SELECT
        sport_type,
        league_name,
        COUNT(*) as event_count
      FROM live_events
      WHERE event_start <= $1 AND event_end >= $2
      ${exclusionClause}
      GROUP BY sport_type, league_name
      HAVING COUNT(*) > 0
      ORDER BY COUNT(*) DESC, sport_type, league_name
    `;
    const params = [new Date().toISOString(), new Date().toISOString(), ...excludeEventIds];

    const result = await postgresService.query(query, params);
    const sportsSummary = result.rows || [];

    logger.info(`Found ${sportsSummary.length} sport/league combinations with live events`);

    res.json({
      success: true,
      sports: sportsSummary,
      count: sportsSummary.length,
      excludedCount: excludeEventIds.length
    });
  } catch (error) {
    logger.error('Get live sports summary failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

    const postgresService = require('../services/postgresService');

    // Fetch blacklisted channels from database
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    logger.info(`Finding random working stream (sport: ${sportType || 'any'}, league: ${leagueName || 'any'}, excludedEvents: ${excludeEventIds.length}, excludedSources: ${excludeSourceIds.length}, blacklistedChannels: ${blacklistedChannels.length})`);

    // Build query for currently live events (PostgreSQL)
    const conditions = ['event_start <= $1', 'event_end >= $2'];
    const params = [new Date().toISOString(), new Date().toISOString()];
    let paramIndex = 3;

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

      const cleanTeamName = (teamName) => {
        let cleaned = teamName
          .replace(/^(FC|CF|US|AS|AC|SC|VfL|SV|TSG|1\.|RB|CD|UD)\s+/i, '')
          .replace(/\s+(FC|CF|United|City|Town|Hotspur|Wanderers|Athletic|Rovers)$/i, '')
          .trim();

        cleaned = cleaned
          .replace(/\s+(Aggies|Anteaters|Bears|Bruins|Bulldogs|Cardinals|Cougars|Crimson Tide|Ducks|Eagles|Falcons|Gators|Hawkeyes|Huskies|Jayhawks|Knights|Lions|Longhorns|Mountaineers|Musketeers|Nittany Lions|Panthers|Razorbacks|Rebels|Seminoles|Sooners|Spartans|Sun Devils|Tar Heels|Terrapins|Tigers|Trojans|Utes|Volunteers|Wildcats|Wolverines|Badgers|Buckeyes|Cornhuskers|Cyclones|Fighting Irish|Golden Bears|Hokies|Horned Frogs|Hurricanes|Orange|Orangemen|Red Raiders|Scarlet Knights|Demon Deacons|Blue Devils|Gamecocks|Hoosiers|Boilermakers|Golden Gophers|Huskers|Huskies|Thundering Herd|Mean Green|Fighting Hawks|Chanticleers|Ragin' Cajuns|Warhawks|Red Foxes|Gaels|Bruins|Leathernecks)$/i, '')
          .trim();

        return cleaned;
      };

      const homeTeamClean = homeTeam ? cleanTeamName(homeTeam) : '';
      const awayTeamClean = awayTeam ? cleanTeamName(awayTeam) : '';

      const searchTerms = [];
      if (homeTeam) {
        searchTerms.push(homeTeam);
        if (homeTeamClean !== homeTeam) searchTerms.push(homeTeamClean);
      }
      if (awayTeam) {
        searchTerms.push(awayTeam);
        if (awayTeamClean !== awayTeam) searchTerms.push(awayTeamClean);
      }

      if (searchTerms.length === 0) {
        logger.info(`Event ${event.event_id} has no team names, skipping`);
        continue;
      }

      // Search for matching channels (PostgreSQL)
      const channelConditions = searchTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
      const searchParams = searchTerms.map(term => `%${term}%`);

      // Build source exclusion clause
      let sourceExclusion = '';
      let queryParams = [userId, ...searchParams];

      if (excludeSourceIds.length > 0) {
        logger.info(`Excluding sources: ${excludeSourceIds.join(', ')}`);
        const sourceParamIndex = queryParams.length + 1;
        const sourcePlaceholders = excludeSourceIds.map((_, i) => `$${sourceParamIndex + i}`).join(', ');
        sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
        queryParams.push(...excludeSourceIds);
      } else {
        logger.info('No sources to exclude');
      }

      // Use blacklist from frontend (user-customizable)
      let blacklistConditions = '1=1'; // Default to no blacklist filtering

      if (blacklistedChannels && blacklistedChannels.length > 0) {
        blacklistConditions = blacklistedChannels.map((name, i) => {
          const paramIndex = queryParams.length + 1 + i;
          queryParams.push(name);
          return `c.name != $${paramIndex}`;
        }).join(' AND ');

        logger.info(`Blacklisting ${blacklistedChannels.length} channels: ${blacklistedChannels.join(', ')}`);
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
        logger.info(`No channels found for event ${event.event_id}`);
        continue;
      }

      logger.info(`Found ${channels.length} channels for event ${event.event_name}, testing streams...`);

      // Validate streams using ffprobe for M3U/XTREAM (industry standard for IPTV validation)
      // For Stalker, use simpler HTTP validation since ffprobe struggles with portal auth
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const axios = require('axios');

      for (const channel of channels) {
        try {
          logger.info(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);

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
              logger.info(`Requesting fresh Stalker token from portal...`);

              const createLinkResponse = await axios.get(testUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                  'X-User-Agent': 'Model: MAG250; Link: WiFi',
                  'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
                },
                timeout: 10000
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
                    logger.info(`Portal returned empty stream ID - using original: ${originalStreamId}`);
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
              logger.info(`Got fresh Stalker URL with token: ${freshUrl.substring(0, 100)}...`);
            }

            // Validate Stalker stream with ffprobe now that we have the real URL
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
          logger.info(`✗ Channel ${channel.name} test failed: ${testError.message}`);
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

/**
 * GET /api/live-events/:eventId/channels
 * Find IPTV channels that might be showing a specific live event
 */
router.get('/:eventId/channels', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { eventId } = req.params;

    if (!userId) {
      logger.error('Get event channels: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const iptvDatabaseService = require('../services/iptvDatabase');
    const db = await iptvDatabaseService.connect();

    // Get the event details
    const event = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM live_events WHERE event_id = ?', [eventId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    logger.info(`Searching for channels matching event: ${event.event_name}`);

    // Extract team names and keywords
    const homeTeam = event.home_team || '';
    const awayTeam = event.away_team || '';
    const leagueName = event.league_name || '';
    const sportType = event.sport_type || '';

    // Extract clean team names (remove common prefixes and mascots)
    const cleanTeamName = (teamName) => {
      // First remove common soccer/football club prefixes
      let cleaned = teamName
        .replace(/^(FC|CF|US|AS|AC|SC|VfL|SV|TSG|1\.|RB|CD|UD)\s+/i, '')
        .replace(/\s+(FC|CF|United|City|Town|Hotspur|Wanderers|Athletic|Rovers)$/i, '')
        .trim();

      // Then remove common college mascot names (for NCAA sports)
      cleaned = cleaned
        .replace(/\s+(Aggies|Anteaters|Bears|Bruins|Bulldogs|Cardinals|Cougars|Crimson Tide|Ducks|Eagles|Falcons|Gators|Hawkeyes|Huskies|Jayhawks|Knights|Lions|Longhorns|Mountaineers|Musketeers|Nittany Lions|Panthers|Razorbacks|Rebels|Seminoles|Sooners|Spartans|Sun Devils|Tar Heels|Terrapins|Tigers|Trojans|Utes|Volunteers|Wildcats|Wolverines|Badgers|Buckeyes|Cornhuskers|Cyclones|Fighting Irish|Golden Bears|Hokies|Horned Frogs|Hurricanes|Orange|Orangemen|Red Raiders|Scarlet Knights|Demon Deacons|Blue Devils|Gamecocks|Hoosiers|Boilermakers|Golden Gophers|Huskers|Huskies|Thundering Herd|Mean Green|Fighting Hawks|Chanticleers|Ragin' Cajuns|Warhawks|Red Foxes|Gaels|Bruins|Leathernecks)$/i, '')
        .trim();

      return cleaned;
    };

    const homeTeamClean = homeTeam ? cleanTeamName(homeTeam) : '';
    const awayTeamClean = awayTeam ? cleanTeamName(awayTeam) : '';

    // Build search terms - ONLY team-related terms, no generic sport/league
    const searchTerms = [];

    if (homeTeam) {
      searchTerms.push(homeTeam); // Full team name
      if (homeTeamClean !== homeTeam) searchTerms.push(homeTeamClean);
    }

    if (awayTeam) {
      searchTerms.push(awayTeam); // Full team name
      if (awayTeamClean !== awayTeam) searchTerms.push(awayTeamClean);
    }

    // Build SQL query with OR conditions for team names only
    const conditions = searchTerms.map(() => 'c.name LIKE ?').join(' OR ');
    const searchParams = searchTerms.map(term => `%${term}%`);

    logger.info(`Searching for channels with terms: ${JSON.stringify(searchTerms)}`);

    // Search channels from user's sources
    let channels = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT
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
        WHERE s.user_id = ? AND (${conditions})
        ORDER BY c.name
        LIMIT 100
      `, [userId, ...searchParams], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Score and sort channels by relevance
    channels = channels.map(channel => {
      const nameLower = channel.name.toLowerCase();
      let score = 0;

      // Exact team name matches (highest priority)
      if (homeTeam && nameLower.includes(homeTeam.toLowerCase())) score += 100;
      if (awayTeam && nameLower.includes(awayTeam.toLowerCase())) score += 100;

      // Cleaned team name matches
      if (homeTeamClean && nameLower.includes(homeTeamClean.toLowerCase())) score += 50;
      if (awayTeamClean && nameLower.includes(awayTeamClean.toLowerCase())) score += 50;

      // Both teams mentioned (very relevant!)
      if (homeTeam && awayTeam &&
          nameLower.includes(homeTeam.toLowerCase()) &&
          nameLower.includes(awayTeam.toLowerCase())) {
        score += 200;
      }

      // League name bonus (lower priority)
      if (leagueName && nameLower.includes(leagueName.toLowerCase())) score += 10;

      // Sport type bonus (lowest priority)
      if (sportType && nameLower.includes(sportType.toLowerCase())) score += 5;

      return { ...channel, relevanceScore: score };
    });

    // Sort by relevance score (highest first)
    channels.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Remove channels with very low scores (likely false positives)
    channels = channels.filter(c => c.relevanceScore >= 50);

    // Limit to top 30 most relevant
    channels = channels.slice(0, 30);

    logger.info(`Found ${channels.length} matching channels for event ${eventId} (scored and filtered)`);

    // Remove relevance score from response (internal only)
    const channelsClean = channels.map(({ relevanceScore, ...channel }) => channel);

    res.json({
      success: true,
      event: {
        id: event.event_id,
        name: event.event_name,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        league: event.league_name,
        sport: event.sport_type
      },
      channels: channelsClean,
      count: channelsClean.length,
      searchTerms: searchTerms,
      scoringApplied: true
    });
  } catch (error) {
    logger.error('Get event channels failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

    const { excludeSourceIds = [] } = req.body;

    const postgresService = require('../services/postgresService');

    // Fetch blacklisted channels from database
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    logger.info(`Finding random channel from all channels (excludedSources: ${excludeSourceIds.length}, blacklistedChannels: ${blacklistedChannels.length})`);

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
      blacklistConditions = blacklistedChannels.map((name, i) => {
        const paramIndex = queryParams.length + 1 + i;
        queryParams.push(name);
        return `c.name != $${paramIndex}`;
      }).join(' AND ');

      logger.info(`Blacklisting ${blacklistedChannels.length} channels`);
    }

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
      LIMIT 50
    `, queryParams);

    let channels = channelsResult.rows || [];

    if (channels.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No channels found',
        message: 'No channels available after filtering'
      });
    }

    logger.info(`Found ${channels.length} channels, testing streams...`);

    // Test streams using same validation logic as random-working-stream
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const axios = require('axios');

    for (const channel of channels) {
      try {
        logger.info(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);

        let testUrl = channel.url;

        // Handle Stalker portals - need to refresh token
        if (channel.source_type === 'stalker' && testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
          logger.info(`Stalker portal detected, refreshing token for channel: ${channel.name}`);

          try {
            const createLinkResponse = await axios.get(testUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
                'X-User-Agent': 'Model: MAG250; Link: WiFi',
                'Cookie': `mac=${channel.source_mac}; stb_lang=en; timezone=America/New_York`
              },
              timeout: 5000
            });

            const linkData = createLinkResponse.data;
            if (!linkData.js || !linkData.js.cmd) {
              logger.warn(`Invalid Stalker response for ${channel.name}: ${JSON.stringify(linkData)}`);
              continue;
            }

            const freshCmd = linkData.js.cmd;
            const cmdMatch = freshCmd.match(/ffmpeg\s+(.+)/);
            if (!cmdMatch) {
              logger.warn(`Could not extract stream URL from Stalker cmd: ${freshCmd}`);
              continue;
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
                  logger.info(`Fixed empty stream parameter: stream=${originalStreamId}`);
                }
              }
            }

            testUrl = freshUrl;
            logger.info(`Using refreshed Stalker URL: ${testUrl.substring(0, 100)}...`);
          } catch (stalkerError) {
            logger.error(`Stalker token refresh failed for ${channel.name}:`, stalkerError.message);
            continue;
          }
        }

        // Validate stream with ffprobe
        const ffprobeArgs = [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          '-read_intervals', '%+#1',
          '-timeout', '8000000',
          testUrl
        ];

        try {
          const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
            timeout: 10000,
            maxBuffer: 1024 * 1024
          });

          const probeData = JSON.parse(stdout);
          const hasVideo = probeData.streams && probeData.streams.some(s => s.codec_type === 'video');
          const hasAudio = probeData.streams && probeData.streams.some(s => s.codec_type === 'audio');

          if (hasVideo || hasAudio) {
            logger.info(`✓ Stream validated for ${channel.name} (video: ${hasVideo}, audio: ${hasAudio})`);

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
                category: channel.category
              }
            });
          } else {
            logger.warn(`✗ No video/audio streams found for ${channel.name}`);
          }
        } catch (ffprobeError) {
          logger.warn(`✗ ffprobe validation failed for ${channel.name}:`, ffprobeError.message);
          continue;
        }
      } catch (error) {
        logger.error(`Error testing channel ${channel.name}:`, error.message);
        continue;
      }
    }

    return res.status(404).json({
      success: false,
      error: 'No working streams found',
      message: `Tested ${channels.length} channels but none were working`
    });
  } catch (error) {
    logger.error('Random any channel failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/live-events/blacklist
 * Get all blacklisted channels for the current user
 */
router.get('/blacklist', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');
    const result = await postgresService.query(
      'SELECT id, channel_name, created_at FROM blacklisted_channels WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json({
      success: true,
      blacklist: result.rows
    });
  } catch (error) {
    logger.error('Get blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/live-events/blacklist
 * Add a channel to the blacklist
 */
router.post('/blacklist', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelName } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!channelName || typeof channelName !== 'string') {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    const postgresService = require('../services/postgresService');

    // Insert or ignore if already exists
    await postgresService.query(
      'INSERT INTO blacklisted_channels (user_id, channel_name) VALUES ($1, $2) ON CONFLICT (user_id, channel_name) DO NOTHING',
      [userId, channelName]
    );

    logger.info(`User ${userId} blacklisted channel: ${channelName}`);

    res.json({
      success: true,
      message: 'Channel blacklisted successfully'
    });
  } catch (error) {
    logger.error('Add to blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/live-events/blacklist/:channelName
 * Remove a channel from the blacklist
 */
router.delete('/blacklist/:channelName', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelName } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');

    const result = await postgresService.query(
      'DELETE FROM blacklisted_channels WHERE user_id = $1 AND channel_name = $2',
      [userId, channelName]
    );

    logger.info(`User ${userId} removed channel from blacklist: ${channelName}`);

    res.json({
      success: true,
      message: 'Channel removed from blacklist',
      deleted: result.rowCount > 0
    });
  } catch (error) {
    logger.error('Remove from blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
