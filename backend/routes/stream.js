const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const { getSession } = require('../utils/storageUtils');
const logger = require('../config/logger');
const sessionStorage = require('../utils/session');
const iptvDatabaseService = require('../services/iptvDatabase');
const { PassThrough } = require('stream');
const { authMiddleware } = require('../middleware/authMiddleware');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const metricsService = require('../services/metricsService');

// ============================================================================
// RESILIENT STREAM PROXY WITH AUTOMATIC RETRY/RECONNECT
// ============================================================================
// This implements backend-level stream recovery so the frontend player doesn't
// need to handle reconnection logic. When a source stream fails, the proxy
// automatically attempts to reconnect without closing the HTTP response.
// ============================================================================

// Store active resilient stream connections for monitoring
const resilientStreams = new Map();

// ============================================================================
// STREAM REQUEST THROTTLING - Prevent rapid reconnection storms
// ============================================================================
// Track recent stream requests per channel to prevent connection flooding
const recentStreamRequests = new Map(); // channelId -> { timestamp, count, abortController }
const THROTTLE_WINDOW_MS = 3000;  // 3 second window
const MAX_REQUESTS_PER_WINDOW = 2; // Max 2 requests per channel in window
const COOLDOWN_AFTER_THROTTLE_MS = 5000; // 5 second cooldown if throttled

// ============================================================================
// CIRCUIT BREAKER - Stop trying unstable sources
// ============================================================================
// Track source failures to implement circuit breaker pattern
const sourceFailures = new Map(); // sourceUrl -> { failures, lastFailure, circuitOpen }
const CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 3,       // Open circuit after 3 failures
    resetTimeout: 30000,       // Try again after 30 seconds
    halfOpenRequests: 1,       // Allow 1 test request when half-open
};

// ============================================================================
// ACTIVE STREAM TRACKING - Prevent duplicate streams
// ============================================================================
// Track active streams per user/channel to prevent duplicates
const activeStreams = new Map(); // `${userId}_${channelId}` -> { controller, timestamp }

// Configuration for resilient streaming
const RESILIENT_CONFIG = {
    maxRetries: 3,              // Reduced from 5 - fail faster, let frontend decide
    initialRetryDelay: 1000,    // Start with 1 second delay
    maxRetryDelay: 4000,        // Reduced from 8s - don't wait too long
    backoffMultiplier: 1.5,     // Exponential backoff multiplier
    connectionTimeout: 10000,   // Reduced from 15s - fail faster
    healthCheckInterval: 15000, // Increased from 10s - less overhead
    staleDataThreshold: 20000,  // Reduced from 30s - detect stale streams faster
    maxStreamDuration: 4 * 60 * 60 * 1000, // 4 hour max stream duration
};

/**
 * Check if a stream request should be throttled
 * Returns { throttled: boolean, reason?: string }
 */
function checkStreamThrottle(channelId, userId) {
    const key = `${userId || 'anon'}_${channelId}`;
    const now = Date.now();
    const existing = recentStreamRequests.get(key);

    if (existing) {
        const timeSinceFirst = now - existing.firstRequestTime;

        // If we're in cooldown period, reject
        if (existing.cooldownUntil && now < existing.cooldownUntil) {
            const remainingMs = existing.cooldownUntil - now;
            return {
                throttled: true,
                reason: `Cooldown active (${Math.ceil(remainingMs/1000)}s remaining)`,
                remainingMs
            };
        }

        // If within throttle window, check count
        if (timeSinceFirst < THROTTLE_WINDOW_MS) {
            existing.count++;
            if (existing.count > MAX_REQUESTS_PER_WINDOW) {
                // Set cooldown
                existing.cooldownUntil = now + COOLDOWN_AFTER_THROTTLE_MS;
                logger.warn(`[THROTTLE] Too many requests for ${channelId} (${existing.count} in ${timeSinceFirst}ms), cooling down`);
                return {
                    throttled: true,
                    reason: `Too many requests (${existing.count} in ${Math.ceil(timeSinceFirst/1000)}s)`,
                    remainingMs: COOLDOWN_AFTER_THROTTLE_MS
                };
            }
        } else {
            // Window expired, reset
            existing.firstRequestTime = now;
            existing.count = 1;
            existing.cooldownUntil = null;
        }
    } else {
        // First request for this channel
        recentStreamRequests.set(key, {
            firstRequestTime: now,
            count: 1,
            cooldownUntil: null
        });
    }

    return { throttled: false };
}

/**
 * Check circuit breaker for a source URL
 * Returns { open: boolean, reason?: string }
 */
function checkCircuitBreaker(sourceUrl) {
    // Normalize URL to host level for circuit breaker
    let host;
    try {
        host = new URL(sourceUrl).host;
    } catch {
        return { open: false }; // Can't parse URL, let it through
    }

    const circuit = sourceFailures.get(host);
    if (!circuit) {
        return { open: false };
    }

    const now = Date.now();
    const timeSinceLastFailure = now - circuit.lastFailure;

    // If circuit is open and timeout hasn't passed, reject
    if (circuit.circuitOpen && timeSinceLastFailure < CIRCUIT_BREAKER_CONFIG.resetTimeout) {
        const remainingMs = CIRCUIT_BREAKER_CONFIG.resetTimeout - timeSinceLastFailure;
        return {
            open: true,
            reason: `Circuit open for ${host} (${Math.ceil(remainingMs/1000)}s until retry)`,
            remainingMs
        };
    }

    // If timeout passed, move to half-open state
    if (circuit.circuitOpen && timeSinceLastFailure >= CIRCUIT_BREAKER_CONFIG.resetTimeout) {
        circuit.circuitOpen = false;
        circuit.halfOpen = true;
        circuit.halfOpenRequests = 0;
        logger.info(`[CIRCUIT] Half-open for ${host}, allowing test request`);
    }

    return { open: false, halfOpen: circuit.halfOpen };
}

/**
 * Record a source failure for circuit breaker
 */
function recordSourceFailure(sourceUrl, error) {
    let host;
    try {
        host = new URL(sourceUrl).host;
    } catch {
        return;
    }

    const circuit = sourceFailures.get(host) || {
        failures: 0,
        lastFailure: 0,
        circuitOpen: false,
        halfOpen: false
    };

    circuit.failures++;
    circuit.lastFailure = Date.now();

    // If in half-open state and failed, reopen circuit
    if (circuit.halfOpen) {
        circuit.circuitOpen = true;
        circuit.halfOpen = false;
        logger.warn(`[CIRCUIT] Re-opening circuit for ${host} after half-open failure`);
    }
    // If failures exceed threshold, open circuit
    else if (circuit.failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
        circuit.circuitOpen = true;
        logger.warn(`[CIRCUIT] Opening circuit for ${host} after ${circuit.failures} failures`);
    }

    sourceFailures.set(host, circuit);
}

/**
 * Record a source success for circuit breaker
 */
function recordSourceSuccess(sourceUrl) {
    let host;
    try {
        host = new URL(sourceUrl).host;
    } catch {
        return;
    }

    const circuit = sourceFailures.get(host);
    if (circuit) {
        // Reset circuit on success
        circuit.failures = 0;
        circuit.circuitOpen = false;
        circuit.halfOpen = false;
        logger.info(`[CIRCUIT] Reset circuit for ${host} after success`);
    }
}

/**
 * Abort existing stream for a user/channel if one exists
 */
function abortExistingStream(channelId, userId) {
    const key = `${userId || 'anon'}_${channelId}`;
    const existing = activeStreams.get(key);

    if (existing && existing.controller) {
        const streamAge = Date.now() - existing.timestamp;
        logger.info(`[STREAM] Aborting existing stream for ${channelId} (age: ${Math.ceil(streamAge/1000)}s)`);
        try {
            existing.controller.abort();
        } catch (e) {
            // Ignore abort errors
        }
        activeStreams.delete(key);
    }
}

