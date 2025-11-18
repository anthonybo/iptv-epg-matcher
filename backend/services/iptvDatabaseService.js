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
            // IPTV Sources table - each source belongs to ONE user
            `CREATE TABLE IF NOT EXISTS iptv_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT,
                url TEXT,
                username TEXT,
                password TEXT,
                mac_address TEXT,
                type TEXT,
                exp_date TEXT,
                max_connections INTEGER,
                active_connections INTEGER,
                account_status TEXT,
                is_trial BOOLEAN DEFAULT 0,
                account_created_at TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, url, username, password),
                UNIQUE(user_id, url, mac_address)
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

            // User IPTV preferences (for multi-source management)
            `CREATE TABLE IF NOT EXISTS user_iptv_preferences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                source_id INTEGER NOT NULL,
                priority INTEGER DEFAULT 999,
                is_active BOOLEAN DEFAULT 1,
                nickname TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(source_id) REFERENCES iptv_sources(id) ON DELETE CASCADE,
                UNIQUE(user_id, source_id)
            )`,

            // Generated XTREAM credentials
            `CREATE TABLE IF NOT EXISTS generated_credentials (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                credential_id TEXT NOT NULL UNIQUE,
                m3u_file TEXT,
                epg_file TEXT,
                channel_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(username, password)
            )`,

            // User EPG Sources - custom EPG sources added by users
            `CREATE TABLE IF NOT EXISTS user_epg_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                url TEXT NOT NULL,
                name TEXT NOT NULL,
                enabled BOOLEAN DEFAULT 1,
                verified BOOLEAN DEFAULT 0,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, url)
            )`,

            // Create indexes for performance
            `CREATE INDEX IF NOT EXISTS idx_iptv_channels_source_id ON iptv_channels(source_id)`,
            `CREATE INDEX IF NOT EXISTS idx_iptv_channels_name ON iptv_channels(name)`,
            `CREATE INDEX IF NOT EXISTS idx_iptv_channels_epg_id ON iptv_channels(epg_channel_id)`,
            `CREATE INDEX IF NOT EXISTS idx_session_mappings ON session_iptv_mappings(session_id)`,
            `CREATE INDEX IF NOT EXISTS idx_user_iptv_prefs_user ON user_iptv_preferences(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_user_iptv_prefs_priority ON user_iptv_preferences(user_id, priority)`,
            `CREATE INDEX IF NOT EXISTS idx_generated_creds_user ON generated_credentials(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_generated_creds_username ON generated_credentials(username)`,
            `CREATE INDEX IF NOT EXISTS idx_user_epg_sources_user ON user_epg_sources(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_user_epg_sources_enabled ON user_epg_sources(user_id, enabled)`
        ];

        // Migration queries to add new columns to existing tables
        const migrationQueries = [
            // Add account info columns to iptv_sources if they don't exist
            `ALTER TABLE iptv_sources ADD COLUMN exp_date TEXT`,
            `ALTER TABLE iptv_sources ADD COLUMN max_connections INTEGER`,
            `ALTER TABLE iptv_sources ADD COLUMN active_connections INTEGER`,
            `ALTER TABLE iptv_sources ADD COLUMN account_status TEXT`,
            `ALTER TABLE iptv_sources ADD COLUMN is_trial BOOLEAN DEFAULT 0`,
            `ALTER TABLE iptv_sources ADD COLUMN account_created_at TEXT`,
            // Add mac_address column for MAG/Stalker middleware support
            `ALTER TABLE iptv_sources ADD COLUMN mac_address TEXT`,
            // Add user_id column to make sources per-user instead of shared
            `ALTER TABLE iptv_sources ADD COLUMN user_id INTEGER`,
            // Add LIVE prefix feature columns
            `ALTER TABLE iptv_sources ADD COLUMN auto_detect_live INTEGER DEFAULT 0`,
            `ALTER TABLE iptv_channels ADD COLUMN enable_live_prefix INTEGER DEFAULT 0`
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

                        // Run migrations (ignore errors for columns that already exist)
                        migrationQueries.forEach((migrationQuery) => {
                            db.run(migrationQuery, (migrationErr) => {
                                if (migrationErr) {
                                    // Ignore "duplicate column" errors
                                    if (!migrationErr.message.includes('duplicate column')) {
                                        logger.warn(`Migration warning: ${migrationErr.message}`);
                                    }
                                }
                            });
                        });

                        // Populate user_id for existing sources from user_iptv_preferences
                        db.run(`UPDATE iptv_sources
                                SET user_id = (
                                    SELECT user_id FROM user_iptv_preferences
                                    WHERE user_iptv_preferences.source_id = iptv_sources.id
                                    LIMIT 1
                                )
                                WHERE user_id IS NULL`, (updateErr) => {
                            if (updateErr) {
                                logger.warn(`Error migrating user_id: ${updateErr.message}`);
                            } else {
                                logger.info('Migrated user_id for existing sources');
                            }

                            // Clean up orphaned sources (sources with no user_id)
                            db.run(`DELETE FROM iptv_sources WHERE user_id IS NULL`, (cleanupErr, result) => {
                                if (cleanupErr) {
                                    logger.warn(`Error cleaning up orphaned sources: ${cleanupErr.message}`);
                                } else {
                                    logger.info(`Cleaned up orphaned sources`);
                                }

                                // Check if table needs schema migration (has old UNIQUE(url) constraint)
                                db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='iptv_sources'`, (schemaErr, schemaRow) => {
                                    if (schemaErr) {
                                        logger.error(`Error checking schema: ${schemaErr.message}`);
                                        resolve();
                                        return;
                                    }

                                    // If schema contains "url TEXT UNIQUE", we need to recreate the table
                                    if (schemaRow && schemaRow.sql && schemaRow.sql.includes('url TEXT UNIQUE')) {
                                        logger.info('Detected old schema with url TEXT UNIQUE - migrating to per-user constraints...');

                                        db.serialize(() => {
                                            // 1. Create new table with correct schema
                                        db.run(`CREATE TABLE iptv_sources_new (
                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                            user_id INTEGER NOT NULL,
                                            name TEXT,
                                            url TEXT,
                                            username TEXT,
                                            password TEXT,
                                            mac_address TEXT,
                                            type TEXT,
                                            exp_date TEXT,
                                            max_connections INTEGER,
                                            active_connections INTEGER,
                                            account_status TEXT,
                                            is_trial BOOLEAN DEFAULT 0,
                                            account_created_at TEXT,
                                            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                                            UNIQUE(user_id, url, username, password),
                                            UNIQUE(user_id, url, mac_address)
                                        )`, (createErr) => {
                                            if (createErr) {
                                                logger.error(`Error creating new table: ${createErr.message}`);
                                                resolve();
                                                return;
                                            }

                                            // 2. Copy data from old table
                                            db.run(`INSERT INTO iptv_sources_new
                                                    SELECT id, user_id, name, url, username, password, mac_address, type,
                                                           exp_date, max_connections, active_connections, account_status,
                                                           is_trial, account_created_at, last_updated
                                                    FROM iptv_sources`, (copyErr) => {
                                                if (copyErr) {
                                                    logger.error(`Error copying data: ${copyErr.message}`);
                                                    db.run(`DROP TABLE IF EXISTS iptv_sources_new`);
                                                    resolve();
                                                    return;
                                                }

                                                // 3. Drop old table
                                                db.run(`DROP TABLE iptv_sources`, (dropErr) => {
                                                    if (dropErr) {
                                                        logger.error(`Error dropping old table: ${dropErr.message}`);
                                                        resolve();
                                                        return;
                                                    }

                                                    // 4. Rename new table
                                                    db.run(`ALTER TABLE iptv_sources_new RENAME TO iptv_sources`, (renameErr) => {
                                                        if (renameErr) {
                                                            logger.error(`Error renaming table: ${renameErr.message}`);
                                                        } else {
                                                            logger.info('Successfully migrated iptv_sources table to per-user schema');
                                                        }
                                                        resolve();
                                                    });
                                                });
                                            });
                                        });
                                    });
                                    } else {
                                        logger.info('Schema already up to date');
                                        resolve();
                                    }
                                });
                            });
                        });
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
        const {
            user_id, name, url, username, password, mac_address, type,
            exp_date, max_connections, active_connections,
            account_status, is_trial, account_created_at
        } = source;

        if (!user_id) {
            reject(new Error('user_id is required'));
            return;
        }

        // First check if source already exists FOR THIS USER
        // For Stalker sources, check by user_id, URL, and MAC address
        // For Xtream sources, check by user_id, URL, username, and password
        let checkQuery, checkParams;
        if (type === 'stalker') {
            checkQuery = `SELECT id FROM iptv_sources WHERE user_id = ? AND type = 'stalker' AND url = ? AND (mac_address = ? OR mac_address IS NULL)`;
            checkParams = [user_id, url, mac_address];
        } else {
            checkQuery = `SELECT id FROM iptv_sources WHERE user_id = ? AND url = ? AND username = ? AND password = ?`;
            checkParams = [user_id, url, username, password];
        }

        db.get(
            checkQuery,
            checkParams,
            (checkErr, existingSource) => {
                if (checkErr) {
                    logger.error(`Error checking existing source: ${checkErr.message}`);
                    reject(checkErr);
                    return;
                }

                // If source exists, delete its old data before we update
                if (existingSource) {
                    logger.info(`Source already exists (ID: ${existingSource.id}), deleting old data to prepare for refresh`);

                    // Delete old channels AND categories
                    db.serialize(() => {
                        db.run(`DELETE FROM iptv_channels WHERE source_id = ?`, [existingSource.id]);
                        db.run(`DELETE FROM iptv_categories WHERE source_id = ?`, [existingSource.id]);

                        // Update the source metadata
                        db.run(
                            `UPDATE iptv_sources
                             SET last_updated = CURRENT_TIMESTAMP, name = ?, type = ?, user_id = ?,
                                 username = ?, password = ?, mac_address = ?,
                                 exp_date = ?, max_connections = ?, active_connections = ?,
                                 account_status = ?, is_trial = ?, account_created_at = ?
                             WHERE id = ?`,
                            [name, type, user_id, username, password, mac_address,
                             exp_date, max_connections, active_connections,
                             account_status, is_trial, account_created_at, existingSource.id],
                            (updateErr) => {
                                if (updateErr) {
                                    logger.error(`Error updating source: ${updateErr.message}`);
                                    reject(updateErr);
                                    return;
                                }
                                logger.info(`Refreshed source ${existingSource.id}, ready for new data`);
                                resolve(existingSource.id);
                            }
                        );
                    });
                } else {
                    // Source doesn't exist, create it
                    db.run(
                        `INSERT INTO iptv_sources (user_id, name, url, username, password, mac_address, type,
                                                   exp_date, max_connections, active_connections,
                                                   account_status, is_trial, account_created_at,
                                                   last_updated)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [user_id, name, url, username, password, mac_address, type,
                         exp_date, max_connections, active_connections,
                         account_status, is_trial, account_created_at],
                        function(insertErr) {
                            if (insertErr) {
                                logger.error(`Error inserting new source: ${insertErr.message}`);
                                reject(insertErr);
                                return;
                            }
                            logger.info(`Created new source with ID: ${this.lastID}`);
                            resolve(this.lastID);
                        }
                    );
                }
            }
        );
    });
};

/**
 * Update source account information without touching channels
 * @param {number} sourceId - Source ID
 * @param {Object} accountInfo - Account information to update
 * @returns {Promise<void>}
 */
const updateSourceAccountInfo = (sourceId, accountInfo) => {
    return new Promise((resolve, reject) => {
        const {
            exp_date, max_connections, active_connections,
            account_status, is_trial, account_created_at
        } = accountInfo;

        db.run(
            `UPDATE iptv_sources
             SET exp_date = ?,
                 max_connections = ?,
                 active_connections = ?,
                 account_status = ?,
                 is_trial = ?,
                 account_created_at = ?,
                 last_updated = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [exp_date, max_connections, active_connections,
             account_status, is_trial, account_created_at, sourceId],
            function(err) {
                if (err) {
                    logger.error(`Error updating source account info: ${err.message}`);
                    reject(err);
                    return;
                }

                logger.info(`Updated account info for source ${sourceId}`);
                resolve();
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
            sortOrder = 'asc',
            userId = null,
            sourceId = null
        } = options;

        const offset = (page - 1) * limit;

        // Validate sort parameters for security
        const validSortColumns = ['name', 'group_title', 'last_updated'];
        const validSortOrders = ['asc', 'desc'];

        const sanitizedSortBy = validSortColumns.includes(sortBy) ? sortBy : 'name';
        const sanitizedSortOrder = validSortOrders.includes(sortOrder.toLowerCase()) ?
            sortOrder.toLowerCase() : 'asc';

        let query, countQuery, params;

        if (userId) {
            // For authenticated users, use a subquery for better performance with large datasets
            // This forces PostgreSQL to use the index on source_id instead of sequential scan
            let whereClause = 'c.source_id IN (SELECT id FROM iptv_sources WHERE user_id = ?)';
            params = [userId];

            if (categoryId) {
                whereClause += ' AND c.group_title = ?';
                params.push(categoryId);
            }

            if (search) {
                whereClause += ' AND c.name LIKE ?';
                params.push(`%${search}%`);
            }

            if (sourceId) {
                whereClause += ' AND c.source_id = ?';
                params.push(sourceId);
            }

            query = `SELECT c.*,
                          COALESCE(
                              p.nickname,
                              CASE WHEN s.name LIKE 'Legacy IPTV Source%' THEN s.url ELSE s.name END,
                              s.url
                          ) as source_name,
                          s.url as source_url,
                          s.type as source_type,
                          s.auto_detect_live as source_auto_detect_live
                   FROM iptv_channels c
                   JOIN iptv_sources s ON c.source_id = s.id
                   LEFT JOIN user_iptv_preferences p ON s.id = p.source_id AND p.user_id = ?
                   WHERE ${whereClause}
                   ORDER BY c.${sanitizedSortBy} ${sanitizedSortOrder}
                   LIMIT ? OFFSET ?`;

            countQuery = `SELECT COUNT(DISTINCT c.channel_id) as total FROM iptv_channels c
                         WHERE ${whereClause}`;

            // Add userId for the LEFT JOIN in query
            const queryParams = [userId, ...params, limit, offset];

            console.log('[getChannelsForSession] Authenticated user query:', query);
            console.log('[getChannelsForSession] Params:', queryParams);

            db.all(query, queryParams, (err, rows) => {
                if (err) {
                    logger.error(`Error getting channels for authenticated user: ${err.message}`);
                    reject(err);
                    return;
                }

                // Get total count for pagination
                db.get(countQuery, params, (countErr, countRow) => {
                    if (countErr) {
                        logger.error(`Error getting channel count: ${countErr.message}`);
                        reject(countErr);
                        return;
                    }

                    logger.info(`Found ${rows.length} channels from IPTV database for user ${userId}`);

                    resolve({
                        channels: rows.map(row => {
                            // Extract base URL from channel URL if source name is invalid
                            let displayName = row.source_name;
                            if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
                                try {
                                    const urlObj = new URL(row.url);
                                    displayName = `${urlObj.protocol}//${urlObj.host}`;
                                } catch {
                                    displayName = row.source_url || `Source ${row.source_id}`;
                                }
                            }

                            return {
                                id: row.channel_id,
                                dbId: row.id,
                                sourceId: row.source_id,
                                sourceName: displayName,
                                sourceType: row.source_type,
                                sourceAutoDetectLive: row.source_auto_detect_live || 0,
                                name: row.name,
                                logo: row.logo,
                                url: row.url,
                                group: { title: row.group_title },
                                tvg: { id: row.epg_channel_id },
                                categories: row.categories ? JSON.parse(row.categories) : [],
                                enableLivePrefix: row.enable_live_prefix || 0
                            };
                        }),
                        pagination: {
                            total: countRow.total,
                            page,
                            limit,
                            pages: Math.ceil(countRow.total / limit)
                        }
                    });
                });
            });
        } else {
            // For guest users, use session mappings
            let whereClause = 'm.session_id = ?';
            params = [sessionId];

            if (categoryId) {
                whereClause += ' AND c.group_title = ?';
                params.push(categoryId);
            }

            if (search) {
                whereClause += ' AND c.name LIKE ?';
                params.push(`%${search}%`);
            }

            if (sourceId) {
                whereClause += ' AND c.source_id = ?';
                params.push(sourceId);
            }

            query = `SELECT c.*,
                          CASE WHEN s.name LIKE 'Legacy IPTV Source%' THEN s.url ELSE s.name END as source_name,
                          s.url as source_url,
                          s.type as source_type
                   FROM iptv_channels c
                   JOIN session_iptv_mappings m ON c.source_id = m.source_id
                   LEFT JOIN iptv_sources s ON c.source_id = s.id
                   WHERE ${whereClause}
                   ORDER BY c.${sanitizedSortBy} ${sanitizedSortOrder}
                   LIMIT ? OFFSET ?`;

            countQuery = `SELECT COUNT(DISTINCT c.channel_id) as total FROM iptv_channels c
                         JOIN session_iptv_mappings m ON c.source_id = m.source_id
                         WHERE ${whereClause}`;

            console.log('[getChannelsForSession] Guest user query:', query);
            console.log('[getChannelsForSession] Params:', [...params, limit, offset]);

            db.all(query, [...params, limit, offset], (err, rows) => {
                if (err) {
                    logger.error(`Error getting channels for session: ${err.message}`);
                    reject(err);
                    return;
                }

                // Get total count for pagination
                db.get(countQuery, params, (countErr, countRow) => {
                    if (countErr) {
                        logger.error(`Error getting channel count: ${countErr.message}`);
                        reject(countErr);
                        return;
                    }

                    resolve({
                        channels: rows.map(row => {
                            // Extract base URL from channel URL if source name is invalid
                            let displayName = row.source_name;
                            if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
                                try {
                                    const urlObj = new URL(row.url);
                                    displayName = `${urlObj.protocol}//${urlObj.host}`;
                                } catch {
                                    displayName = row.source_url || `Source ${row.source_id}`;
                                }
                            }

                            return {
                                id: row.channel_id,
                                sourceId: row.source_id,
                                sourceName: displayName,
                                sourceType: row.source_type,
                                name: row.name,
                                logo: row.logo,
                                url: row.url,
                                group: { title: row.group_title },
                                tvg: { id: row.epg_channel_id },
                                categories: row.categories ? JSON.parse(row.categories) : []
                            };
                        }),
                        pagination: {
                            total: countRow.total,
                            page,
                            limit,
                            pages: Math.ceil(countRow.total / limit)
                        }
                    });
                });
            });
        }
    });
};

