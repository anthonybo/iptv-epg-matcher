-- Metrics tables, migrated from the legacy sqlite metrics DB to
-- Postgres so the whole app runs on one store. Schema mirrors
-- migrations/create_metrics_tables.sql with two deliberate type
-- changes for Postgres correctness:
--
--   * Unix-millisecond timestamps (Date.now() ≈ 1.78e12) and byte /
--     bps counters EXCEED PG's 32-bit INTEGER (max ~2.1e9). sqlite's
--     dynamic typing stored them fine; in PG they MUST be BIGINT or
--     they'd overflow. Every *_time / timestamp / *_seen / byte /
--     bps column is BIGINT here.
--   * AUTOINCREMENT → BIGSERIAL; REAL → DOUBLE PRECISION;
--     BOOLEAN DEFAULT 1 → BOOLEAN DEFAULT TRUE.

CREATE TABLE IF NOT EXISTS metrics_streams (
  id                BIGSERIAL PRIMARY KEY,
  stream_key        TEXT NOT NULL UNIQUE,
  channel_name      TEXT,
  channel_id        TEXT,
  source_name       TEXT,
  source_id         INTEGER,
  stream_type       TEXT,
  user_name         TEXT,
  user_id           INTEGER,
  client_ip         TEXT,
  start_time        BIGINT NOT NULL,
  end_time          BIGINT,
  duration_seconds  INTEGER,
  bytes_transferred BIGINT DEFAULT 0,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_start_time  ON metrics_streams(start_time);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_user_id     ON metrics_streams(user_id);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_stream_type ON metrics_streams(stream_type);
CREATE INDEX IF NOT EXISTS idx_metrics_streams_end_time    ON metrics_streams(end_time);

CREATE TABLE IF NOT EXISTS metrics_bandwidth (
  id                   BIGSERIAL PRIMARY KEY,
  timestamp            BIGINT NOT NULL,
  upload_bps           BIGINT DEFAULT 0,
  download_bps         BIGINT DEFAULT 0,
  upload_mbps          DOUBLE PRECISION DEFAULT 0,
  download_mbps        DOUBLE PRECISION DEFAULT 0,
  total_sent_bytes     BIGINT DEFAULT 0,
  total_received_bytes BIGINT DEFAULT 0,
  active_streams       INTEGER DEFAULT 0,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_metrics_bandwidth_timestamp ON metrics_bandwidth(timestamp);

CREATE TABLE IF NOT EXISTS metrics_requests (
  id                  BIGSERIAL PRIMARY KEY,
  timestamp           BIGINT NOT NULL,
  total_requests      INTEGER DEFAULT 0,
  successful_requests INTEGER DEFAULT 0,
  failed_requests     INTEGER DEFAULT 0,
  requests_per_minute INTEGER DEFAULT 0,
  error_rate          DOUBLE PRECISION DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_metrics_requests_timestamp ON metrics_requests(timestamp);

CREATE TABLE IF NOT EXISTS metrics_system (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       BIGINT NOT NULL,
  memory_used_mb  INTEGER,
  memory_total_mb INTEGER,
  memory_percent  DOUBLE PRECISION,
  heap_used_mb    INTEGER,
  heap_total_mb   INTEGER,
  uptime_seconds  INTEGER,
  nodejs_version  TEXT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_metrics_system_timestamp ON metrics_system(timestamp);

CREATE TABLE IF NOT EXISTS metrics_sessions (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL,
  user_id      INTEGER,
  user_name    TEXT,
  current_page TEXT,
  client_ip    TEXT,
  user_agent   TEXT,
  first_seen   BIGINT NOT NULL,
  last_seen    BIGINT NOT NULL,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_session_id ON metrics_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_user_id    ON metrics_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_is_active  ON metrics_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_metrics_sessions_last_seen  ON metrics_sessions(last_seen);

CREATE TABLE IF NOT EXISTS metrics_page_views (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL,
  user_id          INTEGER,
  page             TEXT NOT NULL,
  timestamp        BIGINT NOT NULL,
  duration_seconds INTEGER,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_metrics_page_views_session_id ON metrics_page_views(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_page_views_page       ON metrics_page_views(page);
CREATE INDEX IF NOT EXISTS idx_metrics_page_views_timestamp  ON metrics_page_views(timestamp);
