/**
 * Dedicated routes for SSE (Server-Sent Events)
 */
const express = require('express');
const router = express.Router();
const { registerSSEClient, removeSSEClient, sendSSEUpdate, broadcastSSEUpdate } = require('../utils/sseUtils');
const logger = require('../config/logger');

/**
 * Middleware to set up SSE connection headers and handling
 */
function sseMiddleware(req, res, next) {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Prevent Nginx buffering
  });

  // Remove timeouts for long-lived connections
  req.setTimeout(0);
  res.setTimeout(0);
  
  // Send an initial newline to establish connection
  res.write('\n');
  
  // Set up heartbeat to keep connection alive
  const heartbeatInterval = setInterval(() => {
    if (!res.finished) {
      try {
        sendSSEUpdate(res, { 
          type: 'heartbeat', 
          timestamp: new Date().toISOString() 
        });
      } catch (error) {
        logger.error(`Error sending heartbeat: ${error.message}`);
        clearInterval(heartbeatInterval);
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000); // Send heartbeat every 30 seconds
  
  // Handle client disconnect
  req.on('close', () => {
    const { sessionId } = req.params;
    
    // Validate sessionId before using it
    if (sessionId && sessionId !== 'null' && sessionId !== 'undefined') {
      clearInterval(heartbeatInterval);
      logger.info(`SSE connection closed for session: ${sessionId}`);
      removeSSEClient(sessionId, res);
    } else {
      logger.warn(`SSE connection closed with invalid sessionId: ${sessionId}`);
      clearInterval(heartbeatInterval);
    }
  });
  
  next();
}

/**
 * GET /:sessionId
 * Establishes an SSE connection for real-time updates
 */
router.get('/:sessionId', sseMiddleware, (req, res) => {
  const { sessionId } = req.params;
  
  // Validate sessionId
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error(`Invalid sessionId for SSE connection: ${sessionId}`);
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  
  logger.info(`New SSE connection established for session: ${sessionId}`);
  
  // Register the client connection
  registerSSEClient(sessionId, res);
  
  // Send initial connection confirmation
  sendSSEUpdate(res, {
    type: 'connection',
    message: 'SSE connection established',
    sessionId,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;