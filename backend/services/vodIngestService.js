const logger = require('../config/logger');
const postgresService = require('./postgresService');
const xtreamVod = require('./xtreamVodService');
const stalkerVod = require('./stalkerVodService');
const { from: copyFrom } = require('pg-copy-streams');
const { tabEscape, streamRowsToCopy, dedupeBy } = require('../utils/pgCopyHelpers');
const vodCatalog = require('./vodCatalogService');

/**
 * vodIngestService — orchestrator for the eager-list phase of VOD
 * ingestion. Pulls movies + series + categories from a provider in
 * a small number of bulk requests and upserts them into the per-
 * source tables (movie_streams, series_sources, vod_categories).
 *
 * The canonical tables (movies, series, seasons, episodes) and
 * their cross-source dedup happen LATER:
 *   - seasons/episodes are populated lazily by getSeriesEpisodes()
 *     on series-open (P2).
 *   - movies.movie_id / series.series_id links are backfilled by
 *     the TMDB enrichment worker (P3).
 *
 * Wiring:
 *   - Called from routes/iptvSources.js at the end of a successful
 *     refresh (after live-channel saveChannels).
 *   - Best-effort: any VOD-side failure logs but does NOT bubble up
 *     to fail the whole refresh. Live channels are the primary
 *     contract; VOD is supplemental and providers vary wildly in
 *     whether they expose it.
 *   - Provider may legitimately serve zero VOD (sports-only IPTVs).
 *     We treat empty responses as success.
 */

// Per-batch INSERT cap — same 500-row chunk size as live channels
// (postgresService.saveChannels), proven to play nicely with the
// parameter-count limit. With 14 columns per row that's 7,000
// parameters per statement, well under Postgres's 65k cap.
const BATCH_SIZE = 500;

const isXtreamSource = (source) =>
  source && source.type === 'xtream' && source.username && source.password && source.url;
const isStalkerSource = (source) =>
  source && source.type === 'stalker' && source.url && (source.mac_address || source.mac);

const buildAccount = (source) => ({
  url: source.url,
  username: source.username,
  password: source.password
});

// ─── Category upsert ───────────────────────────────────────────────

