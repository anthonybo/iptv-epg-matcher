// routes/download.js
/**
 * Download Route - handles downloading generated files
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { UPLOADS_DIR } = require('../config/constants');

/**
 * GET /api/download/:sessionId
 * Downloads the generated EPG file
 */
router.get('/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const filePath = path.join(UPLOADS_DIR, `${sessionId}-epg.xml`);
  
  if (fs.existsSync(filePath)) {
    logger.debug('Serving EPG download', { sessionId, filePath });
    
    res.download(filePath, 'updated-epg.xml', (err) => {
      if (!err) {
        fs.unlinkSync(filePath);
        logger.debug('Deleted EPG file after download', { filePath });
      } else {
        logger.error('Download failed', { error: err.message, stack: err.stack });
      }
    });
  } else {
    logger.error('EPG file not found for download', { sessionId, filePath });
    res.status(404).send('File not found');
  }
});

module.exports = router;
