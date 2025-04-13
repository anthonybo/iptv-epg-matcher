// utils/storageUtils.js
const crypto = require('crypto');
const logger = require('../config/logger');
const { EXTERNAL_EPG_URLS } = require('../config/constants');

// Memory-based session storage
let sessions = {};

// Session cleanup settings
const SESSION_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 50; // Maximum number of sessions to keep in memory

// Setup periodic cleanup
setInterval(cleanupSessions, SESSION_CLEANUP_INTERVAL);

/**
 * Cleans up old sessions to prevent memory leaks
 */
function cleanupSessions() {
    const now = new Date().getTime();
    const sessionIds = Object.keys(sessions);
    let cleanedCount = 0;
    
    // Log memory usage
    const memoryUsage = process.memoryUsage();
    logger.info('Memory usage stats before cleanup', {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        sessionCount: sessionIds.length
    });
    
    // Remove expired sessions
    sessionIds.forEach(id => {
        const session = sessions[id];
        const lastAccess = new Date(session.lastAccessed).getTime();
        
        // Delete sessions that haven't been accessed in 24 hours
        if (now - lastAccess > SESSION_MAX_AGE) {
            delete sessions[id];
            cleanedCount++;
            logger.debug(`Deleted expired session: ${id}`);
        }
    });
    
    // If we still have too many sessions, remove oldest ones
    const remainingIds = Object.keys(sessions);
    if (remainingIds.length > MAX_SESSIONS) {
        // Sort sessions by last accessed time
        const sortedSessions = remainingIds
            .map(id => ({ id, lastAccessed: new Date(sessions[id].lastAccessed).getTime() }))
            .sort((a, b) => a.lastAccessed - b.lastAccessed);
        
        // Delete oldest sessions beyond the MAX_SESSIONS limit
        const sessionsToDelete = sortedSessions.slice(0, sortedSessions.length - MAX_SESSIONS);
        sessionsToDelete.forEach(session => {
            delete sessions[session.id];
            cleanedCount++;
            logger.debug(`Deleted old session: ${session.id}`);
        });
    }
    
    // Log results
    if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} sessions. Now managing ${Object.keys(sessions).length} sessions.`);
        
        // Log memory usage after cleanup
        const memUsageAfter = process.memoryUsage();
        logger.info('Memory usage stats after cleanup', {
            rss: `${Math.round(memUsageAfter.rss / 1024 / 1024)} MB`,
            heapTotal: `${Math.round(memUsageAfter.heapTotal / 1024 / 1024)} MB`,
            heapUsed: `${Math.round(memUsageAfter.heapUsed / 1024 / 1024)} MB`,
            sessionCount: Object.keys(sessions).length
        });
    }
}

/**
 * Creates a new session with the given ID and data
 * @param {string} sessionId - The session ID
 * @param {Object} data - The session data
 * @returns {Object} The created session
 */
function createSession(sessionId, data = {}) {
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        sessionId = `session_${Math.random().toString(36).substring(2, 15)}`;
        logger.info(`Generated new session ID: ${sessionId}`);
    }
    
    logger.info(`Creating session with ID: ${sessionId}`);
    
    const session = {
        id: sessionId,
        ...data,
        sources: data.sources || {},
        matches: data.matches || [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
    };
    
    // Store in memory
    sessions[sessionId] = session;
    
    // Limit the number of sessions
    if (Object.keys(sessions).length > MAX_SESSIONS * 1.2) {
        logger.warn(`Session limit reached (${Object.keys(sessions).length}). Running emergency cleanup.`);
        cleanupSessions();
    }
    
    return session;
}

/**
 * Gets a session by ID
 * @param {string} sessionId - The session ID
 * @returns {Object|null} The session data or null if not found
 */
function getSession(sessionId) {
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.warn(`Invalid session ID: ${String(sessionId)}`, {
            callstack: new Error().stack
        });
        return null;
    }
    
    const session = sessions[sessionId];
    
    if (!session) {
        logger.warn(`Session not found: ${sessionId}`, {
            availableSessions: Object.keys(sessions),
            callstack: new Error().stack
        });
        return null;
    }
    
    // Debug to trace EPG issue
    const stack = new Error().stack;
    const caller = stack.split('\n')[2] || 'unknown';
    if (caller.includes('epg.js')) {
        logger.debug(`EPG getSession for ${sessionId}`, {
            keys: Object.keys(session),
            hasEpgSources: !!session.epgSources,
            caller
        });
    }
    
    // Update last accessed time
    sessions[sessionId].lastAccessed = new Date().toISOString();
    return session;
}

/**
 * Updates a session with new data
 * @param {string} sessionId - The session ID
 * @param {Object} data - The new session data
 * @returns {Object} The updated session
 */
function updateSession(sessionId, data = {}) {
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.error('Attempted to update session with invalid ID', {
            sessionId: String(sessionId),
            callstack: new Error().stack
        });
        return null;
    }
    
    // Create session if it doesn't exist
    if (!sessions[sessionId]) {
        logger.info(`Creating new session during update: ${sessionId}`);
        return createSession(sessionId, data);
    }
    
    // Debug to trace EPG issue
    const stack = new Error().stack;
    const caller = stack.split('\n')[2] || 'unknown';
    if (caller.includes('epg.js')) {
        logger.debug(`EPG updateSession for ${sessionId}`, {
            keys: Object.keys(data),
            hasEpgSources: !!data.epgSources,
            caller
        });
    }
    
    logger.debug(`Updating session: ${sessionId}`);
    
    // If updating sources specifically, make sure they're properly merged
    if (data.sources) {
        if (!sessions[sessionId].sources) {
            sessions[sessionId].sources = {};
        }
        sessions[sessionId].sources = {
            ...sessions[sessionId].sources,
            ...data.sources
        };
        
        // Remove sources from the data object to prevent it from being overwritten again
        const { sources, ...restData } = data;
        data = restData;
    }
    
    // Update session
    sessions[sessionId] = {
        ...sessions[sessionId],
        ...data,
        updated: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
    };
    
    return sessions[sessionId];
}

/**
 * Deletes a session
 * @param {string} sessionId - The session ID
 */
function deleteSession(sessionId) {
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.warn(`Attempted to delete session with invalid ID: ${String(sessionId)}`);
        return false;
    }
    
    if (!sessions[sessionId]) {
        logger.warn(`Cannot delete non-existent session: ${sessionId}`);
        return false;
    }
    
    logger.debug(`Deleting session: ${sessionId}`);
    delete sessions[sessionId];
    return true;
}

/**
 * Clears all sessions
 */
function clearSessions() {
    logger.info('Clearing in-memory session storage on server restart');
    sessions = {};
}

/**
 * Gets stats about current sessions 
 */
function getSessionStats() {
    const sessionCount = Object.keys(sessions).length;
    const memoryUsage = process.memoryUsage();
    
    return {
        sessionCount,
        memoryUsage: {
            rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`, 
            heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
        },
        oldestSession: Object.keys(sessions).length > 0 
            ? Object.keys(sessions)
                .map(id => ({ id, lastAccessed: new Date(sessions[id].lastAccessed).getTime() }))
                .sort((a, b) => a.lastAccessed - b.lastAccessed)[0]
            : null
    };
}

/**
 * Generates a cache key from Xtream credentials
 * 
 * @param {string} xtreamUsername - Xtream username
 * @param {string} xtreamPassword - Xtream password
 * @param {string} xtreamServer - Xtream server URL
 * @returns {string} MD5 hash of the credentials
 */
function getCacheKey(username, password, server) {
    // Add EXTERNAL_EPG_URLS.length to the cacheKey to invalidate when new sources are added
    const sourceCount = EXTERNAL_EPG_URLS.length;
    const normalizedUsername = username || '';
    const normalizedPassword = password || '';
    const normalizedServer = server || '';

    const cacheString = `${normalizedUsername}|${normalizedPassword}|${normalizedServer}|${sourceCount}`;
    return crypto.createHash('md5').update(cacheString).digest('hex');
}

/**
 * Generates new random Xtream credentials
 * 
 * @returns {Object} Object containing username and password
 */
function generateCredentials() {
    const username = crypto.randomBytes(8).toString('hex');
    const password = crypto.randomBytes(8).toString('hex');
    return { username, password };
}

module.exports = {
    createSession,
    getSession,
    updateSession,
    deleteSession,
    clearSessions,
    getCacheKey,
    generateCredentials,
    cleanupSessions,
    getSessionStats
};