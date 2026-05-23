-- 034: Partition epg_programs by source_id.
--
-- Background: EPG refresh batches were taking ~20s per 10k programs
-- because savePrograms wrote into a temp table then ran
-- INSERT...ON CONFLICT (id) DO UPDATE against a 919k-row table with
-- 7 indexes (PK on id, btree on channel_id, source_id, start_time,
-- stop_time, composite channel_time, and a trgm GIN on title).
-- Each row paid for a PK lookup + 7 index updates. Backend logs for
-- a single refresh of EPG.pw - US (140k programs) span ~5 minutes,
-- and the full 18-source refresh runs 90-150 minutes.
--
-- The DELETE+COPY+UPSERT path also leaves dead tuples for autovacuum
-- to chase, which fights the next refresh for I/O.
--
-- Architecture: list-partition epg_programs by source_id. Each EPG
-- source gets its own partition. Refresh becomes:
--   1. TRUNCATE epg_programs_p_<source_id> ONLY  (instant)
--   2. COPY new rows directly into the partition (no temp table,
--      no UPSERT — the partition is empty so there are no conflicts)
--   3. Sibling partitions untouched — other sources stay queryable
--      during this source's refresh
--
-- Same pattern as migration 032 (iptv_channels). Key differences:
--   * source_id here is varchar(255) (not integer). Partition names
--     are derived from sanitized source_id values.
--   * id is text (not a sequence). Composite PK becomes (id, source_id).
--   * Two outbound FKs (epg_sources, epg_channels) — both are
--     non-partitioned and PG 12+ supports FKs from partitioned to
--     non-partitioned tables, so they carry over unchanged.
--
-- Researched against:
--   * https://www.postgresql.org/docs/current/ddl-partitioning.html
--   * https://www.postgresql.org/docs/current/sql-truncate.html
--   * commit 547ed55 (iptv_channels partition + TRUNCATE+COPY)
--
-- NOT run automatically on boot — carries a ~919k-row copy
-- (~2-8 min in dev) under AccessExclusiveLock. Apply deliberately
-- via scripts/run_migration_034.js when no EPG refresh is in flight.

BEGIN;

-- Schema sanity guard: bail early if already partitioned. Lets us
-- run this file idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'epg_programs'
       AND relkind = 'p'  -- 'p' = partitioned table
  ) THEN
    RAISE NOTICE 'epg_programs is already partitioned — skipping migration 034.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'epg_programs' AND relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'epg_programs does not exist as a regular table; cannot run 034';
  END IF;
END $$;

-- 1. Move the existing table + indexes + constraints out of the way.
ALTER TABLE epg_programs                           RENAME TO epg_programs_pre034;
ALTER TABLE epg_programs_pre034
  RENAME CONSTRAINT epg_programs_pkey              TO epg_programs_pre034_pkey;
ALTER TABLE epg_programs_pre034
  RENAME CONSTRAINT epg_programs_source_id_fkey   TO epg_programs_pre034_source_id_fkey;
ALTER TABLE epg_programs_pre034
  RENAME CONSTRAINT epg_programs_channel_id_fkey  TO epg_programs_pre034_channel_id_fkey;
ALTER INDEX idx_epg_programs_channel_id            RENAME TO idx_epg_programs_channel_id_pre034;
ALTER INDEX idx_epg_programs_source_id             RENAME TO idx_epg_programs_source_id_pre034;
ALTER INDEX idx_epg_programs_start_time            RENAME TO idx_epg_programs_start_time_pre034;
ALTER INDEX idx_epg_programs_stop_time             RENAME TO idx_epg_programs_stop_time_pre034;
ALTER INDEX idx_epg_programs_time_range            RENAME TO idx_epg_programs_time_range_pre034;
ALTER INDEX idx_epg_programs_channel_time          RENAME TO idx_epg_programs_channel_time_pre034;
ALTER INDEX idx_epg_programs_title_trgm            RENAME TO idx_epg_programs_title_trgm_pre034;

-- 2. Create the new partitioned table.
--    Notes:
--    - PRIMARY KEY changes from (id) to (id, source_id). Postgres
--      requires the partition key in every unique constraint on a
--      partitioned table. id is sufficiently unique on its own
--      across all EPG sources (each source builds IDs that already
--      embed its own source slug), so this is a Postgres mechanic,
--      not a semantic change.
--    - FK to epg_sources(id) and epg_channels(id) preserved.
--      Postgres 12+ supports FKs from partitioned to non-partitioned
--      tables.
CREATE TABLE epg_programs (
    id            TEXT          NOT NULL,
    channel_id    VARCHAR(255)  NOT NULL,
    source_id     VARCHAR(255)  NOT NULL,
    title         TEXT          NOT NULL,
    description   TEXT,
    categories    TEXT[],
    last_updated  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    start_time    TIMESTAMP,
    stop_time     TIMESTAMP,
    CONSTRAINT epg_programs_pkey              PRIMARY KEY (id, source_id),
    CONSTRAINT epg_programs_source_id_fkey   FOREIGN KEY (source_id)
        REFERENCES epg_sources(id)  ON DELETE CASCADE,
    CONSTRAINT epg_programs_channel_id_fkey  FOREIGN KEY (channel_id)
        REFERENCES epg_channels(id) ON DELETE CASCADE
) PARTITION BY LIST (source_id);

-- 3. Indexes on the parent. Creating an index on a partitioned table
--    automatically creates a matching index on every existing and
--    future partition.
CREATE INDEX idx_epg_programs_channel_id    ON epg_programs (channel_id);
CREATE INDEX idx_epg_programs_source_id     ON epg_programs (source_id);
CREATE INDEX idx_epg_programs_start_time    ON epg_programs (start_time);
CREATE INDEX idx_epg_programs_stop_time     ON epg_programs (stop_time);
CREATE INDEX idx_epg_programs_time_range    ON epg_programs (channel_id, start_time, stop_time);
CREATE INDEX idx_epg_programs_channel_time  ON epg_programs (channel_id, start_time DESC, stop_time DESC);
CREATE INDEX idx_epg_programs_title_trgm    ON epg_programs USING gin (title gin_trgm_ops);

-- 4. Default partition — catches any source_id that doesn't yet have
--    its own partition (defensive; the app should always provision a
--    partition before inserting).
CREATE TABLE epg_programs_default PARTITION OF epg_programs DEFAULT;

-- 5. Create one partition per existing source. We use DO + format()
--    because LIST partition values can't be supplied as bind
--    parameters. The %I quote_ident-ifies the source_id so it's safe
--    even if it contains unusual characters.
DO $$
DECLARE
    src_id TEXT;
BEGIN
    FOR src_id IN
        SELECT DISTINCT source_id
          FROM epg_programs_pre034
         WHERE source_id IS NOT NULL
         ORDER BY 1
    LOOP
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF epg_programs FOR VALUES IN (%L)',
            'epg_programs_p_' || src_id,
            src_id
        );
    END LOOP;
END $$;

-- 6. Copy data from the pre-034 table. ~919k rows; this is the slow
--    step.
INSERT INTO epg_programs (
    id, channel_id, source_id, title, description, categories,
    last_updated, created_at, start_time, stop_time
)
SELECT
    id, channel_id, source_id, title, description, categories,
    last_updated, created_at, start_time, stop_time
FROM epg_programs_pre034
WHERE source_id IS NOT NULL;

-- 7. Drop the pre-034 table. CASCADE picks up the renamed indexes +
--    constraints (they all sit on the renamed table).
DROP TABLE epg_programs_pre034 CASCADE;

-- 8. Statistics for the new structure.
ANALYZE epg_programs;

COMMIT;
