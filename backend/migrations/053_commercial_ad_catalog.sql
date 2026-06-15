-- Commercial ad-creative catalog (shared, cross-channel).
-- Migration: 053
-- Description: A self-bootstrapping catalog of repeated ad CREATIVES, built
-- from Shazam-style landmark fingerprints. Unlike migration 027 (per-user,
-- per-channel hotlist seeded only at confirmed break boundaries — which had a
-- cold-start deadlock), this catalog is GLOBAL and is filled automatically by
-- cross-channel repetition: when the same audio fingerprint sequence recurs
-- across enough concurrently-monitored channels/programs, it is flagged as an
-- ad creative and catalogued. Future live audio is then matched against this
-- catalog for a high-precision "this channel is in an ad" verdict.
--
--   commercial_ad_creatives     — one row per distinct ad creative
--   commercial_ad_fingerprints  — landmark fingerprints belonging to a creative
--
-- `creative_key` dedupes creatives (stable hash over the fingerprint set), so
-- re-discovering the same ad just bumps hit_count/last_seen instead of
-- inserting a duplicate.

CREATE TABLE IF NOT EXISTS commercial_ad_creatives (
    id           BIGSERIAL PRIMARY KEY,
    creative_key TEXT NOT NULL UNIQUE,            -- stable dedupe key over the fingerprint set
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    hit_count    INTEGER NOT NULL DEFAULT 1,      -- times this creative was observed (cross-channel/program)
    label        TEXT,                            -- optional human label (e.g. brand)
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per landmark fingerprint of a creative. `t` is the frame offset
-- WITHIN the creative (codegen frame index, ~11.6ms per frame), so a query
-- can be aligned against the stored creative via an offset histogram.
CREATE TABLE IF NOT EXISTS commercial_ad_fingerprints (
    creative_id  BIGINT NOT NULL REFERENCES commercial_ad_creatives(id) ON DELETE CASCADE,
    hcode        INTEGER NOT NULL,                -- landmark hash
    t            INTEGER NOT NULL                 -- frame offset within the creative
);

-- hcode is the lookup key for matching incoming audio against the catalog.
CREATE INDEX IF NOT EXISTS idx_ad_fingerprints_hcode
    ON commercial_ad_fingerprints(hcode);
CREATE INDEX IF NOT EXISTS idx_ad_fingerprints_creative
    ON commercial_ad_fingerprints(creative_id);
CREATE INDEX IF NOT EXISTS idx_ad_creatives_last_seen
    ON commercial_ad_creatives(last_seen DESC);
