const logger = require('./logger');
const { broadcastSSEUpdate } = require('./sse');

// ...existing code...

// When processing is complete, make sure to report progress
function finalizeProcessing(sessionId) {
  logger.info(`Processing complete for session ${sessionId}, sending progress update`);
  
  // Send a final progress update
  broadcastSSEUpdate(sessionId, {
    type: 'progress',
    action: 'complete',
    message: 'Processing complete',
    progress: 100
  });

  // Send the data availability notification
  broadcastSSEUpdate(sessionId, {
    type: 'data_ready',
    message: 'Data processing complete, ready for display'
  });
}

// ...existing code...