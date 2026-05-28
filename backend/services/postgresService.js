/**
 * PostgreSQL Database Service
 * Replaces iptvDatabaseService.js for production scalability
 */

const { Pool } = require('pg');
// pg-copy-streams is maintained by the node-postgres author; provides
// the COPY FROM / TO streaming interface that node-pg itself doesn't
// expose. Used by saveChannels for bulk-loading channel rows into a
// source's partition — the fastest Postgres ingest path.
const { from: copyFrom } = require('pg-copy-streams');
const { tabEscape, streamRowsToCopy } = require('../utils/pgCopyHelpers');
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
        const newSource = result.rows[0];
        // Provision the iptv_channels partition for this source so
        // the first saveChannels can TRUNCATE+COPY into it directly
        // rather than landing rows in the DEFAULT partition.
        try {
            await ensureChannelsPartition(newSource.id);
        } catch (e) {
            logger.warn(`[saveSource] failed to provision partition for new source ${newSource.id}: ${e.message}`);
        }
        return newSource;
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
    const ok = result.rowCount > 0;
    // Drop the iptv_channels partition for this source. CASCADE on
    // the FK already removed the rows; this removes the now-empty
    // partition table so we don't accumulate orphan partitions.
    if (ok) {
        try {
            await dropChannelsPartition(sourceId);
        } catch (e) {
            logger.warn(`[deleteSource] failed to drop partition for source ${sourceId}: ${e.message}`);
        }
    }
    return ok;
}

// ============================================================================
// iptv_channels partition lifecycle
//
// iptv_channels is LIST-partitioned by source_id (migration 032).
// Every IPTV source gets its own partition, which enables:
//   - TRUNCATE ... ONLY  for instant per-source wipe (no dead tuples)
//   - COPY into partition for the fastest bulk-insert path
//   - per-source lock scope: refreshing source A can't block reads
//     of source B
//
// The app is responsible for creating/dropping partitions alongside
// iptv_sources rows. A DEFAULT partition catches any source_id that
// somehow gets inserted before a partition is provisioned.
// ============================================================================

