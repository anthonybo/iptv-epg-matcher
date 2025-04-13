/**
 * EventBus - Central event hub for cross-module communication
 * Prevents circular dependencies when modules need to communicate
 */
const EventEmitter = require('events');
const logger = require('../config/logger');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Increase max listeners
  }

  /**
   * Emit an SSE update to a specific session
   * @param {string} sessionId - The session ID to send the update to
   * @param {string} type - The type of update
   * @param {object} data - Optional data to include with the update
   */
  emitSSEUpdate(sessionId, type, data = {}) {
    if (!sessionId) {
      logger.warn('Attempted to emit SSE update without sessionId');
      return;
    }
    
    logger.debug(`[EventBus] Emitting event: sse:update to session: ${sessionId}, type: ${type}`);
    
    // Format SSE update with type and any additional data
    const updateData = {
      type,
      timestamp: new Date().toISOString(),
      ...data
    };
    
    // Emit the event using the consistent format expected by our handler
    this.emit('sse:update', { 
      sessionId, 
      data: updateData 
    });
  }
  
  /**
   * Emit a progress update to a specific session
   * @param {string} sessionId - The session ID
   * @param {number} progress - Progress percentage (0-100)
   * @param {string} stage - Current processing stage
   * @param {string} message - Optional status message
   */
  emitProgress(sessionId, progress, stage, message = '') {
    this.emitSSEUpdate(sessionId, 'progress', {
      progress,
      stage,
      message
    });
  }
  
  /**
   * Emit an error event to a specific session
   * @param {string} sessionId - The session ID
   * @param {string} message - Error message
   * @param {object} details - Optional error details
   */
  emitError(sessionId, message, details = {}) {
    this.emitSSEUpdate(sessionId, 'error', {
      message,
      ...details
    });
  }
}

// Create a singleton instance
const eventBus = new EventBus();

module.exports = { eventBus };