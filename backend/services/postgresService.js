/**
 * PostgreSQL Database Service
 * Replaces iptvDatabaseService.js for production scalability
 */

const { Pool } = require('pg');
const logger = require('../utils/logger');

// Connection pool configuration
const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT) || 5432,
    database: process.env.POSTGRES_DB || 'iptvguru',
    user: process.env.POSTGRES_USER || 'iptvguru',
    password: process.env.POSTGRES_PASSWORD,
    max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS) || 50,
    min: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 600000, // 10 minute query timeout for bulk operations
    ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
    } : false
});

// Pool error handling
pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle PostgreSQL client:', err);
});

pool.on('connect', (client) => {
    logger.debug('New PostgreSQL client connected');
});

pool.on('remove', (client) => {
    logger.debug('PostgreSQL client removed from pool');
});

/**
 * Execute query with retry logic
 * @param {string} query - SQL query
 * @param {Array} params - Query parameters
 * @param {number} retries - Number of retries remaining
 * @returns {Promise<Object>} Query result
 */
async function queryWithRetry(query, params = [], retries = 3) {
    try {
        const start = Date.now();
        const result = await pool.query(query, params);
        const duration = Date.now() - start;

        // Don't warn about slow bulk INSERT/DELETE operations - they're expected during channel refresh
        const isBulkOperation = query.trim().toUpperCase().startsWith('INSERT') ||
                                 query.trim().toUpperCase().startsWith('DELETE');

        if (duration > 1000 && !isBulkOperation) {
            logger.warn('Slow query detected', { duration, query: query.substring(0, 100) });
        }

        return result;
    } catch (error) {
        if (retries > 0 && (error.code === 'ECONNREFUSED' || error.code === '57P03')) {
            logger.warn(`Query failed, retrying... (${retries} attempts left)`, { error: error.message });
            await new Promise(resolve => setTimeout(resolve, 100 * (4 - retries))); // Exponential backoff
            return queryWithRetry(query, params, retries - 1);
        }
        throw error;
    }
}

/**
 * Execute transaction
 * @param {Function} callback - Async function that receives client
 * @returns {Promise<any>} Result from callback
 */
async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Health check
 */
async function healthCheck() {
    try {
        const result = await pool.query('SELECT NOW()');
        return {
            status: 'healthy',
            timestamp: result.rows[0].now,
            poolSize: pool.totalCount,
            idleConnections: pool.idleCount,
            waitingClients: pool.waitingCount
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            error: error.message
        };
    }
}

/**
 * Close all connections
 */
async function close() {
    await pool.end();
    logger.info('PostgreSQL connection pool closed');
}

// ============================================================================
// User Operations
// ============================================================================

async function createUser(username, email, passwordHash) {
    const query = `
        INSERT INTO users (username, email, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, username, email, created_at
    `;
    const result = await queryWithRetry(query, [username, email, passwordHash]);
    return result.rows[0];
}

async function getUserByEmail(email) {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await queryWithRetry(query, [email]);
    return result.rows[0];
}

async function getUserByUsername(username) {
    const query = 'SELECT * FROM users WHERE username = $1';
    const result = await queryWithRetry(query, [username]);
    return result.rows[0];
}

async function getUserById(id) {
    const query = 'SELECT id, username, email, created_at, last_login FROM users WHERE id = $1';
    const result = await queryWithRetry(query, [id]);
    return result.rows[0];
}

async function updateLastLogin(userId) {
    const query = 'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1';
    await queryWithRetry(query, [userId]);
}

// ============================================================================
// IPTV Source Operations
// ============================================================================

