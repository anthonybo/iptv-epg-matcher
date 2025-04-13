/**
 * Routes index file
 * Exports all application routes
 */
const express = require('express');
const router = express.Router();
const epgRoutes = require('./epg');
const m3uRoutes = require('./m3u');
const settingsRoutes = require('./settings');

// Add EPG routes
router.use('/epg', epgRoutes);

// Add M3U routes
router.use('/channels', m3uRoutes);

// Add Settings routes
router.use('/settings', settingsRoutes);

// Health check route
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

module.exports = router; 