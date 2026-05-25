/**
 * YouTube routes — paste-a-URL, search, favorites, live HLS resolve.
 *
 * Backs the multi-view "Add YouTube channel" picker tab and the live
 * playback path used by tile renderers when sourceType === 'youtube'.
 *
 * yt-dlp does the heavy lifting (services/youtubeService.js).
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const pg = require('../services/postgresService');
const yt = require('../services/youtubeService');

router.use(authMiddleware);

/* ──────────────────────────────────────────────────────────────────
 *  Resolve / search
 * ────────────────────────────────────────────────────────────────── */

/**
 * POST /api/youtube/resolve
 *   body: { input: string }   // URL, @handle, or UC...
 *   → { channel: { channelId, name, handle, avatarUrl, channelUrl, isLive } }
 */
router.post('/resolve', async (req, res) => {
  const input = (req.body?.input || '').trim();
  if (!input) return res.status(400).json({ error: 'input is required' });
  try {
    const channel = await yt.resolveChannel(input);
    res.json({ success: true, channel });
  } catch (err) {
    logger.warn(`[youtube/resolve] ${input}: ${err.message}`);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/youtube/search?q=...&limit=8
 *   → { results: [...channels] }
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 8));
  if (!q) return res.json({ success: true, results: [] });
  try {
    const results = await yt.searchChannels(q, { limit });
    res.json({ success: true, results });
  } catch (err) {
    logger.warn(`[youtube/search] q="${q}": ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/youtube/channel/:channelId/live?force=1
 *   → { isLive, hlsUrl?, height?, videoTitle?, channel? }
 */
router.get('/channel/:channelId/live', async (req, res) => {
  const channelId = req.params.channelId;
  if (!/^UC[\w-]{20,}$/.test(channelId)) {
    return res.status(400).json({ success: false, error: 'invalid channel id' });
  }
  try {
    const result = await yt.resolveLiveStream(channelId, { force: req.query.force === '1' });

    // Best-effort touch of last_seen_live_at if we have a favorite for this user/channel.
    if (result.isLive && req.user?.id) {
      pg.query(
        `UPDATE youtube_favorites
            SET last_seen_live_at = NOW()
          WHERE user_id = $1 AND channel_id = $2`,
        [req.user.id, channelId]
      ).catch(() => {});
    }

    res.json({ success: true, ...result });
  } catch (err) {
    logger.warn(`[youtube/live] ${channelId}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ──────────────────────────────────────────────────────────────────
 *  Favorites CRUD
 * ────────────────────────────────────────────────────────────────── */

/**
 * GET /api/youtube/favorites
 *   → { favorites: [...] }
 */
router.get('/favorites', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  try {
    const result = await pg.query(
      `SELECT
          id, channel_id AS "channelId", name, custom_name AS "customName",
          handle, avatar_url AS "avatarUrl", channel_url AS "channelUrl",
          EXTRACT(EPOCH FROM added_at) * 1000           AS "addedAt",
          EXTRACT(EPOCH FROM last_seen_live_at) * 1000  AS "lastSeenLiveAt"
        FROM youtube_favorites
        WHERE user_id = $1
        ORDER BY added_at DESC`,
      [userId]
    );
    res.json({ success: true, favorites: result.rows });
  } catch (err) {
    logger.error('[youtube/favorites GET]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/youtube/favorites
 *   body: { channelId, name?, handle?, avatarUrl?, channelUrl?, customName? }
 *   If only channelId is given, the channel is resolved via yt-dlp.
 *   Conflict on (user_id, channel_id) → 200 + existing row.
 */
router.post('/favorites', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'auth required' });

  let { channelId, name, handle, avatarUrl, channelUrl, customName } = req.body || {};
  channelId = (channelId || '').trim();

  try {
    if (!channelId || !/^UC[\w-]{20,}$/.test(channelId)) {
      return res.status(400).json({ success: false, error: 'channelId (UC…) is required' });
    }

    // Fill missing fields by resolving the channel once.
    if (!name || !avatarUrl) {
      try {
        const c = await yt.resolveChannel(channelId);
        name = name || c.name;
        handle = handle || c.handle;
        avatarUrl = avatarUrl || c.avatarUrl;
        channelUrl = channelUrl || c.channelUrl;
      } catch (e) {
        // If we still have a name, accept the favorite (degraded metadata).
        if (!name) {
          return res.status(400).json({ success: false, error: `Could not resolve channel: ${e.message}` });
        }
      }
    }

    const upsert = await pg.query(
      `INSERT INTO youtube_favorites
         (user_id, channel_id, name, custom_name, handle, avatar_url, channel_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, channel_id) DO UPDATE
          SET name        = EXCLUDED.name,
              custom_name = COALESCE(EXCLUDED.custom_name, youtube_favorites.custom_name),
              handle      = COALESCE(EXCLUDED.handle, youtube_favorites.handle),
              avatar_url  = COALESCE(EXCLUDED.avatar_url, youtube_favorites.avatar_url),
              channel_url = COALESCE(EXCLUDED.channel_url, youtube_favorites.channel_url)
        RETURNING
          id, channel_id AS "channelId", name, custom_name AS "customName",
          handle, avatar_url AS "avatarUrl", channel_url AS "channelUrl",
          EXTRACT(EPOCH FROM added_at) * 1000          AS "addedAt",
          EXTRACT(EPOCH FROM last_seen_live_at) * 1000 AS "lastSeenLiveAt"`,
      [userId, channelId, name || 'YouTube channel', customName || null, handle || null, avatarUrl || null, channelUrl || null]
    );

    res.json({ success: true, favorite: upsert.rows[0] });
  } catch (err) {
    logger.error('[youtube/favorites POST]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/youtube/favorites/:id
 *   body: { customName? }
 */
router.patch('/favorites/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'invalid id' });
  }
  const { customName } = req.body || {};
  try {
    const r = await pg.query(
      `UPDATE youtube_favorites
          SET custom_name = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id`,
      [customName ?? null, id, userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error('[youtube/favorites PATCH]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/youtube/favorites/:id
 */
router.delete('/favorites/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'auth required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'invalid id' });
  }
  try {
    const r = await pg.query(
      'DELETE FROM youtube_favorites WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error('[youtube/favorites DELETE]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/youtube/favorites/check-live
 *   body: { channelIds: [UC..., UC...] }
 *   → { statuses: [{ channelId, isLive }] }
 *
 *   Bulk live-probe used by the picker to show LIVE / OFFLINE dots
 *   on each saved channel. Bounded by the cache TTL so spamming the
 *   endpoint doesn't hammer YouTube.
 */
router.post('/favorites/check-live', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'auth required' });

  const channelIds = Array.isArray(req.body?.channelIds) ? req.body.channelIds : [];
  const valid = channelIds.filter((c) => typeof c === 'string' && /^UC[\w-]{20,}$/.test(c)).slice(0, 30);
  if (valid.length === 0) return res.json({ success: true, statuses: [] });

  try {
    // Run in parallel, but yt.resolveLiveStream coalesces concurrent
    // resolves for the same channel internally.
    const statuses = await Promise.all(valid.map((c) => yt.checkLiveStatus(c)));

    // Touch last_seen_live_at for any that came back live.
    const liveIds = statuses.filter((s) => s.isLive).map((s) => s.channelId);
    if (liveIds.length > 0) {
      pg.query(
        `UPDATE youtube_favorites
            SET last_seen_live_at = NOW()
          WHERE user_id = $1 AND channel_id = ANY($2::text[])`,
        [userId, liveIds]
      ).catch(() => {});
    }

    res.json({ success: true, statuses });
  } catch (err) {
    logger.error('[youtube/favorites/check-live]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
