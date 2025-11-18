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

    // Provide connect() method that returns a database-agnostic wrapper
    connect: async () => {
        if (USE_POSTGRES) {
            // Return a wrapper that provides SQLite-like API for PostgreSQL
            const pg = require('./postgresService');
            const logger = require('../utils/logger');
            return {
                all: (sql, params, callback) => {
                    // Synchronous method that returns immediately but executes async
                    (async () => {
                        try {
                            // Convert SQLite ? placeholders to PostgreSQL $1, $2...
                            let pgSql = sql;
                            let paramIndex = 1;
                            pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

                            // Convert SQLite-style boolean queries to PostgreSQL
                            pgSql = pgSql
                                .replace(/\s+enabled\s*=\s*1/gi, ' enabled = TRUE')
                                .replace(/\s+enabled\s*=\s*0/gi, ' enabled = FALSE')
                                .replace(/\s+is_active\s*=\s*1/gi, ' is_active = TRUE')
                                .replace(/\s+is_active\s*=\s*0/gi, ' is_active = FALSE')
                                .replace(/\s+use_dummy_epg\s*=\s*1/gi, ' use_dummy_epg = TRUE')
                                .replace(/\s+use_dummy_epg\s*=\s*0/gi, ' use_dummy_epg = FALSE');

                            logger.debug(`[DB Wrapper] Executing query with ${params?.length || 0} params`);
                            const result = await pg.query(pgSql, params);
                            callback(null, result.rows);
                        } catch (err) {
                            logger.error(`[DB Wrapper] Query error: ${err.message}`);
                            logger.debug(`[DB Wrapper] Failed SQL: ${sql.substring(0, 200)}...`);
                            callback(err);
                        }
                    })();
                },
                get: (sql, params, callback) => {
                    // Synchronous method that returns immediately but executes async
                    (async () => {
                        try {
                            // Convert SQLite ? placeholders to PostgreSQL $1, $2...
                            let pgSql = sql;
                            let paramIndex = 1;
                            pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

                            // Convert SQLite-style boolean queries to PostgreSQL
                            pgSql = pgSql
                                .replace(/\s+enabled\s*=\s*1/gi, ' enabled = TRUE')
                                .replace(/\s+enabled\s*=\s*0/gi, ' enabled = FALSE')
                                .replace(/\s+is_active\s*=\s*1/gi, ' is_active = TRUE')
                                .replace(/\s+is_active\s*=\s*0/gi, ' is_active = FALSE')
                                .replace(/\s+use_dummy_epg\s*=\s*1/gi, ' use_dummy_epg = TRUE')
                                .replace(/\s+use_dummy_epg\s*=\s*0/gi, ' use_dummy_epg = FALSE');

                            logger.debug(`[DB Wrapper] Executing get() with ${params?.length || 0} params`);
                            const result = await pg.query(pgSql, params);
                            callback(null, result.rows[0]);
                        } catch (err) {
                            logger.error(`[DB Wrapper] get() error: ${err.message}`);
                            logger.debug(`[DB Wrapper] Failed SQL: ${sql.substring(0, 200)}...`);
                            callback(err);
                        }
                    })();
                },
                run: (sql, params, callback) => {
                    // Synchronous method that returns immediately but executes async
                    (async () => {
                        try {
                            // Convert SQLite ? placeholders to PostgreSQL $1, $2...
                            let pgSql = sql;
                            let paramIndex = 1;
                            pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

                            // Convert SQLite-style boolean queries to PostgreSQL
                            pgSql = pgSql
                                .replace(/\s+enabled\s*=\s*1/gi, ' enabled = TRUE')
                                .replace(/\s+enabled\s*=\s*0/gi, ' enabled = FALSE')
                                .replace(/\s+is_active\s*=\s*1/gi, ' is_active = TRUE')
                                .replace(/\s+is_active\s*=\s*0/gi, ' is_active = FALSE')
                                .replace(/\s+use_dummy_epg\s*=\s*1/gi, ' use_dummy_epg = TRUE')
                                .replace(/\s+use_dummy_epg\s*=\s*0/gi, ' use_dummy_epg = FALSE');

                            // Convert INSERT OR REPLACE for generated_credentials table
                            if (pgSql.includes('INSERT OR REPLACE INTO generated_credentials')) {
                                pgSql = pgSql.replace(
                                    /INSERT OR REPLACE INTO generated_credentials/i,
                                    'INSERT INTO generated_credentials'
                                );
                                // Add ON CONFLICT clause for generated_credentials (unique on username, password)
                                if (!pgSql.includes('ON CONFLICT')) {
                                    pgSql = pgSql.replace(
                                        /VALUES\s*\([^)]+\)/i,
                                        (match) => `${match} ON CONFLICT (username, password) DO UPDATE SET channel_count = EXCLUDED.channel_count, updated_at = EXCLUDED.updated_at, m3u_file = EXCLUDED.m3u_file, epg_file = EXCLUDED.epg_file`
                                    );
                                }
                            }

                            // Convert INSERT OR REPLACE for live_events table
                            if (pgSql.includes('INSERT OR REPLACE INTO live_events')) {
                                pgSql = pgSql.replace(
                                    /INSERT OR REPLACE INTO live_events/i,
                                    'INSERT INTO live_events'
                                );
                                // Add ON CONFLICT clause for live_events (unique on event_id)
                                if (!pgSql.includes('ON CONFLICT')) {
                                    pgSql = pgSql.replace(
                                        /VALUES\s*\([^)]+\)/i,
                                        (match) => `${match} ON CONFLICT (event_id) DO UPDATE SET event_name = EXCLUDED.event_name, sport_type = EXCLUDED.sport_type, league_name = EXCLUDED.league_name, home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team, event_start = EXCLUDED.event_start, event_end = EXCLUDED.event_end, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`
                                    );
                                }
                            }

                            // Convert INSERT OR REPLACE for epg_matches table
                            if (pgSql.includes('INSERT OR REPLACE INTO epg_matches')) {
                                pgSql = pgSql.replace(
                                    /INSERT OR REPLACE INTO epg_matches/i,
                                    'INSERT INTO epg_matches'
                                );
                                // Add ON CONFLICT clause for epg_matches (unique on session_id, iptv_channel_id)
                                if (!pgSql.includes('ON CONFLICT')) {
                                    pgSql = pgSql.replace(
                                        /VALUES\s*\([^)]+\)/i,
                                        (match) => `${match} ON CONFLICT (session_id, iptv_channel_id) DO UPDATE SET user_id = EXCLUDED.user_id, epg_channel_id = EXCLUDED.epg_channel_id, use_dummy_epg = EXCLUDED.use_dummy_epg, updated_at = EXCLUDED.updated_at`
                                    );
                                }
                            }

                            logger.debug(`[DB Wrapper] Executing run() with ${params?.length || 0} params`);
                            await pg.query(pgSql, params);
                            callback(null);
                        } catch (err) {
                            logger.error(`[DB Wrapper] run() error: ${err.message}`);
                            logger.debug(`[DB Wrapper] Failed SQL: ${sql.substring(0, 200)}...`);
                            callback(err);
                        }
                    })();
                },
                serialize: (callback) => {
                    // PostgreSQL doesn't need serialize, just execute the callback
                    callback();
                }
            };
        } else {
            return db.connect();
        }
    },

    // Method aliases for compatibility (PostgreSQL uses different names)
    // Map SQLite method names to PostgreSQL method names
    getUserIPTVSources: async (userId, sessionId = null) => {
        if (USE_POSTGRES) {
            return db.getUserSources ? await db.getUserSources(userId, sessionId) : [];
        } else {
            return db.getUserIPTVSources ? await db.getUserIPTVSources(userId) : [];
        }
    },

    // SQLite-specific methods that PostgreSQL doesn't need (no-ops)
    saveCategories: async (sourceId, categories) => {
        if (USE_POSTGRES) {
            // PostgreSQL doesn't use separate categories table - uses group_title directly
            return Promise.resolve();
        } else {
            return db.saveCategories ? await db.saveCategories(sourceId, categories) : Promise.resolve();
        }
    },

    // Parameter order wrapper for saveChannels
    // SQLite: saveChannels(sourceId, channels)
    // PostgreSQL: saveChannels(channels, sourceId)
    saveChannels: async (sourceId, channels) => {
        if (USE_POSTGRES) {
            // Swap parameter order for PostgreSQL
            return db.saveChannels ? await db.saveChannels(channels, sourceId) : Promise.resolve();
        } else {
            return db.saveChannels ? await db.saveChannels(sourceId, channels) : Promise.resolve();
        }
    },

    associateSourceWithSession: async (sessionId, sourceId) => {
        if (USE_POSTGRES) {
            // PostgreSQL doesn't need this - sources already have session_id column
            return Promise.resolve();
        } else {
            return db.associateSourceWithSession ? await db.associateSourceWithSession(sessionId, sourceId) : Promise.resolve();
        }
    },

    getCategoriesForSession: async (sessionId, sourceId, userId) => {
        if (USE_POSTGRES) {
            // Get unique categories from channels with counts
            let query = `
                SELECT c.category as name, c.category as id, COUNT(*) as "channelCount"
                FROM iptv_channels c
                JOIN iptv_sources s ON c.source_id = s.id
                WHERE (s.session_id = $1 OR s.user_id = $2)
                  AND c.category IS NOT NULL
                  AND c.category != ''
            `;
            const params = [sessionId, userId];

            // Filter by source if provided
            if (sourceId) {
                params.push(sourceId);
                query += ` AND s.id = $${params.length}`;
            }

            query += ` GROUP BY c.category ORDER BY c.category`;

            const result = await db.pool.query(query, params);
            return result.rows;
        } else {
            return db.getCategoriesForSession ? await db.getCategoriesForSession(sessionId) : [];
        }
    },

    updateChannelEpgMapping: async (sessionId, channelId, epgChannelId) => {
        if (USE_POSTGRES) {
            // Update EPG match instead
            const result = await db.pool.query(`
                INSERT INTO epg_matches (session_id, iptv_channel_id, epg_channel_id, use_dummy_epg)
                VALUES ($1, $2, $3, false)
                ON CONFLICT (session_id, iptv_channel_id)
                DO UPDATE SET epg_channel_id = EXCLUDED.epg_channel_id
            `, [sessionId, channelId, epgChannelId]);
            return result.rowCount > 0;
        } else {
            return db.updateChannelEpgMapping ? await db.updateChannelEpgMapping(sessionId, channelId, epgChannelId) : false;
        }
    },

    // SQLite callback-based API wrappers for PostgreSQL compatibility
    all: (query, params, callback) => {
        if (USE_POSTGRES) {
            // Convert SQLite syntax to PostgreSQL
            let pgQuery = query;

            // Convert ? placeholders to $1, $2, etc.
            let paramIndex = 1;
            pgQuery = pgQuery.replace(/\?/g, () => `$${paramIndex++}`);

            // Convert boolean queries
            pgQuery = pgQuery
                .replace(/\s+enabled\s*=\s*1/gi, ' enabled = TRUE')
                .replace(/\s+enabled\s*=\s*0/gi, ' enabled = FALSE')
                .replace(/\s+is_active\s*=\s*1/gi, ' is_active = TRUE')
                .replace(/\s+is_active\s*=\s*0/gi, ' is_active = FALSE')
                .replace(/\s+use_dummy_epg\s*=\s*1/gi, ' use_dummy_epg = TRUE')
                .replace(/\s+use_dummy_epg\s*=\s*0/gi, ' use_dummy_epg = FALSE');

            db.pool.query(pgQuery, params)
                .then(result => callback(null, result.rows))
                .catch(err => callback(err));
        } else {
            // SQLite native callback
            return db.all(query, params, callback);
        }
    },

    run: (query, params, callback) => {
        if (USE_POSTGRES) {
            // Convert SQLite syntax to PostgreSQL
            let pgQuery = query;

            // Convert ? placeholders to $1, $2, etc.
            let paramIndex = 1;
            pgQuery = pgQuery.replace(/\?/g, () => `$${paramIndex++}`);

            // Convert boolean queries
            pgQuery = pgQuery
                .replace(/\s+enabled\s*=\s*1/gi, ' enabled = TRUE')
                .replace(/\s+enabled\s*=\s*0/gi, ' enabled = FALSE')
                .replace(/\s+is_active\s*=\s*1/gi, ' is_active = TRUE')
                .replace(/\s+is_active\s*=\s*0/gi, ' is_active = FALSE')
                .replace(/\s+use_dummy_epg\s*=\s*1/gi, ' use_dummy_epg = TRUE')
                .replace(/\s+use_dummy_epg\s*=\s*0/gi, ' use_dummy_epg = FALSE');

            // Convert INSERT OR REPLACE
            if (pgQuery.includes('INSERT OR REPLACE INTO generated_credentials')) {
                pgQuery = pgQuery.replace(
                    /INSERT OR REPLACE INTO generated_credentials/i,
                    'INSERT INTO generated_credentials'
                );
                if (!pgQuery.includes('ON CONFLICT')) {
                    pgQuery = pgQuery.replace(
                        /VALUES\s*\([^)]+\)/i,
                        (match) => `${match} ON CONFLICT (username, password) DO UPDATE SET channel_count = EXCLUDED.channel_count, updated_at = EXCLUDED.updated_at, m3u_file = EXCLUDED.m3u_file, epg_file = EXCLUDED.epg_file`
                    );
                }
            }

            // Convert INSERT OR REPLACE for live_events table
            if (pgQuery.includes('INSERT OR REPLACE INTO live_events')) {
                pgQuery = pgQuery.replace(
                    /INSERT OR REPLACE INTO live_events/i,
                    'INSERT INTO live_events'
                );
                if (!pgQuery.includes('ON CONFLICT')) {
                    pgQuery = pgQuery.replace(
                        /VALUES\s*\([^)]+\)/i,
                        (match) => `${match} ON CONFLICT (event_id) DO UPDATE SET event_name = EXCLUDED.event_name, sport_type = EXCLUDED.sport_type, league_name = EXCLUDED.league_name, home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team, event_start = EXCLUDED.event_start, event_end = EXCLUDED.event_end, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`
                    );
                }
            }

            // PostgreSQL uses promises, convert to callback
            db.pool.query(pgQuery, params)
                .then(result => callback(null))
                .catch(err => callback(err));
        } else {
            // SQLite native callback
            return db.run(query, params, callback);
        }
    },

    get: (query, params, callback) => {
        if (USE_POSTGRES) {
            // Convert SQLite syntax to PostgreSQL
            let pgQuery = query;

            // Convert ? placeholders to $1, $2, etc.
            let paramIndex = 1;
            pgQuery = pgQuery.replace(/\?/g, () => `$${paramIndex++}`);

            // Convert boolean queries
            pgQuery = pgQuery
                .replace(/\s+enabled\s*=\s*1/gi, ' enabled = TRUE')
                .replace(/\s+enabled\s*=\s*0/gi, ' enabled = FALSE')
                .replace(/\s+is_active\s*=\s*1/gi, ' is_active = TRUE')
                .replace(/\s+is_active\s*=\s*0/gi, ' is_active = FALSE')
                .replace(/\s+use_dummy_epg\s*=\s*1/gi, ' use_dummy_epg = TRUE')
                .replace(/\s+use_dummy_epg\s*=\s*0/gi, ' use_dummy_epg = FALSE');

            // PostgreSQL uses promises, convert to callback
            db.pool.query(pgQuery, params)
                .then(result => callback(null, result.rows[0]))
                .catch(err => callback(err));
        } else {
            // SQLite native callback
            return db.get(query, params, callback);
        }
    },

    // SQLite serialize method (for sequential execution)
    // PostgreSQL doesn't need this, but we provide it for compatibility
    serialize: (callback) => {
        if (USE_POSTGRES) {
            // PostgreSQL doesn't need serialize, just execute the callback
            callback();
        } else {
            // SQLite native serialize
            return db.serialize(callback);
        }
    },

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
