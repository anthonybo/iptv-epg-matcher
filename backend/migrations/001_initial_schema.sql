-- IPTV Guru - PostgreSQL Initial Schema
-- Migration: 001
-- Description: Create initial database schema for IPTV Guru

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Users Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- IPTV Sources Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS iptv_sources (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('m3u', 'xtream', 'stalker')),
    url TEXT NOT NULL,
    username VARCHAR(255),
    password VARCHAR(255),
    mac_address VARCHAR(17),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_refreshed TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_iptv_sources_user_id ON iptv_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_iptv_sources_session_id ON iptv_sources(session_id);
CREATE INDEX IF NOT EXISTS idx_iptv_sources_type ON iptv_sources(type);

-- Unique constraint: prevent duplicate sources per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_iptv_sources_unique_with_username
    ON iptv_sources(user_id, type, url, COALESCE(username, ''))
    WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_iptv_sources_unique_without_username
    ON iptv_sources(user_id, type, url)
    WHERE username IS NULL;

CREATE TRIGGER update_iptv_sources_updated_at
    BEFORE UPDATE ON iptv_sources
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- IPTV Channels Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS iptv_channels (
    id SERIAL PRIMARY KEY,
    channel_id VARCHAR(255) UNIQUE NOT NULL,  -- e.g., "xtream_12345", "stalker_67890"
    source_id INTEGER REFERENCES iptv_sources(id) ON DELETE CASCADE,
    name VARCHAR(500) NOT NULL,
    stream_url TEXT,
    logo_url TEXT,
    category VARCHAR(255),
    tvg_id VARCHAR(255),
    tvg_name VARCHAR(500),
    group_title VARCHAR(255),
    source_type VARCHAR(50),
    source_username VARCHAR(255),
    source_password VARCHAR(255),
    source_url TEXT,
    source_mac VARCHAR(17),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_iptv_channels_source_id ON iptv_channels(source_id);
CREATE INDEX IF NOT EXISTS idx_iptv_channels_channel_id ON iptv_channels(channel_id);
CREATE INDEX IF NOT EXISTS idx_iptv_channels_name ON iptv_channels USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_iptv_channels_category ON iptv_channels(category);
CREATE INDEX IF NOT EXISTS idx_iptv_channels_tvg_id ON iptv_channels(tvg_id);

CREATE TRIGGER update_iptv_channels_updated_at
    BEFORE UPDATE ON iptv_channels
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- EPG Matches Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS epg_matches (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    iptv_channel_id VARCHAR(255) NOT NULL,
    epg_channel_id VARCHAR(255) NOT NULL,
    use_dummy_epg BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, iptv_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_epg_matches_session_id ON epg_matches(session_id);
CREATE INDEX IF NOT EXISTS idx_epg_matches_user_id ON epg_matches(user_id);
CREATE INDEX IF NOT EXISTS idx_epg_matches_iptv_channel_id ON epg_matches(iptv_channel_id);
CREATE INDEX IF NOT EXISTS idx_epg_matches_epg_channel_id ON epg_matches(epg_channel_id);

CREATE TRIGGER update_epg_matches_updated_at
    BEFORE UPDATE ON epg_matches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- User EPG Sources Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_epg_sources (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_refreshed TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_epg_sources_user_id ON user_epg_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_user_epg_sources_session_id ON user_epg_sources(session_id);
CREATE INDEX IF NOT EXISTS idx_user_epg_sources_enabled ON user_epg_sources(enabled);

CREATE TRIGGER update_user_epg_sources_updated_at
    BEFORE UPDATE ON user_epg_sources
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Credentials Table (for generated XTREAM credentials)
-- ============================================================================
CREATE TABLE IF NOT EXISTS credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    last_used TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_credentials_session_id ON credentials(session_id);
CREATE INDEX IF NOT EXISTS idx_credentials_username ON credentials(username);
CREATE INDEX IF NOT EXISTS idx_credentials_status ON credentials(status);

CREATE TRIGGER update_credentials_updated_at
    BEFORE UPDATE ON credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Migration Metadata Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    version VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES ('001', 'Initial schema creation')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- Helpful Views
-- ============================================================================

-- View: User channel count
CREATE OR REPLACE VIEW user_channel_counts AS
SELECT
    u.id as user_id,
    u.username,
    COUNT(DISTINCT c.id) as channel_count,
    COUNT(DISTINCT s.id) as source_count
FROM users u
LEFT JOIN iptv_sources s ON s.user_id = u.id
LEFT JOIN iptv_channels c ON c.source_id = s.id
GROUP BY u.id, u.username;

-- View: Matched channels summary
CREATE OR REPLACE VIEW matched_channels_summary AS
SELECT
    m.session_id,
    m.user_id,
    COUNT(*) as total_matches,
    COUNT(*) FILTER (WHERE m.use_dummy_epg = true) as dummy_matches,
    COUNT(*) FILTER (WHERE m.use_dummy_epg = false) as real_matches
FROM epg_matches m
GROUP BY m.session_id, m.user_id;

-- ============================================================================
-- Cleanup old test data (optional)
-- ============================================================================

-- This can be uncommented to remove test data
-- DELETE FROM epg_matches WHERE session_id LIKE 'test%';
-- DELETE FROM iptv_channels WHERE source_id IN (SELECT id FROM iptv_sources WHERE session_id LIKE 'test%');
-- DELETE FROM iptv_sources WHERE session_id LIKE 'test%';

COMMENT ON TABLE users IS 'Application users (authenticated accounts)';
COMMENT ON TABLE iptv_sources IS 'IPTV source configurations (M3U, XTREAM, Stalker)';
COMMENT ON TABLE iptv_channels IS 'Channels from all IPTV sources';
COMMENT ON TABLE epg_matches IS 'Matches between IPTV channels and EPG channels';
COMMENT ON TABLE user_epg_sources IS 'User-added EPG sources';
COMMENT ON TABLE credentials IS 'Generated XTREAM API credentials';
