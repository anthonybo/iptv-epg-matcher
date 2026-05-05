-- Migration: 024_add_broadcaster_match_stats
-- Description: Track which ESPN broadcaster codes are showing up in
--              find-channel searches and how often they actually
--              resolve to a working IPTV channel via the alias table.
-- Date: 2026-05-04
--
-- The end goal is an evidence-based "what aliases to add" list. Each
-- row is one (broadcaster_code, sport, league) tuple — incremented
-- in place every time a search runs that mentioned this code. We
-- track:
--   - search_count        : total appearances
--   - match_via_this_count: search succeeded AND the winning channel's
--                           broadcasterMatched alias was an expansion of
--                           this code (the code "earned" the match)
--   - match_via_other_count: search succeeded but a different signal
--                            won (team name, EPG, different broadcaster)
--   - fail_count          : search exhausted with no working channel
--   - alias_count         : number of substrings broadcasterAliases.js
--                           expanded this code into (0 = passed through
--                           verbatim — almost certainly an unaliased
--                           code worth investigating)
--
-- Querying "what's broken":
--   SELECT broadcaster_code, sport_type, league_name,
--          search_count, fail_count,
--          (fail_count::float / NULLIF(search_count, 0))::numeric(4,2) AS fail_rate,
--          alias_count, last_seen
--     FROM broadcaster_match_stats
--    WHERE search_count >= 3
--    ORDER BY fail_count DESC, fail_rate DESC;

CREATE TABLE IF NOT EXISTS broadcaster_match_stats (
  broadcaster_code        TEXT          NOT NULL,
  sport_type              VARCHAR(100),
  league_name             VARCHAR(255),
  alias_count             INTEGER       NOT NULL DEFAULT 0,
  search_count            INTEGER       NOT NULL DEFAULT 0,
  match_via_this_count    INTEGER       NOT NULL DEFAULT 0,
  match_via_other_count   INTEGER       NOT NULL DEFAULT 0,
  fail_count              INTEGER       NOT NULL DEFAULT 0,
  first_seen              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen               TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Composite PK on (code, sport, league) — same code can behave very
  -- differently across leagues (e.g. ESPN+ for college baseball vs.
  -- ESPN+ for La Liga), so split stats per league.
  PRIMARY KEY (broadcaster_code, sport_type, league_name)
);

CREATE INDEX IF NOT EXISTS idx_broadcaster_stats_last_seen
  ON broadcaster_match_stats(last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_broadcaster_stats_fail
  ON broadcaster_match_stats(fail_count DESC) WHERE fail_count > 0;
