/**
 * Redis Service
 * Handles sessions, EPG caching, and rate limiting
 */

const Redis = require('ioredis');
const zlib = require('zlib');
const { promisify } = require('util');
const logger = require('../utils/logger');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Redis client configuration
const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms`);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    lazyConnect: false,
    connectTimeout: 10000,
    keepAlive: 30000
};

// Create Redis client
let redis;
if (process.env.REDIS_CLUSTER_ENABLED === 'true') {
    // Redis Cluster configuration for production
    const nodes = (process.env.REDIS_CLUSTER_NODES || 'localhost:6379').split(',').map(node => {
        const [host, port] = node.split(':');
        return { host, port: parseInt(port) || 6379 };
    });

    redis = new Redis.Cluster(nodes, {
        redisOptions: redisConfig,
        clusterRetryStrategy: (times) => {
            return Math.min(100 * times, 2000);
        }
    });
} else {
    // Single instance for development
    redis = new Redis(redisConfig);
}

// Event handlers
redis.on('connect', () => {
    logger.info('Redis client connected');
});

redis.on('ready', () => {
    logger.info('Redis client ready');
});

redis.on('error', (err) => {
    logger.error('Redis client error:', err);
});

redis.on('close', () => {
    logger.warn('Redis connection closed');
});

redis.on('reconnecting', () => {
    logger.info('Redis client reconnecting');
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Compress data before storing
 */
async function compress(data) {
    const json = JSON.stringify(data);
    const compressed = await gzip(json);
    return compressed.toString('base64');
}

/**
 * Decompress data after retrieving
 */
async function decompress(data) {
    const buffer = Buffer.from(data, 'base64');
    const decompressed = await gunzip(buffer);
    return JSON.parse(decompressed.toString());
}

/**
 * Generate cache key
 */
function getCacheKey(type, id) {
    return `${type}:${id}`;
}

// ============================================================================
// Session Management
// ============================================================================

const SESSION_TTL = parseInt(process.env.SESSION_TTL) || 604800; // 7 days

/**
 * Save session data
 * @param {string} sessionId - Session identifier
 * @param {Object} data - Session data
 * @param {number} ttl - Time to live in seconds (default: 7 days)
 */
async function saveSession(sessionId, data, ttl = SESSION_TTL) {
    const key = getCacheKey('session', sessionId);

    try {
        // Store as hash for efficient field updates
        await redis.hset(key, {
            channels: JSON.stringify(data.channels || []),
            categories: JSON.stringify(data.categories || []),
            epgSources: JSON.stringify(data.epgSources || []),
            createdAt: data.createdAt || Date.now(),
            lastAccessed: Date.now(),
            userId: data.userId || ''
        });

        await redis.expire(key, ttl);

        logger.debug(`Session saved: ${sessionId}`);
        return true;
    } catch (error) {
        logger.error('Error saving session:', error);
        throw error;
    }
}

/**
 * Get session data
 * @param {string} sessionId - Session identifier
 */
async function getSession(sessionId) {
    const key = getCacheKey('session', sessionId);

    try {
        const data = await redis.hgetall(key);

        if (!data || Object.keys(data).length === 0) {
            return null;
        }

        // Refresh TTL on access
        await redis.expire(key, SESSION_TTL);

        // Update last accessed
        await redis.hset(key, 'lastAccessed', Date.now());

        return {
            channels: JSON.parse(data.channels || '[]'),
            categories: JSON.parse(data.categories || '[]'),
            epgSources: JSON.parse(data.epgSources || '[]'),
            createdAt: parseInt(data.createdAt),
            lastAccessed: parseInt(data.lastAccessed),
            userId: data.userId || null
        };
    } catch (error) {
        logger.error('Error getting session:', error);
        return null;
    }
}

/**
 * Update session field
 * @param {string} sessionId - Session identifier
 * @param {string} field - Field name
 * @param {any} value - Field value
 */
async function updateSessionField(sessionId, field, value) {
    const key = getCacheKey('session', sessionId);

    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : value;
        await redis.hset(key, field, serialized);
        await redis.hset(key, 'lastAccessed', Date.now());
        await redis.expire(key, SESSION_TTL);
        return true;
    } catch (error) {
        logger.error('Error updating session field:', error);
        throw error;
    }
}

/**
 * Delete session
 * @param {string} sessionId - Session identifier
 */
async function deleteSession(sessionId) {
    const key = getCacheKey('session', sessionId);

    try {
        await redis.del(key);
        logger.debug(`Session deleted: ${sessionId}`);
        return true;
    } catch (error) {
        logger.error('Error deleting session:', error);
        throw error;
    }
}

/**
 * Get all active sessions
 */
async function getAllSessions() {
    try {
        const keys = await redis.keys('session:*');
        const sessions = [];

        for (const key of keys) {
            const sessionId = key.replace('session:', '');
            const data = await getSession(sessionId);
            if (data) {
                sessions.push({ sessionId, ...data });
            }
        }

        return sessions;
    } catch (error) {
        logger.error('Error getting all sessions:', error);
        return [];
    }
}

// ============================================================================
// EPG Cache Management
// ============================================================================

const EPG_CACHE_TTL = 86400; // 24 hours

/**
 * Save EPG source data
 * @param {string} sourceName - EPG source name
 * @param {Object} data - EPG data (channels and programs)
 */
async function saveEpgCache(sourceName, data) {
    const key = getCacheKey('epg:source', sourceName);

    try {
        // Compress large EPG data
        const compressed = await compress(data);

        await redis.hset(key, {
            data: compressed,
            channelCount: data.channels?.length || 0,
            programCount: data.programs?.length || 0,
            lastUpdate: Date.now()
        });

        await redis.expire(key, EPG_CACHE_TTL);

        logger.info(`EPG cache saved: ${sourceName} (${data.channels?.length || 0} channels, ${data.programs?.length || 0} programs)`);
        return true;
    } catch (error) {
        logger.error('Error saving EPG cache:', error);
        throw error;
    }
}

/**
 * Get EPG source data
 * @param {string} sourceName - EPG source name
 */
async function getEpgCache(sourceName) {
    const key = getCacheKey('epg:source', sourceName);

    try {
        const cached = await redis.hgetall(key);

        if (!cached || !cached.data) {
            return null;
        }

        // Decompress data
        const data = await decompress(cached.data);

        return {
            ...data,
            metadata: {
                channelCount: parseInt(cached.channelCount),
                programCount: parseInt(cached.programCount),
                lastUpdate: parseInt(cached.lastUpdate)
            }
        };
    } catch (error) {
        logger.error('Error getting EPG cache:', error);
        return null;
    }
}

/**
 * Check if EPG cache is valid
 * @param {string} sourceName - EPG source name
 * @param {number} maxAge - Maximum age in seconds
 */
async function isEpgCacheValid(sourceName, maxAge = EPG_CACHE_TTL) {
    const key = getCacheKey('epg:source', sourceName);

    try {
        const lastUpdate = await redis.hget(key, 'lastUpdate');

        if (!lastUpdate) {
            return false;
        }

        const age = (Date.now() - parseInt(lastUpdate)) / 1000;
        return age < maxAge;
    } catch (error) {
        logger.error('Error checking EPG cache validity:', error);
        return false;
    }
}

/**
 * Delete EPG cache
 * @param {string} sourceName - EPG source name
 */
async function deleteEpgCache(sourceName) {
    const key = getCacheKey('epg:source', sourceName);

    try {
        await redis.del(key);
        logger.debug(`EPG cache deleted: ${sourceName}`);
        return true;
    } catch (error) {
        logger.error('Error deleting EPG cache:', error);
        throw error;
    }
}

/**
 * Get all EPG source names in cache
 */
async function getAllEpgSources() {
    try {
        const keys = await redis.keys('epg:source:*');
        return keys.map(key => key.replace('epg:source:', ''));
    } catch (error) {
        logger.error('Error getting all EPG sources:', error);
        return [];
    }
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check and increment rate limit
 * @param {string} key - Rate limit key (e.g., IP address or user ID)
 * @param {number} limit - Maximum requests allowed
 * @param {number} window - Time window in seconds
 * @returns {Object} - { allowed: boolean, current: number, remaining: number, resetAt: number }
 */
async function checkRateLimit(key, limit = 100, window = 900) { // Default: 100 req / 15 min
    const rateLimitKey = getCacheKey('ratelimit', key);

    try {
        const current = await redis.incr(rateLimitKey);

        if (current === 1) {
            // First request, set expiration
            await redis.expire(rateLimitKey, window);
        }

        const ttl = await redis.ttl(rateLimitKey);
        const resetAt = Date.now() + (ttl * 1000);

        return {
            allowed: current <= limit,
            current,
            remaining: Math.max(0, limit - current),
            resetAt
        };
    } catch (error) {
        logger.error('Error checking rate limit:', error);
        // On error, allow the request
        return { allowed: true, current: 0, remaining: limit, resetAt: Date.now() + window * 1000 };
    }
}

/**
 * Reset rate limit for a key
 * @param {string} key - Rate limit key
 */
async function resetRateLimit(key) {
    const rateLimitKey = getCacheKey('ratelimit', key);
    await redis.del(rateLimitKey);
}

// ============================================================================
// SSE (Server-Sent Events) Client Tracking
// ============================================================================

/**
 * Add SSE client to session
 * @param {string} sessionId - Session identifier
 * @param {string} clientId - Client identifier
 */
async function addSseClient(sessionId, clientId) {
    const key = getCacheKey('sse:session', sessionId);

    try {
        await redis.sadd(key, clientId);
        await redis.expire(key, 3600); // 1 hour TTL
        return true;
    } catch (error) {
        logger.error('Error adding SSE client:', error);
        throw error;
    }
}

/**
 * Remove SSE client from session
 * @param {string} sessionId - Session identifier
 * @param {string} clientId - Client identifier
 */
async function removeSseClient(sessionId, clientId) {
    const key = getCacheKey('sse:session', sessionId);

    try {
        await redis.srem(key, clientId);
        return true;
    } catch (error) {
        logger.error('Error removing SSE client:', error);
        throw error;
    }
}

/**
 * Get all SSE clients for a session
 * @param {string} sessionId - Session identifier
 */
async function getSseClients(sessionId) {
    const key = getCacheKey('sse:session', sessionId);

    try {
        return await redis.smembers(key);
    } catch (error) {
        logger.error('Error getting SSE clients:', error);
        return [];
    }
}

// ============================================================================
// General Cache Operations
// ============================================================================

/**
 * Set cache value
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttl - Time to live in seconds
 */
async function set(key, value, ttl = 3600) {
    try {
        const serialized = JSON.stringify(value);
        if (ttl) {
            await redis.setex(key, ttl, serialized);
        } else {
            await redis.set(key, serialized);
        }
        return true;
    } catch (error) {
        logger.error('Error setting cache:', error);
        throw error;
    }
}

/**
 * Get cache value
 * @param {string} key - Cache key
 */
async function get(key) {
    try {
        const value = await redis.get(key);
        return value ? JSON.parse(value) : null;
    } catch (error) {
        logger.error('Error getting cache:', error);
        return null;
    }
}

/**
 * Delete cache value
 * @param {string} key - Cache key
 */
async function del(key) {
    try {
        await redis.del(key);
        return true;
    } catch (error) {
        logger.error('Error deleting cache:', error);
        throw error;
    }
}

/**
 * Health check
 */
async function healthCheck() {
    try {
        await redis.ping();
        const info = await redis.info('server');
        return {
            status: 'healthy',
            info: info.split('\n').reduce((acc, line) => {
                const [key, value] = line.split(':');
                if (key && value) acc[key.trim()] = value.trim();
                return acc;
            }, {})
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            error: error.message
        };
    }
}

/**
 * Close Redis connection
 */
async function close() {
    await redis.quit();
    logger.info('Redis connection closed');
}

// Export all functions
module.exports = {
    // Core
    redis,
    healthCheck,
    close,

    // Sessions
    saveSession,
    getSession,
    updateSessionField,
    deleteSession,
    getAllSessions,

    // EPG Cache
    saveEpgCache,
    getEpgCache,
    isEpgCacheValid,
    deleteEpgCache,
    getAllEpgSources,

    // Rate Limiting
    checkRateLimit,
    resetRateLimit,

    // SSE Clients
    addSseClient,
    removeSseClient,
    getSseClients,

    // General Cache
    set,
    get,
    del
};
