-- Eliminate the enrichment-worker seqscan that was holding row-level
-- locks on movie_streams / series_sources for 20-30 seconds at a time
-- and stalling user-initiated deletes, refreshes, and new-source imports.
--
-- The worker's cross-source dedup runs:
--
--   UPDATE movie_streams SET movie_id = $1, updated_at = NOW()
--    WHERE id = $2 OR (
--      movie_id IS NULL
--      AND lower(regexp_replace(provider_name, '[^a-zA-Z0-9]+', '', 'g'))
--          LIKE $3
--    )
--
-- The `lower(regexp_replace(...))` expression isn't backed by any
-- index, so PG falls back to a seqscan over the entire table — every
-- row gets a row-level lock for the duration. With ~1.4M rows that's
-- ~30s per UPDATE. Concurrent INSERTs (VOD ingest), UPDATEs (other
-- enrichments) and cascade DELETEs (user deletes a source) all queue
-- behind it.
--
-- Fix: an expression index on the normalized name, scoped to rows
-- the worker can actually touch (movie_id IS NULL — once linked, the
-- row is no longer a candidate). text_pattern_ops makes the index
-- usable for LIKE 'prefix%' patterns, which is exactly what the
-- enrichment query does.
--
-- Plus IF NOT EXISTS so re-runs are safe and CONCURRENTLY so the
-- migration doesn't block the live workload while building.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movie_streams_provider_name_norm
    ON movie_streams (
      lower(regexp_replace(provider_name, '[^a-zA-Z0-9]+', '', 'g'))
        text_pattern_ops
    )
    WHERE movie_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_series_sources_provider_name_norm
    ON series_sources (
      lower(regexp_replace(provider_name, '[^a-zA-Z0-9]+', '', 'g'))
        text_pattern_ops
    )
    WHERE series_id IS NULL;
