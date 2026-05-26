-- 038: composite (source_id, updated_at DESC NULLS LAST, id DESC) index
-- on series_sources.
--
-- Background: /api/vod/series filters by `source_id IN (user's sources)`
-- and sorts by `MAX(updated_at) DESC`, then paginates. With only the
-- single-column `idx_series_sources_source_id` available, the planner
-- did a Seq Scan of all 300k rows + a 300k-row Sort to GROUP BY a
-- synthesized `COALESCE('s:'||sr.id, 'ss:'||ss.id)` expression. End
-- result: 4–6 seconds per request, and the frontend's no-cancel retry
-- behaviour piled multiple copies of that work onto the DB
-- concurrently, making everything worse.
--
-- The composite index lets the planner do an index range scan per
-- source_id with rows already ordered by recency, so the LATERAL "top
-- 50 per source" rewrite in the route can grab 76 × 50 = ~3800
-- candidates instead of scanning 300k.
--
-- DESC NULLS LAST mirrors the ORDER BY in the route. id DESC is a
-- stable tie-breaker so the cursor pagination stays deterministic when
-- multiple rows share the same updated_at.

CREATE INDEX IF NOT EXISTS idx_series_sources_source_recency
  ON series_sources (source_id, updated_at DESC NULLS LAST, id DESC);

ANALYZE series_sources;
