/**
 * User EPG Sources Routes
 * Handles CRUD operations for user-specific EPG sources
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const iptvDatabaseService = require('../services/iptvDatabaseService');
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

    const db = await iptvDatabaseService.connect();

    const sources = await new Promise((resolve, reject) => {
      db.all(`
        SELECT id, url, name, enabled, verified, notes, created_at, updated_at
        FROM user_epg_sources
        WHERE user_id = ?
        ORDER BY created_at DESC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json({
      success: true,
      sources
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

    const db = await iptvDatabaseService.connect();

    // Insert new source
    const result = await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO user_epg_sources (user_id, url, name, enabled, verified, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, url, name, enabled ? 1 : 0, verified ? 1 : 0, notes], function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            reject(new Error('This EPG source URL already exists'));
          } else {
            reject(err);
          }
        } else {
          resolve({ id: this.lastID });
        }
      });
    });

    logger.info(`Added EPG source for user ${userId}: ${name} (${url})`);

    res.json({
      success: true,
      message: 'EPG source added successfully',
      id: result.id
    });
  } catch (error) {
    logger.error(`Error adding user EPG source: ${error.message}`);

    if (error.message.includes('already exists')) {
      res.status(409).json({ error: error.message });
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

    const db = await iptvDatabaseService.connect();

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];

    if (url !== undefined) {
      try {
        new URL(url);
        updates.push('url = ?');
        values.push(url);
      } catch (urlError) {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
    }

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }

    if (enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(enabled ? 1 : 0);
    }

    if (verified !== undefined) {
      updates.push('verified = ?');
      values.push(verified ? 1 : 0);
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId, id);

    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE user_epg_sources
        SET ${updates.join(', ')}
        WHERE user_id = ? AND id = ?
      `, values, function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('EPG source not found'));
        else resolve();
      });
    });

    logger.info(`Updated EPG source ${id} for user ${userId}`);

    res.json({
      success: true,
      message: 'EPG source updated successfully'
    });
  } catch (error) {
    logger.error(`Error updating user EPG source: ${error.message}`);

    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update EPG source' });
    }
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

    const db = await iptvDatabaseService.connect();

    await new Promise((resolve, reject) => {
      db.run(`
        DELETE FROM user_epg_sources
        WHERE user_id = ? AND id = ?
      `, [userId, id], function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('EPG source not found'));
        else resolve();
      });
    });

    logger.info(`Deleted EPG source ${id} for user ${userId}`);

    res.json({
      success: true,
      message: 'EPG source deleted successfully'
    });
  } catch (error) {
    logger.error(`Error deleting user EPG source: ${error.message}`);

    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete EPG source' });
    }
  }
});

module.exports = router;