async function ensureChannelsPartition(sourceId) {
    const id = parseInt(sourceId, 10);
    if (!Number.isFinite(id)) {
        throw new Error(`ensureChannelsPartition: invalid sourceId ${sourceId}`);
    }
    const partitionName = `iptv_channels_p_${id}`;
    // CREATE TABLE IF NOT EXISTS doesn't work with PARTITION OF, so
    // we check the catalog first.
    const exists = await queryWithRetry(
        `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
        [partitionName]
    );
    if (exists.rows.length > 0) return partitionName;
    // sourceId is a sanitized integer (parseInt above), so direct
    // interpolation is safe; LIST partition values can't be supplied
    // as bind parameters.
    await queryWithRetry(
        `CREATE TABLE ${partitionName} PARTITION OF iptv_channels FOR VALUES IN (${id})`
    );
    logger.info(`Created partition ${partitionName} for source ${id}`);
    return partitionName;
}

async function dropChannelsPartition(sourceId) {
    const id = parseInt(sourceId, 10);
    if (!Number.isFinite(id)) return;
    const partitionName = `iptv_channels_p_${id}`;
    // DROP TABLE IF EXISTS — safe whether or not the partition was
    // ever created (e.g. a source that was added but never refreshed).
    await queryWithRetry(`DROP TABLE IF EXISTS ${partitionName}`);
    // Mirror the cleanup into the search shadow (migration 033). The
    // shadow has no FK to iptv_sources so the rows would otherwise
    // become orphaned and pollute future search results.
    try {
        await queryWithRetry(
            `DELETE FROM iptv_channels_search WHERE source_id = $1`,
            [id]
        );
    } catch (e) {
        logger.warn(`[dropChannelsPartition] failed to purge search shadow for source ${id}: ${e.message}`);
    }
}

// ============================================================================
// Channel Operations
// ============================================================================

// Global saveChannels semaphore. Each refresh borrows a client and
// holds it for tens of seconds during the COPY + index build. Without
// a cap, a bulk-refresh of 75 sources across many hosts saturates the
// pool — user-facing queries time out with "timeout exceeded when
// trying to connect" because the pool can't hand out a free client.
//
// MAX_CONCURRENT_SAVES=1 — fully serialised. Empirically, two
// concurrent saves (each TRUNCATE-then-COPY into a per-source
// partition) didn't conflict on locks directly but DID saturate
// Postgres' WAL fsync queue. A clean save is ~3-5 s; with two
// running plus VOD UPSERTs in the background, saves stretched to
// 50-135 s. Going sequential keeps each save snappy and the UI
// reads (series listings, source health) responsive. Total bulk
// time is barely worse — 75 sources × 5 s ≈ 6 min instead of 4 min
// at parallel-2, and the user perceives each completion instantly
// instead of waiting two-at-a-time.
const MAX_CONCURRENT_SAVES = 1;
let _activeSaves = 0;
const _saveWaiters = [];
async function _acquireSaveSlot() {
    if (_activeSaves < MAX_CONCURRENT_SAVES) {
        _activeSaves += 1;
        return;
    }
    await new Promise((resolve) => _saveWaiters.push(resolve));
    _activeSaves += 1;
}
function _releaseSaveSlot() {
    _activeSaves = Math.max(0, _activeSaves - 1);
    const next = _saveWaiters.shift();
    if (next) next();
}

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
    const onProgress = typeof options.onProgress === 'function'
        ? options.onProgress
        : () => {};

    if (!channels || channels.length === 0) {
        return { saved: 0 };
    }

    // Wait for an open save slot before grabbing a pool client. This
    // is what keeps the pool from being exhausted during bulk refresh
    // — see MAX_CONCURRENT_SAVES at the top of this section. The
    // semaphore wraps the entire save (so the client lifetime is
    // serialised, not just queue-on-pool which can deadlock).
    const _saveWaitStart = Date.now();
    await _acquireSaveSlot();
    if (Date.now() - _saveWaitStart > 100) {
        logger.info(`[saveChannels] Source ${sourceId}: waited ${Date.now() - _saveWaitStart}ms for save slot (active=${_activeSaves}, max=${MAX_CONCURRENT_SAVES})`);
    }
    try {
        return await _saveChannelsInner(channels, sourceId, options, isCancelled, onProgress);
    } finally {
        _releaseSaveSlot();
    }
}

async function _saveChannelsInner(channels, sourceId, options, isCancelled, onProgress) {
    if (!channels || channels.length === 0) {
        return { saved: 0 };
    }

    // Deduplicate channels by id (the source API occasionally returns
    // duplicates when a channel sits in multiple provider categories).
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
    const saveStartedAt = Date.now();

    // Strategy (post-migration 032):
    //   * iptv_channels is LIST-partitioned by source_id. Each source
    //     gets its own partition table iptv_channels_p_<id>.
    //   * Refresh becomes TRUNCATE the partition (instant, no dead
    //     tuples) then COPY the new rows into it (Postgres' fastest
    //     bulk-insert path, ~1.7x faster than UNNEST INSERT, ~8x
    //     faster than multi-VALUES INSERT per Tiger Data benchmarks).
    //   * AccessExclusiveLock is scoped to this partition only —
    //     refreshing one source does NOT block reads of other sources.
    //   * No global index drop/rebuild needed; the partition's
    //     indexes were emptied by TRUNCATE so re-populating them via
    //     COPY runs at full speed.
    //
    // The whole flow is one transaction so a refresh either fully
    // replaces the source's channels or leaves the previous data
    // intact. No half-loaded states.
    await ensureChannelsPartition(sourceId);
    const partitionName = `iptv_channels_p_${parseInt(sourceId, 10)}`;

    if (isCancelled()) return { saved: 0, cancelled: true };

    const client = await pool.connect();
    let savedCount = 0;
    try {
        await client.query('BEGIN');
        await client.query(`TRUNCATE TABLE ${partitionName}`);

        // Pump GIN bulk-load knobs for this transaction. We can't
        // drop the partition's GIN indexes (their parent partitioned
        // index — idx_iptv_channels_name_trgm / idx_iptv_channels_name
        // — owns them and rejects the DROP) so instead we lean on
        // GIN's pending-list mechanism: with fastupdate=on (default),
        // every insert lands in a small TID-list buffer and only
        // gets folded into the main GIN structure when the buffer
        // fills. The default 4MB limit triggers a flush every
        // ~25k rows of trgm tokens — way too often for a 50k-row
        // COPY. Cranking the limit lets the entire COPY accumulate
        // into the pending list, and we explicitly flush once at
        // the end via gin_clean_pending_list().
        //
        // maintenance_work_mem also bumps because the flush itself
        // benefits from more sort space, and any incidental index
        // operations in this txn get the same headroom.
        await client.query(`SET LOCAL maintenance_work_mem = '512MB'`);
        await client.query(`SET LOCAL gin_pending_list_limit = '256MB'`);

        const trgmIdxName    = `${partitionName}_name_idx1`;
        const tsvectorIdxName = `${partitionName}_to_tsvector_idx`;

        // COPY uses text format with tab delimiter and \N as the NULL
        // marker. FREEZE eligibility: TRUNCATE-then-COPY in the same
        // transaction satisfies the "table created or truncated in
        // current subtransaction" rule, so the rows are written
        // pre-frozen — no WAL for the data itself (only catalog +
        // visibility map), and no first-VACUUM cost later to mark
        // all-visible.
        const copyStream = client.query(copyFrom(
            `COPY ${partitionName} (
                channel_id, source_id, name, stream_url, logo_url, category,
                tvg_id, tvg_name, group_title, source_type, source_username,
                source_password, source_url, source_mac
            ) FROM STDIN WITH (FORMAT text, FREEZE)`
        ));

        // Stream rows via the shared crash-safe helper. It handles
        // pg-copy-streams' mid-COPY-error race (the
        // "Cannot read properties of null (reading 'stream')"
        // crash that hit us in vodIngest) and bounds the per-write
        // listener count so giant saves don't trip
        // MaxListenersExceededWarning.
        const sourceIdStr = String(parseInt(sourceId, 10));
        let progressIdx = 0;
        const toCopyRow = (c) => {
            // Bump progress + cancellation check on every row pulled
            // from the iterator. This stays inside the helper's
            // backpressure-aware loop so the COPY can pause cleanly.
            if (isCancelled()) {
                throw new Error('__SAVE_CHANNELS_CANCELLED__');
            }
            progressIdx += 1;
            if (progressIdx % 5000 === 0) {
                const pct = Math.floor((progressIdx / total) * 100);
                const elapsedSec = ((Date.now() - saveStartedAt) / 1000).toFixed(1);
                logger.info(
                    `[saveChannels] Source ${sourceId}: ${progressIdx}/${total} (${pct}%, ${elapsedSec}s)`
                );
                onProgress({ saved: progressIdx, total });
            }
            const groupTitle = c.groupTitle || c.group_title || '';
            return [
                c.id,
                sourceIdStr,
                c.name,
                c.url,
                c.logo,
                c.category || groupTitle,
                c.tvgId || c.tvg_id || '',
                c.tvgName || c.tvg_name || c.name || '',
                groupTitle,
                c.source_type,
                c.source_username,
                c.source_password,
                c.source_url,
                c.source_mac
            ].map(tabEscape).join('\t') + '\n';
        };

        await streamRowsToCopy(copyStream, uniqueChannels, toCopyRow);
        savedCount = total;

        // Sync the search shadow (migration 033) inside the same
        // transaction so the visible state always matches:
        // partition rows ↔ shadow rows. DELETE+INSERT (rather than
        // UPSERT) is the simplest correct path because the partition
        // was just TRUNCATEd above — there are no stale rows to merge
        // around. INSERT-SELECT from the partition keeps the data
        // exactly aligned even if we add or drop columns later, and
        // runs entirely server-side (no second COPY stream from
        // Node).
        await client.query(
            `DELETE FROM iptv_channels_search WHERE source_id = $1`,
            [sourceId]
        );
        await client.query(
            `INSERT INTO iptv_channels_search
                 (source_id, channel_id, user_id, name, logo_url, stream_url, tvg_id, group_title)
             SELECT c.source_id, c.channel_id, s.user_id, c.name, c.logo_url, c.stream_url,
                    c.tvg_id, c.group_title
               FROM ${partitionName} c
               JOIN iptv_sources s ON s.id = c.source_id`
        );

        // Flush the GIN pending list once for each partition GIN
        // index. All the COPY inserts have been queued into the
        // per-index pending list (because gin_pending_list_limit was
        // bumped to 256MB above) — gin_clean_pending_list folds them
        // into the main GIN structure in a single batched pass, which
        // is materially faster than the dribble of small flushes
        // that would have happened with the 4MB default limit.
        //
        // If the indexes don't exist on this partition for some
        // reason (older schema, custom drop), the to_regclass guard
        // means we just skip the flush rather than erroring the
        // transaction.
        await client.query(
            `SELECT gin_clean_pending_list(c.oid)
               FROM pg_class c
              WHERE c.relkind = 'i'
                AND c.relname IN ($1, $2)`,
            [trgmIdxName, tsvectorIdxName]
        );

        // Update the source row's refresh stats inside the same
        // transaction so it commits atomically with the channel data.
        await client.query(
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

        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        if (err && err.message === '__SAVE_CHANNELS_CANCELLED__') {
            logger.info(`[saveChannels] Source ${sourceId}: cancelled — transaction rolled back`);
            return { saved: 0, cancelled: true };
        }
        throw err;
    } finally {
        client.release();
    }

    const elapsedSec = ((Date.now() - saveStartedAt) / 1000).toFixed(1);
    logger.info(
        `[saveChannels] Source ${sourceId}: ${savedCount} channels saved in ${elapsedSec}s via TRUNCATE+COPY`
    );
    onProgress({ saved: savedCount, total });
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
    ensureChannelsPartition,
    dropChannelsPartition,

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
