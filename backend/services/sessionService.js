/**
 * Session management service for EPG loading and state tracking
 */
const crypto = require('crypto');
const logger = require('../utils/logger');

// In-memory session storage
const sessions = {};

/**
 * Generate a unique session ID
 * @returns {string} New session ID
 */
function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Create a new session or reset an existing one
 * @param {string} [sessionId] - Optional existing session ID to reset
 * @returns {Object} Session object with ID
 */
function createSession(sessionId = null) {
    // Generate a new session ID if none provided
    const newSessionId = sessionId || generateSessionId();
    
    // Initialize the session with default values
    sessions[newSessionId] = {
        id: newSessionId,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        sources: {},  // Map of source URLs to their loading state
        loadingCount: 0,
        hasErrors: false,
        hasData: false
    };
    
    logger.debug(`Created session ${newSessionId}`);
    return sessions[newSessionId];
}

/**
 * Get a session by ID
 * @param {string} sessionId - Session ID to retrieve
 * @returns {Object|null} Session object or null if not found
 */
function getSession(sessionId) {
    if (!sessionId) {
        return null;
    }
    
    // First check our own sessions object
    if (sessions[sessionId]) {
        return sessions[sessionId];
    }
    
    // Check the storageUtils session store
    try {
        const { getSession: getStorageSession } = require('../utils/storageUtils');
        const storageSession = getStorageSession(sessionId);
        
        if (storageSession) {
            // If found, import it into our sessions object
            sessions[sessionId] = {
                id: sessionId,
                created: storageSession.createdAt || new Date().toISOString(),
                updated: new Date().toISOString(),
                sources: {},
                hasData: false,
                hasErrors: false
            };
            
            // Return our formatted version of the session
            return sessions[sessionId];
        }
    } catch (error) {
        logger.error(`Error checking storageUtils for session ${sessionId}: ${error.message}`);
    }
    
    // Check the sessionStorage if available
    try {
        const { getSession: getSessionStorageSession } = require('../utils/sessionStorage');
        const sessionStorageSession = getSessionStorageSession(sessionId);
        
        if (sessionStorageSession) {
            // If found, import it into our sessions object
            sessions[sessionId] = {
                id: sessionId,
                created: sessionStorageSession.created || new Date().toISOString(),
                updated: new Date().toISOString(),
                sources: {},
                hasData: false,
                hasErrors: false
            };
            
            // Return our formatted version of the session
            return sessions[sessionId];
        }
    } catch (error) {
        logger.error(`Error checking sessionStorage for session ${sessionId}: ${error.message}`);
    }
    
    // Check app.locals.sessions as a last resort
    try {
        const app = global.app; // Assuming app is stored in global
        if (app && app.locals && app.locals.sessions && app.locals.sessions[sessionId]) {
            // If found, import it into our sessions object
            const appSession = app.locals.sessions[sessionId];
            sessions[sessionId] = {
                id: sessionId,
                created: appSession.created || new Date().toISOString(),
                updated: new Date().toISOString(),
                sources: {},
                hasData: false,
                hasErrors: false
            };
            
            // Return our formatted version of the session
            return sessions[sessionId];
        }
    } catch (error) {
        logger.error(`Error checking app.locals for session ${sessionId}: ${error.message}`);
    }
    
    // Session not found in any storage
    return null;
}

/**
 * Update a source's loading state in a session
 * @param {string} sessionId - Session ID
 * @param {string} sourceUrl - Source URL
 * @param {Object} state - State updates
 * @returns {Object|null} Updated session or null if session not found
 */
