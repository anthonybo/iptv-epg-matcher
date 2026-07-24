/**
 * Commercial detection control — start/stop the server-side ad detector
 * for a channel. The analyzer (commercialBoundaryService) runs ffmpeg
 * black-frame + audio-silence (+ scene-cut) detection on the upstream and
 * broadcasts a commercial-break start/end over SSE when it sees a hard
 * ad-insertion boundary (black co-occurring with silence). The multiview
 * client consumes those events to flag/mute the tile. This is a best-effort
 * LIVE signal — no mainstream tool does reliable real-time ad detection on
 * arbitrary live streams (Comskip/Plex/Emby all post-process recordings;
 * SCTE-35 markers are stripped by these restreams) — so it's opt-in and the
 * UI surfaces it with an Undo escape hatch. Analyzers are ref-counted per
 * (source, channel), so N viewers of the same channel share one upstream
 * connection.
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const postgresService = require('../services/postgresService');
const detector = require('../services/commercialBoundaryService');

// Populate req.user from the JWT for every route here. Without this the
// per-route requireAuth gate (which only CHECKS req.user) always 401'd,
// because authMiddleware isn't applied globally — that was why analysis
// never started.
router.use(authMiddleware);

// POST /api/commercial/analyze  { channelId, sourceId }
router.post('/analyze', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { channelId, sourceId } = req.body || {};
    if (!channelId || !sourceId) {
      return res.status(400).json({ success: false, error: 'channelId and sourceId required' });
    }
    // Resolve the upstream URL from the fast shadow (PK = source_id,channel_id).
    const r = await postgresService.query(
      `SELECT c.stream_url, s.type
         FROM iptv_channels_search c
         JOIN iptv_sources s ON c.source_id = s.id
        WHERE c.source_id = $1 AND c.channel_id = $2 AND c.user_id = $3
        LIMIT 1`,
      [sourceId, channelId, userId]
    );
    const row = r.rows[0];
    if (!row || !row.stream_url) {
      return res.status(404).json({ success: false, error: 'channel not found' });
    }
    // Stalker stream URLs need a per-play token (create_link), so the
    // stored URL isn't directly analyzable. Skip cleanly for now.
    if (row.type === 'stalker') {
      return res.json({ success: false, skipped: true, reason: 'stalker not supported yet' });
    }
    const ok = detector.startAnalysis(sourceId, channelId, row.stream_url, { headers: null });
    res.json({ success: ok });
  } catch (e) {
    logger.error(`[commercial/analyze] ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/commercial/analyze/stop  { channelId, sourceId }
router.post('/analyze/stop', requireAuth, (req, res) => {
  const { channelId, sourceId } = req.body || {};
  if (channelId) detector.stopAnalysis(sourceId, channelId);
  res.json({ success: true });
});

// GET /api/commercial/analyze/status
router.get('/analyze/status', requireAuth, (req, res) => {
  res.json({ success: true, analyzers: detector.getStatus() });
});

module.exports = router;
