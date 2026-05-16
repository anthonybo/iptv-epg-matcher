/**
 * Favorites Routes
 *
 * Per-user channel favorites tied to a specific (source, channel) tuple.
 * Same channel name from different sources/accounts is intentionally
 * stored as distinct rows — that's the whole point of this feature.
 *
 *   GET    /api/favorites              → list user's favorites + source meta
 *   POST   /api/favorites              → add { sourceId, channelId, name, logo, url }
 *   DELETE /api/favorites/:id          → remove one
 *   PATCH  /api/favorites/reorder      → body: [{ id, position }, ...]
 *   POST   /api/favorites/:id/played   → bump play count + last_played_at
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const postgresService = require('../services/postgresService');

router.use(authMiddleware);

// Single SELECT used by both GET /favorites and POST /favorites (the
// latter re-emits the inserted row with source meta so the client can
// optimistic-merge without a follow-up fetch).
const SELECT_WITH_SOURCE = `
  SELECT
    f.id,
    f.channel_id      AS "channelId",
    f.source_id       AS "sourceId",
    f.name,
    f.logo,
    f.url,
    f.position,
    f.play_count      AS "playCount",
    EXTRACT(EPOCH FROM f.last_played_at) * 1000 AS "lastPlayedAt",
    EXTRACT(EPOCH FROM f.created_at)     * 1000 AS "createdAt",
    s.type            AS "sourceType",
    s.url             AS "sourceUrl",
    s.username        AS "sourceUsername",
    s.password        AS "sourcePassword",
    s.mac_address     AS "sourceMac",
    s.name            AS "sourceName"
  FROM channel_favorites f
  LEFT JOIN iptv_sources s ON s.id = f.source_id
  WHERE f.user_id = $1
`;

router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const result = await postgresService.query(
      `${SELECT_WITH_SOURCE}
       ORDER BY f.position ASC, f.created_at ASC`,
      [userId]
    );

    res.json({ success: true, favorites: result.rows });
  } catch (error) {
    logger.error('Get favorites failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { sourceId, channelId, name, logo, url } = req.body || {};
    if (!sourceId || !channelId || !name) {
      return res.status(400).json({
        error: 'sourceId, channelId, and name are required'
      });
    }

    // Append to the end of the user's list. Use COALESCE on MAX so a
    // first-ever favorite lands at position 0 rather than NaN.
    const nextPosResult = await postgresService.query(
      `SELECT COALESCE(MAX(position) + 1, 0) AS next_pos
       FROM channel_favorites WHERE user_id = $1`,
      [userId]
    );
    const nextPosition = nextPosResult.rows[0].next_pos;

    // Re-favoriting an existing row is a no-op (UNIQUE constraint), so
    // RETURNING id is null on conflict — we fall back to a fresh SELECT
    // for the existing row so the response shape is consistent.
    const insertResult = await postgresService.query(
      `INSERT INTO channel_favorites
         (user_id, source_id, channel_id, name, logo, url, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, source_id, channel_id) DO NOTHING
       RETURNING id`,
      [userId, sourceId, channelId, name, logo || null, url || null, nextPosition]
    );

    const wasInserted = insertResult.rowCount > 0;

    const fetched = await postgresService.query(
      `${SELECT_WITH_SOURCE} AND f.source_id = $2 AND f.channel_id = $3`,
      [userId, sourceId, channelId]
    );
    if (fetched.rows.length === 0) {
      return res.status(500).json({ success: false, error: 'Favorite vanished after insert' });
    }

    logger.info(
      `User ${userId} ${wasInserted ? 'added' : 're-confirmed'} favorite: ${name} (${channelId}@${sourceId})`
    );

    res.json({
      success: true,
      favorite: fetched.rows[0],
      created: wasInserted
    });
  } catch (error) {
    logger.error('Add favorite failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const favoriteId = parseInt(req.params.id, 10);
    if (!Number.isFinite(favoriteId)) {
      return res.status(400).json({ error: 'Invalid favorite id' });
    }

    const result = await postgresService.query(
      `DELETE FROM channel_favorites WHERE id = $1 AND user_id = $2`,
      [favoriteId, userId]
    );

    res.json({ success: true, deleted: result.rowCount > 0 });
  } catch (error) {
    logger.error('Delete favorite failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/reorder', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) {
      return res.status(400).json({ error: 'order array required' });
    }

    // Single transaction; the client sends the full ordered list of
    // favorite ids, we re-stamp positions 0..N-1. Any id not owned by
    // this user is silently ignored by the WHERE clause.
    await postgresService.transaction(async (client) => {
      for (let i = 0; i < order.length; i++) {
        const id = parseInt(order[i], 10);
        if (!Number.isFinite(id)) continue;
        await client.query(
          `UPDATE channel_favorites SET position = $1
           WHERE id = $2 AND user_id = $3`,
          [i, id, userId]
        );
      }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Reorder favorites failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/played', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const favoriteId = parseInt(req.params.id, 10);
    if (!Number.isFinite(favoriteId)) {
      return res.status(400).json({ error: 'Invalid favorite id' });
    }

    await postgresService.query(
      `UPDATE channel_favorites
       SET last_played_at = CURRENT_TIMESTAMP,
           play_count = play_count + 1
       WHERE id = $1 AND user_id = $2`,
      [favoriteId, userId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Bump favorite play stats failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
