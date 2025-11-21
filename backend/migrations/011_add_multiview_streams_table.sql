-- Add multiview_streams table to PostgreSQL
-- Migration: 011
-- Description: Create multiview_streams table for persisting user's multiview streams

CREATE TABLE IF NOT EXISTS multiview_streams (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    logo TEXT,
    url TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_url TEXT,
    source_username VARCHAR(255),
    source_password VARCHAR(255),
    source_mac VARCHAR(255),
    source_name VARCHAR(255),
    espn_event_id VARCHAR(255),
    espn_event_name VARCHAR(255),
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_multiview_streams_user_id ON multiview_streams(user_id);
CREATE INDEX IF NOT EXISTS idx_multiview_streams_added_at ON multiview_streams(added_at);
