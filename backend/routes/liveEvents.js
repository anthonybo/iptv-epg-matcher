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

module.exports = router;
