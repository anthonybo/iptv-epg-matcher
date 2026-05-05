/**
 * Broadcaster match stats writer.
 *
 * Records (broadcaster_code, sport_type, league_name) → outcome rows
 * to broadcaster_match_stats so we can derive an evidence-based
 * "what aliases need adding/fixing" report from real search activity.
 *
 * Why a wrapper:
 *   - We want UPSERTs to be fire-and-forget on the search-channel hot
 *     path. The search response shouldn't block on DB stats writes.
 *   - PG's PK columns can't be NULL on default settings — we COALESCE
 *     sport_type/league_name to '' so the ON CONFLICT key is stable
 *     across rows that came in without sport metadata.
 */

const logger = require('../config/logger');
const postgresService = require('./postgresService');

const SQL = `
  INSERT INTO broadcaster_match_stats (
    broadcaster_code,
    sport_type,
    league_name,
    alias_count,
    search_count,
    match_via_this_count,
    match_via_other_count,
    fail_count,
    last_seen
  ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, CURRENT_TIMESTAMP)
  ON CONFLICT (broadcaster_code, sport_type, league_name) DO UPDATE SET
    search_count          = broadcaster_match_stats.search_count          + 1,
    match_via_this_count  = broadcaster_match_stats.match_via_this_count  + EXCLUDED.match_via_this_count,
    match_via_other_count = broadcaster_match_stats.match_via_other_count + EXCLUDED.match_via_other_count,
    fail_count            = broadcaster_match_stats.fail_count            + EXCLUDED.fail_count,
    alias_count           = EXCLUDED.alias_count,
    last_seen             = CURRENT_TIMESTAMP
`;

/**
 * Record stats for a finished search.
 *
 * @param {object}   args
 * @param {string[]} args.rawCodes        — broadcaster codes from ESPN (pre-expansion). Must NOT be empty.
 * @param {string?}  args.sportType
 * @param {string?}  args.leagueName
 * @param {object}   args.aliasCountByCode — { [code]: number } — how many aliases the code expanded into (0 = passthrough)
 * @param {string?}  args.matchedTerm     — the broadcaster term that earned the bonus on the winning channel (null if no win or non-broadcaster win)
 * @param {string[]} args.termsForCode[code] — { [code]: string[] } — the aliases that came from each code, so we can attribute matchedTerm back
 * @param {boolean}  args.searchFailed    — true if the search exhausted with no working channel
 * @returns {Promise<void>}
 */
async function recordSearch({
  rawCodes,
  sportType,
  leagueName,
  aliasCountByCode,
  matchedTerm,
  termsForCode,
  searchFailed
}) {
  if (!Array.isArray(rawCodes) || rawCodes.length === 0) return;
  // Deduplicate raw codes — ESPN occasionally returns the same code
  // twice for an event with mixed regions.
  const uniqueCodes = Array.from(new Set(rawCodes.filter(Boolean)));
  const sport = sportType || '';
  const league = leagueName || '';
  const matchedTermUpper = matchedTerm ? String(matchedTerm).toUpperCase() : null;

  // Run all UPSERTs in parallel. Each is independent.
  const tasks = uniqueCodes.map((code) => {
    const aliasCount = aliasCountByCode[code] ?? 0;
    let matchedThis = 0;
    let matchedOther = 0;
    let failed = 0;
    if (searchFailed) {
      failed = 1;
    } else if (matchedTermUpper) {
      // Match attribution: did the winning channel's broadcaster bonus
      // come from THIS code's alias expansion?
      const myAliases = (termsForCode[code] || []).map((t) => String(t).toUpperCase());
      if (myAliases.includes(matchedTermUpper)) {
        matchedThis = 1;
      } else {
        matchedOther = 1;
      }
    } else {
      // Search succeeded via non-broadcaster signal (team name / EPG).
      matchedOther = 1;
    }
    return postgresService.query(SQL, [
      code, sport, league,
      aliasCount,
      matchedThis, matchedOther, failed
    ]).catch((err) => {
      // Don't surface stats failures to the user — log and move on.
      logger.warn(`[BroadcasterStats] upsert failed for "${code}" (${sport}/${league}): ${err.message}`);
    });
  });

  await Promise.all(tasks);
}

module.exports = { recordSearch };
