const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const postgresService = require('../services/postgresService');
const xtreamVod = require('../services/xtreamVodService');
const stalkerVod = require('../services/stalkerVodService');
const ffmpegService = require('../services/ffmpegService');
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

// ─── Upstream URL resolvers (shared by raw / probe / transmux) ─────
//
// Each returns { upstreamUrl, headers, container } or throws an
// Error tagged with .status so the route handlers can map the right
// HTTP code. Headers include Stalker MAC cookies when needed; the
// raw proxy and ffmpeg pipeline both consume them.

async function resolveMovieUpstream(userId, id) {
  const r = await postgresService.query(
    `SELECT ms.provider_stream_id, ms.container_extension, ms.raw_meta,
            s.id AS source_id, s.type AS source_type, s.url, s.username, s.password, s.mac_address
     FROM movie_streams ms
     JOIN iptv_sources s ON s.id = ms.source_id
     WHERE ms.id = $1 AND s.user_id = $2`,
    [id, userId]
  );
  const row = r.rows[0];
  if (!row) {
    const err = new Error('Movie stream not found');
    err.status = 404;
    throw err;
  }
  return buildUpstreamFromRow(row, 'movie', id);
}

async function resolveEpisodeUpstream(userId, id) {
  const r = await postgresService.query(
    `SELECT es.provider_episode_id AS provider_stream_id, es.container_extension, es.raw_meta,
            s.id AS source_id, s.type AS source_type, s.url, s.username, s.password, s.mac_address
     FROM episode_streams es
     JOIN iptv_sources s ON s.id = es.source_id
     WHERE es.id = $1 AND s.user_id = $2`,
    [id, userId]
  );
  const row = r.rows[0];
  if (!row) {
    const err = new Error('Episode stream not found');
    err.status = 404;
    throw err;
  }
  return buildUpstreamFromRow(row, 'episode', id);
}

async function buildUpstreamFromRow(row, kind, id) {
  let upstreamUrl;
  const headers = { 'User-Agent': VOD_USER_AGENT };
  if (row.source_type === 'xtream') {
    const builder = kind === 'movie' ? xtreamVod.buildMovieStreamUrl : xtreamVod.buildEpisodeStreamUrl;
    upstreamUrl = builder(
      { url: row.url, username: row.username, password: row.password },
      row.provider_stream_id,
      row.container_extension
    );
  } else if (row.source_type === 'stalker') {
    const cmd = row.raw_meta?.cmd || `/media/file_${row.provider_stream_id}.mpg`;
    try {
      upstreamUrl = await stalkerVod.createLink(row.url, row.mac_address, cmd);
    } catch (err) {
      const e = new Error('Stalker portal rejected create_link');
      e.status = 502;
      throw e;
    }
    headers['User-Agent'] = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
    headers['X-User-Agent'] = 'Model: MAG250; Link: WiFi';
    headers['Cookie'] = `mac=${row.mac_address}; stb_lang=en; timezone=America/New_York`;
  } else {
    const e = new Error(`VOD streaming for source type "${row.source_type}" is not supported`);
    e.status = 501;
    throw e;
  }
  return {
    upstreamUrl,
    headers,
    container: (row.container_extension || '').toLowerCase(),
    sourceType: row.source_type,
    id
  };
}

// ─── /probe — codec / container / dimension lookup ────────────────
//
// Frontend hits this on PLAY-button click to figure out which tier
// (direct / transmux / transcode) the chosen source needs. ffprobe
// result is persisted in vod_probe_cache so repeat plays cost a
// single SELECT.

router.get('/probe/movie/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { upstreamUrl, headers, container } = await resolveMovieUpstream(req.user.id, id);
    const r = await ffmpegService.probeStream(upstreamUrl, headers);
    if (!r.ok) {
      // Probe failed — fall through with container hint so the client
      // can still try a default mode rather than refuse to play.
      return res.json({ success: true, probe: null, container, error: r.error });
    }
    return res.json({ success: true, probe: r.probe, container, cached: r.cached });
  } catch (e) {
    logger.error(`[VOD probe movie] ${e.message}`);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

router.get('/probe/episode/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { upstreamUrl, headers, container } = await resolveEpisodeUpstream(req.user.id, id);
    const r = await ffmpegService.probeStream(upstreamUrl, headers);
    if (!r.ok) {
      return res.json({ success: true, probe: null, container, error: r.error });
    }
    return res.json({ success: true, probe: r.probe, container, cached: r.cached });
  } catch (e) {
    logger.error(`[VOD probe episode] ${e.message}`);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// ─── /transmux — ffmpeg-piped fragmented MP4 ──────────────────────
//
// Single endpoint for all three "the browser can't play this as-is"
// modes (copy / audio_only / video_only / full). Mode is selected by
// the `mode` query param — frontend picks based on probe + caps and
// passes it in. We don't pick server-side because the same upstream
// can be played differently by different browsers (e.g. an HEVC mp4
// is direct-play on a 2022+ Mac but transcode on a 2017 Linux box).
//
// Response is fragmented MP4 streamed to stdout → res. Browser uses
// `<video src=...>` with native byte-range. On seek, the browser
// sends `Range: bytes=N-`; we kill+respawn with `-ss <seek>` derived
// from the requested time (sent as `?t=`), and return 200 with a
// fresh fMP4. Plex/Jellyfin do exactly this.

function handleTransmuxResponse(req, res, upstreamUrl, headers, mode, opts) {
  const startTime = Date.now();
  let totalBytes = 0;
  let killed = false;

  const proc = ffmpegService.spawnPipeline(upstreamUrl, headers, mode, opts);
  const cleanup = (reason) => {
    if (killed) return;
    killed = true;
    logger.info(`[VOD transmux] cleanup (${reason}, ${(totalBytes / 1024 / 1024).toFixed(2)}MB in ${Math.round((Date.now() - startTime) / 1000)}s, mode=${mode})`);
    try { proc.kill('SIGKILL'); } catch (_) {}
    try { res.end(); } catch (_) {}
  };

  // Plex/Jellyfin pattern: respond 200 + fMP4 stream, no Content-Length
  // (we don't know the final size), no Range support (seek = respawn).
  // Browser handles the rest via byte-range internally — fragmented
  // MP4 with frag_keyframe+empty_moov is seekable post-load.
  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-store');

  proc.stdout.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (!res.write(chunk)) {
      proc.stdout.pause();
      res.once('drain', () => proc.stdout.resume());
    }
  });
  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString();
    if (msg.trim()) logger.warn(`[VOD transmux stderr] ${msg.trim().slice(0, 200)}`);
  });
  proc.on('exit', (code) => {
    cleanup(`ffmpeg exited ${code}`);
  });
  proc.on('error', (err) => {
    logger.error(`[VOD transmux] ffmpeg spawn error: ${err.message}`);
    cleanup('spawn error');
  });

  req.on('close', () => cleanup('client closed'));
  req.on('aborted', () => cleanup('client aborted'));
  res.on('close', () => cleanup('res closed'));
}

