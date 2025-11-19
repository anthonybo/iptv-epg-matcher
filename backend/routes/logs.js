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

      // Log at appropriate level
      switch (level) {
        case 'error':
          logger.error(logMessage, context);
          break;
        case 'warn':
          logger.warn(logMessage, context);
          break;
        case 'performance':
        case 'action':
        case 'info':
        default:
          logger.info(logMessage, context);
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
