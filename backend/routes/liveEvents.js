/**
 * Live Events Routes
 * API endpoints for managing live sports events data
 */

const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const { promisify } = require('util');
const http = require('http');
const https = require('https');
const axios = require('axios');
const FuzzySet = require('fuzzyset');
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const liveEventsService = require('../services/liveEventsService');
const postgresService = require('../services/postgresService');
const iptvDatabaseService = require('../services/iptvDatabase');

/**
 * Extract searchable terms from a team name
 * Instead of maintaining a brittle list of mascots, we extract meaningful parts:
 * - The full team name
 * - Individual words (for partial matching)
 * - Location/school name (typically the first word(s) before the mascot)
 */
function extractSearchTerms(teamName) {
  if (!teamName) return [];

  const terms = new Set();
  const cleaned = teamName.trim();

  // Add full name
  terms.add(cleaned);

  // Split into words
  const words = cleaned.split(/\s+/);

  // Add individual significant words (4+ chars, not common words)
  // Using 4 chars to avoid abbreviations like "St." matching "St. Lucia"
  const commonWords = new Set(['the', 'and', 'for', 'state', 'university']);
  words.forEach(word => {
    // Strip trailing punctuation for length check
    const cleanWord = word.replace(/[.,:;!?]$/, '');
    if (cleanWord.length >= 4 && !commonWords.has(cleanWord.toLowerCase())) {
      terms.add(word);
    }
  });

  // For multi-word names, add first word(s) which is typically the location/school
  // e.g., "Temple Owls" -> "Temple", "Villanova Wildcats" -> "Villanova"
  // e.g., "Central State (OH) Marauders" -> "Central State", "Central"
  if (words.length >= 2) {
    // Only add first word if it's meaningful (4+ chars after stripping punctuation)
    const firstWordClean = words[0].replace(/[.,:;!?]$/, '');
    if (firstWordClean.length >= 4) {
      terms.add(words[0]);
    }

    // Handle parenthetical state abbreviations like "(OH)"
    const withoutParens = cleaned.replace(/\s*\([^)]+\)\s*/g, ' ').trim();
    const cleanedWords = withoutParens.split(/\s+/);
    if (cleanedWords.length >= 2) {
      // Add first two words for compound names like "Central State", "West Virginia"
      terms.add(cleanedWords.slice(0, 2).join(' '));
    }
  }

  return Array.from(terms);
}

/**
 * Calculate relevance score between a channel name and team names using fuzzy matching
 * Returns a score from 0-400 based on how well the channel matches the teams
 */
function calculateRelevanceScore(channelName, homeTeam, awayTeam) {
  const channelLower = channelName.toLowerCase();
  let score = 0;

  // Extract search terms for each team
  const homeTerms = extractSearchTerms(homeTeam);
  const awayTerms = extractSearchTerms(awayTeam);

  // Check for exact substring matches first (fastest)
  const hasHomeMatch = homeTerms.some(term => channelLower.includes(term.toLowerCase()));
  const hasAwayMatch = awayTerms.some(term => channelLower.includes(term.toLowerCase()));

  // Both teams = highest priority
  if (hasHomeMatch && hasAwayMatch) {
    score += 200;
  }

  // Individual team matches
  if (hasHomeMatch) score += 100;
  if (hasAwayMatch) score += 100;

  // If no exact matches, try fuzzy matching for typo tolerance
  if (!hasHomeMatch && !hasAwayMatch && (homeTeam || awayTeam)) {
    // Build fuzzy set from channel name words
    const channelWords = channelLower.split(/[\s|:@\-]+/).filter(w => w.length >= 3);
    if (channelWords.length > 0) {
      const fuzzyChannel = FuzzySet(channelWords);

      // Check if any team term fuzzy matches channel words
      const allTerms = [...homeTerms, ...awayTerms];
      for (const term of allTerms) {
        if (term.length < 3) continue;
        const match = fuzzyChannel.get(term.toLowerCase(), null, 0.7);
        if (match && match.length > 0) {
          // Fuzzy match found - add partial score based on match quality
          score += Math.round(match[0][0] * 50);
        }
      }
    }
  }

  return score;
}

// Promisify execFile once at module load
const execFileAsync = promisify(execFile);

