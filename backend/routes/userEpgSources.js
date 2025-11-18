/**
 * User EPG Sources Routes
 * Handles CRUD operations for user-specific EPG sources
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const postgresService = require('../services/postgresService');
const { authMiddleware } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/user-epg-sources
 * Get all EPG sources for the authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await postgresService.query(`
      SELECT id, url, name, enabled, verified, notes, created_at, updated_at
      FROM user_epg_sources
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    res.json({
      success: true,
      sources: result.rows
    });
  } catch (error) {
    logger.error(`Error fetching user EPG sources: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch EPG sources' });
  }
});

/**
 * POST /api/user-epg-sources
 * Add a new EPG source for the user
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { url, name, enabled = true, verified = false, notes = '' } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (urlError) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Insert new source
    const result = await postgresService.query(`
      INSERT INTO user_epg_sources (user_id, url, name, enabled, verified, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [userId, url, name, enabled, verified, notes]);

    logger.info(`Added EPG source for user ${userId}: ${name} (${url})`);

    res.json({
      success: true,
      message: 'EPG source added successfully',
      id: result.rows[0].id
    });
  } catch (error) {
    logger.error(`Error adding user EPG source: ${error.message}`);

    // PostgreSQL unique constraint violation error code
    if (error.code === '23505') {
      res.status(409).json({ error: 'This EPG source URL already exists for your account' });
    } else {
      res.status(500).json({ error: 'Failed to add EPG source' });
    }
  }
});

/**
 * PUT /api/user-epg-sources/:id
 * Update an existing EPG source
 */
router.put('/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { url, name, enabled, verified, notes } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (url !== undefined) {
      try {
        new URL(url);
        updates.push(`url = $${paramIndex++}`);
        values.push(url);
      } catch (urlError) {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
    }

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (enabled !== undefined) {
      updates.push(`enabled = $${paramIndex++}`);
      values.push(enabled);
    }

    if (verified !== undefined) {
      updates.push(`verified = $${paramIndex++}`);
      values.push(verified);
    }

    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      values.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId, id);

    const result = await postgresService.query(`
      UPDATE user_epg_sources
      SET ${updates.join(', ')}
      WHERE user_id = $${paramIndex++} AND id = $${paramIndex}
    `, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'EPG source not found' });
    }

    logger.info(`Updated EPG source ${id} for user ${userId}`);

    res.json({
      success: true,
      message: 'EPG source updated successfully'
    });
  } catch (error) {
    logger.error(`Error updating user EPG source: ${error.message}`);
    res.status(500).json({ error: 'Failed to update EPG source' });
  }
});

/**
 * DELETE /api/user-epg-sources/:id
 * Delete an EPG source
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await postgresService.query(`
      DELETE FROM user_epg_sources
      WHERE user_id = $1 AND id = $2
    `, [userId, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'EPG source not found' });
    }

    logger.info(`Deleted EPG source ${id} for user ${userId}`);

    res.json({
      success: true,
      message: 'EPG source deleted successfully'
    });
  } catch (error) {
    logger.error(`Error deleting user EPG source: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete EPG source' });
  }
});

module.exports = router;
