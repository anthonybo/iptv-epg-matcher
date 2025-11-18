/**
 * Metrics Service - Real-time traffic and system monitoring
 * Tracks streams, bandwidth, requests, and system health
 * Stores historical data in database for debugging
 */

const logger = require('../config/logger');
// Metrics continue to use SQLite directly (not migrated to PostgreSQL yet)
const iptvDatabaseService = require('./iptvDatabaseService');

class MetricsService {
  constructor() {
    // Database connection
    this.db = null;
    this.initDatabase();

    // Write queue for batching database operations
    this.writeQueue = [];
    this.isProcessingQueue = false;
    this.maxQueueSize = 100; // Flush when queue hits this size

    // In-memory session cache to reduce DB queries
    this.sessionCache = new Map(); // sessionId -> session data
    this.sessionCacheTimeout = 5 * 60 * 1000; // 5 minutes

    // Active streams tracking
    this.activeStreams = new Map(); // streamKey -> { channel, source, startTime, bytesTransferred, user, ip }

    // Time-series data storage (circular buffer - last 10 minutes)
    // Stores 120 data points (1 point every 5 seconds)
    this.timeSeriesMaxPoints = 120;
    this.timeSeries = {
      bandwidth: [], // { timestamp, uploadBps, downloadBps, uploadMbps, downloadMbps }
      streams: [],   // { timestamp, count }
      requests: [],  // { timestamp, count }
      memory: []     // { timestamp, usedMB, totalMB, percent }
    };

    // Bandwidth tracking
    this.bandwidthStats = {
      totalSent: 0,
      totalReceived: 0,
      streamBandwidth: new Map() // streamKey -> { sent, received, lastUpdate }
    };

    // Request tracking
    this.requestStats = {
      total: 0,
      successful: 0,
      errors: 0,
      lastMinute: [], // Array of timestamps for rate calculation
      byEndpoint: new Map() // endpoint -> { total, errors }
    };

    // SSE connection tracking
    this.sseConnections = 0;

    // Server start time
    this.startTime = Date.now();

    // Cleanup old request timestamps every minute
    setInterval(() => this.cleanupOldRequests(), 60000);

    // Sample and persist metrics every 30 seconds (reduced from 5s to reduce DB load)
    setInterval(() => this.sampleAndPersistMetrics(), 30000);

    // Cleanup old time-series data from database daily
    setInterval(() => this.cleanupOldMetrics(), 24 * 60 * 60 * 1000);

    // Mark inactive sessions every 2 minutes (reduced from 1m)
    setInterval(() => this.markInactiveSessions(), 120000);

    // Flush write queue every 10 seconds or when it hits max size
    setInterval(() => this.flushWriteQueue(), 10000);

    // Clear session cache every 5 minutes
    setInterval(() => this.cleanupSessionCache(), 5 * 60 * 1000);

    logger.info('[MetricsService] Initialized with write queue batching');
  }

  /**
   * Add a write operation to the queue
   * Automatically flushes if queue is full
   */
  queueWrite(query, params = []) {
    this.writeQueue.push({ query, params, timestamp: Date.now() });

    // Auto-flush if queue is getting large
    if (this.writeQueue.length >= this.maxQueueSize) {
      this.flushWriteQueue();
    }
  }

  /**
   * Flush all queued writes in a single transaction
   */
  async flushWriteQueue() {
    if (!this.db || this.writeQueue.length === 0 || this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;
    const batch = [...this.writeQueue];
    this.writeQueue = [];

    try {
      await new Promise((resolve, reject) => {
        this.db.serialize(() => {
          this.db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
              reject(err);
              return;
            }

            let completed = 0;
            let hasError = false;

            batch.forEach(({ query, params }) => {
              this.db.run(query, params, (runErr) => {
                if (runErr && !hasError) {
                  hasError = true;
                  logger.error('[MetricsService] Queue write error:', runErr);
                }
                completed++;

                if (completed === batch.length) {
                  if (hasError) {
                    this.db.run('ROLLBACK', () => reject(new Error('Batch write failed')));
                  } else {
                    this.db.run('COMMIT', (commitErr) => {
                      if (commitErr) reject(commitErr);
                      else resolve();
                    });
                  }
                }
              });
            });
          });
        });
      });

