-- 033: Add iptv_channels_search shadow table for fast channel search.
--
-- Background: iptv_channels is LIST-partitioned by source_id (mig 032),
-- which made refresh fast but turned every search across the user's
-- catalog into a 65-partition fan-out. The Postgres planner enumerates
-- catalog metadata for every partition + every index per partition on
-- the first query of a fresh connection — measured at:
--
--   Cold connection: 3.5s planning + 6ms execution
--   Warm connection: 42ms planning + 5ms execution
--
-- With Node's pg pool spinning up new connections under load, the cold
-- case fired routinely and timed out the picker UI even on simple
-- 30-row results. See backend/logs/combined-2026-05-22.log around
-- 10:39:47 — "nhl network" → 15s timeout.
--
-- Architecture: a small, NON-partitioned, denormalized shadow that
-- contains exactly the columns search needs, plus a STORED tsvector
-- column with a single GIN index. One table = one plan = ~1ms
-- planning regardless of connection state.
--
-- Trade-off: ~250MB of duplicate data (1M rows × ~250 bytes). Kept in
-- sync by saveChannels (TRUNCATE+COPY mirror into shadow inside the
-- same transaction) and deleteSource (DELETE from shadow). No
-- triggers — the application owns the lifecycle.
--
-- Researched against:
--   * https://postgres.ai/blog/20241003-how-does-planning-time-depend-on-number-of-partitions
--   * https://www.postgresql.org/docs/current/textsearch-tables.html#TEXTSEARCH-TABLES-INDEX
--   * https://www.postgresql.org/docs/current/textsearch-indexes.html

BEGIN;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS iptv_channels_search (
    source_id    INTEGER NOT NULL,
    channel_id   TEXT    NOT NULL,
    user_id      INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    -- GENERATED ALWAYS STORED: the tsvector is computed at write time
    -- and stored physically. The 'simple' config is intentional —
    -- channel names are not English prose, so we don't want stemming
    -- (no "network" → "networks" stem) or stop-word removal ("USA"
    -- and "HD" are meaningful tokens here, not stop-words). 'simple'
    -- just lowercases and tokenises on non-alphanumeric boundaries,
    -- which is exactly right for channel name matching.
    name_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple', name)) STORED,
    logo_url     TEXT,
    stream_url   TEXT,
    tvg_id       TEXT,
    group_title  TEXT,
    PRIMARY KEY (source_id, channel_id)
);

-- GIN index on the tsvector — this is the only index actually used by
-- the picker search query.
CREATE INDEX IF NOT EXISTS iptv_channels_search_name_tsv_idx
    ON iptv_channels_search USING gin (name_tsv);

-- Btree on user_id for ownership filtering. The selectivity is poor
-- (most users own most rows), but PG combines it with the GIN bitmap
-- result, so it still helps prune before heap fetch.
CREATE INDEX IF NOT EXISTS iptv_channels_search_user_id_idx
    ON iptv_channels_search USING btree (user_id);

-- Btree on source_id for the per-source TRUNCATE-and-replace path
-- used by saveChannels.
CREATE INDEX IF NOT EXISTS iptv_channels_search_source_id_idx
    ON iptv_channels_search USING btree (source_id);

-- ---------------------------------------------------------------------------
-- One-shot backfill from the partitioned table.
--
-- ON CONFLICT DO NOTHING because re-running the migration shouldn't
-- duplicate rows. The PK on (source_id, channel_id) catches collisions.
-- ---------------------------------------------------------------------------
INSERT INTO iptv_channels_search
    (source_id, channel_id, user_id, name, logo_url, stream_url, tvg_id, group_title)
SELECT
    c.source_id, c.channel_id, s.user_id, c.name, c.logo_url, c.stream_url,
    c.tvg_id, c.group_title
FROM iptv_channels c
JOIN iptv_sources s ON c.source_id = s.id
ON CONFLICT (source_id, channel_id) DO NOTHING;

-- Help the planner with the new table immediately rather than waiting
-- for autovacuum.
ANALYZE iptv_channels_search;

COMMIT;
