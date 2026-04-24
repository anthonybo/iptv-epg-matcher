/**
 * Team alias registry — backs the sports-event → channel matcher.
 *
 * Aliases are seeded from ESPN's public teams endpoint per league:
 *   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams
 *
 * The matcher calls `getAliasesForTeam(leagueName, teamName)` with the
 * string that came off the live_events row (e.g. "Colorado Rapids", MLS)
 * and gets back the alias bundle: displayName, shortDisplayName,
 * abbreviation, nickname, location, slug, manual_aliases — plus sport
 * and league for cross-sport disambiguation.
 *
 * Adding a new league = adding an entry to SPORT_LEAGUES + running the
 * seed script.
 */

const axios = require('axios');
const logger = require('../config/logger');
const postgresService = require('./postgresService');

const ESPN_BASE_URL = 'http://site.api.espn.com/apis/site/v2/sports';

// Sport / league pairs we import from ESPN. The URL segments match the
// ESPN path convention (`/sports/{sport}/{league}/teams`). Keep this
// list alongside the seeds we actually use — no point pulling a league
// we'll never see in live_events.
const SPORT_LEAGUES = [
  { sport: 'soccer', league: 'usa.1',              internalLeague: 'MLS' },
  { sport: 'soccer', league: 'eng.1',              internalLeague: 'Premier League' },
  { sport: 'soccer', league: 'esp.1',              internalLeague: 'La Liga' },
  { sport: 'soccer', league: 'ger.1',              internalLeague: 'Bundesliga' },
  { sport: 'soccer', league: 'ita.1',              internalLeague: 'Serie A' },
  { sport: 'soccer', league: 'fra.1',              internalLeague: 'Ligue 1' },
  { sport: 'soccer', league: 'uefa.champions',     internalLeague: 'Champions League' },
  { sport: 'soccer', league: 'uefa.europa',        internalLeague: 'Europa League' },
  { sport: 'soccer', league: 'mex.1',              internalLeague: 'Liga MX' },
  { sport: 'basketball', league: 'nba',            internalLeague: 'NBA' },
  { sport: 'basketball', league: 'wnba',           internalLeague: 'WNBA' },
  { sport: 'basketball', league: 'mens-college-basketball', internalLeague: 'NCAA Basketball' },
  { sport: 'football', league: 'nfl',              internalLeague: 'NFL' },
  { sport: 'football', league: 'college-football', internalLeague: 'NCAA Football' },
  { sport: 'hockey', league: 'nhl',                internalLeague: 'NHL' },
  { sport: 'baseball', league: 'mlb',              internalLeague: 'MLB' }
];

// Aliases ESPN doesn't give us but that show up in IPTV channel names.
// Keyed by (internalLeague, ESPN displayName). Each value is a list of
// additional lowercase strings the matcher should recognise. Keep the
// list conservative — overly generic aliases ("United", "City", "Sporting")
// cause more false positives than they solve.
const MANUAL_ALIASES = {
  MLS: {
    'LAFC':                    ['Los Angeles FC', 'LA FC'],
    'LA Galaxy':               ['Galaxy', 'LAG', 'Los Angeles Galaxy'],
    'New York City FC':        ['NYCFC', 'NYC FC'],
    'New York Red Bulls':      ['NYRB', 'RBNY', 'Red Bulls', 'Red Bull New York'],
    'D.C. United':             ['DC United', 'DCU'],
    'Real Salt Lake':          ['RSL', 'Salt Lake'],
    'FC Cincinnati':           ['Cincinnati', 'FCC'],
    'Inter Miami CF':          ['Inter Miami', 'IMCF'],
    'Sporting Kansas City':    ['Sporting KC', 'SKC'],
    'St. Louis CITY SC':       ['St. Louis City', 'CITY SC', 'STL City', 'St Louis City'],
    'CF Montréal':             ['CF Montreal', 'Montreal Impact', 'Impact'],
    'Portland Timbers':        ['Timbers'],
    'Seattle Sounders FC':     ['Sounders', 'Seattle Sounders'],
    'Houston Dynamo FC':       ['Dynamo', 'Houston Dynamo'],
    'Charlotte FC':            ['Charlotte FC'],
    'Nashville SC':            ['Nashville SC'],      // intentionally NOT just "Nashville" — collides with NHL Predators
    'Austin FC':               ['ATX FC'],
    'Atlanta United FC':       ['Atlanta United'],
    'Minnesota United FC':     ['Minnesota United'],
    'Orlando City SC':         ['Orlando City'],
    'Chicago Fire FC':         ['Chicago Fire'],
    'New England Revolution':  ['Revolution', 'NE Revolution'],
    'Philadelphia Union':      ['Philadelphia Union'], // "Union" alone collides with Union Berlin
    'Colorado Rapids':         ['Rapids'],
    'Vancouver Whitecaps FC':  ['Vancouver Whitecaps', 'Whitecaps'],
    'Toronto FC':              ['TFC']
  },
  NHL: {
    'Nashville Predators':     ['Predators'],
    'Los Angeles Kings':       ['LA Kings'],
    'New York Rangers':        ['NY Rangers'],
    'New York Islanders':      ['NY Islanders', 'Isles'],
    'Tampa Bay Lightning':     ['Lightning', 'Bolts'],
    'Vegas Golden Knights':    ['Golden Knights', 'Vegas']
  },
  NBA: {
    'Los Angeles Lakers':      ['LA Lakers', 'Lakers'],
    'Los Angeles Clippers':    ['LA Clippers', 'Clippers'],
    'Golden State Warriors':   ['GSW', 'Warriors'],
    'New York Knicks':         ['NY Knicks'],
    'Brooklyn Nets':           ['BKN Nets']
  },
  NFL: {
    'New England Patriots':    ['NE Patriots'],
    'New York Giants':         ['NY Giants'],
    'New York Jets':           ['NY Jets']
  }
};

