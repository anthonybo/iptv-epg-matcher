const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const postgresService = require('../services/postgresService');
const xtreamVod = require('../services/xtreamVodService');
const stalkerVod = require('../services/stalkerVodService');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');

router.use(authMiddleware);

/**
 * VOD stream proxy routes.
 *
 *   GET /api/vod-stream/movie/:movieStreamId
 *   GET /api/vod-stream/episode/:episodeStreamId
 *
 * Resolves the per-source row, derives the upstream URL on demand
 * (so credential rotations are picked up next time), then streams
 * the response through. Range-request support is forwarded both
 * ways — required for VOD seeking in the browser <video> element.
 *
 * For Xtream sources the URL pattern is canonical:
 *   /movie/{user}/{pass}/{stream_id}.{container_extension}
 *   /series/{user}/{pass}/{episode_id}.{container_extension}
 *
 * For Stalker sources, P4 will add a create_link step before the
 * proxy fetch (skipped here — Stalker rows just return 501 until P4).
 *
 * Why a dedicated route file (vs adding into stream.js):
 *   stream.js is huge (1800+ lines) and is already specialised for
 *   live MPEG-TS streams with ffmpeg-resilient remux, throttling,
 *   and stalker MAC headers per channel. VOD is a simpler beast —
 *   just byte-range proxy a flat file. Mixing them in would mean
 *   reasoning about which throttle / circuit-breaker applies. Keep
 *   them apart.
 */

const VOD_USER_AGENT =
  'VLC/3.0.20 LibVLC/3.0.20';
// VLC UA is what most Xtream panels expect for /movie/ and /series/
// endpoints; Chrome UA sometimes hits anti-bot rules. Stalker proxy
// (when added) will need its own MAG250 UA + Cookie.

const RANGE_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const PASSTHROUGH_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control'
];

async function streamUrlThrough(req, res, upstreamUrl) {
  // Forward range headers so VOD seeking works.
  const headers = { 'User-Agent': VOD_USER_AGENT };
  for (const h of RANGE_HEADERS) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers,
      // No timeout — VOD files are large; the request body itself
      // keeps the connection alive while bytes flow.
      timeout: 0,
      redirect: 'follow'
    });
  } catch (err) {
    logger.error(`[VOD proxy] upstream fetch failed: ${err.message}`);
    return res.status(502).json({ success: false, error: 'Upstream fetch failed', detail: err.message });
  }

  if (!upstream.ok && upstream.status !== 206) {
    logger.warn(`[VOD proxy] upstream ${upstream.status} ${upstream.statusText} for ${upstreamUrl.replace(/(password=)[^&]+/, '$1***')}`);
    return res.status(upstream.status).json({
      success: false,
      error: `Upstream returned ${upstream.status} ${upstream.statusText}`
    });
  }

  // Mirror status + relevant headers, then pipe the body.
  res.status(upstream.status);
  for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) {
    // Some panels don't advertise ranges in the OK response but DO
    // honor a Range request on the next call. Surface it so the
    // browser tries.
    res.setHeader('accept-ranges', 'bytes');
  }

  // Clean up upstream if client disconnects mid-stream.
  const cleanup = () => {
    try { upstream.body.destroy(); } catch (_e) { /* noop */ }
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);

  upstream.body.pipe(res);
}

/**
 * GET /api/vod-stream/movie/:movieStreamId
 * Resolves the per-source movie_streams row, builds the upstream
 * URL from the source's creds, and proxies it through.
 */
router.get('/movie/:movieStreamId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.movieStreamId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    const r = await postgresService.query(
      `SELECT ms.provider_stream_id, ms.container_extension, ms.raw_meta,
              s.id AS source_id, s.type AS source_type, s.url, s.username, s.password, s.mac_address
       FROM movie_streams ms
       JOIN iptv_sources s ON s.id = ms.source_id
       WHERE ms.id = $1 AND s.user_id = $2`,
      [id, userId]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ success: false, error: 'Movie stream not found' });

    let upstreamUrl;
    if (row.source_type === 'xtream') {
      upstreamUrl = xtreamVod.buildMovieStreamUrl(
        { url: row.url, username: row.username, password: row.password },
        row.provider_stream_id,
        row.container_extension
      );
    } else if (row.source_type === 'stalker') {
      // Stalker requires a per-request create_link to mint a fresh
      // signed URL. cmd format: /media/file_{id}.mpg (the canonical
      // pattern). When raw_meta contains a different cmd, prefer it.
      const cmd = row.raw_meta?.cmd || `/media/file_${row.provider_stream_id}.mpg`;
      try {
        upstreamUrl = await stalkerVod.createLink(row.url, row.mac_address, cmd);
      } catch (err) {
        logger.error(`[VOD proxy] stalker create_link failed for movie ${id}: ${err.message}`);
        return res.status(502).json({ success: false, error: 'Stalker portal rejected create_link' });
      }
    } else {
      return res.status(501).json({
        success: false,
        error: `VOD streaming for source type "${row.source_type}" is not supported`
      });
    }

    logger.info(`[VOD proxy] movie ${id} (${row.source_type}) → ${upstreamUrl.replace(/(password=|\/)[^/&]+/, '$1***')}`);
    return streamUrlThrough(req, res, upstreamUrl);
  } catch (error) {
    logger.error(`[VOD proxy movie] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod-stream/episode/:episodeStreamId
 * Same shape as movies but for episode_streams.
 */
router.get('/episode/:episodeStreamId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.episodeStreamId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    const r = await postgresService.query(
      `SELECT es.provider_episode_id, es.container_extension, es.raw_meta,
              s.id AS source_id, s.type AS source_type, s.url, s.username, s.password, s.mac_address
       FROM episode_streams es
       JOIN iptv_sources s ON s.id = es.source_id
       WHERE es.id = $1 AND s.user_id = $2`,
      [id, userId]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ success: false, error: 'Episode stream not found' });

    let upstreamUrl;
    if (row.source_type === 'xtream') {
      upstreamUrl = xtreamVod.buildEpisodeStreamUrl(
        { url: row.url, username: row.username, password: row.password },
        row.provider_episode_id,
        row.container_extension
      );
    } else if (row.source_type === 'stalker') {
      const cmd = row.raw_meta?.cmd || `/media/file_${row.provider_episode_id}.mpg`;
      try {
        upstreamUrl = await stalkerVod.createLink(row.url, row.mac_address, cmd);
      } catch (err) {
        logger.error(`[VOD proxy] stalker create_link failed for episode ${id}: ${err.message}`);
        return res.status(502).json({ success: false, error: 'Stalker portal rejected create_link' });
      }
    } else {
      return res.status(501).json({
        success: false,
        error: `VOD streaming for source type "${row.source_type}" is not supported`
      });
    }

    logger.info(`[VOD proxy] episode ${id} (${row.source_type}) → ${upstreamUrl.replace(/(password=|\/)[^/&]+/, '$1***')}`);
    return streamUrlThrough(req, res, upstreamUrl);
  } catch (error) {
    logger.error(`[VOD proxy episode] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
