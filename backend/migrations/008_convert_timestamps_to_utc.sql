-- Migration: Convert EPG timestamps to UTC with timezone
-- This fixes the issue where timestamps were being interpreted in the server's local timezone (MST)
-- instead of UTC, causing 7-hour offset in EPG data

-- Step 1: Add new UTC timestamp columns
ALTER TABLE epg_programs
  ADD COLUMN start_time_utc timestamp with time zone,
  ADD COLUMN stop_time_utc timestamp with time zone;

-- Step 2: Convert existing data assuming it's already in UTC
-- (the raw data should be UTC, but was stored without timezone info)
UPDATE epg_programs
SET
  start_time_utc = (start_time AT TIME ZONE 'UTC'),
  stop_time_utc = (stop_time AT TIME ZONE 'UTC');

-- Step 3: Drop old columns and rename new ones
ALTER TABLE epg_programs DROP COLUMN start_time;
ALTER TABLE epg_programs DROP COLUMN stop_time;
ALTER TABLE epg_programs RENAME COLUMN start_time_utc TO start_time;
ALTER TABLE epg_programs RENAME COLUMN stop_time_utc TO stop_time;

-- Step 4: Recreate indexes
DROP INDEX IF EXISTS idx_epg_programs_start_time;
DROP INDEX IF EXISTS idx_epg_programs_stop_time;
DROP INDEX IF EXISTS idx_epg_programs_channel_time;
DROP INDEX IF EXISTS idx_epg_programs_time_range;

CREATE INDEX idx_epg_programs_start_time ON epg_programs(start_time);
CREATE INDEX idx_epg_programs_stop_time ON epg_programs(stop_time);
CREATE INDEX idx_epg_programs_channel_time ON epg_programs(channel_id, start_time DESC, stop_time DESC);
CREATE INDEX idx_epg_programs_time_range ON epg_programs(channel_id, start_time, stop_time);

-- Done! All timestamps are now stored as UTC with timezone information
