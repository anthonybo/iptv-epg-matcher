/**
 * Breaking-events route. Surfaces real-time real-world events (fires,
 * police pursuits, weather, breaking news, big sports moments) with
 * channel hints resolved against the user's IPTV catalog.
 *
 *   GET /api/breaking-events           → JSON, cached events (≤ 15 min old)
 *   GET /api/breaking-events?force=1   → JSON, bypass cache
 *   GET /api/breaking-events/stream    → SSE — streams per-source progress
 *                                         + final events as they're ready
 *
 * SSE event types emitted (each a real `event:` line):
 *   cache_hit       — { age } the result came from the 15min cache
 *   source_start    — { source: 'reddit'|'gdelt' }
 *   source_ok       — { source, count, ms }
 *   source_err      — { source, error, ms }
 *   synthesis_start — { threadCount, articleCount }
 *   synthesis_ok    — { ms, eventCount }
 *   matching_start  — { count }
 *   matching_ok     — { count }
 *   complete        — { events, cachedAt, source, elapsedMs }
 *   error           — { error }
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');
const { getBreakingEvents, getPersistedBreakingEvents } = require('../services/breakingEvents');

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

/**
 * SSE variant: streams per-source progress in real time. The frontend
 * uses EventSource to consume — see useBreakingEvents on the client.
 *
 * Why SSE (not WebSocket): one-way server→client, browser-native, plays
 * nicely with Express middleware, auto-reconnects on the client. The
 * one cost is the connection sits open for the duration of the synth
 * (up to ~90s when upstreams are slow) — that's fine because there's
 * only ever one of these per user.
 */
router.get('/stream', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, error: 'auth required' });

  const force = req.query.force === '1' || req.query.force === 'true';

  // SSE headers. X-Accel-Buffering disables nginx's proxy buffering so
  // the events actually flow through immediately rather than landing
  // as a single batched payload at the end.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const send = (type, data) => {
    if (closed) return;
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
    } catch (e) {
      // Client disconnected mid-write — give up gracefully.
      closed = true;
    }
  };

  // Keepalive comment every 15s so proxies (and idle browser timeouts)
  // don't drop the connection while we're waiting on slow upstreams.
  const keepalive = setInterval(() => {
    if (closed) return;
    try { res.write(': keepalive\n\n'); } catch (_) { closed = true; }
  }, 15_000);

  // Client hung up before the pipeline finished — stop emitting and
  // let the in-flight synth complete in the background (cache will
  // hold its result for the next request).
  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
  });

  const t0 = Date.now();
  try {
    send('open', { startedAt: t0 });

    // Preload: emit the last-known still-active events from the DB right away
    // so the tab populates instantly instead of showing an empty/loading
    // screen while the slow/flaky web-search + synthesis runs below.
    try {
      const cached = await getPersistedBreakingEvents(userId);
      if (cached.events.length > 0 && !closed) {
        send('cached', { ...cached, elapsedMs: Date.now() - t0 });
      }
    } catch (e) {
      logger.warn(`[breaking-events/stream] preload failed: ${e.message}`);
    }

    const result = await getBreakingEvents(userId, {
      force,
      onProgress: (ev) => send(ev.type, ev)
    });
    send('complete', { ...result, elapsedMs: Date.now() - t0 });
  } catch (err) {
    logger.error('[breaking-events/stream] error', err);
    send('error', { error: err.message });
  } finally {
    clearInterval(keepalive);
    try { res.end(); } catch (_) {}
  }
});

module.exports = router;