async function saveSource(sourceData) {
    const {
        user_id, session_id, name, type, url, username, password, mac_address,
        exp_date, max_connections, active_connections, account_status, is_trial, account_created_at
    } = sourceData;

    // Check for existing source
    let checkQuery;
    let checkParams;

    if (type === 'stalker') {
        checkQuery = `
            SELECT id FROM iptv_sources
            WHERE user_id = $1 AND type = 'stalker' AND url = $2 AND mac_address = $3
        `;
        checkParams = [user_id, url, mac_address];
    } else if (type === 'xtream') {
        checkQuery = `
            SELECT id FROM iptv_sources
            WHERE user_id = $1 AND type = 'xtream' AND url = $2 AND username = $3
        `;
        checkParams = [user_id, url, username];
    } else {
        checkQuery = `
            SELECT id FROM iptv_sources
            WHERE user_id = $1 AND type = $2 AND url = $3
        `;
        checkParams = [user_id, type, url];
    }

    const existing = await queryWithRetry(checkQuery, checkParams);

    if (existing.rows.length > 0) {
        // Update existing source with account info
        const updateQuery = `
            UPDATE iptv_sources
            SET name = $1,
                exp_date = $2,
                max_connections = $3,
                active_connections = $4,
                account_status = $5,
                is_trial = $6,
                account_created_at = $7,
                last_refreshed = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $8
            RETURNING *
        `;
        const result = await queryWithRetry(updateQuery, [
            name, exp_date, max_connections, active_connections,
            account_status, is_trial, account_created_at, existing.rows[0].id
        ]);
        return result.rows[0];
    } else {
        // Insert new source
        const insertQuery = `
            INSERT INTO iptv_sources (
                user_id, session_id, name, type, url, username, password, mac_address,
                exp_date, max_connections, active_connections, account_status, is_trial, account_created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
        `;
        const result = await queryWithRetry(insertQuery, [
            user_id, session_id, name, type, url, username, password, mac_address,
            exp_date, max_connections, active_connections, account_status, is_trial, account_created_at
        ]);
        return result.rows[0];
    }
}

async function getUserSources(userId, sessionId) {
    const query = `
        SELECT s.*
        FROM iptv_sources s
        WHERE s.user_id = $1 OR s.session_id = $2
        ORDER BY s.created_at DESC
    `;
    const result = await queryWithRetry(query, [userId, sessionId]);
    return result.rows;
}

async function deleteSource(sourceId, userId) {
    const query = 'DELETE FROM iptv_sources WHERE id = $1 AND user_id = $2 RETURNING id';
    const result = await queryWithRetry(query, [sourceId, userId]);
    return result.rowCount > 0;
}

// ============================================================================
// Channel Operations
// ============================================================================

