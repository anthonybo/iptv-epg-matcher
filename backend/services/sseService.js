const logger = require('../config/logger');

/**
 * Set up SSE (Server-Sent Events) route handler
 * @param {Express.Application} app - Express application instance
 */
function setupSseRoutes(app) {
  // Configure SSE route
  app.get('/api/stream-updates/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    // Validate session id
    if (!sessionId) {
      logger.error('SSE connection attempted without session ID');
      return res.status(400).send('Session ID is required');
    }
    
    logger.info(`SSE connection request for session ${sessionId}`);
    
    // Set up SSE connection headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // For NGINX proxy
    
    // Add explicit CORS headers
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Send headers immediately
    res.flushHeaders();
    
    // Write initial comment to establish connection
    res.write(':ok\n\n');
    
    // Helper function to send SSE messages
    const sendEvent = (eventType, data) => {
      try {
        if (res.writableEnded) {
          logger.debug(`Cannot send event to ended stream for ${sessionId}`);
          return;
        }
        
        const event = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        logger.debug(`Sending SSE event to ${sessionId}: ${eventType}`);
        res.write(event);
      } catch (err) {
        logger.error(`Error sending SSE event to ${sessionId}:`, err);
      }
    };
    
    // Initialize session in app storage if it doesn't exist
    if (!app.locals.sessions) {
      app.locals.sessions = {};
    }
    
    // Create or update session
    if (!app.locals.sessions[sessionId]) {
      logger.info(`Creating new session for SSE: ${sessionId}`);
      app.locals.sessions[sessionId] = {
        id: sessionId,
        created: new Date(),
        lastAccessed: new Date(),
        clients: [],
        channels: [],
        categories: []
      };
    }
    
    // Generate a unique client ID
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    
    // Add this client to the session's client list
    app.locals.sessions[sessionId].clients.push({
      id: clientId,
      connected: new Date(),
      remoteAddress: req.ip,
      userAgent: req.headers['user-agent'],
      send: sendEvent
    });
    
    // Update session last accessed time
    app.locals.sessions[sessionId].lastAccessed = new Date();
    
    logger.info(`SSE client ${clientId} connected for session ${sessionId}`);
    
    // Send initial connection confirmation
    sendEvent('register', { 
      type: 'register',
      message: 'Connection established',
      sessionId,
      clientId,
      timestamp: new Date().toISOString()
    });
    
    // Send a heartbeat every 30 seconds to keep the connection alive
    const heartbeatInterval = setInterval(() => {
      try {
        if (res.writableEnded) {
          clearInterval(heartbeatInterval);
          return;
        }
        // Send a comment as heartbeat to keep connection alive
        res.write(`:heartbeat ${new Date().toISOString()}\n\n`);
      } catch (err) {
        logger.error(`Error sending heartbeat to ${sessionId}:`, err);
        clearInterval(heartbeatInterval);
      }
    }, 30000);
    
    // Handle client disconnect
    req.on('close', () => {
      logger.info(`SSE client ${clientId} disconnected from session ${sessionId}`);
      clearInterval(heartbeatInterval);
      
      // Remove client from session
      if (app.locals.sessions[sessionId]) {
        app.locals.sessions[sessionId].clients = app.locals.sessions[sessionId].clients.filter(
          client => client.id !== clientId
        );
        
        // Update session last accessed
        app.locals.sessions[sessionId].lastAccessed = new Date();
      }
    });
  });
}

/**
 * Broadcast an event to all clients connected to a specific session
 * @param {Express.Application} app - Express application instance
 * @param {string} sessionId - Session ID to broadcast to
 * @param {string} eventType - Event type (e.g., 'progress', 'complete')
 * @param {Object} data - Event data to send
 */
function broadcastToSession(app, sessionId, eventType, data) {
  try {
    if (!sessionId) {
      logger.error('Cannot broadcast without session ID');
      return;
    }
    
    logger.debug(`Attempting to broadcast to session ${sessionId}, data type: ${eventType}`);
    
    // Skip if no sessions exist
    if (!app.locals.sessions) {
      logger.debug('No sessions exist in app storage');
      return;
    }
    
    // Get session
    const session = app.locals.sessions[sessionId];
    if (!session) {
      logger.debug(`Session not found: ${sessionId}`);
      return;
    }
    
    // Get active clients
    const { clients } = session;
    if (!clients || clients.length === 0) {
      logger.debug(`No clients connected to session ${sessionId}`);
      return;
    }
    
    // Add session ID to data
    const eventData = {
      ...data,
      sessionId,
      timestamp: new Date().toISOString()
    };
    
    // Ensure type is set in the data
    if (!eventData.type) {
      eventData.type = eventType;
    }
    
    logger.debug(`Broadcasting to ${clients.length} clients for session ${sessionId}`);
    
    // Send to all clients
    const deadClients = [];
    clients.forEach((client, index) => {
      try {
        client.send(eventType, eventData);
      } catch (err) {
        logger.error(`Error sending to client ${client.id}:`, err);
        // Mark this client for removal
        deadClients.push(index);
      }
    });
    
    // Clean up dead clients if needed
    if (deadClients.length > 0) {
      logger.info(`Removing ${deadClients.length} dead clients from session ${sessionId}`);
      // Remove in reverse order to avoid index shifting problems
      for (let i = deadClients.length - 1; i >= 0; i--) {
        clients.splice(deadClients[i], 1);
      }
    }
    
    // Update session last accessed
    session.lastAccessed = new Date();
    
    logger.debug(`Broadcast SSE update to session ${sessionId}`);
  } catch (err) {
    logger.error(`Error broadcasting to session ${sessionId}:`, err);
  }
}

/**
 * Get active sessions with connected clients
 * @param {Express.Application} app - Express application instance
 * @returns {Array} Array of active sessions with client counts
 */
function getActiveSessions(app) {
  if (!app.locals.sessions) {
    return [];
  }
  
  const sessions = [];
  
  for (const [sessionId, session] of Object.entries(app.locals.sessions)) {
    sessions.push({
      id: sessionId,
      created: session.created,
      lastAccessed: session.lastAccessed,
      clientCount: session.clients.length,
      channelCount: session.channels.length,
    });
  }
  
  return sessions;
}

module.exports = {
  setupSseRoutes,
  broadcastToSession,
  getActiveSessions
}; 