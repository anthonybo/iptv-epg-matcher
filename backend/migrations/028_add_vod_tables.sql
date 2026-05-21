-- Migration: 028_add_vod_tables
-- Description: VOD (Video On Demand) — movies + series — schema.
-- Date: 2026-05-20
--
-- Two-tier model matching the existing iptv_sources/iptv_channels split:
--
--   * Canonical "work" tables  — movies, series, seasons, episodes
--     One row per (title, year) globally. Holds TMDB-enriched metadata
--     (poster, overview, cast, runtime) that's shared across every
--     provider carrying the same work.
--
--   * Per-source "availability" tables — movie_streams, series_sources,
--     episode_streams. One row per (source, provider_stream_id). Holds
--     the per-account stream URL + container extension + provider's
--     raw metadata blob.
--
-- The link from availability → canonical (movie_id, series_id,
-- episode_id) is NULLABLE on purpose. Ingest inserts rows with the
-- canonical FK = NULL; the TMDB enrichment worker (P3) backfills the
-- link after deduping by (title_norm, year).
--
-- This shape is what IPTVnator, pyxtream, and the Stremio Xtream
-- addons converged on — eager-load the catalog list, lazy-load the
-- per-series episode tree on click, dedupe canonical metadata across
-- sources so the same "The Matrix 1999" only fetches its poster once.
--
-- Storage scale: 10 sources × 30k movies + 10 × 10k series × 5
-- seasons × 12 episodes (lazy) ≈ 6M rows total — fine for Postgres
-- with the indexes below.

-- pg_trgm already installed by migration 022; restate for safety.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── VOD categories (per-source, shared between movies + series) ──
-- Categories are provider-defined and not deduped — "Action" on
-- provider A is a different opaque category_id from "Action" on
-- provider B. We just store them as the source returned them and
-- let the UI surface them per-source for browsing.
CREATE TABLE IF NOT EXISTS vod_categories (
    id                  BIGSERIAL PRIMARY KEY,
    source_id           INTEGER NOT NULL REFERENCES iptv_sources(id) ON DELETE CASCADE,
    kind                TEXT    NOT NULL CHECK (kind IN ('movie', 'series')),
    provider_category_id TEXT   NOT NULL,
    name                TEXT    NOT NULL,
    parent_id           TEXT,
    UNIQUE (source_id, kind, provider_category_id)
);

CREATE INDEX IF NOT EXISTS idx_vod_categories_source_kind
    ON vod_categories (source_id, kind);

-- ─── Canonical MOVIES ────────────────────────────────────────────
-- One row per (title_norm, year). title_norm is a generated column
-- so it can be UNIQUE without app-side normalisation drift.
-- tmdb_id / imdb_id are nullable — populated by the enrichment
-- worker. enriched_at lets the worker skip rows it's already done
-- and the UI distinguish "still bare provider data" from "TMDB-
-- enriched". The worker also persists poster_url / overview / cast.
CREATE TABLE IF NOT EXISTS movies (
    id              BIGSERIAL PRIMARY KEY,
    tmdb_id         INTEGER UNIQUE,
    imdb_id         TEXT    UNIQUE,
    title           TEXT    NOT NULL,
    year            INTEGER,
    -- Lower-cased, alphanum-only key for dedup. Two providers' "The
    -- Matrix (1999)" and "MATRIX, THE 1999" both collapse to "thematrix".
    title_norm      TEXT    GENERATED ALWAYS AS (
                        lower(regexp_replace(title, '[^a-zA-Z0-9]+', '', 'g'))
                    ) STORED,
    overview        TEXT,
    poster_url      TEXT,
    backdrop_url    TEXT,
    runtime_secs    INTEGER,
    genres          TEXT[],
    director        TEXT,
    cast_json       JSONB,    -- TMDB credits.cast[] truncated to top ~15
    rating_tmdb     NUMERIC(3,1),
    rating_imdb     NUMERIC(3,1),
    released_on     DATE,
    enriched_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (title_norm, year)
);

CREATE INDEX IF NOT EXISTS idx_movies_title_trgm
    ON movies USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_movies_enriched_at
    ON movies (enriched_at NULLS FIRST);

-- ─── Per-source MOVIE STREAMS ────────────────────────────────────
-- movie_id NULL means "not yet enriched / linked to canonical". The
-- enrichment worker walks these rows in batches, hits TMDB by
-- (provider_name, year-extracted-from-title), upserts movies, then
-- links them here in bulk.
--
-- When stream URLs change (provider rotates auth, etc.), the upsert
-- on (source_id, provider_stream_id) replaces them in place.
CREATE TABLE IF NOT EXISTS movie_streams (
    id                    BIGSERIAL PRIMARY KEY,
    source_id             INTEGER NOT NULL REFERENCES iptv_sources(id) ON DELETE CASCADE,
    movie_id              BIGINT  REFERENCES movies(id) ON DELETE SET NULL,
    provider_stream_id    TEXT    NOT NULL,
    provider_name         TEXT    NOT NULL,  -- raw title from provider, pre-enrichment
    provider_category_id  TEXT,
    container_extension   TEXT,              -- mp4 / mkv / avi
    -- Stream URL template. Xtream:
    --   /movie/{username}/{password}/{stream_id}.{container_extension}
    -- Stalker: resolved on play via create_link.
    -- Stored as the FULL upstream URL so the stream proxy can fetch
    -- without re-deriving creds.
    stream_url            TEXT,
    added_at              TIMESTAMPTZ,       -- provider's "added" epoch (for "Recently added")
    rating                NUMERIC(3,1),
    raw_meta              JSONB,             -- provider's full row for debugging + future fields
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, provider_stream_id)
);

