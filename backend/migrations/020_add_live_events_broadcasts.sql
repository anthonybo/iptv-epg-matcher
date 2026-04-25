-- Migration: 020_add_live_events_broadcasts
-- Description: Capture ESPN's broadcasts metadata so we can locate the
--              actual TV channel airing a game (B1G+, ESPN+, TBS, etc.)
--              instead of relying on team-name fuzzy match. Big sports
--              networks rebroadcast under generic channel names like
--              ":BTN+ 25" — without this we can't connect the game to
--              the channel.
-- Date: 2026-04-24

-- TEXT[] (array of broadcaster names) is enough — ESPN returns one to
-- a few names per market and we only need substring matching against
-- channel names.
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS broadcasts TEXT[];

-- We do not bother indexing broadcasts because the lookup pattern is
-- "given an event_id, get its broadcasts" which already uses the PK.
