/**
 * Authentication Service
 * Handles password hashing, JWT token generation and validation
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'iptv-epg-matcher-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'; // 7 days default
const BCRYPT_SALT_ROUNDS = 10;

/**
 * Hash a password using bcrypt
 * @param {string} password Plain text password
 * @returns {Promise<string>} Hashed password
 */
async function hashPassword(password) {
  try {
    const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
    const hash = await bcrypt.hash(password, salt);
    return hash;
  } catch (error) {
    logger.error(`Error hashing password: ${error.message}`);
    throw new Error('Failed to hash password');
  }
}

/**
 * Compare a plain text password with a hashed password
 * @param {string} password Plain text password
 * @param {string} hashedPassword Hashed password to compare against
 * @returns {Promise<boolean>} True if passwords match
 */
async function comparePassword(password, hashedPassword) {
  try {
    const isMatch = await bcrypt.compare(password, hashedPassword);
    return isMatch;
  } catch (error) {
    logger.error(`Error comparing password: ${error.message}`);
    throw new Error('Failed to compare password');
  }
}

/**
 * Generate a JWT token for a user
 * @param {Object} user User object
 * @returns {string} JWT token
 */
function generateToken(user) {
  try {
    const payload = {
      userId: user.id,
      username: user.username,
      email: user.email
    };

    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN
    });

    return token;
  } catch (error) {
    logger.error(`Error generating token: ${error.message}`);
    throw new Error('Failed to generate token');
  }
}

/**
 * Verify and decode a JWT token
 * @param {string} token JWT token
 * @returns {Object} Decoded token payload
 */
function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    } else if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid token');
    } else {
      logger.error(`Error verifying token: ${error.message}`);
      throw new Error('Failed to verify token');
    }
  }
}

/**
 * Refresh an access token. Accepts a token that may have JUST expired
 * (within REFRESH_GRACE_SECONDS past `exp`) so the client can silently
 * obtain a fresh one without forcing a full re-login on the weekly
 * expiry. The signature must still verify and the user identity must
 * be intact; we re-issue a brand-new full-lifetime token.
 *
 * Security note: this is a sliding-session model (no separate refresh
 * token). The grace window bounds how long a leaked-but-expired token
 * remains refreshable. A token expired beyond the grace window — or
 * with a bad signature — is rejected, and the client falls back to
 * login. For a stricter posture, swap to dedicated refresh tokens.
 *
 * @param {string} oldToken A current or recently-expired JWT
 * @returns {{ token: string, user: { id, username, email } }}
 * @throws if the token signature is invalid or it's expired past grace
 */
const REFRESH_GRACE_SECONDS = 14 * 24 * 60 * 60; // 14 days past expiry

function refreshToken(oldToken) {
  if (!oldToken) throw new Error('No token provided');

  // ignoreExpiration so a just-expired token still verifies by
  // signature; we enforce our own bounded grace window below.
  let decoded;
  try {
    decoded = jwt.verify(oldToken, JWT_SECRET, { ignoreExpiration: true });
  } catch (error) {
    // Bad signature / malformed — never refreshable.
    throw new Error('Invalid token');
  }

  const now = Math.floor(Date.now() / 1000);
  if (decoded.exp && now > decoded.exp + REFRESH_GRACE_SECONDS) {
    throw new Error('Token expired beyond refresh window');
  }
  if (!decoded.userId) {
    throw new Error('Token missing user identity');
  }

  // Re-issue with the same identity. generateToken reads {id,username,email}.
  const token = generateToken({
    id: decoded.userId,
    username: decoded.username,
    email: decoded.email
  });
  return {
    token,
    user: { id: decoded.userId, username: decoded.username, email: decoded.email }
  };
}

/**
 * Extract token from Authorization header
 * @param {string} authHeader Authorization header value
 * @returns {string|null} Token or null if not found
 */
function extractTokenFromHeader(authHeader) {
  if (!authHeader) {
    return null;
  }

  // Expected format: "Bearer <token>"
  const parts = authHeader.split(' ');

  if (parts.length === 2 && parts[0] === 'Bearer') {
    return parts[1];
  }

  return null;
}

/**
 * Calculate token expiration date
 * @returns {Date} Expiration date
 */
function calculateTokenExpiration() {
  const now = new Date();

  // Parse JWT_EXPIRES_IN (e.g., "7d", "24h", "60m")
  const match = JWT_EXPIRES_IN.match(/^(\d+)([dhm])$/);

  if (!match) {
    // Default to 7 days if format is invalid
    now.setDate(now.getDate() + 7);
    return now;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      now.setDate(now.getDate() + value);
      break;
    case 'h':
      now.setHours(now.getHours() + value);
      break;
    case 'm':
      now.setMinutes(now.getMinutes() + value);
      break;
    default:
      now.setDate(now.getDate() + 7);
  }

  return now;
}

/**
 * Validate password strength
 * @param {string} password Password to validate
 * @returns {Object} Validation result with isValid and message
 */
function validatePassword(password) {
  if (!password || password.length < 6) {
    return {
      isValid: false,
      message: 'Password must be at least 6 characters long'
    };
  }

  if (password.length > 128) {
    return {
      isValid: false,
      message: 'Password must be less than 128 characters'
    };
  }

  return {
    isValid: true,
    message: 'Password is valid'
  };
}

/**
 * Validate email format
 * @param {string} email Email to validate
 * @returns {Object} Validation result with isValid and message
 */
function validateEmail(email) {
  if (!email) {
    return {
      isValid: false,
      message: 'Email is required'
    };
  }

  // Basic email regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email)) {
    return {
      isValid: false,
      message: 'Invalid email format'
    };
  }

  if (email.length > 255) {
    return {
      isValid: false,
      message: 'Email must be less than 255 characters'
    };
  }

  return {
    isValid: true,
    message: 'Email is valid'
  };
}

/**
 * Validate username format
 * @param {string} username Username to validate
 * @returns {Object} Validation result with isValid and message
 */
function validateUsername(username) {
  if (!username) {
    return {
      isValid: false,
      message: 'Username is required'
    };
  }

  if (username.length < 3) {
    return {
      isValid: false,
      message: 'Username must be at least 3 characters long'
    };
  }

  if (username.length > 50) {
    return {
      isValid: false,
      message: 'Username must be less than 50 characters'
    };
  }

  // Allow alphanumeric, underscore, and hyphen
  const usernameRegex = /^[a-zA-Z0-9_-]+$/;

  if (!usernameRegex.test(username)) {
    return {
      isValid: false,
      message: 'Username can only contain letters, numbers, underscores, and hyphens'
    };
  }

  return {
    isValid: true,
    message: 'Username is valid'
  };
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  refreshToken,
  extractTokenFromHeader,
  calculateTokenExpiration,
  validatePassword,
  validateEmail,
  validateUsername
};
