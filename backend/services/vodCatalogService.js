/**
 * vodCatalogService — Plex/Jellyfin-style precomputed browse catalog.
 *
 * Browse/search/genres used to scan + deduplicate the raw 1.8M-row
 * movie_streams table on every page load. This service does that dedup
 * ONCE, in the background (the "library scan"), into the compact
 * vod_catalog_movies / vod_catalog_series tables (one row per unique
 * movie/series a user has). The browse endpoints then read those small,
 * fully-cacheable tables — fast on any hardware, no DB tuning required.
 *
 * The expensive aggregate legitimately exceeds the 30s app-wide
 * statement_timeout, so refreshes run on a dedicated pool client with
 * `SET LOCAL statement_timeout = 0`, exactly like the genres background
 * compute. Browse readers see the previous catalog (MVCC) until the
 * DELETE+INSERT transaction commits — never a half-built catalog.
 */
const postgresService = require('./postgresService');
const logger = require('../config/logger');

// Treat a catalog older than this as stale, so a lazy browse-path check
// rebuilds it to absorb enrichment drift (rows slowly move from 'pn:'
// unenriched to 'm:' canonical groups). A full rebuild is minutes of
// work, so this is a SLOW backstop, not the primary freshness driver —
// that's the explicit refresh fired when a source finishes ingesting
// (vodIngestService), which is the only time the underlying rows change
// in bulk. 6h keeps periodic rebuilds rare while staying current enough.
const STALE_MS = 6 * 60 * 60 * 1000;

// Prevent two concurrent rebuilds of the same (user, kind) — the second
// would just redo the work and fight for the connection.
const inFlight = new Set();

const KINDS = {
  movie: {
    catalog: 'vod_catalog_movies',
    idCol: 'movie_id',
    rawTable: 'movie_streams',
    canonTable: 'movies',
    canonId: 'movie_id',
    // movie_streams carries provider rating + an added_at timestamp.
    ratingExpr: 'COALESCE(c.rating_tmdb, ms.rating, ms.rating_fallback)',
    addedAtCol: 'ms.added_at',
  },
  series: {
    catalog: 'vod_catalog_series',
    idCol: 'series_id',
    rawTable: 'series_sources',
    canonTable: 'series',
    canonId: 'series_id',
    // series_sources has NO rating / rating_fallback / added_at columns —
    // only the canonical series rating, and created_at as the recency proxy.
    ratingExpr: 'c.rating_tmdb',
    addedAtCol: 'ms.created_at',
  },
};

function buildRefreshSql(kind) {
  const k = KINDS[kind];
  // dedup_key collapses provider-copies of the same title: enriched rows
  // group by canonical id, unenriched by normalized provider name.
  const dedupKey = `COALESCE('m:' || c.id::text, 'pn:' || md5(lower(trim(ms.provider_name))))`;
  return `
    INSERT INTO ${k.catalog}
      (user_id, dedup_key, ${k.idCol}, rep_stream_id,
       title, year, poster_url, rating, enriched, genres, source_count, max_added_at)
    SELECT
      $1 AS user_id,
      ${dedupKey} AS dedup_key,
      MAX(c.id) AS canon_id,
      MIN(ms.id) AS rep_stream_id,
      COALESCE(MIN(c.title), MIN(ms.provider_name)) AS title,
      MAX(c.year) AS year,
      COALESCE(MAX(c.poster_url), MIN(ms.poster_fallback)) AS poster_url,
      MAX(${k.ratingExpr}) AS rating,
      bool_or(c.id IS NOT NULL) AS enriched,
      COALESCE(MAX(c.genres), '{}'::text[]) AS genres,
      COUNT(*)::int AS source_count,
      MAX(${k.addedAtCol}) AS max_added_at
    FROM ${k.rawTable} ms
    JOIN iptv_sources s ON s.id = ms.source_id AND s.user_id = $1
    LEFT JOIN ${k.canonTable} c ON c.id = ms.${k.canonId}
    GROUP BY ${dedupKey}
  `;
}

/**
 * Rebuild one user's catalog for `kind` ('movie'|'series') transactionally.
 * Resolves to the row count written. Concurrent calls for the same
 * (user, kind) are coalesced (the later call returns null).
 */
