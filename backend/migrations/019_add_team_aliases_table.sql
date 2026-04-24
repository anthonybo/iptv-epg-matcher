-- Canonical sports team registry used by the channel matcher.
--
-- Seed source: ESPN public teams API
--   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams
--
-- The matcher looks up rows by (league, home_team|away_team string) to
-- expand a live_events row into every known alias for the team so the
-- relevance scorer can match channels that use any of them — "LAFC",
-- "Los Angeles FC", "LA FC" all resolve to the same row.
--
-- manual_aliases holds anything ESPN doesn't expose (historical names,
-- user-curated short forms like "RBNY", regional naming quirks).

CREATE TABLE IF NOT EXISTS team_aliases (
  id                    SERIAL PRIMARY KEY,
  league                VARCHAR(64)  NOT NULL,   -- e.g. 'MLS', 'NFL', 'NHL'
  sport                 VARCHAR(64)  NOT NULL,   -- e.g. 'soccer', 'football'
  espn_team_id          VARCHAR(64),             -- nullable so manual rows still fit
  canonical_name        VARCHAR(255) NOT NULL,   -- preferred single label
  display_name          VARCHAR(255),            -- ESPN displayName
  short_display_name    VARCHAR(128),            -- ESPN shortDisplayName
  abbreviation          VARCHAR(32),             -- ESPN abbreviation
  nickname              VARCHAR(128),            -- ESPN nickname (mascot)
  location              VARCHAR(128),            -- ESPN location (city/region)
  slug                  VARCHAR(128),            -- ESPN slug
  logo_url              TEXT,
  manual_aliases        JSONB DEFAULT '[]'::jsonb,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ESPN uses the (league, espn_team_id) pair as its natural key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_aliases_league_espn
  ON team_aliases(league, espn_team_id);

-- The matcher's main lookup is by (league, lowercased-name); covering
-- both canonical and display names as fast equality lookups.
CREATE INDEX IF NOT EXISTS idx_team_aliases_league_canonical
  ON team_aliases(league, LOWER(canonical_name));
CREATE INDEX IF NOT EXISTS idx_team_aliases_league_display
  ON team_aliases(league, LOWER(display_name));

-- updated_at maintenance trigger (same pattern as other tables).
CREATE OR REPLACE FUNCTION team_aliases_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_team_aliases_updated_at ON team_aliases;
CREATE TRIGGER trg_team_aliases_updated_at
  BEFORE UPDATE ON team_aliases
  FOR EACH ROW
  EXECUTE FUNCTION team_aliases_set_updated_at();
