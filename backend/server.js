/**
 * Main server entry point for IPTV EPG Matcher
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('./config/logger');
const { CACHE_DIR } = require('./config/constants');
const { setupPeriodicCleanup } = require('./utils/cacheCleanup');

// Add this near the top of server.js
if (process.env.NODE_ENV === 'production') {
  // Enable garbage collection exposure when running with --expose-gc
  global.gc = global.gc || (() => {
    logger.warn('Garbage collection not available. Run node with --expose-gc');
  });
}

// Ensure cache directory exists and has correct permissions
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.info(`Created cache directory: ${CACHE_DIR}`);
  }
  const testFile = path.join(CACHE_DIR, 'test.txt');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  logger.info(`Cache directory is writable: ${CACHE_DIR}`);
  
  // Set up periodic cache cleanup (every 24 hours, keep files up to 7 days)
  setupPeriodicCleanup(24, 7);
} catch (e) {
  logger.error(`Cache directory setup failed: ${e.message}`, { stack: e.stack });
}

// Set up upload middleware
const upload = multer({ dest: 'uploads/' });

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Set up global error handling middleware
app.use((req, res, next) => {
  try {
    next();
  } catch (error) {
    logger.error(`Global error handler caught: ${error.message}`, { 
      stack: error.stack,
      path: req.path,
      method: req.method
    });
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Configure memory management for large requests
app.use((req, res, next) => {
  req.setTimeout(120000); // 2 minutes timeout for requests
  res.setTimeout(120000);
  next();
});

// Import routes
const channelRoutes = require('./routes/channels');
const epgRoutes = require('./routes/epg');
const streamRoutes = require('./routes/stream');
const debugRoutes = require('./routes/debug');
const xtreamRoutes = require('./routes/xtream');
const loadRoute = require('./routes/load');
const generateRoute = require('./routes/generate');
const downloadRoute = require('./routes/download');

// Use routes
app.use('/api/channels', channelRoutes);
app.use('/api/epg', epgRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/xtream', xtreamRoutes);
app.use('/api/load', loadRoute);
app.use('/api/generate', generateRoute);
app.use('/api/download', downloadRoute);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Cache stats endpoint
app.get('/api/cache-stats', (req, res) => {
  try {
    const { getDirSize, formatSize } = require('./utils/cacheCleanup');
    const cacheSize = getDirSize(CACHE_DIR);
    
    res.json({
      cacheDirectory: CACHE_DIR,
      cacheSize: cacheSize,
      cacheSizeFormatted: formatSize(cacheSize),
      fileCount: fs.readdirSync(CACHE_DIR).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cache cleanup endpoint (admin use)
app.post('/api/cache-cleanup', (req, res) => {
  try {
    const { cleanupExpiredCache } = require('./utils/cacheCleanup');
    const maxAgeDays = req.body.maxAgeDays || 7;
    
    const result = cleanupExpiredCache(maxAgeDays);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => logger.info(`Backend running on http://localhost:${PORT}`));

// Handle process termination gracefully
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down server');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down server');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`, { stack: error.stack });
  
  // Force garbage collection if available
  if (global.gc) {
    logger.info('Forcing garbage collection after uncaught exception');
    global.gc();
  }
  
  // Don't exit the process for non-critical errors
  if (error.message.includes('ECONNRESET') || 
      error.message.includes('socket hang up') ||
      error.message.includes('write after end')) {
    logger.warn('Non-critical error, continuing execution');
  } else {
    // For critical errors, exit after a delay to allow logging
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
});

module.exports = app;