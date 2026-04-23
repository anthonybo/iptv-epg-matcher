-- ============================================================================
-- Migration 018: Fix iptv_sources unique indexes (per-type scoping)
--
-- The original indexes from 001_initial_schema.sql only dedupe on
-- (user_id, type, url, username). That's wrong for Stalker sources, which
-- have NULL username and differ only by mac_address:
--
--   CREATE UNIQUE INDEX idx_iptv_sources_unique_with_username
--     ON iptv_sources(user_id, type, url, COALESCE(username, ''))
--     WHERE username IS NOT NULL;
--
--   CREATE UNIQUE INDEX idx_iptv_sources_unique_without_username
--     ON iptv_sources(user_id, type, url)
--     WHERE username IS NULL;
--
-- In practice Stalker rows are saved with username = '' (empty string, not
-- NULL), so they fall under the _with_username index and all collapse to the
-- same key because mac_address isn't part of it. Multiple MACs on the same
-- portal all collide, and only the first one saves — subsequent inserts fail
-- with "duplicate key value violates unique constraint
-- idx_iptv_sources_unique_with_username".
--
-- Fix: replace the two broad indexes with three per-type partial indexes.
-- Each type dedupes on exactly the columns that identify a distinct account.
-- ============================================================================

DROP INDEX IF EXISTS idx_iptv_sources_unique_with_username;
DROP INDEX IF EXISTS idx_iptv_sources_unique_without_username;

-- Xtream: same user + same server + same username = same account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_iptv_sources_unique_xtream
    ON iptv_sources (user_id, url, username)
    WHERE type = 'xtream' AND username IS NOT NULL AND username <> '';

-- Stalker: same user + same portal + same MAC = same account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_iptv_sources_unique_stalker
    ON iptv_sources (user_id, url, mac_address)
    WHERE type = 'stalker' AND mac_address IS NOT NULL;

-- M3U: just the URL uniquely identifies a playlist for a user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_iptv_sources_unique_m3u
    ON iptv_sources (user_id, url)
    WHERE type = 'm3u';

INSERT INTO schema_migrations (version, description)
VALUES ('018', 'Fix iptv_sources unique indexes: include mac_address for stalker, scope per type')
ON CONFLICT (version) DO NOTHING;