async function refresh(userId, kind) {
  if (!KINDS[kind]) throw new Error(`Unknown catalog kind: ${kind}`);
  const lock = `${userId}:${kind}`;
  if (inFlight.has(lock)) {
    logger.info(`[vodCatalog] refresh ${lock} already in flight — skipping`);
    return null;
  }
  inFlight.add(lock);

  const k = KINDS[kind];
  let client;
  const t0 = Date.now();
  try {
    client = await postgresService.pool.connect();
    await client.query('BEGIN');
    // This aggregate over the raw table legitimately takes ~tens of
    // seconds; the dedicated client opts out of the app-wide 30s cap.
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query(
      `INSERT INTO vod_catalog_meta (user_id, kind, status) VALUES ($1, $2, 'building')
       ON CONFLICT (user_id, kind) DO UPDATE SET status = 'building'`,
      [userId, kind]
    );
    await client.query(`DELETE FROM ${k.catalog} WHERE user_id = $1`, [userId]);
    const res = await client.query(buildRefreshSql(kind), [userId]);
    // Precompute the genre-count list now (catalog rows are hot in this
    // txn) so /genres is a trivial meta read rather than a cold full
    // unnest+GROUP BY on the browse path.
    const g = await client.query(
      `SELECT g.genre, COUNT(*)::int AS count
         FROM ${k.catalog}, unnest(genres) AS g(genre)
        WHERE user_id = $1
        GROUP BY g.genre
        ORDER BY count DESC, g.genre ASC`,
      [userId]
    );
    await client.query(
      `UPDATE vod_catalog_meta
          SET refreshed_at = NOW(), row_count = $3, status = 'ok', genres_json = $4
        WHERE user_id = $1 AND kind = $2`,
      [userId, kind, res.rowCount, JSON.stringify(g.rows)]
    );
    await client.query('COMMIT');
    logger.info(`[vodCatalog] rebuilt ${kind} catalog for user ${userId}: ${res.rowCount} rows in ${Date.now() - t0}ms`);
    return res.rowCount;
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    try {
      await postgresService.query(
        `UPDATE vod_catalog_meta SET status = 'error' WHERE user_id = $1 AND kind = $2`,
        [userId, kind]
      );
    } catch (_) {}
    logger.error(`[vodCatalog] refresh ${lock} failed: ${err.message}`);
    throw err;
  } finally {
    if (client) client.release();
    inFlight.delete(lock);
  }
}

const refreshMovies = (userId) => refresh(userId, 'movie');
const refreshSeries = (userId) => refresh(userId, 'series');

/** Fire-and-forget rebuild (used post-ingest); errors are logged, not thrown. */
function refreshInBackground(userId, kind) {
  refresh(userId, kind).catch((e) =>
    logger.error(`[vodCatalog] background refresh ${userId}:${kind} failed: ${e.message}`)
  );
}

// Debounce post-ingest rebuilds: a bulk refresh fires ingestVodForSource
// once PER source, but the catalog only needs ONE rebuild after the batch
// settles. Each schedule call resets the timer, so the rebuild runs once,
// ~DEBOUNCE_MS after the last source finishes.
const REFRESH_DEBOUNCE_MS = 90 * 1000;
const refreshTimers = new Map();

function scheduleRefresh(userId, kind, delayMs = REFRESH_DEBOUNCE_MS) {
  if (!KINDS[kind] || !userId) return;
  const key = `${userId}:${kind}`;
  const existing = refreshTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    refreshTimers.delete(key);
    refreshInBackground(userId, kind);
  }, delayMs);
  if (typeof t.unref === 'function') t.unref(); // never keep the process alive
  refreshTimers.set(key, t);
  logger.info(`[vodCatalog] scheduled ${kind} catalog rebuild for user ${userId} in ${Math.round(delayMs / 1000)}s`);
}

async function getMeta(userId, kind) {
  const r = await postgresService.query(
    `SELECT refreshed_at, row_count, status, genres_json FROM vod_catalog_meta WHERE user_id = $1 AND kind = $2`,
    [userId, kind]
  );
  return r.rows[0] || null;
}

/**
 * Genre-count list for the filter. Served from the precomputed
 * genres_json on the meta row (built at refresh time). If it's missing
 * (catalog built before this existed), compute once, store, and return —
 * self-healing without waiting for the next full refresh.
 */
async function getGenres(userId, kind) {
  if (!KINDS[kind]) throw new Error(`Unknown catalog kind: ${kind}`);
  const meta = await getMeta(userId, kind);
  if (meta && Array.isArray(meta.genres_json)) return meta.genres_json;
  const k = KINDS[kind];
  const r = await postgresService.query(
    `SELECT g.genre, COUNT(*)::int AS count
       FROM ${k.catalog}, unnest(genres) AS g(genre)
      WHERE user_id = $1
      GROUP BY g.genre
      ORDER BY count DESC, g.genre ASC`,
    [userId]
  );
  try {
    await postgresService.query(
      `UPDATE vod_catalog_meta SET genres_json = $3 WHERE user_id = $1 AND kind = $2`,
      [userId, kind, JSON.stringify(r.rows)]
    );
  } catch (_) { /* best-effort cache; not fatal */ }
  return r.rows;
}

/** True if the catalog is missing, errored, or older than STALE_MS. */
async function isStale(userId, kind) {
  const meta = await getMeta(userId, kind);
  if (!meta || meta.status === 'error' || !meta.refreshed_at) return true;
  return Date.now() - new Date(meta.refreshed_at).getTime() > STALE_MS;
}

/**
 * Lazily kick a background rebuild if the catalog is stale and not already
 * building. Cheap to call on the browse path — it never blocks the request.
 */
async function ensureFresh(userId, kind) {
  try {
    const meta = await getMeta(userId, kind);
    if (meta && meta.status === 'building') return;
    if (await isStale(userId, kind)) refreshInBackground(userId, kind);
  } catch (e) {
    logger.warn(`[vodCatalog] ensureFresh ${userId}:${kind} check failed: ${e.message}`);
  }
}

module.exports = {
  refresh,
  refreshMovies,
  refreshSeries,
  refreshInBackground,
  scheduleRefresh,
  getMeta,
  getGenres,
  isStale,
  ensureFresh,
  STALE_MS,
};
