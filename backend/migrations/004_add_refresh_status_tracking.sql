-- Migration: 004_add_refresh_status_tracking
-- Description: Add columns to track last refresh status for each IPTV source
-- Date: 2025-11-15

-- ============================================================================
-- Add Refresh Status Tracking to IPTV Sources
-- ============================================================================

-- Add last_refresh_status column (success, error, or null for never refreshed)
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS last_refresh_status VARCHAR(20);

-- Add last_refresh_error column to store error messages
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS last_refresh_error TEXT;

-- Add last_refresh_time column (different from last_refreshed which is when channels were loaded)
ALTER TABLE iptv_sources
ADD COLUMN IF NOT EXISTS last_refresh_attempt TIMESTAMP;

-- Add index for filtering by status
CREATE INDEX IF NOT EXISTS idx_iptv_sources_refresh_status
ON iptv_sources(last_refresh_status);

-- Comment the columns for documentation
COMMENT ON COLUMN iptv_sources.last_refresh_status IS 'Status of last refresh attempt: success, error, or null';
COMMENT ON COLUMN iptv_sources.last_refresh_error IS 'Error message from last failed refresh attempt';
COMMENT ON COLUMN iptv_sources.last_refresh_attempt IS 'Timestamp of last refresh attempt (success or failure)';
