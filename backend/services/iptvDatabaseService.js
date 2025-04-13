/**
 * IPTV Database Service - handles storage of IPTV data in SQLite
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('../config/logger');

// SQLite database path
const DB_PATH = path.join(__dirname, '../data/iptv.db');

// Ensure database directory exists
const ensureDatabaseDirectory = () => {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created database directory: ${dir}`);
    }
};

// Initialize database connection
let db = null;

/**
 * Connect to the database
 * @returns {Promise<sqlite3.Database>} Database connection
 */
const connect = () => {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        ensureDatabaseDirectory();

        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                logger.error(`Error connecting to IPTV SQLite database: ${err.message}`);
                reject(err);
                return;
            }
            
            logger.info('Connected to IPTV SQLite database');
            
            // Enable foreign keys
            db.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
                if (pragmaErr) {
                    logger.warn(`Error enabling foreign keys: ${pragmaErr.message}`);
                }
                
                // Set journal mode to WAL for better performance
                db.run('PRAGMA journal_mode = WAL', (journalErr) => {
                    if (journalErr) {
                        logger.warn(`Error setting journal mode: ${journalErr.message}`);
                    }
                    
                    // Initialize tables
                    initializeTables()
                        .then(() => resolve(db))
                        .catch(reject);
                });
            });
        });
    });
};

/**
 * Initialize database tables
 * @returns {Promise<void>}
 */
const initializeTables = () => {
    return new Promise((resolve, reject) => {
        const queries = [
            // IPTV Sources table
            `CREATE TABLE IF NOT EXISTS iptv_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                url TEXT UNIQUE,
                username TEXT,
                password TEXT,
                type TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(url, username, password)
            )`,
            
            // IPTV Categories table
            `CREATE TABLE IF NOT EXISTS iptv_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER,
                category_id TEXT,
                name TEXT,
                FOREIGN KEY(source_id) REFERENCES iptv_sources(id) ON DELETE CASCADE,
                UNIQUE(source_id, category_id)
            )`,
            
            // IPTV Channels table
            `CREATE TABLE IF NOT EXISTS iptv_channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER,
                channel_id TEXT,
                name TEXT,
                logo TEXT,
                url TEXT,
                group_title TEXT,
                epg_channel_id TEXT,
                categories TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_id) REFERENCES iptv_sources(id) ON DELETE CASCADE,
                UNIQUE(source_id, channel_id)
            )`,
            
            // Session IPTV mappings
            `CREATE TABLE IF NOT EXISTS session_iptv_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                source_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_id) REFERENCES iptv_sources(id) ON DELETE CASCADE,
                UNIQUE(session_id, source_id)
            )`,
            
            // Create indexes for performance
            `CREATE INDEX IF NOT EXISTS idx_iptv_channels_source_id ON iptv_channels(source_id)`,
            `CREATE INDEX IF NOT EXISTS idx_iptv_channels_name ON iptv_channels(name)`,
            `CREATE INDEX IF NOT EXISTS idx_iptv_channels_epg_id ON iptv_channels(epg_channel_id)`,
            `CREATE INDEX IF NOT EXISTS idx_session_mappings ON session_iptv_mappings(session_id)`
        ];
        
        db.serialize(() => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) {
                    logger.error(`Error starting transaction: ${err.message}`);
                    reject(err);
                    return;
                }
                
                let hadError = false;
                
                queries.forEach((query) => {
                    if (hadError) return;
                    
                    db.run(query, (queryErr) => {
                        if (queryErr) {
                            hadError = true;
                            logger.error(`Error creating table: ${queryErr.message}`);
                            db.run('ROLLBACK', () => reject(queryErr));
                        }
                    });
                });
                
                if (!hadError) {
                    db.run('COMMIT', (commitErr) => {
                        if (commitErr) {
                            logger.error(`Error committing transaction: ${commitErr.message}`);
                            reject(commitErr);
                            return;
                        }
                        
                        logger.info('IPTV database tables created successfully');
                        resolve();
                    });
                }
            });
        });
    });
};

/**
 * Save IPTV source information
 * @param {Object} source - Source information
 * @returns {Promise<number>} Source ID
 */