/**
 * Get categories for a session
 * @param {string} sessionId - Session ID
 * @param {number} sourceId - Optional source ID to filter categories
 * @param {number} userId - Optional user ID for authenticated users
 * @returns {Promise<Array<Object>>} Categories
 */
const getCategoriesForSession = (sessionId, sourceId = null, userId = null) => {
    return new Promise((resolve, reject) => {
        let query, params;

        if (userId) {
            // For authenticated users, query directly from iptv_sources using user_id
            let whereClause = 's.user_id = ? AND c.group_title != \'\'';
            params = [userId];

            if (sourceId) {
                whereClause += ' AND c.source_id = ?';
                params.push(sourceId);
            }

            query = `SELECT DISTINCT c.group_title as name, COUNT(DISTINCT c.channel_id) as channel_count
                     FROM iptv_channels c
                     JOIN iptv_sources s ON c.source_id = s.id
                     WHERE ${whereClause}
                     GROUP BY c.group_title
                     ORDER BY c.group_title`;
        } else {
            // For guest users, use session mappings
            let whereClause = 'm.session_id = ? AND c.group_title != \'\'';
            params = [sessionId];

            if (sourceId) {
                whereClause += ' AND c.source_id = ?';
                params.push(sourceId);
            }

            query = `SELECT DISTINCT c.group_title as name, COUNT(DISTINCT c.channel_id) as channel_count
                     FROM iptv_channels c
                     JOIN session_iptv_mappings m ON c.source_id = m.source_id
                     WHERE ${whereClause}
                     GROUP BY c.group_title
                     ORDER BY c.group_title`;
        }

        db.all(query, params, (err, rows) => {
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
        });
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
             WHERE m.session_id = ? AND c.channel_id = ?
             LIMIT 1`,
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

/**
 * Get all IPTV sources for a user with their preferences
 * @param {number} userId - User ID
 * @returns {Promise<Array>} Array of sources with preferences
 */
const getUserIPTVSources = (userId) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT
                s.id as source_id,
                s.name,
                s.url,
                s.username,
                s.password,
                s.mac_address,
                s.type,
                s.exp_date,
                s.max_connections,
                s.active_connections,
                s.account_status,
                s.is_trial,
                s.account_created_at,
                s.last_updated,
                s.auto_detect_live,
                s.last_refresh_status,
                s.last_refresh_error,
                s.last_refresh_attempt,
                COALESCE(p.priority, 999) as priority,
                COALESCE(p.is_active, 1) as is_active,
                p.nickname,
                COALESCE(p.created_at, s.last_updated) as preference_created_at,
                (SELECT COUNT(*) FROM iptv_channels WHERE source_id = s.id) as channel_count
             FROM iptv_sources s
             LEFT JOIN user_iptv_preferences p ON s.id = p.source_id AND p.user_id = ?
             WHERE s.user_id = ?
             ORDER BY priority ASC, preference_created_at DESC`,
            [userId, userId],
            (err, rows) => {
                if (err) {
                    logger.error(`Error getting user IPTV sources: ${err.message}`);
                    reject(err);
                    return;
                }

                resolve(rows.map(row => ({
                    id: row.source_id,
                    name: row.name,
                    nickname: row.nickname || row.name,
                    url: row.url,
                    username: row.username,
                    password: row.password,
                    mac_address: row.mac_address,
                    type: row.type,
                    exp_date: row.exp_date,
                    max_connections: row.max_connections,
                    active_connections: row.active_connections,
                    account_status: row.account_status,
                    is_trial: row.is_trial,
                    account_created_at: row.account_created_at,
                    auto_detect_live: row.auto_detect_live || 0,
                    priority: row.priority,
                    is_active: row.is_active,
                    channel_count: row.channel_count,
                    last_updated: row.last_updated,
                    added_at: row.preference_created_at,
                    last_refresh_status: row.last_refresh_status,
                    last_refresh_error: row.last_refresh_error,
                    last_refresh_attempt: row.last_refresh_attempt
                })));
            }
        );
    });
};