const VALID_MODES = ['copy', 'audio_only', 'video_only', 'full'];

router.get('/transmux/movie/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const mode = VALID_MODES.includes(req.query.mode) ? req.query.mode : 'copy';
    const seek = parseFloat(req.query.t) || 0;
    // Optional output-height clamp for quality selection. Only honor
    // standard heights so a malformed param doesn't drive ffmpeg into
    // a weird scale.
    const allowed = [480, 720, 1080, 1440, 2160];
    const requestedHeight = parseInt(req.query.height, 10);
    const height = allowed.includes(requestedHeight) ? requestedHeight : 0;
    const { upstreamUrl, headers } = await resolveMovieUpstream(req.user.id, id);
    logger.info(`[VOD transmux] movie ${id} mode=${mode} seek=${seek}s height=${height || 'source'}`);
    handleTransmuxResponse(req, res, upstreamUrl, headers, mode, { seek, height });
  } catch (e) {
    logger.error(`[VOD transmux movie] ${e.message}`);
    if (!res.headersSent) {
      res.status(e.status || 500).json({ success: false, error: e.message });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
});

router.get('/transmux/episode/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const mode = VALID_MODES.includes(req.query.mode) ? req.query.mode : 'copy';
    const seek = parseFloat(req.query.t) || 0;
    // Optional output-height clamp for quality selection. Only honor
    // standard heights so a malformed param doesn't drive ffmpeg into
    // a weird scale.
    const allowed = [480, 720, 1080, 1440, 2160];
    const requestedHeight = parseInt(req.query.height, 10);
    const height = allowed.includes(requestedHeight) ? requestedHeight : 0;
    const { upstreamUrl, headers } = await resolveEpisodeUpstream(req.user.id, id);
    logger.info(`[VOD transmux] episode ${id} mode=${mode} seek=${seek}s`);
    handleTransmuxResponse(req, res, upstreamUrl, headers, mode, { seek });
  } catch (e) {
    logger.error(`[VOD transmux episode] ${e.message}`);
    if (!res.headersSent) {
      res.status(e.status || 500).json({ success: false, error: e.message });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
});

/**
 * GET /api/vod-stream/capabilities
 * Returns the backend's detected hwaccel + encoder so the frontend
 * can decide whether to offer transcode tiers (might want to hide
 * them on low-power hosts).
 */
router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ success: true, ...ffmpegService.getHwaccel() });
});

/**
 * GET /api/vod-stream/movie/:movieStreamId
 * Resolves the per-source movie_streams row, builds the upstream
 * URL from the source's creds, and proxies it through.
 */
router.get('/movie/:movieStreamId', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.movieStreamId, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { upstreamUrl, sourceType } = await resolveMovieUpstream(req.user.id, id);
    logger.info(`[VOD proxy] movie ${id} (${sourceType}) → ${upstreamUrl.replace(/(password=|\/)[^/&]+/, '$1***')}`);
    return streamUrlThrough(req, res, upstreamUrl);
  } catch (e) {
    logger.error(`[VOD proxy movie] failed: ${e.message}`);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/vod-stream/episode/:episodeStreamId
 * Same shape as movies but for episode_streams.
 */
router.get('/episode/:episodeStreamId', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.episodeStreamId, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { upstreamUrl, sourceType } = await resolveEpisodeUpstream(req.user.id, id);
    logger.info(`[VOD proxy] episode ${id} (${sourceType}) → ${upstreamUrl.replace(/(password=|\/)[^/&]+/, '$1***')}`);
    return streamUrlThrough(req, res, upstreamUrl);
  } catch (e) {
    logger.error(`[VOD proxy episode] failed: ${e.message}`);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

module.exports = router;