const saveSource = (source) => {
    return new Promise((resolve, reject) => {
        const { name, url, username, password, type } = source;
        
        db.run(
            `INSERT INTO iptv_sources (name, url, username, password, type, last_updated) 
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(url, username, password) 
             DO UPDATE SET last_updated = CURRENT_TIMESTAMP, name = ?, type = ?
             RETURNING id`,
            [name, url, username, password, type, name, type],
            function(err) {
                if (err) {
                    logger.error(`Error saving IPTV source: ${err.message}`);
                    reject(err);
                    return;
                }
                
                // Get the source ID (either new or existing)
                db.get(
                    `SELECT id FROM iptv_sources WHERE url = ? AND username = ? AND password = ?`,
                    [url, username, password],
                    (getErr, row) => {
                        if (getErr) {
                            logger.error(`Error getting source ID: ${getErr.message}`);
                            reject(getErr);
                            return;
                        }
                        
                        resolve(row.id);
                    }
                );
            }
        );
    });
};

/**
 * Save IPTV categories
 * @param {number} sourceId - Source ID
 * @param {Array<Object>} categories - Categories to save
 * @returns {Promise<void>}
 */
const saveCategories = (sourceId, categories) => {
    return new Promise((resolve, reject) => {
        if (!categories || categories.length === 0) {
            resolve();
            return;
        }
        
        const placeholders = categories.map(() => '(?, ?, ?)').join(',');
        const params = [];
        
        categories.forEach(category => {
            params.push(sourceId, category.id, category.name);
        });
        
        db.run(
            `INSERT INTO iptv_categories (source_id, category_id, name)
             VALUES ${placeholders}
             ON CONFLICT(source_id, category_id) 
             DO UPDATE SET name = excluded.name`,
            params,
            function(err) {
                if (err) {
                    logger.error(`Error saving IPTV categories: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve();
            }
        );
    });
};

/**
 * Save IPTV channels in batches
 * @param {number} sourceId - Source ID
 * @param {Array<Object>} channels - Channels to save
 * @returns {Promise<void>}
 */
const saveChannels = (sourceId, channels) => {
    return new Promise((resolve, reject) => {
        if (!channels || channels.length === 0) {
            resolve();
            return;
        }
        
        const batchSize = 1000;
        const totalBatches = Math.ceil(channels.length / batchSize);
        let processedBatches = 0;
        
        logger.info(`Saving ${channels.length} channels in ${totalBatches} batches`);
        
        const processNextBatch = () => {
            const batch = channels.slice(
                processedBatches * batchSize, 
                (processedBatches + 1) * batchSize
            );
            
            const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(',');
            const params = [];
            
            batch.forEach(channel => {
                params.push(
                    sourceId,
                    channel.id || channel.name,
                    channel.name,
                    channel.logo || channel.tvg?.logo || '',
                    channel.url,
                    channel.group?.title || '',
                    channel.tvg?.id || '',
                    channel.categories ? JSON.stringify(channel.categories) : '[]'
                );
            });
            
            db.run(
                `INSERT INTO iptv_channels 
                 (source_id, channel_id, name, logo, url, group_title, epg_channel_id, categories, last_updated)
                 VALUES ${placeholders}
                 ON CONFLICT(source_id, channel_id) 
                 DO UPDATE SET 
                    name = excluded.name,
                    logo = excluded.logo,
                    url = excluded.url,
                    group_title = excluded.group_title,
                    epg_channel_id = excluded.epg_channel_id,
                    categories = excluded.categories,
                    last_updated = CURRENT_TIMESTAMP`,
                params,
                function(err) {
                    if (err) {
                        logger.error(`Error saving IPTV channels batch ${processedBatches + 1}/${totalBatches}: ${err.message}`);
                        reject(err);
                        return;
                    }
                    
                    processedBatches++;
                    
                    if (processedBatches % 10 === 0) {
                        logger.info(`Saved ${processedBatches}/${totalBatches} batches of channels`);
                    }
                    
                    if (processedBatches < totalBatches) {
                        processNextBatch();
                    } else {
                        logger.info(`Completed saving ${channels.length} channels`);
                        resolve();
                    }
                }
            );
        };
        
        processNextBatch();
    });
};

/**
 * Associate an IPTV source with a session
 * @param {string} sessionId - Session ID
 * @param {number} sourceId - Source ID
 * @returns {Promise<void>}
 */
const associateSourceWithSession = (sessionId, sourceId) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO session_iptv_mappings (session_id, source_id)
             VALUES (?, ?)
             ON CONFLICT(session_id, source_id) DO NOTHING`,
            [sessionId, sourceId],
            function(err) {
                if (err) {
                    logger.error(`Error associating source with session: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve();
            }
        );
    });
};

/**
 * Get channels for a session
 * @param {string} sessionId - Session ID
 * @param {Object} options - Query options
 * @returns {Promise<Array<Object>>} Channels
 */
const getChannelsForSession = (sessionId, options = {}) => {
    return new Promise((resolve, reject) => {
        const {
            page = 1,
            limit = 100,
            categoryId = null,
            search = null,
            sortBy = 'name',
            sortOrder = 'asc'
        } = options;
        
        const offset = (page - 1) * limit;
        const params = [sessionId];
        
        let whereClause = '';
        
        if (categoryId) {
            whereClause += ' AND c.group_title = ?';
            params.push(categoryId);
        }
        
        if (search) {
            whereClause += ' AND c.name LIKE ?';
            params.push(`%${search}%`);
        }
        
        // Validate sort parameters for security
        const validSortColumns = ['name', 'group_title', 'last_updated'];
        const validSortOrders = ['asc', 'desc'];
        
        const sanitizedSortBy = validSortColumns.includes(sortBy) ? sortBy : 'name';
        const sanitizedSortOrder = validSortOrders.includes(sortOrder.toLowerCase()) ? 
            sortOrder.toLowerCase() : 'asc';
        
        db.all(
            `SELECT c.* FROM iptv_channels c
             JOIN session_iptv_mappings m ON c.source_id = m.source_id
             WHERE m.session_id = ? ${whereClause}
             ORDER BY c.${sanitizedSortBy} ${sanitizedSortOrder}
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
            (err, rows) => {
                if (err) {
                    logger.error(`Error getting channels for session: ${err.message}`);
                    reject(err);
                    return;
                }
                
                // Get total count for pagination
                db.get(
                    `SELECT COUNT(*) as total FROM iptv_channels c
                     JOIN session_iptv_mappings m ON c.source_id = m.source_id
                     WHERE m.session_id = ? ${whereClause}`,
                    params,
                    (countErr, countRow) => {
                        if (countErr) {
                            logger.error(`Error getting channel count: ${countErr.message}`);
                            reject(countErr);
                            return;
                        }
                        
                        resolve({
                            channels: rows.map(row => ({
                                id: row.channel_id,
                                name: row.name,
                                logo: row.logo,
                                url: row.url,
                                group: { title: row.group_title },
                                tvg: { id: row.epg_channel_id },
                                categories: row.categories ? JSON.parse(row.categories) : []
                            })),
                            pagination: {
                                total: countRow.total,
                                page,
                                limit,
                                pages: Math.ceil(countRow.total / limit)
                            }
                        });
                    }
                );
            }
        );
    });
};

/**
 * Get categories for a session
 * @param {string} sessionId - Session ID
 * @returns {Promise<Array<Object>>} Categories
 */
const getCategoriesForSession = (sessionId) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT c.group_title as name, COUNT(*) as channel_count
             FROM iptv_channels c
             JOIN session_iptv_mappings m ON c.source_id = m.source_id
             WHERE m.session_id = ? AND c.group_title != ''
             GROUP BY c.group_title
             ORDER BY c.group_title`,
            [sessionId],
            (err, rows) => {
                if (err) {
                    logger.error(`Error getting categories for session: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve(rows.map(row => ({
                    id: row.name,
                    name: row.name,
                    channelCount: row.channel_count
                })));
            }
        );
    });
};

/**
 * Get a channel by ID for a session
 * @param {string} sessionId - Session ID
 * @param {string} channelId - Channel ID
 * @returns {Promise<Object>} Channel
 */
const getChannelById = (sessionId, channelId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT c.* FROM iptv_channels c
             JOIN session_iptv_mappings m ON c.source_id = m.source_id
             WHERE m.session_id = ? AND c.channel_id = ?`,
            [sessionId, channelId],
            (err, row) => {
                if (err) {
                    logger.error(`Error getting channel by ID: ${err.message}`);
                    reject(err);
                    return;
                }
                
                if (!row) {
                    resolve(null);
                    return;
                }
                
                resolve({
                    id: row.channel_id,
                    name: row.name,
                    logo: row.logo,
                    url: row.url,
                    group: { title: row.group_title },
                    tvg: { id: row.epg_channel_id },
                    categories: row.categories ? JSON.parse(row.categories) : []
                });
            }
        );
    });
};

/**
 * Clean up old sessions (older than 48 hours)
 * @returns {Promise<number>} Number of sessions cleaned up
 */
const cleanupOldSessions = () => {
    return new Promise((resolve, reject) => {
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - 48); // 48 hours ago
        
        db.run(
            `DELETE FROM session_iptv_mappings 
             WHERE created_at < ?`,
            [cutoffTime.toISOString()],
            function(err) {
                if (err) {
                    logger.error(`Error cleaning up old sessions: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve(this.changes);
            }
        );
    });
};

