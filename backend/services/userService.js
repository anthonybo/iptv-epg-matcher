/**
 * User Service
 * Handles user CRUD operations and database interactions
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../config/logger');
const authService = require('./authService');

const DB_PATH = path.join(__dirname, '../data/iptv.db');

// Database connection (reuse from iptvDatabaseService pattern)
let db = null;

/**
 * Connect to the database
 * @returns {Promise<sqlite3.Database>} Database connection
 */
const connect = () => {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }

    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error(`Error connecting to user database: ${err.message}`);
        reject(err);
        return;
      }

      logger.debug('Connected to user database');
      resolve(db);
    });
  });
};

/**
 * Create a new user
 * @param {Object} userData User data {username, email, password}
 * @returns {Promise<Object>} Created user object (without password)
 */
async function createUser(userData) {
  const { username, email, password } = userData;

  // Validate inputs
  const usernameValidation = authService.validateUsername(username);
  if (!usernameValidation.isValid) {
    throw new Error(usernameValidation.message);
  }

  const emailValidation = authService.validateEmail(email);
  if (!emailValidation.isValid) {
    throw new Error(emailValidation.message);
  }

  const passwordValidation = authService.validatePassword(password);
  if (!passwordValidation.isValid) {
    throw new Error(passwordValidation.message);
  }

  // Hash password
  const passwordHash = await authService.hashPassword(password);

  // Connect to database
  await connect();

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed: users.username')) {
            reject(new Error('Username already exists'));
          } else if (err.message.includes('UNIQUE constraint failed: users.email')) {
            reject(new Error('Email already exists'));
          } else {
            logger.error(`Error creating user: ${err.message}`);
            reject(new Error('Failed to create user'));
          }
          return;
        }

        const userId = this.lastID;
        logger.info(`Created new user: ${username} (ID: ${userId})`);

        // Return user without password
        resolve({
          id: userId,
          username: username.toLowerCase(),
          email: email.toLowerCase(),
          createdAt: new Date().toISOString()
        });
      }
    );
  });
}

/**
 * Find user by username
 * @param {string} username Username to search for
 * @returns {Promise<Object|null>} User object or null if not found
 */
async function findUserByUsername(username) {
  await connect();

  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM users WHERE username = ?',
      [username.toLowerCase()],
      (err, row) => {
        if (err) {
          logger.error(`Error finding user by username: ${err.message}`);
          reject(new Error('Failed to find user'));
          return;
        }

        if (!row) {
          resolve(null);
          return;
        }

        resolve({
          id: row.id,
          username: row.username,
          email: row.email,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastLogin: row.last_login
        });
      }
    );
  });
}

/**
 * Find user by email
 * @param {string} email Email to search for
 * @returns {Promise<Object|null>} User object or null if not found
 */
async function findUserByEmail(email) {
  await connect();

  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM users WHERE email = ?',
      [email.toLowerCase()],
      (err, row) => {
        if (err) {
          logger.error(`Error finding user by email: ${err.message}`);
          reject(new Error('Failed to find user'));
          return;
        }

        if (!row) {
          resolve(null);
          return;
        }

        resolve({
          id: row.id,
          username: row.username,
          email: row.email,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastLogin: row.last_login
        });
      }
    );
  });
}

/**
 * Find user by ID
 * @param {number} userId User ID
 * @returns {Promise<Object|null>} User object (without password) or null if not found
 */
async function findUserById(userId) {
  await connect();

  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, username, email, created_at, updated_at, last_login FROM users WHERE id = ?',
      [userId],
      (err, row) => {
        if (err) {
          logger.error(`Error finding user by ID: ${err.message}`);
          reject(new Error('Failed to find user'));
          return;
        }

        if (!row) {
          resolve(null);
          return;
        }

        resolve({
          id: row.id,
          username: row.username,
          email: row.email,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastLogin: row.last_login
        });
      }
    );
  });
}

/**
 * Update user's last login timestamp
 * @param {number} userId User ID
 * @returns {Promise<void>}
 */
async function updateLastLogin(userId) {
  await connect();

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      [userId],
      (err) => {
        if (err) {
          logger.error(`Error updating last login: ${err.message}`);
          reject(new Error('Failed to update last login'));
          return;
        }

        resolve();
      }
    );
  });
}

/**
 * Authenticate user with username/email and password
 * @param {string} usernameOrEmail Username or email
 * @param {string} password Plain text password
 * @returns {Promise<Object>} User object (without password) or throws error
 */
async function authenticateUser(usernameOrEmail, password) {
  // Try to find user by username first, then by email
  let user = await findUserByUsername(usernameOrEmail);

  if (!user) {
    user = await findUserByEmail(usernameOrEmail);
  }

  if (!user) {
    throw new Error('Invalid username or password');
  }

  // Compare password
  const isPasswordValid = await authService.comparePassword(password, user.passwordHash);

  if (!isPasswordValid) {
    throw new Error('Invalid username or password');
  }

  // Update last login
  await updateLastLogin(user.id);

  // Return user without password hash
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLogin: new Date().toISOString()
  };
}

