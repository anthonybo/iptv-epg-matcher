-- Migration: 015_add_live_scores_columns
-- Description: Add live scores columns to live_events table for real-time score tracking
-- Date: 2025-12-04

-- ============================================================================
-- Add Score Columns to live_events
-- ============================================================================
-- Instead of a separate table, we add score columns directly to live_events
-- This makes queries simpler and avoids joins

-- Home team score
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS home_score INTEGER;

-- Away team score
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS away_score INTEGER;

-- Game status (e.g., "1st Quarter", "Halftime", "Final", "In Progress", "Not Started")
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS game_status VARCHAR(100);

-- Game clock/period info (e.g., "Q2 5:30", "2nd Half", "Top 7th")
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS game_clock VARCHAR(50);

-- Detailed status from ESPN (e.g., "STATUS_SCHEDULED", "STATUS_IN_PROGRESS", "STATUS_FINAL")
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS status_type VARCHAR(50);

-- Is the game currently in progress?
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS is_live BOOLEAN DEFAULT FALSE;

-- Last time scores were updated (separate from row updated_at)
ALTER TABLE live_events ADD COLUMN IF NOT EXISTS scores_updated_at TIMESTAMP;

-- ============================================================================
-- Index for Live Score Queries
-- ============================================================================

-- Index for finding all currently live games
CREATE INDEX IF NOT EXISTS idx_live_events_is_live ON live_events(is_live) WHERE is_live = TRUE;

-- Composite index for live games by sport (common query pattern)
CREATE INDEX IF NOT EXISTS idx_live_events_sport_live ON live_events(sport_type, is_live) WHERE is_live = TRUE;
