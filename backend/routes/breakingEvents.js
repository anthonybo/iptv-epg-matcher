/**
 * Breaking-events route. Surfaces real-time real-world events (fires,
 * police pursuits, weather, breaking news, big sports moments) with
 * channel hints resolved against the user's IPTV catalog.
 *
 *   GET /api/breaking-events           → cached events (≤ 15 min old)
 *   GET /api/breaking-events?force=1   → bypass cache, re-synthesize
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const { getBreakingEvents } = require('../services/breakingEvents');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, error: 'auth required' });

  const force = req.query.force === '1' || req.query.force === 'true';
  const t0 = Date.now();
  try {
    const result = await getBreakingEvents(userId, { force });
    res.json({ success: true, ...result, elapsedMs: Date.now() - t0 });
  } catch (err) {
    logger.error('[breaking-events] unexpected error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
