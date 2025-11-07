-- Create live_events table to store live sports events data
-- This table is populated from external APIs (TheSportsDB, ESPN, etc.)

CREATE TABLE IF NOT EXISTS live_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,        -- External API event ID
  event_name TEXT NOT NULL,              -- Event title (e.g., "Team A vs Team B")
  sport_type TEXT,                       -- Sport category (e.g., "Soccer", "Basketball")
  league_name TEXT,                      -- League (e.g., "NFL", "Premier League")
  home_team TEXT,                        -- Home team name
  away_team TEXT,                        -- Away team name
  event_start DATETIME NOT NULL,         -- Event start time (UTC)
  event_end DATETIME,                    -- Event end time (UTC) - can be NULL
  source TEXT NOT NULL,                  -- Data source (e.g., "thesportsdb", "espn")
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups by time range
CREATE INDEX IF NOT EXISTS idx_live_events_start ON live_events(event_start);
CREATE INDEX IF NOT EXISTS idx_live_events_end ON live_events(event_end);
CREATE INDEX IF NOT EXISTS idx_live_events_times ON live_events(event_start, event_end);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_live_events_timestamp
AFTER UPDATE ON live_events
BEGIN
  UPDATE live_events SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
