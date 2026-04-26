/**
 * EPG-first channel matcher.
 *
 * The existing search-channel pipeline fetches candidates by NAME
 * (team words + broadcaster aliases) and then uses EPG as a verifier
 * during scoring. That misses an entire class of perfect-match
 * channels: ones whose name is generic (e.g. "beIN_SPORTS1_DIGITAL_
 * Mono_AR.bein") but whose CURRENT EPG PROGRAM contains the exact
 * team names ("Wolverhampton Wanderers vs Tottenham Hotspur").
 *
 * This module turns the lookup around — start from the EPG. For an
 * event with home_team H and away_team A:
 *
 *   1. Build alias regexes from the team_aliases tiered bundles
 *      (full / mascot / abbr / short / manual / city)
 *   2. Find epg_programs WHERE NOW() ∈ (start_time, stop_time)
 *      AND title matches BOTH a home alias AND an away alias
 *   3. Map those programs back to iptv_channels via tvg_id
 *   4. Filter to channels the user has access to
 *
 * Hits returned by this matcher get a flat +500 score in the caller's
 * scoring pass — much higher than even a "both teams in name" channel
 * (~350) — because EPG confirmation is the strongest possible signal.
 *
 * Backed by the GIN trigram index on epg_programs.title (migration
 * 022) for sub-100ms lookups across the 3.3M-row table.
 */

const logger = require('../config/logger');
const postgresService = require('../services/postgresService');

/**
 * Build an alias substring list from a team's tiered alias bundle.
 * Skips null/empty entries and dedupes case-insensitively.
 */
function tieredToList(tiered) {
  if (!tiered) return [];
  const out = new Set();
  // Iterate in tier order — full names first, mascots, abbreviations,
  // short, manual, city. We keep all of them; ranking happens at score
  // time, not here.
  const tiers = ['full', 'mascot', 'abbr', 'short', 'manual', 'city'];
  for (const t of tiers) {
    for (const alias of (tiered[t] || [])) {
      if (!alias) continue;
      const trimmed = String(alias).trim();
      // Drop very short tokens — they cause false positives
      // ("FC", "SC", initials) when used as a substring against
      // other event names.
      if (trimmed.length < 3) continue;
      out.add(trimmed);
    }
  }
  return Array.from(out);
}

/**
 * Find channels currently airing an event per their EPG data.
 *
 * Returns an array of:
 *   { channel: <iptv_channels row>, epgTitle: string, source: 'epg' }
 *
 * Channels missing from any of the user's M3U/Xtream sources are
 * filtered out before return.
 */
async function findChannelsByEpg({
  homeAliases,
  awayAliases,
  userId,
  sessionId,
  excludeSourceIds = [],
  excludeChannelIds = [],
  limit = 30
}) {
  if (!userId && !sessionId) return [];

  const homeList = tieredToList(homeAliases);
  const awayList = tieredToList(awayAliases);
  if (homeList.length === 0 || awayList.length === 0) return [];

  // Build OR-of-ILIKE for each side. We'd love to use ANY(array_agg(
  // title ILIKE pattern)) but PostgreSQL ILIKE doesn't have an
  // any-of-pattern primitive cleanly, so a regex with alternation
  // works: title ~* '(alias1|alias2|...)'.
  //
  // pg_trgm GIN index on title still accelerates this: the planner
  // uses the index for the regex's literal substrings.
  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const homeRegex = `(${homeList.map(escapeRegex).join('|')})`;
  const awayRegex = `(${awayList.map(escapeRegex).join('|')})`;

  // Build the exclusion clauses inline.
  const sourceExclusion = excludeSourceIds.length > 0
    ? `AND s.id NOT IN (${excludeSourceIds.map((_, i) => `$${i + 5}`).join(', ')})`
    : '';
  const channelExclusionStart = 5 + excludeSourceIds.length;
  const channelExclusion = excludeChannelIds.length > 0
    ? `AND c.channel_id NOT IN (${excludeChannelIds.map((_, i) => `$${i + channelExclusionStart}`).join(', ')})`
    : '';

  const sql = `
    SELECT DISTINCT ON (c.channel_id)
      c.channel_id      AS id,
      c.name,
      c.logo_url        AS logo,
      c.stream_url      AS url,
      c.tvg_id          AS epg_channel_id,
      c.group_title     AS category,
      s.id              AS source_id,
      s.name            AS source_name,
      s.type            AS source_type,
      s.url             AS source_url,
      s.username        AS source_username,
      s.password        AS source_password,
      s.mac_address     AS source_mac,
      p.title           AS epg_title
    FROM epg_programs p
    JOIN iptv_channels c ON c.tvg_id = p.channel_id
    JOIN iptv_sources s   ON s.id = c.source_id
    WHERE p.start_time <= NOW()
      AND p.stop_time  >  NOW()
      AND p.title ~* $1
      AND p.title ~* $2
      AND (s.user_id = $3 OR s.session_id = $4)
      ${sourceExclusion}
      ${channelExclusion}
    ORDER BY c.channel_id, p.start_time DESC
    LIMIT ${Math.max(1, Math.min(parseInt(limit, 10) || 30, 100))}
  `;

  const params = [
    homeRegex,
    awayRegex,
    userId || -1,
    sessionId || '',
    ...excludeSourceIds,
    ...excludeChannelIds
  ];

  try {
    const start = Date.now();
    const result = await postgresService.query(sql, params);
    const took = Date.now() - start;
    const rows = result.rows || [];
    if (rows.length > 0) {
      logger.info(`[EPG-first] ${rows.length} channels confirmed via EPG (${took}ms) — sample: ${rows.slice(0, 3).map((r) => `${r.name} → "${r.epg_title?.substring(0, 60)}"`).join(' | ')}`);
    } else {
      // INFO not DEBUG — visibility into "EPG-first ran but found nothing"
      // is the difference between "didn't fire" and "fired but missed"
      // when diagnosing why a click fell through to broadcaster search.
      logger.info(`[EPG-first] no channels found via EPG title match (${took}ms, ${homeList.length} home aliases × ${awayList.length} away aliases)`);
    }
    return rows.map((r) => ({ channel: r, epgTitle: r.epg_title, source: 'epg' }));
  } catch (err) {
    logger.warn(`[EPG-first] query failed: ${err.message}`);
    return [];
  }
}

module.exports = { findChannelsByEpg };
