import apiClient from '../utils/apiClient';
import { getAuthToken } from '../utils/streamAuth';

/**
 * vodService — thin client wrapper around the /api/vod and
 * /api/vod-stream routes. The pages talk to this so the URL
 * surface only lives in one place.
 */

/**
 * GET /api/vod/categories?kind=movie|series
 * Returns categories grouped per source, server-side ordered.
 */
async function getCategories(kind) {
  const r = await apiClient.get('/vod/categories', { params: { kind } });
  return r.data;
}

/**
 * Cursor-paginated movie browse. opts: { search, sourceId, categoryId, cursor, pageSize, sort }
 * Returns: { movies, hasMore, nextCursor, pageSize }
 */
async function getMovies(opts = {}) {
  const r = await apiClient.get('/vod/movies', {
    params: {
      search: opts.search || undefined,
      sourceId: opts.sourceId || undefined,
      categoryId: opts.categoryId || undefined,
      cursor: opts.cursor || undefined,
      pageSize: opts.pageSize || 30,
      sort: opts.sort || 'recent'
    },
    // AbortSignal so superseding fetches cancel in-flight requests.
    // Same rationale as getSeriesList.
    signal: opts.signal
  });
  return r.data;
}

async function getMovie(id) {
  const r = await apiClient.get(`/vod/movies/${encodeURIComponent(id)}`);
  return r.data;
}

async function enrichMovie(id) {
  const r = await apiClient.post(`/vod/movies/${encodeURIComponent(id)}/enrich`);
  return r.data;
}

async function enrichSeries(id) {
  const r = await apiClient.post(`/vod/series/${encodeURIComponent(id)}/enrich`);
  return r.data;
}

async function getSeriesList(opts = {}) {
  const r = await apiClient.get('/vod/series', {
    params: {
      search: opts.search || undefined,
      sourceId: opts.sourceId || undefined,
      categoryId: opts.categoryId || undefined,
      cursor: opts.cursor || undefined,
      pageSize: opts.pageSize || 30,
      sort: opts.sort || 'recent'
    },
    // Caller can pass an AbortSignal to cancel an in-flight request
    // when a newer one supersedes it. Without this, a slow TV-series
    // page load + a filter change fires both requests and they pile
    // up on the DB; even with the query rewrite the wasted work is
    // worth avoiding. Mirror for /vod/movies if needed.
    signal: opts.signal
  });
  return r.data;
}

async function getSeries(id) {
  const r = await apiClient.get(`/vod/series/${encodeURIComponent(id)}`);
  return r.data;
}

/**
 * Lazy episode fetcher. Backend lazy-fetches + caches 24h. The
 * `sourceId` param picks which provider to lazy-fetch from when a
 * series exists on multiple sources (default: most-recently-updated).
 */
async function getSeriesEpisodes(id, { sourceId } = {}) {
  const r = await apiClient.get(`/vod/series/${encodeURIComponent(id)}/episodes`, {
    params: { source_id: sourceId || undefined }
  });
  return r.data;
}

/**
 * Build a playable URL for a movie or episode. Token rides as a
 * query param because <video> elements can't carry Authorization
 * headers.
 */
// VOD streaming stays on the relative same-origin path because (a) it's
// a single-stream-at-a-time use case so it doesn't compete for slots
// with anything else, and (b) cross-origin autoplay policies are
// stricter — Chrome silently rejected the autoplay when these URLs
// targeted localhost:5001 in dev. Live multi-view tiles still use
// streamBase() (see initMpegts.js / initHls.js) where the connection-
// pool isolation matters and the players don't rely on autoplay.
function buildMovieStreamUrl(movieStreamId) {
  const token = getAuthToken();
  const base = `/api/vod-stream/movie/${encodeURIComponent(movieStreamId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function buildEpisodeStreamUrl(episodeStreamId) {
  const token = getAuthToken();
  const base = `/api/vod-stream/episode/${encodeURIComponent(episodeStreamId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * GET /api/vod-stream/probe/movie/:id → { container, vcodec, acodec, width, height, duration_s, ... }
 * Caller passes this to pickPlaybackTier() to decide direct/transmux/transcode.
 */
async function probeMovie(movieStreamId) {
  const r = await apiClient.get(`/vod-stream/probe/movie/${encodeURIComponent(movieStreamId)}`);
  return r.data;
}

async function probeEpisode(episodeStreamId) {
  const r = await apiClient.get(`/vod-stream/probe/episode/${encodeURIComponent(episodeStreamId)}`);
  return r.data;
}

/**
 * Build the transmux URL for a given mode (copy / audio_only /
 * video_only / full). The frontend tier picker chooses the mode; we
 * just build a token-bearing URL.
 */
function buildMovieTransmuxUrl(movieStreamId, mode, opts = {}) {
  const token = getAuthToken();
  const qs = new URLSearchParams({ mode });
  if (token) qs.set('token', token);
  if (opts.height) qs.set('height', String(opts.height));
  return `/api/vod-stream/transmux/movie/${encodeURIComponent(movieStreamId)}?${qs.toString()}`;
}

function buildEpisodeTransmuxUrl(episodeStreamId, mode, opts = {}) {
  const token = getAuthToken();
  const qs = new URLSearchParams({ mode });
  if (token) qs.set('token', token);
  if (opts.height) qs.set('height', String(opts.height));
  return `/api/vod-stream/transmux/episode/${encodeURIComponent(episodeStreamId)}?${qs.toString()}`;
}

/**
 * Single entry point used by VodDetail. Probes, picks the tier, and
 * returns the URL the <video> should load + a debug `reason` string
 * the UI can surface.
 */
async function buildPlaybackUrl(kind, streamId, container, pickPlaybackTier, opts = {}) {
  const probeFn = kind === 'movie' ? probeMovie : probeEpisode;
  const directBuilder = kind === 'movie' ? buildMovieStreamUrl : buildEpisodeStreamUrl;
  const transmuxBuilder = kind === 'movie' ? buildMovieTransmuxUrl : buildEpisodeTransmuxUrl;

  let probe = null;
  try {
    const r = await probeFn(streamId);
    if (r?.success && r.probe) probe = r.probe;
  } catch (e) {
    // Probe failed — fall through and let the tier picker fall back to
    // the container hint. We don't want a probe outage to break
    // playback for natively-playable content.
  }

  const decision = pickPlaybackTier(probe, container);
  const forcedHeight = Number(opts.height) || 0;

  // Quality override: when the user picks a specific output height,
  // we must transcode video (and re-encode video bitrate is the
  // bigger cost). Force the tier into video_only or full depending on
  // whether the audio also needs work. This overrides the picker's
  // direct/copy choice.
  let tier = decision.tier;
  if (forcedHeight > 0) {
    if (tier === 'audio_only' || tier === 'full') tier = 'full';
    else tier = 'video_only';
  }

  const url = tier === 'direct'
    ? directBuilder(streamId)
    : transmuxBuilder(streamId, tier, forcedHeight ? { height: forcedHeight } : {});
  return { url, tier, reason: decision.reason, probe };
}

export default {
  getCategories,
  getMovies,
  getMovie,
  enrichMovie,
  getSeriesList,
  getSeries,
  enrichSeries,
  getSeriesEpisodes,
  buildMovieStreamUrl,
  buildEpisodeStreamUrl,
  buildMovieTransmuxUrl,
  buildEpisodeTransmuxUrl,
  probeMovie,
  probeEpisode,
  buildPlaybackUrl
};
