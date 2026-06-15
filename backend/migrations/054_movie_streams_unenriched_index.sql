-- Partial index for the VOD enrichment worker's hot query.
-- Migration: 054
-- Description: tmdbEnrichmentService runs, every tick,
--   SELECT id, provider_name, raw_meta FROM movie_streams
--    WHERE movie_id IS NULL ORDER BY updated_at DESC NULLS LAST LIMIT 50;
-- With no supporting index this is a full scan + sort of a large table, which
-- timed out (30s statement_timeout) every tick and thrashed the buffer cache —
-- evicting the channel-search table and making interactive search time out.
-- This partial index covers exactly the un-enriched backlog in the worker's
-- sort order, turning the query into a tiny index scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movie_streams_unenriched
  ON movie_streams (updated_at DESC NULLS LAST)
  WHERE movie_id IS NULL;