      logger.debug(`[MetricsService] Flushed ${batch.length} writes to database`);
    } catch (error) {
      logger.error('[MetricsService] Failed to flush write queue:', error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Clean up old entries from session cache
   */
  cleanupSessionCache() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessionCache.entries()) {
      if (now - session.last_seen > this.sessionCacheTimeout) {
        this.sessionCache.delete(sessionId);
      }
    }
  }

  /**
   * Initialize database connection and populate cache
   */
  async initDatabase() {
    try {
      this.db = await iptvDatabaseService.connect();
      logger.info('[MetricsService] Database connection initialized');

      // Populate session cache with recent active sessions
      await this.populateSessionCache();
    } catch (error) {
      logger.error('[MetricsService] Failed to initialize database:', error);
    }
  }

  /**
   * Populate session cache from database on startup
   */
  async populateSessionCache() {
    if (!this.db) return;

    try {
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

      const sessions = await new Promise((resolve, reject) => {
        this.db.all(
          `SELECT * FROM metrics_sessions
           WHERE is_active = 1 AND last_seen > ?
           ORDER BY last_seen DESC`,
          [fiveMinutesAgo],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      sessions.forEach(session => {
        this.sessionCache.set(session.session_id, session);
      });

      logger.info(`[MetricsService] Loaded ${sessions.length} active sessions into cache`);
    } catch (error) {
      logger.error('[MetricsService] Failed to populate session cache:', error);
    }
  }

  /**
   * Track when a stream starts
   */
  trackStreamStart(streamKey, info) {
    const streamInfo = {
      streamKey,
      channel: info.channel || 'Unknown',
      channelId: info.channelId,
      source: info.source || 'Unknown',
      sourceId: info.sourceId,
      startTime: Date.now(),
      bytesTransferred: 0,
      user: info.user || null,
      userId: info.userId || null,
      ip: info.ip || 'Unknown',
      type: info.type || 'stream' // 'stream' or 'xtream'
    };

    this.activeStreams.set(streamKey, streamInfo);

    // Initialize bandwidth tracking for this stream
    this.bandwidthStats.streamBandwidth.set(streamKey, {
      sent: 0,
      received: 0,
      lastUpdate: Date.now()
    });

    // Persist to database
    this.persistStreamStart(streamInfo);

    logger.debug(`[MetricsService] Stream started: ${streamKey} (${streamInfo.channel})`);
  }

  /**
   * Persist stream start to database (queued)
   */
  persistStreamStart(streamInfo) {
    if (!this.db) return;

    this.queueWrite(
      `INSERT INTO metrics_streams (
        stream_key, channel_name, channel_id, source_name, source_id,
        stream_type, user_name, user_id, client_ip, start_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        streamInfo.streamKey,
        streamInfo.channel,
        streamInfo.channelId,
        streamInfo.source,
        streamInfo.sourceId,
        streamInfo.type,
        streamInfo.user,
        streamInfo.userId,
        streamInfo.ip,
        streamInfo.startTime
      ]
    );
  }

  /**
   * Track when a stream ends
   */
  trackStreamEnd(streamKey) {
    const streamInfo = this.activeStreams.get(streamKey);
    if (streamInfo) {
      const duration = Date.now() - streamInfo.startTime;
      logger.debug(`[MetricsService] Stream ended: ${streamKey}, duration: ${Math.round(duration / 1000)}s, bytes: ${streamInfo.bytesTransferred}`);

      // Persist to database
      this.persistStreamEnd(streamKey, Date.now(), Math.floor(duration / 1000), streamInfo.bytesTransferred);
    }

    this.activeStreams.delete(streamKey);
    this.bandwidthStats.streamBandwidth.delete(streamKey);
  }

  /**
   * Persist stream end to database (queued)
   */
  persistStreamEnd(streamKey, endTime, durationSeconds, bytesTransferred) {
    if (!this.db) return;

    this.queueWrite(
      `UPDATE metrics_streams
       SET end_time = ?, duration_seconds = ?, bytes_transferred = ?
       WHERE stream_key = ?`,
      [endTime, durationSeconds, bytesTransferred, streamKey]
    );
  }

  /**
   * Track bandwidth for a stream
   */
  trackBandwidth(streamKey, bytesSent, bytesReceived = 0) {
    // Update stream-specific tracking
    const streamBandwidth = this.bandwidthStats.streamBandwidth.get(streamKey);
    if (streamBandwidth) {
      streamBandwidth.sent += bytesSent;
      streamBandwidth.received += bytesReceived;
      streamBandwidth.lastUpdate = Date.now();
    }

    // Update stream info
    const streamInfo = this.activeStreams.get(streamKey);
    if (streamInfo) {
      streamInfo.bytesTransferred += bytesSent;
    }

    // Update totals
    this.bandwidthStats.totalSent += bytesSent;
    this.bandwidthStats.totalReceived += bytesReceived;
  }

  /**
   * Track a request
   */
  trackRequest(endpoint, success = true) {
    this.requestStats.total++;

    if (success) {
      this.requestStats.successful++;
    } else {
      this.requestStats.errors++;
    }

    // Track timestamp for rate calculation
    this.requestStats.lastMinute.push(Date.now());

    // Track by endpoint
    if (!this.requestStats.byEndpoint.has(endpoint)) {
      this.requestStats.byEndpoint.set(endpoint, { total: 0, errors: 0 });
    }
    const endpointStats = this.requestStats.byEndpoint.get(endpoint);
    endpointStats.total++;
    if (!success) {
      endpointStats.errors++;
    }
  }

  /**
   * Track SSE connection count
   */
  updateSSECount(count) {
    this.sseConnections = count;
  }

  /**
   * Track or update a user session (uses cache + queue)
   */
  trackSession(sessionId, userId, userName, page, ip, userAgent) {
    if (!this.db) {
      logger.warn('[MetricsService] Database not initialized, skipping session tracking');
      return;
    }

    const now = Date.now();

    // Check cache first
    const cached = this.sessionCache.get(sessionId);

    if (cached) {
      // Update cache
      cached.last_seen = now;
      cached.current_page = page;
      cached.is_active = 1;

      // Queue database update
      logger.debug(`[MetricsService] Updating session (cached): ${sessionId}, page: ${page}`);
      this.queueWrite(
        `UPDATE metrics_sessions
         SET last_seen = ?, current_page = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`,
        [now, page, sessionId]
      );
    } else {
      // New session - add to cache and queue insert
      logger.info(`[MetricsService] Creating new session: ${sessionId}, user: ${userName}, page: ${page}`);

      const sessionData = {
        session_id: sessionId,
        user_id: userId,
        user_name: userName,
        current_page: page,
        client_ip: ip,
        user_agent: userAgent,
        first_seen: now,
        last_seen: now,
        is_active: 1
      };

      this.sessionCache.set(sessionId, sessionData);

      this.queueWrite(
        `INSERT OR REPLACE INTO metrics_sessions (
          session_id, user_id, user_name, current_page,
          client_ip, user_agent, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, userId, userName, page, ip, userAgent, now, now]
      );
    }
  }

  /**
   * Track a page view (queued)
   */
  trackPageView(sessionId, userId, page) {
    if (!this.db) return;

    const now = Date.now();

    // Record page view
    this.queueWrite(
      `INSERT INTO metrics_page_views (session_id, user_id, page, timestamp)
       VALUES (?, ?, ?, ?)`,
      [sessionId, userId, page, now]
    );

    // Update last page view duration
    this.queueWrite(
      `UPDATE metrics_page_views
       SET duration_seconds = (? - timestamp) / 1000
       WHERE id = (
         SELECT id FROM metrics_page_views
         WHERE session_id = ? AND page != ? AND duration_seconds IS NULL
         ORDER BY timestamp DESC
         LIMIT 1
       )`,
      [now, sessionId, page]
    );
  }

  /**
   * Get active sessions (uses cache for performance)
   */
  getActiveSessions() {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

    // Return from cache - much faster than DB query
    const activeSessions = Array.from(this.sessionCache.values())
      .filter(session => session.is_active === 1 && session.last_seen > fiveMinutesAgo)
      .sort((a, b) => b.last_seen - a.last_seen);

    logger.debug(`[MetricsService] Retrieved ${activeSessions.length} active sessions from cache`);

    return activeSessions;
  }

  /**
   * Mark inactive sessions as inactive (updates cache + queues DB write)
   */
  markInactiveSessions() {
    if (!this.db) return;

    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

    // Update cache first
    for (const [sessionId, session] of this.sessionCache.entries()) {
      if (session.last_seen < fiveMinutesAgo) {
        session.is_active = 0;
      }
    }

    // Queue database update
    this.queueWrite(
      `UPDATE metrics_sessions
       SET is_active = 0
       WHERE last_seen < ?`,
      [fiveMinutesAgo]
    );
  }

  /**
   * Clean up old request timestamps (older than 1 minute)
   */
  cleanupOldRequests() {
    const oneMinuteAgo = Date.now() - 60000;
    this.requestStats.lastMinute = this.requestStats.lastMinute.filter(
      timestamp => timestamp > oneMinuteAgo
    );
  }

  /**
   * Calculate current bandwidth rate (bytes per second)
   */
  getBandwidthRate() {
    const rates = { upload: 0, download: 0 };
    const now = Date.now();

    for (const [streamKey, bandwidth] of this.bandwidthStats.streamBandwidth) {
      const timeSinceUpdate = (now - bandwidth.lastUpdate) / 1000; // seconds

      // Only calculate rate if updated within last 10 seconds
      if (timeSinceUpdate <= 10) {
        rates.upload += bandwidth.sent / Math.max(timeSinceUpdate, 1);
        rates.download += bandwidth.received / Math.max(timeSinceUpdate, 1);
      }
    }

    return {
      uploadBps: Math.round(rates.upload),
      downloadBps: Math.round(rates.download),
      uploadMbps: (rates.upload / 1024 / 1024).toFixed(2),
      downloadMbps: (rates.download / 1024 / 1024).toFixed(2)
    };
  }

  /**
   * Get requests per minute
   */
  getRequestsPerMinute() {
    return this.requestStats.lastMinute.length;
  }

  /**
   * Get system metrics
   */
  getSystemMetrics() {
    const memUsage = process.memoryUsage();
    const uptime = Date.now() - this.startTime;

    return {
      memory: {
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        percentUsed: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1)
      },
      uptime: {
        ms: uptime,
        seconds: Math.floor(uptime / 1000),
        formatted: this.formatUptime(uptime)
      },
      nodejs: {
        version: process.version,
        pid: process.pid
      }
    };
  }

  /**
   * Format uptime into readable string
   */
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Get complete metrics snapshot
   */
  getSnapshot() {
    const bandwidthRate = this.getBandwidthRate();
    const systemMetrics = this.getSystemMetrics();

    // Convert active streams Map to array with formatted data
    const activeStreamsArray = Array.from(this.activeStreams.values()).map(stream => {
      const duration = Date.now() - stream.startTime;
      const bandwidth = this.bandwidthStats.streamBandwidth.get(stream.streamKey);

      return {
        streamKey: stream.streamKey,
        channel: stream.channel,
        channelId: stream.channelId,
        source: stream.source,
        sourceId: stream.sourceId,
        duration: Math.floor(duration / 1000), // seconds
        durationFormatted: this.formatUptime(duration),
        bytesTransferred: stream.bytesTransferred,
        bytesMB: (stream.bytesTransferred / 1024 / 1024).toFixed(2),
        user: stream.user,
        userId: stream.userId,
        ip: stream.ip,
        type: stream.type,
        currentRate: bandwidth ? {
          sent: bandwidth.sent,
          received: bandwidth.received
        } : null
      };
    });

    return {
      timestamp: Date.now(),
      streams: {
        active: this.activeStreams.size,
        list: activeStreamsArray
      },
      bandwidth: {
        total: {
          sent: this.bandwidthStats.totalSent,
          received: this.bandwidthStats.totalReceived,
          sentMB: (this.bandwidthStats.totalSent / 1024 / 1024).toFixed(2),
          receivedMB: (this.bandwidthStats.totalReceived / 1024 / 1024).toFixed(2),
          sentGB: (this.bandwidthStats.totalSent / 1024 / 1024 / 1024).toFixed(2),
          receivedGB: (this.bandwidthStats.totalReceived / 1024 / 1024 / 1024).toFixed(2)
        },
        current: {
          uploadBps: bandwidthRate.uploadBps,
          downloadBps: bandwidthRate.downloadBps,
          uploadMbps: bandwidthRate.uploadMbps,
          downloadMbps: bandwidthRate.downloadMbps
        }
      },
      requests: {
        total: this.requestStats.total,
        successful: this.requestStats.successful,
        errors: this.requestStats.errors,
        errorRate: this.requestStats.total > 0
          ? ((this.requestStats.errors / this.requestStats.total) * 100).toFixed(2)
          : 0,
        perMinute: this.getRequestsPerMinute(),
        byEndpoint: Array.from(this.requestStats.byEndpoint.entries()).map(([endpoint, stats]) => ({
          endpoint,
          total: stats.total,
          errors: stats.errors,
          errorRate: stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(2) : 0
        }))
      },
      connections: {
        sse: this.sseConnections
      },
      system: systemMetrics
    };
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset() {
    this.activeStreams.clear();
    this.bandwidthStats = {
      totalSent: 0,
      totalReceived: 0,
      streamBandwidth: new Map()
    };
    this.requestStats = {
      total: 0,
      successful: 0,
      errors: 0,
      lastMinute: [],
      byEndpoint: new Map()
    };
    this.sseConnections = 0;
    this.startTime = Date.now();

    logger.info('[MetricsService] Metrics reset');
  }

  /**
   * Graceful shutdown - flush queue and close connections
   */
  async shutdown() {
    logger.info('[MetricsService] Shutting down gracefully...');

    // Flush any remaining writes
    await this.flushWriteQueue();

    // Close database connection
    if (this.db) {
      await new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            logger.error('[MetricsService] Error closing database:', err);
          } else {
            logger.info('[MetricsService] Database connection closed');
          }
          resolve();
        });
      });
    }

    logger.info('[MetricsService] Shutdown complete');
  }

  /**
   * Sample current metrics and persist to database
   * Called every 5 seconds
   */
  async sampleAndPersistMetrics() {
    const timestamp = Date.now();
    const bandwidthRate = this.getBandwidthRate();
    const systemMetrics = this.getSystemMetrics();

    // Add to circular buffers
    this.addToTimeSeries('bandwidth', {
      timestamp,
      uploadBps: bandwidthRate.uploadBps,
      downloadBps: bandwidthRate.downloadBps,
      uploadMbps: parseFloat(bandwidthRate.uploadMbps),
      downloadMbps: parseFloat(bandwidthRate.downloadMbps)
    });

    this.addToTimeSeries('streams', {
      timestamp,
      count: this.activeStreams.size
    });

    this.addToTimeSeries('requests', {
      timestamp,
      count: this.getRequestsPerMinute()
    });

    this.addToTimeSeries('memory', {
      timestamp,
      usedMB: systemMetrics.memory.heapUsedMB,
      totalMB: systemMetrics.memory.heapTotalMB,
      percent: parseFloat(systemMetrics.memory.percentUsed)
    });

    // Persist to database (queued for batching)
    if (this.db) {
      // Bandwidth metrics
      this.queueWrite(
        `INSERT INTO metrics_bandwidth (
          timestamp, upload_bps, download_bps, upload_mbps, download_mbps,
          total_sent_bytes, total_received_bytes, active_streams
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          timestamp,
          bandwidthRate.uploadBps,
          bandwidthRate.downloadBps,
          parseFloat(bandwidthRate.uploadMbps),
          parseFloat(bandwidthRate.downloadMbps),
          this.bandwidthStats.totalSent,
          this.bandwidthStats.totalReceived,
          this.activeStreams.size
        ]
      );

      // Request metrics
      const errorRate = this.requestStats.total > 0
        ? ((this.requestStats.errors / this.requestStats.total) * 100).toFixed(2)
        : 0;

      this.queueWrite(
        `INSERT INTO metrics_requests (
          timestamp, total_requests, successful_requests, failed_requests,
          requests_per_minute, error_rate
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          timestamp,
          this.requestStats.total,
          this.requestStats.successful,
          this.requestStats.errors,
          this.getRequestsPerMinute(),
          parseFloat(errorRate)
        ]
      );

      // System metrics
      this.queueWrite(
        `INSERT INTO metrics_system (
          timestamp, memory_used_mb, memory_total_mb, memory_percent,
          heap_used_mb, heap_total_mb, uptime_seconds, nodejs_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          timestamp,
          systemMetrics.memory.rssMB,
          systemMetrics.memory.heapTotalMB,
          parseFloat(systemMetrics.memory.percentUsed),
          systemMetrics.memory.heapUsedMB,
          systemMetrics.memory.heapTotalMB,
          systemMetrics.uptime.seconds,
          systemMetrics.nodejs.version
        ]
      );
    }
  }

  /**
   * Add data point to time-series circular buffer
   */
  addToTimeSeries(type, data) {
    if (!this.timeSeries[type]) return;

    this.timeSeries[type].push(data);

    // Keep only last N points (circular buffer)
    if (this.timeSeries[type].length > this.timeSeriesMaxPoints) {
      this.timeSeries[type].shift();
    }
  }

  /**
   * Get time-series data for graphs
   */
  getTimeSeries(type, minutes = 10) {
    if (!this.timeSeries[type]) return [];

    const cutoffTime = Date.now() - (minutes * 60 * 1000);
    return this.timeSeries[type].filter(point => point.timestamp >= cutoffTime);
  }

  /**
   * Clean up old metrics from database
   * Keeps last 30 days of data
   */
  async cleanupOldMetrics() {
    if (!this.db) return;

    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

    try {
      // Wrap all db.run calls in Promises
      await new Promise((resolve, reject) => {
        this.db.run('DELETE FROM metrics_bandwidth WHERE timestamp < ?', [thirtyDaysAgo], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      await new Promise((resolve, reject) => {
        this.db.run('DELETE FROM metrics_requests WHERE timestamp < ?', [thirtyDaysAgo], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      await new Promise((resolve, reject) => {
        this.db.run('DELETE FROM metrics_system WHERE timestamp < ?', [thirtyDaysAgo], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      await new Promise((resolve, reject) => {
        this.db.run('DELETE FROM metrics_streams WHERE start_time < ? AND end_time IS NOT NULL', [thirtyDaysAgo], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      logger.info('[MetricsService] Cleaned up metrics older than 30 days');
    } catch (error) {
      logger.error('[MetricsService] Failed to cleanup old metrics:', error);
    }
  }
}

// Singleton instance
const metricsService = new MetricsService();

module.exports = metricsService;
