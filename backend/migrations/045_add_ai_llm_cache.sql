-- Migration: 045_add_ai_llm_cache
-- Description: Persistent cache for LLM responses so we don't re-query the
--              same stable facts over and over (and survive restarts /
--              share across instances, unlike an in-memory Map).
-- Date: 2026-06-01
--
-- First consumer: AI broadcaster resolution (services/ai/aiChannelMatcher).
-- "Which networks carry <league>?" is stable for a whole season, so it's
-- cached for days, not minutes. Generic by design (namespace column) so
-- other LLM lookups can reuse it.
--
-- cache_key  : namespaced key, e.g. 'broadcaster:racing|nascar cup'
-- namespace  : coarse bucket for pruning/inspection ('broadcaster', ...)
-- value      : JSONB payload (e.g. {"broadcasters":["FOX","FS1"]})
-- expires_at : hard TTL; rows past this are treated as a miss and pruned
-- hits       : how many times this cached value was served (telemetry)

CREATE TABLE IF NOT EXISTS ai_llm_cache (
  cache_key   TEXT          PRIMARY KEY,
  namespace   TEXT          NOT NULL,
  value       JSONB         NOT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TIMESTAMP     NOT NULL,
  hits        INTEGER       NOT NULL DEFAULT 0
);

-- Prune-by-namespace and freshness scans.
CREATE INDEX IF NOT EXISTS idx_ai_llm_cache_ns_exp
  ON ai_llm_cache(namespace, expires_at);
