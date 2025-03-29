// routes/generate.js
/**
 * Generate Route - handles generating new XTREAM credentials
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { getSession, generateCredentials, updateSession } = require('../utils/storageUtils');
const { matchChannels, generateEPG, generateM3U } = require('../services/m3uService');
const { UPLOADS_DIR } = require('../config/constants');

/**
 * POST /api/generate
 * Generates new XTREAM credentials based on matched channels
 */
router.post('/', async (req, res) => {
  const { sessionId, matchedChannels } = req.body;
  
  const session = getSession(sessionId);
  if (!session) {
    logger.error('Session not found', { sessionId });
    return res.status(404).send('Session not found');
  }

  try {
    const { channels, epgSources } = session;
    
    // Match channels with EPG data
    const updatedEPG = matchChannels(
      channels, 
      epgSources['XTREAM'] || {}, 
      epgSources[Object.keys(epgSources)[0]] || {}, 
      matchedChannels
    );
    
    // Generate new EPG and M3U content
    const newEPG = generateEPG(updatedEPG);
    const newM3uContent = generateM3U(channels);

    // Generate new credentials
    const { username, password } = generateCredentials();
    
    // Update session with new data
    updateSession(sessionId, { m3u: newM3uContent, epg: newEPG });

    // Generate URLs for the new credentials
    const newXtreamUrl = `http://localhost:5001/api/xtream/${sessionId}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    const newXtreamEpgUrl = `http://localhost:5001/api/xtream/${sessionId}/xmltv.php?username=${username}&password=${password}`;
    
    // Save EPG file for download
    const filePath = path.join(UPLOADS_DIR, `${sessionId}-epg.xml`);
    fs.writeFileSync(filePath, newEPG);

    logger.debug('Generated new XTREAM credentials', { sessionId, username });
    
    res.json({
      xtreamUrl: newXtreamUrl,
      xtreamEpgUrl: newXtreamEpgUrl,
      username,
      password,
      downloadUrl: `/api/download/${sessionId}`
    });
  } catch (error) {
    logger.error('Generate failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;