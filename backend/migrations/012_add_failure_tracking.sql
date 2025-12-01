-- Migration: 012_add_failure_tracking
-- Description: Add columns to track refresh failure count, last failure time, last successful refresh, duration, and server location
-- Date: 2025-12-01

-- ============================================================================
-- Add Failure Tracking to IPTV Sources
-- ============================================================================

-- Add failure_count column to track cumulative failures
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS failure_count INTEGER DEFAULT 0;

-- Add last_failure_time column to track when the last failure occurred
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS last_failure_time TIMESTAMP;

-- Add last_successful_refresh column to track when the source last refreshed successfully
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS last_successful_refresh TIMESTAMP;

-- Add last_refresh_duration_ms column to track how long the refresh took
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS last_refresh_duration_ms INTEGER;

-- Add server_country column for geolocation
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS server_country VARCHAR(100);

-- Add server_city column for geolocation
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS server_city VARCHAR(100);

-- Create index for filtering by failure count (useful for finding problematic sources)
CREATE INDEX IF NOT EXISTS idx_iptv_sources_failure_count
ON iptv_sources(failure_count);

-- Comment the columns for documentation
COMMENT ON COLUMN iptv_sources.failure_count IS 'Cumulative count of refresh failures for this source';
COMMENT ON COLUMN iptv_sources.last_failure_time IS 'Timestamp of the most recent refresh failure';
COMMENT ON COLUMN iptv_sources.last_successful_refresh IS 'Timestamp of last successful refresh';
COMMENT ON COLUMN iptv_sources.last_refresh_duration_ms IS 'Duration of last refresh in milliseconds';
COMMENT ON COLUMN iptv_sources.server_country IS 'Country where the IPTV server is located';
COMMENT ON COLUMN iptv_sources.server_city IS 'City where the IPTV server is located';