/**
 * Search channels by name
 * @param {string} sessionId - Session ID
 * @param {string} query - Search query
 * @param {number} limit - Results limit
 * @returns {Promise<Array<Object>>} Matching channels
 */
const searchChannels = (sessionId, query, limit = 100) => {
    return new Promise((resolve, reject) => {
        // Create search tokens for more flexible matching
        const searchTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
        
        if (searchTokens.length === 0) {
            resolve([]);
            return;
        }
        
        // Build query conditions for each token
        const conditions = searchTokens.map(() => 'LOWER(c.name) LIKE ?').join(' OR ');
        const params = [];
        
        // Add parameters for each token
        searchTokens.forEach(token => {
            params.push(`%${token}%`);
        });
        
        // Add session ID and limit
        params.unshift(sessionId);
        params.push(limit);
        
        db.all(
            `SELECT c.* FROM iptv_channels c
             JOIN session_iptv_mappings m ON c.source_id = m.source_id
             WHERE m.session_id = ? AND (${conditions})
             ORDER BY 
                CASE WHEN LOWER(c.name) = LOWER(?) THEN 1
                     WHEN LOWER(c.name) LIKE LOWER(?) THEN 2
                     ELSE 3
                END,
                c.name
             LIMIT ?`,
            [...params, query.toLowerCase(), `${query.toLowerCase()}%`],
            (err, rows) => {
                if (err) {
                    logger.error(`Error searching channels: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve(rows.map(row => ({
                    id: row.channel_id,
                    name: row.name,
                    logo: row.logo,
                    url: row.url,
                    group: { title: row.group_title },
                    tvg: { id: row.epg_channel_id },
                    categories: row.categories ? JSON.parse(row.categories) : []
                })));
            }
        );
    });
};

/**
 * Update EPG channel ID mapping
 * @param {string} sessionId - Session ID
 * @param {string} channelId - Channel ID
 * @param {string} epgChannelId - EPG channel ID
 * @returns {Promise<boolean>} Success status
 */
const updateChannelEpgMapping = (sessionId, channelId, epgChannelId) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE iptv_channels
             SET epg_channel_id = ?
             WHERE channel_id = ? AND source_id IN (
                SELECT source_id FROM session_iptv_mappings WHERE session_id = ?
             )`,
            [epgChannelId, channelId, sessionId],
            function(err) {
                if (err) {
                    logger.error(`Error updating channel EPG mapping: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve(this.changes > 0);
            }
        );
    });
};

module.exports = {
    connect,
    saveSource,
    saveCategories,
    saveChannels,
    associateSourceWithSession,
    getChannelsForSession,
    getCategoriesForSession,
    getChannelById,
    cleanupOldSessions,
    searchChannels,
    updateChannelEpgMapping
}; 