/**
 * Track an active stream
 */
function trackActiveStream(channelId, userId, controller) {
    const key = `${userId || 'anon'}_${channelId}`;
    activeStreams.set(key, {
        controller,
        timestamp: Date.now()
    });
}

/**
 * Remove stream from tracking
 */
function untrackActiveStream(channelId, userId) {
    const key = `${userId || 'anon'}_${channelId}`;
    activeStreams.delete(key);
}

// Clean up stale throttle entries every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of recentStreamRequests.entries()) {
        if (now - data.firstRequestTime > THROTTLE_WINDOW_MS * 10) {
            recentStreamRequests.delete(key);
        }
    }
}, 30000);

// Clean up stale circuit breaker entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [host, circuit] of sourceFailures.entries()) {
        // Remove entries that haven't had failures in 10 minutes
        if (now - circuit.lastFailure > 10 * 60 * 1000) {
            sourceFailures.delete(host);
        }
    }
}, 5 * 60 * 1000);

// Connection pooling agents for efficient HTTP/HTTPS requests
// CRITICAL: Keep socket limits LOW to prevent network exhaustion
// Multi-view with 6 streams only needs 6-12 connections total
const httpAgent = new http.Agent({
  keepAlive: true,           // Reuse connections
  maxSockets: 15,            // Max 15 concurrent connections per host (reduced to prevent exhaustion)
  maxFreeSockets: 5,         // Keep 5 idle connections ready for reuse
  timeout: 20000,            // 20 second socket timeout (faster release of stuck sockets)
  keepAliveMsecs: 5000,      // Send keep-alive packets every 5s
  scheduling: 'fifo'         // First-in-first-out for fair socket allocation
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 15,
  maxFreeSockets: 5,
  timeout: 20000,
  keepAliveMsecs: 5000,
  scheduling: 'fifo'
});

logger.info('HTTP/HTTPS connection pooling enabled (maxSockets: 15, keepAlive: true)');

/**
 * GET /:sessionId/:channelId
 * Stream a channel by redirecting to the appropriate URL
 * Supports both direct streaming and format conversion
 */