/**
 * Create a new user session
 * @param {number} userId User ID
 * @param {string} sessionId Session ID
 * @param {string} token JWT token
 * @returns {Promise<Object>} Session object
 */
async function createUserSession(userId, sessionId, token) {
  await connect();

  const expiresAt = authService.calculateTokenExpiration();

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO user_sessions (user_id, session_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [userId, sessionId, token, expiresAt.toISOString()],
      function(err) {
        if (err) {
          logger.error(`Error creating user session: ${err.message}`);
          reject(new Error('Failed to create session'));
          return;
        }

        logger.info(`Created session for user ${userId}: ${sessionId}`);

        resolve({
          id: this.lastID,
          userId,
          sessionId,
          token,
          expiresAt: expiresAt.toISOString()
        });
      }
    );
  });
}

/**
 * Find session by token
 * @param {string} token JWT token
 * @returns {Promise<Object|null>} Session object or null if not found
 */
async function findSessionByToken(token) {
  await connect();

  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM user_sessions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP',
      [token],
      (err, row) => {
        if (err) {
          logger.error(`Error finding session by token: ${err.message}`);
          reject(new Error('Failed to find session'));
          return;
        }

        if (!row) {
          resolve(null);
          return;
        }

        resolve({
          id: row.id,
          userId: row.user_id,
          sessionId: row.session_id,
          token: row.token,
          expiresAt: row.expires_at,
          createdAt: row.created_at
        });
      }
    );
  });
}

/**
 * Delete a user session (logout)
 * @param {string} token JWT token
 * @returns {Promise<boolean>} True if session was deleted
 */
async function deleteSession(token) {
  await connect();

  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM user_sessions WHERE token = ?',
      [token],
      function(err) {
        if (err) {
          logger.error(`Error deleting session: ${err.message}`);
          reject(new Error('Failed to delete session'));
          return;
        }

        resolve(this.changes > 0);
      }
    );
  });
}

/**
 * Delete all expired sessions (cleanup)
 * @returns {Promise<number>} Number of sessions deleted
 */
async function deleteExpiredSessions() {
  await connect();

  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP',
      function(err) {
        if (err) {
          logger.error(`Error deleting expired sessions: ${err.message}`);
          reject(new Error('Failed to delete expired sessions'));
          return;
        }

        if (this.changes > 0) {
          logger.info(`Deleted ${this.changes} expired sessions`);
        }

        resolve(this.changes);
      }
    );
  });
}

/**
 * Link existing session data to a user
 * @param {number} userId User ID
 * @param {string} sessionId Session ID
 * @returns {Promise<Object>} Result with counts of linked data
 */
async function linkSessionDataToUser(userId, sessionId) {
  await connect();

  return new Promise((resolve, reject) => {
    // Begin transaction
    db.run('BEGIN TRANSACTION', (err) => {
      if (err) {
        logger.error(`Error starting transaction: ${err.message}`);
        reject(new Error('Failed to start transaction'));
        return;
      }

      // Update epg_matches
      db.run(
        'UPDATE epg_matches SET user_id = ? WHERE session_id = ? AND user_id IS NULL',
        [userId, sessionId],
        function(err) {
          if (err) {
            db.run('ROLLBACK');
            logger.error(`Error linking EPG matches: ${err.message}`);
            reject(new Error('Failed to link EPG matches'));
            return;
          }

          const epgMatchesLinked = this.changes;

          // Update session_iptv_mappings
          db.run(
            'UPDATE session_iptv_mappings SET user_id = ? WHERE session_id = ? AND user_id IS NULL',
            [userId, sessionId],
            function(err) {
              if (err) {
                db.run('ROLLBACK');
                logger.error(`Error linking IPTV mappings: ${err.message}`);
                reject(new Error('Failed to link IPTV mappings'));
                return;
              }

              const iptvMappingsLinked = this.changes;

              // Commit transaction
              db.run('COMMIT', (err) => {
                if (err) {
                  logger.error(`Error committing transaction: ${err.message}`);
                  reject(new Error('Failed to commit transaction'));
                  return;
                }

                logger.info(`Linked session data to user ${userId}: ${epgMatchesLinked} EPG matches, ${iptvMappingsLinked} IPTV mappings`);

                resolve({
                  epgMatchesLinked,
                  iptvMappingsLinked
                });
              });
            }
          );
        }
      );
    });
  });
}

module.exports = {
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  updateLastLogin,
  authenticateUser,
  createUserSession,
  findSessionByToken,
  deleteSession,
  deleteExpiredSessions,
  linkSessionDataToUser
};
