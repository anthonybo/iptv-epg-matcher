-- Migration: Add performance indexes to epg_programs table
-- Date: 2025-11-19
-- Description: Add composite index for channel_id and time range queries to optimize guide view loading

-- Add composite index for channel + time range queries
-- This dramatically improves query performance for fetching programs by channel within a time window
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_epg_programs_channel_time
ON epg_programs(channel_id, start_time, stop_time);

-- Optional: Add index for time-only queries if needed in the future
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_epg_programs_time_range
-- ON epg_programs(start_time, stop_time) WHERE stop_time >= NOW();
