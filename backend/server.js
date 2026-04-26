/**
 * Main server entry point for IPTV Guru
 */
// Load environment variables from .env file FIRST
require('dotenv').config();

require('./readChunkedCache');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('./config/logger'); // Import logger first
const { CACHE_DIR } = require('./config/constants');
const { storage } = require('./utils/storageUtils'); // Import storage utils
const { setupPeriodicCleanup } = require('./utils/cacheCleanup');
const { eventBus } = require('./utils/eventBus');
const { sendSSEUpdate, registerSSEClient, removeSSEClient } = require('./utils/sseUtils');
const v8 = require('v8');
const http = require('http');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const { ensureCacheDirectory, scheduleCacheCleanup } = require('./services/cacheService');
const { initializeSession } = require('./utils/storageUtils');
const epgService = require('./services/epgService');
const epgParser = require('./services/epgParserService');

// Import EPG Finder to locate any EPG data in memory
const epgFinder = require('./utils/epgFinder');

// Add this after other initial configurations but before setting up middleware
// Ensure data directory exists for SQLite databases
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  logger.info(`Creating data directory: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Session storage - uses abstraction layer (Redis or In-Memory based on USE_REDIS)
logger.info('Initializing session storage');
const sessionStorage = require('./utils/session');
// Clear any existing sessions on server restart
if (storage) {
  Object.keys(storage).forEach(key => {
    sessionStorage.clearSession(key);
  });
} else {
  console.log('[info]: No session storage to clear.');
}

// Configure heap size limits more conservatively
const heapSizeLimit = v8.getHeapStatistics().heap_size_limit;
const heapSizeMB = Math.round(heapSizeLimit / (1024 * 1024));

logger.info(`Node.js heap size limit: ${heapSizeMB} MB`);

// Add periodic memory usage logging
setInterval(() => {
  const memStats = process.memoryUsage();
  const stats = {
    rss: `${Math.round(memStats.rss / 1024 / 1024)} MB`,
    heapTotal: `${Math.round(memStats.heapTotal / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(memStats.heapUsed / 1024 / 1024)} MB`,
    external: `${Math.round(memStats.external / 1024 / 1024)} MB`,
    percentUsed: `${Math.round((memStats.heapUsed / heapSizeLimit) * 100)}%`
  };
  
  logger.info('Memory usage stats before cleanup', stats);
  
  // Force garbage collection if we're using too much memory (more than 75%)
  if (global.gc && (memStats.heapUsed / heapSizeLimit) > 0.75) {
    logger.info('Memory usage high, forcing garbage collection');
    global.gc();
  }
}, 30 * 60 * 1000); // Check every 30 minutes

// DISABLED: Aggressive GC timer - Node.js handles GC automatically
// This was checking every minute and forcing GC, causing performance issues
// let lastGcTime = Date.now();
// setInterval(() => {
//   const timeSinceLastGc = Date.now() - lastGcTime;
//
//   // Enforce GC at least every 5 minutes
//   if (global.gc && timeSinceLastGc > 5 * 60 * 1000) {
//     logger.info('Performing scheduled garbage collection');
//     global.gc();
//     lastGcTime = Date.now();
//   }
// }, 60 * 1000); // Check every minute

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

// Set up upload middleware with size limits
const upload = multer({ 
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
    files: 1 // Only one file at a time
  }
});

// Create Express app
const app = express();

// Store app in global for access from services
global.app = app;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase JSON size limit
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Suppress access logging for high-frequency polling endpoints. These
// log lines aren't useful for diagnostics (the interesting state lives
// in the per-stream lifecycle logs we emit elsewhere) and they drown
// out everything else — HLS playlist polling alone produced ~9.5k
// lines per session, ~60% of the entire log file.
//
// Match by prefix; query strings and IDs are ignored.
const NOISY_LOG_PREFIXES = [
  '/api/stream/hls/',          // hls.js polls index.m3u8 every ~2s + many segs
  '/api/logs/frontend',        // frontend log relay — body is logged separately
  '/api/live-scores',          // ticker poll every 60s per client
  '/api/multiview',            // multi-view state checks
  '/api/iptv/sources',         // source-list refreshes
  '/api/status/session',       // session validation pings
  '/api/metrics/page-view'     // page-view beacons (handler logs them itself)
];
const isNoisyRequest = (req) => {
  const path = req.originalUrl?.split('?')[0] || req.path || '';
  return NOISY_LOG_PREFIXES.some((p) => path.startsWith(p));
};

// Morgan HTTP access log — skips noisy paths only on 2xx. 4xx/5xx on
// the same paths still log so we don't lose visibility on real errors
// (e.g. hls.js requesting a segment that ffmpeg's rolling window has
// already deleted — that 404 IS the diagnostic we need).
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: logger.stream,
  skip: (req, res) => isNoisyRequest(req) && res.statusCode < 400
}));

// Add proper middleware for attaching logger to req
app.use((req, res, next) => {
  req.logger = logger;
  next();
});

// Custom [REQUEST] log — same skip rule.
app.use((req, res, next) => {
  if (!isNoisyRequest(req)) {
    logger.info(`[REQUEST] ${req.method} ${req.originalUrl} from ${req.ip}`);
  }

  // Response body is logged at debug level only; doesn't show up in
  // the normal log stream but still useful when DEBUG is on. Skip the
  // noisy paths there too so a debug session isn't drowned either.
  if (!isNoisyRequest(req)) {
    const originalSend = res.send;
    res.send = function(data) {
      logger.debug(`RESPONSE: ${req.method} ${req.originalUrl} - Status: ${res.statusCode}`, {
        responseData: typeof data === 'string' && data.length < 1000 ? data : 'Too large to log'
      });
      return originalSend.apply(this, arguments);
    };
  }

  next();
});

// Add metrics tracking middleware
const metricsService = require('./services/metricsService');
app.use((req, res, next) => {
  // Track request metrics
  const originalSend = res.send;
  const originalJson = res.json;
  const originalEnd = res.end;

  const trackRequest = () => {
    const success = res.statusCode < 400;
    const endpoint = req.route ? req.route.path : req.path;
    metricsService.trackRequest(endpoint, success);
  };

  res.send = function(...args) {
    trackRequest();
    return originalSend.apply(this, args);
  };

  res.json = function(...args) {
    trackRequest();
    return originalJson.apply(this, args);
  };

  res.end = function(...args) {
    trackRequest();
    return originalEnd.apply(this, args);
  };

  next();
});

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
  req.setTimeout(300000); // 5 minutes timeout for requests
  res.setTimeout(300000); // 5 minutes for response
  next();
});

// Add cache directory initialization before loading EPG data
// Remove duplicate declarations of path and fs
// const path = require('path'); - already declared at the top
// const fs = require('fs'); - already declared at the top

// Initialize cache directories
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  logger.info(`Creating cache directory: ${cacheDir}`);
  fs.mkdirSync(cacheDir, { recursive: true });
}

const chunksDir = path.join(cacheDir, 'chunks');
if (!fs.existsSync(chunksDir)) {
  logger.info(`Creating chunks directory: ${chunksDir}`);
  fs.mkdirSync(chunksDir, { recursive: true });
}

// Load EPG data in the background
setTimeout(async () => {
  try {
    const { EXTERNAL_EPG_URLS } = require('./config/constants');
    const { loadAllExternalEPGs } = require('./services/epgService');
    
    if (!EXTERNAL_EPG_URLS || EXTERNAL_EPG_URLS.length === 0) {
      logger.warn('No EPG sources defined in constants.js');
      return;
    }
    
    logger.info(`Loading EPG data from ${EXTERNAL_EPG_URLS.length} sources with unlimited channels`);
    const result = await loadAllExternalEPGs(null, {
      maxChannelsPerSource: 0, // No limit - process all channels
      forceRefresh: false
    });
    
    // Check if result is valid
    if (result && Array.isArray(result)) {
      const successCount = result.filter(r => r && r.success).length;
      const totalChannels = result.reduce((sum, src) => sum + (src && src.channels ? src.channels.length : 0), 0);
      
      logger.info(`Successfully loaded ${successCount} EPG sources with ${totalChannels} channels in the background`);
    } else {
      logger.warn('Unexpected result from loadAllExternalEPGs:', result);
    }
  } catch (error) {
    logger.error('Failed to load EPG data in the background', { error: error.message, stack: error.stack });
  }
}, 10000); // Wait 10 seconds after server start to begin loading

// Add middleware to validate session IDs
app.use(['/api/channels/:sessionId', '/api/channels/:sessionId/categories'], (req, res, next) => {
  const { sessionId } = req.params;
  
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.warn(`Invalid session ID received: ${sessionId}`);
    return res.status(400).json({ 
      error: 'Invalid session', 
      message: 'A valid session ID is required',
      code: 'INVALID_SESSION'
    });
  }
  
  // Check in BOTH session systems
  const sessionExists = sessionStorage.getSession(sessionId) || 
                        (app.locals.sessions && app.locals.sessions[sessionId]);
                        
  if (!sessionExists) {
    logger.warn(`Session not found in either storage system: ${sessionId}`);
    
    // Try to create the session instead of failing
    try {
      logger.info(`Auto-creating missing session: ${sessionId}`);
      
      // Create in sessionStorage
      sessionStorage.createSession(sessionId, {
        channels: [],
        categories: []
      });
      
      // Create in app.locals.sessions
      if (!app.locals.sessions[sessionId]) {
        app.locals.sessions[sessionId] = {
          id: sessionId,
          created: new Date(),
          lastAccessed: new Date(),
          clients: [],
          channels: [],
          categories: []
        };
      }
      
      // Continue now that we've created the session
      return next();
    } catch (error) {
      logger.error(`Failed to auto-create session ${sessionId}:`, error);
      return res.status(404).json({ 
        error: 'Session not found', 
        message: 'The requested session does not exist and could not be created',
        code: 'SESSION_NOT_FOUND'
      });
    }
  }
  
  next();
});

// Clear require cache for routes in development to ensure fresh code loads
if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
  const routesToClear = [
    './routes/generate',
    './routes/liveEvents',
    './routes/epg',
    './routes/xtream'
  ];

  routesToClear.forEach(route => {
    const fullPath = require.resolve(route);
    if (require.cache[fullPath]) {
      logger.info(`Clearing require cache for ${route}`);
      delete require.cache[fullPath];
    }
  });
}

// Import routes
const authRoutes = require('./routes/auth');
const channelRoutes = require('./routes/channels');
const epgRoutes = require('./routes/epg');
const streamRoutes = require('./routes/stream');
const debugRoutes = require('./routes/debug');
const xtreamRoutes = require('./routes/xtream');
const loadRoute = require('./routes/load');
const generateRoute = require('./routes/generate');
const downloadRoute = require('./routes/download');
const apiRoutes = require('./routes/api');
const indexRouter = require('./routes/index');
const m3uRouter = require('./routes/m3u');
const settingsRouter = require('./routes/settings');
const iptvRoutes = require('./routes/iptv');
const iptvSourcesRoutes = require('./routes/iptvSources');
const userEpgSourcesRoutes = require('./routes/userEpgSources');
const epgRefreshRoutes = require('./routes/epgRefresh');
const liveEventsRoutes = require('./routes/liveEvents');
const multiviewRoutes = require('./routes/multiview');
const metricsRoutes = require('./routes/metrics');
const logsRoutes = require('./routes/logs');
const userLocationsRoutes = require('./routes/userLocations');
const liveScoresRoutes = require('./routes/liveScores');

// In case settings.js is missing or has errors, provide a fallback
if (!settingsRouter || typeof settingsRouter !== 'function') {
  logger.warn('Settings router not found or invalid, using fallback');
  // Create an Express router as a fallback
  const express = require('express');
  const fallbackRouter = express.Router();
  
  // Basic endpoints to prevent crashes
  fallbackRouter.get('/', (req, res) => {
    res.json({ message: 'Settings API - Fallback Mode' });
  });
  
  fallbackRouter.get('/:key', (req, res) => {
    res.json({ key: req.params.key, value: null, fallback: true });
  });
  
  fallbackRouter.post('/:key', (req, res) => {
    res.json({ success: true, message: 'Setting saved (fallback mode)', key: req.params.key });
  });
  
  // Use the fallback if needed
  if (!settingsRouter) {
    logger.info('Using fallback settings router');
    settingsRouter = fallbackRouter;
  }
}

// Use routes
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/epg', epgRoutes);
// HLS-for-player router must come before the generic /api/stream router so
// /api/stream/hls/* doesn't get swallowed by the catch-all `:sessionId/:channelId`
// segment serving in stream.js (which is for Chromecast).
app.use('/api/stream/hls', require('./routes/streamHls'));
app.use('/api/stream', streamRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/xtream', xtreamRoutes);
app.use('/api/load', loadRoute);
app.use('/api/generate', generateRoute);
app.use('/api/download', downloadRoute);
app.use('/api', apiRoutes);
app.use('/api', indexRouter);
app.use('/api/m3u', m3uRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/iptv', iptvRoutes);
app.use('/api/iptv', iptvSourcesRoutes); // Multi-IPTV source management
app.use('/api/user-epg-sources', userEpgSourcesRoutes); // User EPG sources management
app.use('/api/epg-refresh', epgRefreshRoutes); // EPG refresh management
app.use('/api/live-events', liveEventsRoutes); // Live sports events management
app.use('/api/multiview', multiviewRoutes); // Multiview streams management
app.use('/api/metrics', metricsRoutes); // Real-time metrics and monitoring
app.use('/api/logs', logsRoutes); // Frontend logging endpoint
app.use('/api/user/locations', userLocationsRoutes); // User locations for local news
app.use('/api/live-scores', liveScoresRoutes); // Live sports scores

// Create dedicated SSE route for real-time updates
app.use('/api/stream-updates', require('./routes/sse'));

// Import routes for streaming
app.use('/stream', require('./routes/stream'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Get server network IP address (for Chromecast support)
app.get('/api/network-info', (req, res) => {
  try {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    const addresses = [];

    // Find all non-internal IPv4 addresses
    Object.keys(networkInterfaces).forEach(interfaceName => {
      networkInterfaces[interfaceName].forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push({
            interface: interfaceName,
            address: iface.address,
            netmask: iface.netmask
          });
        }
      });
    });

    // Return the first valid address, or localhost if none found
    const primaryAddress = addresses.length > 0 ? addresses[0].address : 'localhost';

    res.json({
      primaryAddress,
      allAddresses: addresses,
      hostname: os.hostname()
    });
  } catch (error) {
    logger.error('Error getting network info:', error);
    res.status(500).json({ error: error.message });
  }
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

// Set up event listener for SSE updates - Keep this but modify it
eventBus.on('sse:update', ({ sessionId, data }) => {
  // Use the sseService instead of the old mechanism
  if (app && app.locals && app.locals.sessions && app.locals.sessions[sessionId]) {
    const sseService = require('./services/sseService');
    sseService.broadcastToSession(app, sessionId, data.type, data);
  } else {
    // Fallback to the old method if needed
    const { broadcastSSEUpdate } = require('./utils/sseUtils');
    broadcastSSEUpdate(data, sessionId);
  }
});

// Integrate the sessionStorage into app.locals.sessions for compatibility
// Add this code to ensure compatibility between the two session systems
const sessions = sessionStorage.getAllSessions();

// Initialize app.locals.sessions and copy existing sessions from sessionStorage
app.locals.sessions = app.locals.sessions || {};
Object.keys(sessions).forEach(sessionId => {
  const session = sessions[sessionId];
  if (!app.locals.sessions[sessionId]) {
    app.locals.sessions[sessionId] = {
      id: sessionId,
      created: new Date(),
      lastAccessed: new Date(),
      clients: [],
      channels: session.channels || [],
      categories: session.categories || []
    };
    logger.info(`Migrated session from sessionStorage: ${sessionId}`);
  }
});

// Add this code right before setting up the sseService routes
// Special CORS handling for SSE connections
app.use('/api/stream-updates/:sessionId', (req, res, next) => {
  // Set CORS headers specifically for SSE
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  logger.debug(`SSE request from origin: ${req.headers.origin}`);
  next();
});

// Setup SSE route before other route handlers
const sseService = require('./services/sseService');
sseService.setupSseRoutes(app);

// After setting up the sseService, add this code to sync session systems
// This will ensure both session mechanisms work together

// Add a function to periodically sync sessions between systems
async function syncSessionSystems() {
  try {
    // First, migrate from sessionStorage to app.locals.sessions
    const sessions = await sessionStorage.getAllSessions() || {};
    Object.keys(sessions).forEach(sessionId => {
      const session = sessions[sessionId];
      if (!app.locals.sessions[sessionId]) {
        app.locals.sessions[sessionId] = {
          id: sessionId,
          created: session.createdAt || new Date(),
          lastAccessed: session.lastAccessed || new Date(),
          clients: [],
          channels: session.channels || [],
          categories: session.categories || []
        };
        logger.debug(`Migrated session from sessionStorage to app.locals: ${sessionId}`);
      }
    });

    // Then, migrate from app.locals.sessions to sessionStorage
    for (const sessionId of Object.keys(app.locals.sessions)) {
      const session = app.locals.sessions[sessionId];
      if (!sessions[sessionId]) {
        try {
          await sessionStorage.createSession(sessionId, {
            channels: session.channels || [],
            categories: session.categories || []
          });
          logger.debug(`Migrated session from app.locals to sessionStorage: ${sessionId}`);
        } catch (err) {
          logger.error(`Failed to migrate session ${sessionId}:`, err);
        }
      }
    }

    logger.debug('Session synchronization complete');
  } catch (error) {
    logger.error('Error synchronizing session systems:', error);
  }
}

// Run sync immediately
syncSessionSystems();

// Set up periodic sync - reduced from 30s to 5 minutes for better performance
setInterval(syncSessionSystems, 5 * 60 * 1000); // Sync every 5 minutes

// Add the API events endpoint near the event bus listener for SSE
// Set up the events endpoint for SSE
app.get('/api/events/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  // Validate session id
  if (!sessionId) {
    logger.error('SSE connection attempted without session ID');
    return res.status(400).send('Session ID is required');
  }
  
  logger.info(`SSE connection request for session ${sessionId}`);
  
  // Set up SSE connection headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // For NGINX proxy
  
  // Add explicit CORS headers
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Send headers immediately
  res.flushHeaders();
  
  // Write initial comment to establish connection
  res.write(':ok\n\n');
  
  // Send a test event to confirm connection works
  const testData = {
    type: 'progress',
    message: 'Connected to server event stream',
    timestamp: new Date().toISOString(),
    percentage: 0
  };
  res.write(`data: ${JSON.stringify(testData)}\n\n`);
  
  // Store client for sending future updates
  if (!app.locals.sessions) {
    app.locals.sessions = {};
  }
  
  // Create session if it doesn't exist
  if (!app.locals.sessions[sessionId]) {
    app.locals.sessions[sessionId] = {
      id: sessionId,
      created: new Date(),
      lastAccessed: new Date(),
      clients: [],
      channels: [],
      categories: []
    };
    logger.info(`Created new session for SSE: ${sessionId}`);
  }
  
  // Add this client to the session
  const clientId = Date.now().toString(36) + Math.random().toString(36).substring(2);
  const client = {
    id: clientId,
    send: (type, data) => {
      if (!res.writableEnded) {
        try {
          logger.info(`[SSE SEND] Sending to client ${clientId}: type=${type}, data.type=${data.type}`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
          logger.info(`[SSE SEND] Write successful for client ${clientId}`);
        } catch (error) {
          logger.error(`Error sending event to client ${clientId}:`, error);
        }
      } else {
        logger.warn(`[SSE SEND] Cannot send to client ${clientId} - connection ended`);
      }
    },
    res
  };
  
  app.locals.sessions[sessionId].clients.push(client);
  app.locals.sessions[sessionId].lastAccessed = new Date();
  
  logger.info(`Added client ${clientId} to session ${sessionId}`);
  
  // Set up a heartbeat to keep the connection alive
  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(':heartbeat\n\n');
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000); // Every 30 seconds
  
  // Handle client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    
    // Remove client from session
    if (app.locals.sessions[sessionId]) {
      const { clients } = app.locals.sessions[sessionId];
      const clientIndex = clients.findIndex(c => c.id === clientId);
      if (clientIndex !== -1) {
        clients.splice(clientIndex, 1);
        logger.info(`Removed client ${clientId} from session ${sessionId}`);
      }
    }
    
    logger.info(`SSE connection closed for session ${sessionId}`);
  });
});

// Report current memory usage
function reportMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
  const rss = Math.round(memoryUsage.rss / 1024 / 1024);
  
  logger.info(`Memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB (RSS: ${rss}MB)`);
  
  // Trigger garbage collection if available and heap usage is high (over 80% of total)
  if (global.gc && heapUsedMB > heapTotalMB * 0.8) {
    logger.info('High memory usage detected, triggering garbage collection');
    global.gc();
    
    // Report memory usage after GC
    const afterGC = process.memoryUsage();
    const afterHeapUsedMB = Math.round(afterGC.heapUsed / 1024 / 1024);
    const afterHeapTotalMB = Math.round(afterGC.heapTotal / 1024 / 1024);
    logger.info(`Memory after GC: ${afterHeapUsedMB}MB / ${afterHeapTotalMB}MB`);
  }
}

// Log node memory limit
const memoryLimit = process.argv.find(arg => arg.includes('--max-old-space-size='));
if (memoryLimit) {
  const limitMB = memoryLimit.split('=')[1];
  logger.info(`Node.js heap size limit: ${limitMB} MB`);
} else {
  logger.info('Node.js using default heap size limit');
}

// Schedule periodic memory usage reporting
setInterval(reportMemoryUsage, 5 * 60 * 1000); // Every 5 minutes

// Schedule periodic garbage collection
if (global.gc) {
  setInterval(() => {
    logger.debug('Running scheduled garbage collection');
    global.gc();
  }, 10 * 60 * 1000); // Every 10 minutes
}

// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => logger.info(`Backend running on http://localhost:${PORT}`));

// Handle process termination gracefully
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down server');

  // Flush metrics queue before exit
  await metricsService.shutdown();

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down server');

  // Flush metrics queue before exit
  await metricsService.shutdown();

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

// Share EPG data globally
global.makeEpgDataAccessible = () => {
  const startTime = Date.now();
  logger.info('Setting up global EPG data access');
  
  // Function to recursively search for EPG data
  const findEpgData = (obj, path = 'global') => {
    if (!obj || typeof obj !== 'object') return null;
    
    // Check if this object directly has channels
    if (obj.channels && Array.isArray(obj.channels) && obj.channels.length > 0) {
      logger.info(`Found EPG channels at ${path}: ${obj.channels.length} channels`);
      return { type: 'direct', source: obj, path };
    }
    
    // Check if this is a container of sources
    let bestSource = null;
    let maxChannels = 0;
    
    // Skip checking some known complex objects that can cause issues
    if (path.includes('socket') || path.includes('require.cache')) {
      return null;
    }
    
    // If this is an object with properties, check each property
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      let sourceCount = 0;
      let totalChannels = 0;
      
      for (const key in obj) {
        try {
          const val = obj[key];
          
          // Skip functions and null values
          if (typeof val === 'function' || val === null) continue;
          
          // Check if this is an EPG source with channels
          if (val && typeof val === 'object' && val.channels && Array.isArray(val.channels)) {
            sourceCount++;
            totalChannels += val.channels.length;
            
            // Keep track of the largest source
            if (val.channels.length > maxChannels) {
              maxChannels = val.channels.length;
              bestSource = { type: 'source', source: val, path: `${path}.${key}` };
            }
          }
        } catch (e) {
          // Ignore errors in accessing properties
        }
      }
      
      // If we found multiple sources, this might be a sources container
      if (sourceCount > 1) {
        logger.info(`Found potential EPG sources container at ${path}: ${sourceCount} sources with ${totalChannels} channels`);
        return { type: 'container', source: obj, path, sourceCount, totalChannels };
      }
    }
    
    return bestSource;
  };
  
  // Start by checking common locations
  const epgSourcesLocations = [
    global._loadedEpgSources,
    global.epgSources,
    global._epgCache
  ];
  
  // Try direct known locations first
  for (const location of epgSourcesLocations) {
    if (location) {
      const result = findEpgData(location);
      if (result) {
        logger.info(`Found EPG data in known location: ${result.path}`);
        global._directEpgAccess = result.source;
        
        // If this is the epgService export
        if (epgService && !epgService._directSourceAccess) {
          epgService._directSourceAccess = result.source;
        }
        
        return result.source;
      }
    }
  }
  
  // If not found, scan the entire global object
  for (const key in global) {
    try {
      if (Date.now() - startTime > 5000) {
        logger.warn('EPG data search timeout after 5000ms');
        break;
      }
      
      const result = findEpgData(global[key], `global.${key}`);
      if (result) {
        logger.info(`Found EPG data in global.${key}`);
        global._directEpgAccess = result.source;
        
        // If we found a container of sources
        if (result.type === 'container') {
          global._epgSourcesContainer = result.source;
          
          // Store in epgService for access
          if (epgService) {
            epgService._directSourceAccess = result.source;
          }
        }
        
        return result.source;
      }
    } catch (e) {
      // Ignore errors in accessing global properties
    }
  }
  
  // Force create a centralized place to store EPG data
  if (!global._centralEpgData) {
    global._centralEpgData = {
      sources: {},
      addSource: function(url, source) {
        this.sources[url] = source;
        logger.info(`Added EPG source to central store: ${url}`);
      }
    };
  }
  
  logger.info('EPG data scan complete, results stored for direct access');
  return null;
};

// DISABLED: These EPG scanners were causing 400%+ CPU usage by scanning the entire global object every minute
// Run the data accessibility setup ONCE on startup only
global.makeEpgDataAccessible();

// DISABLED: Periodic EPG scanner - was causing massive performance issues
// setInterval(() => {
//   if (!global._directEpgAccess) {
//     global.makeEpgDataAccessible();
//   }
// }, 60000); // Check every minute

// Set up EPG data finder - find any loaded EPG data and expose it ONCE on startup
logger.info('Initializing EPG data finder');
epgFinder.findAndExposeEpgData();

// DISABLED: Second periodic EPG scanner - was duplicating work and causing CPU spikes
// setInterval(() => {
//   if (!global._directEpgAccess) {
//     logger.info('Periodic EPG data scan triggered');
//     epgFinder.findAndExposeEpgData();
//   }
// }, 60000);

// Initialize database on startup
(async () => {
  try {
    // Initialize PostgreSQL EPG database service
    const epgDatabaseService = require('./services/epgDatabaseService');
    const epgQueryService = require('./services/epgQueryService');
    await epgDatabaseService.init();
    logger.info('EPG database initialized successfully (PostgreSQL)');

    // Get database stats
    const stats = await epgQueryService.getDatabaseStats();
    logger.info(`Database contains ${stats.channelCount} channels and ${stats.programCount} programs`);

    // Initialize IPTV database - uses abstraction layer (PostgreSQL or SQLite based on USE_POSTGRES)
    const iptvDb = require('./services/iptvDatabase');
    await iptvDb.connect();
    logger.info(`IPTV database initialized successfully (${iptvDb.getDatabaseType()})`);
    
    // If database is empty and EPG sources exist, parse them
    if (stats.channelCount === 0) {
      logger.info('Database is empty, checking for EPG sources to parse');
      
      // Check settings for EPG URLs or check filesystem for local EPG files
      const settingsPath = path.join(__dirname, 'data', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          if (settings.epgUrls && settings.epgUrls.length > 0) {
            logger.info(`Found ${settings.epgUrls.length} EPG URLs in settings, starting parsing`);
            
            // Parse each EPG URL
            for (const url of settings.epgUrls) {
              logger.info(`Parsing EPG from URL: ${url}`);
              epgParser.parseEpgFromUrl(url)
                .then(result => {
                  logger.info(`Parsed EPG from ${url}: ${result.channelCount} channels, ${result.programCount} programs in ${result.parseTimeSec}s`);
                })
                .catch(err => {
                  logger.error(`Error parsing EPG from ${url}: ${err.message}`);
                });
            }
          }
        } catch (error) {
          logger.error(`Error reading settings file: ${error.message}`);
        }
      }
      
      // Check for local EPG files in the data directory
      const epgDirectory = path.join(__dirname, 'data', 'epg');
      if (fs.existsSync(epgDirectory)) {
        const files = fs.readdirSync(epgDirectory);
        const xmlFiles = files.filter(file => file.endsWith('.xml') || file.endsWith('.xml.gz'));
        
        if (xmlFiles.length > 0) {
          logger.info(`Found ${xmlFiles.length} local EPG files, starting parsing`);
          
          // Parse each EPG file
          for (const file of xmlFiles) {
            const filePath = path.join(epgDirectory, file);
            logger.info(`Parsing EPG from file: ${filePath}`);
            epgParser.parseEpgFromFile(filePath)
              .then(result => {
                logger.info(`Parsed EPG from ${file}: ${result.channelCount} channels, ${result.programCount} programs in ${result.parseTimeSec}s`);
              })
              .catch(err => {
                logger.error(`Error parsing EPG from ${file}: ${err.message}`);
              });
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Database initialization failed: ${error.message}`);
  }
})();

// Set up automatic EPG refresh schedule
const cron = require('node-cron');
const { EPG_AUTO_REFRESH_ENABLED, EPG_AUTO_REFRESH_CRON } = require('./config/constants');
const epgParserService = require('./services/epgParserService');
const epgDatabaseService = require('./services/epgDatabaseService');

if (EPG_AUTO_REFRESH_ENABLED) {
  logger.info(`Setting up automatic EPG refresh schedule: ${EPG_AUTO_REFRESH_CRON}`);

  cron.schedule(EPG_AUTO_REFRESH_CRON, async () => {
    logger.info('Starting scheduled EPG refresh');

    try {
      const results = await epgParserService.parseAllSources({ force: true });

      const successful = results.summary.successfulSources;
      const total = results.summary.totalSources;
      logger.info(`EPG refresh completed: ${successful}/${total} sources successful`);

      // Log database stats after refresh
      const stats = await epgDatabaseService.getStats();
      logger.info(`Database now contains ${stats.sources} sources, ${stats.channels} channels, and ${stats.programs} programs`);
    } catch (error) {
      logger.error(`Scheduled EPG refresh failed: ${error.message}`);
    }
  });

  logger.info('Automatic EPG refresh schedule configured successfully');
} else {
  logger.info('Automatic EPG refresh is disabled in configuration');
}

// Set up automatic live events refresh schedule
// Run daily at 6 AM to fetch upcoming sports events
const liveEventsService = require('./services/liveEventsService');
// Live events table needs to stay current as today's games progress —
// daily-at-6am missed any game that started after the cron tick (and
// any cron miss left us 24h+ stale, which was the "MLB game live but
// not in ticker" symptom). Refresh every 3h plus once on startup.
logger.info('Setting up automatic live events refresh schedule: every 3 hours + on startup');

const runLiveEventsRefresh = async (trigger = 'scheduled') => {
  logger.info(`Starting live events refresh (${trigger})`);
  try {
    const result = await liveEventsService.refreshLiveEvents();
    if (result.success) {
      logger.info(`Live events refresh completed (${trigger}): fetched=${result.totalFetched}, stored=${result.totalStored}, errors=${result.errors}`);
    } else {
      logger.error(`Live events refresh failed (${trigger}): ${result.error}`);
    }
  } catch (error) {
    logger.error(`Live events refresh error (${trigger}): ${error.message}`);
  }
};

cron.schedule('0 */3 * * *', () => runLiveEventsRefresh('cron'));

// Fire once at startup, after a short delay so the DB pool + other
// services are ready. setTimeout instead of awaiting at module load so
// the HTTP server can come up immediately.
setTimeout(() => runLiveEventsRefresh('startup'), 5000);

logger.info('Automatic live events refresh schedule configured successfully');

// Start live scores background updates (every 30 seconds)
const liveScoresService = require('./services/liveScoresService');
liveScoresService.startBackgroundUpdates(30000); // 30 seconds
logger.info('Live scores background updates started (30s interval)');

// Team-alias registry: create the table if missing. Seeding from
// ESPN is a separate script (backend/scripts/seedTeamAliases.js).
const teamAliasesService = require('./services/teamAliasesService');
teamAliasesService.initialize()
    .then(async () => {
        // Seed (or refresh) the alias table once at boot when it looks
        // empty. This is cheap — 15 ESPN requests, ~500 rows upserted —
        // and means fresh installs don't need to manually run the
        // seedTeamAliases script before the matcher is useful.
        try {
            const existing = await teamAliasesService.count();
            if (existing < 100) {
                logger.info(`[TeamAliases] Only ${existing} rows — seeding from ESPN on boot...`);
                const result = await teamAliasesService.seedFromEspn();
                logger.info(
                    `[TeamAliases] Boot seed done: ${result.inserted} upserted, ${result.failed} failed`
                );
            }
        } catch (seedErr) {
            logger.warn(`[TeamAliases] Boot seed skipped: ${seedErr.message}`);
        }

        // Weekly refresh — picks up new teams (e.g. San Diego FC 2025)
        // and any ESPN metadata changes without manual intervention.
        // Runs Sunday 03:00 local time — off-hours for anyone using
        // this for live sports on weekend evenings.
        try {
            cron.schedule('0 3 * * 0', async () => {
                try {
                    logger.info('[TeamAliases] Weekly refresh starting...');
                    const result = await teamAliasesService.seedFromEspn();
                    logger.info(
                        `[TeamAliases] Weekly refresh complete: ${result.inserted} upserted, ${result.failed} failed`
                    );
                } catch (err) {
                    logger.warn(`[TeamAliases] Weekly refresh failed: ${err.message}`);
                }
            });
            logger.info('[TeamAliases] Weekly refresh scheduled (Sunday 03:00)');
        } catch (cronErr) {
            logger.warn(`[TeamAliases] Cron schedule failed: ${cronErr.message}`);
        }
    })
    .catch(err => {
        logger.error(`[TeamAliases] Startup init failed: ${err.message}`);
    });

// Serve static frontend files if build directory exists
const frontendBuildPath = path.join(__dirname, '../frontend/build');
if (fs.existsSync(frontendBuildPath)) {
    logger.info(`Serving frontend from ${frontendBuildPath}`);
    app.use(express.static(frontendBuildPath));
    
    // Handle React routing
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api/')) {
            res.sendFile(path.join(frontendBuildPath, 'index.html'));
        } else {
            res.status(404).json({ error: 'API endpoint not found' });
        }
    });
} else {
    logger.warn(`Frontend build directory not found at ${frontendBuildPath}`);
    
    // Serve a message explaining how to build the frontend
    app.get('/', (req, res) => {
        res.status(200).send(`
            <html>
                <head>
                    <title>IPTV Guru Backend</title>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
                            line-height: 1.6;
                            color: #333;
                            max-width: 800px;
                            margin: 40px auto;
                            padding: 20px;
                        }
                        pre {
                            background-color: #f5f5f5;
                            padding: 15px;
                            border-radius: 5px;
                            overflow-x: auto;
                        }
                        h1 {
                            border-bottom: 1px solid #ddd;
                            padding-bottom: 10px;
                        }
                        .success {
                            color: #2ecc71;
                        }
                    </style>
                </head>
                <body>
                    <h1>IPTV Guru Backend is running! <span class="success">✓</span></h1>
                    <p>The backend server is running correctly, but the frontend build was not found.</p>
                    <p>To build the frontend, run the following commands:</p>
                    <pre>
cd ../frontend
npm install
npm run build
                    </pre>
                    <p>This will create the necessary build files that the backend can serve.</p>
                    <p>For development, you can alternatively run the frontend server separately:</p>
                    <pre>
cd ../frontend
npm install
npm start
                    </pre>
                    <p>API endpoints are available at <a href="/api">/api</a></p>
                </body>
            </html>
        `);
    });
}

module.exports = app;
