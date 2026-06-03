-- Migration: 044_add_ai_match_stats
-- Description: Append-only event log for AI-assisted live-event channel
--              matching. One row per AI call (picker or broadcaster
--              resolution) so the dashboard can prove the feature is
--              actually working: how often it runs, how often it changes
--              the outcome vs. plain scoring, agreement rate, latency, and
--              error/rate-limit rate.
-- Date: 2026-06-01
--
-- Why an event log (not an aggregate UPSERT like broadcaster_match_stats):
--   AI calls are low-frequency (≤1 per user search, broadcaster lookups
--   are cached per league), so volume is small and an append-only log
--   gives us BOTH aggregates (COUNT/AVG/FILTER) and a "recent decisions"
--   feed for the dashboard. Old rows can be pruned on a schedule later.
--
-- feature      : 'picker'      — re-ranked/filtered scored candidates
--                'broadcaster' — resolved which networks carry the event
-- outcome      : 'ok'          — AI returned a usable answer
--                'llm_null'    — all providers rate-limited / empty
--                'error'       — exception during the call
--                'not_ready'   — LLM not configured / no providers
--                'no_candidates' / 'cache_hit'
-- changed_outcome : AI changed the #1 candidate vs. pure scoring (picker)
-- agreed          : AI's top pick equalled the scoring top pick
-- top_choice      : channel id (picker) or comma-joined networks (broadcaster)
-- confidence      : AI confidence for its top pick (0..1), nullable

CREATE TABLE IF NOT EXISTS ai_match_stats (
  id              BIGSERIAL     PRIMARY KEY,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  feature         TEXT          NOT NULL,
  event_id        TEXT,
  sport_type      VARCHAR(100),
  league_name     VARCHAR(255),
  query           TEXT,
  candidates      INTEGER       NOT NULL DEFAULT 0,
  latency_ms      INTEGER,
  outcome         TEXT          NOT NULL,
  changed_outcome BOOLEAN,
  agreed          BOOLEAN,
  top_choice      TEXT,
  confidence      REAL
);

-- Recent-decisions feed (dashboard) + time-window aggregates.
CREATE INDEX IF NOT EXISTS idx_ai_match_stats_created
  ON ai_match_stats(created_at DESC);

-- Per-feature aggregates without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_ai_match_stats_feature
  ON ai_match_stats(feature, created_at DESC);
