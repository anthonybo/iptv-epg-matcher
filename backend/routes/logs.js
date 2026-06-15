/**
 * Logs Routes - Receives and stores frontend logs
 */
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const chalk = require('chalk');

/**
 * POST /frontend
 * Receive logs from frontend
 */
router.post('/frontend', authMiddleware, (req, res) => {
  try {
    const { logs } = req.body;

    if (!logs || !Array.isArray(logs)) {
      return res.status(400).json({ error: 'Invalid logs format' });
    }

    // Process each log entry
    logs.forEach(log => {
      const { level, message, context } = log;
      const user = context?.user?.username || 'anonymous';
      const url = context?.browser?.url || 'unknown';

      // Format log message with color-coded FRONTEND prefix
      const frontendPrefix = chalk.cyan.bold('[FRONTEND]');
      const logMessage = `${frontendPrefix} [${user}] ${message} | URL: ${url}`;

      // Log at the matching level. We deliberately DON'T forward the
      // `context` object to the logger: winston serialises it inline, and
      // frontend error contexts carry full JS stack traces (e.g.
      // "at async handleRefreshAll (…:477)") that flooded the backend
      // console during a refresh-all. The formatted message already
      // carries the user + URL — enough for a relayed frontend line.
      switch (level) {
        case 'error':
          logger.error(logMessage);
          break;
        case 'warn':
          logger.warn(logMessage);
          break;
        case 'performance':
        case 'action':
        case 'info':
        default:
          logger.info(logMessage);
          break;
      }
    });

    res.json({ success: true, received: logs.length });
  } catch (error) {
    logger.error(`Error processing frontend logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to process logs' });
  }
});

module.exports = router;
