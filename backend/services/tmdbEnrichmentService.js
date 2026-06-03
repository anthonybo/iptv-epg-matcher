const fetch = require('node-fetch');
const logger = require('../config/logger');
const postgresService = require('./postgresService');
const featureFlags = require('./featureFlags');

/**
 * vodEnrichmentService (file kept as tmdbEnrichmentService.js for
 * backwards-compat imports) — background worker that backfills the
 * canonical `movies` / `series` tables with artwork, overview,
 * ratings, genres and cast looked up from no-API-key sources:
 *
 *   1. IMDb suggestion endpoint (the same JSON the IMDb search box
 *      uses) — gives an IMDb ID + poster + year. No key, no signup,
 *      handles 100% of titles we tested including 2026 streaming-only
 *      releases that iTunes/TMDB miss.
 *        https://v3.sg.media-imdb.com/suggestion/{first-char}/{slug}.json
 *
 *   2. Cinemeta (Stremio's free metadata service) — given the IMDb ID,
 *      returns plot, IMDb rating, genres, runtime, cast, plus a
 *      working poster from metahub.space CDN. No key, no signup.
 *        https://v3-cinemeta.strem.io/meta/{movie|series}/{imdb_id}.json
 *
 * Why this pairing: IMDb's suggestion endpoint nails the fuzzy
 * disambiguation (provider names → canonical title + IMDb ID); then
 * Cinemeta hands us everything else by ID without a second search
 * round-trip. Both endpoints have been stable for years and are used
 * by mainstream apps (IMDb's own search box, the Stremio addon
 * ecosystem). Either could change — the worker degrades gracefully:
 * a failed lookup logs and moves on to the next row.
 *
 * Pipeline per unenriched row:
 *   1. Normalise provider_name (strip [VIP], 4K/UHD/HDR cruft, year).
 *   2. Check in-memory + DB lookup cache. If we've enriched this
 *      title before, reuse the canonical row without an outbound call.
 *   3. IMDb suggest → best candidate (Levenshtein on title + year tie-break).
 *   4. Cinemeta fetch by IMDb ID → full metadata.
 *   5. Upsert into canonical `movies` / `series`. Cross-source dedup:
 *      UPDATE every other unenriched row whose normalised title
 *      shares a prefix so one lookup links the same title across
 *      every provider that carries it.
 *
 * Throttle: 500ms between requests. Both endpoints are community
 * services — be polite, not greedy. A 50k catalog will take many
 * hours; the worker re-ticks every 30s while there's work.
 *
 * No env var required. Auto-starts on backend boot. Set
 * VOD_ENRICHMENT_DISABLED=1 to opt out for deployments that don't
 * want outbound calls.
 */

const IMDB_SUGGEST_BASE = 'https://v3.sg.media-imdb.com/suggestion';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io/meta';
const TVMAZE_LOOKUP_URL = 'https://api.tvmaze.com/lookup/shows';
const TVMAZE_SHOWS_URL = 'https://api.tvmaze.com/shows';
const THROTTLE_MS = 500;
const BATCH_PER_TICK = 50;
const TICK_INTERVAL_MS = 30 * 1000;
const IDLE_INTERVAL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 60 * 1000;
const DISABLED = process.env.VOD_ENRICHMENT_DISABLED === '1';

let workerStarted = false;
let lastTickAt = 0;
const inMemoryMovieCache = new Map(); // (title_norm,year) → movie_id|null
const inMemorySeriesCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── User-operation pause mechanism ───────────────────────────────
//
// The enrichment worker's "OR (movie_id IS NULL AND lower(regexp_
// replace(...)) LIKE $3)" UPDATE on movie_streams forces a seqscan
// and acquires row-level locks for the duration. A single tick can
// hold those locks for ~30 seconds. While that's running, user-
// initiated deletes (which cascade through movie_streams) stall
// waiting for the locks to release. The user sees a delete UI that
// "does nothing" for a minute.
//
// pause()/isPaused() let user-initiated work tell the worker to
// stand down. The worker checks isPaused() between rows in a tick
// and exits early; new ticks defer entirely. This prevents NEW
// UPDATEs from starting while a delete or refresh is in flight.
// We can't preempt the currently-running UPDATE — if one is in
// flight when the user clicks delete, that operation still has to
// finish — but blocking new ones means deletes don't queue up
// behind a steady stream of enrichment work.
let pauseHoldCount = 0;

