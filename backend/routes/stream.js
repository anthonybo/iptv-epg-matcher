const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getSession } = require('../utils/storageUtils');
const logger = require('../config/logger');
const sessionStorage = require('../utils/sessionStorage');
const { PassThrough } = require('stream');

/**
 * GET /:sessionId/:channelId
 * Stream a channel by redirecting to the appropriate URL
 * Supports both direct streaming and format conversion
 */
router.get('/:sessionId/:channelId', async (req, res) => {
    try {
        const { sessionId, channelId } = req.params;
        const format = req.query.format || 'ts'; // Default to ts format
        
        logger.info(`Stream request for session ${sessionId}, channel ${channelId}, format ${format}`);
        
        // Get session data using sessionStorage module directly
        let session = sessionStorage.getSession(sessionId);

        // Check if session exists
        if (!session) {
            logger.warn(`Session ${sessionId} not found for streaming. Auto-creating...`);
            
            // Create a simple session with empty channels array
            session = sessionStorage.createSession(sessionId, { 
                data: { channels: [] } 
            });
            
            logger.info(`Auto-created session ${sessionId} for streaming`);
        }
        
        // Ensure channels array exists
        if (!session.data || !session.data.channels) {
            logger.warn(`Session ${sessionId} has no data.channels array, initializing it`);
            // Update session with proper structure
            session = sessionStorage.updateSession(sessionId, {
                data: { channels: [] }
            });
        }
        
        // Check if session has channels
        if (!session.data.channels || session.data.channels.length === 0) {
            logger.error(`Session ${sessionId} exists but has no channels`);
            return res.status(404).json({ error: 'No channels loaded for this session' });
        }
        
        // Normalize channelId - either with or without 'channel_' prefix
        let normalizedChannelId = channelId;
        let channel;
        
        // Try to find the channel with the exact ID first
        channel = session.data.channels.find(ch => ch.tvgId === channelId);
        
        // If not found, try adding 'channel_' prefix if it's not already there
        if (!channel && !channelId.startsWith('channel_')) {
            normalizedChannelId = `channel_${channelId}`;
            channel = session.data.channels.find(ch => ch.tvgId === normalizedChannelId);
            logger.info(`Channel not found with ID ${channelId}, trying with prefix: ${normalizedChannelId}`);
        }
        
        // If still not found and has 'channel_' prefix, try without it
        if (!channel && channelId.startsWith('channel_')) {
            normalizedChannelId = channelId.replace(/^channel_/, '');
            channel = session.data.channels.find(ch => ch.tvgId === normalizedChannelId);
            logger.info(`Channel not found with ID ${channelId}, trying without prefix: ${normalizedChannelId}`);
        }
        
        if (!channel) {
            logger.error(`Channel not found: ${channelId} in session ${sessionId}`);
            return res.status(404).json({ error: 'Channel not found' });
        }
        
        if (!channel.url) {
            logger.error(`No stream URL for channel ${channelId}`);
            return res.status(400).json({ error: 'No stream URL for this channel' });
        }
        
        logger.info(`Streaming channel: ${channel.name} (${normalizedChannelId}) from URL: ${channel.url}`);
        
        // Option 1: Simple redirect to the original URL
        if (req.query.redirect === 'true') {
            return res.redirect(channel.url);
        }
        
        // For HEAD requests, don't try to stream, just check availability
        if (req.method === 'HEAD') {
            try {
                // Test if the URL is reachable
                const testResponse = await fetch(channel.url, {
                    method: 'HEAD',
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                    }
                });
                
                if (!testResponse.ok) {
                    logger.warn(`Stream URL check failed for ${channelId}: ${testResponse.status} ${testResponse.statusText}`);
                    return res.status(502).json({
                        error: 'Stream source unavailable',
                        details: `Source returned: ${testResponse.status} ${testResponse.statusText}`
                    });
                }
                
                // If we get here, the URL is reachable
                return res.status(200).end();
            } catch (error) {
                let statusCode = 502;
                let errorMessage = 'Stream source unavailable';
                
                // DNS resolution errors
                if (error.code === 'ENOTFOUND') {
                    errorMessage = 'Stream source domain cannot be resolved';
                    logger.error(`DNS resolution failed for stream URL: ${channel.url}`);
                } else if (error.code === 'ETIMEDOUT' || error.cause?.code === 'ETIMEDOUT') {
                    errorMessage = 'Stream source connection timed out';
                } else if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
                    errorMessage = 'Stream source connection was refused';
                }
                
                logger.error(`Stream availability check failed: ${error.message}`, {
                    channelId,
                    url: channel.url,
                    errorCode: error.code || error.cause?.code
                });
                
                return res.status(statusCode).json({
                    error: errorMessage,
                    details: error.message
                });
            }
        }
        
        // Option 2: Proxy the stream with potential format conversion
        // Stream video using pipe (more efficient for large data)
        try {
            // Set appropriate headers for streaming
            res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            // Fetch and pipe the stream
            const streamResponse = await fetch(channel.url, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                },
                timeout: 60000, // Increase timeout to 60 seconds
            });
            
            if (!streamResponse.ok) {
                logger.error(`Failed to fetch stream: ${streamResponse.status} ${streamResponse.statusText}`);
                return res.status(502).json({ 
                    error: 'Failed to fetch stream from source',
                    status: streamResponse.status,
                    message: streamResponse.statusText
                });
            }
            
            // Create a pass-through stream for better error handling
            const passThrough = new PassThrough();
            
            // Handle errors on the source stream
            streamResponse.body.on('error', (err) => {
                logger.error(`Source stream error for channel ${channelId}: ${err.message}`);
                passThrough.destroy(err);
            });
            
            // Handle errors on the response stream
            res.on('error', (err) => {
                logger.error(`Response stream error for channel ${channelId}: ${err.message}`);
                streamResponse.body.destroy();
                passThrough.destroy();
            });
            
            // Handle client disconnect
            req.on('close', () => {
                try {
                    logger.info(`Stream closed for channel ${channelId}`);
                    streamResponse.body.destroy();
                    passThrough.destroy();
                } catch (err) {
                    logger.error(`Error closing stream: ${err.message}`);
                }
            });
            
            // Pipe through our pass-through stream for better control
            streamResponse.body.pipe(passThrough).pipe(res);
            
            // Set a timeout on the whole operation
            const streamTimeout = setTimeout(() => {
                logger.warn(`Stream timeout for channel ${channelId}`);
                streamResponse.body.destroy(new Error('Stream timeout'));
                passThrough.destroy(new Error('Stream timeout'));
            }, 300000); // 5 minute timeout
            
            // Clear timeout when stream ends or errors
            passThrough.on('end', () => {
                logger.info(`Stream completed successfully for channel ${channelId}`);
                clearTimeout(streamTimeout);
            });
            
            passThrough.on('error', () => {
                clearTimeout(streamTimeout);
            });
            
        } catch (streamError) {
            // Handle common stream errors
            let errorMessage = 'Error streaming content';
            let statusCode = 500;
            
            // Adjust error message based on specific error types
            if (streamError.code === 'ENOTFOUND' || streamError.message.includes('ENOTFOUND')) {
                errorMessage = 'Stream source cannot be found (DNS resolution failed)';
                statusCode = 502;
            } else if (streamError.code === 'ETIMEDOUT' || streamError.message.includes('ETIMEDOUT')) {
                errorMessage = 'Stream source connection timed out';
                statusCode = 504;
            } else if (streamError.code === 'ECONNREFUSED' || streamError.message.includes('ECONNREFUSED')) {
                errorMessage = 'Stream source connection was refused';
                statusCode = 502;
            }
            
            logger.error(`${errorMessage}: ${streamError.message}`, { 
                error: streamError.message,
                stack: streamError.stack,
                channelId,
                url: channel.url
            });
            
            // If streaming has already started, we can't send a JSON response
            if (!res.headersSent) {
                return res.status(statusCode).json({ 
                    error: errorMessage,
                    details: streamError.message
                });
            }
        }
        
    } catch (error) {
        logger.error(`Stream error: ${error.message}`, { 
            error: error.message,
            stack: error.stack
        });
        
        // Only send response if headers haven't been sent yet
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

/**
 * GET /xtream/:sessionId/:type/:id
 * Special handler for Xtream format URLs
 */
router.get('/xtream/:sessionId/:type/:id', async (req, res) => {
    try {
        const { sessionId, type, id } = req.params;
        const format = req.query.format || 'ts';
        
        logger.info(`Xtream stream request for session ${sessionId}, type ${type}, id ${id}`);
        
        // Get session data with Xtream credentials
        const session = getSession(sessionId);
        if (!session || !session.xtreamUsername || !session.xtreamPassword || !session.xtreamServer) {
            return res.status(404).json({ error: 'Session not found or no Xtream credentials' });
        }
        
        const { xtreamUsername, xtreamPassword, xtreamServer } = session;
        
        // Construct the Xtream URL
        const xtreamUrl = `${xtreamServer}/live/${xtreamUsername}/${xtreamPassword}/${id}.${format}`;
        
        logger.info(`Proxying Xtream stream: ${xtreamUrl}`);
        
        // Option 1: Simple redirect
        if (req.query.redirect === 'true') {
            return res.redirect(xtreamUrl);
        }
        
        // Option 2: Proxy the stream
        try {
            // Set streaming headers
            res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            // Fetch and pipe the stream
            const streamResponse = await fetch(xtreamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                }
            });
            
            if (!streamResponse.ok) {
                logger.error(`Failed to fetch Xtream stream: ${streamResponse.status} ${streamResponse.statusText}`);
                return res.status(502).json({ 
                    error: 'Failed to fetch stream from Xtream source',
                    status: streamResponse.status,
                    message: streamResponse.statusText
                });
            }
            
            // Pipe the response directly
            streamResponse.body.pipe(res);
            
            // Handle client disconnect
            req.on('close', () => {
                try {
                    streamResponse.body.destroy();
                    logger.info(`Xtream stream closed for id ${id}`);
                } catch (err) {
                    logger.error(`Error closing Xtream stream: ${err.message}`);
                }
            });
            
        } catch (streamError) {
            logger.error(`Error streaming Xtream content: ${streamError.message}`, {
                error: streamError.message,
                stack: streamError.stack
            });
            
            if (!res.headersSent) {
                return res.status(500).json({ 
                    error: 'Error streaming Xtream content',
                    message: streamError.message
                });
            }
        }
        
    } catch (error) {
        logger.error(`Xtream stream error: ${error.message}`, {
            error: error.message,
            stack: error.stack
        });
        
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

/**
 * Routes for handling Server-Sent Events (SSE)
 */
const { registerSSEClient, removeSSEClient, broadcastSSEUpdate } = require('../utils/sseUtils');

// Middleware to set SSE headers and prevent connection timeout
function sseHeaders(req, res, next) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent Nginx buffering
  res.flushHeaders();
  
  // Set up a heartbeat to prevent connection timeout
  const heartbeatInterval = setInterval(() => {
    if (!res.finished) {
      try {
        res.write(`:heartbeat ${new Date().toISOString()}\n\n`);
        // Don't use res.flush() here to avoid potential errors
      } catch (error) {
        logger.error(`Error sending heartbeat: ${error.message}`);
        clearInterval(heartbeatInterval);
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000); // Every 30 seconds
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    
    // Get the sessionId from params - check for null or invalid values
    const sessionId = req.params.sessionId || null;
    if (sessionId && sessionId !== 'null' && sessionId !== 'undefined') {
      removeSSEClient(sessionId, res);
    } else {
      logger.warn('Client disconnected with invalid session ID');
    }
  });
  
  next();
}

/**
 * GET /api/stream-updates/:sessionId
 * Establishes an SSE connection for real-time updates
 */
router.get('/:sessionId', sseHeaders, (req, res) => {
  const { sessionId } = req.params;
  
  // Validate session ID
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error('Invalid session ID provided for SSE connection', { sessionId });
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  
  try {
    // Log the connection
    logger.info(`New SSE connection established for session: ${sessionId}`);
    
    // Register the client
    registerSSEClient(sessionId, res);
    
    // Send initial connection event
    broadcastSSEUpdate({
      type: 'connection',
      message: 'SSE connection established',
      sessionId
    }, sessionId);
    
  } catch (error) {
    logger.error(`Error establishing SSE connection: ${error.message}`, { 
      sessionId, 
      error: error.message 
    });
    res.status(500).end();
  }
});

module.exports = router;