/**
 * Create or update user IPTV preference
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @param {Object} options - Preference options
 * @returns {Promise<void>}
 */
const createUserIPTVPreference = (userId, sourceId, options = {}) => {
    return new Promise((resolve, reject) => {
        const { nickname, priority, isActive = true } = options;

        // If no priority specified, get the next available priority
        if (priority === undefined || priority === null) {
            db.get(
                `SELECT COALESCE(MAX(priority), 0) + 1 as next_priority
                 FROM user_iptv_preferences
                 WHERE user_id = ?`,
                [userId],
                (err, row) => {
                    if (err) {
                        logger.error(`Error getting next priority: ${err.message}`);
                        reject(err);
                        return;
                    }

                    insertPreference(row.next_priority);
                }
            );
        } else {
            insertPreference(priority);
        }

        function insertPreference(finalPriority) {
            db.run(
                `INSERT INTO user_iptv_preferences (user_id, source_id, priority, is_active, nickname, updated_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id, source_id)
                 DO UPDATE SET
                    priority = excluded.priority,
                    is_active = excluded.is_active,
                    nickname = COALESCE(excluded.nickname, nickname),
                    updated_at = CURRENT_TIMESTAMP`,
                [userId, sourceId, finalPriority, isActive ? 1 : 0, nickname],
                function(err) {
                    if (err) {
                        logger.error(`Error creating user IPTV preference: ${err.message}`);
                        reject(err);
                        return;
                    }

                    logger.info(`Created IPTV preference for user ${userId}, source ${sourceId}, priority ${finalPriority}`);
                    resolve();
                }
            );
        }
    });
};

