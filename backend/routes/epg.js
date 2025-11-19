/**
 * EPG Routes - handles EPG-related endpoints
 * Refactored to use service layer pattern
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const logger = require('../utils/logger');
const sessionStorage = require('../utils/session');
const { authMiddleware } = require('../middleware/authMiddleware');
const postgresService = require('../services/postgresService');
const XmltvParser = require('xmltv-parser');

// Import EPG services
const epgQueryService = require('../services/epgQueryService');
const epgSourceService = require('../services/epgSourceService');
const epgMatchService = require('../services/epgMatchService');

// Apply optional auth middleware to all routes
router.use(authMiddleware);

/**
 * POST /init
 * Initialize EPG session
 */
router.post('/init', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    logger.info(`Initializing EPG session ${sessionId}`);

    // Check for existing session
    let session = sessionStorage.getSession(sessionId);

    if (!session) {
      logger.info(`Creating new EPG session ${sessionId}`);
      session = sessionStorage.createSession(sessionId, {
        data: {
          channels: []
        }
      });
    } else if (!session.data || !session.data.channels) {
      logger.info(`Updating EPG session ${sessionId} with channels array`);
      session = sessionStorage.updateSession(sessionId, {
        data: {
          channels: []
        }
      });
    }

    // Get database stats
    const stats = await epgQueryService.getDatabaseStats();

    return res.json({
      success: true,
      sessionId,
      message: `EPG session initialized with ID ${sessionId}`,
      stats,
      dbType: 'postgresql'
    });
  } catch (error) {
    logger.error(`Error initializing EPG session: ${error.message}`);
    return res.status(500).json({
      error: `Failed to initialize EPG session: ${error.message}`
    });
  }
});

/**
 * GET /search
 * Global search endpoint without session
 */
router.get('/search', async (req, res) => {
  try {
    const { query } = req.query;

    logger.info(`Global search requested for term: ${query}`);

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const results = await epgQueryService.searchChannels(query);
    const stats = await epgQueryService.getDatabaseStats();

    return res.json({
      results,
      term: query,
      sessionId: `db_${Date.now()}`,
      sourceCount: stats.sourceCount,
      channelCount: stats.channelCount,
      matches: results.length,
      message: results.length > 0
        ? `Found ${results.length} matches for "${query}"`
        : `No matches found for "${query}"`
    });
  } catch (error) {
    logger.error(`Error in global search: ${error.message}`);
    res.status(500).json({ error: `Search error: ${error.message}` });
  }
});

/**
 * GET /debug/stats
 * Get database statistics
 */
