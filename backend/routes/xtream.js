// routes/xtream.js
/**
 * Xtream Routes - handles Xtream API compatibility
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getSession } = require('../utils/storageUtils');

/**
 * GET /api/xtream/:sessionId/get.php
 * Xtream-compatible endpoint for M3U playlist
 */
router.get('/:sessionId/get.php', (req, res) => {
  const { sessionId } = req.params;
  const { username, password } = req.query;
  
  const session = getSession(sessionId);
  if (session && username && password) {
    logger.debug('Serving XTREAM M3U', { sessionId, username });
    res.set('Content-Type', 'text/plain');
    res.send(session.m3u);
  } else {
    logger.error('Invalid credentials or session for XTREAM M3U', { sessionId, username });
    res.status(403).send('Invalid credentials or session');
  }
});

/**
 * GET /api/xtream/:sessionId/xmltv.php
 * Xtream-compatible endpoint for EPG data
 */
router.get('/:sessionId/xmltv.php', (req, res) => {
  const { sessionId } = req.params;
  const { username, password } = req.query;
  
  const session = getSession(sessionId);
  if (session && username && password) {
    logger.debug('Serving XTREAM EPG', { sessionId, username });
    res.set('Content-Type', 'application/xml');
    res.send(session.epg);
  } else {
    logger.error('Invalid credentials or session for XTREAM EPG', { sessionId, username });
    res.status(403).send('Invalid credentials or session');
  }
});

/**
 * GET /api/xtream/:sessionId/player_api.php
 * Xtream-compatible endpoint for player API
 */
router.get('/:sessionId/player_api.php', (req, res) => {
  const { sessionId } = req.params;
  const { username, password } = req.query;
  
  const session = getSession(sessionId);
  if (session && username && password) {
    logger.debug('Serving XTREAM player API', { sessionId, username });
    
    // Generate minimal player API response
    const response = {
      user_info: {
        username,
        password,
        status: "Active",
        exp_date: "Unlimited",
        is_trial: "0",
        active_cons: "1",
        max_connections: "1",
        allowed_output_formats: ["m3u8", "ts"]
      },
      server_info: {
        url: `http://localhost:5001/api/xtream/${sessionId}`,
        port: "80",
        https_port: "443",
        server_protocol: "http"
      }
    };
    
    res.json(response);
  } else {
    logger.error('Invalid credentials or session for XTREAM player API', { sessionId, username });
    res.status(403).json({ error: 'Invalid credentials or session' });
  }
});

module.exports = router;