router.get('/:sessionId/:channelId', authMiddleware, async (req, res) => {
    try {
        const { sessionId, channelId } = req.params;
        const format = req.query.format || 'ts'; // Default to ts format
        const sourceId = req.query.source_id ? parseInt(req.query.source_id) : null; // Get source_id if provided
        const userId = req.user?.id; // Get user ID if authenticated

        // Check throttling to prevent rapid reconnection storms
        const throttleCheck = checkStreamThrottle(channelId, userId);
        if (throttleCheck.throttled) {
            logger.warn(`[THROTTLE] Rejecting stream request for ${channelId}: ${throttleCheck.reason}`);
            return res.status(429).json({
                error: 'Too many requests',
                details: throttleCheck.reason,
                retryAfter: Math.ceil((throttleCheck.remainingMs || 5000) / 1000)
            });
        }

        // Abort any existing stream for this user/channel to prevent duplicates
        abortExistingStream(channelId, userId);

        logger.info(`Stream request for session ${sessionId}, channel ${channelId}, format ${format}, userId ${userId || 'none'}, sourceId ${sourceId || 'all'}`);

        let channels = [];

        // For streaming, first try to fetch ONLY the specific channel needed
        // This prevents timeout issues with sources that have 40k+ channels
        try {
            logger.info(`Fetching specific channel ${channelId} from database for source ${sourceId}`);
            const db = await iptvDatabaseService.connect();

            const channelRow = await new Promise((resolve, reject) => {
                db.get(`
                    SELECT
                        c.channel_id as id,
                        c.name,
                        c.stream_url as url,
                        c.logo_url as logo,
                        c.group_title,
                        c.tvg_id,
                        c.source_type,
                        c.source_username,
                        c.source_password,
                        c.source_url,
                        c.source_mac
                    FROM iptv_channels c
                    JOIN iptv_sources s ON c.source_id = s.id
                    WHERE c.channel_id = ?
                    AND s.id = ?
                    AND (s.session_id = ? OR s.user_id = ?)
                `, [channelId, sourceId, sessionId, userId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (channelRow) {
                logger.info(`Found channel ${channelId} directly from database`);
                channels = [{
                    id: channelRow.id,
                    tvgId: channelRow.tvg_id || channelRow.id,
                    name: channelRow.name,
                    groupTitle: channelRow.group_title || '',
                    logo: channelRow.logo || '',
                    url: channelRow.url,
                    categories: [],
                    source_type: channelRow.source_type,
                    source_username: channelRow.source_username,
                    source_password: channelRow.source_password,
                    source_url: channelRow.source_url,
                    source_mac: channelRow.source_mac
                }];
            }
        } catch (dbError) {
            logger.warn(`Error loading specific channel: ${dbError.message}`);
        }

        // Fallback: Try to get ALL channels from database if direct lookup failed
        if (channels.length === 0) {
            try {
                logger.info(`Fetching channels from IPTV database for streaming session ${sessionId}${sourceId ? ` filtered by source ${sourceId}` : ''}`);
                const dbResult = await iptvDatabaseService.getChannelsForSession(sessionId, {
                    page: 1,
                    limit: 999999, // Essentially unlimited - load ALL channels for streaming
                    userId: userId, // Pass userId for authenticated users - enables per-user channel queries
                    sourceId: sourceId // Pass sourceId to filter channels by IPTV source
                });

                if (dbResult && dbResult.channels && dbResult.channels.length > 0) {
                    logger.info(`Loaded ${dbResult.channels.length} channels from database for streaming`);

                    // Transform channels to match expected format
                    channels = dbResult.channels.map(ch => ({
                        id: ch.id,
                        tvgId: ch.tvg?.id || ch.id,
                        name: ch.name,
                        groupTitle: ch.group?.title || '',
                        logo: ch.logo || '',
                        url: ch.url,
                        categories: ch.categories || []
                    }));

                    // Debug: Log first few channels to see their structure
                    const samples = channels.slice(0, 5).map(ch => ({
                        id: ch.id,
                        tvgId: ch.tvgId,
                        name: ch.name
                    }));
                    logger.info(`Sample channels from database: ${JSON.stringify(samples, null, 2)}`);

                    // Debug: Find NHL channels if we're looking for one
                    if (channelId.toLowerCase().includes('nhl') || channelId.toLowerCase().includes('699083') || channelId.toLowerCase().includes('xtream')) {
                        const nhlChannels = channels.filter(ch =>
                            ch.name.toLowerCase().includes('nhl') ||
                            ch.id.toLowerCase().includes('nhl') ||
                            ch.id.includes('699083') ||
                            ch.id.includes('xtream')
                        ).slice(0, 10);
                        logger.info(`Found ${nhlChannels.length} NHL/matching channels: ${JSON.stringify(nhlChannels.map(ch => ({
                            id: ch.id,
                            tvgId: ch.tvgId,
                            name: ch.name
                        })), null, 2)}`);
                    }
                }
            } catch (dbError) {
                logger.warn(`Error loading channels from database: ${dbError.message}, falling back to in-memory`);
            }
        }

        // Fall back to in-memory session storage if database didn't have channels
        if (channels.length === 0) {
            logger.info(`Falling back to in-memory session storage for streaming`);
            let session = sessionStorage.getSession(sessionId);

            // Check if session exists
            if (!session) {
                logger.error(`Session ${sessionId} not found in memory or database`);
                return res.status(404).json({ error: 'Session not found' });
            }

            // Get channels from session
            if (session.data && session.data.channels && session.data.channels.length > 0) {
                channels = session.data.channels;
                logger.info(`Using ${channels.length} channels from in-memory session`);
            } else {
                logger.error(`Session ${sessionId} has no channels in memory or database`);
                return res.status(404).json({ error: 'No channels loaded for this session' });
            }
        }
        
        // Normalize channelId - either with or without 'channel_' prefix
        let normalizedChannelId = channelId;
        let channel;

        logger.info(`Looking for channel with ID: "${channelId}" among ${channels.length} channels`);

        // Try multiple lookup strategies
        // 1. Try by ID first (most reliable)
        channel = channels.find(ch => ch.id === channelId);
        if (channel) {
            logger.info(`Found channel by ID match`);
        }

        // 2. If not found, try by tvgId
        if (!channel) {
            channel = channels.find(ch => ch.tvgId === channelId);
        }

        // 3. If not found, try adding 'channel_' prefix
        if (!channel && !channelId.startsWith('channel_')) {
            normalizedChannelId = `channel_${channelId}`;
            channel = channels.find(ch => ch.id === normalizedChannelId || ch.tvgId === normalizedChannelId);
            if (channel) {
                logger.info(`Found channel with prefix: ${normalizedChannelId}`);
            }
        }

        // 4. If still not found and has 'channel_' prefix, try without it
        if (!channel && channelId.startsWith('channel_')) {
            normalizedChannelId = channelId.replace(/^channel_/, '');
            channel = channels.find(ch => ch.id === normalizedChannelId || ch.tvgId === normalizedChannelId);
            if (channel) {
                logger.info(`Found channel without prefix: ${normalizedChannelId}`);
            }
        }

        if (!channel) {
            logger.error(`Channel not found: ${channelId} in session ${sessionId}. Tried ID and tvgId lookups.`);
            return res.status(404).json({
                error: 'Channel not found',
                details: `Could not find channel with ID "${channelId}" in session. Make sure the channel is loaded.`
            });
        }
        
        if (!channel.url) {
            logger.error(`No stream URL for channel ${channelId}`);
            return res.status(400).json({ error: 'No stream URL for this channel' });
        }
        
        logger.info(`Streaming channel: ${channel.name} (${normalizedChannelId}) from URL: ${channel.url}`);

        // For HEAD requests, skip expensive Stalker token fetching - just check if channel exists
        if (req.method === 'HEAD') {
            logger.info(`[HEAD] Channel exists in database, returning 200`);
            return res.status(200).end();
        }

        // Handle Stalker portal URLs - request FRESH link from portal
        let streamUrl = channel.url;
        if (channel.url.includes('portal.php') && channel.url.includes('action=create_link')) {
            try {
                logger.info(`[STREAM] Requesting fresh Stalker link from portal for channel ${normalizedChannelId}...`);

                // Query database to get source information including MAC address
                const db = await iptvDatabaseService.connect();
                const channelWithSource = await new Promise((resolve, reject) => {
                    // Extract the actual channel ID from normalized ID (remove 'channel_' prefix if present)
                    const dbChannelId = normalizedChannelId.replace(/^channel_/, '');

                    db.get(`
                        SELECT
                            c.channel_id,
                            c.name,
                            c.stream_url as url,
                            s.mac_address as source_mac,
                            s.username as source_username,
                            s.password as source_password
                        FROM iptv_channels c
                        JOIN iptv_sources s ON c.source_id = s.id
                        WHERE c.channel_id = ? ${userId ? 'AND s.user_id = ?' : ''}
                    `, userId ? [dbChannelId, userId] : [dbChannelId], (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    });
                });

                if (!channelWithSource) {
                    logger.warn(`[STREAM] Could not find channel ${normalizedChannelId} in database with source info`);
                } else {
                    // Make request to create_link to get fresh token
                    const createLinkResponse = await fetch(channel.url, {
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                            'X-User-Agent': 'Model: MAG250; Link: WiFi',
                            'Cookie': `mac=${channelWithSource.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
                        },
                        timeout: 10000,
                        agent: channel.url.startsWith('https') ? httpsAgent : httpAgent
                    });

                    if (createLinkResponse.ok) {
                        const linkData = await createLinkResponse.json();
                        logger.info(`[STREAM] create_link response:`, JSON.stringify(linkData, null, 2));
                        logger.info(`[STREAM] linkData type: ${typeof linkData}, has js: ${!!linkData?.js}, has cmd: ${!!linkData?.js?.cmd}`);

                        if (linkData && linkData.js && linkData.js.cmd) {
                            const freshCmd = linkData.js.cmd;
                            logger.info(`[STREAM] Extracted cmd from response: ${freshCmd}`);
                            const match = freshCmd.match(/ffmpeg\s+(.+)/);
                            if (match && match[1]) {
                                let freshUrl = match[1];
                                logger.info(`[STREAM] Got FRESH Stalker stream URL: ${freshUrl}`);

                                // Extract play_token from fresh URL
                                const freshTokenMatch = freshUrl.match(/play_token=([^&]+)/);
                                const freshToken = freshTokenMatch ? freshTokenMatch[1] : null;

                                // Extract stream ID from ORIGINAL cmd parameter in channel.url
                                // Some Stalker portals return empty stream parameter in create_link response
                                const originalCmdMatch = channel.url.match(/cmd=([^&]+)/);
                                if (originalCmdMatch && freshToken) {
                                    const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                                    logger.info(`[STREAM] Original cmd: ${originalCmd}`);
                                    const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                                    const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                                    if (originalStreamId) {
                                        // Check if fresh URL has empty stream parameter
                                        if (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/)) {
                                            logger.info(`[STREAM] Portal returned empty stream ID - using original stream ID: ${originalStreamId}`);
                                            freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
                                            logger.info(`[STREAM] Fixed stream URL: ${freshUrl}`);
                                        }
                                    }
                                }

                                streamUrl = freshUrl;

                                // Replace localhost with actual server address if present
                                if (streamUrl.includes('localhost')) {
                                    const sourceUrl = new URL(channel.url);
                                    const serverAddress = `${sourceUrl.protocol}//${sourceUrl.host}`;
                                    streamUrl = streamUrl.replace(/http:\/\/localhost/g, serverAddress);
                                    logger.info(`[STREAM] Replaced localhost with server address: ${streamUrl}`);
                                }
                            } else {
                                logger.warn(`[STREAM] Could not extract stream URL from cmd: ${freshCmd.substring(0, 100)}`);
                            }
                        } else {
                            logger.warn(`[STREAM] Invalid create_link response structure:`, JSON.stringify(linkData, null, 2));
                        }
                    } else {
                        logger.error(`[STREAM] create_link request failed: ${createLinkResponse.status} ${createLinkResponse.statusText}`);
                    }
                }
            } catch (error) {
                logger.error(`[STREAM] Error fetching fresh Stalker link: ${error.message}`);
                // Fall back to using the URL as-is
            }
        }

        // Option 1: Simple redirect to the original URL
        if (req.query.redirect === 'true') {
            return res.redirect(streamUrl);
        }
        
        // For HEAD requests, don't try to stream, just check availability
        if (req.method === 'HEAD') {
            try {
                // Test if the URL is reachable
                const testResponse = await fetch(streamUrl, {
                    method: 'HEAD',
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                    },
                    agent: streamUrl.startsWith('https') ? httpsAgent : httpAgent
                });
                
                if (!testResponse.ok) {
                    logger.warn(`Stream URL check failed for ${channelId}: ${testResponse.status} ${testResponse.statusText}`);
                    return res.status(502).json({
                        error: 'Stream source unavailable',
                        details: `Source returned: ${testResponse.status} ${testResponse.statusText}`
                    });
                }
                
                // If we get here, the URL is reachable
                return res.status(200).end();
            } catch (error) {
                let statusCode = 502;
                let errorMessage = 'Stream source unavailable';
                
                // DNS resolution errors
                if (error.code === 'ENOTFOUND') {
                    errorMessage = 'Stream source domain cannot be resolved';
                    logger.error(`DNS resolution failed for stream URL: ${streamUrl}`);
                } else if (error.code === 'ETIMEDOUT' || error.cause?.code === 'ETIMEDOUT') {
                    errorMessage = 'Stream source connection timed out';
                } else if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
                    errorMessage = 'Stream source connection was refused';
                }

                logger.error(`Stream availability check failed: ${error.message}`, {
                    channelId,
                    url: streamUrl,
                    errorCode: error.code || error.cause?.code
                });
                
                return res.status(statusCode).json({
                    error: errorMessage,
                    details: error.message
                });
            }
        }
        
        // Option 2: Proxy the stream with potential format conversion
        // Stream video using pipe (more efficient for large data)
        try {
            // Check circuit breaker before attempting to connect
            const circuitCheck = checkCircuitBreaker(streamUrl);
            if (circuitCheck.open) {
                logger.warn(`[CIRCUIT] Rejecting stream for ${channelId}: ${circuitCheck.reason}`);
                return res.status(503).json({
                    error: 'Source temporarily unavailable',
                    details: circuitCheck.reason,
                    retryAfter: Math.ceil((circuitCheck.remainingMs || 30000) / 1000)
                });
            }

            // Set appropriate headers for streaming
            res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');

            // Fetch and pipe the stream with proper timeout using AbortController
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout for stream to start

            // Track this stream so we can abort it if a new request comes in for same channel
            trackActiveStream(channelId, userId, controller);

            const streamResponse = await fetch(streamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                },
                signal: controller.signal,
                agent: streamUrl.startsWith('https') ? httpsAgent : httpAgent
            });

            clearTimeout(timeoutId);

            if (!streamResponse.ok) {
                logger.error(`Failed to fetch stream: ${streamResponse.status} ${streamResponse.statusText}`);
                recordSourceFailure(streamUrl, new Error(`HTTP ${streamResponse.status}`));
                untrackActiveStream(channelId, userId);
                return res.status(502).json({
                    error: 'Failed to fetch stream from source',
                    status: streamResponse.status,
                    message: streamResponse.statusText
                });
            }

            // Stream connected successfully - record success for circuit breaker
            recordSourceSuccess(streamUrl);
            
            // Create a pass-through stream for better error handling
            const passThrough = new PassThrough();

            // Track stream start for metrics
            const streamKey = `${sessionId}_${channelId}_${Date.now()}`;
            metricsService.trackStreamStart(streamKey, {
                channel: channel.name,
                channelId: channelId,
                source: channel.groupTitle || 'Unknown',
                sourceId: sourceId,
                user: req.user?.username || req.user?.email,
                userId: userId,
                ip: req.ip || req.connection.remoteAddress,
                type: 'stream'
            });

            // Track bandwidth as data flows - batch updates to reduce overhead
            let pendingBytes = 0;
            let lastBandwidthUpdate = Date.now();
            const BANDWIDTH_UPDATE_INTERVAL = 1000; // Update metrics at most once per second

            passThrough.on('data', (chunk) => {
                pendingBytes += chunk.length;
                const now = Date.now();
                // Only call trackBandwidth once per second to reduce CPU overhead
                if (now - lastBandwidthUpdate >= BANDWIDTH_UPDATE_INTERVAL) {
                    metricsService.trackBandwidth(streamKey, pendingBytes, 0);
                    pendingBytes = 0;
                    lastBandwidthUpdate = now;
                }
            });

            // Handle errors on the source stream
            streamResponse.body.on('error', (err) => {
                logger.error(`Source stream error for channel ${channelId}: ${err.message}`);
                metricsService.trackStreamEnd(streamKey);
                passThrough.destroy(err);
            });

            // Handle errors on the response stream
            res.on('error', (err) => {
                logger.error(`Response stream error for channel ${channelId}: ${err.message}`);
                metricsService.trackStreamEnd(streamKey);
                streamResponse.body.destroy();
                passThrough.destroy();
            });

            // Handle client disconnect - clean up everything immediately
            req.on('close', () => {
                try {
                    logger.info(`Stream closed for channel ${channelId}`);
                    metricsService.trackStreamEnd(streamKey);
                    untrackActiveStream(channelId, userId);
                    // Abort the fetch if still pending
                    controller.abort();
                    streamResponse.body.destroy();
                    passThrough.destroy();
                } catch (err) {
                    logger.error(`Error closing stream: ${err.message}`);
                }
            });

            // Pipe through our pass-through stream for better control
            streamResponse.body.pipe(passThrough).pipe(res);

            // Set a timeout on the whole operation - reduced to 90 seconds
            // Long timeouts can cause connection accumulation in multi-view
            const streamTimeout = setTimeout(() => {
                logger.warn(`Stream timeout for channel ${channelId}`);
                metricsService.trackStreamEnd(streamKey);
                untrackActiveStream(channelId, userId);
                streamResponse.body.destroy(new Error('Stream timeout'));
                passThrough.destroy(new Error('Stream timeout'));
            }, 90000); // 90 second timeout (reduced from 5 minutes)

            // Clear timeout when stream ends or errors
            passThrough.on('end', () => {
                logger.info(`Stream completed successfully for channel ${channelId}`);
                metricsService.trackStreamEnd(streamKey);
                untrackActiveStream(channelId, userId);
                clearTimeout(streamTimeout);
            });

            passThrough.on('error', () => {
                untrackActiveStream(channelId, userId);
                clearTimeout(streamTimeout);
            });
            
        } catch (streamError) {
            // Always clean up tracking on error
            untrackActiveStream(channelId, userId);

            // Handle aborted requests gracefully - these are normal when clients disconnect
            // (e.g., user changes channel, closes player, or layout changes in multi-view)
            if (streamError.name === 'AbortError' || streamError.message?.includes('aborted')) {
                logger.info(`Stream request aborted for channel ${channelId} (client disconnected)`);
                // Don't send error response - client is already gone
                if (!res.headersSent) {
                    res.status(499).end(); // 499 = Client Closed Request (nginx convention)
                }
                return;
            }

            // Record failure for circuit breaker (if we have the URL)
            if (streamUrl) {
                recordSourceFailure(streamUrl, streamError);
            }

            // Handle common stream errors
            let errorMessage = 'Error streaming content';
            let statusCode = 500;

            // Adjust error message based on specific error types
            if (streamError.code === 'ENOTFOUND' || streamError.message.includes('ENOTFOUND')) {
                errorMessage = 'Stream source cannot be found (DNS resolution failed)';
                statusCode = 502;
            } else if (streamError.code === 'ETIMEDOUT' || streamError.message.includes('ETIMEDOUT')) {
                errorMessage = 'Stream source connection timed out';
                statusCode = 504;
            } else if (streamError.code === 'ECONNREFUSED' || streamError.message.includes('ECONNREFUSED')) {
                errorMessage = 'Stream source connection was refused';
                statusCode = 502;
            } else if (streamError.code === 'ECONNRESET' || streamError.message.includes('ECONNRESET')) {
                errorMessage = 'Stream source connection was reset';
                statusCode = 502;
            }

            logger.error(`${errorMessage}: ${streamError.message}`, {
                error: streamError.message,
                stack: streamError.stack,
                channelId,
                url: channel.url
            });

            // If streaming has already started, we can't send a JSON response
            if (!res.headersSent) {
                return res.status(statusCode).json({
                    error: errorMessage,
                    details: streamError.message
                });
            }
        }
        
    } catch (error) {
        logger.error(`Stream error: ${error.message}`, { 
            error: error.message,
            stack: error.stack
        });
        
        // Only send response if headers haven't been sent yet
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

/**
 * GET /xtream/:sessionId/:type/:id
 * Special handler for Xtream format URLs
 */
router.get('/xtream/:sessionId/:type/:id', async (req, res) => {
    try {
        const { sessionId, type, id } = req.params;
        const format = req.query.format || 'ts';
        
        logger.info(`Xtream stream request for session ${sessionId}, type ${type}, id ${id}`);
        
        // Get session data with Xtream credentials
        const session = getSession(sessionId);
        if (!session || !session.xtreamUsername || !session.xtreamPassword || !session.xtreamServer) {
            return res.status(404).json({ error: 'Session not found or no Xtream credentials' });
        }
        
        const { xtreamUsername, xtreamPassword, xtreamServer } = session;
        
        // Construct the Xtream URL
        const xtreamUrl = `${xtreamServer}/live/${xtreamUsername}/${xtreamPassword}/${id}.${format}`;
        
        logger.info(`Proxying Xtream stream: ${xtreamUrl}`);
        
        // Option 1: Simple redirect
        if (req.query.redirect === 'true') {
            return res.redirect(xtreamUrl);
        }
        
        // Option 2: Proxy the stream
        try {
            // Set streaming headers
            res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            // Fetch and pipe the stream
            const streamResponse = await fetch(xtreamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                },
                agent: xtreamUrl.startsWith('https') ? httpsAgent : httpAgent
            });
            
            if (!streamResponse.ok) {
                logger.error(`Failed to fetch Xtream stream: ${streamResponse.status} ${streamResponse.statusText}`);
                return res.status(502).json({ 
                    error: 'Failed to fetch stream from Xtream source',
                    status: streamResponse.status,
                    message: streamResponse.statusText
                });
            }
            
            // Track stream start for metrics
            const streamKey = `xtream_${sessionId}_${id}_${Date.now()}`;
            const passThrough = new PassThrough();

            metricsService.trackStreamStart(streamKey, {
                channel: `Xtream Channel ${id}`,
                channelId: id,
                source: xtreamServer,
                sourceId: null,
                user: null,
                userId: null,
                ip: req.ip || req.connection.remoteAddress,
                type: 'xtream'
            });

            // Track bandwidth as data flows - batch updates to reduce overhead
            let pendingBytesXtream = 0;
            let lastBandwidthUpdateXtream = Date.now();
            const BANDWIDTH_UPDATE_INTERVAL_XTREAM = 1000;

            passThrough.on('data', (chunk) => {
                pendingBytesXtream += chunk.length;
                const now = Date.now();
                if (now - lastBandwidthUpdateXtream >= BANDWIDTH_UPDATE_INTERVAL_XTREAM) {
                    metricsService.trackBandwidth(streamKey, pendingBytesXtream, 0);
                    pendingBytesXtream = 0;
                    lastBandwidthUpdateXtream = now;
                }
            });

            // Pipe through passThrough to track bandwidth
            streamResponse.body.pipe(passThrough).pipe(res);

            // Track stream end
            passThrough.on('end', () => {
                metricsService.trackStreamEnd(streamKey);
            });

            passThrough.on('error', (err) => {
                logger.error(`Xtream passThrough error: ${err.message}`);
                metricsService.trackStreamEnd(streamKey);
            });

            // Handle client disconnect
            req.on('close', () => {
                try {
                    metricsService.trackStreamEnd(streamKey);
                    streamResponse.body.destroy();
                    passThrough.destroy();
                    logger.info(`Xtream stream closed for id ${id}`);
                } catch (err) {
                    logger.error(`Error closing Xtream stream: ${err.message}`);
                }
            });
            
        } catch (streamError) {
            logger.error(`Error streaming Xtream content: ${streamError.message}`, {
                error: streamError.message,
                stack: streamError.stack
            });
            
            if (!res.headersSent) {
                return res.status(500).json({ 
                    error: 'Error streaming Xtream content',
                    message: streamError.message
                });
            }
        }
        
    } catch (error) {
        logger.error(`Xtream stream error: ${error.message}`, {
            error: error.message,
            stack: error.stack
        });
        
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

// ============================================================================
// RESILIENT STREAM ENDPOINT - Automatic retry/reconnect at proxy level
// ============================================================================

/**
 * Helper function to create a resilient stream connection
 * This handles automatic retry/reconnect when the source stream fails
 */
async function createResilientStreamConnection(streamUrl, streamKey, channel, res, req, logger) {
    const state = {
        retryCount: 0,
        lastDataTime: Date.now(),
        totalBytesStreamed: 0,
        startTime: Date.now(),
        currentFetch: null,
        currentBody: null,
        isDestroyed: false,
        healthCheckTimer: null,
        retryDelay: RESILIENT_CONFIG.initialRetryDelay,
    };

    // Store in global map for monitoring
    resilientStreams.set(streamKey, {
        channel: channel.name,
        url: streamUrl,
        state,
        startTime: state.startTime,
    });

    // Function to connect to stream source
    const connectToSource = async () => {
        if (state.isDestroyed) {
            return false;
        }

        try {
            logger.info(`[RESILIENT ${streamKey}] Connecting to source (attempt ${state.retryCount + 1}/${RESILIENT_CONFIG.maxRetries + 1})`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
            }, RESILIENT_CONFIG.connectionTimeout);

            state.currentFetch = await fetch(streamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                },
                signal: controller.signal,
                agent: streamUrl.startsWith('https') ? httpsAgent : httpAgent
            });

            clearTimeout(timeoutId);

            if (!state.currentFetch.ok) {
                throw new Error(`HTTP ${state.currentFetch.status}: ${state.currentFetch.statusText}`);
            }

            state.currentBody = state.currentFetch.body;
            state.lastDataTime = Date.now();
            state.retryCount = 0; // Reset retry count on successful connection
            state.retryDelay = RESILIENT_CONFIG.initialRetryDelay; // Reset delay

            // Record success for circuit breaker
            recordSourceSuccess(streamUrl);

            logger.info(`[RESILIENT ${streamKey}] Connected successfully`);
            return true;

        } catch (error) {
            if (state.isDestroyed) {
                return false;
            }

            // Record failure for circuit breaker
            recordSourceFailure(streamUrl, error);

            logger.warn(`[RESILIENT ${streamKey}] Connection failed: ${error.message}`);
            state.retryCount++;

            if (state.retryCount > RESILIENT_CONFIG.maxRetries) {
                logger.error(`[RESILIENT ${streamKey}] Max retries exceeded, giving up`);
                return false;
            }

            // Exponential backoff
            logger.info(`[RESILIENT ${streamKey}] Retrying in ${state.retryDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, state.retryDelay));
            state.retryDelay = Math.min(
                state.retryDelay * RESILIENT_CONFIG.backoffMultiplier,
                RESILIENT_CONFIG.maxRetryDelay
            );

            return connectToSource(); // Recursive retry
        }
    };

    // Function to handle stream data with automatic reconnection
    const streamWithReconnect = async () => {
        if (state.isDestroyed) {
            return;
        }

        const connected = await connectToSource();
        if (!connected) {
            // Failed to connect even after retries - close the response
            if (!res.headersSent) {
                res.status(502).json({ error: 'Failed to connect to stream source after retries' });
            } else {
                res.end();
            }
            cleanup();
            return;
        }

        // Set up health check timer
        state.healthCheckTimer = setInterval(() => {
            const timeSinceData = Date.now() - state.lastDataTime;
            const streamDuration = Date.now() - state.startTime;

            // Check for stale stream
            if (timeSinceData > RESILIENT_CONFIG.staleDataThreshold) {
                logger.warn(`[RESILIENT ${streamKey}] Stream stale (no data for ${timeSinceData}ms), attempting reconnect`);

                // CRITICAL: Clear health check timer BEFORE reconnecting to prevent timer accumulation
                if (state.healthCheckTimer) {
                    clearInterval(state.healthCheckTimer);
                    state.healthCheckTimer = null;
                }

                // Destroy current connection and reconnect
                if (state.currentBody) {
                    state.currentBody.destroy();
                }
                streamWithReconnect();
                return;
            }

            // Check for max duration
            if (streamDuration > RESILIENT_CONFIG.maxStreamDuration) {
                logger.info(`[RESILIENT ${streamKey}] Max stream duration reached (${streamDuration}ms)`);
                cleanup();
                res.end();
            }
        }, RESILIENT_CONFIG.healthCheckInterval);

        // Pipe data to response
        state.currentBody.on('data', (chunk) => {
            if (state.isDestroyed) return;

            state.lastDataTime = Date.now();
            state.totalBytesStreamed += chunk.length;

            try {
                res.write(chunk);
            } catch (err) {
                logger.error(`[RESILIENT ${streamKey}] Error writing to response: ${err.message}`);
                cleanup();
            }
        });

        state.currentBody.on('error', async (err) => {
            if (state.isDestroyed) return;

            logger.warn(`[RESILIENT ${streamKey}] Source stream error: ${err.message}`);

            // Clear the health check before reconnecting
            if (state.healthCheckTimer) {
                clearInterval(state.healthCheckTimer);
                state.healthCheckTimer = null;
            }

            // Attempt reconnect
            state.retryCount++;
            if (state.retryCount <= RESILIENT_CONFIG.maxRetries) {
                logger.info(`[RESILIENT ${streamKey}] Attempting automatic reconnect...`);
                await new Promise(resolve => setTimeout(resolve, state.retryDelay));
                state.retryDelay = Math.min(
                    state.retryDelay * RESILIENT_CONFIG.backoffMultiplier,
                    RESILIENT_CONFIG.maxRetryDelay
                );
                streamWithReconnect();
            } else {
                logger.error(`[RESILIENT ${streamKey}] Max reconnect attempts reached`);
                cleanup();
                res.end();
            }
        });

        state.currentBody.on('end', async () => {
            if (state.isDestroyed) return;

            logger.info(`[RESILIENT ${streamKey}] Source stream ended, attempting reconnect...`);

            // Clear the health check before reconnecting
            if (state.healthCheckTimer) {
                clearInterval(state.healthCheckTimer);
                state.healthCheckTimer = null;
            }

            // Stream ended normally - try to reconnect
            state.retryCount++;
            if (state.retryCount <= RESILIENT_CONFIG.maxRetries) {
                await new Promise(resolve => setTimeout(resolve, state.retryDelay));
                streamWithReconnect();
            } else {
                logger.info(`[RESILIENT ${streamKey}] Stream completed after reconnect attempts`);
                cleanup();
                res.end();
            }
        });
    };

    // Cleanup function
    const cleanup = () => {
        if (state.isDestroyed) return;
        state.isDestroyed = true;

        logger.info(`[RESILIENT ${streamKey}] Cleaning up (streamed ${(state.totalBytesStreamed / 1024 / 1024).toFixed(2)} MB)`);

        if (state.healthCheckTimer) {
            clearInterval(state.healthCheckTimer);
        }

        if (state.currentBody) {
            try {
                state.currentBody.destroy();
            } catch (e) {
                // Ignore
            }
        }

        resilientStreams.delete(streamKey);
        metricsService.trackStreamEnd(streamKey);
    };

    // Handle client disconnect
    req.on('close', () => {
        logger.info(`[RESILIENT ${streamKey}] Client disconnected`);
        cleanup();
    });

    res.on('error', (err) => {
        logger.error(`[RESILIENT ${streamKey}] Response error: ${err.message}`);
        cleanup();
    });

    // Track stream start
    metricsService.trackStreamStart(streamKey, {
        channel: channel.name,
        channelId: channel.id,
        source: channel.groupTitle || 'Unknown',
        type: 'resilient'
    });

    // Start streaming
    streamWithReconnect();
}

/**
 * GET /resilient/:sessionId/:channelId
 * Resilient stream proxy with automatic retry/reconnect at the backend level
 * This endpoint handles stream failures transparently - the frontend player
 * doesn't need to implement any recovery logic.
 */
router.get('/resilient/:sessionId/:channelId', authMiddleware, async (req, res) => {
    try {
        const { sessionId, channelId } = req.params;
        const format = req.query.format || 'ts';
        const sourceId = req.query.source_id ? parseInt(req.query.source_id) : null;
        const userId = req.user?.id;

        // Check throttling to prevent rapid reconnection storms
        const throttleCheck = checkStreamThrottle(channelId, userId);
        if (throttleCheck.throttled) {
            logger.warn(`[RESILIENT THROTTLE] Rejecting stream request for ${channelId}: ${throttleCheck.reason}`);
            return res.status(429).json({
                error: 'Too many requests',
                details: throttleCheck.reason,
                retryAfter: Math.ceil((throttleCheck.remainingMs || 5000) / 1000)
            });
        }

        // Abort any existing resilient stream for this user/channel
        abortExistingStream(channelId, userId);

        logger.info(`[RESILIENT] Stream request for session ${sessionId}, channel ${channelId}, sourceId ${sourceId}`);

        // Fetch channel from database (reuse existing logic)
        const db = await iptvDatabaseService.connect();
        const channelRow = await new Promise((resolve, reject) => {
            db.get(`
                SELECT
                    c.channel_id as id,
                    c.name,
                    c.stream_url as url,
                    c.logo_url as logo,
                    c.group_title,
                    c.tvg_id,
                    c.source_type,
                    c.source_username,
                    c.source_password,
                    c.source_url,
                    c.source_mac
                FROM iptv_channels c
                JOIN iptv_sources s ON c.source_id = s.id
                WHERE c.channel_id = ?
                ${sourceId ? 'AND s.id = ?' : ''}
                AND (s.session_id = ? OR s.user_id = ?)
            `, sourceId
                ? [channelId, sourceId, sessionId, userId]
                : [channelId, sessionId, userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!channelRow) {
            logger.error(`[RESILIENT] Channel not found: ${channelId}`);
            return res.status(404).json({ error: 'Channel not found' });
        }

        if (!channelRow.url) {
            logger.error(`[RESILIENT] No stream URL for channel ${channelId}`);
            return res.status(400).json({ error: 'No stream URL for this channel' });
        }

        const channel = {
            id: channelRow.id,
            name: channelRow.name,
            url: channelRow.url,
            groupTitle: channelRow.group_title,
            source_type: channelRow.source_type,
            source_mac: channelRow.source_mac,
        };

        // Handle Stalker portal URLs - request fresh link
        let streamUrl = channel.url;
        if (channel.url.includes('portal.php') && channel.url.includes('action=create_link')) {
            try {
                logger.info(`[RESILIENT] Requesting fresh Stalker link for channel ${channelId}...`);

                const createLinkResponse = await fetch(channel.url, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                        'X-User-Agent': 'Model: MAG250; Link: WiFi',
                        'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
                    },
                    timeout: 10000,
                    agent: channel.url.startsWith('https') ? httpsAgent : httpAgent
                });

                if (createLinkResponse.ok) {
                    const linkData = await createLinkResponse.json();
                    if (linkData && linkData.js && linkData.js.cmd) {
                        const freshCmd = linkData.js.cmd;
                        const match = freshCmd.match(/ffmpeg\s+(.+)/);
                        if (match && match[1]) {
                            let freshUrl = match[1];
                            logger.info(`[RESILIENT] Got fresh Stalker URL: ${freshUrl.substring(0, 80)}...`);

                            // Extract stream ID from ORIGINAL cmd parameter in channel.url
                            // Some Stalker portals return empty stream parameter in create_link response
                            const originalCmdMatch = channel.url.match(/cmd=([^&]+)/);
                            if (originalCmdMatch) {
                                const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                                const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                                const originalStreamId = originalStreamMatch ? originalStreamMatch[1] : null;

                                if (originalStreamId) {
                                    // Check if fresh URL has empty stream parameter
                                    if (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/)) {
                                        logger.info(`[RESILIENT] Portal returned empty stream ID - using original: ${originalStreamId}`);
                                        freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamId}$1`);
                                    }
                                }
                            }

                            streamUrl = freshUrl;

                            // Replace localhost if needed
                            if (streamUrl.includes('localhost')) {
                                const sourceUrl = new URL(channel.url);
                                streamUrl = streamUrl.replace(/http:\/\/localhost/g,
                                    `${sourceUrl.protocol}//${sourceUrl.host}`);
                            }

                            logger.info(`[RESILIENT] Final stream URL: ${streamUrl.substring(0, 100)}...`);
                        }
                    }
                }
            } catch (error) {
                logger.warn(`[RESILIENT] Error fetching Stalker link: ${error.message}, using original URL`);
            }
        }

        logger.info(`[RESILIENT] Streaming channel: ${channel.name} from: ${streamUrl.substring(0, 80)}...`);

        // Check circuit breaker before attempting to stream
        const circuitCheck = checkCircuitBreaker(streamUrl);
        if (circuitCheck.open) {
            logger.warn(`[RESILIENT CIRCUIT] Rejecting stream for ${channelId}: ${circuitCheck.reason}`);
            return res.status(503).json({
                error: 'Source temporarily unavailable',
                details: circuitCheck.reason,
                retryAfter: Math.ceil((circuitCheck.remainingMs || 30000) / 1000)
            });
        }

        // Set streaming headers
        res.setHeader('Content-Type', format === 'ts' ? 'video/mp2t' : 'video/mp4');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Stream-Mode', 'resilient');

        // Create unique stream key
        const streamKey = `resilient_${sessionId}_${channelId}_${Date.now()}`;

        // Start resilient streaming (pass streamUrl for circuit breaker recording)
        await createResilientStreamConnection(streamUrl, streamKey, channel, res, req, logger);

    } catch (error) {
        logger.error(`[RESILIENT] Stream error: ${error.message}`, {
            error: error.message,
            stack: error.stack
        });

        if (!res.headersSent) {
            return res.status(500).json({ error: error.message });
        }
    }
});

