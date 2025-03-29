// config/logger.js
const winston = require('winston');
const path = require('path');

/**
 * Winston logger configuration
 * Logs to console and file with timestamp and formatted metadata
 */
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
      const metaString = Object.keys(metadata).length ? ' ' + JSON.stringify(metadata) : '';
      return `${timestamp} [${level}]: ${message}${metaString}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(__dirname, '../logs/app.log') })
  ]
});

module.exports = logger;