/**
 * Update source priority for a user
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @param {number} newPriority - New priority value
 * @returns {Promise<void>}
 */
const updateSourcePriority = (userId, sourceId, newPriority) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE user_iptv_preferences
             SET priority = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND source_id = ?`,
            [newPriority, userId, sourceId],
            function(err) {
                if (err) {
                    logger.error(`Error updating source priority: ${err.message}`);
                    reject(err);
                    return;
                }

                resolve();
            }
        );
    });
};

/**
 * Update source nickname for a user
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @param {string} nickname - New nickname
 * @returns {Promise<void>}
 */
const updateSourceNickname = (userId, sourceId, nickname) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE user_iptv_preferences
             SET nickname = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND source_id = ?`,
            [nickname, userId, sourceId],
            function(err) {
                if (err) {
                    logger.error(`Error updating source nickname: ${err.message}`);
                    reject(err);
                    return;
                }

                resolve();
            }
        );
    });
};

/**
 * Update source credentials (URL, username, password)
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @param {Object} credentials - { url, username, password }
 * @returns {Promise<void>}
 */
const updateSourceCredentials = (userId, sourceId, credentials) => {
    return new Promise((resolve, reject) => {
        const { url, username, password } = credentials;

        db.run(
            `UPDATE iptv_sources
             SET url = ?, username = ?, password = ?, last_updated = CURRENT_TIMESTAMP
             WHERE id = ? AND id IN (
                 SELECT source_id FROM user_iptv_preferences WHERE user_id = ?
             )`,
            [url, username || null, password || null, sourceId, userId],
            function(err) {
                if (err) {
                    logger.error(`Error updating source credentials: ${err.message}`);
                    reject(err);
                    return;
                }

                if (this.changes === 0) {
                    reject(new Error('Source not found or user does not have access'));
                    return;
                }

                resolve();
            }
        );
    });
};

