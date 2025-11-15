/**
 * Session Manager - Abstraction Layer
 * Routes to either Redis or in-memory storage based on environment
 */

const logger = require('../config/logger');

// Feature flag
const USE_REDIS = process.env.USE_REDIS === 'true';

// Log which session storage we're using
if (USE_REDIS) {
    logger.info('🔴 Using Redis for session storage');
} else {
    logger.info('💾 Using in-memory session storage');
}

// Load appropriate service
let sessionService;
if (USE_REDIS) {
    const redisService = require('../services/redisService');

    // Redis-based session management
    sessionService = {
        async createSession(sessionId, sessionData = {}) {
            try {
                const data = {
                    channels: sessionData.data?.channels || sessionData.channels || [],
                    categories: sessionData.data?.categories || sessionData.categories || [],
                    epgSources: sessionData.data?.epgSources || sessionData.epgSources || [],
                    userId: sessionData.userId || null
                };

                await redisService.saveSession(sessionId, data);
                logger.info(`[Redis] Session created: ${sessionId}`);
                return { sessionId, data };
            } catch (error) {
                logger.error('[Redis] Error creating session:', error);
                throw error;
            }
        },

        async getSession(sessionId) {
            try {
                const data = await redisService.getSession(sessionId);
                if (!data) {
                    logger.debug(`[Redis] Session not found: ${sessionId}`);
                    return null;
                }
                return { sessionId, data };
            } catch (error) {
                logger.error('[Redis] Error getting session:', error);
                return null;
            }
        },

        async updateSession(sessionId, updates) {
            try {
                const session = await redisService.getSession(sessionId);
                if (!session) {
                    logger.warn(`[Redis] Cannot update non-existent session: ${sessionId}`);
                    return null;
                }

                // Merge updates
                const updatedData = {
                    channels: updates.data?.channels || updates.channels || session.channels,
                    categories: updates.data?.categories || updates.categories || session.categories,
                    epgSources: updates.data?.epgSources || updates.epgSources || session.epgSources,
                    userId: updates.userId !== undefined ? updates.userId : session.userId
                };

                await redisService.saveSession(sessionId, updatedData);
                logger.debug(`[Redis] Session updated: ${sessionId}`);
                return { sessionId, data: updatedData };
            } catch (error) {
                logger.error('[Redis] Error updating session:', error);
                throw error;
            }
        },

        async deleteSession(sessionId) {
            try {
                await redisService.deleteSession(sessionId);
                logger.info(`[Redis] Session deleted: ${sessionId}`);
                return true;
            } catch (error) {
                logger.error('[Redis] Error deleting session:', error);
                return false;
            }
        },

        async getAllSessions() {
            try {
                const sessions = await redisService.getAllSessions();
                return sessions.map(s => ({
                    sessionId: s.sessionId,
                    data: {
                        channels: s.channels || [],
                        categories: s.categories || [],
                        epgSources: s.epgSources || []
                    },
                    createdAt: s.createdAt ? new Date(s.createdAt) : null,
                    lastAccessed: s.lastAccessed ? new Date(s.lastAccessed) : null
                }));
            } catch (error) {
                logger.error('[Redis] Error getting all sessions:', error);
                return [];
            }
        }
    };
} else {
    // Use existing in-memory sessionStorage
    const memoryStorage = require('./sessionStorage');

    sessionService = {
        async createSession(sessionId, sessionData = {}) {
            return memoryStorage.createSession(sessionId, sessionData);
        },

        async getSession(sessionId) {
            return memoryStorage.getSession(sessionId);
        },

        async updateSession(sessionId, updates) {
            return memoryStorage.updateSession(sessionId, updates);
        },

        async deleteSession(sessionId) {
            return memoryStorage.clearSession(sessionId);
        },

        async getAllSessions() {
            return memoryStorage.getAllSessions();
        }
    };
}

// Export unified interface
module.exports = {
    USE_REDIS,
    ...sessionService,
    getStorageType: () => USE_REDIS ? 'Redis' : 'In-Memory'
};
