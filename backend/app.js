const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

// Add log throttling to prevent console spam
const logCache = new Map();
const throttleLog = (level, message, ttl = 5000) => {
  const key = `${level}:${message}`;
  const now = Date.now();
  const cachedTime = logCache.get(key);
  
  if (!cachedTime || now - cachedTime > ttl) {
    logCache.set(key, now);
    
    // Clean up old entries
    if (logCache.size > 100) {
      const keysToDelete = [];
      for (const [cacheKey, timestamp] of logCache.entries()) {
        if (now - timestamp > ttl) {
          keysToDelete.push(cacheKey);
        }
      }
      keysToDelete.forEach(k => logCache.delete(k));
    }
    
    // Log based on level
    switch (level) {
      case 'error': console.error(message); break;
      case 'warn': console.warn(message); break;
      case 'info': console.info(message); break;
      case 'debug': console.debug(message); break;
      default: console.log(message);
    }
    
    return true;
  }
  
  return false;
};

// Expose to global scope so other modules can use it
global.throttleLog = throttleLog;

// Create Express app
const app = express();

// Configure middleware
app.use(cors());
app.use(express.json());

// Create a custom morgan format that uses our throttled logger
morgan.token('url-no-query', (req) => {
  // Remove query parameters from logged URLs to reduce variability
  return req.url.split('?')[0];
});

// Skip logging for certain repetitive endpoints
app.use(morgan(':method :url-no-query :status :response-time ms', {
  skip: (req) => {
    // Skip logging for frequent polling requests
    if (req.url.includes('/api/epg/') && req.url.includes('/sources') && req.url.includes('_t=')) {
      // Only log these requests once per minute
      return !throttleLog('info', `Skipped logging API request to ${req.url.split('?')[0]}`, 60000);
    }
    return false;
  }
}));

// Routes
const epgRouter = require('./routes/epg');
const playlistRouter = require('./routes/playlist');

app.use('/api/epg', epgRouter);
app.use('/api/playlist', playlistRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

module.exports = app; 