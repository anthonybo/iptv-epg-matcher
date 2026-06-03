-- Migration: 049_vod_catalog
-- Description: Plex/Jellyfin-style precomputed browse catalog.
--
--   The VOD browse/search/genres endpoints were scanning + deduplicating
--   the raw 1.8M-row movie_streams table (the same movie repeated across
--   ~81 IPTV sources) on EVERY page load — the work Plex/Jellyfin do once
--   at library-scan time. Browse latency was therefore a coin-flip on
--   cache residency (39ms warm, 12-30s cold) and search/title-sort timed
--   out at 30s.
--
--   This table is the equivalent of Plex's `metadata_items`: ONE row per
--   unique movie a user has (canonical movie_id when enriched, else
--   deduped by normalized provider title). It is small (one row per
--   distinct movie, not per provider-copy), fully cacheable, and indexed
--   for the three access patterns: recent / title / rating sort, trigram
--   search, and genre filter. The raw movie_streams rows remain the
--   source-of-truth "which providers carry it" (Plex's media_parts) and
--   still back /api/vod/movies/:id.
--
--   Populated/refreshed in the background by vodCatalogService at ingest
--   time (the "scan"), NEVER on the browse path.
-- Date: 2026-06-02

CREATE TABLE IF NOT EXISTS vod_catalog_movies (
  user_id       INTEGER      NOT NULL,
  -- Grouping key: 'm:<movie_id>' (enriched) or 'pn:<md5(norm(provider_name))>'
  -- (unenriched, deduped across sources by normalized title).
  dedup_key     TEXT         NOT NULL,
  movie_id      BIGINT,                  -- canonical TMDB movie; NULL if unenriched
  rep_stream_id BIGINT       NOT NULL,   -- representative movie_streams.id (for /movies/:id)
  title         TEXT         NOT NULL,
  year          INTEGER,
  poster_url    TEXT,
  rating        NUMERIC,
  enriched      BOOLEAN      NOT NULL DEFAULT FALSE,
  genres        TEXT[]       NOT NULL DEFAULT '{}',
  source_count  INTEGER      NOT NULL DEFAULT 1,
  max_added_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, dedup_key)
);

-- Recent sort + keyset pagination. Rows are already unique here, so the
-- cursor is a clean (max_added_at, dedup_key) keyset — no query-time dedup.
CREATE INDEX IF NOT EXISTS idx_vod_catalog_movies_recent
  ON vod_catalog_movies (user_id, max_added_at DESC NULLS LAST, dedup_key DESC);

-- Title sort.
CREATE INDEX IF NOT EXISTS idx_vod_catalog_movies_title
  ON vod_catalog_movies (user_id, lower(title), dedup_key);

-- Rating sort.
CREATE INDEX IF NOT EXISTS idx_vod_catalog_movies_rating
  ON vod_catalog_movies (user_id, rating DESC NULLS LAST, dedup_key DESC);

-- Search: trigram over the small catalog title column (not 1.8M raw rows).
CREATE INDEX IF NOT EXISTS idx_vod_catalog_movies_title_trgm
  ON vod_catalog_movies USING gin (title gin_trgm_ops);

-- Genre filter: genres @> ARRAY[$1].
CREATE INDEX IF NOT EXISTS idx_vod_catalog_movies_genres
  ON vod_catalog_movies USING gin (genres);

-- Series catalog mirrors the movie one (built after movies is proven).
CREATE TABLE IF NOT EXISTS vod_catalog_series (
  user_id       INTEGER      NOT NULL,
  dedup_key     TEXT         NOT NULL,
  series_id     BIGINT,
  rep_stream_id BIGINT       NOT NULL,
  title         TEXT         NOT NULL,
  year          INTEGER,
  poster_url    TEXT,
  rating        NUMERIC,
  enriched      BOOLEAN      NOT NULL DEFAULT FALSE,
  genres        TEXT[]       NOT NULL DEFAULT '{}',
  source_count  INTEGER      NOT NULL DEFAULT 1,
  max_added_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_vod_catalog_series_recent
  ON vod_catalog_series (user_id, max_added_at DESC NULLS LAST, dedup_key DESC);
CREATE INDEX IF NOT EXISTS idx_vod_catalog_series_title
  ON vod_catalog_series (user_id, lower(title), dedup_key);
CREATE INDEX IF NOT EXISTS idx_vod_catalog_series_rating
  ON vod_catalog_series (user_id, rating DESC NULLS LAST, dedup_key DESC);
CREATE INDEX IF NOT EXISTS idx_vod_catalog_series_title_trgm
  ON vod_catalog_series USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_vod_catalog_series_genres
  ON vod_catalog_series USING gin (genres);

-- Bookkeeping: when each (user, kind) catalog was last rebuilt, so the
-- refresher can skip fresh catalogs and the UI can show staleness.
CREATE TABLE IF NOT EXISTS vod_catalog_meta (
  user_id      INTEGER     NOT NULL,
  kind         TEXT        NOT NULL,   -- 'movie' | 'series'
  refreshed_at TIMESTAMPTZ,
  row_count    INTEGER     NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'ok', -- 'ok' | 'building' | 'error'
  -- Precomputed [{genre, count}, ...] for the genre filter, built at the
  -- same time as the catalog so /genres is a trivial read, not a
  -- full-table unnest+GROUP BY on every cold request.
  genres_json  JSONB,
  PRIMARY KEY (user_id, kind)
);

-- Idempotent for DBs created before genres_json existed.
ALTER TABLE vod_catalog_meta ADD COLUMN IF NOT EXISTS genres_json JSONB;
