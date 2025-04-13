/**
 * IPTV Routes - handles IPTV provider management and storage
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../utils/logger');
const parser = require('iptv-playlist-parser');
const { getSession, updateSession } = require('../utils/storageUtils');
const iptvDatabaseService = require('../services/iptvDatabaseService');

/**
 * POST /api/iptv/provider
 * Add or update an IPTV provider
 */
router.post('/provider', async (req, res) => {
  try {
    const { name, url, username, password, sessionId } = req.body;
    
    if (!url || !username || !password) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        success: false
      });
    }
    
    logger.info(`Adding/updating IPTV provider: ${name || 'Unnamed'} (${url})`);
    
    // Save provider to database
    const providerResult = await iptvDatabaseService.saveProvider({
      name: name || 'My IPTV Provider',
      url,
      username,
      password
    });
    
    // Test connection to provider
    const connectionResult = await testProviderConnection(url, username, password);
    if (!connectionResult.success) {
      return res.status(400).json({
        error: connectionResult.message,
        success: false
      });
    }
    
    // If sessionId is provided, associate the provider with the session
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.provider = {
          id: providerResult.id,
          name: name || 'My IPTV Provider',
          url,
          username
        };
        updateSession(sessionId, session);
        logger.info(`Associated provider ${providerResult.id} with session ${sessionId}`);
      }
    }
    
    return res.json({
      success: true,
      providerId: providerResult.id,
      isNew: providerResult.isNew,
      message: providerResult.isNew ? 'Provider added successfully' : 'Provider updated successfully'
    });
  } catch (error) {
    logger.error(`Error adding/updating IPTV provider: ${error.message}`);
    return res.status(500).json({
      error: `Error processing request: ${error.message}`,
      success: false
    });
  }
});

/**
 * Test connection to IPTV provider
 */
