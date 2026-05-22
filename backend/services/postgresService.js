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

        // Include the SQL preview in the warning. The previous version
        // stripped query info to keep the log line short, but then any
        // sustained slow-query storm (e.g. 944/day) was completely
        // un-diagnosable from the logs alone. A 120-char preview is
        // plenty to identify the call site without bloating the logs.
        if (duration > 1000 && !isBulkOperation) {
            const preview = query.replace(/\s+/g, ' ').trim().substring(0, 120);
            logger.warn(`Slow query (${duration}ms): ${preview}${query.length > 120 ? '…' : ''}`);
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

const dns = require('dns').promises;

/**
 * Lookup server location from IP address using free ip-api.com service
 * @param {string} url - The server URL
 * @returns {Promise<{country: string, city: string} | null>}
 */
async function lookupServerLocation(url) {
    try {
        const urlObj = new URL(url.startsWith('http') ? url : `http://${url}`);
        let hostname = urlObj.hostname;

        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        let ip = hostname;

        if (!ipRegex.test(hostname)) {
            try {
                const addresses = await dns.resolve4(hostname);
                if (addresses && addresses.length > 0) {
                    ip = addresses[0];
                }
            } catch (dnsError) {
                logger.warn(`DNS lookup failed for ${hostname}: ${dnsError.message}`);
                return null;
            }
        }

        const axios = require('axios');
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,city`, {
            timeout: 5000
        });

        if (response.data && response.data.status === 'success') {
            return {
                country: response.data.country || null,
                city: response.data.city || null
            };
        }
        return null;
    } catch (error) {
        logger.warn(`Failed to lookup server location: ${error.message}`);
        return null;
    }
}

async function saveSource(sourceData) {
    // Remove id if present - we use database-generated IDs only
    const { id, ...cleanSourceData } = sourceData;

    const {
        user_id, session_id, name, type, url, username, password, mac_address,
        exp_date, max_connections, active_connections, account_status, is_trial, account_created_at
    } = cleanSourceData;

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
        // Insert new source - lookup server location first
        let server_country = null;
        let server_city = null;

        if (url) {
            try {
                const location = await lookupServerLocation(url);
                if (location) {
                    server_country = location.country;
                    server_city = location.city;
                    logger.info(`Found server location for new source: ${server_city}, ${server_country}`);
                }
            } catch (locErr) {
                logger.warn(`Location lookup failed for new source: ${locErr.message}`);
            }
        }

        const insertQuery = `
            INSERT INTO iptv_sources (
                user_id, session_id, name, type, url, username, password, mac_address,
                exp_date, max_connections, active_connections, account_status, is_trial, account_created_at,
                server_country, server_city
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING *
        `;
        const result = await queryWithRetry(insertQuery, [
            user_id, session_id, name, type, url, username, password, mac_address,
            exp_date, max_connections, active_connections, account_status, is_trial, account_created_at,
            server_country, server_city
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

/**
 * Save channels for a source.
 *
 * @param {Array}    channels  Channel objects to save.
 * @param {number}   sourceId  Source row id.
 * @param {Object}   [options]
 * @param {Function} [options.isCancelled]
 *   Predicate called between batches. When it returns true, saveChannels
 *   stops issuing more INSERTs and returns whatever it managed to save
 *   so far. Used by the refresh route to honor a Cancel click — the
 *   in-flight INSERT batch finishes (Postgres owns that, we can't kill
 *   a statement mid-flight) but the loop won't fire the remaining ~99
 *   batches. For a 54k-channel provider that's the difference between
 *   "cancelled but still chewing for 10 more minutes" and "stops within
 *   the next 2-5 seconds".
 */
async function saveChannels(channels, sourceId, options = {}) {
    const isCancelled = typeof options.isCancelled === 'function'
        ? options.isCancelled
        : () => false;
    // Optional progress callback so long-running INSERT loops can
    // tell the SSE pipe / log stream how far they've gotten. Default
    // is a no-op. The previous code logged once at the very end,
    // which left the user staring at a "Saving to database…" UI for
    // 5+ minutes with zero feedback — even the backend logs went
    // silent during the loop, so there was no way to tell if it was
    // working or hung.
    const onProgress = typeof options.onProgress === 'function'
        ? options.onProgress
        : () => {};

    if (!channels || channels.length === 0) {
        return { saved: 0 };
    }

    // Deduplicate channels by ID (in case the source API returns
    // duplicates, which it occasionally does for category overlaps).
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

    const total = uniqueChannels.length;
    // Chunk size for the UNNEST-based INSERT. This isn't a Postgres
    // parameter-limit constraint (UNNEST passes each column as one
    // array param, so we could fit the whole 50k catalog in one
    // statement), but smaller chunks keep memory bounded and let us
    // honor the cancellation probe between chunks. 10k rows × 14 cols
    // is ~140k array slots in memory — plenty fast.
    const CHUNK = 10000;
    const totalChunks = Math.ceil(total / CHUNK) || 1;
    let savedCount = 0;
    const saveStartedAt = Date.now();

    logger.info(
        `[saveChannels] Source ${sourceId}: bulk-replacing ${total} channels in ${totalChunks} chunk(s) of up to ${CHUNK}`
    );

    // Atomic DELETE + INSERT inside a single transaction. The previous
    // implementation did the DELETE outside the loop, then ran 100+
    // separate INSERTs each with its own ON CONFLICT clause that was
    // dead code (post-DELETE, nothing conflicts) and forced index
    // maintenance to repeat per batch. A 51k-channel save took 25 min.
    //
    // The new path:
    //   * One DELETE
    //   * One INSERT per chunk via UNNEST(arrays) — Postgres' set-based
    //     bulk path. Each chunk is a single SQL statement with 14 array
    //     params regardless of row count.
    //   * Wrapped in a single transaction so a refresh either fully
    //     replaces the source's channels or leaves the previous data
    //     intact (no half-loaded states for concurrent readers).
    //   * No ON CONFLICT — the DELETE guarantees no rows exist.
    // List of "fat" text indexes on iptv_channels.name that are
    // dropped before the bulk INSERT and rebuilt after. These three
    // alone account for ~80% of per-row INSERT cost — GIN indexes
    // tokenize each name on every row, and we have two GINs plus a
    // btree on the same column. Drop+rebuild is dramatically faster
    // than per-row maintenance for >5k rows, and since it's all in
    // one transaction a failure rolls everything back (the indexes
    // are never lost). Other queries against iptv_channels block on
    // the table's AccessExclusiveLock during the txn — acceptable
    // for a refresh that already does a wholesale source replacement.
    const FAT_INDEXES = [
        {
            name: 'idx_iptv_channels_name',
            create: "CREATE INDEX idx_iptv_channels_name ON iptv_channels USING gin (to_tsvector('english', name))"
        },
        {
            name: 'idx_iptv_channels_name_btree',
            create: 'CREATE INDEX idx_iptv_channels_name_btree ON iptv_channels USING btree (name)'
        },
        {
            name: 'idx_iptv_channels_name_trgm',
            create: 'CREATE INDEX idx_iptv_channels_name_trgm ON iptv_channels USING gin (name gin_trgm_ops)'
        }
    ];

    let cancelled = false;
    try {
        await transaction(async (client) => {
            await client.query('DELETE FROM iptv_channels WHERE source_id = $1', [sourceId]);

            // Skip the drop+rebuild dance for small saves — for <5k
            // rows the per-row index cost is negligible and the
            // rebuild adds latency that dwarfs the win.
            const useIndexBulkPath = total >= 5000;
            if (useIndexBulkPath) {
                const dropStart = Date.now();
                for (const idx of FAT_INDEXES) {
                    await client.query(`DROP INDEX IF EXISTS ${idx.name}`);
                }
                logger.info(
                    `[saveChannels] Source ${sourceId}: dropped 3 name indexes for bulk path (${Date.now() - dropStart}ms)`
                );
            }

            for (let i = 0; i < total; i += CHUNK) {
                if (isCancelled()) {
                    cancelled = true;
                    throw new Error('__SAVE_CHANNELS_CANCELLED__');
                }
                const chunk = uniqueChannels.slice(i, i + CHUNK);

                // Build one column-array per field; UNNEST zips them
                // back into rows server-side. Empty-string default
                // matches the previous insert behavior so search/EPG
                // queries that filter on `tvg_id <> ''` etc. stay happy.
                const channelIds = new Array(chunk.length);
                const names = new Array(chunk.length);
                const urls = new Array(chunk.length);
                const logos = new Array(chunk.length);
                const categories = new Array(chunk.length);
                const tvgIds = new Array(chunk.length);
                const tvgNames = new Array(chunk.length);
                const groupTitles = new Array(chunk.length);
                const sourceTypes = new Array(chunk.length);
                const sourceUsernames = new Array(chunk.length);
                const sourcePasswords = new Array(chunk.length);
                const sourceUrls = new Array(chunk.length);
                const sourceMacs = new Array(chunk.length);

                for (let j = 0; j < chunk.length; j++) {
                    const c = chunk[j];
                    const groupTitle = c.groupTitle || c.group_title || '';
                    channelIds[j] = c.id;
                    names[j] = c.name;
                    urls[j] = c.url;
                    logos[j] = c.logo;
                    categories[j] = c.category || groupTitle;
                    tvgIds[j] = c.tvgId || c.tvg_id || '';
                    tvgNames[j] = c.tvgName || c.tvg_name || c.name || '';
                    groupTitles[j] = groupTitle;
                    sourceTypes[j] = c.source_type;
                    sourceUsernames[j] = c.source_username;
                    sourcePasswords[j] = c.source_password;
                    sourceUrls[j] = c.source_url;
                    sourceMacs[j] = c.source_mac;
                }

                // The INSERT column order matches the SELECT output
                // order — source_id sits at the end of both rather
                // than in its on-disk position so the SELECT can just
                // be `*, $sourceId` without per-row interleaving.
                await client.query(
                    `INSERT INTO iptv_channels (
                        channel_id, name, stream_url, logo_url, category,
                        tvg_id, tvg_name, group_title, source_type, source_username,
                        source_password, source_url, source_mac, source_id
                    )
                    SELECT *, $14::int FROM UNNEST(
                        $1::text[],  $2::text[],  $3::text[],  $4::text[],  $5::text[],
                        $6::text[],  $7::text[],  $8::text[],  $9::text[],  $10::text[],
                        $11::text[], $12::text[], $13::text[]
                    ) AS t (
                        channel_id, name, stream_url, logo_url, category,
                        tvg_id, tvg_name, group_title, source_type, source_username,
                        source_password, source_url, source_mac
                    )`,
                    [
                        channelIds, names, urls, logos, categories,
                        tvgIds, tvgNames, groupTitles, sourceTypes, sourceUsernames,
                        sourcePasswords, sourceUrls, sourceMacs,
                        sourceId
                    ]
                );

                savedCount += chunk.length;
                const pct = Math.floor((savedCount / total) * 100);
                const elapsedSec = ((Date.now() - saveStartedAt) / 1000).toFixed(1);
                const batchNumber = Math.ceil(savedCount / CHUNK);
                logger.info(
                    `[saveChannels] Source ${sourceId}: ${savedCount}/${total} (${pct}%, ${elapsedSec}s)`
                );
                onProgress({ saved: savedCount, total, batchNumber, totalBatches: totalChunks });
            }

            // Rebuild the indexes we dropped above. CREATE INDEX inside
            // a transaction is allowed (non-CONCURRENTLY) and runs as
            // a single bulk operation rather than per-row maintenance.
            // Bumping maintenance_work_mem locally lets GIN sort more
            // tuples in memory rather than spilling to temp files —
            // typically halves the rebuild time on a multi-hundred-MB
            // table.
            if (useIndexBulkPath) {
                const rebuildStart = Date.now();
                await client.query("SET LOCAL maintenance_work_mem = '512MB'");
                for (const idx of FAT_INDEXES) {
                    await client.query(idx.create);
                }
                logger.info(
                    `[saveChannels] Source ${sourceId}: rebuilt 3 name indexes (${Date.now() - rebuildStart}ms)`
                );
            }
        });
    } catch (err) {
        if (cancelled) {
            logger.info(`[saveChannels] Source ${sourceId}: cancelled — transaction rolled back`);
            return { saved: 0, cancelled: true };
        }
        throw err;
    }

    // Update the source row to reflect this successful load. Stamping
    // the refresh-status fields here matters for the MyIPTVs page's
    // "Last refresh" column — bulk-added sources used to leave these
    // fields null even though the load completed cleanly, so the UI
    // showed "—" for every just-imported source. By writing them at
    // the lowest level (every load path bottoms out here), every
    // single-source / bulk / xtream / stalker code path gets proper
    // provenance for free.
    await queryWithRetry(
        `UPDATE iptv_sources
            SET channel_count            = $1,
                last_refresh_attempt     = CURRENT_TIMESTAMP,
                last_successful_refresh  = CURRENT_TIMESTAMP,
                last_refresh_status      = 'success',
                last_refresh_error       = NULL,
                failure_count            = 0
          WHERE id = $2`,
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

/**
 * Get alternate feeds for a channel across a user's active sources.
 * Used by FeedSelector to surface other providers that carry the
 * same channel so the user can pick a working stream when one fails.
 *
 * @param {number} userId        Owning user id (scopes the query).
 * @param {string} channelName   Channel name to match (case-insensitive).
 * @param {string} [tvgId]       Optional EPG channel id; widens the
 *                                match to include any source that
 *                                tags the channel with the same tvg_id.
 */
async function getAlternateFeeds(userId, channelName, tvgId = null) {
    if (!userId || !channelName) return [];

    const params = [userId, channelName];
    const tvgClause = tvgId
        ? (params.push(tvgId), 'OR c.tvg_id = $3')
        : '';

    const query = `
        SELECT
            c.id,
            c.channel_id,
            c.name,
            c.logo_url      AS logo,
            c.stream_url    AS url,
            c.group_title,
            c.tvg_id        AS epg_channel_id,
            s.id            AS source_id,
            s.name          AS source_name,
            s.type          AS source_type,
            p.priority,
            p.nickname      AS source_nickname,
            p.is_active
        FROM iptv_channels c
        JOIN iptv_sources s             ON c.source_id = s.id
        JOIN user_iptv_preferences p    ON s.id = p.source_id
        WHERE p.user_id = $1
          AND p.is_active = TRUE
          AND (LOWER(c.name) = LOWER($2) ${tvgClause})
        ORDER BY p.priority ASC, s.name ASC
    `;

    const result = await queryWithRetry(query, params);
    return result.rows.map((row) => ({
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
            isActive: row.is_active === true
        }
    }));
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
    lookupServerLocation,

    // Channels
    saveChannels,
    getChannelsForSession,
    getChannelById,
    getAlternateFeeds,

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
