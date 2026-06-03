-- Migration: 048_movie_streams_source_movieid_index
-- Description: The VOD /genres query (and any "which canonical movies does
--   this user have" lookup) must derive DISTINCT movie_id from movie_streams
--   scoped to the user's sources. With only a (movie_id) index it bitmap-
--   scanned ~204k rows and then HEAP-fetched every one to read source_id —
--   measured >90s. A covering partial index on (source_id, movie_id) lets
--   that dedup run index-only (no heap), turning /genres into a sub-second
--   query. Small index (~enriched rows only) so it builds quickly.
-- Date: 2026-06-02

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movie_streams_source_movieid
  ON movie_streams (source_id, movie_id)
  WHERE movie_id IS NOT NULL;