function pause() {
  pauseHoldCount += 1;
  return function release() {
    pauseHoldCount = Math.max(0, pauseHoldCount - 1);
  };
}

function isPaused() {
  // pauseHoldCount = transient pause held by user-initiated ingest/deletes.
  // The feature flag is a runtime kill switch (e.g. while reindexing the
  // 1.5M-row movie_streams table) that survives across ticks.
  return pauseHoldCount > 0 || featureFlags.isEnabled('pause_vod_enrichment', false);
}

let lastApiCallAt = 0;
async function throttleGate() {
  const elapsed = Date.now() - lastApiCallAt;
  if (elapsed < THROTTLE_MS) await sleep(THROTTLE_MS - elapsed);
  lastApiCallAt = Date.now();
}

async function getJson(url, { timeoutMs = 15000 } = {}) {
  await throttleGate();
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; iptv-epg-matcher/1.0)'
    },
    timeout: timeoutMs
  });
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
    logger.warn(`[enrich] rate-limited (429); backing off ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return getJson(url, { timeoutMs });
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  if (!text) return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    logger.warn(`[enrich] non-JSON body (${text.length}b) from ${url.slice(0, 80)}`);
    if (/rate limit/i.test(text)) await sleep(RATE_LIMIT_BACKOFF_MS);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    logger.warn(`[enrich] JSON parse failed for ${url.slice(0, 80)}: ${e.message}`);
    return null;
  }
}

// ─── Title hygiene ─────────────────────────────────────────────────

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function cleanProviderTitle(title) {
  if (!title) return '';
  let s = String(title);
  s = s.replace(/^\s*\[[^\]]+\]\s*/g, '');
  s = s.replace(/\s*\((19|20)\d{2}\)\s*$/, '').replace(/\s+(19|20)\d{2}\s*$/, '');
  s = s.replace(/\b(4K|UHD|HDR|FHD|HD|SD|1080P|720P|2160P|480P|REMUX|BLURAY)\b/gi, '');
  s = s.replace(/\s*\([A-Z]{2,3}\)\s*$/i, '');
  s = s.replace(/\s+-\s+(19|20)\d{2}\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let curr = i;
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
      prev[j] = curr;
    }
  }
  return prev[n];
}

function pickBestImdbHit(hits, expectedTitle, expectedYear, allowedTypes) {
  if (!hits.length) return null;
  const target = normTitle(expectedTitle);
  let best = null;
  let bestLev = Infinity;
  let bestScore = Infinity;
  for (const h of hits) {
    if (allowedTypes && !allowedTypes.has(h.q)) continue;
    if (!h.id || !String(h.id).startsWith('tt')) continue;
    const lev = levenshtein(normTitle(h.l || ''), target);
    // Year penalty is for RANKING ties between same-titled entries,
    // not for filtering. Only applied when we have a year to match
    // against — provider names commonly lack year for series, and
    // we shouldn't reject every TV match just because we don't have
    // a year to verify with.
    const yearPenalty = (expectedYear && h.y)
      ? Math.abs(expectedYear - h.y) * 30
      : 0;
    const score = lev + yearPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestLev = lev;
      best = h;
    }
  }
  // Reject by Levenshtein alone — title fuzz exceeding the threshold
  // means no year coincidence would rescue it. Threshold scales with
  // title length: floor of 8 chars for short titles.
  if (best && bestLev > Math.max(8, target.length * 0.7)) {
    return null;
  }
  return best;
}

// IMDb suggestion endpoint expects a path of:
//   /suggestion/<first_char_of_slug>/<slug>.json
// where slug is the lower-cased title with non-alphanumeric chars
// replaced by underscores.
async function searchImdbSuggest(title) {
  const cleaned = cleanProviderTitle(title);
  if (!cleaned || cleaned.length < 2) return [];
  const slug = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) return [];
  const url = `${IMDB_SUGGEST_BASE}/${slug[0]}/${encodeURIComponent(slug)}.json`;
  try {
    const data = await getJson(url);
    return Array.isArray(data?.d) ? data.d : [];
  } catch (e) {
    logger.warn(`[enrich] IMDb suggest failed for "${cleaned}": ${e.message}`);
    return [];
  }
}

async function fetchCinemeta(kind, imdbId) {
  const url = `${CINEMETA_BASE}/${kind}/${encodeURIComponent(imdbId)}.json`;
  try {
    const data = await getJson(url, { timeoutMs: 20000 });
    return data?.meta || null;
  } catch (e) {
    logger.warn(`[enrich] Cinemeta ${kind}/${imdbId} failed: ${e.message}`);
    return null;
  }
}

// Fetch full cast (with character names + headshot URLs) from
// TVMaze for a TV series. Cinemeta only gives us cast names; TVMaze
// has properly-keyed person records with portraits. Free, no key,
// covers anything that aired on broadcast/cable/streaming.
//
// Returns an array of { name, character, image } objects, max 30
// entries, in TVMaze's billing order. Empty array if the series
// isn't in TVMaze (which happens for some non-English imports).
async function fetchTvmazeCast(imdbId) {
  if (!imdbId) return [];
  try {
    const lookup = await getJson(`${TVMAZE_LOOKUP_URL}?imdb=${encodeURIComponent(imdbId)}`);
    if (!lookup?.id) return [];
    const cast = await getJson(`${TVMAZE_SHOWS_URL}/${lookup.id}/cast`);
    if (!Array.isArray(cast)) return [];
    return cast
      .map((c) => ({
        name: c.person?.name || null,
        character: c.character?.name || null,
        image: c.person?.image?.original || c.person?.image?.medium || null
      }))
      .filter((c) => c.name)
      .slice(0, 30);
  } catch (e) {
    logger.warn(`[enrich] TVMaze cast lookup for ${imdbId} failed: ${e.message}`);
    return [];
  }
}

// Fetch per-episode metadata from Cinemeta for a series. Cinemeta
// returns episodes as a `videos` array with season+number+thumbnail+
// overview — fields the Xtream `get_series_info` endpoint often
// omits entirely. Used to backfill canonical episode stills after
// the lazy provider fetch persists the season/episode skeleton.
async function fetchCinemetaSeriesEpisodes(imdbId) {
  const meta = await fetchCinemeta('series', imdbId);
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  return videos
    .map((v) => ({
      season: Number(v.season),
      episode: Number(v.number ?? v.episode),
      thumbnail: v.thumbnail || null,
      overview: v.overview || null,
      title: v.name || v.title || null,
      released: v.released ? String(v.released).slice(0, 10) : null
    }))
    .filter((v) => Number.isFinite(v.season) && Number.isFinite(v.episode));
}

// Strip HTML out of Cinemeta descriptions (occasionally has <br/>).
function stripHtml(html) {
  if (!html) return null;
  return String(html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
}

// Parse "119 min" → 7140
function parseRuntimeSecs(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*min/i);
  return m ? parseInt(m[1], 10) * 60 : null;
}

function parseYear(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return (y >= 1900 && y <= new Date().getFullYear() + 5) ? y : null;
}

// ─── Movies ────────────────────────────────────────────────────────

// IMDb 'q' values for things we'll treat as "movies" in the UI's
// Movies tab. The IPTV provider has already decided this row is a
// stream of a single piece of content, so we include TV specials,
// TV movies, made-for-video, etc. — anything that isn't a series.
const MOVIE_TYPES = new Set([
  'feature', 'video', 'tvMovie', 'TV special', 'TV movie',
  'short', 'documentary'
]);
const SERIES_TYPES = new Set([
  'TV series', 'TV mini-series', 'TV miniseries', 'series'
]);

function extractTrailerYtId(meta) {
  const m = meta || {};
  const fromTrailers = Array.isArray(m.trailers) ? m.trailers.find((t) => t.source)?.source : null;
  const fromStreams = Array.isArray(m.trailerStreams) ? m.trailerStreams.find((t) => t.ytId)?.ytId : null;
  return fromTrailers || fromStreams || null;
}

function buildMovieRowFromCinemeta(suggestHit, meta) {
  // Cinemeta sometimes lacks fields; fall back to IMDb suggest data.
  const m = meta || {};
  return {
    tmdb_id: null,
    imdb_id: suggestHit.id,
    title: m.name || suggestHit.l || null,
    year: parseYear(m.year) || suggestHit.y || null,
    overview: stripHtml(m.description) || null,
    poster_url: m.poster || null,
    backdrop_url: m.background || null,
    runtime_secs: parseRuntimeSecs(m.runtime),
    genres: Array.isArray(m.genres) ? m.genres : [],
    director: Array.isArray(m.director) && m.director.length
      ? m.director[0]
      : (Array.isArray(m.writer) && m.writer.length ? m.writer[0] : null),
    cast_json: Array.isArray(m.cast) ? m.cast.slice(0, 12).map((name) => ({ name })) : [],
    rating_tmdb: m.imdbRating ? parseFloat(m.imdbRating) || null : null,
    released_on: m.released ? String(m.released).slice(0, 10) : null,
    trailer_youtube_id: extractTrailerYtId(m)
  };
}

async function upsertCanonicalMovie(row) {
  // Prefer conflict on imdb_id; fall back to (title_norm, year).
  if (row.imdb_id) {
    const r = await postgresService.query(
      `INSERT INTO movies
         (imdb_id, title, year, overview, poster_url, backdrop_url, runtime_secs,
          genres, director, cast_json, rating_tmdb, released_on, trailer_youtube_id, enriched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (imdb_id) DO UPDATE SET
         title = EXCLUDED.title,
         year = EXCLUDED.year,
         overview = COALESCE(EXCLUDED.overview, movies.overview),
         poster_url = COALESCE(EXCLUDED.poster_url, movies.poster_url),
         backdrop_url = COALESCE(EXCLUDED.backdrop_url, movies.backdrop_url),
         runtime_secs = COALESCE(EXCLUDED.runtime_secs, movies.runtime_secs),
         genres = COALESCE(EXCLUDED.genres, movies.genres),
         director = COALESCE(EXCLUDED.director, movies.director),
         cast_json = COALESCE(EXCLUDED.cast_json, movies.cast_json),
         rating_tmdb = COALESCE(EXCLUDED.rating_tmdb, movies.rating_tmdb),
         released_on = COALESCE(EXCLUDED.released_on, movies.released_on),
         trailer_youtube_id = COALESCE(EXCLUDED.trailer_youtube_id, movies.trailer_youtube_id),
         enriched_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [row.imdb_id, row.title, row.year, row.overview, row.poster_url,
       row.backdrop_url, row.runtime_secs, row.genres, row.director,
       JSON.stringify(row.cast_json), row.rating_tmdb, row.released_on,
       row.trailer_youtube_id]
    );
    return r.rows[0].id;
  }
  const r = await postgresService.query(
    `INSERT INTO movies
       (title, year, overview, poster_url, backdrop_url, runtime_secs,
        genres, director, cast_json, rating_tmdb, released_on, trailer_youtube_id, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (title_norm, year) DO UPDATE SET
       overview = COALESCE(EXCLUDED.overview, movies.overview),
       poster_url = COALESCE(EXCLUDED.poster_url, movies.poster_url),
       backdrop_url = COALESCE(EXCLUDED.backdrop_url, movies.backdrop_url),
       runtime_secs = COALESCE(EXCLUDED.runtime_secs, movies.runtime_secs),
       genres = COALESCE(EXCLUDED.genres, movies.genres),
       director = COALESCE(EXCLUDED.director, movies.director),
       cast_json = COALESCE(EXCLUDED.cast_json, movies.cast_json),
       rating_tmdb = COALESCE(EXCLUDED.rating_tmdb, movies.rating_tmdb),
       trailer_youtube_id = COALESCE(EXCLUDED.trailer_youtube_id, movies.trailer_youtube_id),
       enriched_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [row.title, row.year, row.overview, row.poster_url, row.backdrop_url,
     row.runtime_secs, row.genres, row.director, JSON.stringify(row.cast_json),
     row.rating_tmdb, row.released_on, row.trailer_youtube_id]
  );
  return r.rows[0].id;
}

async function enrichMovieRow(row) {
  const titleClean = cleanProviderTitle(row.provider_name);
  const titleYear = parseInt(String(row.provider_name).match(/\b(19|20)\d{2}\b/)?.[0] || '', 10);
  const year = Number.isFinite(titleYear) ? titleYear : null;

  const cacheKey = `${normTitle(titleClean)}|${year || ''}`;
  if (inMemoryMovieCache.has(cacheKey)) {
    const cachedId = inMemoryMovieCache.get(cacheKey);
    if (cachedId == null) return false;
    await postgresService.query(
      `UPDATE movie_streams SET movie_id = $1, updated_at = NOW() WHERE id = $2`,
      [cachedId, row.id]
    );
    return true;
  }

  const hits = await searchImdbSuggest(titleClean);
  const best = pickBestImdbHit(hits, titleClean, year, MOVIE_TYPES);
  if (!best) {
    inMemoryMovieCache.set(cacheKey, null);
    return false;
  }
  const meta = await fetchCinemeta('movie', best.id);
  const movieRow = buildMovieRowFromCinemeta(best, meta);
  if (!movieRow.title) {
    inMemoryMovieCache.set(cacheKey, null);
    return false;
  }
  const movieId = await upsertCanonicalMovie(movieRow);

  // Cross-source dedup, split into two statements so the planner
  // can use the right index for each branch:
  //
  //   1. PK lookup on the freshly-enriched row's id — fast, indexed.
  //   2. Prefix-LIKE on the partial functional index
  //      idx_movie_streams_provider_name_norm (migration 041) — was
  //      a 30s seqscan over 1.4M rows when combined with the OR
  //      above; now sub-ms via the indexed expression.
  //
  // The pre-041 single-statement form was holding row-level locks on
  // every scanned row for ~30s, stalling deletes/refreshes/imports.
  await postgresService.query(
    `UPDATE movie_streams SET movie_id = $1, updated_at = NOW() WHERE id = $2`,
    [movieId, row.id]
  );
  await postgresService.query(
    `UPDATE movie_streams SET movie_id = $1, updated_at = NOW()
       WHERE movie_id IS NULL
         AND lower(regexp_replace(provider_name, '[^a-zA-Z0-9]+', '', 'g'))
             LIKE $2`,
    [movieId, normTitle(movieRow.title) + '%']
  );

  inMemoryMovieCache.set(cacheKey, movieId);
  return true;
}

// ─── Series ────────────────────────────────────────────────────────

function buildSeriesRowFromCinemeta(suggestHit, meta, tvmazeCast) {
  const m = meta || {};
  // Prefer TVMaze cast — it has character names + headshot URLs.
  // Fall back to Cinemeta's name-only list when TVMaze doesn't
  // carry the show.
  const cast = (Array.isArray(tvmazeCast) && tvmazeCast.length > 0)
    ? tvmazeCast
    : (Array.isArray(m.cast) ? m.cast.slice(0, 12).map((name) => ({ name })) : []);
  return {
    tmdb_id: null,
    imdb_id: suggestHit.id,
    title: m.name || suggestHit.l || null,
    year: parseYear(m.year) || suggestHit.y || null,
    overview: stripHtml(m.description) || null,
    poster_url: m.poster || null,
    backdrop_url: m.background || null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    cast_json: cast,
    rating_tmdb: m.imdbRating ? parseFloat(m.imdbRating) || null : null,
    trailer_youtube_id: extractTrailerYtId(m)
  };
}

async function upsertCanonicalSeries(row) {
  if (row.imdb_id) {
    const r = await postgresService.query(
      `INSERT INTO series
         (imdb_id, title, year, overview, poster_url, backdrop_url,
          genres, cast_json, rating_tmdb, trailer_youtube_id, enriched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (imdb_id) DO UPDATE SET
         title = EXCLUDED.title, year = EXCLUDED.year,
         overview = COALESCE(EXCLUDED.overview, series.overview),
         poster_url = COALESCE(EXCLUDED.poster_url, series.poster_url),
         backdrop_url = COALESCE(EXCLUDED.backdrop_url, series.backdrop_url),
         genres = COALESCE(EXCLUDED.genres, series.genres),
         cast_json = COALESCE(EXCLUDED.cast_json, series.cast_json),
         rating_tmdb = COALESCE(EXCLUDED.rating_tmdb, series.rating_tmdb),
         trailer_youtube_id = COALESCE(EXCLUDED.trailer_youtube_id, series.trailer_youtube_id),
         enriched_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [row.imdb_id, row.title, row.year, row.overview, row.poster_url,
       row.backdrop_url, row.genres, JSON.stringify(row.cast_json), row.rating_tmdb,
       row.trailer_youtube_id]
    );
    return r.rows[0].id;
  }
  const r = await postgresService.query(
    `INSERT INTO series
       (title, year, overview, poster_url, backdrop_url,
        genres, cast_json, rating_tmdb, trailer_youtube_id, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (title_norm, year) DO UPDATE SET
       overview = COALESCE(EXCLUDED.overview, series.overview),
       poster_url = COALESCE(EXCLUDED.poster_url, series.poster_url),
       backdrop_url = COALESCE(EXCLUDED.backdrop_url, series.backdrop_url),
       genres = COALESCE(EXCLUDED.genres, series.genres),
       cast_json = COALESCE(EXCLUDED.cast_json, series.cast_json),
       rating_tmdb = COALESCE(EXCLUDED.rating_tmdb, series.rating_tmdb),
       trailer_youtube_id = COALESCE(EXCLUDED.trailer_youtube_id, series.trailer_youtube_id),
       enriched_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [row.title, row.year, row.overview, row.poster_url, row.backdrop_url,
     row.genres, JSON.stringify(row.cast_json), row.rating_tmdb,
     row.trailer_youtube_id]
  );
  return r.rows[0].id;
}

async function enrichSeriesRow(row) {
  const titleClean = cleanProviderTitle(row.provider_name);
  const titleYearStr = (row.raw_meta?.releaseDate || '').slice(0, 4) ||
                       String(row.provider_name).match(/\b(19|20)\d{2}\b/)?.[0] || '';
  const year = titleYearStr ? parseInt(titleYearStr, 10) : null;

  const cacheKey = `${normTitle(titleClean)}|${year || ''}`;
  if (inMemorySeriesCache.has(cacheKey)) {
    const cachedId = inMemorySeriesCache.get(cacheKey);
    if (cachedId == null) return false;
    await postgresService.query(
      `UPDATE series_sources SET series_id = $1, updated_at = NOW() WHERE id = $2`,
      [cachedId, row.id]
    );
    return true;
  }

  const hits = await searchImdbSuggest(titleClean);
  const best = pickBestImdbHit(hits, titleClean, year, SERIES_TYPES);
  if (!best) {
    inMemorySeriesCache.set(cacheKey, null);
    return false;
  }
  const meta = await fetchCinemeta('series', best.id);
  // TVMaze cast — adds character names + headshots Cinemeta lacks.
  // Best-effort; an empty array just means we fall back to Cinemeta's
  // name-only cast list inside buildSeriesRowFromCinemeta.
  const tvmazeCast = await fetchTvmazeCast(best.id);
  const seriesRow = buildSeriesRowFromCinemeta(best, meta, tvmazeCast);
  if (!seriesRow.title) {
    inMemorySeriesCache.set(cacheKey, null);
    return false;
  }
  const seriesId = await upsertCanonicalSeries(seriesRow);

  // See enrichMovieRow for the rationale on splitting these.
  await postgresService.query(
    `UPDATE series_sources SET series_id = $1, updated_at = NOW() WHERE id = $2`,
    [seriesId, row.id]
  );
  await postgresService.query(
    `UPDATE series_sources SET series_id = $1, updated_at = NOW()
       WHERE series_id IS NULL
         AND lower(regexp_replace(provider_name, '[^a-zA-Z0-9]+', '', 'g'))
             LIKE $2`,
    [seriesId, normTitle(seriesRow.title) + '%']
  );

  inMemorySeriesCache.set(cacheKey, seriesId);
  return true;
}

// ─── Worker tick ───────────────────────────────────────────────────

async function runTick() {
  if (DISABLED) return { skipped: true, reason: 'VOD_ENRICHMENT_DISABLED=1' };
  // Don't start a new tick while user-initiated work holds the
  // pause. The worker scheduler will retry on the next interval.
  if (isPaused()) return { skipped: true, reason: 'paused', attempted: 0, enriched: 0 };
  lastTickAt = Date.now();
  let enriched = 0;
  let attempted = 0;

  const movieRows = await postgresService.query(
    `SELECT id, provider_name, raw_meta FROM movie_streams
     WHERE movie_id IS NULL
     ORDER BY updated_at DESC NULLS LAST
     LIMIT $1`,
    [BATCH_PER_TICK]
  );
  for (const row of movieRows.rows) {
    // Re-check between rows so a long batch can be interrupted by
    // a user-initiated delete/refresh — without this, a 50-row tick
    // could take 5+ minutes during which the pause is honored only
    // on the next tick.
    if (isPaused()) {
      logger.info(`[enrich] tick paused mid-batch (movies); ${attempted} attempted, exiting early`);
      return { attempted, enriched, paused: true };
    }
    attempted++;
    try {
      const ok = await enrichMovieRow(row);
      if (ok) enriched++;
    } catch (e) {
      logger.warn(`[enrich] enrichMovieRow ${row.id} failed: ${e.message}`);
    }
  }

  const seriesRows = await postgresService.query(
    `SELECT id, provider_name, raw_meta FROM series_sources
     WHERE series_id IS NULL
     ORDER BY updated_at DESC NULLS LAST
     LIMIT $1`,
    [Math.floor(BATCH_PER_TICK / 2)]
  );
  for (const row of seriesRows.rows) {
    if (isPaused()) {
      logger.info(`[enrich] tick paused mid-batch (series); ${attempted} attempted, exiting early`);
      return { attempted, enriched, paused: true };
    }
    attempted++;
    try {
      const ok = await enrichSeriesRow(row);
      if (ok) enriched++;
    } catch (e) {
      logger.warn(`[enrich] enrichSeriesRow ${row.id} failed: ${e.message}`);
    }
  }

  if (attempted > 0) {
    logger.info(`[enrich] tick: ${enriched}/${attempted} rows enriched (IMDb + Cinemeta)`);
  }
  return { attempted, enriched };
}

function isConfigured() {
  return !DISABLED;
}

function start() {
  if (workerStarted) return;
  workerStarted = true;
  if (DISABLED) {
    logger.info('[enrich] VOD enrichment worker disabled via VOD_ENRICHMENT_DISABLED=1');
    return;
  }
  logger.info('[enrich] VOD enrichment worker starting (IMDb suggest + Cinemeta — no API key)');

  const tick = async () => {
    try {
      const result = await runTick();
      const nextDelay = (result.attempted > 0 && result.enriched > 0)
        ? TICK_INTERVAL_MS
        : IDLE_INTERVAL_MS;
      setTimeout(tick, nextDelay);
    } catch (e) {
      logger.error(`[enrich] tick crashed: ${e.message}`);
      setTimeout(tick, IDLE_INTERVAL_MS);
    }
  };
  setTimeout(tick, 30 * 1000);
}

// Force-enrich a single row on demand (called by the API when a user
// opens a detail page for an unenriched item — no need to wait for
// the background batch to walk to it).
async function enrichMovieStreamId(movieStreamId) {
  const r = await postgresService.query(
    `SELECT id, provider_name, raw_meta, movie_id FROM movie_streams WHERE id = $1`,
    [movieStreamId]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.movie_id) return { ok: true, reason: 'already_enriched', movieId: row.movie_id };
  const linked = await enrichMovieRow(row);
  if (!linked) return { ok: false, reason: 'no_match' };
  const after = await postgresService.query(
    `SELECT movie_id FROM movie_streams WHERE id = $1`,
    [movieStreamId]
  );
  return { ok: true, reason: 'enriched', movieId: after.rows[0]?.movie_id };
}

async function enrichSeriesSourceId(seriesSourceId) {
  const r = await postgresService.query(
    `SELECT ss.id, ss.provider_name, ss.raw_meta, ss.series_id, s.imdb_id, s.cast_json
     FROM series_sources ss
     LEFT JOIN series s ON s.id = ss.series_id
     WHERE ss.id = $1`,
    [seriesSourceId]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  // Already-enriched fast path: skip the IMDb+Cinemeta search but
  // still backfill TVMaze cast when the existing cast_json doesn't
  // carry character names / headshot images yet (old enrichments
  // predate the TVMaze pass).
  if (row.series_id) {
    const castHasImages = Array.isArray(row.cast_json) && row.cast_json.some((c) => c?.image);
    if (castHasImages || !row.imdb_id) {
      return { ok: true, reason: 'already_enriched', seriesId: row.series_id };
    }
    const tvmazeCast = await fetchTvmazeCast(row.imdb_id);
    if (tvmazeCast.length > 0) {
      await postgresService.query(
        `UPDATE series SET cast_json = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(tvmazeCast), row.series_id]
      );
      return { ok: true, reason: 'cast_refreshed', seriesId: row.series_id };
    }
    return { ok: true, reason: 'already_enriched', seriesId: row.series_id };
  }
  const linked = await enrichSeriesRow(row);
  if (!linked) return { ok: false, reason: 'no_match' };
  const after = await postgresService.query(
    `SELECT series_id FROM series_sources WHERE id = $1`,
    [seriesSourceId]
  );
  return { ok: true, reason: 'enriched', seriesId: after.rows[0]?.series_id };
}

module.exports = {
  start,
  runTick,
  isConfigured,
  cleanProviderTitle,
  normTitle,
  pickBestImdbHit,
  enrichMovieStreamId,
  enrichSeriesSourceId,
  fetchCinemetaSeriesEpisodes,
  // Pause/resume so user-initiated work can keep the enrichment
  // worker from acquiring new row locks on movie_streams while a
  // delete/refresh is in flight. Returns a release function.
  pause,
  isPaused
};
