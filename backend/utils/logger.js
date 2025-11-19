/**
 * Logger utility for consistent logging throughout the application
 */
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Define enhanced format with better context
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    if (stack) {
      return `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`;
    }
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

// Console format with colors for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level}: ${message}`;
  })
);

// Daily rotate transport for combined logs
const combinedTransport = new DailyRotateFile({
  filename: path.join(logDir, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '7d', // Keep logs for 7 days
  format: customFormat
});

// Daily rotate transport for error logs
const errorTransport = new DailyRotateFile({
  filename: path.join(logDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxSize: '20m',
  maxFiles: '14d', // Keep error logs for 14 days
  format: customFormat
});

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    // Console output with colors (only in development)
    new winston.transports.Console({
      format: consoleFormat,
      silent: process.env.NODE_ENV === 'production'
    }),

    // Daily rotating combined log
    combinedTransport,

    // Daily rotating error log
    errorTransport
  ],
  // Don't exit on error
  exitOnError: false
});

// Add stream for morgan HTTP logging
logger.stream = {
  write: function(message) {
    logger.info(message.trim());
  }
};

// Helper methods for structured logging
logger.logRequest = (method, url, user = 'anonymous') => {
  logger.info(`[REQUEST] ${method} ${url} from ${user}`);
};

logger.logResponse = (method, url, statusCode, duration) => {
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  logger[level](`[RESPONSE] ${method} ${url} ${statusCode} - ${duration}ms`);
};

logger.logError = (error, context = '') => {
  const message = context ? `${context}: ${error.message}` : error.message;
  logger.error(message, { stack: error.stack });
};

module.exports = logger;