/**
 * GET /resilient/status
 * Get status of all active resilient streams (for monitoring)
 */
router.get('/resilient/status', authMiddleware, (req, res) => {
    const streams = [];
    for (const [key, data] of resilientStreams.entries()) {
        streams.push({
            key,
            channel: data.channel,
            startTime: data.startTime,
            duration: Date.now() - data.startTime,
            retryCount: data.state?.retryCount || 0,
            bytesStreamed: data.state?.totalBytesStreamed || 0,
        });
    }
    res.json({
        activeStreams: streams.length,
        streams,
        config: RESILIENT_CONFIG,
    });
});

/**
 * GET /diagnostics
 * Get diagnostics for throttling, circuit breakers, and active streams
 */
router.get('/diagnostics', authMiddleware, (req, res) => {
    const now = Date.now();

    // Collect throttle status
    const throttleStatus = [];
    for (const [key, data] of recentStreamRequests.entries()) {
        throttleStatus.push({
            key,
            requestCount: data.count,
            firstRequestTime: data.firstRequestTime,
            ageMs: now - data.firstRequestTime,
            cooldownUntil: data.cooldownUntil,
            inCooldown: data.cooldownUntil ? now < data.cooldownUntil : false,
            cooldownRemainingMs: data.cooldownUntil ? Math.max(0, data.cooldownUntil - now) : 0
        });
    }

    // Collect circuit breaker status
    const circuitStatus = [];
    for (const [host, circuit] of sourceFailures.entries()) {
        circuitStatus.push({
            host,
            failures: circuit.failures,
            lastFailure: circuit.lastFailure,
            lastFailureAgeMs: now - circuit.lastFailure,
            circuitOpen: circuit.circuitOpen,
            halfOpen: circuit.halfOpen || false,
            resetIn: circuit.circuitOpen ? Math.max(0, CIRCUIT_BREAKER_CONFIG.resetTimeout - (now - circuit.lastFailure)) : 0
        });
    }

    // Collect active streams
    const activeStreamStatus = [];
    for (const [key, data] of activeStreams.entries()) {
        activeStreamStatus.push({
            key,
            timestamp: data.timestamp,
            ageMs: now - data.timestamp
        });
    }

    // Collect resilient streams
    const resilientStatus = [];
    for (const [key, data] of resilientStreams.entries()) {
        resilientStatus.push({
            key,
            channel: data.channel,
            startTime: data.startTime,
            durationMs: now - data.startTime,
            retryCount: data.state?.retryCount || 0,
            bytesStreamed: data.state?.totalBytesStreamed || 0,
            lastDataTimeAgeMs: data.state?.lastDataTime ? now - data.state.lastDataTime : null
        });
    }

    res.json({
        timestamp: now,
        throttling: {
            config: {
                windowMs: THROTTLE_WINDOW_MS,
                maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW,
                cooldownMs: COOLDOWN_AFTER_THROTTLE_MS
            },
            channels: throttleStatus
        },
        circuitBreaker: {
            config: CIRCUIT_BREAKER_CONFIG,
            sources: circuitStatus
        },
        activeStreams: {
            count: activeStreamStatus.length,
            streams: activeStreamStatus
        },
        resilientStreams: {
            config: RESILIENT_CONFIG,
            count: resilientStatus.length,
            streams: resilientStatus
        }
    });
});

