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
    max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS) || 20,
    min: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    statement_timeout: 30000, // 30 second query timeout
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

        if (duration > 1000) {
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
    const { user_id, session_id, name, type, url, username, password, mac_address } = sourceData;

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
        // Update existing source
        const updateQuery = `
            UPDATE iptv_sources
            SET name = $1, last_refreshed = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *
        `;
        const result = await queryWithRetry(updateQuery, [name, existing.rows[0].id]);
        return result.rows[0];
    } else {
        // Insert new source
        const insertQuery = `
            INSERT INTO iptv_sources (user_id, session_id, name, type, url, username, password, mac_address)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `;
        const result = await queryWithRetry(insertQuery, [
            user_id, session_id, name, type, url, username, password, mac_address
        ]);
        return result.rows[0];
    }
}

async function getUserSources(userId, sessionId) {
    const query = `
        SELECT * FROM iptv_sources
        WHERE user_id = $1 OR session_id = $2
        ORDER BY created_at DESC
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

    return transaction(async (client) => {
        let savedCount = 0;

        // Batch insert with ON CONFLICT
        for (const channel of channels) {
            const query = `
                INSERT INTO iptv_channels (
                    channel_id, source_id, name, stream_url, logo_url, category,
                    tvg_id, tvg_name, group_title, source_type, source_username,
                    source_password, source_url, source_mac
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (channel_id)
                DO UPDATE SET
                    name = EXCLUDED.name,
                    stream_url = EXCLUDED.stream_url,
                    logo_url = EXCLUDED.logo_url,
                    category = EXCLUDED.category,
                    updated_at = CURRENT_TIMESTAMP
            `;

            await client.query(query, [
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
            ]);

            savedCount++;
        }

        return { saved: savedCount };
    });
}

async function getChannelsForSession(sessionId, page = 1, pageSize = 50, search = '', category = '') {
    let query = `
        SELECT c.*
        FROM iptv_channels c
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE s.session_id = $1
    `;

    const params = [sessionId];
    let paramIndex = 2;

    if (search) {
        query += ` AND c.name ILIKE $${paramIndex}`;
        params.push(`%${search}%`);
        paramIndex++;
    }

    if (category) {
        query += ` AND c.category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
    }

    // Count total
    const countQuery = query.replace('SELECT c.*', 'SELECT COUNT(*) as total');
    const countResult = await queryWithRetry(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get paginated results
    query += ` ORDER BY c.name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, (page - 1) * pageSize);

    const result = await queryWithRetry(query, params);

    return {
        channels: result.rows,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
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
