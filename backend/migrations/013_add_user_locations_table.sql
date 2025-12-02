-- Migration: 013
-- Description: Add user_locations table for local news feature

-- ============================================================================
-- User Locations Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_locations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    state_abbrev VARCHAR(10),  -- e.g., "CA", "NY"
    is_auto_detected BOOLEAN DEFAULT FALSE,
    is_current BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, city, state)  -- No duplicate city/state combos per user
);

CREATE INDEX IF NOT EXISTS idx_user_locations_user_id ON user_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_locations_is_current ON user_locations(is_current);

-- Trigger to automatically update updated_at
CREATE TRIGGER update_user_locations_updated_at
    BEFORE UPDATE ON user_locations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES ('013', 'Add user_locations table for local news feature')
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE user_locations IS 'User saved locations for local news search';
COMMENT ON COLUMN user_locations.is_auto_detected IS 'True if location was detected via IP geolocation';
COMMENT ON COLUMN user_locations.is_current IS 'True if this is the currently selected location';
