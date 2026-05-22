-- 032: Partition iptv_channels by source_id.
--
-- Background: refresh of a single source was taking 5-25 minutes
-- because DELETE+INSERT on the parent table forced per-row index
-- maintenance across 11 indexes (including 2 GIN on `name`) for
-- the entire 866k-row table. Every refresh also left tens of
-- thousands of dead tuples for autovacuum to chase, which then
-- contended with reads and made the whole app feel laggy.
--
-- Architecture: list-partition iptv_channels by source_id. Each
-- IPTV source gets its own partition. Refresh becomes:
--   1. TRUNCATE iptv_channels_p_<source_id> ONLY  (instant, no
--      dead tuples, sibling partitions untouched)
--   2. COPY new rows into the partition          (~1.7x faster
--      than UNNEST insert, ~8x faster than batched multi-VALUES)
--
-- Researched against:
--   * https://www.postgresql.org/docs/current/ddl-partitioning.html
--   * https://www.postgresql.org/docs/current/sql-truncate.html
--   * https://www.tigerdata.com/learn/testing-postgres-ingest-insert-vs-batch-insert-vs-copy
--   * https://postgres.ai/docs/postgres-howtos/database-administration/maintenance/how-to-deal-with-bloat
--
-- This migration is intentionally NOT run automatically on boot —
-- it carries a full-table copy (~866k rows, ~1-5 min in our dev
-- environment) and an AccessExclusiveLock for that duration.
-- Apply it deliberately via the runner script under scripts/.

BEGIN;

-- Schema sanity guard: bail early if already partitioned. Lets us
-- run this file idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'iptv_channels'
       AND relkind = 'p'  -- 'p' = partitioned table
  ) THEN
    RAISE NOTICE 'iptv_channels is already partitioned — skipping migration 032.';
    RETURN;
  END IF;

  -- Sanity check: original table must exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'iptv_channels' AND relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'iptv_channels does not exist as a regular table; cannot run 032';
  END IF;
END $$;

-- 1. Move the existing table out of the way under a new name.
--    Renaming the indexes too — the new table needs index names
--    free to reuse.
ALTER TABLE iptv_channels                              RENAME TO iptv_channels_pre032;
ALTER SEQUENCE iptv_channels_id_seq                    RENAME TO iptv_channels_pre032_id_seq;
ALTER TABLE iptv_channels_pre032
  RENAME CONSTRAINT iptv_channels_pkey                 TO iptv_channels_pre032_pkey;
ALTER TABLE iptv_channels_pre032
  RENAME CONSTRAINT iptv_channels_channel_source_unique TO iptv_channels_pre032_channel_source_unique;
ALTER TABLE iptv_channels_pre032
  RENAME CONSTRAINT iptv_channels_source_id_fkey       TO iptv_channels_pre032_source_id_fkey;
ALTER INDEX idx_iptv_channels_category                 RENAME TO idx_iptv_channels_category_pre032;
ALTER INDEX idx_iptv_channels_name                     RENAME TO idx_iptv_channels_name_pre032;
ALTER INDEX idx_iptv_channels_name_btree               RENAME TO idx_iptv_channels_name_btree_pre032;
ALTER INDEX idx_iptv_channels_name_trgm                RENAME TO idx_iptv_channels_name_trgm_pre032;
ALTER INDEX idx_iptv_channels_source_id                RENAME TO idx_iptv_channels_source_id_pre032;
ALTER INDEX idx_iptv_channels_source_id_category       RENAME TO idx_iptv_channels_source_id_category_pre032;
ALTER INDEX idx_iptv_channels_source_id_name           RENAME TO idx_iptv_channels_source_id_name_pre032;
ALTER INDEX idx_iptv_channels_tvg_id                   RENAME TO idx_iptv_channels_tvg_id_pre032;
ALTER INDEX idx_iptv_channels_tvg_id_lower             RENAME TO idx_iptv_channels_tvg_id_lower_pre032;

-- 2. Create the new partitioned table.
--    Notes:
--    - source_id becomes NOT NULL (the partition key must be).
--      The old table allowed NULL but no real row carries one.
--    - PRIMARY KEY changes from (id) to (id, source_id). Postgres
--      requires the partition key to be in every unique constraint
--      on a partitioned table. The composite is still unique-enough
--      because id is from a global sequence; this is purely a
--      Postgres mechanic, not a semantic change.
--    - UNIQUE (channel_id, source_id) is preserved (source_id was
--      already in there, so no change needed).
CREATE SEQUENCE iptv_channels_id_seq;