const testProviderConnection = async (url, username, password) => {
  try {
    // Format the URL to get M3U data
    const m3uUrl = `${url}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    
    logger.info(`Testing connection to provider: ${m3uUrl}`);
    
    // Try to fetch M3U data
    const response = await axios.get(m3uUrl, {
      timeout: 10000,
      responseType: 'text'
    });
    
    if (response.status === 200 && response.data && response.data.includes('#EXTM3U')) {
      return {
        success: true,
        message: 'Successfully connected to IPTV provider'
      };
    } else {
      return {
        success: false,
        message: 'Invalid response from IPTV provider'
      };
    }
  } catch (error) {
    logger.error(`Error connecting to IPTV provider: ${error.message}`);
    return {
      success: false,
      message: `Connection error: ${error.message}`
    };
  }
};

/**
 * GET /api/iptv/provider/:providerId
 * Get provider details
 */
router.get('/provider/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    
    if (!providerId) {
      return res.status(400).json({
        error: 'Provider ID is required',
        success: false
      });
    }
    
    logger.info(`Getting IPTV provider details: ${providerId}`);
    
    // Fetch provider details (excluding password)
    const providerDetails = await iptvDatabaseService.runQuery(
      `SELECT id, name, url, username, last_connected, created_at 
       FROM providers 
       WHERE id = ?`,
      [providerId]
    );
    
    if (!providerDetails || providerDetails.length === 0) {
      return res.status(404).json({
        error: 'Provider not found',
        success: false
      });
    }
    
    return res.json({
      success: true,
      provider: providerDetails[0]
    });
  } catch (error) {
    logger.error(`Error getting IPTV provider details: ${error.message}`);
    return res.status(500).json({
      error: `Error processing request: ${error.message}`,
      success: false
    });
  }
});

/**
 * GET /api/iptv/:sessionId/refresh
 * Fetch latest channel data from IPTV provider and store in database
 */
router.get('/:sessionId/refresh', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
        success: false
      });
    }
    
    const session = getSession(sessionId);
    if (!session || !session.provider) {
      return res.status(404).json({
        error: 'Session not found or no provider associated with session',
        success: false
      });
    }
    
    const { provider } = session;
    
    // Get provider details from database to get credentials
    const providerDetails = await iptvDatabaseService.runQuery(
      'SELECT id, name, url, username, password_hash FROM providers WHERE id = ?',
      [provider.id]
    );
    
    if (!providerDetails || providerDetails.length === 0) {
      return res.status(404).json({
        error: 'Provider not found in database',
        success: false
      });
    }
    
    const { id, url, username, password_hash } = providerDetails[0];
    
    // Send immediate response to client
    res.json({
      success: true,
      message: 'Refresh started, channels will be updated in the background',
      providerId: id
    });
    
    // Fetch provider credentials securely from another source if needed
    // For now, we'll need to retrieve the password from the session
    // This is a workaround, in production you should use a secure method
    
    if (!session.providerPassword) {
      logger.warn(`Missing provider password for refresh operation: ${id}`);
      return; // End background processing
    }

    // Start refreshing channels in the background
    refreshProviderChannels(id, url, username, session.providerPassword, sessionId)
      .then(result => {
        logger.info(`Completed channel refresh for provider ${id}: ${result.savedCount} channels`);
      })
      .catch(error => {
        logger.error(`Error refreshing channels for provider ${id}: ${error.message}`);
      });
    
  } catch (error) {
    logger.error(`Error starting IPTV channel refresh: ${error.message}`);
    return res.status(500).json({
      error: `Error processing request: ${error.message}`,
      success: false
    });
  }
});

/**
 * Refresh channels from IPTV provider
 */
const refreshProviderChannels = async (providerId, url, username, password, sessionId) => {
  try {
    logger.info(`Starting channel refresh for provider ${providerId}`);
    
    // Format the URL to get M3U data
    const m3uUrl = `${url}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    
    // If session is provided, send progress updates
    if (sessionId) {
      const eventBus = require('../utils/eventBus');
      eventBus.emit('sse:update', {
        sessionId,
        data: {
          type: 'progress',
          percentage: 10,
          message: 'Fetching channel data from IPTV provider',
          stage: 'fetch_starting'
        }
      });
    }
    
    // Fetch M3U data
    const response = await axios.get(m3uUrl, {
      timeout: 30000, // 30 second timeout for large playlists
      responseType: 'text'
    });
    
    if (response.status !== 200 || !response.data || !response.data.includes('#EXTM3U')) {
      throw new Error('Invalid response from IPTV provider');
    }
    
    // If session is provided, send progress updates
    if (sessionId) {
      const eventBus = require('../utils/eventBus');
      eventBus.emit('sse:update', {
        sessionId,
        data: {
          type: 'progress',
          percentage: 30,
          message: 'Parsing channel data',
          stage: 'parsing'
        }
      });
    }
    
    // Parse M3U data
    const playlist = parser.parse(response.data);
    
    if (!playlist || !playlist.items || playlist.items.length === 0) {
      throw new Error('No channels found in provider response');
    }
    
    logger.info(`Found ${playlist.items.length} channels from provider ${providerId}`);
    
    // If session is provided, send progress updates
    if (sessionId) {
      const eventBus = require('../utils/eventBus');
      eventBus.emit('sse:update', {
        sessionId,
        data: {
          type: 'progress',
          percentage: 50,
          message: `Processing ${playlist.items.length} channels`,
          stage: 'processing'
        }
      });
    }
    
    // Format channels for database storage
    const channels = playlist.items.map(item => {
      return {
        id: item.tvg.id || item.url.split('/').pop() || `channel_${Math.random().toString(36).substring(2, 10)}`,
        name: item.name || item.tvg.name || 'Unknown Channel',
        group: item.group.title || 'Uncategorized',
        logo: item.tvg.logo || '',
        url: item.url
      };
    });
    
    // If session is provided, send progress updates
    if (sessionId) {
      const eventBus = require('../utils/eventBus');
      eventBus.emit('sse:update', {
        sessionId,
        data: {
          type: 'progress',
          percentage: 70,
          message: 'Saving channels to database',
          stage: 'saving'
        }
      });
    }
    
    // Save channels to database
    const result = await iptvDatabaseService.saveChannels(channels, providerId);
    
    // Update provider's last_connected timestamp
    await iptvDatabaseService.runCommand(
      'UPDATE providers SET last_connected = ? WHERE id = ?',
      [new Date().toISOString(), providerId]
    );
    
    // If session is provided, update channels and send final progress update
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        // Update session with latest channels
        session.channels = channels;
        updateSession(sessionId, session);
        
        // Send final progress update
        const eventBus = require('../utils/eventBus');
        eventBus.emit('sse:update', {
          sessionId,
          data: {
            type: 'progress',
            percentage: 100,
            message: `Successfully refreshed ${result.savedCount} channels`,
            stage: 'complete'
          }
        });
      }
    }
    
    return result;
  } catch (error) {
    logger.error(`Error refreshing channels: ${error.message}`);
    
    // If session is provided, send error progress update
    if (sessionId) {
      const eventBus = require('../utils/eventBus');
      eventBus.emit('sse:update', {
        sessionId,
        data: {
          type: 'progress',
          percentage: 0,
          message: `Error refreshing channels: ${error.message}`,
          stage: 'error'
        }
      });
    }
    
    throw error;
  }
};