async function upsertCategories(sourceId, kind, categories) {
  if (!categories.length) return 0;
  // Replace-all-then-insert is fine here — categories are tiny
  // (~10-50 per kind per provider) and never referenced by FK from
  // other tables, so we can blow them away and re-insert without
  // disturbing anything.
  await postgresService.query(
    `DELETE FROM vod_categories WHERE source_id = $1 AND kind = $2`,
    [sourceId, kind]
  );
  for (let i = 0; i < categories.length; i += BATCH_SIZE) {
    const batch = categories.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    batch.forEach((cat, idx) => {
      const off = idx * 5;
      values.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5})`);
      params.push(sourceId, kind, cat.categoryId, cat.name, cat.parentId);
    });
    await postgresService.query(
      `INSERT INTO vod_categories
        (source_id, kind, provider_category_id, name, parent_id)
       VALUES ${values.join(', ')}`,
      params
    );
  }
  return categories.length;
}

// ─── Movie upsert ──────────────────────────────────────────────────
// Per-source replace: every refresh re-pulls the catalog, so we
// DELETE the source's movie_streams that didn't come back in this
// pass at the end. Simpler than diffing — and the canonical
// `movies` rows survive the delete because of ON DELETE SET NULL
// (the link goes away but the canonical row stays for the next
// source that catalogs it).

async function upsertMovieStreams(sourceId, movies) {
  if (!movies.length) return { upserted: 0 };
  const sourceIdStr = String(parseInt(sourceId, 10));

  // Dedupe by provider_stream_id (last-wins) before COPY. See dedupeBy
  // for why — providers sometimes list the same stream_id twice and
  // the staging table can't tolerate that without a server-side
  // ErrorResponse mid-COPY, which the pg-copy-streams race can
  // convert into an uncaught exception.
  const deduped = dedupeBy(movies, (m) => m.providerStreamId);

  // UNLOGGED-TEMP staging + single planned upsert. Replaces the prior
  // batched multi-VALUES INSERTs:
  //
  //   * COPY into a TEMP table writes no WAL — temp tables are
  //     session-local and crash-discardable by definition, so the
  //     bulk write skips the WAL pipeline entirely.
  //   * One INSERT...SELECT...ON CONFLICT lets the planner run the
  //     whole upsert as a single hash/merge pass instead of N
  //     500-row batches with N round-trips. The IS DISTINCT FROM
  //     filter is preserved — unchanged rows touch zero tuple
  //     versions, same as before.
  //   * The cull becomes "DELETE WHERE NOT EXISTS (SELECT 1 FROM
  //     stage)" — uniform fast path for any catalog size, no
  //     chunked NOT IN dance.
  //
  // Whole thing is one transaction: a mid-flight failure rolls back
  // the upsert + cull together so movie_streams never sits in a
  // half-loaded state.
  await postgresService.transaction(async (client) => {
    // GIN bulk-load knobs (movie_streams.provider_name has a trgm
    // GIN, the LIKE-search index for VOD browse). Same pending-list
    // story as saveChannels: crank gin_pending_list_limit so the
    // entire merge's GIN inserts queue into the buffer, then we
    // implicitly flush once at COMMIT (or could explicitly call
    // gin_clean_pending_list — but for ~50k row catalogs the
    // implicit COMMIT flush is fine).
    await client.query(`SET LOCAL maintenance_work_mem = '512MB'`);
    await client.query(`SET LOCAL gin_pending_list_limit = '256MB'`);

    // No PRIMARY KEY on staging: we dedupe inputs in JS above so a
    // PK would be redundant, and not having one means COPY can't
    // emit a server-side ErrorResponse mid-stream (which historically
    // raced with pg-copy-streams' _final and crashed the process).
    // The INSERT...SELECT into the real movie_streams below enforces
    // the actual unique constraint via ON CONFLICT.
    await client.query(`
      CREATE TEMP TABLE _stage_movie_streams (
        source_id            INTEGER NOT NULL,
        provider_stream_id   TEXT    NOT NULL,
        provider_name        TEXT,
        provider_category_id TEXT,
        container_extension  TEXT,
        stream_url           TEXT,
        added_at             TIMESTAMPTZ,
        rating               NUMERIC,
        raw_meta             JSONB
      ) ON COMMIT DROP
    `);

    const copyStream = client.query(copyFrom(`
      COPY _stage_movie_streams (
        source_id, provider_stream_id, provider_name, provider_category_id,
        container_extension, stream_url, added_at, rating, raw_meta
      ) FROM STDIN WITH (FORMAT text, FREEZE)
    `));

    await streamRowsToCopy(copyStream, deduped, (m) => [
      sourceIdStr,
      m.providerStreamId,
      m.rawName,
      m.categoryId,
      m.containerExtension,
      null, // stream_url — proxy-resolved on demand from creds
      m.addedAt,
      m.rating,
      m.raw == null ? null : JSON.stringify(m.raw)
    ].map(tabEscape).join('\t') + '\n');

    await client.query(`
      INSERT INTO movie_streams
        (source_id, provider_stream_id, provider_name, provider_category_id,
         container_extension, stream_url, added_at, rating, raw_meta)
      SELECT
        source_id, provider_stream_id, provider_name, provider_category_id,
        container_extension, stream_url, added_at, rating, raw_meta
      FROM _stage_movie_streams
      ON CONFLICT (source_id, provider_stream_id) DO UPDATE SET
        provider_name        = EXCLUDED.provider_name,
        provider_category_id = EXCLUDED.provider_category_id,
        container_extension  = EXCLUDED.container_extension,
        added_at             = EXCLUDED.added_at,
        rating               = EXCLUDED.rating,
        raw_meta             = EXCLUDED.raw_meta,
        updated_at           = NOW()
      WHERE
        movie_streams.provider_name        IS DISTINCT FROM EXCLUDED.provider_name
        OR movie_streams.provider_category_id IS DISTINCT FROM EXCLUDED.provider_category_id
        OR movie_streams.container_extension  IS DISTINCT FROM EXCLUDED.container_extension
        OR movie_streams.added_at             IS DISTINCT FROM EXCLUDED.added_at
        OR movie_streams.rating               IS DISTINCT FROM EXCLUDED.rating
        OR movie_streams.raw_meta             IS DISTINCT FROM EXCLUDED.raw_meta
    `);

    // Cull rows the provider no longer carries. "NOT EXISTS" against
    // the staging table is uniform-fast regardless of catalog size,
    // so we don't need the prior chunked NOT IN fallback.
    await client.query(`
      DELETE FROM movie_streams ms
       WHERE ms.source_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM _stage_movie_streams st
            WHERE st.source_id          = ms.source_id
              AND st.provider_stream_id = ms.provider_stream_id
         )
    `, [sourceId]);
  });

  return { upserted: deduped.length };
}

// ─── Series upsert ─────────────────────────────────────────────────

async function upsertSeriesSources(sourceId, seriesList) {
  if (!seriesList.length) return { upserted: 0 };
  const sourceIdStr = String(parseInt(sourceId, 10));

  // Dedupe + no-PK pattern — see upsertMovieStreams for the rationale.
  const deduped = dedupeBy(seriesList, (s) => s.providerSeriesId);

  // Mirror of upsertMovieStreams — see the long comment there for
  // why we stage into a TEMP table and do a single planned upsert.
  await postgresService.transaction(async (client) => {
    await client.query(`SET LOCAL maintenance_work_mem = '512MB'`);
    await client.query(`SET LOCAL gin_pending_list_limit = '256MB'`);

    await client.query(`
      CREATE TEMP TABLE _stage_series_sources (
        source_id            INTEGER NOT NULL,
        provider_series_id   TEXT    NOT NULL,
        provider_name        TEXT,
        provider_category_id TEXT,
        raw_meta             JSONB
      ) ON COMMIT DROP
    `);

    const copyStream = client.query(copyFrom(`
      COPY _stage_series_sources (
        source_id, provider_series_id, provider_name, provider_category_id, raw_meta
      ) FROM STDIN WITH (FORMAT text, FREEZE)
    `));

    await streamRowsToCopy(copyStream, deduped, (s) => [
      sourceIdStr,
      s.providerSeriesId,
      s.rawName,
      s.categoryId,
      s.raw == null ? null : JSON.stringify(s.raw)
    ].map(tabEscape).join('\t') + '\n');

    await client.query(`
      INSERT INTO series_sources
        (source_id, provider_series_id, provider_name, provider_category_id, raw_meta)
      SELECT
        source_id, provider_series_id, provider_name, provider_category_id, raw_meta
      FROM _stage_series_sources
      ON CONFLICT (source_id, provider_series_id) DO UPDATE SET
        provider_name        = EXCLUDED.provider_name,
        provider_category_id = EXCLUDED.provider_category_id,
        raw_meta             = EXCLUDED.raw_meta,
        updated_at           = NOW()
      WHERE
        series_sources.provider_name        IS DISTINCT FROM EXCLUDED.provider_name
        OR series_sources.provider_category_id IS DISTINCT FROM EXCLUDED.provider_category_id
        OR series_sources.raw_meta             IS DISTINCT FROM EXCLUDED.raw_meta
    `);

    await client.query(`
      DELETE FROM series_sources ss
       WHERE ss.source_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM _stage_series_sources st
            WHERE st.source_id          = ss.source_id
              AND st.provider_series_id = ss.provider_series_id
         )
    `, [sourceId]);
  });

  return { upserted: deduped.length };
}

// ─── Public entry point ────────────────────────────────────────────

/**
 * Pull the eager VOD catalog for a single source.
 *
 *   1. Fetch + upsert vod_categories (movies)
 *   2. Fetch + upsert movie_streams  (this is the big one — 10–50k rows)
 *   3. Fetch + upsert vod_categories (series)
 *   4. Fetch + upsert series_sources (5–15k rows)
 *
 * Returns a summary; throws only on completely catastrophic
 * failure (e.g. authentication wall). Per-step failures are
 * logged and reflected in the returned counts.
 */
// Global concurrency cap. VOD ingest hits movie_streams (~1.4M rows)
// and series_sources (~300k rows) with bulk UPSERTs that contend
// heavily for DB I/O and locks. When refresh-account-info became
// fire-and-forget (responds after channel save, spawns VOD detached),
// we discovered that N background VOD ingests can run simultaneously
// and turn a 4-second channel save into a 99-second one because the
// COPY is fighting the UPSERTs for the same disk.
//
// MAX_CONCURRENT_VOD=1 — fully sequential. Same WAL-fsync story as
// saveChannels: bulk UPSERTs into movie_streams (1.4M rows) and
// series_sources (300k rows) generate huge WAL volume. Running two
// at a time, combined with concurrent channel saves, stretched what
// should have been a 4 s save into 135 s. With both knobs at 1, the
// DB has one heavy writer at a time and everything stays responsive.
// Excess ingests queue and drain naturally; since VOD is now fire-
// and-forget on the refresh route, the user never waits on this.
const MAX_CONCURRENT_VOD = 1;
let _activeVod = 0;
const _vodWaiters = [];
async function _acquireVodSlot() {
  if (_activeVod < MAX_CONCURRENT_VOD) {
    _activeVod += 1;
    return;
  }
  await new Promise((resolve) => _vodWaiters.push(resolve));
  _activeVod += 1;
}
function _releaseVodSlot() {
  _activeVod = Math.max(0, _activeVod - 1);
  const next = _vodWaiters.shift();
  if (next) next();
}

async function ingestVodForSource(source, opts = {}) {
  // `opts.movies` / `opts.series` let the caller cut the pipeline in
  // half. Default is both (matches the old behaviour). The Refresh-
  // page's per-kind bulk buttons pass exactly one of them so the
  // user can refresh movies without re-pulling 300k series rows
  // they don't care about right now.
  const wantMovies = opts.movies !== false;
  const wantSeries = opts.series !== false;

  if (isStalkerSource(source)) return ingestVodFromStalker(source);
  if (!isXtreamSource(source)) {
    logger.debug(`[vodIngest] Source ${source?.id}: not an Xtream/Stalker source, skipping VOD ingest`);
    return { skipped: true };
  }
  const sourceId = source.id;

  // Wait for a free VOD slot before grabbing DB resources. Without this
  // cap, multiple fire-and-forget VOD ingests from concurrent refreshes
  // collectively starve the channel COPY path — a 4s save balloons to
  // 99s. The wait happens BEFORE buildAccount / the started timestamp
  // so the elapsed log reflects real work, not queue time.
  const _vodWaitStart = Date.now();
  await _acquireVodSlot();
  if (Date.now() - _vodWaitStart > 100) {
    logger.debug(`[vodIngest] Source ${sourceId}: waited ${Date.now() - _vodWaitStart}ms for ingest slot (active=${_activeVod}, max=${MAX_CONCURRENT_VOD})`);
  }
  // Pause the TMDB enrichment worker for the duration of the
  // ingest. Both touch movie_streams; the enrichment's seqscan
  // UPDATE holds row-level locks our INSERT...SELECT...ON CONFLICT
  // needs. When source 319's VOD ran while enrichment was active,
  // the same 42k-row catalog that took 34s on source 320 took 578s
  // — a 17× slowdown from lock contention. Pausing the worker
  // (require'd lazily to avoid a circular dep) lets the ingest run
  // unblocked.
  const tmdbEnrichmentService = require('./tmdbEnrichmentService');
  const releaseEnrichmentPause = tmdbEnrichmentService.pause();
  try {
    const summary = await _ingestVodForSourceInner(source, opts, wantMovies, wantSeries);
    // The raw per-source rows just changed, so the precomputed browse
    // catalog (vod_catalog_*) is now stale. Schedule a debounced rebuild
    // — during a bulk refresh this coalesces into one rebuild after the
    // last source settles, instead of one per source.
    try {
      const uid = source.user_id;
      if (uid) {
        if (wantMovies) vodCatalog.scheduleRefresh(uid, 'movie');
        if (wantSeries) vodCatalog.scheduleRefresh(uid, 'series');
      }
    } catch (_) { /* never let catalog scheduling fail an ingest */ }
    return summary;
  } finally {
    releaseEnrichmentPause();
    _releaseVodSlot();
  }
}

async function _ingestVodForSourceInner(source, opts, wantMovies, wantSeries) {
  const sourceId = source.id;
  const account = buildAccount(source);
  const started = Date.now();
  logger.info(`[vodIngest] Source ${sourceId}: starting VOD catalog ingest (movies=${wantMovies}, series=${wantSeries})`);

  const summary = {
    movieCategories: 0,
    movies: 0,
    seriesCategories: 0,
    series: 0,
    errors: []
  };

  // Movies + Series ingest in PARALLEL — they hit different Xtream
  // endpoints and write to different tables, so there's no contention.
  // Previously these ran sequentially; for a typical source that was
  // ~90s movies + ~90s series = ~180s VOD ingest. In parallel it's
  // ~90s total (whichever finishes first sets the floor). Saves ~40-
  // 50% of the dominant cost in the refresh pipeline.
  const movieJob = (async () => {
    if (!wantMovies) return;
    try {
      const cats = await xtreamVod.getVodCategories(account);
      summary.movieCategories = await upsertCategories(sourceId, 'movie', cats);
      logger.info(`[vodIngest] Source ${sourceId}: ${summary.movieCategories} movie categories`);
    } catch (err) {
      summary.errors.push({ step: 'movie_categories', message: err.message });
      logger.warn(`[vodIngest] Source ${sourceId}: movie categories failed: ${err.message}`);
    }
    try {
      const movies = await xtreamVod.getVodStreams(account);
      const result = await upsertMovieStreams(sourceId, movies);
      summary.movies = result.upserted;
      logger.info(`[vodIngest] Source ${sourceId}: ${summary.movies} movies upserted (${Date.now() - started}ms)`);
    } catch (err) {
      summary.errors.push({ step: 'movies', message: err.message });
      logger.warn(`[vodIngest] Source ${sourceId}: movies failed: ${err.message}`);
    }
  })();

  const seriesJob = (async () => {
    if (!wantSeries) return;
    try {
      const cats = await xtreamVod.getSeriesCategories(account);
      summary.seriesCategories = await upsertCategories(sourceId, 'series', cats);
      logger.info(`[vodIngest] Source ${sourceId}: ${summary.seriesCategories} series categories`);
    } catch (err) {
      summary.errors.push({ step: 'series_categories', message: err.message });
      logger.warn(`[vodIngest] Source ${sourceId}: series categories failed: ${err.message}`);
    }
    try {
      const series = await xtreamVod.getSeries(account);
      const result = await upsertSeriesSources(sourceId, series);
      summary.series = result.upserted;
      logger.info(`[vodIngest] Source ${sourceId}: ${summary.series} series upserted`);
    } catch (err) {
      summary.errors.push({ step: 'series', message: err.message });
      logger.warn(`[vodIngest] Source ${sourceId}: series failed: ${err.message}`);
    }
  })();

  await Promise.all([movieJob, seriesJob]);

  logger.info(
    `[vodIngest] Source ${sourceId}: done in ${Date.now() - started}ms — ` +
    `${summary.movies} movies, ${summary.series} series, ` +
    `${summary.movieCategories + summary.seriesCategories} categories, ` +
    `${summary.errors.length} errors`
  );
  return summary;
}

/**
 * Stalker VOD ingest. Same shape as the Xtream variant but the
 * pagination + series filtering happens client-side because
 * Stalker's get_ordered_list doesn't separate movies from series.
 *
 * This is best-effort and gated by source.type. A provider with
 * Cloudflare in front of portal.php (see the cineplus-hd incident)
 * will fail here at authenticate — we log and return without
 * blowing up the whole refresh.
 */
async function ingestVodFromStalker(source) {
  const sourceId = source.id;
  const macAddress = source.mac_address || source.mac;
  const portalUrl = source.url;
  const started = Date.now();
  logger.info(`[vodIngest] Source ${sourceId}: starting STALKER VOD catalog ingest`);

  const summary = {
    movieCategories: 0,
    movies: 0,
    seriesCategories: 0,
    series: 0,
    errors: [],
    stalker: true
  };

  let categories = [];
  try {
    categories = await stalkerVod.getVodCategories(portalUrl, macAddress);
    // Stalker shares one category space between movies + series, but
    // we record it under both kinds so the per-kind browse query
    // still works.
    summary.movieCategories = await upsertCategories(sourceId, 'movie', categories);
    summary.seriesCategories = await upsertCategories(sourceId, 'series', categories);
    logger.info(`[vodIngest] Source ${sourceId}: ${categories.length} Stalker VOD categories`);
  } catch (err) {
    summary.errors.push({ step: 'stalker_categories', message: err.message });
    logger.warn(`[vodIngest] Source ${sourceId}: stalker categories failed: ${err.message}`);
  }

  // Movies — full catalog (no per-category iteration, Stalker's
  // get_ordered_list with no category returns everything).
  try {
    const rawMovies = await stalkerVod.getVodOrderedList(portalUrl, macAddress, { seriesOnly: false });
    const movies = rawMovies.map(stalkerVod.normalizeStalkerMovieRow);
    const result = await upsertMovieStreams(sourceId, movies);
    summary.movies = result.upserted;
    logger.info(`[vodIngest] Source ${sourceId}: ${summary.movies} Stalker movies upserted (${Date.now() - started}ms)`);
  } catch (err) {
    summary.errors.push({ step: 'stalker_movies', message: err.message });
    logger.warn(`[vodIngest] Source ${sourceId}: stalker movies failed: ${err.message}`);
  }

  // Series — same endpoint, filter by is_series flag.
  try {
    const rawSeries = await stalkerVod.getVodOrderedList(portalUrl, macAddress, { seriesOnly: true });
    const series = rawSeries.map(stalkerVod.normalizeStalkerSeriesRow);
    const result = await upsertSeriesSources(sourceId, series);
    summary.series = result.upserted;
    logger.info(`[vodIngest] Source ${sourceId}: ${summary.series} Stalker series upserted`);
  } catch (err) {
    summary.errors.push({ step: 'stalker_series', message: err.message });
    logger.warn(`[vodIngest] Source ${sourceId}: stalker series failed: ${err.message}`);
  }

  logger.info(
    `[vodIngest] Source ${sourceId}: STALKER done in ${Date.now() - started}ms — ` +
    `${summary.movies} movies, ${summary.series} series, ${summary.errors.length} errors`
  );
  return summary;
}

module.exports = {
  ingestVodForSource,
  ingestVodFromStalker,
  // exposed for tests / direct callers
  upsertCategories,
  upsertMovieStreams,
  upsertSeriesSources
};
