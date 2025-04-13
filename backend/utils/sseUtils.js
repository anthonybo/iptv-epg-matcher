const logger = require('../config/logger');

// Map to store SSE client connections
const sseClients = new Map();

/**
 * Sends an SSE update to a specific client
 * @param {object} res - Express response object
 * @param {object} data - Data to send
 */
function sendSSEUpdate(res, data) {
  try {
    const dataString = JSON.stringify(data);
    const logData = data.type === 'heartbeat' 
      ? `[Heartbeat event]` 
      : `${data.type || 'unknown'}: ${JSON.stringify(data).substring(0, 100)}${dataString.length > 100 ? '...' : ''}`;
    
    logger.debug(`Sending SSE event: ${logData}`);
    
    // Write the event data
    res.write(`data: ${dataString}\n\n`);
    
    // Force flush if available, but don't error if not
    if (res.flush && typeof res.flush === 'function') {
      try {
        res.flush();
      } catch (flushError) {
        logger.debug(`Flush not supported or failed: ${flushError.message}`);
      }
    }
  } catch (error) {
    logger.error('Error sending SSE update:', error);
  }
}

/**
 * Normalize session ID to ensure it's always a string
 * @param {string|object} sessionId - Session ID (string or object with sessionId)
 * @returns {string|null} - Normalized session ID or null if invalid
 */
function normalizeSessionId(sessionId) {
  if (!sessionId) return null;
  
  // Already a string
  if (typeof sessionId === 'string') return sessionId;
  
  // Handle object with sessionId property
  if (typeof sessionId === 'object' && sessionId.sessionId) {
    return sessionId.sessionId;
  }
  
  // Convert to string if needed
  if (sessionId.toString && typeof sessionId.toString === 'function') {
    const idStr = sessionId.toString();
    if (idStr !== '[object Object]') {
      return idStr;
    }
  }
  
  logger.warn(`Invalid session ID format: ${JSON.stringify(sessionId)}`);
  return null;
}

/**
 * Get the current call stack as a string for debugging
 * @returns {string} The formatted call stack
 */
function getDebugCallstack() {
  const stackObj = {};
  Error.captureStackTrace(stackObj);
  const stack = stackObj.stack
    .split('\n')
    .slice(2) // Skip this function and the caller
    .map(line => line.trim())
    .join('\n  ');
  return stack;
}

/**
 * Broadcasts an SSE update to all clients or a specific session
 * @param {object} data - Data to broadcast
 * @param {string|object|null} specificSessionId - Optional session ID to target
 */
function broadcastSSEUpdate(data, specificSessionId = null) {
  try {
    // Prevent broadcasting with null session ID
    if (specificSessionId === null || specificSessionId === 'null' || specificSessionId === 'undefined') {
      logger.warn(`Attempted to broadcast to invalid session ID: ${JSON.stringify(specificSessionId)}`, {
        dataType: data?.type || 'unknown',
        callstack: getDebugCallstack()
      });
      return; // Exit early without trying to broadcast
    }
    
    // Log details about who we're broadcasting to and what
    if (specificSessionId) {
      const normalizedId = normalizeSessionId(specificSessionId);
      
      if (!normalizedId) {
        logger.warn(`Cannot broadcast: Invalid session ID format: ${JSON.stringify(specificSessionId)}`);
        return;
      }
      
      logger.debug(`Attempting to broadcast to session ${normalizedId}, data type: ${data.type || 'unknown'}`);
      
      // Try to broadcast using the new app.locals.sessions system if available
      const app = global.app;
      if (app && app.locals && app.locals.sessions && app.locals.sessions[normalizedId]) {
        const session = app.locals.sessions[normalizedId];
        if (session.clients && session.clients.length > 0) {
          logger.debug(`Broadcasting to ${session.clients.length} clients for session ${normalizedId} using app.locals`);
          
          let deadClients = [];
          session.clients.forEach((client, index) => {
            try {
              if (client.send && typeof client.send === 'function') {
                client.send(data.type, data);
              } else if (client.res && !client.res.writableEnded) {
                const dataString = JSON.stringify(data);
                client.res.write(`data: ${dataString}\n\n`);
              }
            } catch (clientError) {
              logger.error(`Error sending update to client in session ${normalizedId}: ${clientError.message}`);
              deadClients.push(index);
            }
          });
          
          // Clean up dead clients
          if (deadClients.length > 0) {
            for (let i = deadClients.length - 1; i >= 0; i--) {
              session.clients.splice(deadClients[i], 1);
            }
            logger.debug(`Removed ${deadClients.length} dead clients from session ${normalizedId}`);
          }
          
          // Update session last accessed time
          session.lastAccessed = new Date();
          
          logger.debug(`Broadcast SSE update to session ${normalizedId} using app.locals.sessions`);
          return;
        }
      }
      
      // Fall back to the legacy sseClients map
      if (sseClients.has(normalizedId)) {
        const clients = sseClients.get(normalizedId);
        logger.debug(`Broadcasting to ${clients.length} clients for session ${normalizedId} using legacy sseClients`);
        
        clients.forEach(client => {
          try {
            sendSSEUpdate(client, data);
          } catch (clientError) {
            logger.error(`Error sending update to specific client: ${clientError.message}`);
          }
        });
        logger.debug(`Broadcast SSE update to session ${normalizedId} using legacy method`);
      } else {
        logger.debug(`Cannot broadcast to session ${normalizedId}: No active connections found in any system`);
      }
    } else {
      // Broadcast to all connected clients in both systems
      logger.debug(`Broadcasting to all sessions.`);
      let clientCount = 0;
      
      // First try the new app.locals.sessions system
      const app = global.app;
      if (app && app.locals && app.locals.sessions) {
        Object.entries(app.locals.sessions).forEach(([sessionId, session]) => {
          if (session.clients && session.clients.length > 0) {
            session.clients.forEach(client => {
              try {
                if (client.send && typeof client.send === 'function') {
                  client.send(data.type, {
                    ...data,
                    sessionId
                  });
                  clientCount++;
                } else if (client.res && !client.res.writableEnded) {
                  const dataString = JSON.stringify({
                    ...data,
                    sessionId
                  });
                  client.res.write(`data: ${dataString}\n\n`);
                  clientCount++;
                }
              } catch (clientError) {
                logger.error(`Error sending update to client in session ${sessionId}: ${clientError.message}`);
              }
            });
            
            // Update session last accessed time
            session.lastAccessed = new Date();
          }
        });
      }
      
      // Also try the legacy sseClients map
      sseClients.forEach((clients, sessionId) => {
        clients.forEach(client => {
          try {
            sendSSEUpdate(client, {
              ...data,
              sessionId
            });
            clientCount++;
          } catch (clientError) {
            logger.error(`Error sending update to client in session ${sessionId}: ${clientError.message}`);
          }
        });
      });
      
      logger.debug(`Broadcast SSE update to ${clientCount} clients`);
    }
  } catch (error) {
    logger.error('Error broadcasting SSE update:', error);
  }
}

