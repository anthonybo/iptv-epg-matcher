-- 039: composite (source_id, added_at DESC NULLS LAST, id DESC) index
-- on movie_streams.
--
-- Same shape as migration 038 (series_sources). The /api/vod/movies
-- default-load filters by `source_id IN (user's sources)` and sorts by
-- `MAX(added_at) DESC` then paginates. With 1.4M rows in movie_streams,
-- the original GROUP BY + ORDER BY was even worse than series — seq
-- scanning 1.4M rows and double-sorting to GROUP BY a synthesized
-- expression. Plus the movie-enrichment background job runs against
-- the same table, so the two contend constantly.
--
-- The composite index lets the planner do an index range scan per
-- source_id with rows already ordered by recency. Combined with the
-- LATERAL "top-K per source" rewrite in routes/vod.js, candidate pool
-- drops from 1.4M → ~3,800 (76 sources × 50 rows).

CREATE INDEX IF NOT EXISTS idx_movie_streams_source_added
  ON movie_streams (source_id, added_at DESC NULLS LAST, id DESC);

ANALYZE movie_streams;
