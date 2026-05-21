const logger = require('../config/logger');
const postgresService = require('./postgresService');
const xtreamVod = require('./xtreamVodService');
const stalkerVod = require('./stalkerVodService');

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
  let upserted = 0;
  const seenIds = new Set();

  for (let i = 0; i < movies.length; i += BATCH_SIZE) {
    const batch = movies.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];

    batch.forEach((m, idx) => {
      seenIds.add(m.providerStreamId);
      const off = idx * 9;
      values.push(
        `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8}, $${off + 9})`
      );
      params.push(
        sourceId,                  // 1
        m.providerStreamId,        // 2
        m.rawName,                 // 3 provider_name (preserves "Title (1999)")
        m.categoryId,              // 4 provider_category_id
        m.containerExtension,      // 5
        null,                      // 6 stream_url — populated by proxy on-demand from creds
        m.addedAt,                 // 7
        m.rating,                  // 8
        JSON.stringify(m.raw || null) // 9 raw_meta
      );
    });

    const sql = `
      INSERT INTO movie_streams
        (source_id, provider_stream_id, provider_name, provider_category_id,
         container_extension, stream_url, added_at, rating, raw_meta)
      VALUES ${values.join(', ')}
      ON CONFLICT (source_id, provider_stream_id) DO UPDATE SET
        provider_name        = EXCLUDED.provider_name,
        provider_category_id = EXCLUDED.provider_category_id,
        container_extension  = EXCLUDED.container_extension,
        added_at             = EXCLUDED.added_at,
        rating               = EXCLUDED.rating,
        raw_meta             = EXCLUDED.raw_meta,
        updated_at           = NOW()
    `;
    await postgresService.query(sql, params);
    upserted += batch.length;
  }

  // Cull rows the provider no longer carries. Keep this last so a
  // mid-ingest failure doesn't leave the table empty.
  if (seenIds.size > 0) {
    // Chunk the NOT IN list to keep parameter counts sane.
    const idList = Array.from(seenIds);
    const NOT_IN_CHUNK = 5000;
    if (idList.length <= NOT_IN_CHUNK) {
      const placeholders = idList.map((_, idx) => `$${idx + 2}`).join(',');
      await postgresService.query(
        `DELETE FROM movie_streams
         WHERE source_id = $1 AND provider_stream_id NOT IN (${placeholders})`,
        [sourceId, ...idList]
      );
    } else {
      // For very large catalogues, stage into a temp table and
      // delete the complement. Single SQL trip, no chunking dance.
      await postgresService.transaction(async (client) => {
        await client.query(
          `CREATE TEMP TABLE _vod_seen (provider_stream_id TEXT PRIMARY KEY) ON COMMIT DROP`
        );
        // Use COPY-style bulk insert via UNNEST.
        await client.query(
          `INSERT INTO _vod_seen (provider_stream_id) SELECT unnest($1::text[])`,
          [idList]
        );
        await client.query(
          `DELETE FROM movie_streams ms
           USING (SELECT $1::int AS sid) p
           WHERE ms.source_id = p.sid
             AND NOT EXISTS (SELECT 1 FROM _vod_seen s WHERE s.provider_stream_id = ms.provider_stream_id)`,
          [sourceId]
        );
      });
    }
  }
  return { upserted };
}

// ─── Series upsert ─────────────────────────────────────────────────

async function upsertSeriesSources(sourceId, seriesList) {
  if (!seriesList.length) return { upserted: 0 };
  let upserted = 0;
  const seenIds = new Set();

  for (let i = 0; i < seriesList.length; i += BATCH_SIZE) {
    const batch = seriesList.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    batch.forEach((s, idx) => {
      seenIds.add(s.providerSeriesId);
      const off = idx * 5;
      values.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5})`);
      params.push(
        sourceId,
        s.providerSeriesId,
        s.rawName,
        s.categoryId,
        JSON.stringify(s.raw || null)
      );
    });
    const sql = `
      INSERT INTO series_sources
        (source_id, provider_series_id, provider_name, provider_category_id, raw_meta)
      VALUES ${values.join(', ')}
      ON CONFLICT (source_id, provider_series_id) DO UPDATE SET
        provider_name        = EXCLUDED.provider_name,
        provider_category_id = EXCLUDED.provider_category_id,
        raw_meta             = EXCLUDED.raw_meta,
        updated_at           = NOW()
    `;
    await postgresService.query(sql, params);
    upserted += batch.length;
  }

  // Cull missing — same approach as movies above.
  if (seenIds.size > 0) {
    const idList = Array.from(seenIds);
    const NOT_IN_CHUNK = 5000;
    if (idList.length <= NOT_IN_CHUNK) {
      const placeholders = idList.map((_, idx) => `$${idx + 2}`).join(',');
      await postgresService.query(
        `DELETE FROM series_sources
         WHERE source_id = $1 AND provider_series_id NOT IN (${placeholders})`,
        [sourceId, ...idList]
      );
    } else {
      await postgresService.transaction(async (client) => {
        await client.query(
          `CREATE TEMP TABLE _series_seen (provider_series_id TEXT PRIMARY KEY) ON COMMIT DROP`
        );
        await client.query(
          `INSERT INTO _series_seen (provider_series_id) SELECT unnest($1::text[])`,
          [idList]
        );
        await client.query(
          `DELETE FROM series_sources ss
           USING (SELECT $1::int AS sid) p
           WHERE ss.source_id = p.sid
             AND NOT EXISTS (SELECT 1 FROM _series_seen s WHERE s.provider_series_id = ss.provider_series_id)`,
          [sourceId]
        );
      });
    }
  }
  return { upserted };
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
async function ingestVodForSource(source) {
  if (isStalkerSource(source)) return ingestVodFromStalker(source);
  if (!isXtreamSource(source)) {
    logger.debug(`[vodIngest] Source ${source?.id}: not an Xtream/Stalker source, skipping VOD ingest`);
    return { skipped: true };
  }
  const sourceId = source.id;
  const account = buildAccount(source);
  const started = Date.now();
  logger.info(`[vodIngest] Source ${sourceId}: starting VOD catalog ingest`);

  const summary = {
    movieCategories: 0,
    movies: 0,
    seriesCategories: 0,
    series: 0,
    errors: []
  };

  // STEP 1 + 2 — MOVIES ─────────────────────────────────────────
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

  // STEP 3 + 4 — SERIES ─────────────────────────────────────────
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
