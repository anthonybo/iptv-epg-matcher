/**
 * Social feed route — serves the multiview "Live chatter" side panel.
 *
 *   GET /api/social-feed?tag=OPLive            → latest posts for a hashtag
 *   GET /api/social-feed?tag=OPLive&force=1    → bypass the freshness window
 *   GET /api/social-feed?tag=OPLive&limit=40   → cap returned posts
 *
 * Response: { success, configured, tag, posts[], fetchedUpstream, cachedAt }
 *   configured=false means X_COOKIES isn't set — the panel shows a
 *   "connect X" hint instead of an error.
 */
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const { getFeed } = require('../services/socialFeedService');

// Only ever proxy Twitter/X media CDNs — SSRF guard.
function isTwimg(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'twimg.com' || h.endsWith('.twimg.com');
  } catch { return false; }
}

/**
 * GET /api/social-feed/media?url=<twimg url>
 *
 * Media proxy so the panel can show video/image media inline. X's CDNs
 * (video.twimg.com / pbs.twimg.com) refuse playback when embedded from a
 * non-x.com origin (referer/CORS), which surfaced as "couldn't load" on
 * the inline <video>. Relaying the bytes through our own origin makes it
 * same-origin and sidesteps that. Forwards Range so <video> can seek.
 *
 * Deliberately defined BEFORE the authMiddleware below: media elements
 * (<img>/<video> src) can't send the Authorization header, and this only
 * relays public, host-allowlisted Twitter media (no user data).
 */
router.get('/media', async (req, res) => {
  const url = req.query.url;
  if (!url || !isTwimg(url)) return res.status(400).json({ error: 'bad url' });
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Referer': 'https://twitter.com/'
    };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=3600');
    if (upstream.body && typeof upstream.body.pipe === 'function') {
      upstream.body.pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    logger.warn(`[socialFeed media proxy] ${e.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
});

router.use(authMiddleware);

router.get('/', requireAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const tag = req.query.tag || 'OPLive';
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await getFeed(tag, { limit: req.query.limit, force });
    res.json({ success: true, ...result, elapsedMs: Date.now() - t0 });
  } catch (err) {
    logger.error(`[socialFeed route] ${err.message}`);
    res.status(500).json({ success: false, error: 'feed fetch failed' });
  }
});

module.exports = router;