async function saveChannels(channels, sourceId) {
    if (!channels || channels.length === 0) {
        return { saved: 0 };
    }

    // Deduplicate channels by ID (in case source API returns duplicates)
    const uniqueChannels = [];
    const seenIds = new Set();
    for (const channel of channels) {
        if (!seenIds.has(channel.id)) {
            seenIds.add(channel.id);
            uniqueChannels.push(channel);
        }
    }

    if (uniqueChannels.length < channels.length) {
        logger.warn(`Removed ${channels.length - uniqueChannels.length} duplicate channels for source ${sourceId}`);
    }

    // Delete all existing channels for this source first
    // This is much faster than ON CONFLICT for large datasets
    await queryWithRetry(
        'DELETE FROM iptv_channels WHERE source_id = $1',
        [sourceId]
    );

    logger.info(`Deleted old channels for source ${sourceId}, inserting ${uniqueChannels.length} new channels`);

    // Batch insert in chunks of 500 to avoid parameter limits
    const batchSize = 500;
    let savedCount = 0;

    for (let i = 0; i < uniqueChannels.length; i += batchSize) {
        const batch = uniqueChannels.slice(i, i + batchSize);

        // Build values array: ($1,$2,$3...), ($15,$16,$17...), ...
        const values = [];
        const params = [];

        batch.forEach((channel, idx) => {
            const offset = idx * 14;
            values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14})`);

            params.push(
                channel.id,
                sourceId,
                channel.name,
                channel.url,
                channel.logo,
                channel.category || channel.group_title,
                channel.tvg_id,
                channel.tvg_name,
                channel.group_title,
                channel.source_type,
                channel.source_username,
                channel.source_password,
                channel.source_url,
                channel.source_mac
            );
        });

        const query = `
            INSERT INTO iptv_channels (
                channel_id, source_id, name, stream_url, logo_url, category,
                tvg_id, tvg_name, group_title, source_type, source_username,
                source_password, source_url, source_mac
            )
            VALUES ${values.join(', ')}
            ON CONFLICT (channel_id, source_id) DO UPDATE SET
                name = EXCLUDED.name,
                stream_url = EXCLUDED.stream_url,
                logo_url = EXCLUDED.logo_url,
                category = EXCLUDED.category,
                tvg_id = EXCLUDED.tvg_id,
                tvg_name = EXCLUDED.tvg_name,
                group_title = EXCLUDED.group_title,
                updated_at = CURRENT_TIMESTAMP
        `;

        await queryWithRetry(query, params);
        savedCount += batch.length;
    }

    // Update the channel count on the source
    await queryWithRetry(
        'UPDATE iptv_sources SET channel_count = $1 WHERE id = $2',
        [savedCount, sourceId]
    );

    logger.info(`Saved ${savedCount} channels for source ${sourceId}`);
    return { saved: savedCount };
}

async function getChannelsForSession(sessionId, options = {}) {
    // Extract options with defaults
    const page = parseInt(options.page) || 1;
    const limit = parseInt(options.limit) || 50;
    const search = options.search || '';
    const categoryId = options.categoryId || '';
    const sourceId = options.sourceId ? parseInt(options.sourceId) : null;
    const userId = options.userId || null;

    // Use subquery for better query planning performance with large datasets
    // This forces PostgreSQL to use indexes instead of sequential scans
    let query = `
        SELECT c.channel_id as id, c.name, c.logo_url as logo, c.stream_url as url,
               c.group_title, c.category, c.tvg_id, c.source_id as "sourceId",
               s.name as "sourceName", s.type as "sourceType",
               c.source_type, c.source_username, c.source_password, c.source_url, c.source_mac
        FROM iptv_channels c
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE c.source_id IN (SELECT id FROM iptv_sources WHERE session_id = $1 OR user_id = $2)
    `;

    const params = [sessionId, userId];
    let paramIndex = 3;

    // Filter by source_id if provided
    if (sourceId) {
        query += ` AND c.source_id = $${paramIndex}`;
        params.push(sourceId);
        paramIndex++;
    }

    // Filter by search term if provided
    if (search) {
        query += ` AND c.name ILIKE $${paramIndex}`;
        params.push(`%${search}%`);
        paramIndex++;
    }

    // Filter by category if provided
    if (categoryId) {
        query += ` AND c.category = $${paramIndex}`;
        params.push(categoryId);
        paramIndex++;
    }

    // Count total - use fast estimate for large result sets
    // For pagination, an approximate count is acceptable and MUCH faster
    let total = 0;
    try {
        // Try exact count with a short timeout for small result sets
        const countQuery = query.replace(/SELECT c\.channel_id as id.*?\n.*?FROM/s, 'SELECT COUNT(*) as total FROM');
        const countResult = await Promise.race([
            queryWithRetry(countQuery, params),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Count timeout')), 2000))
        ]);
        total = countResult.rows && countResult.rows[0] ? parseInt(countResult.rows[0].total) : 0;
    } catch (err) {
        // If count times out, estimate based on limit
        // This is acceptable for pagination UX - users don't need exact totals
        logger.debug('Using estimated count for pagination');
        total = limit * 100; // Estimate: assume up to 100 pages worth of data
    }

    // Get paginated results
    // Skip ORDER BY when searching for better performance with large datasets
    // Users care more about finding matching results quickly than alphabetical order
    if (!search) {
        query += ` ORDER BY c.name`;
    }
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const result = await queryWithRetry(query, params);

    return {
        channels: result.rows,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

async function getChannelById(channelId) {
    const query = 'SELECT * FROM iptv_channels WHERE channel_id = $1';
    const result = await queryWithRetry(query, [channelId]);
    return result.rows[0];
}

// ============================================================================
// EPG Match Operations
// ============================================================================

async function saveEpgMatch(sessionId, userId, iptvChannelId, epgChannelId, useDummyEpg = false) {
    const query = `
        INSERT INTO epg_matches (session_id, user_id, iptv_channel_id, epg_channel_id, use_dummy_epg)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (session_id, iptv_channel_id)
        DO UPDATE SET
            epg_channel_id = EXCLUDED.epg_channel_id,
            use_dummy_epg = EXCLUDED.use_dummy_epg,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *
    `;

    const result = await queryWithRetry(query, [sessionId, userId, iptvChannelId, epgChannelId, useDummyEpg]);
    return result.rows[0];
}

async function getMatchedChannels(sessionId, userId) {
    const query = `
        SELECT
            m.*,
            c.name as channel_name,
            c.logo_url,
            c.category,
            s.name as source_name,
            s.type as source_type
        FROM epg_matches m
        JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE m.session_id = $1 OR m.user_id = $2
        ORDER BY m.created_at DESC
    `;

    const result = await queryWithRetry(query, [sessionId, userId]);
    return result.rows;
}

async function deleteEpgMatch(sessionId, iptvChannelId) {
    const query = 'DELETE FROM epg_matches WHERE session_id = $1 AND iptv_channel_id = $2';
    const result = await queryWithRetry(query, [sessionId, iptvChannelId]);
    return result.rowCount > 0;
}

// ============================================================================
// Credential Operations
// ============================================================================

async function saveCredential(credentialData) {
    const { user_id, session_id, username, password, expires_at } = credentialData;

    const query = `
        INSERT INTO credentials (user_id, session_id, username, password, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (username)
        DO UPDATE SET
            password = EXCLUDED.password,
            expires_at = EXCLUDED.expires_at,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *
    `;

    const result = await queryWithRetry(query, [user_id, session_id, username, password, expires_at]);
    return result.rows[0];
}

async function getCredentialByUsername(username) {
    const query = 'SELECT * FROM credentials WHERE username = $1 AND status = $2';
    const result = await queryWithRetry(query, [username, 'active']);
    return result.rows[0];
}

async function updateCredentialLastUsed(username) {
    const query = 'UPDATE credentials SET last_used = CURRENT_TIMESTAMP WHERE username = $1';
    await queryWithRetry(query, [username]);
}

// ============================================================================
// User EPG Sources
// ============================================================================

async function saveUserEpgSource(userId, sessionId, name, url) {
    const query = `
        INSERT INTO user_epg_sources (user_id, session_id, name, url)
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `;

    const result = await queryWithRetry(query, [userId, sessionId, name, url]);
    return result.rows[0];
}

async function getUserEpgSources(userId, sessionId) {
    const query = `
        SELECT * FROM user_epg_sources
        WHERE (user_id = $1 OR session_id = $2) AND enabled = true
        ORDER BY created_at DESC
    `;

    const result = await queryWithRetry(query, [userId, sessionId]);
    return result.rows;
}

// Export all functions
module.exports = {
    // Core
    pool,
    query: queryWithRetry,
    transaction,
    healthCheck,
    close,

    // Users
    createUser,
    getUserByEmail,
    getUserByUsername,
    getUserById,
    updateLastLogin,

    // Sources
    saveSource,
    getUserSources,
    deleteSource,

    // Channels
    saveChannels,
    getChannelsForSession,
    getChannelById,

    // EPG Matches
    saveEpgMatch,
    getMatchedChannels,
    deleteEpgMatch,

    // Credentials
    saveCredential,
    getCredentialByUsername,
    updateCredentialLastUsed,

    // User EPG Sources
    saveUserEpgSource,
    getUserEpgSources
};
