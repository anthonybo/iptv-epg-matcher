-- Migration: Create published_epg table for storing published IPTV EPG data
-- This replaces the static XMLTV file approach with a database-backed solution
-- Each user can have multiple credentials, and each credential has its own published EPG data

CREATE TABLE IF NOT EXISTS published_epg (
  id SERIAL PRIMARY KEY,
  credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Channel information
  iptv_channel_id VARCHAR(255) NOT NULL,
  epg_channel_id VARCHAR(255),
  channel_name VARCHAR(255),
  logo_url TEXT,

  -- Program information
  title TEXT,
  description TEXT,
  start_time TIMESTAMP NOT NULL,
  stop_time TIMESTAMP NOT NULL,
  categories TEXT,

  -- Metadata
  published_at TIMESTAMP DEFAULT NOW(),

  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_published_epg_credential ON published_epg(credential_id, start_time);
CREATE INDEX IF NOT EXISTS idx_published_epg_user ON published_epg(user_id);
CREATE INDEX IF NOT EXISTS idx_published_epg_time_range ON published_epg(start_time, stop_time);
CREATE INDEX IF NOT EXISTS idx_published_epg_channel ON published_epg(credential_id, iptv_channel_id, start_time);

-- Add comment for documentation
COMMENT ON TABLE published_epg IS 'Stores published EPG data for each user credential. Replaces static XMLTV files with database-backed storage for better performance and maintainability.';
