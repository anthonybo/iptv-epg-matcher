-- Migration: 016_extend_epg_varchar_columns
-- Description: Extend varchar columns in EPG tables to prevent overflow errors
-- Date: 2025-12-05
--
-- Problem: Some EPG sources have very long channel IDs and program titles that
-- exceed the current VARCHAR(512) limits, causing "value too long" errors.
--
-- Solution: Extend id and title columns to TEXT (unlimited length)

-- ============================================================================
-- Extend epg_programs columns
-- ============================================================================

-- Change program ID from VARCHAR(512) to TEXT
-- This is safe because TEXT has no length limit
ALTER TABLE epg_programs
ALTER COLUMN id TYPE TEXT;

-- Change title from VARCHAR(512) to TEXT
-- Program titles from some sources can be very long
ALTER TABLE epg_programs
ALTER COLUMN title TYPE TEXT;

-- ============================================================================
-- Extend epg_channels columns
-- ============================================================================

-- Change channel ID from VARCHAR(255) to TEXT
-- Some sources have very verbose channel IDs
ALTER TABLE epg_channels
ALTER COLUMN id TYPE TEXT;

-- Change channel name from VARCHAR(512) to TEXT
ALTER TABLE epg_channels
ALTER COLUMN name TYPE TEXT;

-- ============================================================================
-- Update foreign key references if needed
-- PostgreSQL handles this automatically with ALTER TYPE
-- ============================================================================

-- Re-analyze tables after type changes
ANALYZE epg_programs;
ANALYZE epg_channels;
