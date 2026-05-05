-- Migration: 023_add_iptv_channels_name_trgm_index
-- Description: Trigram GIN index on iptv_channels.name to make the
--              search-channel route's ILIKE pattern lookups index-
--              driven instead of sequential scans.
-- Date: 2026-05-04
--
-- The existing idx_iptv_channels_name (USING gin to_tsvector) only
-- helps full-text @@ to_tsquery queries — it does NOT help the
-- `c.name ILIKE '%pattern%'` queries the search-channel route runs
-- with 12+ OR'd terms ("Anaheim Ducks at Vegas Golden Knights" expands
-- to home/away aliases × broadcaster terms). Without a trigram index
-- those queries do a full table scan of iptv_channels, which logs
-- show taking 3+ minutes when the table is large and the DB is busy
-- with background services (scores updater, trending channels).
--
-- pg_trgm + GIN gives the planner a usable index for ILIKE patterns
-- ≥3 chars. CONCURRENTLY so the migration doesn't lock writers
-- during the build.

-- pg_trgm extension is already installed by migration 022; CREATE IF
-- NOT EXISTS here only as a safety net for environments that ran
-- migrations out of order.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_iptv_channels_name_trgm
  ON iptv_channels USING gin (name gin_trgm_ops);
