-- Migration: 003_add_live_events_table
-- Description: Create live_events table for sports events tracking
-- Date: 2025-11-15

-- ============================================================================
-- Live Events Table
-- ============================================================================
-- This table stores live sports events data from external APIs (TheSportsDB, ESPN, etc.)

CREATE TABLE IF NOT EXISTS live_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(255) UNIQUE NOT NULL,  -- External API event ID
    event_name TEXT NOT NULL,                -- Event title (e.g., "Team A vs Team B")
    sport_type VARCHAR(100),                 -- Sport category (e.g., "Soccer", "Basketball")
    league_name VARCHAR(255),                -- League (e.g., "NFL", "Premier League")
    home_team VARCHAR(255),                  -- Home team name
    away_team VARCHAR(255),                  -- Away team name
    event_start TIMESTAMP NOT NULL,          -- Event start time (UTC)
    event_end TIMESTAMP,                     -- Event end time (UTC) - can be NULL
    source VARCHAR(100) NOT NULL,            -- Data source (e.g., "thesportsdb", "espn")
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Indexes for Performance
-- ============================================================================

-- Index for fast lookups by time range
CREATE INDEX IF NOT EXISTS idx_live_events_start ON live_events(event_start);
CREATE INDEX IF NOT EXISTS idx_live_events_end ON live_events(event_end);
CREATE INDEX IF NOT EXISTS idx_live_events_times ON live_events(event_start, event_end);

-- Index for event_id lookups
CREATE INDEX IF NOT EXISTS idx_live_events_event_id ON live_events(event_id);

-- Index for sport type filtering
CREATE INDEX IF NOT EXISTS idx_live_events_sport_type ON live_events(sport_type);

-- ============================================================================
-- Trigger for Auto-updating updated_at
-- ============================================================================

CREATE TRIGGER update_live_events_updated_at
    BEFORE UPDATE ON live_events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