/**
 * Toggle source active state for a user
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @param {boolean} isActive - Active state
 * @returns {Promise<void>}
 */
const toggleSourceActive = (userId, sourceId, isActive) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE user_iptv_preferences
             SET is_active = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND source_id = ?`,
            [isActive ? 1 : 0, userId, sourceId],
            function(err) {
                if (err) {
                    logger.error(`Error toggling source active state: ${err.message}`);
                    reject(err);
                    return;
                }

                resolve();
            }
        );
    });
};

/**
 * Get IPTV source by ID
 * @param {number} sourceId - Source ID
 * @returns {Promise<Object|null>} Source object or null if not found
 */
const getSourceById = (sourceId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM iptv_sources WHERE id = ?`,
            [sourceId],
            (err, row) => {
                if (err) {
                    logger.error(`Error getting source by ID: ${err.message}`);
                    reject(err);
                    return;
                }

                resolve(row || null);
            }
        );
    });
};

/**
 * Delete user's IPTV source preference (doesn't delete actual source)
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @returns {Promise<void>}
 */
const deleteUserSource = (userId, sourceId) => {
    return new Promise((resolve, reject) => {
        // First delete the user preference (if it exists)
        db.run(
            `DELETE FROM user_iptv_preferences WHERE user_id = ? AND source_id = ?`,
            [userId, sourceId],
            (prefErr) => {
                if (prefErr) {
                    logger.warn(`Error deleting user preference: ${prefErr.message}`);
                }

                // Then delete the actual source (channels and categories will cascade)
                db.run(
                    `DELETE FROM iptv_sources WHERE id = ? AND user_id = ?`,
                    [sourceId, userId],
                    function(err) {
                        if (err) {
                            logger.error(`Error deleting IPTV source: ${err.message}`);
                            reject(err);
                            return;
                        }

                        logger.info(`Deleted IPTV source ${sourceId} for user ${userId}`);
                        resolve();
                    }
                );
            }
        );
    });
};

