/**
 * IPTV Database Abstraction Layer
 * Routes to either PostgreSQL or SQLite based on environment variable
 * Provides seamless migration with instant rollback capability
 */

const logger = require('../utils/logger');

// Feature flags from environment
const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

// Log which database we're using
if (USE_POSTGRES) {
    logger.info('🐘 Using PostgreSQL for IPTV data');
} else {
    logger.info('📦 Using SQLite for IPTV data');
}

// Load the appropriate database service
const db = USE_POSTGRES
    ? require('./postgresService')
    : require('./iptvDatabaseService');

// Export unified interface
// This allows all existing code to work without changes
module.exports = {
    // Feature flag (so other code can check if needed)
    USE_POSTGRES,

    // Direct pass-through of all methods
    // PostgreSQL and SQLite services have compatible interfaces
    ...db,

    // Additional metadata
    getDatabaseType: () => USE_POSTGRES ? 'PostgreSQL' : 'SQLite',

    // Health check (works for both)
    healthCheck: async () => {
        if (USE_POSTGRES && db.healthCheck) {
            return await db.healthCheck();
        } else {
            // SQLite health check
            return {
                status: 'healthy',
                database: 'SQLite',
                path: db.getDbPath ? db.getDbPath() : 'backend/data/iptv.db'
            };
        }
    },

    // For debugging/logging
    _underlyingService: db
};
