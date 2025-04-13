/**
 * Channels Routes - handles channel-related endpoints
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const sessionStorage = require('../utils/sessionStorage');

/**
 * GET /api/channels/:sessionId
 * Gets paginated channels, optionally filtered by category
 */
router.get('/:sessionId', async (req, res) => {
  try {
    // Get session ID from path parameter or query parameter
    let sessionId = req.params.sessionId;
    
    // Extract pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000); // Cap at 1000 channels max
    const category = req.query.category || null;
    
    // Log debugging info about the request
    logger.info(`CHANNEL REQUEST RECEIVED: sessionId=${sessionId}`, {
      url: req.originalUrl,
      params: req.params,
      query: req.query,
      sessionIdFromParams: req.params.sessionId,
      sessionIdFromQuery: req.query.sessionId
    });
    
    // Also check query parameter as a fallback
    if ((!sessionId || sessionId === 'null' || sessionId === 'undefined') && req.query.sessionId) {
      sessionId = req.query.sessionId;
      logger.debug(`Using query parameter sessionId instead: ${sessionId}`);
    }
    
    // Validate session ID
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
      logger.warn(`INVALID SESSION ID: ${sessionId}`);
      return res.status(400).json({ 
        error: 'Invalid session ID', 
        message: 'A valid session ID is required to retrieve channels',
        code: 'INVALID_SESSION_ID'
      });
    }
    
    // Get session data
    const sessionData = sessionStorage.getSession(sessionId);
    
    if (!sessionData) {
      logger.warn(`Session not found: ${sessionId}`);
      
      // Return test channels for easier debugging
      const testChannels = generateTestChannels(10);
      logger.info(`Returning ${testChannels.length} test channels for missing session ${sessionId}`);
      
      return res.json({
        channels: testChannels,
        categories: generateCategories(testChannels),
        totalChannels: testChannels.length,
        fromTest: true,
        message: 'Session not found, returning test data'
      });
    }
    
    // Check if channels exist in the session data
    const allChannels = sessionData.data?.channels;
    if (!allChannels || allChannels.length === 0) {
      // If no channels, return test channels for development
      const testChannels = generateTestChannels(50);
      logger.info(`No channels found in session ${sessionId}, returning ${testChannels.length} test channels`);
      
      // Update the session with test channels
      sessionStorage.updateSession(sessionId, {
        data: {
          ...(sessionData.data || {}),
          channels: testChannels
        }
      });
      
      return res.json({
        channels: testChannels,
        categories: generateCategories(testChannels),
        totalChannels: testChannels.length,
        fromTest: true
      });
    }

    // Apply category filter if provided
    let filteredChannels = allChannels;
    if (category) {
      filteredChannels = allChannels.filter(ch => ch.groupTitle === category);
    }
    
    // Apply pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedChannels = filteredChannels.slice(startIndex, endIndex);
    
    // Calculate total pages
    const totalChannels = filteredChannels.length;
    const totalPages = Math.ceil(totalChannels / limit);
    
    logger.info(`Returning page ${page}/${totalPages} with ${paginatedChannels.length} channels for session ${sessionId}`);

    // Get categories from the session or generate them
    let categories = sessionData.data.categories;
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      logger.debug(`Generating categories for response as none exist in session`);
      categories = generateCategories(allChannels);
      
      // Store in session for future use
      sessionStorage.updateSession(sessionId, {
        data: {
          ...sessionData.data,
          categories
        }
      });
    }
    
    // Return paginated channels with metadata
    res.json({
      channels: paginatedChannels,
      pagination: {
        page,
        limit,
        totalChannels,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      totalChannels: totalChannels,
      categories: categories
    });

  } catch (error) {
    logger.error(`Error retrieving channels: ${error.message}`, {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Internal server error', 
      message: 'An unexpected error occurred while retrieving channels.'
    });
  }
});

/**
 * GET /api/channels/session/:sessionId
 * Alternative endpoint for getting channels
 */
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.debug(`Alternative channel route called with sessionId: ${sessionId}`);
    
    // Forward to the main handler
    req.params.sessionId = sessionId;
    return router.handle(req, res);
    
  } catch (error) {
    logger.error(`Error in alternative channel route: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/channels/:sessionId/categories
 * Gets channel categories with counts
 */
router.get('/:sessionId/categories', (req, res) => {
  const { sessionId } = req.params;

  logger.debug(`REQUEST RECEIVED for categories: sessionId=${sessionId}`);

  try {
    const session = sessionStorage.getSession(sessionId);
    
    if (!session || !session.data || !session.data.categories) {
      return res.status(404).json({ 
        error: 'Categories not found', 
        message: 'No categories found for this session'
      });
    }
    
    // Ensure categories are in the expected format
    const rawCategories = session.data.categories;
    let formattedCategories;
    
    // Format the categories depending on what we have
    if (Array.isArray(rawCategories)) {
      // Map to ensure each category has the correct format
      formattedCategories = rawCategories.map(cat => {
        if (typeof cat === 'string') {
          return { name: cat, count: 0 };
        } else if (typeof cat === 'object') {
          return {
            name: cat.name || cat.category || cat.title || 'Unknown',
            count: cat.count || cat.channelCount || 0
          };
        } else {
          return { name: String(cat), count: 0 };
        }
      });
    } else {
      logger.warn(`Categories for session ${sessionId} are not in expected format`);
      formattedCategories = [];
    }
    
    // Sort alphabetically
    formattedCategories.sort((a, b) => a.name.localeCompare(b.name));
    
    logger.info(`Returning ${formattedCategories.length} formatted categories from session data`);
    
    // Return the formatted categories
    return res.json(formattedCategories);
  } catch (error) {
    logger.error(`Error getting categories: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ 
      error: 'Server error', 
      message: 'Failed to retrieve categories'
    });
  }
});

/**
 * GET /api/channels/:sessionId/:channelId
 * Gets details of a specific channel
 */
router.get('/:sessionId/:channelId', (req, res) => {
  const { sessionId, channelId } = req.params;

  const session = sessionStorage.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Safely access the channels through session.data
  if (!session.data || !session.data.channels) {
    return res.status(404).json({ error: 'No channels found in the session' });
  }
  
  const channels = session.data.channels;
  
  const decodedChannelId = decodeURIComponent(channelId);
  const channel = channels.find(ch => ch.tvgId === decodedChannelId);
  
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  res.json(channel);
});

/**
 * Generate test channels for development
 */
function generateTestChannels(count = 50) {
  const categories = ['Movies', 'Sports', 'News', 'Entertainment', 'Kids', 'Documentary'];
  const prefixes = ['US', 'UK', 'CA', 'FR', 'DE', 'ES', 'IT'];
  
  return Array.from({ length: count }, (_, i) => {
    const category = categories[Math.floor(Math.random() * categories.length)];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    
    return {
      id: `ch_${i+1}`,
      tvgId: `${prefix}.${category.toLowerCase()}.${i+1}`,
      name: `${prefix} ${category} ${i+1}`,
      groupTitle: category,
      logo: `https://via.placeholder.com/50x50?text=${prefix}${i+1}`,
      url: `http://example.com/streams/${prefix.toLowerCase()}/${i+1}/index.m3u8`
    };
  });
}

/**
 * Generate categories from channels
 */
function generateCategories(channels) {
  const categoryCounts = channels.reduce((acc, ch) => {
    const groupTitle = ch.groupTitle || 'Uncategorized';
    acc[groupTitle] = (acc[groupTitle] || 0) + 1;
    return acc;
  }, {});
  
  return Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = router;