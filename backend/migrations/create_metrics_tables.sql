-- Metrics Database Schema
-- Stores historical metrics data for debugging and analysis

-- Stream sessions tracking
CREATE TABLE IF NOT EXISTS metrics_streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_key TEXT NOT NULL UNIQUE,
  channel_name TEXT,
  channel_id TEXT,
  source_name TEXT,
  source_id INTEGER,
  stream_type TEXT, -- 'stream', 'xtream_api', 'xtream_direct', 'xtream'
  user_name TEXT,
  user_id INTEGER,
  client_ip TEXT,
  start_time INTEGER NOT NULL, -- Unix timestamp
  end_time INTEGER, -- NULL if still active
  duration_seconds INTEGER, -- Calculated on end
  bytes_transferred INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_streams_start_time ON metrics_streams(start_time);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_user_id ON metrics_streams(user_id);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_stream_type ON metrics_streams(stream_type);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_end_time ON metrics_streams(end_time);

-- Time-series bandwidth data (sampled every 5 seconds)
CREATE TABLE IF NOT EXISTS metrics_bandwidth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL, -- Unix timestamp
  upload_bps INTEGER DEFAULT 0, -- Bytes per second
  download_bps INTEGER DEFAULT 0,
  upload_mbps REAL DEFAULT 0,
  download_mbps REAL DEFAULT 0,
  total_sent_bytes INTEGER DEFAULT 0,
  total_received_bytes INTEGER DEFAULT 0,
  active_streams INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_bandwidth_timestamp ON metrics_bandwidth(timestamp);

-- Time-series request data (sampled every 5 seconds)
CREATE TABLE IF NOT EXISTS metrics_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  total_requests INTEGER DEFAULT 0,
  successful_requests INTEGER DEFAULT 0,
  failed_requests INTEGER DEFAULT 0,
  requests_per_minute INTEGER DEFAULT 0,
  error_rate REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_requests_timestamp ON metrics_requests(timestamp);

-- Time-series system metrics (sampled every 5 seconds)
CREATE TABLE IF NOT EXISTS metrics_system (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  memory_used_mb INTEGER,
  memory_total_mb INTEGER,
  memory_percent REAL,
  heap_used_mb INTEGER,
  heap_total_mb INTEGER,
  uptime_seconds INTEGER,
  nodejs_version TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_system_timestamp ON metrics_system(timestamp);

-- Active user sessions and page tracking
CREATE TABLE IF NOT EXISTS metrics_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  current_page TEXT,
  client_ip TEXT,
  user_agent TEXT,
  first_seen INTEGER NOT NULL, -- Unix timestamp
  last_seen INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_sessions_session_id ON metrics_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_user_id ON metrics_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_is_active ON metrics_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_last_seen ON metrics_sessions(last_seen);

-- Page view tracking
CREATE TABLE IF NOT EXISTS metrics_page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER,
  page TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  duration_seconds INTEGER, -- Time spent on page (calculated when leaving)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_page_views_session_id ON metrics_page_views(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_page_views_page ON metrics_page_views(page);
CREATE INDEX IF NOT EXISTS idx_metrics_page_views_timestamp ON metrics_page_views(timestamp);
