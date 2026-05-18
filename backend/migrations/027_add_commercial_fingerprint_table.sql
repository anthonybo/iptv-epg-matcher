-- Add commercial_fingerprint table to PostgreSQL
-- Migration: 027
-- Description: Per-user, per-channel hotlist of audio fingerprints
-- captured at confirmed commercial-break boundaries. Each row is one
-- break worth of 32-bit signatures (one signature per ~250ms of audio).
--
-- Storage shape: `fingerprint` is BYTEA holding a packed little-endian
-- Uint32Array. A 30-second commercial = ~120 signatures = 480 bytes.
-- Cheap to send over the wire, cheap to compare in-memory with
-- Hamming-distance scoring.
--
-- Auto-pruning is performed in the application layer (oldest rows
-- dropped first when a per-user budget is exceeded).

CREATE TABLE IF NOT EXISTS commercial_fingerprint (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id VARCHAR(255) NOT NULL,
    fingerprint BYTEA NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commercial_fingerprint_user_channel
    ON commercial_fingerprint(user_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_commercial_fingerprint_user_captured
    ON commercial_fingerprint(user_id, captured_at DESC);