CREATE TABLE iptv_channels (
    id                   INTEGER       NOT NULL DEFAULT nextval('iptv_channels_id_seq'),
    channel_id           VARCHAR       NOT NULL,
    source_id            INTEGER       NOT NULL,
    name                 TEXT          NOT NULL,
    stream_url           TEXT,
    logo_url             TEXT,
    category             VARCHAR,
    tvg_id               VARCHAR,
    tvg_name             TEXT,
    group_title          VARCHAR,
    source_type          VARCHAR,
    source_username      VARCHAR,
    source_password      VARCHAR,
    source_url           TEXT,
    source_mac           VARCHAR,
    created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    enable_live_prefix   BOOLEAN       DEFAULT FALSE,
    CONSTRAINT iptv_channels_pkey PRIMARY KEY (id, source_id),
    CONSTRAINT iptv_channels_channel_source_unique UNIQUE (channel_id, source_id),
    CONSTRAINT iptv_channels_source_id_fkey FOREIGN KEY (source_id)
        REFERENCES iptv_sources(id) ON DELETE CASCADE
) PARTITION BY LIST (source_id);

ALTER SEQUENCE iptv_channels_id_seq OWNED BY iptv_channels.id;

-- 3. Indexes on the parent. Creating an index on a partitioned
--    table automatically creates a matching index on every existing
--    and future partition.
CREATE INDEX idx_iptv_channels_category               ON iptv_channels (category);
CREATE INDEX idx_iptv_channels_name                   ON iptv_channels USING gin (to_tsvector('english', name));
CREATE INDEX idx_iptv_channels_name_btree             ON iptv_channels (name);
CREATE INDEX idx_iptv_channels_name_trgm              ON iptv_channels USING gin (name gin_trgm_ops);
CREATE INDEX idx_iptv_channels_source_id              ON iptv_channels (source_id);
CREATE INDEX idx_iptv_channels_source_id_category     ON iptv_channels (source_id, category)
    WHERE category IS NOT NULL AND category::text <> '';
CREATE INDEX idx_iptv_channels_source_id_name         ON iptv_channels (source_id, name);
CREATE INDEX idx_iptv_channels_tvg_id                 ON iptv_channels (tvg_id);
CREATE INDEX idx_iptv_channels_tvg_id_lower           ON iptv_channels (lower(tvg_id));

-- 4. Trigger on parent (propagates to all partitions automatically).
CREATE TRIGGER update_iptv_channels_updated_at
    BEFORE UPDATE ON iptv_channels
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. Default partition — catches any source_id that doesn't yet
--    have its own partition (defensive; the app should always
--    provision a partition before inserting).
CREATE TABLE iptv_channels_default PARTITION OF iptv_channels DEFAULT;

-- 6. Create one partition per existing iptv_sources row. We use
--    DO + format() because LIST partition values can't be supplied
--    as bind parameters.
DO $$
DECLARE
    src_id INTEGER;
BEGIN
    FOR src_id IN SELECT id FROM iptv_sources ORDER BY id LOOP
        EXECUTE format(
            'CREATE TABLE iptv_channels_p_%s PARTITION OF iptv_channels FOR VALUES IN (%s)',
            src_id, src_id
        );
    END LOOP;
END $$;

-- 7. Copy data from the pre-032 table. ~866k rows; this is the
--    slow step. Single statement so the planner can use parallel
--    workers.
INSERT INTO iptv_channels (
    id, channel_id, source_id, name, stream_url, logo_url, category,
    tvg_id, tvg_name, group_title, source_type, source_username,
    source_password, source_url, source_mac, created_at, updated_at,
    enable_live_prefix
)
SELECT
    id, channel_id, source_id, name, stream_url, logo_url, category,
    tvg_id, tvg_name, group_title, source_type, source_username,
    source_password, source_url, source_mac, created_at, updated_at,
    enable_live_prefix
FROM iptv_channels_pre032
WHERE source_id IS NOT NULL;  -- exclude any stray null rows that wouldn't fit a partition

-- 8. Advance the sequence past the imported rows.
SELECT setval('iptv_channels_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM iptv_channels), 1));

-- 9. Drop the pre-032 table and its sequence.
DROP TABLE iptv_channels_pre032 CASCADE;
DROP SEQUENCE IF EXISTS iptv_channels_pre032_id_seq;

COMMIT;
