const fetch = require('node-fetch');
const logger = require('../config/logger');

/**
 * xtreamVodService — VOD (movies + series) API client for Xtream
 * Codes player_api.php. Mirrors the patterns used by the existing
 * live-channel code in epgService.js (same browser UA, same retry
 * heuristic on transient failures) but kept separate so the live
 * code path doesn't grow.
 *
 * Reference: the worldofiptvcom / ArjunZe Xtream API docs +
 * IPTVnator's mock generators (the most accurate reference for the
 * actual response shape, which the official docs lie about).
 *
 * Endpoints implemented:
 *   - getVodCategories(account)          → [{category_id, category_name, parent_id}]
 *   - getVodStreams(account, opts?)      → [{stream_id, name, container_extension, added, ...}]
 *   - getVodInfo(account, vodId)         → {info: {...} | [], movie_data: {...}}   (lazy)
 *   - getSeriesCategories(account)       → [{category_id, category_name, parent_id}]
 *   - getSeries(account, opts?)          → [{series_id, name, cover, plot, ...}]
 *   - getSeriesInfo(account, seriesId)   → {info, seasons: [], episodes: {"1": [], "2": []}}  (lazy)
 *
 * Stream URL helpers (no network):
 *   - buildMovieStreamUrl(account, streamId, containerExtension)
 *   - buildEpisodeStreamUrl(account, episodeId, containerExtension)
 *
 * Each call expects an `account` shape — kept generic so this
 * service doesn't have to know about iptv_sources schema. Shape:
 *   { url, username, password }
 *
 * "Quirks of the wild" that bit other implementations and that
 * this module normalises around:
 *
 *   1. `get_vod_info.info` is sometimes the empty array `[]` instead
 *      of `null`/`{}` when the panel has no metadata for that movie.
 *      We coerce to `null` so callers don't have to check both.
 *
 *   2. `episodes` in `get_series_info` is an OBJECT keyed by the
 *      season number as a STRING, not an array. Iterating with
 *      `for-of` on it returns nothing. We normalise to an array of
 *      `{ season_number, episodes: [...] }`.
 *
 *   3. `rating` may be a string `"7.5"` OR a number `7.5` OR `""`.
 *      We coerce to `null` or a finite number.
 *
 *   4. `container_extension` is unreliable — some panels return
 *      empty string. The stream-URL helpers fall back to `mkv` (the
 *      Xtream Codes default) when missing, and we expose a flag so
 *      the proxy can probe `mp4` if `mkv` 404s.
 */

const XTREAM_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const XTREAM_API_HEADERS = {
  'User-Agent': XTREAM_BROWSER_UA,
  'Accept': 'application/json, */*'
};

// Transient-failure retry: same envelope the live-channel fetch
// uses (epgService.fetchXtreamAccountInfo). Bulk VOD ingest can
// run into the same rate limits, so we lean on the same backoff
// shape rather than reinventing it.
const RETRY_DELAYS_MS = [0, 3000, 8000];

const isTransientFailure = (err) => {
  const msg = String(err?.message || '');
  if (/HTTP error (403|408|425|429|5\d\d)/i.test(msg)) return true;
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(msg)) return true;
  return false;
};

const normalizeBaseUrl = (url) => {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('Xtream account is missing url');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
};

const buildPlayerApiUrl = (account, action, extra = {}) => {
  const base = normalizeBaseUrl(account.url);
  const params = new URLSearchParams({
    username: account.username,
    password: account.password,
    action,
    ...Object.fromEntries(
      Object.entries(extra).filter(([, v]) => v != null && v !== '')
    )
  });
  return `${base}player_api.php?${params.toString()}`;
};

/**
 * Single-attempt fetch + JSON parse with a clear error message.
 * Wrapped by callWithRetry below — keep this side-effect-free.
 */
const fetchJsonOnce = async (url, { timeoutMs = 30000 } = {}) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: XTREAM_API_HEADERS,
    timeout: timeoutMs
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(
      `HTTP error ${response.status} ${response.statusText} from ${url} — ${body.slice(0, 200)}`
    );
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // Some panels return HTML (Cloudflare challenge etc.) with a 200
    // status. Surface a useful error instead of "Unexpected token <".
    throw new Error(
      `Xtream returned non-JSON body (first 200 chars): ${text.slice(0, 200)}`
    );
  }
};