/**
 * GET /api/iptv/:sessionId/channels
 * Get all channels for the current session's provider
 */
router.get('/:sessionId/channels', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { category } = req.query;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
        success: false
      });
    }
    
    const session = getSession(sessionId);
    if (!session || !session.provider) {
      return res.status(404).json({
        error: 'Session not found or no provider associated with session',
        success: false
      });
    }
    
    const { provider } = session;
    
    logger.info(`Getting channels for provider: ${provider.id}, session: ${sessionId}`);
    
    // Get channels from database
    let channels = await iptvDatabaseService.getChannelsByProviderId(provider.id);
    
    // Filter by category if specified
    if (category && category !== 'All') {
      channels = channels.filter(channel => channel.group_title === category);
    }
    
    return res.json({
      success: true,
      channels,
      count: channels.length,
      providerId: provider.id,
      providerName: provider.name
    });
  } catch (error) {
    logger.error(`Error getting IPTV channels: ${error.message}`);
    return res.status(500).json({
      error: `Error processing request: ${error.message}`,
      success: false
    });
  }
});

/**
 * GET /api/iptv/:sessionId/categories
 * Get all categories for the current session's provider
 */
router.get('/:sessionId/categories', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
        success: false
      });
    }
    
    const session = getSession(sessionId);
    if (!session || !session.provider) {
      return res.status(404).json({
        error: 'Session not found or no provider associated with session',
        success: false
      });
    }
    
    const { provider } = session;
    
    logger.info(`Getting categories for provider: ${provider.id}, session: ${sessionId}`);
    
    // Get categories from database
    const categories = await iptvDatabaseService.getCategoriesByProviderId(provider.id);
    
    return res.json({
      success: true,
      categories,
      count: categories.length,
      providerId: provider.id,
      providerName: provider.name
    });
  } catch (error) {
    logger.error(`Error getting IPTV categories: ${error.message}`);
    return res.status(500).json({
      error: `Error processing request: ${error.message}`,
      success: false
    });
  }
});

/**
 * POST /api/iptv/:sessionId/match
 * Match an IPTV channel with an EPG channel
 */
router.post('/:sessionId/match', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { iptvChannelId, epgChannelId } = req.body;
    
    if (!sessionId || !iptvChannelId || !epgChannelId) {
      return res.status(400).json({
        error: 'Session ID, IPTV channel ID and EPG channel ID are required',
        success: false
      });
    }
    
    logger.info(`Matching IPTV channel ${iptvChannelId} with EPG channel ${epgChannelId}`);
    
    // Save the mapping to database
    const mappingResult = await iptvDatabaseService.saveChannelMapping(iptvChannelId, epgChannelId);
    
    return res.json({
      success: true,
      mapping: mappingResult,
      message: 'Channel mapping saved successfully'
    });
  } catch (error) {
    logger.error(`Error matching channels: ${error.message}`);
    return res.status(500).json({
      error: `Error processing request: ${error.message}`,
      success: false
    });
  }
});

/**
 * GET /api/iptv/stats
 * Get database statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await iptvDatabaseService.getDatabaseStats();
    
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error getting IPTV database stats: ${error.message}`);
    res.status(500).json({
      error: `Failed to get database stats: ${error.message}`,
      success: false
    });
  }
});

module.exports = router; 