// Connection pooling for axios requests (Stalker token refresh, etc.)
// This prevents socket exhaustion when testing multiple channels in parallel
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,        // Limit concurrent connections per host
  maxFreeSockets: 5,
  timeout: 10000,        // 10 second socket timeout
  keepAliveMsecs: 5000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 10000,
  keepAliveMsecs: 5000
});

logger.info('[LiveEvents] HTTP/HTTPS connection pooling enabled (maxSockets: 10)');

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

      // Use the new extractSearchTerms function for robust term extraction
      const homeTerms = extractSearchTerms(homeTeam);
      const awayTerms = extractSearchTerms(awayTeam);
      const searchTerms = [...new Set([...homeTerms, ...awayTerms])]; // Dedupe

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

    // Use the new extractSearchTerms function for robust term extraction
    const homeTerms = extractSearchTerms(homeTeam);
    const awayTerms = extractSearchTerms(awayTeam);
    const searchTerms = [...new Set([...homeTerms, ...awayTerms])]; // Dedupe

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

/**
 * POST /api/live-events/search-channel
 * Search for a channel by name and return a working stream
 * Avoids sources already in use in multiview
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
    const offset = parseInt(searchOffset) || 0;

    logger.info(`[Find Alternative] Received search request: query="${searchQuery}", offset=${offset}, minQuality=${minHeight}p`);
    // Fetch blacklisted channels
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    // Extract search terms using fuzzy matching logic (handles event names like "Temple Owls at Villanova Wildcats")
    // Check if query looks like an event name (contains "at" or "vs" between teams)
    const eventMatch = searchQuery.match(/^(.+?)\s+(?:at|vs\.?|@)\s+(.+?)$/i);
    let searchTerms;
    let homeTeam = null;
    let awayTeam = null;

    if (eventMatch) {
      // Query is an event name - extract team search terms
      awayTeam = eventMatch[1].trim();
      homeTeam = eventMatch[2].trim();
      const homeTerms = extractSearchTerms(homeTeam);
      const awayTerms = extractSearchTerms(awayTeam);
      searchTerms = [...new Set([...homeTerms, ...awayTerms])];
      logger.info(`Search channel: Detected event format - home: "${homeTeam}", away: "${awayTeam}", terms: ${searchTerms.join(', ')}`);
    } else {
      // Simple search - just use the query as-is plus extracted terms
      searchTerms = extractSearchTerms(searchQuery);
      logger.info(`Search channel: Simple search for "${searchQuery}", terms: ${searchTerms.join(', ')}`);
    }

    logger.info(`Searching for channel: "${searchQuery}" (excludedSources: ${excludeSourceIds.length}, excludedChannels: ${excludeChannelIds.length}, minQuality: ${minHeight}p)`);

    // For event searches, prioritize team mascots/nicknames (last word of team name)
    // e.g., "Anaheim Ducks" -> prioritize "Ducks", "St. Louis Blues" -> prioritize "Blues"
    let priorityTerms = [];
    if (homeTeam && awayTeam) {
      const homeWords = homeTeam.split(/\s+/);
      const awayWords = awayTeam.split(/\s+/);
      // Last word is usually the mascot/nickname
      if (homeWords.length > 0) priorityTerms.push(homeWords[homeWords.length - 1]);
      if (awayWords.length > 0) priorityTerms.push(awayWords[awayWords.length - 1]);
      // Filter out short words
      priorityTerms = priorityTerms.filter(t => t.length >= 4);
      logger.info(`Priority search terms (mascots): ${priorityTerms.join(', ')}`);
    }

    // Build query - for event searches, require at least one priority term (mascot)
    let channelConditions;
    let searchParams;
    if (priorityTerms.length > 0) {
      // Require at least one mascot/nickname match to filter out irrelevant channels
      channelConditions = priorityTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
      searchParams = priorityTerms.map(term => `%${term}%`);
    } else {
      // Fallback to all terms for non-event searches
      channelConditions = searchTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
      searchParams = searchTerms.map(term => `%${term}%`);
    }
    let queryParams = [userId, ...searchParams];

    // Build source exclusion clause
    let sourceExclusion = '';
    if (excludeSourceIds.length > 0) {
      const sourceParamIndex = queryParams.length + 1;
      const sourcePlaceholders = excludeSourceIds.map((_, i) => `$${sourceParamIndex + i}`).join(', ');
      sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
      queryParams.push(...excludeSourceIds);
    }

    // Build channel exclusion clause
    let channelExclusion = '';
    if (excludeChannelIds.length > 0) {
      const channelParamIndex = queryParams.length + 1;
      const channelPlaceholders = excludeChannelIds.map((_, i) => `$${channelParamIndex + i}`).join(', ');
      channelExclusion = `AND c.channel_id NOT IN (${channelPlaceholders})`;
      queryParams.push(...excludeChannelIds);
    }

    // Build blacklist conditions
    let blacklistConditions = '1=1';
    if (blacklistedChannels.length > 0) {
      const startParamIndex = queryParams.length + 1;
      const blacklistPlaceholders = blacklistedChannels.map((name, i) => {
        return `c.name != $${startParamIndex + i}`;
      });
      queryParams.push(...blacklistedChannels);
      blacklistConditions = blacklistPlaceholders.join(' AND ');
    }

    // Search for matching channels using OR conditions for all search terms
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
      ORDER BY c.name
      LIMIT 50
    `, queryParams);

    let channels = channelsResult.rows || [];

    if (channels.length === 0) {
      return res.json({
        success: false,
        error: 'No channels found',
        message: `No channels found matching "${searchQuery}"`
      });
    }

    // Only apply relevance scoring if we detected an event format (homeTeam/awayTeam set)
    // For simple searches, all channels matched the SQL ILIKE so they're all relevant
    if (homeTeam || awayTeam) {
      // Score and sort channels using fuzzy relevance scoring
      channels = channels.map(channel => {
        const score = calculateRelevanceScore(channel.name, homeTeam, awayTeam);
        return { ...channel, relevanceScore: score };
      });

      // Sort by relevance score (highest first) and filter low-relevance channels
      channels.sort((a, b) => b.relevanceScore - a.relevanceScore);

      // Log top scoring channels for debugging
      if (channels.length > 0) {
        const topChannels = channels.slice(0, 10).map(c => `${c.name.substring(0, 50)}: ${c.relevanceScore}`);
        logger.info(`Top scoring channels: ${topChannels.join(' | ')}`);
      }

      // For event searches (both teams specified), require channels that match at least one FULL team
      // Score >= 200 means both teams matched (ideal)
      // Score >= 100 means at least one team matched
      // Filter out low scores but also prioritize high scores by testing them first
      const minScore = 100;
      channels = channels.filter(c => c.relevanceScore >= minScore);

      logger.info(`Filtered channels with minScore=${minScore}: ${channels.length} remaining (top score: ${channels[0]?.relevanceScore || 0})`);

      if (channels.length === 0) {
        return res.json({
          success: false,
          error: 'No relevant channels found',
          message: `No channels found matching "${searchQuery}" (all filtered by relevance)`
        });
      }

      logger.info(`Found ${channels.length} relevant channels matching "${searchQuery}" (top score: ${channels[0]?.relevanceScore}), testing streams...`);
    } else {
      logger.info(`Found ${channels.length} channels matching "${searchQuery}", testing streams...`);
    }

    // Apply offset for pagination (skip already-tried channels)
    if (offset > 0) {
      channels = channels.slice(offset);
    }

    if (channels.length === 0) {
      return res.json({
        success: false,
        error: 'No more channels to try',
        message: `All channels for "${searchQuery}" have been tried`
      });
    }

    // Test streams using ffprobe validation
    const PARALLEL_TESTS = 5; // Test 5 channels at a time for faster results

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

                // Fix empty stream parameter
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

        // Validate with ffprobe - use shorter timeout for faster results
        const ffprobeArgs = [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          '-read_intervals', '%+#1',
          '-timeout', '5000000'  // 5 seconds (was 8)
        ];

        if (channel.source_type === 'stalker') {
          ffprobeArgs.push('-headers', `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`);
        }

        ffprobeArgs.push(testUrl);

        const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
          timeout: 5000,  // 5 seconds (was 8)
          maxBuffer: 1024 * 1024
        });

        const probeData = JSON.parse(stdout);
        const videoStream = probeData.streams && probeData.streams.find(s => s.codec_type === 'video');
        const hasAudio = probeData.streams && probeData.streams.some(s => s.codec_type === 'audio');

        // MUST have video - audio-only streams (like radio) are not valid for IPTV
        if (videoStream) {
          const streamHeight = videoStream.height || 0;
          return { success: true, height: streamHeight, hasAudio, channel, index };
        }

        return { success: false, reason: hasAudio ? 'Audio-only stream (no video)' : 'No video stream', index };
      } catch (error) {
        return { success: false, reason: error.message.split('\n')[0], index };
      }
    };

    // Test channels in parallel with concurrency limit
    for (let i = 0; i < channels.length; i += PARALLEL_TESTS) {
      const chunk = channels.slice(i, i + PARALLEL_TESTS);
      const results = await Promise.all(chunk.map((channel, chunkIndex) => {
        const globalIndex = i + chunkIndex;
        logger.info(`Testing channel: ${channel.name} from source ${channel.source_id} (${channel.source_type})`);
        return testSingleChannel(channel, globalIndex);
      }));

      // Check results for a working channel (prioritize by original index order)
      const successfulResults = results.filter(r => r.success).sort((a, b) => a.index - b.index);

      for (const result of successfulResults) {
        const channel = result.channel;
        const streamHeight = result.height;

        // Check quality requirement
        if (minHeight > 0 && streamHeight < minHeight) {
          logger.info(`✗ Channel ${channel.name} quality too low: ${streamHeight}p < ${minHeight}p`);
          continue;
        }

        logger.info(`✓ Found working channel: ${channel.name} (${streamHeight}p)`);

        // Next offset = current offset + position in list + 1 (to skip this one next time)
        const nextSearchOffset = offset + result.index + 1;

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
            // Include search metadata for "find alternative" feature
            searchQuery: searchQuery,
            searchOffset: nextSearchOffset
          }
        });
      }

      // Log failed results
      for (const result of results) {
        if (!result.success) {
          const channel = channels[result.index];
          logger.info(`✗ Channel ${channel.name} failed: ${result.reason}`);
        }
      }
    }

    return res.json({
      success: false,
      error: 'No working streams found',
      message: minHeight > 0
        ? `Found ${channels.length} channels matching "${searchQuery}" but none met the ${minHeight}p quality requirement`
        : `Found ${channels.length} channels matching "${searchQuery}" but none were working`
    });

  } catch (error) {
    logger.error('Search channel failed:', error);
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

/**
 * POST /api/live-events/auto-fill-streams
 * Auto-fill multiview with multiple streams at once based on settings
 * Avoids duplicate sources and duplicate events
 */
