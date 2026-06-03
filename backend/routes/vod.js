const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const postgresService = require('../services/postgresService');
const xtreamVod = require('../services/xtreamVodService');
const enrichmentService = require('../services/tmdbEnrichmentService');
const { authMiddleware, requireAuth } = require('../middleware/authMiddleware');
const aiLlmCache = require('../services/aiLlmCache');
const vodCatalog = require('../services/vodCatalogService');

router.use(authMiddleware);

// The /genres aggregate (dedup canonical ids across the user's sources, then
// unnest + group genres) is heavy — tens of seconds on a large catalog — and
// genres change only as enrichment slowly adds titles. So we serve it from a
// persistent cache and recompute it in the BACKGROUND on a dedicated
// no-statement-timeout connection, never blocking (or timing out) the request.
const GENRES_CACHE_TTL_S = 6 * 60 * 60;
const genresInFlight = new Set();

async function computeGenresInBackground(kind, userId, sql) {
  const key = `${kind}:${userId}`;
  if (genresInFlight.has(key)) return; // already computing
  genresInFlight.add(key);
  let client;
  try {
    client = await postgresService.pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 0'); // this aggregate legitimately takes a while
    const r = await client.query(sql, [userId]);
    await client.query('COMMIT');
    await aiLlmCache.set('vod_genres', key, r.rows, GENRES_CACHE_TTL_S);
    logger.info(`[VOD genres] cached ${r.rows.length} genres for ${key}`);
  } catch (e) {
    try { if (client) await client.query('ROLLBACK'); } catch (_) {}
    logger.warn(`[VOD genres] background compute failed for ${key}: ${e.message}`);
  } finally {
    if (client) client.release();
    genresInFlight.delete(key);
  }
}

/**
 * VOD browse + detail routes.
 *
 *   GET  /api/vod/categories?kind=movie|series   — flat per-source list
 *   GET  /api/vod/movies?category=&search=&page= — paginated browse
 *   GET  /api/vod/series?category=&search=&page= — paginated browse
 *   GET  /api/vod/movies/:id                     — single canonical movie + available sources
 *   GET  /api/vod/series/:id                     — single canonical series + seasons (P2 lazy)
 *
 * "id" semantics here are deliberately the CANONICAL movies.id /
 * series.id when one exists. When the row hasn't been enriched yet
 * (most rows initially), the id is the movie_streams.id /
 * series_sources.id with a `provider:` prefix so the URL space
 * stays one-tier from the caller's perspective.
 *
 * Cross-source dedup happens in the queries themselves: rows
 * grouped by movie_id (or by `provider_name + COALESCE(...year...)`
 * when movie_id is NULL) are surfaced once with an aggregated
 * "sources" array describing every account that carries them.
 */

const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;

// Encode/decode a keyset-pagination cursor. We pack the two values
// the sort uses (a sort key + the group id) into a base64-URL string
// so the client treats it as opaque. Keeping it opaque means we can
// change the cursor format later without breaking the client.
function encodeCursor(sortKey, id) {
  const raw = JSON.stringify({ k: sortKey, i: id });
  return Buffer.from(raw, 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const json = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (obj && obj.k != null && obj.i != null) return obj;
  } catch (_) { /* ignore */ }
  return null;
}

// Shared helper to scope a query to "movies/series belonging to a
// source this user owns." All VOD reads go through this.
const userSourcesScope = `
  source_id IN (
    SELECT id FROM iptv_sources WHERE user_id = $1
  )
`;

/**
 * GET /api/vod/genres?kind=movie|series
 *
 * Returns canonical genres (from TMDB enrichment) with per-genre row
 * counts. Cross-source — unlike `/categories` which lists each
 * provider's own bucket strings, this is the union of `movies.genres`
 * / `series.genres` text[] columns scoped to the user's sources.
 *
 * Backed by the GIN index on the genres column so the per-genre
 * COUNT is fast even at scale.
 */
