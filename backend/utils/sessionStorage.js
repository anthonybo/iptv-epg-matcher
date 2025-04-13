/**
 * Session Storage Module
 * Manages session data persistence
 */
const logger = require('../config/logger');

// In-memory storage for session data
const sessions = {};

/**
 * Create a new session
 * @param {string} sessionId - Session identifier
 * @param {Object} sessionData - Session data to store
 * @returns {Object} The created session
 */
const createSession = (sessionId, sessionData = {}) => {
  if (!sessionId) {
    logger.error('Attempted to create session with null/undefined sessionId');
    return null;
  }
  
  logger.info(`Creating new session: ${sessionId}`);
  
  // Add metadata and ensure required arrays exist
  const sessionWithMeta = {
    ...sessionData,
    createdAt: new Date(),
    lastAccessed: new Date(),
    data: {
      ...(sessionData.data || {}),
      channels: Array.isArray(sessionData.data?.channels) ? sessionData.data.channels : [],
      matches: Array.isArray(sessionData.data?.matches) ? sessionData.data.matches : []
    }
  };
  
  // Store in memory
  sessions[sessionId] = sessionWithMeta;
  
  logger.debug(`Session created: ${sessionId}`, { 
    sessionCount: Object.keys(sessions).length,
    hasData: !!sessionWithMeta.data,
    hasChannels: Array.isArray(sessionWithMeta.data.channels),
    channelCount: sessionWithMeta.data.channels.length,
    hasMatches: Array.isArray(sessionWithMeta.data.matches),
    matchCount: sessionWithMeta.data.matches.length
  });
  
  return sessionWithMeta;
};

/**
 * Get a session by ID
 * @param {string} sessionId - Session identifier
 * @returns {Object|null} The session data or null if not found
 */
const getSession = (sessionId) => {
  if (!sessionId) {
    logger.warn('Attempted to get session with null/undefined sessionId');
    return null;
  }
  
  const session = sessions[sessionId];
  
  if (session) {
    // Update last accessed time
    session.lastAccessed = new Date();
    logger.debug(`Session accessed: ${sessionId}`);
    return session;
  }
  
  logger.debug(`Session not found: ${sessionId}`);
  return null;
};

/**
 * Update a session's data
 * @param {string} sessionId - Session identifier
 * @param {Object} sessionData - New session data
 * @returns {Object|null} Updated session or null if session not found
 */
const updateSession = (sessionId, sessionData) => {
  if (!sessionId) {
    logger.error('Attempted to update session with null/undefined sessionId');
    return null;
  }
  
  if (!sessions[sessionId]) {
    logger.warn(`Cannot update non-existent session: ${sessionId}`);
    return createSession(sessionId, sessionData); // Create if it doesn't exist
  }
  
  // Update the session with new data, ensuring required arrays exist
  sessions[sessionId] = {
    ...sessions[sessionId],
    ...sessionData,
    lastAccessed: new Date(),
    data: {
      ...(sessions[sessionId].data || {}),
      ...(sessionData.data || {}),
      // Preserve existing arrays if new data doesn't include them
      channels: Array.isArray(sessionData.data?.channels) 
        ? sessionData.data.channels 
        : (Array.isArray(sessions[sessionId].data?.channels) ? sessions[sessionId].data.channels : []),
      matches: Array.isArray(sessionData.data?.matches)
        ? sessionData.data.matches
        : (Array.isArray(sessions[sessionId].data?.matches) ? sessions[sessionId].data.matches : [])
    }
  };
  
  logger.debug(`Session updated: ${sessionId}`, {
    hasChannels: Array.isArray(sessions[sessionId].data.channels),
    channelCount: sessions[sessionId].data.channels.length,
    hasMatches: Array.isArray(sessions[sessionId].data.matches),
    matchCount: sessions[sessionId].data.matches.length
  });
  
  return sessions[sessionId];
};

/**
 * Clear a session by ID
 * @param {string} sessionId - Session identifier
 * @returns {boolean} Success status
 */
const clearSession = (sessionId) => {
  if (!sessionId || !sessions[sessionId]) {
    return false;
  }
  
  delete sessions[sessionId];
  logger.debug(`Session cleared: ${sessionId}`);
  return true;
};

/**
 * Get all sessions
 * @returns {Object} Map of all sessions
 */
const getAllSessions = () => {
  return { ...sessions };
};

/**
 * Get session count
 * @returns {number} Number of active sessions
 */
const getSessionCount = () => {
  return Object.keys(sessions).length;
};

/**
 * Clear expired sessions
 * @param {number} maxAgeMinutes - Maximum session age in minutes
 * @returns {number} Number of cleared sessions
 */
const clearExpiredSessions = (maxAgeMinutes = 120) => {
  const now = new Date();
  const maxAgeMs = maxAgeMinutes * 60 * 1000;
  let clearedCount = 0;
  
  Object.keys(sessions).forEach(sessionId => {
    const session = sessions[sessionId];
    const lastAccessed = new Date(session.lastAccessed);
    const ageMs = now - lastAccessed;
    
    if (ageMs > maxAgeMs) {
      delete sessions[sessionId];
      clearedCount++;
    }
  });
  
  if (clearedCount > 0) {
    logger.info(`Cleared ${clearedCount} expired sessions`);
  }
  
  return clearedCount;
};

// Add a function to register sessions from app.locals
function registerSessionFromLocals(sessionId, sessionData) {
  if (!sessionId) {
    return false;
  }

  try {
    // Create or update the session
    sessions[sessionId] = {
      ...getSession(sessionId),
      ...sessionData,
      lastAccessed: new Date()
    };
    
    return true;
  } catch (error) {
    console.error(`Error registering session ${sessionId} from locals:`, error);
    return false;
  }
}

module.exports = {
  createSession,
  getSession,
  updateSession,
  clearSession,
  getAllSessions,
  getSessionCount,
  clearExpiredSessions,
  registerSessionFromLocals
};