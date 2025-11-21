-- Add blacklisted_channels table to PostgreSQL
-- Migration: 010
-- Description: Create blacklisted_channels table for filtering unwanted channels from random streams

CREATE TABLE IF NOT EXISTS blacklisted_channels (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_name)
);

CREATE INDEX IF NOT EXISTS idx_blacklisted_channels_user_id ON blacklisted_channels(user_id);
CREATE INDEX IF NOT EXISTS idx_blacklisted_channels_channel_name ON blacklisted_channels(channel_name);