/**
 * Close all SSE connections for a session
 * @param {string} sessionId - The session ID to close connections for
 */
function closeSession(sessionId) {
  // Validate sessionId to prevent null session errors
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error(`Invalid session ID passed to closeSession`, { 
      providedSessionId: String(sessionId)
    });
    return; // Don't proceed with invalid sessionIds
  }
  
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) {
    logger.warn(`Cannot close session: Invalid session ID format: ${JSON.stringify(sessionId)}`);
    return;
  }

  if (sseClients.has(normalizedId)) {
    const clients = sseClients.get(normalizedId);
    logger.info(`Closing ${clients.length} SSE connections for session: ${normalizedId}`);
    
    // Send a close event to all clients
    const closeData = {
      type: 'close',
      message: 'Server closing connection',
      timestamp: new Date().toISOString()
    };
    
    clients.forEach(client => {
      try {
        // Send close notification
        sendSSEUpdate(client, closeData);
        // End the response
        client.end();
      } catch (err) {
        logger.debug(`Error closing client connection: ${err.message}`);
      }
    });
    
    // Remove all clients for this session
    sseClients.delete(normalizedId);
    logger.info(`Closed SSE connection and removed session: ${normalizedId}`);
  } else {
    logger.debug(`No SSE clients to close for session: ${normalizedId}`);
  }
}

/**
 * Registers a new SSE client
 * @param {string} sessionId - Session ID
 * @param {object} res - Express response object
 */
function registerSSEClient(sessionId, res) {
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) {
    logger.warn(`Cannot register client: Invalid session ID: ${JSON.stringify(sessionId)}`);
    return;
  }
  
  if (!sseClients.has(normalizedId)) {
    sseClients.set(normalizedId, []);
  }
  sseClients.get(normalizedId).push(res);
  logger.info(`Registered new SSE client for session: ${normalizedId}`);
}

/**
 * Removes an SSE client
 * @param {string} sessionId - Session ID
 * @param {object} res - Express response object
 */
function removeSSEClient(sessionId, res) {
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) {
    logger.warn(`Cannot remove client: Invalid session ID: ${JSON.stringify(sessionId)}`);
    return;
  }
  
  if (sseClients.has(normalizedId)) {
    const clients = sseClients.get(normalizedId).filter(client => client !== res);
    if (clients.length > 0) {
      sseClients.set(normalizedId, clients);
    } else {
      sseClients.delete(normalizedId);
      logger.info(`Closed SSE connection for session: ${normalizedId} (note: session data is still preserved)`);
    }
  }
}

module.exports = {
  sseClients,
  sendSSEUpdate,
  broadcastSSEUpdate,
  registerSSEClient,
  removeSSEClient,
  closeSession
};