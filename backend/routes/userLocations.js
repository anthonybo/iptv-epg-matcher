/**
 * User Locations Routes
 * API endpoints for managing user's saved locations for local news
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');

// Apply auth middleware to all routes
router.use(authMiddleware);

// US state abbreviations mapping
const STATE_ABBREVIATIONS = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
  'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
  'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
  'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT',
  'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
  'District of Columbia': 'DC'
};

/**
 * Get state abbreviation from full name
 */
function getStateAbbrev(state) {
  if (!state) return null;
  // Check if it's already an abbreviation
  if (state.length === 2) return state.toUpperCase();
  // Look up full name
  return STATE_ABBREVIATIONS[state] || null;
}

/**
 * GET /api/user/locations
 * Get all saved locations for the current user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');
    const result = await postgresService.query(
      `SELECT
        id,
        city,
        state,
        state_abbrev as "stateAbbrev",
        is_auto_detected as "isAutoDetected",
        is_current as "isCurrent",
        created_at as "createdAt"
       FROM user_locations
       WHERE user_id = $1
       ORDER BY is_current DESC, created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      locations: result.rows
    });
  } catch (error) {
    logger.error('Get user locations failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/user/locations/current
 * Get the current selected location
 */
router.get('/current', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');
    const result = await postgresService.query(
      `SELECT
        id,
        city,
        state,
        state_abbrev as "stateAbbrev",
        is_auto_detected as "isAutoDetected",
        is_current as "isCurrent"
       FROM user_locations
       WHERE user_id = $1 AND is_current = true
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        location: null,
        message: 'No current location set'
      });
    }

    res.json({
      success: true,
      location: result.rows[0]
    });
  } catch (error) {
    logger.error('Get current location failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/user/locations
 * Add a new location (manual entry)
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { city, state, setAsCurrent = true } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (!city || !state) {
      return res.status(400).json({ success: false, error: 'City and state are required' });
    }

    const stateAbbrev = getStateAbbrev(state);
    const postgresService = require('../services/postgresService');

    // If setting as current, first unset any existing current location
    if (setAsCurrent) {
      await postgresService.query(
        'UPDATE user_locations SET is_current = false WHERE user_id = $1',
        [userId]
      );
    }

    // Insert new location or update if it exists
    const result = await postgresService.query(
      `INSERT INTO user_locations (user_id, city, state, state_abbrev, is_auto_detected, is_current)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (user_id, city, state) DO UPDATE SET
         is_current = EXCLUDED.is_current,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, city, state, state_abbrev as "stateAbbrev", is_auto_detected as "isAutoDetected", is_current as "isCurrent"`,
      [userId, city.trim(), state.trim(), stateAbbrev, setAsCurrent]
    );

    logger.info(`User ${userId} added location: ${city}, ${state}`);

    res.json({
      success: true,
      location: result.rows[0],
      message: 'Location added successfully'
    });
  } catch (error) {
    logger.error('Add location failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/user/locations/detect
 * Auto-detect location via IP geolocation
 */
router.post('/detect', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Get client IP - check various headers for proxied requests
    let clientIp = req.headers['x-forwarded-for'] ||
                   req.headers['x-real-ip'] ||
                   req.connection?.remoteAddress ||
                   req.socket?.remoteAddress;

    // If multiple IPs in x-forwarded-for, take the first one
    if (clientIp && clientIp.includes(',')) {
      clientIp = clientIp.split(',')[0].trim();
    }

    // Remove IPv6 prefix if present
    if (clientIp && clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7);
    }

    logger.info(`Detecting location for user ${userId} from IP: ${clientIp}`);

    // Use ip-api.com (free, no API key required, 45 requests/minute)
    const fetch = (await import('node-fetch')).default;

    // For localhost/development, use empty string to get server's public IP
    const ipParam = (clientIp === '127.0.0.1' || clientIp === '::1' || !clientIp) ? '' : clientIp;
    const geoUrl = `http://ip-api.com/json/${ipParam}?fields=status,message,city,regionName,region`;

    const geoResponse = await fetch(geoUrl);
    const geoData = await geoResponse.json();

    if (geoData.status !== 'success') {
      logger.warn(`IP geolocation failed: ${geoData.message}`);
      return res.status(400).json({
        success: false,
        error: 'Could not detect location from IP',
        details: geoData.message
      });
    }

    const city = geoData.city;
    const state = geoData.regionName;
    const stateAbbrev = geoData.region; // ip-api returns region code (e.g., "CA")

    if (!city || !state) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine city/state from IP'
      });
    }

    const postgresService = require('../services/postgresService');

    // Unset any existing current location
    await postgresService.query(
      'UPDATE user_locations SET is_current = false WHERE user_id = $1',
      [userId]
    );

    // Insert or update the detected location
    const result = await postgresService.query(
      `INSERT INTO user_locations (user_id, city, state, state_abbrev, is_auto_detected, is_current)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (user_id, city, state) DO UPDATE SET
         is_auto_detected = true,
         is_current = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, city, state, state_abbrev as "stateAbbrev", is_auto_detected as "isAutoDetected", is_current as "isCurrent"`,
      [userId, city, state, stateAbbrev]
    );

    logger.info(`User ${userId} detected location: ${city}, ${state} (${stateAbbrev})`);

    res.json({
      success: true,
      location: result.rows[0],
      message: 'Location detected successfully'
    });
  } catch (error) {
    logger.error('Detect location failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/user/locations/:id/select
 * Set a location as current
 */
router.put('/:id/select', async (req, res) => {
  try {
    const userId = req.user?.id;
    const locationId = parseInt(req.params.id);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (isNaN(locationId)) {
      return res.status(400).json({ success: false, error: 'Invalid location ID' });
    }

    const postgresService = require('../services/postgresService');

    // Verify location belongs to user
    const checkResult = await postgresService.query(
      'SELECT id FROM user_locations WHERE id = $1 AND user_id = $2',
      [locationId, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }

    // Unset any existing current location
    await postgresService.query(
      'UPDATE user_locations SET is_current = false WHERE user_id = $1',
      [userId]
    );

    // Set new current location
    const result = await postgresService.query(
      `UPDATE user_locations SET is_current = true, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, city, state, state_abbrev as "stateAbbrev", is_auto_detected as "isAutoDetected", is_current as "isCurrent"`,
      [locationId, userId]
    );

    logger.info(`User ${userId} selected location ID ${locationId}`);

    res.json({
      success: true,
      location: result.rows[0],
      message: 'Location selected successfully'
    });
  } catch (error) {
    logger.error('Select location failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/user/locations/:id
 * Delete a saved location
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const locationId = parseInt(req.params.id);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (isNaN(locationId)) {
      return res.status(400).json({ success: false, error: 'Invalid location ID' });
    }

    const postgresService = require('../services/postgresService');

    const result = await postgresService.query(
      'DELETE FROM user_locations WHERE id = $1 AND user_id = $2 RETURNING city, state',
      [locationId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }

    logger.info(`User ${userId} deleted location: ${result.rows[0].city}, ${result.rows[0].state}`);

    res.json({
      success: true,
      message: 'Location deleted successfully',
      deleted: result.rows[0]
    });
  } catch (error) {
    logger.error('Delete location failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
