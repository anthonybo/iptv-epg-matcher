const express = require('express');
const router = express.Router();
const { getSession } = require('../utils/storageUtils');
const { registerSSEClient, removeSSEClient, sendSSEUpdate, broadcastSSEUpdate } = require('../utils/sseUtils');
const logger = require('../config/logger');

/**
 * GET /:sessionId
 * Establishes an SSE connection with the client
 * Streams real-time updates about the processing state
 */
router.get('/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    // Log the connection attempt
    logger.info(`New SSE connection attempt for session: ${sessionId}`);

    // Setup headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Initialize the stream with a connection message
    sendSSEUpdate(res, {
        type: 'connection',
        message: 'SSE connection established',
        sessionId
    });

    // Register client for receiving updates
    registerSSEClient(sessionId, res);
    logger.info(`New SSE connection established for session: ${sessionId}`);

    // Send a heartbeat every 30 seconds to prevent timeouts
    const heartbeatInterval = setInterval(() => {
        try {
            sendSSEUpdate(res, { 
                type: 'heartbeat', 
                timestamp: new Date().toISOString() 
            });
        } catch (error) {
            logger.error(`Error sending heartbeat to session ${sessionId}:`, error);
            clearInterval(heartbeatInterval);
        }
    }, 30000);

    // Send initial data if session already exists
    try {
        const session = getSession(sessionId);
        if (session) {
            logger.info(`Sending initial data for existing session: ${sessionId}`);
            
            // Send channels if available
            if (session.channels && session.channels.length > 0) {
                sendSSEUpdate(res, {
                    type: 'channels_available',
                    message: `${session.channels.length} channels available`,
                    channelCount: session.channels.length,
                    channelList: session.channels.slice(0, 100) // Send only first 100 for performance
                });
                logger.debug(`Sent initial channels list (${session.channels.length} channels) for session ${sessionId}`);
            }
            
            // Send EPG sources if available
            if (session.epgSources) {
                Object.keys(session.epgSources).forEach(sourceKey => {
                    const source = session.epgSources[sourceKey];
                    sendSSEUpdate(res, {
                        type: 'epg_source_available',
                        source: sourceKey,
                        sourceDetails: {
                            channelCount: source.channels?.length || 0,
                            programCount: source.programs?.length || 0
                        }
                    });
                });
                logger.debug(`Sent EPG sources info for session ${sessionId}`);
            }
            
            // Send progress 100% for completed sessions
            sendSSEUpdate(res, {
                type: 'progress',
                progress: 100,
                stage: 'complete',
                message: 'Data ready'
            });
            
            // Send data_ready event
            sendSSEUpdate(res, {
                type: 'data_ready',
                timestamp: new Date().toISOString()
            });
        } else {
            logger.info(`No existing session data found for: ${sessionId}`);
            
            // Send an initial progress state
            sendSSEUpdate(res, {
                type: 'progress',
                progress: 0,
                stage: 'waiting',
                message: 'Waiting for data processing to begin'
            });
        }
    } catch (error) {
        logger.error(`Error sending initial session data: ${error.message}`);
    }

    // Handle client disconnect
    req.on('close', () => {
        logger.info(`SSE connection closed for session: ${sessionId}`);
        clearInterval(heartbeatInterval);
        removeSSEClient(sessionId, res);
    });
});

/**
 * GET /test-sse/:sessionId
 * Test endpoint to manually trigger SSE events to a session
 */
router.get('/test-sse/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { message, type = 'progress', progress = 50 } = req.query;
    
    logger.info(`Manually sending test SSE event to session ${sessionId}`);
    
    // Create test event data
    const eventData = {
        type: type || 'progress',
        message: message || 'Test event from server',
        timestamp: new Date().toISOString(),
        progress: parseInt(progress, 10) || 50,
        stage: 'test',
        detail: 'This is a test event to verify SSE communication'
    };
    
    // Send the event
    broadcastSSEUpdate(eventData, sessionId);
    
    // Send response
    res.json({
        success: true,
        message: `Test event sent to session ${sessionId}`,
        sentData: eventData
    });
});

module.exports = router;