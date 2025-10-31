/**
 * Authentication Routes
 * Handles user registration, login, logout, and session management
 */
const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const authService = require('../services/authService');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const logger = require('../config/logger');

/**
 * POST /api/auth/register
 * Register a new user account
 */
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, sessionId } = req.body;

    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Username, email, and password are required'
      });
    }

    // Create user
    const user = await userService.createUser({
      username,
      email,
      password
    });

    // Generate JWT token
    const token = authService.generateToken(user);

    // Create user session
    const newSessionId = sessionId || `session_${Math.random().toString(36).substring(2, 15)}`;
    await userService.createUserSession(user.id, newSessionId, token);

    // If a session ID was provided, link existing data to this user
    if (sessionId) {
      try {
        const linkResult = await userService.linkSessionDataToUser(user.id, sessionId);
        logger.info(`Linked session data for new user ${user.id}:`, linkResult);
      } catch (linkError) {
        logger.warn(`Failed to link session data for new user: ${linkError.message}`);
        // Don't fail registration if linking fails
      }
    }

    logger.info(`User registered: ${user.username} (ID: ${user.id})`);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt
      },
      token,
      sessionId: newSessionId
    });
  } catch (error) {
    logger.error(`Registration error: ${error.message}`);

    if (error.message.includes('already exists')) {
      return res.status(409).json({
        error: 'User already exists',
        message: error.message
      });
    }

    res.status(500).json({
      error: 'Registration failed',
      message: error.message
    });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and create session
 */
router.post('/login', async (req, res) => {
  try {
    const { usernameOrEmail, password, sessionId } = req.body;

    // Validate required fields
    if (!usernameOrEmail || !password) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Username/email and password are required'
      });
    }

    // Authenticate user
    const user = await userService.authenticateUser(usernameOrEmail, password);

    // Generate JWT token
    const token = authService.generateToken(user);

    // Create user session
    const newSessionId = sessionId || `session_${Math.random().toString(36).substring(2, 15)}`;
    await userService.createUserSession(user.id, newSessionId, token);

    // If a session ID was provided, link existing data to this user
    if (sessionId) {
      try {
        const linkResult = await userService.linkSessionDataToUser(user.id, sessionId);
        logger.info(`Linked session data for user ${user.id}:`, linkResult);
      } catch (linkError) {
        logger.warn(`Failed to link session data: ${linkError.message}`);
        // Don't fail login if linking fails
      }
    }

    logger.info(`User logged in: ${user.username} (ID: ${user.id})`);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        lastLogin: user.lastLogin
      },
      token,
      sessionId: newSessionId
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);

    if (error.message.includes('Invalid username or password')) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid username or password'
      });
    }

    res.status(500).json({
      error: 'Login failed',
      message: 'An error occurred during login'
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout user and invalidate session
 */
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const token = req.token;

    if (!token) {
      return res.status(400).json({
        error: 'No token provided',
        message: 'Cannot logout without an active session'
      });
    }

    // Delete session
    await userService.deleteSession(token);

    logger.info(`User logged out: ${req.user?.username || 'Unknown'}`);

    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    logger.error(`Logout error: ${error.message}`);

    res.status(500).json({
      error: 'Logout failed',
      message: 'An error occurred during logout'
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user information
 */
router.get('/me', authMiddleware, requireAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        createdAt: req.user.createdAt,
        updatedAt: req.user.updatedAt,
        lastLogin: req.user.lastLogin
      }
    });
  } catch (error) {
    logger.error(`Get user error: ${error.message}`);

    res.status(500).json({
      error: 'Failed to get user',
      message: 'An error occurred while fetching user information'
    });
  }
});

/**
 * POST /api/auth/link-session
 * Link an existing anonymous session to the authenticated user
 */
router.post('/link-session', authMiddleware, requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing session ID',
        message: 'Session ID is required'
      });
    }

    // Link session data to user
    const linkResult = await userService.linkSessionDataToUser(req.user.id, sessionId);

    logger.info(`Linked session ${sessionId} to user ${req.user.id}:`, linkResult);

    res.json({
      success: true,
      message: 'Session data linked successfully',
      linked: linkResult
    });
  } catch (error) {
    logger.error(`Link session error: ${error.message}`);

    res.status(500).json({
      error: 'Failed to link session',
      message: error.message
    });
  }
});

/**
 * DELETE /api/auth/cleanup-sessions
 * Clean up expired sessions (admin endpoint)
 */
router.delete('/cleanup-sessions', async (req, res) => {
  try {
    const deletedCount = await userService.deleteExpiredSessions();

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} expired sessions`,
      deletedCount
    });
  } catch (error) {
    logger.error(`Cleanup sessions error: ${error.message}`);

    res.status(500).json({
      error: 'Failed to cleanup sessions',
      message: error.message
    });
  }
});

module.exports = router;
