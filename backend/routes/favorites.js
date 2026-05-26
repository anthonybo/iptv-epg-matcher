/**
 * Favorites Routes
 *
 * Per-user channel favorites tied to a specific (source, channel) tuple.
 * Same channel name from different sources/accounts is intentionally
 * stored as distinct rows — that's the whole point of this feature.
 *
 *   GET    /api/favorites                       → { favorites, folders }
 *   POST   /api/favorites                       → add { sourceId, channelId, name, logo, url }
 *   DELETE /api/favorites/:id                   → remove one
 *   PATCH  /api/favorites/reorder               → body: [{ id, position }, ...]
 *   POST   /api/favorites/:id/played            → bump play count + last_played_at
 *
 *   POST   /api/favorites/folders               → { name, color?, memberIds? } → create
 *   PATCH  /api/favorites/folders/:id           → { name?, color?, position? } → rename/recolor/reorder
 *   DELETE /api/favorites/folders/:id           → delete folder, children fall back to top level
 *   PATCH  /api/favorites/:favId/move           → { folderId, position }, null folderId = top level
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
    f.folder_id       AS "folderId",
    f.folder_position AS "folderPosition",
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

const SELECT_FOLDERS = `
  SELECT id, name, color, position,
         EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
  FROM channel_favorite_folders
  WHERE user_id = $1
  ORDER BY position ASC, created_at ASC
`;

router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const [favs, fldrs] = await Promise.all([
      postgresService.query(
        `${SELECT_WITH_SOURCE}
         ORDER BY f.position ASC, f.created_at ASC`,
        [userId]
      ),
      postgresService.query(SELECT_FOLDERS, [userId])
    ]);

    res.json({
      success: true,
      favorites: favs.rows,
      folders: fldrs.rows
    });
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

// ─── Folder endpoints ─────────────────────────────────────────────
//
// Folders sit alongside top-level favorites in the rail. Each
// channel_favorites row carries a nullable folder_id; null = top-level.
// Position semantics: folder.position interleaves with top-level
// favorite.position (both are user-scoped 0..N sequences and the
// frontend sorts by the union). folder_position orders children
// *within* the folder.

// POST /folders — create. Optionally accepts memberIds to move
// existing favorites into the new folder in a single round-trip
// (this is what the "drop chip on chip → make folder" flow needs).
router.post('/folders', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const name = String(req.body?.name || '').trim().slice(0, 80) || 'Folder';
    const color = req.body?.color ? String(req.body.color).slice(0, 16) : null;
    const memberIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds.map((n) => parseInt(n, 10)).filter(Number.isFinite)
      : [];

    let folderId;
    await postgresService.transaction(async (client) => {
      // Place new folder at the end of the user's top-level row.
      const posResult = await client.query(
        `SELECT GREATEST(
           COALESCE((SELECT MAX(position) FROM channel_favorite_folders WHERE user_id = $1), -1),
           COALESCE((SELECT MAX(position) FROM channel_favorites WHERE user_id = $1 AND folder_id IS NULL), -1)
         ) + 1 AS next_pos`,
        [userId]
      );
      const nextPos = posResult.rows[0].next_pos;

      const ins = await client.query(
        `INSERT INTO channel_favorite_folders (user_id, name, color, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, name, color, nextPos]
      );
      folderId = ins.rows[0].id;

      if (memberIds.length > 0) {
        for (let i = 0; i < memberIds.length; i++) {
          await client.query(
            `UPDATE channel_favorites
             SET folder_id = $1, folder_position = $2
             WHERE id = $3 AND user_id = $4`,
            [folderId, i, memberIds[i], userId]
          );
        }
      }
    });

    logger.info(`User ${userId} created folder "${name}" (${folderId}) with ${memberIds.length} members`);
    res.json({ success: true, folderId });
  } catch (error) {
    logger.error('Create favorite folder failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /folders/:id — rename / recolor / reposition.
router.patch('/folders/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const folderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(folderId)) {
      return res.status(400).json({ error: 'Invalid folder id' });
    }

    const updates = [];
    const params = [folderId, userId];
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim().slice(0, 80);
      if (name) {
        params.push(name);
        updates.push(`name = $${params.length}`);
      }
    }
    if (req.body?.color !== undefined) {
      params.push(req.body.color ? String(req.body.color).slice(0, 16) : null);
      updates.push(`color = $${params.length}`);
    }
    if (Number.isFinite(parseInt(req.body?.position, 10))) {
      params.push(parseInt(req.body.position, 10));
      updates.push(`position = $${params.length}`);
    }
    if (updates.length === 0) {
      return res.json({ success: true, noop: true });
    }

    await postgresService.query(
      `UPDATE channel_favorite_folders
       SET ${updates.join(', ')}
       WHERE id = $1 AND user_id = $2`,
      params
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Patch favorite folder failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /folders/:id — delete a folder. ON DELETE SET NULL on the FK
// promotes the children to top-level automatically.
router.delete('/folders/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const folderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(folderId)) {
      return res.status(400).json({ error: 'Invalid folder id' });
    }

    const result = await postgresService.query(
      `DELETE FROM channel_favorite_folders WHERE id = $1 AND user_id = $2`,
      [folderId, userId]
    );
    res.json({ success: true, deleted: result.rowCount > 0 });
  } catch (error) {
    logger.error('Delete favorite folder failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /:favId/move — move a favorite into / out of a folder, or
// reorder within a folder. position = -1 appends.
router.patch('/:favId/move', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const favoriteId = parseInt(req.params.favId, 10);
    if (!Number.isFinite(favoriteId)) {
      return res.status(400).json({ error: 'Invalid favorite id' });
    }

    const folderIdRaw = req.body?.folderId;
    const folderId = folderIdRaw === null || folderIdRaw === undefined
      ? null
      : parseInt(folderIdRaw, 10);
    if (folderId !== null && !Number.isFinite(folderId)) {
      return res.status(400).json({ error: 'Invalid folderId' });
    }
    let position = parseInt(req.body?.position, 10);
    if (!Number.isFinite(position)) position = -1;

    await postgresService.transaction(async (client) => {
      // Validate ownership of both rows.
      const ok = await client.query(
        `SELECT 1 FROM channel_favorites WHERE id = $1 AND user_id = $2`,
        [favoriteId, userId]
      );
      if (ok.rowCount === 0) throw new Error('Favorite not found');
      if (folderId !== null) {
        const f = await client.query(
          `SELECT 1 FROM channel_favorite_folders WHERE id = $1 AND user_id = $2`,
          [folderId, userId]
        );
        if (f.rowCount === 0) throw new Error('Folder not found');
      }

      // Compute target position if append.
      if (position < 0) {
        if (folderId === null) {
          const r = await client.query(
            `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM channel_favorites
             WHERE user_id = $1 AND folder_id IS NULL`,
            [userId]
          );
          position = r.rows[0].p;
        } else {
          const r = await client.query(
            `SELECT COALESCE(MAX(folder_position) + 1, 0) AS p FROM channel_favorites
             WHERE user_id = $1 AND folder_id = $2`,
            [userId, folderId]
          );
          position = r.rows[0].p;
        }
      }

      if (folderId === null) {
        await client.query(
          `UPDATE channel_favorites
           SET folder_id = NULL, folder_position = 0, position = $1
           WHERE id = $2 AND user_id = $3`,
          [position, favoriteId, userId]
        );
      } else {
        await client.query(
          `UPDATE channel_favorites
           SET folder_id = $1, folder_position = $2
           WHERE id = $3 AND user_id = $4`,
          [folderId, position, favoriteId, userId]
        );
      }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Move favorite failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /order — unified top-level reorder for the preset rail.
// Body: { items: [{ kind: 'chip' | 'folder', id }, ...] }
// Stamps position = array_index across BOTH tables in a single
// transaction so a folder and a chip can share the same logical row
// and the frontend can sort by position regardless of kind.
//
// We deliberately keep the existing /reorder endpoint (chip-only)
// for backward compatibility — but the rail now uses this one.
router.patch('/order', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items array required' });

    await postgresService.transaction(async (client) => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        // YouTube favorites carry string IDs of the form "yt:N".
        // Route them to the youtube_favorites table; everything else
        // goes to the IPTV channel_favorites/folders tables.
        const rawId = String(it?.id ?? '');
        const ytMatch = rawId.match(/^yt:(\d+)$/);
        if (ytMatch) {
          const ytId = parseInt(ytMatch[1], 10);
          if (!Number.isFinite(ytId)) continue;
          await client.query(
            `UPDATE youtube_favorites SET position = $1
             WHERE id = $2 AND user_id = $3`,
            [i, ytId, userId]
          );
          continue;
        }
        const id = parseInt(rawId, 10);
        if (!Number.isFinite(id)) continue;
        if (it.kind === 'folder') {
          await client.query(
            `UPDATE channel_favorite_folders SET position = $1
             WHERE id = $2 AND user_id = $3`,
            [i, id, userId]
          );
        } else if (it.kind === 'chip') {
          // Only re-stamp top-level chips (folder_id IS NULL). A chip
          // inside a folder shouldn't show up in this payload, but
          // guard with the WHERE clause anyway so a stale client can't
          // accidentally pull rows out of a folder.
          await client.query(
            `UPDATE channel_favorites SET position = $1
             WHERE id = $2 AND user_id = $3 AND folder_id IS NULL`,
            [i, id, userId]
          );
        }
      }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Reorder top-level failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
