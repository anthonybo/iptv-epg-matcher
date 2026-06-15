-- Migration: 052_channels_search_name_trgm
-- Description: Trigram GIN index on iptv_channels_search.name so the
--   multiview channel picker's substring search (name ILIKE '%query%',
--   added 2026-06-12) is index-backed instead of a full scan of the
--   user's channels. For the heaviest account (~911k rows) a bare ILIKE
--   took ~3.8s; with this index it drops to <100ms. pg_trgm's
--   gin_trgm_ops supports both LIKE and ILIKE.
-- MUST run non-transactionally (CREATE INDEX CONCURRENTLY cannot run in a
--   transaction block) — use scripts/run_migration_052.js, which issues
--   each statement on a dedicated connection with statement_timeout = 0.
-- Date: 2026-06-12

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_iptv_channels_search_name_trgm
  ON iptv_channels_search USING gin (name gin_trgm_ops);
