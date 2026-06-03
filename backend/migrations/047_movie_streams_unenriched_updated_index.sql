-- Migration: 047_movie_streams_unenriched_updated_index
-- Description: The VOD enrichment job repeatedly runs
--     SELECT ... FROM movie_streams WHERE movie_id IS NULL ORDER BY updated_at DESC NULLS LAST LIMIT N
--   which had no supporting index → parallel seq scan + sort over ~832k of
--   2.25M rows, measured at 40s up to ~10 MINUTES per run, every ~6 minutes.
--   That monster query saturates the DB and starves the user-facing
--   /api/vod/movies listing (page-load slowness).
--
--   A partial index on updated_at (WHERE movie_id IS NULL) turns it into a
--   cheap index scan that stops at LIMIT.
-- Date: 2026-06-02

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movie_streams_unenriched_updated
  ON movie_streams (updated_at DESC NULLS LAST)
  WHERE movie_id IS NULL;