/**
 * Get alternate feeds for a channel across user's sources
 * @param {number} userId - User ID
 * @param {string} channelName - Channel name to match
 * @param {string} epgChannelId - EPG channel ID to match (optional)
 * @returns {Promise<Array<Object>>} Alternate feeds ordered by priority
 */
const getAlternateFeeds = (userId, channelName, epgChannelId = null) => {
    return new Promise((resolve, reject) => {
        if (!userId || !channelName) {
            resolve([]);
            return;
        }

        // Build query to find matching channels across user's active sources
        // Match by channel name (case-insensitive) or epg_channel_id
        const query = `
            SELECT
                c.id,
                c.channel_id,
                c.name,
                c.logo,
                c.url,
                c.group_title,
                c.epg_channel_id,
                s.id as source_id,
                s.name as source_name,
                s.type as source_type,
                p.priority,
                p.nickname as source_nickname,
                p.is_active
            FROM iptv_channels c
            JOIN iptv_sources s ON c.source_id = s.id
            JOIN user_iptv_preferences p ON s.id = p.source_id
            WHERE p.user_id = ?
                AND p.is_active = 1
                AND (
                    LOWER(c.name) = LOWER(?)
                    ${epgChannelId ? 'OR c.epg_channel_id = ?' : ''}
                )
            ORDER BY p.priority ASC, s.name ASC
        `;

        const params = epgChannelId
            ? [userId, channelName, epgChannelId]
            : [userId, channelName];

        db.all(query, params, (err, rows) => {
            if (err) {
                logger.error(`Error fetching alternate feeds: ${err.message}`);
                reject(err);
                return;
            }

            if (!rows || rows.length === 0) {
                resolve([]);
                return;
            }

            // Transform results
            const feeds = rows.map(row => ({
                id: row.id,
                channelId: row.channel_id,
                name: row.name,
                logo: row.logo,
                url: row.url,
                groupTitle: row.group_title,
                epgChannelId: row.epg_channel_id,
                source: {
                    id: row.source_id,
                    name: row.source_name,
                    nickname: row.source_nickname || row.source_name,
                    type: row.source_type,
                    priority: row.priority,
                    isActive: row.is_active === 1
                }
            }));

            logger.debug(`Found ${feeds.length} alternate feeds for channel "${channelName}"`);
            resolve(feeds);
        });
    });
};

