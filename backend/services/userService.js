/**
 * User Service
 * Handles user CRUD operations and database interactions.
 *
 * Backed by PostgreSQL (postgresService). Previously this service
 * read/wrote the sqlite `data/iptv.db` while the rest of the app had
 * migrated to Postgres — a split-brain where auth validated against
 * sqlite users(id) but every user-scoped table (epg_matches,
 * blacklisted_channels, channel_favorite_folders, …) FK'd to the PG
 * users(id). They lined up only because the ids happened to match.
 * Auth now lives on the same Postgres instance as everything else.
 */
const logger = require('../config/logger');
const authService = require('./authService');
const postgresService = require('./postgresService');

// Thin query helper over the shared PG pool. Returns the pg result
// object ({ rows, rowCount }).
const query = (text, params) => postgresService.query(text, params);

// No-op retained so existing callers / tests that `await connect()`
// don't break; the PG pool manages its own connections.
const connect = async () => true;

/**
 * Create a new user
 * @param {Object} userData User data {username, email, password}
 * @returns {Promise<Object>} Created user object (without password)
 */
async function createUser(userData) {
  const { username, email, password } = userData;

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

  const passwordHash = await authService.hashPassword(password);

  try {
    const result = await query(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, created_at`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash]
    );
    const row = result.rows[0];
    logger.info(`Created new user: ${username} (ID: ${row.id})`);
    return {
      id: row.id,
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      createdAt: row.created_at
    };
  } catch (err) {
    // Postgres unique-violation = 23505; constraint name tells which.
    if (err.code === '23505') {
      const c = String(err.constraint || '').toLowerCase();
      if (c.includes('username')) throw new Error('Username already exists');
      if (c.includes('email')) throw new Error('Email already exists');
      throw new Error('User already exists');
    }
    logger.error(`Error creating user: ${err.message}`);
    throw new Error('Failed to create user');
  }
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login
  };
}

/**
 * Find user by username
 */
async function findUserByUsername(username) {
  try {
    const result = await query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
    return mapUserRow(result.rows[0]);
  } catch (err) {
    logger.error(`Error finding user by username: ${err.message}`);
    throw new Error('Failed to find user');
  }
}

/**
 * Find user by email
 */
async function findUserByEmail(email) {
  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return mapUserRow(result.rows[0]);
  } catch (err) {
    logger.error(`Error finding user by email: ${err.message}`);
    throw new Error('Failed to find user');
  }
}

/**
 * Find user by ID (without password)
 */
async function findUserById(userId) {
  try {
    const result = await query(
      'SELECT id, username, email, created_at, updated_at, last_login FROM users WHERE id = $1',
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLogin: row.last_login
    };
  } catch (err) {
    logger.error(`Error finding user by ID: ${err.message}`);
    throw new Error('Failed to find user');
  }
}

/**
 * Update user's last login timestamp
 */
async function updateLastLogin(userId) {
  try {
    await query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
  } catch (err) {
    logger.error(`Error updating last login: ${err.message}`);
    throw new Error('Failed to update last login');
  }
}

/**
 * Authenticate user with username/email and password
 */
async function authenticateUser(usernameOrEmail, password) {
  let user = await findUserByUsername(usernameOrEmail);
  if (!user) {
    user = await findUserByEmail(usernameOrEmail);
  }
  if (!user) {
    throw new Error('Invalid username or password');
  }

  const isPasswordValid = await authService.comparePassword(password, user.passwordHash);
  if (!isPasswordValid) {
    throw new Error('Invalid username or password');
  }

  await updateLastLogin(user.id);

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
 * Create a new user session. Deletes any existing row with the same
 * session_id first to avoid duplicates (matches the old behavior and
 * the user_sessions.session_id UNIQUE constraint).
 */
async function createUserSession(userId, sessionId, token) {
  const expiresAt = authService.calculateTokenExpiration();
  try {
    await query('DELETE FROM user_sessions WHERE session_id = $1', [sessionId]);
    const result = await query(
      `INSERT INTO user_sessions (user_id, session_id, token, expires_at, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING id`,
      [userId, sessionId, token, expiresAt.toISOString()]
    );
    logger.info(`Created session for user ${userId}: ${sessionId}`);
    return {
      id: result.rows[0].id,
      userId,
      sessionId,
      token,
      expiresAt: expiresAt.toISOString()
    };
  } catch (err) {
    logger.error(`Error creating user session: ${err.message}`);
    throw new Error('Failed to create session');
  }
}

/**
 * Migrate a user's session to a freshly-refreshed token. Called by
 * /api/auth/refresh: the new JWT is useless until it exists in
 * user_sessions (authMiddleware validates against this table), and
 * the old row is matched by the OLD token IGNORING expiry (the old
 * token has, by definition, just lapsed — findSessionByToken's
 * `expires_at > NOW` filter would never find it).
 *
 * Updates the matching row's token + expires_at in place so the
 * session_id is preserved. If no row matches (e.g. the session was
 * pruned), inserts a fresh session so the new token still
 * authenticates.
 */
async function updateSessionToken(userId, oldToken, newToken) {
  const expiresAt = authService.calculateTokenExpiration();
  try {
    const upd = await query(
      `UPDATE user_sessions
          SET token = $1, expires_at = $2
        WHERE token = $3 AND user_id = $4`,
      [newToken, expiresAt.toISOString(), oldToken, userId]
    );
    if (upd.rowCount > 0) {
      return { updated: true };
    }
    // No row for the old token — create a fresh session.
    const sessionId = `session_${Math.random().toString(36).substring(2, 15)}`;
    await query(
      `INSERT INTO user_sessions (user_id, session_id, token, expires_at, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [userId, sessionId, newToken, expiresAt.toISOString()]
    );
    return { updated: false, sessionId };
  } catch (err) {
    logger.error(`Error updating session token: ${err.message}`);
    throw new Error('Failed to update session token');
  }
}

/**
 * Find session by token (only non-expired rows)
 */
async function findSessionByToken(token) {
  try {
    const result = await query(
      'SELECT * FROM user_sessions WHERE token = $1 AND expires_at > CURRENT_TIMESTAMP',
      [token]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      token: row.token,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    };
  } catch (err) {
    logger.error(`Error finding session by token: ${err.message}`);
    throw new Error('Failed to find session');
  }
}

/**
 * Delete a user session (logout)
 */
async function deleteSession(token) {
  try {
    const result = await query('DELETE FROM user_sessions WHERE token = $1', [token]);
    return result.rowCount > 0;
  } catch (err) {
    logger.error(`Error deleting session: ${err.message}`);
    throw new Error('Failed to delete session');
  }
}

/**
 * Delete all expired sessions (cleanup)
 */
async function deleteExpiredSessions() {
  try {
    const result = await query('DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    if (result.rowCount > 0) {
      logger.info(`Deleted ${result.rowCount} expired sessions`);
    }
    return result.rowCount;
  } catch (err) {
    logger.error(`Error deleting expired sessions: ${err.message}`);
    throw new Error('Failed to delete expired sessions');
  }
}

/**
 * Link existing anonymous session data to a user on login. Runs in a
 * single transaction. Only epg_matches is linked — session_iptv_
 * mappings was a sqlite-only table that doesn't exist in Postgres, so
 * it's skipped (its absence is not an error).
 */
async function linkSessionDataToUser(userId, sessionId) {
  return postgresService.transaction(async (client) => {
    const epg = await client.query(
      'UPDATE epg_matches SET user_id = $1 WHERE session_id = $2 AND user_id IS NULL',
      [userId, sessionId]
    );
    const epgMatchesLinked = epg.rowCount || 0;
    logger.info(`Linked session data to user ${userId}: ${epgMatchesLinked} EPG matches`);
    return { epgMatchesLinked, iptvMappingsLinked: 0 };
  });
}

module.exports = {
  connect,
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  updateLastLogin,
  authenticateUser,
  createUserSession,
  updateSessionToken,
  findSessionByToken,
  deleteSession,
  deleteExpiredSessions,
  linkSessionDataToUser
};
