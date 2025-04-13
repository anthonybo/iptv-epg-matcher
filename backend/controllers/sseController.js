// Map to store SSE clients by session ID
const sseClients = new Map();

/**
 * Registers a new SSE client for a session
 * @param {string} sessionId - The session ID 
 * @param {Object} res - Express response object
 */
function registerSSEClient(sessionId, res) {
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.error('Attempted to register SSE client with invalid session ID', {
            sessionId: String(sessionId),
            callstack: new Error().stack
        });
        return;
    }
    
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Create a client collection for this session if it doesn't exist
    if (!sseClients.has(sessionId)) {
        sseClients.set(sessionId, new Set());
    }

    // Add this client to the collection
    sseClients.get(sessionId).add(res);
    logger.info(`Registered new SSE client for session: ${sessionId}`);

    // Send an initial connection event
    sendSSEEvent(res, 'connection', {
        type: 'connection',
        message: 'SSE connection established',
        sessionId: sessionId,
        timestamp: new Date().toISOString()
    });

    // Handle client disconnect
    res.on('close', () => {
        logger.info(`SSE connection closed for session: ${sessionId}`);
        // Remove this client from the session's collection
        const clients = sseClients.get(sessionId);
        if (clients) {
            clients.delete(res);
            
            // If no clients left for this session, clean up the Map entry
            if (clients.size === 0) {
                sseClients.delete(sessionId);
                logger.info(`Closed SSE connection and removed session: ${sessionId}`);
            }
        }
    });
}

/**
 * Broadcasts an SSE event to all clients for a session
 * @param {Object} data - Event data to send
 * @param {string} sessionId - The session ID
 */
function broadcastSSEUpdate(data, sessionId) {
    // Detailed logging for debugging
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.error('Attempted to broadcast with invalid session ID', {
            providedSessionId: String(sessionId),
            dataType: data?.type,
            callstack: new Error().stack
        });
        return;
    }
    
    logger.debug(`Attempting to broadcast to session ${sessionId}, data type: ${data?.type}`);
    
    // Make sure we have a valid session ID
    const sessionClients = sseClients.get(sessionId);
    
    if (!sessionClients || sessionClients.size === 0) {
        logger.warn(`No active SSE clients for session: ${sessionId}`, {
            activeSessionIds: Array.from(sseClients.keys()),
            dataType: data?.type
        });
        return;
    }
    
    logger.debug(`Broadcasting to ${sessionClients.size} clients for session ${sessionId}`);
    
    // Send the event to all clients for this session
    for (const client of sessionClients) {
        try {
            // Clone the session ID to ensure it's a separate string value
            const safeSessionId = String(sessionId);
            sendSSEEvent(client, data.type || 'message', data);
        } catch (error) {
            logger.error(`Error broadcasting SSE event: ${error.message}`, {
                sessionId,
                error: error.stack
            });
        }
    }
    
    logger.debug(`Broadcast SSE update to session ${sessionId}`);
}

/**
 * Sends an SSE event to a client
 * @param {Object} res - Express response object
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
function sendSSEEvent(res, event, data) {
    try {
        const dataString = JSON.stringify(data);
        logger.debug(`Sending SSE event: ${event}: ${dataString.substring(0, 100)}...`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${dataString}\n\n`);
    } catch (error) {
        logger.error(`Error sending SSE event: ${error.message}`, { error: error.stack });
    }
}

module.exports = {
    registerSSEClient,
    broadcastSSEUpdate,
    sendSSEEvent
};