/**
 * Authentication Middleware
 * Verifies JWT tokens and attaches user information to requests
 */
const authService = require('../services/authService');
const userService = require('../services/userService');
const logger = require('../config/logger');

/**
 * Middleware to verify JWT token and attach user to request
 * This middleware is optional - if no token is provided, the request continues
 * Use requireAuth middleware to enforce authentication
 */
async function authMiddleware(req, res, next) {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authService.extractTokenFromHeader(authHeader);

    if (!token) {
      // No token provided, continue without user
      req.user = null;
      return next();
    }

    // Verify token
    let decoded;
    try {
      decoded = authService.verifyToken(token);
    } catch (error) {
      // Invalid or expired token - log and continue without user
      logger.debug(`Token verification failed: ${error.message}`);
      req.user = null;
      return next();
    }

    // Check if session exists in database
    const session = await userService.findSessionByToken(token);

    if (!session) {
      // Session not found or expired
      logger.debug('Session not found or expired');
      req.user = null;
      return next();
    }

    // Get user information
    const user = await userService.findUserById(decoded.userId);

    if (!user) {
      // User not found
      logger.warn(`User not found for token: ${decoded.userId}`);
      req.user = null;
      return next();
    }

    // Attach user and session to request
    req.user = user;
    req.session = session;
    req.token = token;

    next();
  } catch (error) {
    logger.error(`Auth middleware error: ${error.message}`);
    req.user = null;
    next();
  }
}

/**
 * Middleware to require authentication
 * Returns 401 if user is not authenticated
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'You must be logged in to access this resource'
    });
  }

  next();
}

/**
 * Middleware to optionally authenticate but not require it
 * Useful for routes that have different behavior for authenticated vs non-authenticated users
 */
async function optionalAuth(req, res, next) {
  // Just run the auth middleware - it already handles optional authentication
  await authMiddleware(req, res, next);
}

module.exports = {
  authMiddleware,
  requireAuth,
  optionalAuth
};
