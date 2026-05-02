/**
 * Trending channels API.
 *
 * GET /api/trending/live
 *   Query params:
 *     region   — optional, filter to one of US/UK/AU/IN/MENA/CN/JP/INTL/...
 *     category — optional, news | sports | entertainment | weather | finance | music
 *     limit    — optional, default 25, max 100
 *
 *   Response:
 *     {
 *       generatedAt:   ISO timestamp of last refresh
 *       sourcesActive: string[] — sources that contributed this tick
 *       sourcesEnabled: string[] — sources that ran (may have produced 0)
 *       count:         number of channels returned
 *       channels:      [{ id, name, region, category, score, signals }]
 *     }
 *
 * GET /api/trending/live/refresh
 *   Force an immediate refresh (debug). Returns the same shape.
 */

const express = require('express');
const router = express.Router();

const trending = require('../services/trendingChannels');

router.get('/live', (req, res) => {
  const { region, category } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

  const snap = trending.getSnapshot();
  let ranked = snap.ranked || [];

  if (region) {
    const r = String(region).toUpperCase();
    ranked = ranked.filter((c) => (c.region || '').toUpperCase() === r);
  }
  if (category) {
    const c = String(category).toLowerCase();
    ranked = ranked.filter((x) => (x.category || '').toLowerCase() === c);
  }

  res.json({
    generatedAt: snap.generatedAt ? new Date(snap.generatedAt).toISOString() : null,
    sourcesActive: snap.sourcesActive || [],
    sourcesEnabled: snap.sourcesEnabled || [],
    stale: trending.isStale(),
    count: Math.min(ranked.length, limit),
    channels: ranked.slice(0, limit),
  });
});

router.get('/live/refresh', async (_req, res) => {
  const snap = await trending.refresh();
  res.json({
    generatedAt: snap.generatedAt ? new Date(snap.generatedAt).toISOString() : null,
    sourcesActive: snap.sourcesActive || [],
    sourcesEnabled: snap.sourcesEnabled || [],
    durationMs: snap.durationMs || null,
    count: (snap.ranked || []).length,
    channels: (snap.ranked || []).slice(0, 25),
  });
});

module.exports = router;
