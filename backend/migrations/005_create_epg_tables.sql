-- Migration: 005_create_epg_tables
-- Description: Create EPG tables in PostgreSQL (migrate from MongoDB)
-- Date: 2025-11-15

-- ============================================================================
-- EPG Sources Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS epg_sources (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url TEXT,
    file_path TEXT,
    channel_count INTEGER DEFAULT 0,
    program_count INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epg_sources_name ON epg_sources(name);

COMMENT ON TABLE epg_sources IS 'EPG source metadata (migrated from MongoDB)';
COMMENT ON COLUMN epg_sources.id IS 'Unique identifier for EPG source';
COMMENT ON COLUMN epg_sources.url IS 'URL to fetch EPG data from';
COMMENT ON COLUMN epg_sources.file_path IS 'Local file path if EPG is from file';

-- ============================================================================
-- EPG Channels Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS epg_channels (
    id VARCHAR(255) PRIMARY KEY,
    source_id VARCHAR(255) NOT NULL REFERENCES epg_sources(id) ON DELETE CASCADE,
    name VARCHAR(512) NOT NULL,
    icon TEXT,
    language_code VARCHAR(10),
    categories_csv TEXT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epg_channels_source_id ON epg_channels(source_id);
CREATE INDEX IF NOT EXISTS idx_epg_channels_name ON epg_channels(name);
CREATE INDEX IF NOT EXISTS idx_epg_channels_name_lower ON epg_channels(LOWER(name));

-- Full-text search index for channel names
CREATE INDEX IF NOT EXISTS idx_epg_channels_name_trgm ON epg_channels USING gin (name gin_trgm_ops);

COMMENT ON TABLE epg_channels IS 'EPG channel listings (migrated from MongoDB)';
COMMENT ON COLUMN epg_channels.id IS 'Channel ID from EPG source (e.g., I123.456.schedulesdirect.org)';
COMMENT ON COLUMN epg_channels.categories_csv IS 'Comma-separated list of categories';

-- ============================================================================
-- EPG Programs Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS epg_programs (
    id VARCHAR(512) PRIMARY KEY,
    channel_id VARCHAR(255) NOT NULL REFERENCES epg_channels(id) ON DELETE CASCADE,
    source_id VARCHAR(255) NOT NULL REFERENCES epg_sources(id) ON DELETE CASCADE,
    title VARCHAR(512) NOT NULL,
    description TEXT,
    start_time TIMESTAMP NOT NULL,
    stop_time TIMESTAMP NOT NULL,
    categories TEXT[], -- Array of categories
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Critical indexes for performance
CREATE INDEX IF NOT EXISTS idx_epg_programs_channel_id ON epg_programs(channel_id);
CREATE INDEX IF NOT EXISTS idx_epg_programs_source_id ON epg_programs(source_id);
CREATE INDEX IF NOT EXISTS idx_epg_programs_time_range ON epg_programs(channel_id, start_time, stop_time);
CREATE INDEX IF NOT EXISTS idx_epg_programs_start_time ON epg_programs(start_time);
CREATE INDEX IF NOT EXISTS idx_epg_programs_stop_time ON epg_programs(stop_time);

-- Composite index for common queries (channel + time window)
CREATE INDEX IF NOT EXISTS idx_epg_programs_channel_time ON epg_programs(channel_id, start_time DESC, stop_time DESC);

COMMENT ON TABLE epg_programs IS 'EPG program guide data (migrated from MongoDB)';
COMMENT ON COLUMN epg_programs.id IS 'Unique program ID (combination of channel_id, start_time, title)';
COMMENT ON COLUMN epg_programs.start_time IS 'Program start time';
COMMENT ON COLUMN epg_programs.stop_time IS 'Program end time';
COMMENT ON COLUMN epg_programs.categories IS 'Array of program categories (genre, type, etc.)';

-- ============================================================================
-- Enable pg_trgm extension for fuzzy text search (if not already enabled)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================================
-- Analyze tables for query optimization
-- ============================================================================

ANALYZE epg_sources;
ANALYZE epg_channels;
ANALYZE epg_programs;