/**
 * Create the team_aliases table if it doesn't exist. Called from the
 * server boot path so dev environments don't need a separate manual
 * psql step.
 */
async function initialize() {
  const sql = `
    CREATE TABLE IF NOT EXISTS team_aliases (
      id                    SERIAL PRIMARY KEY,
      league                VARCHAR(64)  NOT NULL,
      sport                 VARCHAR(64)  NOT NULL,
      espn_team_id          VARCHAR(64),
      canonical_name        VARCHAR(255) NOT NULL,
      display_name          VARCHAR(255),
      short_display_name    VARCHAR(128),
      abbreviation          VARCHAR(32),
      nickname              VARCHAR(128),
      location              VARCHAR(128),
      slug                  VARCHAR(128),
      logo_url              TEXT,
      manual_aliases        JSONB DEFAULT '[]'::jsonb,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_aliases_league_espn
      ON team_aliases(league, espn_team_id);
    CREATE INDEX IF NOT EXISTS idx_team_aliases_league_canonical
      ON team_aliases(league, LOWER(canonical_name));
    CREATE INDEX IF NOT EXISTS idx_team_aliases_league_display
      ON team_aliases(league, LOWER(display_name));
  `;
  try {
    await postgresService.query(sql);
    const { rows } = await postgresService.query('SELECT COUNT(*) AS n FROM team_aliases');
    logger.info(`[TeamAliases] Table ready (${rows[0].n} rows)`);
  } catch (err) {
    logger.error(`[TeamAliases] initialize failed: ${err.message}`);
    throw err;
  }
}

/**
 * Pull teams for one ESPN (sport, league) pair. Wraps response parsing
 * so callers just get a flat list of row-ready objects.
 */
async function fetchEspnTeams(sport, league, internalLeague) {
  const url = `${ESPN_BASE_URL}/${sport}/${league}/teams`;
  const response = await axios.get(url, { timeout: 15000 });
  const leagueData = response.data?.sports?.[0]?.leagues?.[0];
  const teams = leagueData?.teams || [];

  return teams.map(entry => {
    const t = entry.team || {};
    const logoUrl = Array.isArray(t.logos) && t.logos[0] ? t.logos[0].href : null;
    const canonical = t.displayName || t.name || t.shortDisplayName || t.abbreviation || '';
    return {
      league: internalLeague,
      sport,
      espn_team_id: t.id ? String(t.id) : null,
      canonical_name: canonical,
      display_name: t.displayName || null,
      short_display_name: t.shortDisplayName || null,
      abbreviation: t.abbreviation || null,
      nickname: t.nickname || t.name || null,
      location: t.location || null,
      slug: t.slug || null,
      logo_url: logoUrl
    };
  });
}

/**
 * Upsert a single row by (league, espn_team_id).
 */
