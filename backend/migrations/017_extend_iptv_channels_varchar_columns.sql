-- Migration: 017_extend_iptv_channels_varchar_columns
-- Description: Extend varchar columns in iptv_channels to prevent overflow errors
-- Date: 2026-04-21
--
-- Problem: Some Xtream providers return channel names that embed ad/tracking URLs
-- (e.g. "RMF MAXX https://...?aw_0_req.gdpr=true&..."), producing names longer
-- than 500 chars. This causes "value too long for type character varying(500)"
-- errors during refresh-account-info, which kills the entire source save.
--
-- Solution: Extend name and tvg_name columns to TEXT (unlimited length),
-- mirroring what migration 016 did for the EPG tables.

ALTER TABLE iptv_channels
ALTER COLUMN name TYPE TEXT;

ALTER TABLE iptv_channels
ALTER COLUMN tvg_name TYPE TEXT;

ANALYZE iptv_channels;
