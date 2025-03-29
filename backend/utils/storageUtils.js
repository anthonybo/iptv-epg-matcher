// utils/storageUtils.js
const crypto = require('crypto');
const logger = require('../config/logger');
const { EXTERNAL_EPG_URLS } = require('../config/constants');

/**
 * In-memory storage for session data
 */
const storage = {};

/**
 * Creates a new session with a unique ID
 * 
 * @param {Object} data - Initial session data
 * @returns {string} The generated session ID
 */
function createSession(data) {
  const sessionId = crypto.randomBytes(4).toString('hex');
  storage[sessionId] = data;
  logger.info('Session created', { sessionId });
  return sessionId;
}

/**
 * Retrieves a session by ID
 * 
 * @param {string} sessionId - Session ID to retrieve
 * @returns {Object|null} The session data or null if not found
 */
function getSession(sessionId) {
  return storage[sessionId] || null;
}

/**
 * Updates an existing session with new data
 * 
 * @param {string} sessionId - Session ID to update
 * @param {Object} data - New data to merge into the session
 * @returns {boolean} True if session was updated, false if not found
 */
function updateSession(sessionId, data) {
  if (!storage[sessionId]) return false;
  storage[sessionId] = { ...storage[sessionId], ...data };
  return true;
}

/**
 * Deletes a session by ID
 * 
 * @param {string} sessionId - Session ID to delete
 * @returns {boolean} True if session was deleted, false if not found
 */
function deleteSession(sessionId) {
  if (!storage[sessionId]) return false;
  delete storage[sessionId];
  return true;
}

/**
 * Generates a cache key from Xtream credentials
 * 
 * @param {string} xtreamUsername - Xtream username
 * @param {string} xtreamPassword - Xtream password
 * @param {string} xtreamServer - Xtream server URL
 * @returns {string} MD5 hash of the credentials
 */
function getCacheKey(username, password, server) {
    // Add EXTERNAL_EPG_URLS.length to the cacheKey to invalidate when new sources are added
    const sourceCount = EXTERNAL_EPG_URLS.length;
    const normalizedUsername = username || '';
    const normalizedPassword = password || '';
    const normalizedServer = server || '';
    
    const cacheString = `${normalizedUsername}|${normalizedPassword}|${normalizedServer}|${sourceCount}`;
    return crypto.createHash('md5').update(cacheString).digest('hex');
  }

/**
 * Generates new random Xtream credentials
 * 
 * @returns {Object} Object containing username and password
 */
function generateCredentials() {
  const username = crypto.randomBytes(8).toString('hex');
  const password = crypto.randomBytes(8).toString('hex');
  return { username, password };
}

module.exports = {
  storage,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  getCacheKey,
  generateCredentials
};