async function upsertTeam(row, manualAliases = []) {
  await postgresService.query(
    `INSERT INTO team_aliases
      (league, sport, espn_team_id, canonical_name, display_name,
       short_display_name, abbreviation, nickname, location, slug,
       logo_url, manual_aliases)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (league, espn_team_id) DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name,
       display_name = EXCLUDED.display_name,
       short_display_name = EXCLUDED.short_display_name,
       abbreviation = EXCLUDED.abbreviation,
       nickname = EXCLUDED.nickname,
       location = EXCLUDED.location,
       slug = EXCLUDED.slug,
       logo_url = COALESCE(EXCLUDED.logo_url, team_aliases.logo_url),
       manual_aliases = EXCLUDED.manual_aliases,
       updated_at = CURRENT_TIMESTAMP`,
    [
      row.league,
      row.sport,
      row.espn_team_id,
      row.canonical_name,
      row.display_name,
      row.short_display_name,
      row.abbreviation,
      row.nickname,
      row.location,
      row.slug,
      row.logo_url,
      JSON.stringify(manualAliases || [])
    ]
  );
}

/**
 * Seed / refresh the table from ESPN. Runs every league in
 * SPORT_LEAGUES; keep it idempotent so the nightly cron can rerun.
 */
async function seedFromEspn() {
  let inserted = 0;
  let failed = 0;

  for (const { sport, league, internalLeague } of SPORT_LEAGUES) {
    try {
      logger.info(`[TeamAliases] Fetching ${internalLeague} (${sport}/${league})...`);
      const teams = await fetchEspnTeams(sport, league, internalLeague);
      const leagueAliases = MANUAL_ALIASES[internalLeague] || {};
      for (const team of teams) {
        const manual = leagueAliases[team.display_name] || [];
        await upsertTeam(team, manual);
        inserted++;
      }
      logger.info(`[TeamAliases] Upserted ${teams.length} ${internalLeague} teams`);
    } catch (err) {
      failed++;
      logger.warn(`[TeamAliases] Failed to seed ${internalLeague}: ${err.message}`);
    }
  }

  logger.info(`[TeamAliases] Seed complete — ${inserted} rows upserted, ${failed} leagues failed`);
  return { inserted, failed };
}

/**
 * Build the alias bundle used by the matcher: every string that should
 * cause a channel-name hit for this team, plus sport/league context.
 *
 * Returns null if no row matches. Matching strategy is:
 *   1. exact case-insensitive match on canonical_name
 *   2. exact case-insensitive match on display_name, short_display_name
 *   3. any manual_aliases entry matches (case-insensitive)
 *   4. substring fallback on display_name (last resort — e.g. the
 *      live_events feed returned "Nashville SC" and we have
 *      "Nashville SC" canonical; no-op for real data but cheap)
 */
async function getAliasesForTeam(leagueName, teamName) {
  if (!leagueName || !teamName) return null;

  // Primary: exact league + name match via one indexed query.
  const result = await postgresService.query(
    `SELECT *
       FROM team_aliases
      WHERE league = $1
        AND (
          LOWER(canonical_name) = LOWER($2)
          OR LOWER(display_name) = LOWER($2)
          OR LOWER(short_display_name) = LOWER($2)
          OR LOWER(COALESCE(nickname, '')) = LOWER($2)
          OR LOWER(COALESCE(abbreviation, '')) = LOWER($2)
          OR manual_aliases @> to_jsonb(LOWER($2))
        )
      LIMIT 1`,
    [leagueName, teamName]
  );

  if (result.rows.length > 0) return rowToBundle(result.rows[0]);

  // Fallback: any league row whose manual_aliases contains the name
  // case-insensitively. The `@>` check above is case-sensitive against
  // the JSON; some manual_aliases entries were seeded with capitalised
  // forms. Scan + ilike on the jsonb text. Cheap because team_aliases
  // is tiny (<1000 rows total).
  const scan = await postgresService.query(
    `SELECT * FROM team_aliases
      WHERE league = $1
        AND manual_aliases::text ILIKE $2
      LIMIT 1`,
    [leagueName, `%${teamName.toLowerCase()}%`]
  );
  if (scan.rows.length > 0) return rowToBundle(scan.rows[0]);

  return null;
}

function rowToBundle(row) {
  const manual = Array.isArray(row.manual_aliases) ? row.manual_aliases : [];
  const aliases = new Set();
  for (const s of [
    row.canonical_name,
    row.display_name,
    row.short_display_name,
    row.abbreviation,
    row.nickname,
    ...manual
  ]) {
    if (s && String(s).trim()) aliases.add(String(s).trim());
  }
  return {
    espnTeamId: row.espn_team_id,
    league: row.league,
    sport: row.sport,
    canonicalName: row.canonical_name,
    aliases: Array.from(aliases) // primary field the matcher consumes
  };
}

module.exports = {
  initialize,
  seedFromEspn,
  fetchEspnTeams,
  upsertTeam,
  getAliasesForTeam,
  SPORT_LEAGUES,
  MANUAL_ALIASES
};