router.get('/debug/stats', async (req, res) => {
  try {
    const stats = await epgQueryService.getDatabaseStats();

    res.json({
      stats,
      status: 'Database is operational',
      databasePath: stats.databasePath,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error getting database stats: ${error.message}`);
    res.status(500).json({ error: `Failed to get database stats: ${error.message}` });
  }
});

/**
 * GET /refresh-status
 * Get current EPG refresh status
 */
router.get('/refresh-status', (req, res) => {
  const status = epgSourceService.getEpgRefreshStatus();
  res.json(status);
});

/**
 * POST /parse
 * Parse EPG from URL or file
 */
router.post('/parse', async (req, res) => {
  try {
    const { url, force = false } = req.body;

    // Check if already running
    const status = epgSourceService.getEpgRefreshStatus();
    if (status.isRunning) {
      return res.status(409).json({
        error: 'EPG refresh already in progress',
        status: status,
        timestamp: new Date().toISOString()
      });
    }

    // Start parsing in the background
    res.json({
      status: 'EPG parsing started',
      source: url || 'all sources',
      timestamp: new Date().toISOString()
    });

    // Run the EPG parser
    const options = {
      force,
      source: url
    };

    epgSourceService.runEpgParser(options).then(result => {
      logger.info(`EPG parse completed: ${result.success}`);
    }).catch(error => {
      logger.error(`EPG parse error: ${error.message}`);
    });
  } catch (error) {
    logger.error(`Error parsing EPG: ${error.message}`);
  }
});

/**
 * IPTV Editor Endpoints - User-authenticated endpoints for editing matched channels
 */

/**
 * GET /matched-channels
 * Get all matched channels for the authenticated user (for IPTV Editor)
 */
router.get('/matched-channels', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get matched channels: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await postgresService.query(`
      SELECT
        m.id as match_id,
        m.iptv_channel_id,
        c.name as iptv_channel_name,
        m.epg_channel_id,
        CASE WHEN m.use_dummy_epg THEN 1 ELSE 0 END as use_dummy_epg,
        CASE WHEN c.enable_live_prefix THEN 1 ELSE 0 END as enable_live_prefix,
        c.id as iptv_channel_table_id,
        c.source_id,
        c.name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        s.name as source_name
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `, [userId]);

    const channels = result.rows;

    res.json({
      channels,
      count: channels.length
    });
  } catch (error) {
    logger.error('Error fetching matched channels for editor:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /matched-channels-with-programs
 * Get all channels that have been matched with EPG data, along with their programs (auth required)
 */
router.get('/matched-channels-with-programs', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get matched channels with programs: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await epgMatchService.getMatchedChannelsWithPrograms(userId);

    // Disable caching for this endpoint to ensure fresh data after matches
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    return res.json(result);
  } catch (error) {
    logger.error(`Error getting matched channels: ${error.message}`);
    return res.status(500).json({
      error: `Failed to get matched channels: ${error.message}`
    });
  }
});

/**
 * PUT /matched-channels/:channelId
 * Update channel metadata
 */
router.put('/matched-channels/:channelId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelId } = req.params;
    const { name, logo, group_title } = req.body;

    if (!userId) {
      logger.error('Update channel: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Update the channel in iptv_channels table
    await postgresService.query(`
      UPDATE iptv_channels
      SET name = $1, logo_url = $2, group_title = $3
      WHERE channel_id = $4
      AND source_id IN (
        SELECT s.id FROM iptv_sources s WHERE s.user_id = $5
      )
    `, [name, logo, group_title, channelId, userId]);

    logger.info(`Updated channel ${channelId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Channel updated successfully'
    });
  } catch (error) {
    logger.error('Error updating channel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /matched-channels/:matchId
 * Remove a specific match by match ID
 */
router.delete('/matched-channels/:matchId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { matchId } = req.params;

    if (!userId) {
      logger.error('Delete matched channel: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Delete the specific match by ID (ensure it belongs to this user)
    const result = await postgresService.query(`
      DELETE FROM epg_matches
      WHERE id = $1 AND user_id = $2
    `, [matchId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    logger.info(`Removed match ID ${matchId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Channel match removed'
    });
  } catch (error) {
    logger.error('Error deleting matched channel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /matched-channels/:matchId/dummy-epg
 * Toggle dummy EPG for a specific match
 */
router.put('/matched-channels/:matchId/dummy-epg', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { matchId } = req.params;
    const { useDummyEpg } = req.body;

    if (!userId) {
      logger.error('Toggle dummy EPG: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (typeof useDummyEpg !== 'boolean') {
      return res.status(400).json({ error: 'useDummyEpg must be a boolean' });
    }

    // Update the dummy EPG flag for this match
    const result = await postgresService.query(`
      UPDATE epg_matches
      SET use_dummy_epg = $1
      WHERE id = $2 AND user_id = $3
    `, [useDummyEpg ? 1 : 0, matchId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    logger.info(`${useDummyEpg ? 'Enabled' : 'Disabled'} dummy EPG for match ID ${matchId} (user ${userId})`);

    res.json({
      success: true,
      message: `Dummy EPG ${useDummyEpg ? 'enabled' : 'disabled'}`,
      useDummyEpg
    });
  } catch (error) {
    logger.error('Error toggling dummy EPG:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /channel-programs/:channelId
 * Get EPG programs for a specific channel
 */
router.get('/channel-programs/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    if (!channelId) {
      return res.status(400).json({ error: 'Channel ID is required' });
    }

    const result = await postgresService.query(`
      SELECT
        channel_id,
        title,
        start_time as start,
        stop_time as stop,
        description,
        categories as category
      FROM epg_programs
      WHERE channel_id = $1
      AND stop_time >= NOW() - INTERVAL '2 hours'
      ORDER BY start_time
      LIMIT 50
    `, [channelId]);

    const programs = result.rows || [];

    res.json({
      programs,
      count: programs.length
    });
  } catch (error) {
    logger.error('Error fetching channel programs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /matched-channels/batch-update-category
 * Rename a category for all channels
 */
router.post('/matched-channels/batch-update-category', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { oldCategory, newCategory } = req.body;

    if (!userId) {
      logger.error('Batch update category: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!oldCategory || !newCategory) {
      return res.status(400).json({ error: 'Old and new category names required' });
    }

    // Update all channels in the category for this user
    const result = await postgresService.query(`
      UPDATE iptv_channels
      SET group_title = $1
      WHERE group_title = $2
      AND source_id IN (
        SELECT s.id FROM iptv_sources s WHERE s.user_id = $3
      )
    `, [newCategory, oldCategory, userId]);

    logger.info(`Renamed category "${oldCategory}" to "${newCategory}" for user ${userId}, ${result.rowCount} channels updated`);

    res.json({
      success: true,
      message: `Category renamed, ${result.rowCount} channels updated`
    });
  } catch (error) {
    logger.error('Error batch updating category:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /:sessionId/categories
 * Get categories for session
 */
router.get('/:sessionId/categories', async (req, res) => {
  try {
    const { sessionId } = req.params;

    logger.debug(`REQUEST RECEIVED for categories: sessionId=${sessionId}`);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const session = sessionStorage.getSession(sessionId);
    const categories = epgQueryService.getCategories(session);

    return res.json({
      success: true,
      sessionId,
      categories,
      count: categories.length
    });
  } catch (error) {
    logger.error(`Error getting categories: ${error.message}`);
    return res.status(500).json({ error: `Failed to get categories: ${error.message}` });
  }
});

/**
 * GET /:sessionId/search
 * Search for channels across EPG sources with session
 */
router.get('/:sessionId/search', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { term } = req.query;

    logger.info(`Search requested for session ${sessionId}, term: ${term}`);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    if (!term || term.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }

    const session = sessionStorage.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const results = await epgQueryService.searchChannels(term);
    const stats = await epgQueryService.getDatabaseStats();

    // Store search in session history
    if (!session.searchHistory) {
      session.searchHistory = [];
    }
    session.searchHistory.push({
      term,
      timestamp: new Date().toISOString(),
      resultCount: results.length
    });
    session.updated = new Date().toISOString();
    sessionStorage.updateSession(sessionId, session);

    return res.json({
      results,
      term,
      sessionId,
      sourceCount: stats.sourceCount,
      channelCount: stats.channelCount,
      matches: results.length,
      message: results.length > 0
        ? `Found ${results.length} matches for "${term}"`
        : `No matches found for "${term}"`
    });
  } catch (error) {
    logger.error(`Error searching EPG data: ${error.message}`);
    res.status(500).json({ error: `Search error: ${error.message}` });
  }
});

/**
 * GET /published-channels-with-programs
 * Returns matched channels with EPG programs from the PUBLISHED EPG database
 */
router.get('/published-channels-with-programs', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get published channels: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get user's published credentials from PostgreSQL
    const credResult = await postgresService.query(
      'SELECT * FROM credentials WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    const credential = credResult.rows[0];

    if (!credential) {
      return res.status(404).json({
        error: 'No published IPTV data found. Please generate credentials in the Credentials tab first.',
        channels: []
      });
    }

    // Get matched channels from PostgreSQL (for channel metadata)
    const channelsResult = await postgresService.query(`
      SELECT DISTINCT
        c.channel_id as id,
        c.name as iptv_channel_name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        c.enable_live_prefix,
        m.epg_channel_id,
        m.use_dummy_epg,
        s.auto_detect_live
      FROM iptv_channels c
      JOIN epg_matches m ON c.channel_id = m.iptv_channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `, [userId]);

    const matchedChannels = channelsResult.rows;

    // Get LIVE EPG data for channels with real EPG
    const epgResult = await postgresService.query(`
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
    `, [userId]);

    let epgData = epgResult.rows || [];

    logger.info(`[DEBUG] Published channels query returned ${epgData.length} programs for user ${userId}`);
    const fxPrograms = epgData.filter(p => p.channel_name && p.channel_name.includes('FX'));
    if (fxPrograms.length > 0) {
      logger.info(`[DEBUG] FX programs found: ${JSON.stringify(fxPrograms.slice(0, 3))}`);
    }

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

    // Generate dummy EPG for channels with use_dummy_epg=true
    const dummyChannels = matchedChannels.filter(ch => ch.use_dummy_epg === true);
    if (dummyChannels.length > 0) {
      logger.info(`Generating dummy EPG for ${dummyChannels.length} channels in published guide`);

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
            const isLiveEvent = matchesLiveEvent(channel.iptv_channel_name, programStartTime, programStopTime);

            // Apply LIVE prefix if channel has enable_live_prefix and matches a live event
            const shouldAddLivePrefix = (channel.enable_live_prefix === true || channel.auto_detect_live === true) && isLiveEvent;
            const title = shouldAddLivePrefix ? `ʟɪᴠᴇ ${channel.iptv_channel_name}` : channel.iptv_channel_name;

            epgData.push({
              iptv_channel_id: channel.id,
              epg_channel_id: channel.epg_channel_id || `dummy_${channel.id}`,
              channel_name: channel.iptv_channel_name,
              logo_url: channel.logo,
              title: title,
              description: `Streaming on ${channel.iptv_channel_name}`,
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
      return res.status(404).json({
        error: 'No EPG data found. Your EPG data may need to refresh.',
        channels: []
      });
    }

    // Convert PostgreSQL timestamp to ISO format for frontend
    const toISOString = (timestamp) => {
      if (!timestamp) return '';
      // Handle both Date objects and string timestamps
      if (timestamp instanceof Date) {
        return timestamp.toISOString();
      }
      // String timestamp like "2025-11-19 04:35:00" - convert to ISO
      if (typeof timestamp === 'string') {
        return timestamp.replace(' ', 'T') + '.000Z';
      }
      return '';
    };

    // Build response with programs from database
    const channelsWithPrograms = matchedChannels.map(channel => {
      // Find programs for this channel from live EPG
      const channelPrograms = epgData
        .filter(row => row.iptv_channel_id === channel.id)
        .map(row => ({
          title: row.title || 'Unknown',
          description: row.description || null,
          start: toISOString(row.start_time), // Return ISO format for frontend
          stop: toISOString(row.stop_time),   // Return ISO format for frontend
          category: row.categories || null
        }));

      return {
        id: channel.id,
        name: channel.iptv_channel_name,
        epgId: channel.epg_channel_id,
        logo: channel.logo,
        url: channel.url,
        groupTitle: channel.group_title,
        useDummyEpg: channel.use_dummy_epg === 1,
        programs: channelPrograms
      };
    });

    // Log detailed stats
    const totalPrograms = channelsWithPrograms.reduce((sum, ch) => sum + ch.programs.length, 0);
    logger.info(`Returning ${channelsWithPrograms.length} published channels with ${totalPrograms} programs for user ${userId}`);

    res.json({
      channels: channelsWithPrograms,
      count: channelsWithPrograms.length
    });
  } catch (error) {
    logger.error('Error getting published channels with programs:', {
      message: error.message,
      stack: error.stack,
      userId: req.user?.id
    });
    res.status(500).json({
      error: error.message,
      details: error.stack,
      channels: []
    });
  }
});

/**
 * GET /:sessionId
 * Get channel data by channelId
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { channelId } = req.query;

    if (!channelId) {
      return res.status(400).json({
        error: 'Channel ID is required',
        success: false
      });
    }

    logger.info(`Getting EPG data for channel: ${channelId}`);

    try {
      const userId = req.user?.id;
      let epgChannelId = null;

      // Look up the match from PostgreSQL
      let query = `SELECT epg_channel_id FROM epg_matches WHERE iptv_channel_id = $1`;
      const params = [channelId];

      // Filter by user if authenticated
      if (userId) {
        query += ` AND user_id = $2`;
        params.push(userId);
      } else {
        query += ` AND session_id = $2`;
        params.push(sessionId);
      }

      query += ` LIMIT 1`;

      const result = await postgresService.query(query, params);
      const match = result.rows[0];

      if (match) {
        epgChannelId = match.epg_channel_id;
        logger.info(`Found EPG match: ${channelId} -> ${epgChannelId}`);
      } else {
        logger.info(`No match found for IPTV channel ${channelId}`);
      }

      // Get channel info using the EPG channel ID
      const channelInfo = epgChannelId ? await epgQueryService.getChannelById(epgChannelId) : null;

      if (!channelInfo) {
        logger.info(`No EPG channel data found for ${channelId}, returning empty EPG data`);
        return res.json({
          success: true,
          channelId,
          channelInfo: null,
          programs: [],
          message: 'No EPG data available for this channel'
        });
      }

      // Get time window: from now to 7 days later
      const now = new Date();
      const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      logger.info(`Searching for programs between ${now.toISOString()} and ${endDate.toISOString()} (7-day window)`);

      // Get programs for this channel
      const epgDatabaseService = require('../services/epgDatabaseService');
      const programs = await epgDatabaseService.getProgramsByChannelId(epgChannelId, now, endDate);

      // Find current program
      const currentProgram = programs.find(p => {
        try {
          const startTime = new Date(p.start);
          const stopTime = new Date(p.stop);
          const currentTime = new Date();
          return startTime <= currentTime && stopTime >= currentTime;
        } catch (err) {
          return false;
        }
      });

      // Get sources list for context
      const sourcesResult = await postgresService.query('SELECT id, name FROM epg_sources ORDER BY name');
      const sourcesList = sourcesResult.rows;

      // Disable caching to ensure fresh EPG data
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      return res.json({
        success: true,
        channelId,
        channel: channelInfo,
        programs,
        currentProgram,
        sources: sourcesList,
        timeWindow: {
          start: now.toISOString(),
          end: endDate.toISOString()
        }
      });
    } catch (error) {
      logger.error(`Error getting channel data: ${error.message}`);
      return res.status(500).json({
        error: `Failed to get channel data: ${error.message}`,
        success: false,
        channelId
      });
    }
  } catch (error) {
    logger.error(`Error in channel data endpoint: ${error.message}`);
    res.status(500).json({
      error: `Server error: ${error.message}`,
      success: false
    });
  }
});

/**
 * GET /:sessionId/sources
 * Get all EPG sources for a session
 */
router.get('/:sessionId/sources', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    logger.info(`Getting EPG sources for session ${sessionId}, user ${userId || 'none'}`);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const sources = await epgSourceService.getEpgSourcesWithStats(userId);

    // Filter to only enabled sources if requested
    const enabledOnly = req.query.enabled === 'true';
    const filteredSources = enabledOnly ? sources.filter(s => s.enabled) : sources;

    return res.json({
      success: true,
      sessionId,
      sources: filteredSources,
      count: filteredSources.length,
      totalAvailable: sources.length,
      enabledCount: sources.filter(s => s.enabled).length,
      message: `Retrieved ${filteredSources.length} EPG sources (${sources.filter(s => s.enabled).length} enabled)`
    });
  } catch (error) {
    logger.error(`Error getting EPG sources: ${error.message}`);
    return res.status(500).json({
      error: `Failed to get EPG sources: ${error.message}`,
      success: false
    });
  }
});

/**
 * POST /:sessionId/match
 * Match an EPG channel to an M3U channel and save to session
 */
router.post('/:sessionId/match', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { epgChannel, m3uChannel, useDummyEpg } = req.body;

    logger.info(`Matching EPG channel to M3U channel in session ${sessionId}${useDummyEpg ? ' (with dummy EPG)' : ''}`);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    if (!epgChannel || !m3uChannel) {
      return res.status(400).json({
        error: 'Both epgChannel and m3uChannel are required',
        received: { hasEpgChannel: !!epgChannel, hasM3uChannel: !!m3uChannel }
      });
    }

    // Get session
    const session = sessionStorage.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Initialize session.data if not exists
    if (!session.data) {
      session.data = {};
    }

    // Initialize matched channels array if not exists
    if (!session.data.matches) {
      session.data.matches = [];
    }

    // Check if match already exists and update or add new
    const existingMatchIndex = session.data.matches.findIndex(
      match => match.m3uChannel.id === m3uChannel.id
    );

    if (existingMatchIndex !== -1) {
      // Update existing match
      session.data.matches[existingMatchIndex] = { epgChannel, m3uChannel };
      logger.info(`Updated existing match for channel ${m3uChannel.name}`);
    } else {
      // Add new match
      session.data.matches.push({ epgChannel, m3uChannel });
      logger.info(`Added new match for channel ${m3uChannel.name} with EPG ${epgChannel.name}`);
    }

    // Update session
    sessionStorage.updateSession(sessionId, session);

    // Save match to database for persistence
    try {
      const userId = req.user?.id;
      await epgMatchService.saveMatch(sessionId, userId, m3uChannel.id, epgChannel.id, useDummyEpg);
    } catch (dbError) {
      logger.error(`Failed to save match to database: ${dbError.message}`);
    }

    return res.json({
      success: true,
      sessionId,
      message: `EPG channel ${epgChannel.name} matched to M3U channel ${m3uChannel.name}`,
      matchCount: session.data.matches.length
    });
  } catch (error) {
    logger.error(`Error matching channels: ${error.message}`);
    return res.status(500).json({
      error: `Failed to match channels: ${error.message}`,
      success: false
    });
  }
});

/**
 * DELETE /:sessionId/match/:iptvChannelId
 * Remove a match for an IPTV channel
 */
router.delete('/:sessionId/match/:iptvChannelId', async (req, res) => {
  try {
    const { sessionId, iptvChannelId } = req.params;
    const userId = req.user?.id;

    logger.info(`Deleting match for channel ${iptvChannelId} in session ${sessionId}${userId ? ` (user ${userId})` : ''}`);

    await epgMatchService.deleteMatch(sessionId, userId, iptvChannelId);

    return res.json({
      success: true,
      message: 'Match deleted successfully'
    });
  } catch (error) {
    logger.error(`Error deleting match: ${error.message}`);
    return res.status(500).json({
      error: `Failed to delete match: ${error.message}`,
      success: false
    });
  }
});

module.exports = router;
