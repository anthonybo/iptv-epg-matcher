-- Migration: 002_add_performance_indexes
-- Description: Add composite indexes for query performance with large datasets
-- Date: 2025-11-15

-- ============================================================================
-- Composite Indexes for Channel Queries
-- ============================================================================

-- Index for getChannelsForSession queries (source_id filtering is most common)
-- This speeds up: WHERE c.source_id = X queries
CREATE INDEX IF NOT EXISTS idx_iptv_channels_source_id_name
    ON iptv_channels(source_id, name);

-- Index for category queries with source filtering
-- This speeds up: WHERE source_id = X AND category IS NOT NULL GROUP BY category
CREATE INDEX IF NOT EXISTS idx_iptv_channels_source_id_category
    ON iptv_channels(source_id, category)
    WHERE category IS NOT NULL AND category != '';

-- Index for JOIN queries on sources (session_id and user_id lookups)
CREATE INDEX IF NOT EXISTS idx_iptv_sources_session_user
    ON iptv_sources(session_id, user_id);

-- Index for channel lookups by channel_id and source_id (streaming queries)
CREATE INDEX IF NOT EXISTS idx_iptv_channels_channel_id_source_id
    ON iptv_channels(channel_id, source_id);

-- ============================================================================
-- Update Table Statistics
-- ============================================================================
-- This helps PostgreSQL query planner make better decisions
ANALYZE iptv_channels;
ANALYZE iptv_sources;
ANALYZE epg_matches;