router.post('/auto-fill-streams', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const {
      sportType,
      leagueName,
      maxStreams = 4,
      excludeSourceIds = [],
      excludeEventIds = [],
      excludeChannelIds = [],
      minQuality = 0
    } = req.body;

    const minHeight = parseInt(minQuality) || 0;

    // Fetch blacklisted channels
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    logger.info(`Auto-fill: Looking for ${maxStreams} streams (sport: ${sportType || 'any'}, league: ${leagueName || 'any'}, minQuality: ${minHeight}p) for user ${userId}`);
    logger.info(`Auto-fill: Excluding ${excludeSourceIds.length} sources, ${excludeEventIds.length} events, ${excludeChannelIds.length} channels`);

    const foundChannels = [];
    const usedSourceIds = new Set(excludeSourceIds.map(id => parseInt(id)));
    const usedEventIds = new Set(excludeEventIds);
    const usedChannelIds = new Set(excludeChannelIds);

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

    // Get all matching live events
    const eventsResult = await postgresService.query(`
      SELECT * FROM live_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY RANDOM()
    `, params);

    const events = eventsResult.rows || [];

    if (events.length === 0) {
      logger.info('Auto-fill: No live events found');
      return res.json({
        success: true,
        channels: [],
        message: sportType ? `No live ${sportType} events available` : 'No live events available'
      });
    }

    logger.info(`Auto-fill: Found ${events.length} matching live events`);

    // Helper function to test a channel - returns { valid: boolean, height: number }
    const testChannel = async (channel) => {
      let testUrl = channel.url;

      // Build proper URL for XTREAM sources
      if (channel.source_type === 'xtream' && channel.source_url && channel.source_username && channel.source_password) {
        const baseUrl = channel.source_url.replace(/\/$/, '');
        const streamId = channel.url.split('/').pop();
        testUrl = `${baseUrl}/live/${channel.source_username}/${channel.source_password}/${streamId}`;
      }

      // Handle Stalker portal authentication
      if (channel.source_type === 'stalker') {
        if (testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
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

        // Validate Stalker stream
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

        const videoStream = probeData.streams.find(s => s.codec_type === 'video');

        // MUST have video - audio-only streams are not valid for IPTV
        if (!videoStream) {
          throw new Error('No video stream');
        }

        return { valid: true, height: videoStream.height || 0 };
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

        const videoStream = probeData.streams.find(s => s.codec_type === 'video');

        // MUST have video - audio-only streams are not valid for IPTV
        if (!videoStream) {
          throw new Error('No video stream');
        }

        return { valid: true, height: videoStream.height || 0 };
      }
    };

    // Track which events we've exhausted all channels for
    const exhaustedEvents = new Set();

    // Do multiple passes through events until we fill all slots or exhaust all options
    const maxPasses = 5; // Try up to 5 passes through the events

    for (let pass = 0; pass < maxPasses && foundChannels.length < maxStreams; pass++) {
      logger.info(`Auto-fill: Pass ${pass + 1}/${maxPasses} - ${foundChannels.length}/${maxStreams} streams found`);

      for (const event of events) {
        if (foundChannels.length >= maxStreams) {
          break;
        }

        // Skip already used events (when avoidDuplicateEvents is on) or exhausted events
        if (usedEventIds.has(event.event_id) || exhaustedEvents.has(event.event_id)) {
          continue;
        }

      const homeTeam = event.home_team || '';
      const awayTeam = event.away_team || '';

      // Use the new extractSearchTerms function for robust term extraction
      const homeTerms = extractSearchTerms(homeTeam);
      const awayTerms = extractSearchTerms(awayTeam);
      const searchTerms = [...new Set([...homeTerms, ...awayTerms])]; // Dedupe

      if (searchTerms.length === 0) {
        logger.info(`Auto-fill: Event ${event.event_name} has no search terms, skipping`);
        continue;
      }

      // Build channel query
      const channelConditions = searchTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
      const searchParams = searchTerms.map(term => `%${term}%`);
      let queryParams = [userId, ...searchParams];

      // Build source exclusion clause (exclude already used sources)
      let sourceExclusion = '';
      if (usedSourceIds.size > 0) {
        const sourceParamIndex = queryParams.length + 1;
        const sourcePlaceholders = Array.from(usedSourceIds).map((_, i) => `$${sourceParamIndex + i}`).join(', ');
        sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
        queryParams.push(...Array.from(usedSourceIds));
      }

      // Build blacklist conditions
      let blacklistConditions = '1=1';
      if (blacklistedChannels.length > 0) {
        const blacklistParamIndex = queryParams.length + 1;
        blacklistConditions = blacklistedChannels.map((name, i) => {
          return `c.name != $${blacklistParamIndex + i}`;
        }).join(' AND ');
        queryParams.push(...blacklistedChannels);
      }

      // Build channel exclusion
      let channelExclusion = '';
      if (usedChannelIds.size > 0) {
        const channelParamIndex = queryParams.length + 1;
        const channelPlaceholders = Array.from(usedChannelIds).map((_, i) => `$${channelParamIndex + i}`).join(', ');
        channelExclusion = `AND c.channel_id NOT IN (${channelPlaceholders})`;
        queryParams.push(...Array.from(usedChannelIds));
      }

      // Build scoring conditions for SQL - prioritize channels with both teams
      let scoringCase = 'CASE ';
      if (homeTeam && awayTeam) {
        // Both teams = highest priority
        scoringCase += `WHEN LOWER(c.name) LIKE LOWER('%${homeTeam.replace(/'/g, "''")}%') AND LOWER(c.name) LIKE LOWER('%${awayTeam.replace(/'/g, "''")}%') THEN 3 `;
      }
      if (homeTeam) {
        scoringCase += `WHEN LOWER(c.name) LIKE LOWER('%${homeTeam.replace(/'/g, "''")}%') THEN 2 `;
      }
      scoringCase += 'ELSE 1 END';

      const sqlQuery = `
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
        WHERE s.user_id = $1 AND (${channelConditions}) ${sourceExclusion} ${channelExclusion} AND ${blacklistConditions}
        ORDER BY ${scoringCase} DESC, RANDOM()
        LIMIT 50
      `;

      const channelsResult = await postgresService.query(sqlQuery, queryParams);

        let channels = channelsResult.rows || [];

        if (channels.length === 0) {
          // No more channels for this event, mark as exhausted
          exhaustedEvents.add(event.event_id);
          continue;
        }

        // Score channels using fuzzy matching (prioritize channels with BOTH teams)
        channels = channels.map(channel => {
          let score = calculateRelevanceScore(channel.name, homeTeam, awayTeam);

          // League name bonus
          if (event.league_name && channel.name.toLowerCase().includes(event.league_name.toLowerCase())) {
            score += 25;
          }

          // Sport type bonus
          if (event.sport_type && channel.name.toLowerCase().includes(event.sport_type.toLowerCase())) {
            score += 10;
          }

          return { ...channel, relevanceScore: score };
        });

        // Sort by relevance score (highest first) and filter low-relevance channels
        channels.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Only keep channels with score >= 35 (fuzzy match can add ~35 points)
        // Score >= 100 means exact team name match, >= 200 means both teams
        channels = channels.filter(c => c.relevanceScore >= 35);

        if (channels.length === 0) {
          exhaustedEvents.add(event.event_id);
          continue;
        }

        logger.info(`Auto-fill: Found ${channels.length} relevant channels for "${event.event_name}" (top score: ${channels[0]?.relevanceScore})`);

        let foundForThisEvent = false;

        // Filter out already used sources and channels
        const eligibleChannels = channels.filter(channel =>
          !usedSourceIds.has(parseInt(channel.source_id)) &&
          !usedChannelIds.has(channel.id)
        );

        if (eligibleChannels.length === 0) {
          exhaustedEvents.add(event.event_id);
          continue;
        }

        // Test channels in parallel batches (test top 6 at a time, prioritized by score)
        const batchSize = 6;
        for (let i = 0; i < eligibleChannels.length && !foundForThisEvent; i += batchSize) {
          if (foundChannels.length >= maxStreams) {
            break;
          }

          const batch = eligibleChannels.slice(i, i + batchSize);
          logger.info(`Auto-fill: Testing batch of ${batch.length} channels in parallel for "${event.event_name}"`);

          // Test all channels in batch simultaneously
          const testPromises = batch.map(async (channel) => {
            try {
              logger.info(`Auto-fill: Testing channel ${channel.name} (score: ${channel.relevanceScore}) for event ${event.event_name}`);
              const result = await testChannel(channel);

              // Check quality requirement
              if (minHeight > 0 && result.height < minHeight) {
                logger.info(`Auto-fill: ✗ Channel ${channel.name} quality too low: ${result.height}p < ${minHeight}p`);
                return { channel, success: false, reason: 'quality' };
              }

              logger.info(`Auto-fill: ✓ Channel ${channel.name} is WORKING! (${result.height}p)`);
              return { channel, success: true, result };
            } catch (error) {
              logger.info(`Auto-fill: ✗ Channel ${channel.name} failed: ${error.message}`);
              return { channel, success: false, reason: 'error', error: error.message };
            }
          });

          const results = await Promise.all(testPromises);

          // Mark all tested channels as used
          for (const r of results) {
            usedChannelIds.add(r.channel.id);
          }

          // Find the best working channel from this batch (highest score that works)
          const workingChannels = results
            .filter(r => r.success)
            .sort((a, b) => b.channel.relevanceScore - a.channel.relevanceScore);

          if (workingChannels.length > 0) {
            const best = workingChannels[0];
            const channel = best.channel;

            foundChannels.push({
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
              espnEventName: event.event_name,
              quality: best.result.height
            });

            // Mark source and event as used
            usedSourceIds.add(parseInt(channel.source_id));
            usedEventIds.add(event.event_id);
            foundForThisEvent = true;
          }
        }

        // If we tested all channels and found nothing, mark event as exhausted
        if (!foundForThisEvent) {
          exhaustedEvents.add(event.event_id);
        }
      }
    }

    logger.info(`Auto-fill: Completed - Found ${foundChannels.length} working channels after ${maxPasses} passes`);

    return res.json({
      success: true,
      channels: foundChannels,
      message: foundChannels.length === 0
        ? (minHeight > 0 ? `No streams found meeting ${minHeight}p quality requirement` : 'No working streams found')
        : `Found ${foundChannels.length} working stream${foundChannels.length !== 1 ? 's' : ''}`
    });

  } catch (error) {
    logger.error('Auto-fill streams failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
