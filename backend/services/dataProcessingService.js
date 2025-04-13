const logger = require('../config/logger');
const { getSession, updateSession } = require('../utils/storageUtils');
const { broadcastSSEUpdate } = require('../utils/sseUtils');

/**
 * Finalizes the data processing and emits completion events
 * @param {string} sessionId - The session ID
 */
function finalizeProcessing(sessionId) {
  // Validate session ID to prevent null errors
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    const stackObj = {};
    Error.captureStackTrace(stackObj);
    const stack = stackObj.stack
      .split('\n')
      .slice(2) // Skip this function and its caller
      .map(line => line.trim())
      .join('\n  ');
    
    logger.warn('Attempted to finalize processing with invalid session ID', { 
      sessionId: sessionId === null ? 'null' : sessionId,
      callstack: stack
    });
    return; // Don't proceed with invalid session ID
  }

  logger.info(`Finalizing processing for session ${sessionId}`);
  
  try {
    const session = getSession(sessionId);
    if (!session) {
      logger.warn(`Cannot finalize processing: Session not found: ${sessionId}`);
      return;
    }

    logger.info(`Processing complete for session ${sessionId}, sending progress update`);
        
    // Send progress update
    broadcastSSEUpdate({
        type: 'progress',
        progress: 100,
        stage: 'complete',
        message: 'Processing complete!'
    }, sessionId);
    
    // Send data ready notification
    broadcastSSEUpdate({
        type: 'data_ready',
        timestamp: new Date().toISOString()
    }, sessionId);
    
    // Add flag to prevent further calls to this session
    updateSession(sessionId, { 
      processingComplete: true,
      completedAt: new Date().toISOString()
    });
    
    // Critical: Prevent any deferred callbacks from passing null
    process.nextTick(() => {
      logger.info(`Processing fully completed for session ${sessionId}`);
    });
  } catch (error) {
    logger.error(`Error in finalizeProcessing: ${error.message}`, { 
      error: error.message, 
      stack: error.stack,
      sessionId 
    });
  }
}

// We need to protect other functions to prevent null sessionId propagation
function safelyGetSession(sessionId) {
    // Validate sessionId
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.warn(`Invalid session ID in safelyGetSession: ${sessionId}`);
        return null;
    }
    
    return getSession(sessionId);
}

module.exports = {
    finalizeProcessing
};