/**
 * Update auto_detect_live setting for a source
 * @param {number} userId - User ID
 * @param {number} sourceId - Source ID
 * @param {boolean} autoDetectLive - Auto detect live state
 * @returns {Promise<void>}
 */
const updateSourceAutoDetectLive = (userId, sourceId, autoDetectLive) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE iptv_sources
             SET auto_detect_live = ?
             WHERE id = ? AND user_id = ?`,
            [autoDetectLive ? 1 : 0, sourceId, userId],
            function(err) {
                if (err) {
                    logger.error(`Error updating source auto_detect_live: ${err.message}`);
                    reject(err);
                    return;
                }

                if (this.changes === 0) {
                    reject(new Error('Source not found or user does not have access'));
                    return;
                }

                resolve();
            }
        );
    });
};

/**
 * Update enable_live_prefix setting for a channel
 * @param {number} userId - User ID
 * @param {number} channelId - Channel ID (the integer ID, not channel_id)
 * @param {boolean} enableLivePrefix - Enable live prefix state
 * @returns {Promise<void>}
 */
const updateChannelLivePrefix = (userId, channelId, enableLivePrefix) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE iptv_channels
             SET enable_live_prefix = ?
             WHERE channel_id = ? AND source_id IN (
                SELECT id FROM iptv_sources WHERE user_id = ?
             )`,
            [enableLivePrefix ? 1 : 0, channelId, userId],
            function(err) {
                if (err) {
                    logger.error(`Error updating channel enable_live_prefix: ${err.message}`);
                    reject(err);
                    return;
                }

                if (this.changes === 0) {
                    reject(new Error('Channel not found or user does not have access'));
                    return;
                }

                resolve();
            }
        );
    });
};

module.exports = {
    connect,
    saveSource,
    updateSourceAccountInfo,
    saveCategories,
    saveChannels,
    associateSourceWithSession,
    getChannelsForSession,
    getCategoriesForSession,
    getChannelById,
    cleanupOldSessions,
    searchChannels,
    updateChannelEpgMapping,
    // Multi-IPTV source management
    getUserIPTVSources,
    createUserIPTVPreference,
    updateSourcePriority,
    updateSourceNickname,
    updateSourceCredentials,
    toggleSourceActive,
    getSourceById,
    deleteUserSource,
    getAlternateFeeds,
    // LIVE prefix feature
    updateSourceAutoDetectLive,
    updateChannelLivePrefix
}; 