/**
 * Routes for handling Server-Sent Events (SSE)
 */
const { registerSSEClient, removeSSEClient, broadcastSSEUpdate } = require('../utils/sseUtils');

// Middleware to set SSE headers and prevent connection timeout
function sseHeaders(req, res, next) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent Nginx buffering
  res.flushHeaders();
  
  // Set up a heartbeat to prevent connection timeout
  const heartbeatInterval = setInterval(() => {
    if (!res.finished) {
      try {
        res.write(`:heartbeat ${new Date().toISOString()}\n\n`);
        // Don't use res.flush() here to avoid potential errors
      } catch (error) {
        logger.error(`Error sending heartbeat: ${error.message}`);
        clearInterval(heartbeatInterval);
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000); // Every 30 seconds
  
  // Cleanup function to ensure interval is cleared (runs only once)
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeatInterval);
    const sessionId = req.params.sessionId || null;
    if (sessionId && sessionId !== 'null' && sessionId !== 'undefined') {
      removeSSEClient(sessionId, res);
    }
  };

  // Clean up on client disconnect - multiple event handlers for safety
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  res.on('finish', cleanup);

  next();
}

/**
 * GET /api/stream-updates/:sessionId
 * Establishes an SSE connection for real-time updates
 */
router.get('/:sessionId', sseHeaders, (req, res) => {
  const { sessionId } = req.params;
  
  // Validate session ID
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error('Invalid session ID provided for SSE connection', { sessionId });
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  
  try {
    // Log the connection
    logger.info(`New SSE connection established for session: ${sessionId}`);
    
    // Register the client
    registerSSEClient(sessionId, res);
    
    // Send initial connection event
    broadcastSSEUpdate({
      type: 'connection',
      message: 'SSE connection established',
      sessionId
    }, sessionId);
    
  } catch (error) {
    logger.error(`Error establishing SSE connection: ${error.message}`, { 
      sessionId, 
      error: error.message 
    });
    res.status(500).end();
  }
});