function updateSourceLoadingState(sessionId, sourceUrl, state) {
    const session = getSession(sessionId);
    if (!session) {
        return null;
    }
    
    // Initialize source if it doesn't exist
    if (!session.sources[sourceUrl]) {
        session.sources[sourceUrl] = {
            url: sourceUrl,
            loading: false,
            loadingStarted: null,
            loadingFinished: null,
            loadingProgress: 0,
            loadingMessage: '',
            error: null,
            channelCount: 0,
            programCount: 0
        };
    }
    
    // Update the source with new state
    const source = session.sources[sourceUrl];
    Object.assign(source, state);
    
    // Special handling for loading state changes
    if (state.loading === true && !source.loadingStarted) {
        source.loadingStarted = new Date().toISOString();
        session.loadingCount++;
    } else if (state.loading === false && source.loadingStarted && !source.loadingFinished) {
        source.loadingFinished = new Date().toISOString();
        session.loadingCount = Math.max(0, session.loadingCount - 1);
    }
    
    // Update session flags
    session.hasErrors = Object.values(session.sources).some(s => s.error);
    session.hasData = Object.values(session.sources).some(s => s.channelCount > 0);
    session.updated = new Date().toISOString();
    
    return session;
}

/**
 * Mark a source as loading in a session
 * @param {string} sessionId - Session ID
 * @param {string} sourceUrl - Source URL
 * @param {string} message - Initial loading message
 * @returns {Object|null} Updated session or null if session not found
 */
function startSourceLoading(sessionId, sourceUrl, message = 'Starting...') {
    return updateSourceLoadingState(sessionId, sourceUrl, {
        loading: true,
        loadingProgress: 0,
        loadingMessage: message,
        error: null
    });
}

/**
 * Update a source's loading progress
 * @param {string} sessionId - Session ID
 * @param {string} sourceUrl - Source URL
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Progress message
 * @returns {Object|null} Updated session or null if session not found
 */
function updateSourceProgress(sessionId, sourceUrl, progress, message) {
    return updateSourceLoadingState(sessionId, sourceUrl, {
        loadingProgress: progress,
        loadingMessage: message
    });
}

/**
 * Mark a source as successfully loaded
 * @param {string} sessionId - Session ID
 * @param {string} sourceUrl - Source URL
 * @param {number} channelCount - Number of channels loaded
 * @param {number} programCount - Number of programs loaded
 * @returns {Object|null} Updated session or null if session not found
 */
function completeSourceLoading(sessionId, sourceUrl, channelCount, programCount) {
    return updateSourceLoadingState(sessionId, sourceUrl, {
        loading: false,
        loadingProgress: 100,
        loadingMessage: `Loaded ${channelCount} channels and ${programCount} programs`,
        channelCount,
        programCount
    });
}

/**
 * Mark a source as failed
 * @param {string} sessionId - Session ID
 * @param {string} sourceUrl - Source URL
 * @param {string} errorMessage - Error message
 * @returns {Object|null} Updated session or null if session not found
 */
function failSourceLoading(sessionId, sourceUrl, errorMessage) {
    return updateSourceLoadingState(sessionId, sourceUrl, {
        loading: false,
        loadingProgress: 0,
        loadingMessage: `Failed: ${errorMessage}`,
        error: errorMessage
    });
}

/**
 * Clean up old sessions
 * @param {number} maxAgeHours - Max age in hours before a session is removed
 * @returns {number} Number of sessions removed
 */
function cleanupOldSessions(maxAgeHours = 24) {
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = new Date();
    let removedCount = 0;
    
    Object.keys(sessions).forEach(sessionId => {
        const session = sessions[sessionId];
        const updated = new Date(session.updated);
        
        if (now - updated > maxAgeMs) {
            delete sessions[sessionId];
            removedCount++;
        }
    });
    
    if (removedCount > 0) {
        logger.info(`Cleaned up ${removedCount} old sessions`);
    }
    
    return removedCount;
}

// Set up periodic cleanup (every hour)
setInterval(() => cleanupOldSessions(24), 60 * 60 * 1000);

module.exports = {
    generateSessionId,
    createSession,
    getSession,
    updateSourceLoadingState,
    startSourceLoading,
    updateSourceProgress,
    completeSourceLoading,
    failSourceLoading,
    cleanupOldSessions
}; 