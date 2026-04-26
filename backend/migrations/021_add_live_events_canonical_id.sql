-- Migration: 021_add_live_events_canonical_id
-- Description: Cross-source event deduplication. Each adapter writes
--              events with its own source-prefixed event_id (espn_xxx,
--              sportsdb_xxx, mlbstats_xxx). Without canonical_id, the
--              same MLB game from ESPN and MLB Stats API would appear
--              as two ticker entries. canonical_id is a deterministic
--              hash of (sport, normalized_home, normalized_away,
--              start-time-rounded-to-hour) — different sources produce
--              the same canonical_id for the same game.
-- Date: 2026-04-25

ALTER TABLE live_events ADD COLUMN IF NOT EXISTS canonical_id VARCHAR(64);
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS sources TEXT[];

-- Index for upsert-by-canonical-id pattern.
CREATE INDEX IF NOT EXISTS idx_live_events_canonical_id ON live_events(canonical_id) WHERE canonical_id IS NOT NULL;
