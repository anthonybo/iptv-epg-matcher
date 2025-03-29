/**
 * Channels Routes - handles channel-related endpoints
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getSession } = require('../utils/storageUtils');

/**
 * GET /api/channels/:sessionId
 * Gets paginated channels, optionally filtered by category
 */
router.get('/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { page = 1, limit = 1000, category } = req.query;
  const start = (page - 1) * parseInt(limit);
  const end = start + parseInt(limit);

  const session = getSession(sessionId);
  if (!session) {
    logger.error('Session not found', { sessionId });
    return res.status(404).json({ error: 'Session not found' });
  }

  let channels = session.channels;
  if (category) {
    channels = channels.filter(ch => ch.groupTitle === category);
  }
  
  const paginatedChannels = channels.slice(start, end);
  
  logger.debug('Sending paginated channels', { 
    sessionId, 
    page, 
    limit, 
    category, 
    channelCount: paginatedChannels.length 
  });
  
  res.json({
    channels: paginatedChannels,
    totalChannels: channels.length,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

/**
 * GET /api/channels/:sessionId/categories
 * Gets channel categories with counts
 */
router.get('/:sessionId/categories', (req, res) => {
  const { sessionId } = req.params;

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const categoryCounts = session.channels.reduce((acc, ch) => {
    const groupTitle = ch.groupTitle || 'Uncategorized';
    acc[groupTitle] = (acc[groupTitle] || 0) + 1;
    return acc;
  }, {});
  
  const categories = Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    categories,
    total: categories.length
  });
});

/**
 * GET /api/channels/:sessionId/:channelId
 * Gets details of a specific channel
 */
router.get('/:sessionId/:channelId', (req, res) => {
  const { sessionId, channelId } = req.params;

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const decodedChannelId = decodeURIComponent(channelId);
  const channel = session.channels.find(ch => ch.tvgId === decodedChannelId);
  
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  res.json(channel);
});

module.exports = router;