/**
 * HLS Transcoding for Chromecast Support
 * Converts MPEG-TS streams to HLS format that Chromecast can play
 */

// Store active HLS transcoding sessions
const hlsSessions = new Map();
const MAX_HLS_SESSIONS = 10; // Maximum concurrent HLS sessions to prevent resource exhaustion

// Clean up HLS session
function cleanupHLSSession(sessionKey) {
  const session = hlsSessions.get(sessionKey);
  if (session) {
    logger.info(`Cleaning up HLS session: ${sessionKey}`);

    // Kill ffmpeg process
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
      session.ffmpegProcess.kill('SIGKILL');
    }

    // Clean up temporary files
    if (session.hlsDir && fs.existsSync(session.hlsDir)) {
      try {
        const files = fs.readdirSync(session.hlsDir);
        files.forEach(file => {
          fs.unlinkSync(path.join(session.hlsDir, file));
        });
        fs.rmdirSync(session.hlsDir);
        logger.info(`Cleaned up HLS directory: ${session.hlsDir}`);
      } catch (err) {
        logger.error(`Error cleaning up HLS directory: ${err.message}`);
      }
    }

    hlsSessions.delete(sessionKey);
  }
}

// Cleanup old HLS sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of hlsSessions.entries()) {
    // Clean up sessions older than 5 minutes with no activity
    if (now - session.lastAccess > 5 * 60 * 1000) {
      logger.info(`Cleaning up inactive HLS session: ${key}`);
      cleanupHLSSession(key);
    }
  }
}, 60 * 1000); // Check every minute