CREATE INDEX IF NOT EXISTS idx_movie_streams_movie_id
    ON movie_streams (movie_id) WHERE movie_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movie_streams_source_id
    ON movie_streams (source_id);
CREATE INDEX IF NOT EXISTS idx_movie_streams_unenriched
    ON movie_streams (source_id) WHERE movie_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_movie_streams_provider_name_trgm
    ON movie_streams USING gin (provider_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_movie_streams_added_at
    ON movie_streams (added_at DESC NULLS LAST);

-- ─── Canonical SERIES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS series (
    id              BIGSERIAL PRIMARY KEY,
    tmdb_id         INTEGER UNIQUE,
    imdb_id         TEXT    UNIQUE,
    title           TEXT    NOT NULL,
    year            INTEGER,
    title_norm      TEXT    GENERATED ALWAYS AS (
                        lower(regexp_replace(title, '[^a-zA-Z0-9]+', '', 'g'))
                    ) STORED,
    overview        TEXT,
    poster_url      TEXT,
    backdrop_url    TEXT,
    genres          TEXT[],
    cast_json       JSONB,
    rating_tmdb     NUMERIC(3,1),
    enriched_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (title_norm, year)
);

CREATE INDEX IF NOT EXISTS idx_series_title_trgm
    ON series USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_series_enriched_at
    ON series (enriched_at NULLS FIRST);

-- ─── Per-source SERIES AVAILABILITY ──────────────────────────────
CREATE TABLE IF NOT EXISTS series_sources (
    id                    BIGSERIAL PRIMARY KEY,
    source_id             INTEGER NOT NULL REFERENCES iptv_sources(id) ON DELETE CASCADE,
    series_id             BIGINT  REFERENCES series(id) ON DELETE SET NULL,
    provider_series_id    TEXT    NOT NULL,
    provider_name         TEXT    NOT NULL,
    provider_category_id  TEXT,
    last_episode_fetch    TIMESTAMPTZ,   -- when the lazy get_series_info ran; NULL = never
    raw_meta              JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, provider_series_id)
);

CREATE INDEX IF NOT EXISTS idx_series_sources_series_id
    ON series_sources (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_series_sources_source_id
    ON series_sources (source_id);
CREATE INDEX IF NOT EXISTS idx_series_sources_unenriched
    ON series_sources (source_id) WHERE series_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_series_sources_provider_name_trgm
    ON series_sources USING gin (provider_name gin_trgm_ops);

-- ─── SEASONS (canonical, child of series) ────────────────────────
-- Populated lazily when a user opens a series. Persisted so a 2nd
-- user opening the same series gets an instant cache hit.
CREATE TABLE IF NOT EXISTS seasons (
    id              BIGSERIAL PRIMARY KEY,
    series_id       BIGINT  NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    season_number   INTEGER NOT NULL,
    name            TEXT,
    overview        TEXT,
    poster_url      TEXT,
    air_date        DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (series_id, season_number)
);

CREATE INDEX IF NOT EXISTS idx_seasons_series_id
    ON seasons (series_id, season_number);

-- ─── EPISODES (canonical, child of seasons) ──────────────────────
CREATE TABLE IF NOT EXISTS episodes (
    id              BIGSERIAL PRIMARY KEY,
    season_id       BIGINT  NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    episode_number  INTEGER NOT NULL,
    title           TEXT,
    overview        TEXT,
    runtime_secs    INTEGER,
    still_url       TEXT,
    air_date        DATE,
    rating_tmdb     NUMERIC(3,1),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (season_id, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_episodes_season_id
    ON episodes (season_id, episode_number);

-- ─── Per-source EPISODE STREAMS ──────────────────────────────────
-- Same shape as movie_streams. An episode that's available on 3
-- providers gets 3 rows here, all linked to the same canonical
-- episodes.id.
CREATE TABLE IF NOT EXISTS episode_streams (
    id                    BIGSERIAL PRIMARY KEY,
    source_id             INTEGER NOT NULL REFERENCES iptv_sources(id) ON DELETE CASCADE,
    series_source_id      BIGINT  NOT NULL REFERENCES series_sources(id) ON DELETE CASCADE,
    episode_id            BIGINT  REFERENCES episodes(id) ON DELETE SET NULL,
    provider_episode_id   TEXT    NOT NULL,
    provider_season       INTEGER NOT NULL,
    provider_episode_num  INTEGER NOT NULL,
    provider_title        TEXT,
    container_extension   TEXT,
    stream_url            TEXT,
    added_at              TIMESTAMPTZ,
    raw_meta              JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, provider_episode_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_streams_episode_id
    ON episode_streams (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_episode_streams_series_source
    ON episode_streams (series_source_id, provider_season, provider_episode_num);
