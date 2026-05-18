-- Add channel_commercial_profile table for commercial auto-skip
-- Migration: 026
-- Description: Per-user, per-channel learned profile for commercial
-- detection. Holds the logo ROI + perceptual hash, the calibrated
-- silence/loudness thresholds, and false-positive counters that the
-- detector reads back to adjust its own sensitivity over time.
--
-- Keyed by (user_id, channel_id) so the same channel can have a
-- different profile per user — useful when one user's source serves
-- a re-encoded variant of the channel.

CREATE TABLE IF NOT EXISTS channel_commercial_profile (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id VARCHAR(255) NOT NULL,
    channel_name VARCHAR(255),

    -- Phase-2 visual calibration. logo_roi is a normalized rect
    -- (0..1 coords) so it adapts to any resolution; null until the
    -- auto-calibrator finds a stable bug.
    logo_roi JSONB,                       -- { x, y, w, h, corner }
    logo_dhash VARCHAR(32),               -- 64-bit dHash as 16 hex chars
    logo_hamming_threshold INTEGER NOT NULL DEFAULT 12,  -- 0..64; higher = looser match

    -- Phase-1 audio thresholds. Defaults are conservative and get
    -- nudged on each false-positive learning event.
    silence_threshold REAL NOT NULL DEFAULT 0.6,    -- 0..1, fraction-of-time below silence_dbfs
    silence_dbfs REAL NOT NULL DEFAULT -42.0,        -- raw silence floor in dBFS
    loudness_delta_lu REAL NOT NULL DEFAULT 3.0,    -- step-up in LU that signals a break

    -- Tracked stats. These let us tune over time AND expose health
    -- info in the settings UI ("Reelz: 23 detections, 2 false
    -- positives this week").
    detection_count INTEGER NOT NULL DEFAULT 0,
    false_positive_count INTEGER NOT NULL DEFAULT 0,
    last_detected_at TIMESTAMP,
    last_false_positive_at TIMESTAMP,
    calibrated_at TIMESTAMP,
    -- 60s ignore window after a confirmed FP; the detector skips
    -- this channel until ignore_until passes.
    ignore_until TIMESTAMP,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_commercial_profile_user
    ON channel_commercial_profile(user_id);