/**
 * GET /:sessionId/:channelId/hls.m3u8
 * Serve HLS playlist for Chromecast
 */
router.get('/:sessionId/:channelId/hls.m3u8', authMiddleware, async (req, res) => {
  try {
    const { sessionId, channelId } = req.params;
    const sourceId = req.query.source_id; // Get source_id if provided
    const sessionKey = `${sessionId}_${channelId}`;

    logger.info(`HLS playlist request for ${sessionKey}${sourceId ? ` from source ${sourceId}` : ''}`);

    // Get or create HLS session
    let hlsSession = hlsSessions.get(sessionKey);

    if (!hlsSession) {
      // Check if we've hit the max session limit
      if (hlsSessions.size >= MAX_HLS_SESSIONS) {
        logger.warn(`Max HLS sessions (${MAX_HLS_SESSIONS}) reached, rejecting new session`);
        return res.status(503).json({ error: 'Too many active HLS sessions, please try again later' });
      }

      logger.info(`Creating new HLS transcoding session for ${sessionKey}`);

      // Create temporary directory for HLS segments
      const hlsDir = path.join(os.tmpdir(), 'hls', sessionKey);
      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
      }

      // Get the stream URL (reuse logic from main stream endpoint)
      const streamReq = { params: { sessionId, channelId }, query: {}, user: req.user };

      // Import the channel lookup logic - we'll need to refactor this
      // For now, make a request to our own stream endpoint to get the URL
      const baseUrl = `http://localhost:${process.env.PORT || 5001}`;
      let streamInfoUrl = `${baseUrl}/api/stream/${sessionId}/${channelId}?redirect=true`;
      // Pass through sourceId if provided to ensure correct channel lookup
      if (sourceId) {
        streamInfoUrl += `&source_id=${sourceId}`;
      }

      logger.info(`Fetching stream URL from: ${streamInfoUrl}`);

      const streamInfoResp = await fetch(streamInfoUrl, {
        redirect: 'manual',
        headers: req.headers,
        agent: streamInfoUrl.startsWith('https') ? httpsAgent : httpAgent
      });

      const streamUrl = streamInfoResp.headers.get('location') || streamInfoResp.url;
      logger.info(`Got stream URL for HLS transcoding: ${streamUrl}`);

      // Start ffmpeg transcoding to HLS
      const playlistPath = path.join(hlsDir, 'playlist.m3u8');
      const segmentPattern = path.join(hlsDir, 'segment%03d.ts');

      const ffmpegArgs = [
        '-i', streamUrl,
        '-c:v', 'copy',           // Copy video codec (no re-encoding for speed)
        '-c:a', 'aac',             // Convert audio to AAC for compatibility
        '-b:a', '128k',
        '-f', 'hls',
        '-hls_time', '4',          // 4 second segments
        '-hls_list_size', '10',     // Keep last 10 segments in playlist
        '-hls_flags', 'delete_segments+append_list',
        '-start_number', '0',
        playlistPath
      ];

      logger.info(`Starting ffmpeg with args: ${ffmpegArgs.join(' ')}`);

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Only log important messages (errors, not warnings about bitstream issues)
        if (output.includes('error') || output.includes('failed') || output.includes('Invalid')) {
          logger.error(`[ffmpeg ${sessionKey}] ${output}`);
        } else if (output.includes('frame=')) {
          // Log progress occasionally (every frame info line)
          logger.debug(`[ffmpeg ${sessionKey}] ${output.trim()}`);
        }
        // Skip logging bitstream warnings and timestamp discontinuities - they're normal for live streams
      });

      ffmpegProcess.stdout.on('data', (data) => {
        logger.debug(`[ffmpeg stdout ${sessionKey}] ${data.toString()}`);
      });

      ffmpegProcess.on('error', (error) => {
        logger.error(`ffmpeg error for ${sessionKey}: ${error.message}`);
        cleanupHLSSession(sessionKey);
      });

      ffmpegProcess.on('exit', (code) => {
        logger.info(`ffmpeg exited for ${sessionKey} with code ${code}`);
        if (code !== 0) {
          logger.error(`ffmpeg failed for ${sessionKey}, cleaning up`);
          cleanupHLSSession(sessionKey);
        }
      });

      hlsSession = {
        ffmpegProcess,
        hlsDir,
        playlistPath,
        lastAccess: Date.now(),
        startTime: Date.now()
      };

      hlsSessions.set(sessionKey, hlsSession);

      // Wait for first segments to be generated (up to 10 seconds)
      let waitTime = 0;
      const maxWait = 10000;
      const checkInterval = 500;

      while (waitTime < maxWait && !fs.existsSync(playlistPath)) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waitTime += checkInterval;
      }

      if (!fs.existsSync(playlistPath)) {
        logger.error(`Playlist not created after ${maxWait}ms for ${sessionKey}`);
        // Check if ffmpeg process is still running
        if (ffmpegProcess.killed) {
          logger.error(`ffmpeg process was killed for ${sessionKey}`);
        }
        // List files in the directory
        if (fs.existsSync(hlsDir)) {
          const files = fs.readdirSync(hlsDir);
          logger.info(`Files in HLS dir: ${files.join(', ')}`);
        }
      } else {
        logger.info(`Playlist created after ${waitTime}ms for ${sessionKey}`);
      }
    }

    // Update last access time
    hlsSession.lastAccess = Date.now();

    // Serve the playlist
    if (fs.existsSync(hlsSession.playlistPath)) {
      logger.info(`Serving playlist for ${sessionKey}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.sendFile(hlsSession.playlistPath);
    } else {
      logger.warn(`Playlist not ready yet for ${sessionKey}, files in dir: ${fs.existsSync(hlsSession.hlsDir) ? fs.readdirSync(hlsSession.hlsDir).join(', ') : 'dir does not exist'}`);
      res.status(503).send('Playlist not ready, please retry');
    }

  } catch (error) {
    logger.error(`Error serving HLS playlist: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /:sessionId/:channelId/segment*.ts
 * Serve HLS segments
 */
router.get('/:sessionId/:channelId/:segment', authMiddleware, (req, res) => {
  try {
    const { sessionId, channelId, segment } = req.params;
    const sessionKey = `${sessionId}_${channelId}`;

    const hlsSession = hlsSessions.get(sessionKey);
    if (!hlsSession) {
      return res.status(404).send('HLS session not found');
    }

    // Update last access time
    hlsSession.lastAccess = Date.now();

    const segmentPath = path.join(hlsSession.hlsDir, segment);

    if (fs.existsSync(segmentPath)) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.sendFile(segmentPath);
    } else {
      logger.warn(`Segment not found: ${segmentPath}`);
      res.status(404).send('Segment not found');
    }

  } catch (error) {
    logger.error(`Error serving HLS segment: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;