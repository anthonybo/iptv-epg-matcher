-- 035: Schema for per-source bundled EPG.
--
-- Background: most IPTV providers ship their own XMLTV EPG endpoint
-- alongside the M3U/Xtream channel list — Xtream backends expose it
-- at `{host}/xmltv.php?username=X&password=Y`; M3U playlists declare
-- it via the `#EXTM3U url-tvg="…"` or `x-tvg-url="…"` header. Most
-- IPTV players (TiviMate, OTT Navigator, IPTV Smarters, Threadfin)
-- auto-detect and ingest this bundled EPG so each channel has
-- default program data without any user-side matching. We did not
-- have that — every channel started life as "no EPG" until a user
-- manually matched it against one of our 18 global public sources.
--
-- Architecture: reuse the existing epg_sources / epg_channels /
-- epg_programs tables (so we inherit the partitioning from
-- migration 034, the FTS search shadow, and the matcher UI), but
-- tag each row that came from a provider's bundled EPG with the
-- iptv_source it belongs to. Query-time precedence becomes:
--   1. Explicit user match in epg_matches  — wins outright
--   2. Channel's tvg_id matches a row in its source's bundled EPG
--   3. Channel's tvg_id matches a row in any global public EPG
--   4. No EPG.
--
-- This migration is intentionally NOT run on boot — apply
-- deliberately via scripts/run_migration_035.js after reviewing.
-- It's also fully idempotent (ADD COLUMN IF NOT EXISTS, etc.).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. epg_sources: scope a row to a specific iptv_source.
--
--    NULL = global public EPG (the 18 sources we already ingest from
--    epg.pw, EPG Talk Guide, etc.). NOT NULL = bundled EPG owned by
--    that iptv_source. CASCADE on the FK so removing an IPTV source
--    also cleans up its bundled EPG rows.
-- ---------------------------------------------------------------------------
ALTER TABLE epg_sources
    ADD COLUMN IF NOT EXISTS owner_iptv_source_id INTEGER
        REFERENCES iptv_sources(id) ON DELETE CASCADE;

-- Partial index: only on rows that ARE owned by an iptv_source.
-- Skips the ~18 global rows so the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_epg_sources_owner_iptv_source_id
    ON epg_sources (owner_iptv_source_id)
    WHERE owner_iptv_source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. iptv_sources: per-source bundled EPG metadata.
--
--    bundled_epg_url  — cached discovered URL (so we don't re-derive
--                       on every refresh). May be null when the
--                       source has no bundled EPG (rare; most do).
--    bundled_epg_status — null = never tried, 'pending' = ingest in
--                       flight, 'ok' = last ingest succeeded,
--                       'failed' = last ingest errored.
--    bundled_epg_error — last error message when status='failed'.
--    bundled_epg_last_refreshed — wall-clock of last successful
--                       ingest. Powers the "stale" warning in the UI.
--    bundled_epg_channel_count / program_count — denormalised so the
--                       UI doesn't have to COUNT(*) across the
--                       partitioned epg_programs every time it
--                       wants to show status.
-- ---------------------------------------------------------------------------
ALTER TABLE iptv_sources
    ADD COLUMN IF NOT EXISTS bundled_epg_url            TEXT,
    ADD COLUMN IF NOT EXISTS bundled_epg_status         VARCHAR(20),
    ADD COLUMN IF NOT EXISTS bundled_epg_error          TEXT,
    ADD COLUMN IF NOT EXISTS bundled_epg_last_refreshed TIMESTAMP,
    ADD COLUMN IF NOT EXISTS bundled_epg_channel_count  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bundled_epg_program_count  INTEGER NOT NULL DEFAULT 0;

-- Constraint: bundled_epg_status must be one of the four documented
-- values (or null). Catches typos in code that writes to this field.
ALTER TABLE iptv_sources
    DROP CONSTRAINT IF EXISTS iptv_sources_bundled_epg_status_check;
ALTER TABLE iptv_sources
    ADD  CONSTRAINT iptv_sources_bundled_epg_status_check
    CHECK (bundled_epg_status IS NULL
        OR bundled_epg_status IN ('pending', 'ok', 'failed', 'no_url'));

-- ---------------------------------------------------------------------------
-- 3. Statistics refresh for the planner so the partial index gets
--    used immediately rather than after the next autovacuum.
-- ---------------------------------------------------------------------------
ANALYZE epg_sources;
ANALYZE iptv_sources;

COMMIT;