const callWithRetry = async (label, url, opts) => {
  let lastErr = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
    if (RETRY_DELAYS_MS[i] > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
    }
    try {
      return await fetchJsonOnce(url, opts);
    } catch (err) {
      lastErr = err;
      if (!isTransientFailure(err)) break;
      logger.warn(`[xtreamVod] ${label}: transient failure (attempt ${i + 1}/${RETRY_DELAYS_MS.length}): ${err.message}`);
    }
  }
  throw lastErr;
};

// ─── Normalisers for the API's "wild" response quirks ──────────────

const coerceNumberOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// info can be {} or [] (the latter is the "no metadata" sentinel).
// We collapse both to null so callers test one thing.
const coerceInfoOrNull = (info) => {
  if (!info) return null;
  if (Array.isArray(info)) return null;
  if (typeof info !== 'object') return null;
  if (Object.keys(info).length === 0) return null;
  return info;
};

// Year extraction from a movie/series title — falls back to null.
// Many providers append the year as " (1999)" or " 1999" at the end.
// Used by the enrichment worker for TMDB disambiguation.
const extractYearFromTitle = (title) => {
  if (!title) return null;
  const m = String(title).match(/\b(19\d{2}|20\d{2})\b/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (!Number.isFinite(y)) return null;
  if (y < 1900 || y > new Date().getFullYear() + 2) return null;
  return y;
};

// Strip the trailing year mention from a title so the canonical
// `movies.title` stays clean (year lives in the year column).
//   "The Matrix (1999)" → "The Matrix"
//   "The Matrix 1999"   → "The Matrix"
const stripYearFromTitle = (title) => {
  if (!title) return title;
  return String(title)
    .replace(/\s*\((19|20)\d{2}\)\s*$/, '')
    .replace(/\s+(19|20)\d{2}\s*$/, '')
    .trim();
};

// ─── Public API ────────────────────────────────────────────────────

async function getVodCategories(account) {
  const url = buildPlayerApiUrl(account, 'get_vod_categories');
  const data = await callWithRetry('get_vod_categories', url);
  if (!Array.isArray(data)) return [];
  return data
    .filter((c) => c && c.category_id != null)
    .map((c) => ({
      categoryId: String(c.category_id),
      name: String(c.category_name || '').trim() || 'Uncategorised',
      parentId: c.parent_id != null && c.parent_id !== 0 ? String(c.parent_id) : null
    }));
}

/**
 * One-shot pull of every movie in the catalog. Returns an array of
 * normalised rows ready for bulk-upsert into movie_streams.
 *
 * opts.categoryId — when set, only that category is fetched. Mostly
 * useful for incremental re-fetches; the eager initial ingest passes
 * nothing and gets all 10k–50k rows in a single request.
 */
async function getVodStreams(account, opts = {}) {
  const url = buildPlayerApiUrl(account, 'get_vod_streams', {
    category_id: opts.categoryId
  });
  // Movie list responses are big (multi-MB on large providers). Bump
  // the timeout from the 30s default to 60s.
  const data = await callWithRetry('get_vod_streams', url, { timeoutMs: 60000 });
  if (!Array.isArray(data)) return [];
  return data
    .filter((row) => row && row.stream_id != null && row.name)
    .map((row) => ({
      providerStreamId: String(row.stream_id),
      name: stripYearFromTitle(String(row.name).trim()),
      rawName: String(row.name).trim(),
      year: extractYearFromTitle(row.name),
      categoryId: row.category_id != null ? String(row.category_id) : null,
      containerExtension: row.container_extension ? String(row.container_extension).toLowerCase() : null,
      addedAt: row.added ? parseAddedEpoch(row.added) : null,
      rating: coerceNumberOrNull(row.rating ?? row.rating_5based),
      streamIcon: row.stream_icon || null,
      raw: row // keep for raw_meta column
    }));
}

async function getVodInfo(account, vodId) {
  const url = buildPlayerApiUrl(account, 'get_vod_info', { vod_id: vodId });
  const data = await callWithRetry('get_vod_info', url);
  return {
    info: coerceInfoOrNull(data?.info),
    movieData: data?.movie_data || null
  };
}

async function getSeriesCategories(account) {
  const url = buildPlayerApiUrl(account, 'get_series_categories');
  const data = await callWithRetry('get_series_categories', url);
  if (!Array.isArray(data)) return [];
  return data
    .filter((c) => c && c.category_id != null)
    .map((c) => ({
      categoryId: String(c.category_id),
      name: String(c.category_name || '').trim() || 'Uncategorised',
      parentId: c.parent_id != null && c.parent_id !== 0 ? String(c.parent_id) : null
    }));
}

async function getSeries(account, opts = {}) {
  const url = buildPlayerApiUrl(account, 'get_series', {
    category_id: opts.categoryId
  });
  const data = await callWithRetry('get_series', url, { timeoutMs: 60000 });
  if (!Array.isArray(data)) return [];
  return data
    .filter((row) => row && row.series_id != null && row.name)
    .map((row) => ({
      providerSeriesId: String(row.series_id),
      name: stripYearFromTitle(String(row.name).trim()),
      rawName: String(row.name).trim(),
      year: extractYearFromTitle(row.releaseDate || row.name),
      categoryId: row.category_id != null ? String(row.category_id) : null,
      cover: row.cover || null,
      rating: coerceNumberOrNull(row.rating ?? row.rating_5based),
      raw: row
    }));
}

/**
 * Lazy per-series tree fetch. Normalises the "episodes object keyed
 * by season-number-as-string" quirk into a flat seasons[] array,
 * each with an episodes[] of normalised episode rows.
 */
async function getSeriesInfo(account, seriesId) {
  const url = buildPlayerApiUrl(account, 'get_series_info', { series_id: seriesId });
  const data = await callWithRetry('get_series_info', url, { timeoutMs: 30000 });

  const info = coerceInfoOrNull(data?.info);
  const rawSeasons = Array.isArray(data?.seasons) ? data.seasons : [];
  const episodesByKey = (data && typeof data.episodes === 'object' && !Array.isArray(data.episodes))
    ? data.episodes
    : {};

  // Build a set of season numbers we've encountered (from seasons[]
  // AND from episodes object keys — sometimes one is empty).
  const seasonNumbers = new Set();
  rawSeasons.forEach((s) => {
    const n = parseInt(s.season_number, 10);
    if (Number.isFinite(n)) seasonNumbers.add(n);
  });
  Object.keys(episodesByKey).forEach((k) => {
    const n = parseInt(k, 10);
    if (Number.isFinite(n)) seasonNumbers.add(n);
  });

  const seasons = Array.from(seasonNumbers).sort((a, b) => a - b).map((seasonNum) => {
    const meta = rawSeasons.find((s) => parseInt(s.season_number, 10) === seasonNum) || {};
    const eps = Array.isArray(episodesByKey[String(seasonNum)])
      ? episodesByKey[String(seasonNum)]
      : [];
    return {
      seasonNumber: seasonNum,
      name: meta.name || null,
      overview: meta.overview || null,
      posterUrl: meta.cover || meta.cover_big || null,
      airDate: meta.air_date || null,
      episodes: eps
        .filter((e) => e && e.id != null)
        .map((e) => ({
          providerEpisodeId: String(e.id),
          episodeNumber: parseInt(e.episode_num, 10) || null,
          title: e.title || null,
          containerExtension: e.container_extension ? String(e.container_extension).toLowerCase() : null,
          addedAt: e.added ? parseAddedEpoch(e.added) : null,
          info: coerceInfoOrNull(e.info),
          raw: e
        }))
    };
  });

  return { info, seasons };
}

/**
 * Stream URL builders — pure, no network. The proxy route uses
 * these to look up the upstream URL per request rather than
 * persisting it (so credential rotations are picked up the next
 * time the proxy serves the stream).
 *
 * Movie:   /movie/{user}/{pass}/{stream_id}.{container_extension}
 * Episode: /series/{user}/{pass}/{episode_id}.{container_extension}
 */
function buildMovieStreamUrl(account, streamId, containerExtension) {
  const base = normalizeBaseUrl(account.url).replace(/\/$/, '');
  const ext = (containerExtension || 'mkv').toLowerCase();
  return `${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/${encodeURIComponent(streamId)}.${ext}`;
}

function buildEpisodeStreamUrl(account, episodeId, containerExtension) {
  const base = normalizeBaseUrl(account.url).replace(/\/$/, '');
  const ext = (containerExtension || 'mkv').toLowerCase();
  return `${base}/series/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/${encodeURIComponent(episodeId)}.${ext}`;
}

// `added` is a string Unix epoch; parse → ISO timestamp or null.
function parseAddedEpoch(added) {
  const n = Number(added);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

module.exports = {
  getVodCategories,
  getVodStreams,
  getVodInfo,
  getSeriesCategories,
  getSeries,
  getSeriesInfo,
  buildMovieStreamUrl,
  buildEpisodeStreamUrl,
  // exposed for tests + the enrichment worker
  extractYearFromTitle,
  stripYearFromTitle
};