router.get('/genres', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const kind = req.query.kind === 'series' ? 'series' : 'movie';

    // Both kinds are served straight from the precomputed catalog's
    // genres_json (built at refresh time), so this is a trivial meta read
    // — no full-table unnest, no background compute, no caching needed.
    // getGenres self-heals if the catalog predates genres_json. A brand
    // new (unbuilt) catalog returns [] and ensureFresh kicks off the
    // first build in the background.
    vodCatalog.ensureFresh(userId, kind);
    const genres = await vodCatalog.getGenres(userId, kind);
    res.json({ success: true, genres });
  } catch (error) {
    logger.error(`[VOD genres] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod/categories?kind=movie
 * Returns the per-source category list, grouped by source name
 * so the UI can render category groups under each provider.
 */
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const kind = req.query.kind === 'series' ? 'series' : 'movie';

    const { rows } = await postgresService.query(
      `SELECT
         vc.id,
         vc.source_id,
         s.name AS source_name,
         s.nickname AS source_nickname,
         vc.provider_category_id,
         vc.name,
         vc.parent_id
       FROM vod_categories vc
       JOIN iptv_sources s ON s.id = vc.source_id
       WHERE s.user_id = $1 AND vc.kind = $2
       ORDER BY COALESCE(s.nickname, s.name), vc.name`,
      [userId, kind]
    );

    res.json({ success: true, kind, categories: rows });
  } catch (error) {
    logger.error(`[VOD categories] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod/movies
 * Query params:
 *   search       — fuzzy match on title (trgm)
 *   sourceId     — restrict to one provider
 *   categoryId   — provider category to filter by (only meaningful with sourceId)
 *   page         — 1-indexed
 *   pageSize     — default 50, max 200
 *   sort         — recent | title | rating (default: recent)
 *
 * Response:
 *   {
 *     success, page, pageSize, total,
 *     movies: [{
 *       id,                   // canonical movies.id when enriched, else "ms:<movie_streams.id>"
 *       title, year,
 *       poster_url, overview,  // null until enriched
 *       enriched: bool,
 *       rating,
 *       sources: [{ source_id, source_name, provider_stream_id, container_extension, added_at }]
 *     }]
 *   }
 */
router.get('/movies', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const search = (req.query.search || '').trim();
    const sourceId = req.query.sourceId ? parseInt(req.query.sourceId, 10) : null;
    const categoryId = req.query.categoryId || null;
    // Canonical TMDB genre filter — `m.genres @> ARRAY[$N]`. Requires
    // the movie to be enriched (movie_id IS NOT NULL with metadata),
    // so unenriched rows are excluded when a genre is set. The fast
    // LATERAL path doesn't apply here because it groups by provider
    // name; genre filtering routes through the slow path which can
    // JOIN movies and check the genres column.
    const genre = (req.query.genre || '').trim() || null;
    const pageSize = Math.min(PAGE_MAX, Math.max(5, parseInt(req.query.pageSize, 10) || PAGE_DEFAULT));
    const sortKey = ['recent', 'title', 'rating'].includes(req.query.sort) ? req.query.sort : 'recent';
    const cursor = decodeCursor(req.query.cursor);

    // ── CATALOG PATH (Plex/Jellyfin-style precomputed browse) ──────
    // Cross-source browse/search/sort/genre reads the compact
    // vod_catalog_movies table — ONE row per unique movie (deduped at
    // ingest time), already indexed for recent/title/rating, trigram
    // search, and genre filter. This replaces deduplicating the raw
    // 1.8M-row movie_streams on every request (which was 15ms warm but
    // 12-30s cold and timed out on search/title-sort). The
    // provider-scoped drill-downs (sourceId / categoryId) fall through
    // to the raw-table query below, where they're naturally fast
    // because they touch only one source's rows.
    //
    // The response `id` keeps the existing format ('m:<canonical>' or
    // 'ms:<representative stream id>') so /api/vod/movies/:id is
    // unchanged. Rows are unique here, so pagination is a clean keyset
    // on (sort col, dedup_key) — no HAVING, no duplicate-key risk.
    if (!sourceId && !categoryId) {
      // Lazily rebuild the catalog in the background if it's missing or
      // stale. Never blocks this request — we always serve what's there.
      vodCatalog.ensureFresh(userId, 'movie');

      const params = [userId];
      const where = ['user_id = $1'];

      if (search && search.length >= 2) {
        // Same per-token AND trick as before, but over the small catalog
        // title column instead of the raw provider rows.
        const tokens = search.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
        (tokens.length ? tokens : [search]).forEach((tok) => {
          params.push(`%${tok}%`);
          where.push(`title ILIKE $${params.length}`);
        });
      }
      if (genre) {
        params.push(genre);
        where.push(`genres @> ARRAY[$${params.length}]::text[]`);
      }

      const idExpr = `COALESCE('m:' || movie_id::text, 'ms:' || rep_stream_id::text)`;
      let orderBy;
      if (sortKey === 'title') {
        orderBy = 'lower(title) ASC, dedup_key ASC';
        if (cursor) {
          params.push(cursor.k); params.push(cursor.i);
          where.push(`(lower(title), dedup_key) > ($${params.length - 1}, $${params.length})`);
        }
      } else if (sortKey === 'rating') {
        orderBy = 'rating DESC NULLS LAST, dedup_key DESC';
        if (cursor) {
          params.push(cursor.k); params.push(cursor.i);
          where.push(`(rating, dedup_key) < ($${params.length - 1}::numeric, $${params.length})`);
        }
      } else {
        orderBy = 'max_added_at DESC NULLS LAST, dedup_key DESC';
        if (cursor) {
          params.push(cursor.k); params.push(cursor.i);
          where.push(`(max_added_at, dedup_key) < ($${params.length - 1}::timestamptz, $${params.length})`);
        }
      }

      params.push(pageSize + 1);
      const catSql = `
        SELECT ${idExpr} AS id, dedup_key, title, year, poster_url, rating,
               enriched, source_count, max_added_at AS sort_added
        FROM vod_catalog_movies
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $${params.length}
      `;
      const dataResult = await postgresService.query(catSql, params);
      const hasMore = dataResult.rows.length > pageSize;
      const rows = hasMore ? dataResult.rows.slice(0, pageSize) : dataResult.rows;

      let nextCursor = null;
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1];
        const keyValue = sortKey === 'title'
          ? (last.title || '').toLowerCase()
          : sortKey === 'rating'
            ? (last.rating != null ? String(last.rating) : null)
            : (last.sort_added ? new Date(last.sort_added).toISOString() : null);
        // Tiebreaker is dedup_key (the catalog's unique key), matching ORDER BY.
        if (keyValue != null) nextCursor = encodeCursor(keyValue, last.dedup_key);
      }

      const movies = rows.map(({ sort_added, dedup_key, ...rest }) => rest);
      return res.json({ success: true, pageSize, hasMore, nextCursor, movies });
    }

    // ── SCOPED RECENT FAST PATH (single-provider drill-down) ───────
    // The Source dropdown narrows browse to one provider (sourceId, and
    // optionally a categoryId). Deduping is mostly moot within one
    // source, but GROUP-BY-ing that source's entire catalog (40k+ rows)
    // timed out on a cold cache. Instead grab just its most-recent rows
    // via idx_movie_streams_source_added and dedup those — same trick as
    // the catalog refresh, scoped to one source. Recent sort + no
    // search; search/title/rating-within-source fall to the slow path
    // below (already scoped to one source's rows).
    if (sortKey === 'recent' && !search && sourceId) {
      const fp = [sourceId];
      let catFilter = '';
      if (categoryId) { fp.push(categoryId); catFilter = `AND provider_category_id = $${fp.length}`; }
      let havingClause = '';
      if (cursor) { fp.push(cursor.k); havingClause = `HAVING MAX(c.added_at) < $${fp.length}::timestamptz`; }
      fp.push(Math.max(120, pageSize * 4)); const psIdx = fp.length;
      fp.push(pageSize + 1); const outIdx = fp.length;
      const scopedSql = `
        WITH c AS (
          SELECT id, movie_id, provider_name, poster_fallback, rating, rating_fallback, added_at
          FROM movie_streams
          WHERE source_id = $1 ${catFilter}
          ORDER BY added_at DESC NULLS LAST, id DESC
          LIMIT $${psIdx}
        )
        SELECT
          COALESCE('m:' || MIN(m.id)::text, 'ms:' || MIN(c.id)::text) AS id,
          COALESCE(MIN(m.title), MIN(c.provider_name)) AS title,
          MIN(m.year) AS year,
          COALESCE(MIN(m.poster_url), MIN(c.poster_fallback)) AS poster_url,
          MAX(COALESCE(m.rating_tmdb, c.rating, c.rating_fallback)) AS rating,
          BOOL_OR(m.id IS NOT NULL) AS enriched,
          COUNT(*)::int AS source_count,
          MAX(c.added_at) AS sort_added
        FROM c LEFT JOIN movies m ON m.id = c.movie_id
        GROUP BY COALESCE('m:' || m.id::text, 'pn:' || md5(LOWER(TRIM(c.provider_name))))
        ${havingClause}
        ORDER BY MAX(c.added_at) DESC NULLS LAST,
                 COALESCE('m:' || MIN(m.id)::text, 'ms:' || MIN(c.id)::text) DESC
        LIMIT $${outIdx}
      `;
      const dataResult = await postgresService.query(scopedSql, fp);
      const hasMore = dataResult.rows.length > pageSize;
      const rows = hasMore ? dataResult.rows.slice(0, pageSize) : dataResult.rows;
      let nextCursor = null;
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1];
        const keyValue = last.sort_added ? new Date(last.sort_added).toISOString() : null;
        if (keyValue != null) nextCursor = encodeCursor(keyValue, last.id);
      }
      const movies = rows.map(({ sort_added, ...rest }) => rest);
      return res.json({ success: true, pageSize, hasMore, nextCursor, movies });
    }

    // ── SLOW PATH (search / category / non-recent sort) ────────────
    // Build dynamic WHERE. Same shape as before — joins, scoping,
    // filters; just no longer does COUNT(*) or runtime JSONB extract.
    //
    // Search: same UNION rewrite as /series — see comment there. A
    // plain `WHERE COALESCE(m.title, ms.provider_name) ILIKE $X`
    // can't push the predicate down to either trgm index because
    // COALESCE is an expression, so the planner falls back to a
    // Parallel Seq Scan of all 1.4M movie_streams rows.

    const params = [userId];
    let sourceClause = '';
    let catClause = '';
    let genreClause = '';
    if (sourceId) {
      params.push(sourceId);
      sourceClause = `AND ms.source_id = $${params.length}`;
    }
    if (categoryId) {
      params.push(categoryId);
      catClause = `AND ms.provider_category_id = $${params.length}`;
    }
    // Genre filter — applies via the JOIN to the canonical `movies`
    // table, so unenriched rows (no movie_id) are naturally excluded.
    // `genres @> ARRAY[$N]` hits the GIN index from migration on the
    // movies table; very fast even on 2k+ rows.
    if (genre) {
      params.push(genre);
      genreClause = `AND m.genres @> ARRAY[$${params.length}]::text[]`;
    }

    let candidatesCte = '';
    let fromTable;
    let whereClause = '';
    if (search && search.length >= 2) {
      // See /series for the rationale — same tokenization trick to
      // beat punctuation gaps in titles ("On Patrol: Live" vs
      // "on patrol live"). Each token gets its own ILIKE; the AND
      // intersection still hits the GIN trgm index.
      const tokens = search.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
      const effectiveTokens = tokens.length ? tokens : [search];
      const titleAnds = [];
      const provAnds = [];
      effectiveTokens.forEach((tok) => {
        params.push(`%${tok}%`);
        titleAnds.push(`m.title ILIKE $${params.length}`);
        provAnds.push(`ms.provider_name ILIKE $${params.length}`);
      });
      candidatesCte = `
        WITH candidates AS (
          SELECT ms.id, ms.movie_id, ms.provider_name, ms.poster_fallback,
                 ms.source_id, ms.added_at, ms.rating, ms.rating_fallback,
                 ms.provider_category_id
          FROM movie_streams ms
          WHERE ms.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $1)
            ${sourceClause} ${catClause}
            AND ${provAnds.join(' AND ')}
          UNION
          SELECT ms.id, ms.movie_id, ms.provider_name, ms.poster_fallback,
                 ms.source_id, ms.added_at, ms.rating, ms.rating_fallback,
                 ms.provider_category_id
          FROM movie_streams ms
          JOIN movies m ON m.id = ms.movie_id
          WHERE ms.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $1)
            ${sourceClause} ${catClause}
            AND ${titleAnds.join(' AND ')}
        )
      `;
      fromTable = `candidates ms`;
    } else {
      const whereParts = [`ms.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $1)`];
      if (sourceClause) whereParts.push(sourceClause.replace(/^AND /, ''));
      if (catClause) whereParts.push(catClause.replace(/^AND /, ''));
      fromTable = `movie_streams ms`;
      whereClause = `WHERE ${whereParts.join(' AND ')}`;
    }

    const groupKey = `COALESCE('m:' || m.id::text, 'ms:' || ms.id::text)`;

    // Sort + cursor logic. Each sort mode has its own keyset shape:
    // recent  → (MAX(added_at), id) DESC
    // title   → (MIN(title), id) ASC
    // rating  → (MAX(rating), id) DESC NULLS LAST
    let orderBy, havingCursor;
    if (sortKey === 'title') {
      orderBy = `MIN(COALESCE(m.title, ms.provider_name)) ASC, ${groupKey} ASC`;
      if (cursor) {
        params.push(cursor.k); params.push(cursor.i);
        havingCursor = `(MIN(COALESCE(m.title, ms.provider_name)), ${groupKey}) > ($${params.length - 1}, $${params.length})`;
      }
    } else if (sortKey === 'rating') {
      orderBy = `MAX(COALESCE(m.rating_tmdb, ms.rating, ms.rating_fallback)) DESC NULLS LAST, ${groupKey} DESC`;
      if (cursor) {
        params.push(cursor.k); params.push(cursor.i);
        havingCursor = `(MAX(COALESCE(m.rating_tmdb, ms.rating, ms.rating_fallback)), ${groupKey}) < ($${params.length - 1}::numeric, $${params.length})`;
      }
    } else {
      orderBy = `MAX(ms.added_at) DESC NULLS LAST, ${groupKey} DESC`;
      if (cursor) {
        params.push(cursor.k); params.push(cursor.i);
        havingCursor = `(MAX(ms.added_at), ${groupKey}) < ($${params.length - 1}::timestamptz, $${params.length})`;
      }
    }

    // pageSize + 1 lets us know if there's another page without
    // running a separate COUNT(*) — if the over-fetch returns N+1
    // rows, we trim the last and emit a next_cursor.
    const dataSql = `
      ${candidatesCte}
      SELECT
        ${groupKey} AS id,
        COALESCE(MIN(m.title), MIN(ms.provider_name)) AS title,
        MIN(m.year) AS year,
        COALESCE(MIN(m.poster_url), MIN(ms.poster_fallback)) AS poster_url,
        MAX(COALESCE(m.rating_tmdb, ms.rating, ms.rating_fallback)) AS rating,
        BOOL_OR(m.id IS NOT NULL) AS enriched,
        COUNT(*)::int AS source_count,
        MAX(ms.added_at) AS sort_added,
        MIN(COALESCE(m.title, ms.provider_name)) AS sort_title
      FROM ${fromTable}
      ${genre ? 'JOIN' : 'LEFT JOIN'} movies m ON m.id = ms.movie_id
      ${whereClause}
      ${whereClause && genreClause ? genreClause : (genreClause ? `WHERE ${genreClause.replace(/^AND /, '')}` : '')}
      GROUP BY ${groupKey}
      ${havingCursor ? `HAVING ${havingCursor}` : ''}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1}
    `;
    const dataResult = await postgresService.query(dataSql, [...params, pageSize + 1]);

    const hasMore = dataResult.rows.length > pageSize;
    const rows = hasMore ? dataResult.rows.slice(0, pageSize) : dataResult.rows;

    let nextCursor = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1];
      const keyValue = sortKey === 'title' ? last.sort_title
        : sortKey === 'rating' ? (last.rating != null ? String(last.rating) : null)
        : (last.sort_added ? new Date(last.sort_added).toISOString() : null);
      if (keyValue != null) nextCursor = encodeCursor(keyValue, last.id);
    }

    // Strip the sort_* helper columns from the response — clients
    // don't need them and they bloat the payload.
    const movies = rows.map(({ sort_added, sort_title, ...rest }) => rest);

    res.json({
      success: true,
      pageSize,
      hasMore,
      nextCursor,
      movies
    });
  } catch (error) {
    logger.error(`[VOD movies] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod/series — same shape as /movies but for series_sources.
 * No episode info here; the series-detail route lazy-fetches the
 * tree on first open.
 */
router.get('/series', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const search = (req.query.search || '').trim();
    const sourceId = req.query.sourceId ? parseInt(req.query.sourceId, 10) : null;
    const categoryId = req.query.categoryId || null;
    const genre = (req.query.genre || '').trim() || null;
    const pageSize = Math.min(PAGE_MAX, Math.max(5, parseInt(req.query.pageSize, 10) || PAGE_DEFAULT));
    const sortKey = ['recent', 'title', 'rating'].includes(req.query.sort) ? req.query.sort : 'recent';
    const cursor = decodeCursor(req.query.cursor);

    // ── CATALOG PATH (Plex/Jellyfin-style precomputed browse) ──────
    // Mirror of /movies: cross-source browse/search/sort/genre reads the
    // compact vod_catalog_series table (one row per unique series,
    // deduped at ingest) instead of deduplicating raw series_sources on
    // every request. Provider-scoped drill-downs (sourceId / categoryId)
    // fall through to the raw-table query below. Response `id` keeps the
    // existing 's:<canonical>' / 'ss:<stream id>' format so
    // /api/vod/series/:id is unchanged; rows are unique here so
    // pagination is a clean keyset with no duplicate-key risk.
    if (!sourceId && !categoryId) {
      vodCatalog.ensureFresh(userId, 'series');

      const params = [userId];
      const where = ['user_id = $1'];

      if (search && search.length >= 2) {
        const tokens = search.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
        (tokens.length ? tokens : [search]).forEach((tok) => {
          params.push(`%${tok}%`);
          where.push(`title ILIKE $${params.length}`);
        });
      }
      if (genre) {
        params.push(genre);
        where.push(`genres @> ARRAY[$${params.length}]::text[]`);
      }

      const idExpr = `COALESCE('s:' || series_id::text, 'ss:' || rep_stream_id::text)`;
      let orderBy;
      if (sortKey === 'title') {
        orderBy = 'lower(title) ASC, dedup_key ASC';
        if (cursor) {
          params.push(cursor.k); params.push(cursor.i);
          where.push(`(lower(title), dedup_key) > ($${params.length - 1}, $${params.length})`);
        }
      } else if (sortKey === 'rating') {
        orderBy = 'rating DESC NULLS LAST, dedup_key DESC';
        if (cursor) {
          params.push(cursor.k); params.push(cursor.i);
          where.push(`(rating, dedup_key) < ($${params.length - 1}::numeric, $${params.length})`);
        }
      } else {
        orderBy = 'max_added_at DESC NULLS LAST, dedup_key DESC';
        if (cursor) {
          params.push(cursor.k); params.push(cursor.i);
          where.push(`(max_added_at, dedup_key) < ($${params.length - 1}::timestamptz, $${params.length})`);
        }
      }

      params.push(pageSize + 1);
      const catSql = `
        SELECT ${idExpr} AS id, dedup_key, title, year, poster_url, rating,
               enriched, source_count, max_added_at AS sort_added
        FROM vod_catalog_series
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $${params.length}
      `;
      const dataResult = await postgresService.query(catSql, params);
      const hasMore = dataResult.rows.length > pageSize;
      const rows = hasMore ? dataResult.rows.slice(0, pageSize) : dataResult.rows;

      let nextCursor = null;
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1];
        const keyValue = sortKey === 'title'
          ? (last.title || '').toLowerCase()
          : sortKey === 'rating'
            ? (last.rating != null ? String(last.rating) : null)
            : (last.sort_added ? new Date(last.sort_added).toISOString() : null);
        if (keyValue != null) nextCursor = encodeCursor(keyValue, last.dedup_key);
      }

      const series = rows.map(({ sort_added, dedup_key, ...rest }) => rest);
      return res.json({ success: true, pageSize, hasMore, nextCursor, series });
    }

    // ── SCOPED RECENT FAST PATH (single-provider drill-down) ───────
    // Mirror of /movies: narrow to one source's most-recent rows via
    // migration-038's (source_id, updated_at DESC, id DESC) index and
    // dedup those, instead of GROUP-BY-ing the whole source.
    if (sortKey === 'recent' && !search && sourceId) {
      const fp = [sourceId];
      let catFilter = '';
      if (categoryId) { fp.push(categoryId); catFilter = `AND provider_category_id = $${fp.length}`; }
      let havingClause = '';
      if (cursor) { fp.push(cursor.k); havingClause = `HAVING MAX(c.updated_at) < $${fp.length}::timestamptz`; }
      fp.push(Math.max(120, pageSize * 4)); const psIdx = fp.length;
      fp.push(pageSize + 1); const outIdx = fp.length;
      const scopedSql = `
        WITH c AS (
          SELECT id, series_id, provider_name, poster_fallback, updated_at
          FROM series_sources
          WHERE source_id = $1 ${catFilter}
          ORDER BY updated_at DESC NULLS LAST, id DESC
          LIMIT $${psIdx}
        )
        SELECT
          COALESCE('s:' || MIN(sr.id)::text, 'ss:' || MIN(c.id)::text) AS id,
          COALESCE(MIN(sr.title), MIN(c.provider_name)) AS title,
          MIN(sr.year) AS year,
          COALESCE(MIN(sr.poster_url), MIN(c.poster_fallback)) AS poster_url,
          MAX(sr.rating_tmdb) AS rating,
          BOOL_OR(sr.id IS NOT NULL) AS enriched,
          COUNT(*)::int AS source_count,
          MAX(c.updated_at) AS sort_updated
        FROM c LEFT JOIN series sr ON sr.id = c.series_id
        GROUP BY COALESCE('s:' || sr.id::text, 'pn:' || md5(LOWER(TRIM(c.provider_name))))
        ${havingClause}
        ORDER BY MAX(c.updated_at) DESC NULLS LAST,
                 COALESCE('s:' || MIN(sr.id)::text, 'ss:' || MIN(c.id)::text) DESC
        LIMIT $${outIdx}
      `;
      const dataResult = await postgresService.query(scopedSql, fp);
      const hasMore = dataResult.rows.length > pageSize;
      const rows = hasMore ? dataResult.rows.slice(0, pageSize) : dataResult.rows;
      let nextCursor = null;
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1];
        const keyValue = last.sort_updated ? new Date(last.sort_updated).toISOString() : null;
        if (keyValue != null) nextCursor = encodeCursor(keyValue, last.id);
      }
      const series = rows.map(({ sort_updated, ...rest }) => rest);
      return res.json({ success: true, pageSize, hasMore, nextCursor, series });
    }

    // ── SLOW PATH (search / category / non-recent sort) ────────────
    // The original GROUP BY query — kept as the fallback for paths
    // where the LATERAL pre-filter would lose correctness (title /
    // rating sorts need to see every row to find the global top-N).
    //
    // Search rewrite: a naive `WHERE COALESCE(sr.title, ss.provider_name)
    // ILIKE $1` defeats both trgm indexes because COALESCE is an
    // expression the planner can't push down to either underlying
    // column. EXPLAIN ANALYZE on a real query showed Parallel Seq Scan
    // over all 307k series_sources rows → 10+ second timeouts. The
    // fix is to UNION two index-friendly halves: one matches
    // ss.provider_name (uses idx_series_sources_provider_name_trgm),
    // the other joins through to series and matches sr.title (uses
    // idx_series_title_trgm). UNION dedupes so a series matching both
    // sides counts once. Search drops from timeout → ~500ms.

    const params = [userId];
    let sourceClause = '';
    let catClause = '';
    let genreClause = '';
    if (sourceId) {
      params.push(sourceId);
      sourceClause = `AND ss.source_id = $${params.length}`;
    }
    if (categoryId) {
      params.push(categoryId);
      catClause = `AND ss.provider_category_id = $${params.length}`;
    }
    // Genre filter via canonical TMDB-enriched `series.genres` column.
    // Implicitly requires the row to be enriched (joined to series),
    // so unenriched provider rows fall out of the result.
    if (genre) {
      params.push(genre);
      genreClause = `AND sr.genres @> ARRAY[$${params.length}]::text[]`;
    }

    // Build the FROM table reference + an optional WHERE that runs
    // AFTER the LEFT JOIN. They have to be separate strings: SQL
    // requires JOINs before WHERE, so we can't inline the WHERE into
    // the FROM expression for the no-search path.
    let candidatesCte = '';
    let fromTable;
    let whereClause = '';
    if (search && search.length >= 2) {
      // Tokenize on whitespace so "on patrol live" matches
      // "On Patrol: Live" (punctuation breaks a literal ILIKE
      // substring match). Each token becomes its own ILIKE that
      // can still leverage the GIN trgm index, and the AND'd
      // bitmap intersection filters to rows containing all tokens.
      // Cap at 6 tokens — anything beyond is degenerate user input
      // and would just balloon the bitmap intersection cost.
      const tokens = search.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
      // Fall back to the whole-string match if every token is
      // ultra-short (e.g. "a b") so we don't end up with an empty
      // predicate that returns the entire catalog.
      const effectiveTokens = tokens.length ? tokens : [search];
      const titleAnds = [];
      const provAnds = [];
      effectiveTokens.forEach((tok) => {
        params.push(`%${tok}%`);
        titleAnds.push(`sr.title ILIKE $${params.length}`);
        provAnds.push(`ss.provider_name ILIKE $${params.length}`);
      });
      candidatesCte = `
        WITH candidates AS (
          SELECT ss.id, ss.series_id, ss.provider_name, ss.poster_fallback,
                 ss.source_id, ss.updated_at, ss.provider_category_id
          FROM series_sources ss
          WHERE ss.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $1)
            ${sourceClause} ${catClause}
            AND ${provAnds.join(' AND ')}
          UNION
          SELECT ss.id, ss.series_id, ss.provider_name, ss.poster_fallback,
                 ss.source_id, ss.updated_at, ss.provider_category_id
          FROM series_sources ss
          JOIN series sr ON sr.id = ss.series_id
          WHERE ss.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $1)
            ${sourceClause} ${catClause}
            AND ${titleAnds.join(' AND ')}
        )
      `;
      fromTable = `candidates ss`;
    } else {
      const whereParts = [`ss.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $1)`];
      if (sourceClause) whereParts.push(sourceClause.replace(/^AND /, ''));
      if (catClause) whereParts.push(catClause.replace(/^AND /, ''));
      fromTable = `series_sources ss`;
      whereClause = `WHERE ${whereParts.join(' AND ')}`;
    }

    const groupKey = `COALESCE('s:' || sr.id::text, 'ss:' || ss.id::text)`;

    let orderBy, havingCursor;
    if (sortKey === 'title') {
      orderBy = `MIN(COALESCE(sr.title, ss.provider_name)) ASC, ${groupKey} ASC`;
      if (cursor) {
        params.push(cursor.k); params.push(cursor.i);
        havingCursor = `(MIN(COALESCE(sr.title, ss.provider_name)), ${groupKey}) > ($${params.length - 1}, $${params.length})`;
      }
    } else if (sortKey === 'rating') {
      orderBy = `MAX(sr.rating_tmdb) DESC NULLS LAST, ${groupKey} DESC`;
      if (cursor) {
        params.push(cursor.k); params.push(cursor.i);
        havingCursor = `(MAX(sr.rating_tmdb), ${groupKey}) < ($${params.length - 1}::numeric, $${params.length})`;
      }
    } else {
      orderBy = `MAX(ss.updated_at) DESC NULLS LAST, ${groupKey} DESC`;
      if (cursor) {
        params.push(cursor.k); params.push(cursor.i);
        havingCursor = `(MAX(ss.updated_at), ${groupKey}) < ($${params.length - 1}::timestamptz, $${params.length})`;
      }
    }

    const dataSql = `
      ${candidatesCte}
      SELECT
        ${groupKey} AS id,
        COALESCE(MIN(sr.title), MIN(ss.provider_name)) AS title,
        MIN(sr.year) AS year,
        COALESCE(MIN(sr.poster_url), MIN(ss.poster_fallback)) AS poster_url,
        MAX(sr.rating_tmdb) AS rating,
        BOOL_OR(sr.id IS NOT NULL) AS enriched,
        COUNT(*)::int AS source_count,
        MAX(ss.updated_at) AS sort_updated,
        MIN(COALESCE(sr.title, ss.provider_name)) AS sort_title
      FROM ${fromTable}
      ${genre ? 'JOIN' : 'LEFT JOIN'} series sr ON sr.id = ss.series_id
      ${whereClause}
      ${whereClause && genreClause ? genreClause : (genreClause ? `WHERE ${genreClause.replace(/^AND /, '')}` : '')}
      GROUP BY ${groupKey}
      ${havingCursor ? `HAVING ${havingCursor}` : ''}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1}
    `;
    const dataResult = await postgresService.query(dataSql, [...params, pageSize + 1]);

    const hasMore = dataResult.rows.length > pageSize;
    const rows = hasMore ? dataResult.rows.slice(0, pageSize) : dataResult.rows;

    let nextCursor = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1];
      const keyValue = sortKey === 'title' ? last.sort_title
        : sortKey === 'rating' ? (last.rating != null ? String(last.rating) : null)
        : (last.sort_updated ? new Date(last.sort_updated).toISOString() : null);
      if (keyValue != null) nextCursor = encodeCursor(keyValue, last.id);
    }

    const series = rows.map(({ sort_updated, sort_title, ...rest }) => rest);

    res.json({
      success: true,
      pageSize,
      hasMore,
      nextCursor,
      series
    });
  } catch (error) {
    logger.error(`[VOD series] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod/movies/:id
 * id formats:
 *   "m:<movies.id>"     — canonical (enriched)
 *   "ms:<movie_streams.id>" — provider-only (not yet enriched)
 *
 * Returns the canonical metadata (if available) PLUS the full
 * list of per-source availability rows the user can play from.
 */
router.get('/movies/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [prefix, rawId] = String(req.params.id).split(':');
    const idNum = parseInt(rawId, 10);
    if (!['m', 'ms'].includes(prefix) || !Number.isFinite(idNum)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    let movieId = prefix === 'm' ? idNum : null;
    if (prefix === 'ms') {
      // Map provider row → canonical (may still be null if unenriched).
      const r = await postgresService.query(
        `SELECT movie_id FROM movie_streams ms
         WHERE ms.id = $1 AND ms.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $2)`,
        [idNum, userId]
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      movieId = r.rows[0].movie_id;
    }

    let canonical = null;
    if (movieId) {
      const cr = await postgresService.query(
        `SELECT id, tmdb_id, imdb_id, title, year, overview, poster_url, backdrop_url,
                runtime_secs, genres, director, cast_json, rating_tmdb, rating_imdb,
                released_on, trailer_youtube_id, enriched_at
         FROM movies WHERE id = $1`,
        [movieId]
      );
      canonical = cr.rows[0] || null;
    }

    // All per-source rows for this movie (or just the one provider row
    // when there's no canonical link). raw_meta is included so the
    // synthetic canonical can fall back to the provider's own poster.
    // source_username + source_type let the frontend disambiguate
    // multiple sources that share the same host (e.g., 6 different
    // lordstreams.live accounts). source_account_status surfaces dead
    // / expired accounts so the user can skip them without clicking.
    const sourcesSql = movieId
      ? `SELECT ms.id AS movie_stream_id, ms.source_id,
                s.name AS source_name, s.nickname AS source_nickname,
                s.username AS source_username, s.type AS source_type,
                s.account_status AS source_account_status,
                s.exp_date AS source_exp_date,
                ms.provider_stream_id, ms.container_extension, ms.added_at, ms.provider_name, ms.rating,
                ms.raw_meta
         FROM movie_streams ms JOIN iptv_sources s ON s.id = ms.source_id
         WHERE ms.movie_id = $1 AND s.user_id = $2 ORDER BY ms.added_at DESC NULLS LAST`
      : `SELECT ms.id AS movie_stream_id, ms.source_id,
                s.name AS source_name, s.nickname AS source_nickname,
                s.username AS source_username, s.type AS source_type,
                s.account_status AS source_account_status,
                s.exp_date AS source_exp_date,
                ms.provider_stream_id, ms.container_extension, ms.added_at, ms.provider_name, ms.rating,
                ms.raw_meta
         FROM movie_streams ms JOIN iptv_sources s ON s.id = ms.source_id
         WHERE ms.id = $1 AND s.user_id = $2`;
    const sourcesResult = await postgresService.query(sourcesSql, [movieId || idNum, userId]);

    if (!canonical && sourcesResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    // Synthetic canonical must cover every field VodDetail.jsx reads
    // (backdrop_url, runtime_secs, director, cast_json, genres,
    // rating_tmdb, …) or it crashes the moment any of those properties
    // are accessed. Poster falls back to the provider's stream_icon.
    const firstRaw = sourcesResult.rows[0]?.raw_meta || {};
    const synthetic = {
      id: null,
      tmdb_id: null,
      imdb_id: null,
      title: sourcesResult.rows[0]?.provider_name || null,
      year: null,
      overview: firstRaw.plot || firstRaw.description || null,
      poster_url: firstRaw.stream_icon || firstRaw.screenshot_uri || firstRaw.movie_image || firstRaw.cover_big || firstRaw.cover || firstRaw.pic || null,
      backdrop_url: firstRaw.backdrop_path?.[0] || null,
      runtime_secs: null,
      genres: firstRaw.genre ? String(firstRaw.genre).split(/[,/]/).map(s => s.trim()).filter(Boolean) : null,
      director: firstRaw.director || null,
      cast_json: null,
      // Provider rating arrives as a NUMERIC string ("0", "7.5"). Coerce
      // explicitly so a "0" doesn't surface as a meaningless ★0.0 chip.
      rating_tmdb: (parseFloat(sourcesResult.rows[0]?.rating) || null),
      rating_imdb: null,
      released_on: null,
      trailer_youtube_id: null,
      enriched_at: null
    };

    res.json({
      success: true,
      movie: canonical || synthetic,
      sources: sourcesResult.rows
    });
  } catch (error) {
    logger.error(`[VOD movie] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod/series/:id
 * P1 stub: returns the canonical series row + per-source availability.
 * Seasons + episodes will be populated by the lazy fetch in P2 (see
 * GET /api/vod/series/:id/episodes below — initially returns empty).
 */
router.get('/series/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [prefix, rawId] = String(req.params.id).split(':');
    const idNum = parseInt(rawId, 10);
    if (!['s', 'ss'].includes(prefix) || !Number.isFinite(idNum)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    let seriesId = prefix === 's' ? idNum : null;
    if (prefix === 'ss') {
      const r = await postgresService.query(
        `SELECT series_id FROM series_sources ss
         WHERE ss.id = $1 AND ss.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $2)`,
        [idNum, userId]
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      seriesId = r.rows[0].series_id;
    }

    let canonical = null;
    if (seriesId) {
      const cr = await postgresService.query(
        `SELECT id, tmdb_id, imdb_id, title, year, overview, poster_url, backdrop_url,
                genres, cast_json, rating_tmdb, trailer_youtube_id, enriched_at
         FROM series WHERE id = $1`,
        [seriesId]
      );
      canonical = cr.rows[0] || null;
    }

    // Same enriched per-source payload as /movies/:id (username + type
    // + account_status) so the SourceCard UI can disambiguate accounts.
    const sourcesSql = seriesId
      ? `SELECT ss.id AS series_source_id, ss.source_id,
                s.name AS source_name, s.nickname AS source_nickname,
                s.username AS source_username, s.type AS source_type,
                s.account_status AS source_account_status,
                s.exp_date AS source_exp_date,
                ss.provider_series_id, ss.last_episode_fetch, ss.provider_name, ss.raw_meta,
                ss.updated_at
         FROM series_sources ss JOIN iptv_sources s ON s.id = ss.source_id
         WHERE ss.series_id = $1 AND s.user_id = $2 ORDER BY ss.updated_at DESC NULLS LAST`
      : `SELECT ss.id AS series_source_id, ss.source_id,
                s.name AS source_name, s.nickname AS source_nickname,
                s.username AS source_username, s.type AS source_type,
                s.account_status AS source_account_status,
                s.exp_date AS source_exp_date,
                ss.provider_series_id, ss.last_episode_fetch, ss.provider_name, ss.raw_meta,
                ss.updated_at
         FROM series_sources ss JOIN iptv_sources s ON s.id = ss.source_id
         WHERE ss.id = $1 AND s.user_id = $2`;
    const sourcesResult = await postgresService.query(sourcesSql, [seriesId || idNum, userId]);

    if (!canonical && sourcesResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    // Synthetic canonical must include every field VodDetail.jsx reads
    // (backdrop_url, genres, cast_json, rating_tmdb, …) — otherwise
    // the UI crashes on `row.backdrop_url` etc. Poster falls back to
    // the provider's cover art carried in raw_meta.
    const firstRaw = sourcesResult.rows[0]?.raw_meta || {};
    const synthetic = {
      id: null,
      tmdb_id: null,
      imdb_id: null,
      title: sourcesResult.rows[0]?.provider_name || null,
      year: null,
      overview: firstRaw.plot || firstRaw.description || null,
      poster_url: firstRaw.cover || firstRaw.cover_big || firstRaw.screenshot_uri || firstRaw.pic || firstRaw.stream_icon || null,
      backdrop_url: Array.isArray(firstRaw.backdrop_path) ? firstRaw.backdrop_path[0] : null,
      genres: firstRaw.genre ? String(firstRaw.genre).split(/[,/]/).map(s => s.trim()).filter(Boolean) : null,
      cast_json: null,
      rating_tmdb: null,
      trailer_youtube_id: null,
      enriched_at: null
    };

    res.json({
      success: true,
      series: canonical || synthetic,
      sources: sourcesResult.rows
    });
  } catch (error) {
    logger.error(`[VOD series] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/vod/series/:id/episodes
 * Lazy: when last_episode_fetch is NULL or > 24h old, hit
 * get_series_info upstream and persist. Then returns the cached
 * tree.
 *
 * Query: source_id (required when the series exists on multiple
 * sources — picks which provider to fetch from)
 */
router.get('/series/:id/episodes', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [prefix, rawId] = String(req.params.id).split(':');
    const idNum = parseInt(rawId, 10);
    if (!['s', 'ss'].includes(prefix) || !Number.isFinite(idNum)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const sourceIdReq = req.query.source_id ? parseInt(req.query.source_id, 10) : null;

    // Resolve series_sources row to fetch from. Prefer the user-
    // specified source_id; otherwise pick the most-recently-updated
    // one carrying this series.
    let seriesSourceRow;
    if (prefix === 'ss') {
      const r = await postgresService.query(
        `SELECT ss.*, s.url AS source_url, s.username, s.password, s.type AS source_type
         FROM series_sources ss JOIN iptv_sources s ON s.id = ss.source_id
         WHERE ss.id = $1 AND s.user_id = $2`,
        [idNum, userId]
      );
      seriesSourceRow = r.rows[0];
    } else {
      const params = [idNum, userId];
      let extra = '';
      if (sourceIdReq) {
        params.push(sourceIdReq);
        extra = ` AND ss.source_id = $${params.length}`;
      }
      const r = await postgresService.query(
        `SELECT ss.*, s.url AS source_url, s.username, s.password, s.type AS source_type
         FROM series_sources ss JOIN iptv_sources s ON s.id = ss.source_id
         WHERE ss.series_id = $1 AND s.user_id = $2${extra}
         ORDER BY ss.last_episode_fetch DESC NULLS LAST, ss.updated_at DESC
         LIMIT 1`,
        params
      );
      seriesSourceRow = r.rows[0];
    }
    if (!seriesSourceRow) return res.status(404).json({ success: false, error: 'Not found' });

    // Auto-enrich the series if it hasn't been yet. Without this,
    // persistEpisodeTree below takes the "no canonical" branch and
    // writes only to episode_streams — meaning no still_url, no
    // overview, and no Cinemeta backfill is possible. Enriching now
    // sets series_sources.series_id so the canonical path kicks in.
    //
    // If we just promoted series_id from null, force the lazy-fetch
    // to re-run by stomping `last_episode_fetch` in memory. Otherwise
    // a previous no-canonical lazy-fetch (which wrote rows to
    // episode_streams only) marks the series "fresh" for 24h and the
    // canonical episodes table stays empty — so the Cinemeta backfill
    // below has nothing to UPDATE.
    let justEnriched = false;
    if (!seriesSourceRow.series_id) {
      try {
        const enrichResult = await enrichmentService.enrichSeriesSourceId(seriesSourceRow.id);
        const refetch = await postgresService.query(
          `SELECT ss.*, s.url AS source_url, s.username, s.password, s.type AS source_type
           FROM series_sources ss JOIN iptv_sources s ON s.id = ss.source_id
           WHERE ss.id = $1`,
          [seriesSourceRow.id]
        );
        if (refetch.rows[0]) {
          if (refetch.rows[0].series_id && !seriesSourceRow.series_id) {
            justEnriched = true;
          }
          seriesSourceRow = refetch.rows[0];
          if (justEnriched) {
            // Force re-persist so canonical seasons/episodes get
            // populated from the upstream tree this time.
            seriesSourceRow.last_episode_fetch = null;
          }
        }
        logger.info(`[VOD episodes] auto-enrich for series_source ${seriesSourceRow.id}: ${JSON.stringify(enrichResult)} justEnriched=${justEnriched}`);
      } catch (enrichErr) {
        logger.warn(`[VOD episodes] auto-enrich failed: ${enrichErr.message}`);
      }
    }

    // If we have series_id but no canonical seasons yet (e.g. the
    // very first lazy-fetch ran while series was still unenriched and
    // wrote to episode_streams instead), force re-persist so the
    // canonical tables catch up.
    if (seriesSourceRow.series_id && !justEnriched) {
      const seasonCount = await postgresService.query(
        `SELECT COUNT(*)::int AS c FROM seasons WHERE series_id = $1`,
        [seriesSourceRow.series_id]
      );
      if ((seasonCount.rows[0]?.c || 0) === 0) {
        seriesSourceRow.last_episode_fetch = null;
      }
    }

    // Cache age check.
    const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
    const lastFetch = seriesSourceRow.last_episode_fetch;
    const isFresh = lastFetch && (Date.now() - new Date(lastFetch).getTime()) < STALE_AFTER_MS;

    if (!isFresh && seriesSourceRow.source_type === 'xtream') {
      try {
        const tree = await xtreamVod.getSeriesInfo(
          {
            url: seriesSourceRow.source_url,
            username: seriesSourceRow.username,
            password: seriesSourceRow.password
          },
          seriesSourceRow.provider_series_id
        );
        await persistEpisodeTree(seriesSourceRow, tree);
      } catch (fetchErr) {
        // If the upstream fetch fails AND we have stale data,
        // return the stale data with a warning. If we have nothing,
        // surface the error.
        if (lastFetch) {
          logger.warn(`[VOD episodes] Refresh failed; serving stale: ${fetchErr.message}`);
        } else {
          throw fetchErr;
        }
      }
    }

    // Cinemeta episode backfill — Xtream often returns episodes with
    // no `info.movie_image` (the still) and a blank plot. Cinemeta's
    // `videos[]` carries metahub.space thumbnails + overviews keyed
    // by (season, episode_number). Overlay them onto canonical
    // episodes that are missing those fields. Cheap & idempotent.
    if (seriesSourceRow.series_id) {
      try {
        const seriesRow = await postgresService.query(
          `SELECT imdb_id FROM series WHERE id = $1`,
          [seriesSourceRow.series_id]
        );
        const imdbId = seriesRow.rows[0]?.imdb_id;
        if (imdbId) {
          const videos = await enrichmentService.fetchCinemetaSeriesEpisodes(imdbId);
          for (const v of videos) {
            if (!v.thumbnail && !v.overview && !v.title) continue;
            await postgresService.query(
              `UPDATE episodes e
               SET still_url = COALESCE(e.still_url, $1),
                   overview = COALESCE(e.overview, $2),
                   title = COALESCE(e.title, $3)
               FROM seasons se
               WHERE e.season_id = se.id
                 AND se.series_id = $4
                 AND se.season_number = $5
                 AND e.episode_number = $6`,
              [v.thumbnail, v.overview, v.title, seriesSourceRow.series_id, v.season, v.episode]
            );
          }
        }
      } catch (cmErr) {
        logger.warn(`[VOD episodes] Cinemeta backfill failed: ${cmErr.message}`);
      }
    }

    // Read back from the cache. If the series_sources row is linked
    // to a canonical series, read canonical seasons/episodes; if
    // not, fall back to reading directly from episode_streams via
    // a join through the series_source row.
    let canonicalRows = [];
    if (seriesSourceRow.series_id) {
      const r = await postgresService.query(
        `SELECT
           se.id AS season_id, se.season_number, se.name AS season_name,
           se.overview AS season_overview, se.poster_url AS season_poster,
           e.id AS episode_id, e.episode_number, e.title AS episode_title,
           e.overview AS episode_overview, e.runtime_secs, e.still_url,
           es.id AS episode_stream_id, es.source_id, es.provider_episode_id,
           es.container_extension, es.provider_title
         FROM seasons se
         LEFT JOIN episodes e ON e.season_id = se.id
         LEFT JOIN episode_streams es ON es.episode_id = e.id AND es.source_id = $2
         WHERE se.series_id = $1
         ORDER BY se.season_number, e.episode_number`,
        [seriesSourceRow.series_id, seriesSourceRow.source_id]
      );
      canonicalRows = r.rows;
    }

    // When canonical isn't populated yet, return episode_streams
    // grouped by provider season number.
    if (!canonicalRows.length) {
      const r = await postgresService.query(
        `SELECT es.id AS episode_stream_id, es.source_id, es.provider_episode_id,
                es.provider_season AS season_number, es.provider_episode_num AS episode_number,
                es.provider_title AS episode_title, es.container_extension
         FROM episode_streams es
         WHERE es.series_source_id = $1
         ORDER BY es.provider_season, es.provider_episode_num`,
        [seriesSourceRow.id]
      );
      // Group into the same shape the canonical path returns.
      const seasonsMap = new Map();
      for (const row of r.rows) {
        if (!seasonsMap.has(row.season_number)) {
          seasonsMap.set(row.season_number, {
            season_number: row.season_number,
            name: null,
            overview: null,
            poster_url: null,
            episodes: []
          });
        }
        seasonsMap.get(row.season_number).episodes.push({
          episode_stream_id: row.episode_stream_id,
          episode_number: row.episode_number,
          title: row.episode_title,
          container_extension: row.container_extension,
          provider_episode_id: row.provider_episode_id
        });
      }
      return res.json({
        success: true,
        from_source_id: seriesSourceRow.source_id,
        seasons: Array.from(seasonsMap.values())
      });
    }

    // Group canonical rows by season.
    const seasonsMap = new Map();
    for (const row of canonicalRows) {
      if (!seasonsMap.has(row.season_number)) {
        seasonsMap.set(row.season_number, {
          season_number: row.season_number,
          name: row.season_name,
          overview: row.season_overview,
          poster_url: row.season_poster,
          episodes: []
        });
      }
      if (row.episode_id) {
        seasonsMap.get(row.season_number).episodes.push({
          episode_id: row.episode_id,
          episode_stream_id: row.episode_stream_id,
          episode_number: row.episode_number,
          title: row.episode_title,
          overview: row.episode_overview,
          runtime_secs: row.runtime_secs,
          still_url: row.still_url,
          container_extension: row.container_extension,
          provider_episode_id: row.provider_episode_id
        });
      }
    }

    res.json({
      success: true,
      from_source_id: seriesSourceRow.source_id,
      seasons: Array.from(seasonsMap.values())
    });
  } catch (error) {
    logger.error(`[VOD episodes] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Persist a freshly-fetched series tree into the canonical
 * seasons/episodes tables and the per-source episode_streams table.
 *
 * When the series_sources row has no series_id link (un-enriched),
 * we ONLY populate episode_streams — seasons/episodes wait for the
 * enrichment worker to mint a canonical series row.
 */
async function persistEpisodeTree(seriesSourceRow, tree) {
  await postgresService.transaction(async (client) => {
    if (seriesSourceRow.series_id) {
      // Canonical path: upsert seasons + episodes.
      for (const season of tree.seasons) {
        const seasonRes = await client.query(
          `INSERT INTO seasons (series_id, season_number, name, overview, poster_url, air_date)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (series_id, season_number) DO UPDATE SET
             name = EXCLUDED.name, overview = EXCLUDED.overview,
             poster_url = EXCLUDED.poster_url, air_date = EXCLUDED.air_date
           RETURNING id`,
          [
            seriesSourceRow.series_id,
            season.seasonNumber,
            season.name,
            season.overview,
            season.posterUrl,
            season.airDate || null
          ]
        );
        const seasonId = seasonRes.rows[0].id;

        for (const ep of season.episodes) {
          const epRes = await client.query(
            `INSERT INTO episodes (season_id, episode_number, title, overview, runtime_secs, still_url, air_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (season_id, episode_number) DO UPDATE SET
               title = EXCLUDED.title, overview = EXCLUDED.overview,
               runtime_secs = EXCLUDED.runtime_secs, still_url = EXCLUDED.still_url
             RETURNING id`,
            [
              seasonId,
              ep.episodeNumber || 0,
              ep.title,
              ep.info?.plot || null,
              ep.info?.duration_secs ? parseInt(ep.info.duration_secs, 10) : null,
              ep.info?.movie_image || null,
              null
            ]
          );
          const episodeId = epRes.rows[0].id;

          await client.query(
            `INSERT INTO episode_streams
               (source_id, series_source_id, episode_id, provider_episode_id,
                provider_season, provider_episode_num, provider_title,
                container_extension, added_at, raw_meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (source_id, provider_episode_id) DO UPDATE SET
               episode_id = EXCLUDED.episode_id,
               provider_season = EXCLUDED.provider_season,
               provider_episode_num = EXCLUDED.provider_episode_num,
               provider_title = EXCLUDED.provider_title,
               container_extension = EXCLUDED.container_extension,
               raw_meta = EXCLUDED.raw_meta,
               updated_at = NOW()`,
            [
              seriesSourceRow.source_id,
              seriesSourceRow.id,
              episodeId,
              ep.providerEpisodeId,
              season.seasonNumber,
              ep.episodeNumber || 0,
              ep.title,
              ep.containerExtension,
              ep.addedAt,
              JSON.stringify(ep.raw || null)
            ]
          );
        }
      }
    } else {
      // Un-enriched path: write episode_streams without canonical FK.
      for (const season of tree.seasons) {
        for (const ep of season.episodes) {
          await client.query(
            `INSERT INTO episode_streams
               (source_id, series_source_id, episode_id, provider_episode_id,
                provider_season, provider_episode_num, provider_title,
                container_extension, added_at, raw_meta)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (source_id, provider_episode_id) DO UPDATE SET
               provider_season = EXCLUDED.provider_season,
               provider_episode_num = EXCLUDED.provider_episode_num,
               provider_title = EXCLUDED.provider_title,
               container_extension = EXCLUDED.container_extension,
               raw_meta = EXCLUDED.raw_meta,
               updated_at = NOW()`,
            [
              seriesSourceRow.source_id,
              seriesSourceRow.id,
              ep.providerEpisodeId,
              season.seasonNumber,
              ep.episodeNumber || 0,
              ep.title,
              ep.containerExtension,
              ep.addedAt,
              JSON.stringify(ep.raw || null)
            ]
          );
        }
      }
    }

    await client.query(
      `UPDATE series_sources SET last_episode_fetch = NOW(), updated_at = NOW() WHERE id = $1`,
      [seriesSourceRow.id]
    );
  });
}

/**
 * POST /api/vod/movies/:id/enrich
 * Force-enrich an unenriched movie row immediately. The UI calls this
 * when a user opens a detail page for a row whose canonical movie_id
 * is null — so they don't have to wait for the background worker to
 * walk to that row in its queue.
 *
 * Returns the enrichment result. The frontend should re-fetch the
 * detail after a successful response.
 */
router.post('/movies/:id/enrich', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [prefix, rawId] = String(req.params.id).split(':');
    const idNum = parseInt(rawId, 10);
    if (!['m', 'ms'].includes(prefix) || !Number.isFinite(idNum)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }

    // Pick a representative movie_streams.id we own. For `m:<id>`
    // (already canonical), grab any one of the user's per-source rows
    // linked to it — we just need provider_name + raw_meta for the
    // enrichment lookup.
    let msId;
    if (prefix === 'ms') {
      const r = await postgresService.query(
        `SELECT ms.id FROM movie_streams ms
         WHERE ms.id = $1 AND ms.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $2)`,
        [idNum, userId]
      );
      msId = r.rows[0]?.id;
    } else {
      const r = await postgresService.query(
        `SELECT ms.id FROM movie_streams ms
         WHERE ms.movie_id = $1 AND ms.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $2)
         LIMIT 1`,
        [idNum, userId]
      );
      msId = r.rows[0]?.id;
    }
    if (!msId) return res.status(404).json({ success: false, error: 'Not found' });

    const result = await enrichmentService.enrichMovieStreamId(msId);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`[VOD enrich movie] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/series/:id/enrich', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [prefix, rawId] = String(req.params.id).split(':');
    const idNum = parseInt(rawId, 10);
    if (!['s', 'ss'].includes(prefix) || !Number.isFinite(idNum)) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    let ssId;
    if (prefix === 'ss') {
      const r = await postgresService.query(
        `SELECT ss.id FROM series_sources ss
         WHERE ss.id = $1 AND ss.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $2)`,
        [idNum, userId]
      );
      ssId = r.rows[0]?.id;
    } else {
      const r = await postgresService.query(
        `SELECT ss.id FROM series_sources ss
         WHERE ss.series_id = $1 AND ss.source_id IN (SELECT id FROM iptv_sources WHERE user_id = $2)
         LIMIT 1`,
        [idNum, userId]
      );
      ssId = r.rows[0]?.id;
    }
    if (!ssId) return res.status(404).json({ success: false, error: 'Not found' });
    const result = await enrichmentService.enrichSeriesSourceId(ssId);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`[VOD enrich series] failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
