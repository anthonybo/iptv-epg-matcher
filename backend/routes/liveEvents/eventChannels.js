/**
 * GET /api/live-events/:eventId/channels
 * Find IPTV channels that might be showing a specific live event.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const iptvDatabaseService = require('../../services/iptvDatabase');
const { extractSearchTerms, calculateRelevanceScore } = require('../../utils/channelScoring');

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

    // Score and sort channels by relevance using the shared scoring function
    channels = channels.map(channel => {
      const nameLower = channel.name.toLowerCase();

      // Use the shared calculateRelevanceScore function for consistent scoring
      let score = calculateRelevanceScore(channel.name, homeTeam, awayTeam);

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
