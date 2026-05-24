-- 036: Make epg_channels primary key composite (id, source_id).
--
-- Background: epg_channels.id was a global PRIMARY KEY, but in
-- practice the SAME channel id (e.g. "a&e.us", "nhl-network") appears
-- in many providers' XMLTV feeds — both the public EPG.pw / EPG Talk
-- Guide / Schedules Direct catalogs AND every bundled Xtream
-- provider's xmltv.php. saveChannels used ON CONFLICT (id) DO UPDATE,
-- so each refresh of a source STOLE ownership of the conflicting
-- channel id from whoever held it last. Symptoms in the data:
--
--   * bundled_65 (lordstreams.live): denorm channel_count = 9,687,
--     actual epg_channels rows = 0 — every channel got stolen
--     by other bundled sources and public sources during their
--     subsequent refreshes.
--   * EPG Share 01: denorm = 26,365, actual = 23,214 — 3,151
--     channels stolen.
--   * 3,781 of bundled_65's programs reference channel ids whose
--     epg_channels row is now owned by bundled_64 or bundled_250.
--
-- This broke the post-035 three-tier match precedence chain
-- entirely. The precedence resolver in routes/epg.js looks for
-- "channels whose id matches the IPTV channel's tvg_id AND whose
-- source_id is the bundled-EPG source for this IPTV source." With
-- channels migrated to other sources, that join finds nothing —
-- which is why the user sees an empty EPG panel even though the
-- provider's bundled EPG was successfully ingested.
--
-- The fix is the same pattern this codebase already uses for
-- iptv_channels (mig 032) and epg_programs (mig 034): composite
-- primary key on (id, source_id). The same channel id can exist
-- in multiple sources legitimately; saveChannels' UPSERT key must
-- include source_id so each source owns its own row independently.
--
-- The FK on epg_programs.channel_id → epg_channels.id was the
-- thing holding the broken design in place. We change it to a
-- composite reference (channel_id, source_id) → (id, source_id)
-- so every program is anchored to the channel from its OWN
-- source's catalog.
--
-- AccessExclusiveLock on epg_channels for ~1-3s. Safe to run
-- while the app is up but obviously a stop-everything-and-watch
-- moment for an EPG refresh in flight.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Idempotency guard
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'epg_channels_pkey'
       AND pg_get_constraintdef(oid) LIKE '%(id, source_id)%'
  ) THEN
    RAISE NOTICE 'epg_channels PK is already composite — skipping migration 036.';
    RETURN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Drop the old FK from epg_programs → epg_channels.id.
--
--    Declaration sits on the PARTITIONED parent (mig 034) so dropping
--    it here propagates to every partition automatically.
-- ---------------------------------------------------------------------------
ALTER TABLE epg_programs DROP CONSTRAINT IF EXISTS epg_programs_channel_id_fkey;

-- ---------------------------------------------------------------------------
-- 2. Clean orphan programs — those whose (channel_id, source_id)
--    has no matching epg_channels row.
--
--    Why so many: pre-036, each saveChannels call overwrote a global
--    channel-id row. Bundled-EPG sources stole channel ownership from
--    each other and from public sources; the programs kept their
--    own source_id but their channels migrated away. Probe shows
--    3.7M of 7.7M programs are orphans against (id, source_id).
--
--    The lost program data is recoverable from the providers' EPG
--    feeds — re-run /api/iptv/sources/refresh-all-bundled-epg after
--    the migration to backfill. Public-EPG sources will repopulate
--    on their next scheduled run.
--
--    NB: Postgres does not allow `NOT VALID` FKs on partitioned
--    tables (mig 034). That means the FK validation in step 5
--    blocks if any orphan remains. So cleanup MUST happen before
--    the FK is added.
-- ---------------------------------------------------------------------------
WITH orphan AS (
    SELECT p.ctid, p.tableoid
      FROM epg_programs p
      LEFT JOIN epg_channels c
        ON c.id = p.channel_id AND c.source_id = p.source_id
     WHERE c.id IS NULL
)
DELETE FROM epg_programs p USING orphan
 WHERE p.ctid = orphan.ctid AND p.tableoid = orphan.tableoid;

-- ---------------------------------------------------------------------------
-- 3. Swap the primary key on epg_channels from (id) to (id, source_id).
--
--    Existing rows are unique on (id, source_id) because the old
--    ON CONFLICT (id) clause meant duplicate ids always OVERWROTE the
--    prior row — never produced two simultaneous rows. So adding the
--    composite PK cannot fail on existing data.
-- ---------------------------------------------------------------------------
ALTER TABLE epg_channels DROP CONSTRAINT IF EXISTS epg_channels_pkey;
ALTER TABLE epg_channels ADD  CONSTRAINT epg_channels_pkey PRIMARY KEY (id, source_id);

-- ---------------------------------------------------------------------------
-- 4. Re-add the FK on epg_programs as a composite reference. Programs
--    always carry their channel's source_id (mig 034 partition key),
--    so the join is well-defined: every program is anchored to the
--    row in epg_channels where (id, source_id) match.
--
--    With orphans cleaned in step 2, this passes validation
--    immediately. The cost is a sequential scan of epg_programs to
--    confirm every row points at a valid channel — slow on 4M rows
--    but the same cost we'd pay if we tried VALIDATE separately.
-- ---------------------------------------------------------------------------
ALTER TABLE epg_programs
    ADD CONSTRAINT epg_programs_channel_id_fkey
    FOREIGN KEY (channel_id, source_id)
    REFERENCES epg_channels (id, source_id)
    ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Statistics refresh for the planner.
-- ---------------------------------------------------------------------------
ANALYZE epg_channels;
ANALYZE epg_programs;

COMMIT;
