-- Add channel_favorites table to PostgreSQL
-- Migration: 025
-- Description: Per-user channel favorites for fast multi-view tile fill.
--              Keyed by (user, source, channel) so the same channel name
--              from different sources/accounts counts as distinct favorites.

CREATE TABLE IF NOT EXISTS channel_favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES iptv_sources(id) ON DELETE CASCADE,
    channel_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    logo TEXT,
    url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    last_played_at TIMESTAMP,
    play_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, source_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_favorites_user_position
    ON channel_favorites(user_id, position);

CREATE INDEX IF NOT EXISTS idx_channel_favorites_user_last_played
    ON channel_favorites(user_id, last_played_at DESC NULLS LAST);
