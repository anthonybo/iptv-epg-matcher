/**
 * EPG Query Service
 * Handles all database queries for EPG data (channels, programs, statistics)
 */

const logger = require('../utils/logger');
const postgresService = require('./postgresService');
const epgDatabaseService = require('./epgDatabaseService');
const { convertEPGTimestampToISO } = require('../utils/epgTransformUtils');

/**
 * Get database statistics
 */
const getDatabaseStats = async () => {
  try {
    // Use pg_class.reltuples for approximate counts instead of
    // COUNT(*) — the latter takes 22+ seconds on the now-partitioned
    // 3.6M-row epg_programs table, and climbs past 100s when a
    // refresh is concurrently writing into it (this was the
    // smoking-gun cause of the 104-second `POST /api/epg/init` the
    // user reported). reltuples is maintained by ANALYZE / autovacuum
    // and is more than accurate enough for the dashboard / stats
    // display — these numbers are never used for app logic. For the
    // partitioned epg_programs we sum across all child partitions so
    // the figure reflects the full row set.
    const approxResult = await postgresService.query(`
      SELECT
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'epg_sources')   AS source_count,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = 'epg_channels')  AS channel_count,
        (SELECT COALESCE(SUM(reltuples)::bigint, 0)
           FROM pg_class
          WHERE relname LIKE 'epg_programs%' AND relkind = 'r')                  AS program_count
    `);
    const stats = approxResult.rows[0] || { source_count: 0, channel_count: 0, program_count: 0 };

    // Per-source channel/program counts come straight from
    // epg_sources (which the parser updates on completion) — these
    // are exact, source-scoped, and trivially indexed.
    const sourcesResult = await postgresService.query(`
      SELECT name, channel_count, program_count, last_updated
      FROM epg_sources
      ORDER BY name
    `);

    return {
      sourceCount: parseInt(stats.source_count) || 0,
      channelCount: parseInt(stats.channel_count) || 0,
      programCount: parseInt(stats.program_count) || 0,
      sources: sourcesResult.rows,
      databasePath: 'PostgreSQL (iptvguru database)'
    };
  } catch (error) {
    logger.error(`Error getting database stats: ${error.message}`);
    return {
      sourceCount: 0,
      channelCount: 0,
      programCount: 0,
      sources: [],
      error: error.message,
      databasePath: 'PostgreSQL (iptvguru database)'
    };
  }
};

/**
 * Search for EPG channels matching a free-form query.
 *
 * Old implementation used a single `LOWER(c.name) LIKE %query%` phrase
 * match — so searching for "USA NHL Network" returned ZERO results
 * because no EPG channel name contains that literal phrase (the
 * actual matches are spread across names like "NHL Network HD",
 * "NHLNetwork.us", "USA: NHL Network", etc.). The old query also had
 * two correlated subqueries (`COUNT(*)` per result row + LEFT JOIN
 * with NOW() filters) that made it slow against the now-partitioned
 * 919k-row epg_programs table — every result row scanned every
 * partition's channel_id index.
 *
 * New approach:
 *   1. Tokenise the query. "USA NHL Network" → ["usa", "nhl", "network"]
 *   2. WHERE = phrase match OR token-AND match. Phrase first so an
 *      exact "USA NHL Network" still ranks above token-only hits.
 *   3. ORDER BY: phrase-match rank, then name length (shorter names
 *      are usually the linear feed, longer = per-event variants),
 *      then alphabetical.
 *   4. Run COUNT(*) and current-program lookups in TWO batched
 *      queries against the trimmed result set — not one subquery per
 *      row across all 919k programs.
 */
const searchChannels = async (query) => {
  try {
    const searchTerm = String(query || '').toLowerCase().trim();
    if (searchTerm.length < 2) return [];

    // ─── Token-subset matching (Stream-Mapparr style) ───────────
    //
    // Adopted from this project's own multi-view ticker scorer in
    // backend/routes/liveEvents/searchChannel.js — that file's
    // brand-mode filter ALREADY does the right thing for the
    // equivalent IPTV-channel search and explains the design in
    // detail (see lines 826-925). We mirror its normalisation and
    // subset-gate here for EPG channels.
    //
    // The core technique: tokenise both query and channel names,
    // drop noise tokens (HD, FHD, region codes, etc.), and require
    // ALL query tokens to be present in the channel's token set
    // (subset, not substring). Token equality is full-string, so
    // "ESPN" ≠ "ESPN+" and "USA" ≠ "USA Today" without fragile
    // word-boundary regexes.
    //
    // Noise-token list extended beyond the ticker's: includes
    // country/region codes (US, USA, UK, EAST, WEST, …). Why? IPTV
    // channels often carry regional decorations the EPG provider
    // omits — user types "USA NHL Network", EPG only has "NHL
    // Network". Without stripping "usa" from the query the subset
    // gate would reject "NHL Network" as missing a token. With
    // stripping, both forms reduce to {nhl, network} and match.
    //
    // For the "USA NHL Network" case the user reported:
    //   - query tokens (post-strip) = {nhl, network}
    //   - "NHL Network USA" → {nhl, network} → MATCH ✓
    //   - "NHL Network HD"  → {nhl, network} → MATCH ✓ (HD stripped)
    //   - "USA Network"     → {network}      → REJECT (missing nhl) ✓
    //   - "[USA] USA Network" → {network}    → REJECT ✓
    const NOISE_TOKEN_RE = /\b(hd|fhd|sd|uhd|4k|8k|1080p?|720p?|480p?|h265|hevc|raw|alt|alternate|alternative|backup|us|usa|uk|gb|ca|au|nz|mx|de|fr|es|it|east|west|pacific|central|mountain|eastern|western|plus|channel)\b/g;
    const tokenize = (s) => {
      const norm = String(s || '')
        .toLowerCase()
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // strip [X] and (X) decorations
        .replace(NOISE_TOKEN_RE, ' ');
      return new Set(
        norm
          .split(/[\s:|=\\/_.-]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2)
      );
    };

    const queryTokens = tokenize(searchTerm);
    // Defensive fallback: if EVERY query token was noise (e.g. user
    // typed "HD" or "USA HD"), reuse the un-normalised tokens so we
    // still return something instead of an empty set.
    if (queryTokens.size === 0) {
      const raw = searchTerm
        .toLowerCase()
        .split(/[\s:|=\\/_.-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
      raw.forEach((t) => queryTokens.add(t));
      if (queryTokens.size === 0) return [];
    }

    // SQL prefilter: pull candidates that contain the rarest query
    // token. Cheap with the trgm GIN index. Done in SQL because
    // shipping all 37k epg_channels to JS would be wasteful.
    const queryTokensArr = Array.from(queryTokens);
    let prefilterToken = queryTokensArr[0];
    if (queryTokensArr.length > 1) {
      try {
        const freqRes = await postgresService.query(
          `SELECT tok, (SELECT COUNT(*)::int FROM epg_channels WHERE LOWER(name) LIKE '%' || tok || '%') AS n
             FROM UNNEST($1::text[]) AS tok`,
          [queryTokensArr]
        );
        const sorted = freqRes.rows.slice().sort((a, b) => a.n - b.n);
        if (sorted.length > 0 && sorted[0].n > 0) {
          prefilterToken = sorted[0].tok;
        }
      } catch (e) {
        logger.warn(`[searchChannels] token frequency probe failed (non-fatal): ${e.message}`);
      }
    }

    // Pull a wide candidate window (200) so the JS subset gate has
    // enough to work with. 37k channels max, and the filter is
    // trgm-indexed, so this stays under a second.
    const candidatesRes = await postgresService.query(
      `SELECT c.id, c.name, c.icon, c.source_id, s.name AS source_name
         FROM epg_channels c
         JOIN epg_sources s ON c.source_id = s.id
        WHERE LOWER(c.name) LIKE '%' || $1 || '%'
        LIMIT 200`,
      [prefilterToken]
    );

    // JS subset gate + scoring (mirroring searchChannel.js:891-922).
    // The +50 / +30 / +15 / -30 / -5 weights are the same as the
    // ticker scorer so EPG and IPTV searches feel consistent.
    const queryLower = searchTerm.toLowerCase().trim();
    const matched = {
      rows: candidatesRes.rows
        .map((row) => {
          const chTokens = tokenize(row.name);
          // Subset check: every query token must be in the channel's
          // (normalised) token set. Pure full-string equality on
          // tokens — no substring fuzziness.
          for (const t of queryTokensArr) {
            if (!chTokens.has(t)) return null;
          }
          const name = String(row.name || '');
          const lower = name.toLowerCase();
          let score = 100;
          if (lower.startsWith(queryLower)) score += 50;
          if (name.length <= 12) score += 30;
          else if (name.length <= 20) score += 15;
          else if (name.length > 40) score -= 30;
          if (/\(.*\)|\[.*\]/.test(name)) score -= 5;
          return { ...row, _score: score };
        })
        .filter(Boolean)
        .sort((a, b) => b._score - a._score || a.name.localeCompare(b.name))
        .slice(0, 50)
    };
    if (matched.rows.length === 0) return [];

    const ids = matched.rows.map((r) => r.id);
    // Source ids of the matched channels — passed to the COUNT and
    // current-program lookups so PG can compile-time-prune the
    // epg_programs partition fan-out. Without this, each lookup
    // scans every partition's channel_id index (16+ partitions),
    // taking 5-15+ seconds. With the source_id filter the planner
    // visits only the partitions that could possibly hold matching
    // rows — typically 3-5.
    const sourceIds = Array.from(new Set(matched.rows.map((r) => r.source_id).filter(Boolean)));

    // Step 2: batch the program counts.
    let countMap = {};
    try {
      const countRes = await postgresService.query(
        `SELECT channel_id, COUNT(*)::int AS n
           FROM epg_programs
          WHERE channel_id = ANY($1::text[])
            AND source_id  = ANY($2::text[])
          GROUP BY channel_id`,
        [ids, sourceIds]
      );
      countMap = Object.fromEntries(countRes.rows.map((r) => [r.channel_id, r.n]));
    } catch (e) {
      logger.warn(`[searchChannels] program count lookup failed (non-fatal): ${e.message}`);
    }

    // Step 3: batch the "currently airing" program lookup.
    let currentMap = {};
    try {
      const currentRes = await postgresService.query(
        `SELECT DISTINCT ON (channel_id)
                channel_id, id, title, description, start_time, stop_time
           FROM epg_programs
          WHERE channel_id = ANY($1::text[])
            AND source_id  = ANY($2::text[])
            AND start_time <= NOW()
            AND stop_time  >  NOW()
          ORDER BY channel_id, start_time DESC`,
        [ids, sourceIds]
      );
      currentMap = Object.fromEntries(currentRes.rows.map((r) => [r.channel_id, r]));
    } catch (e) {
      logger.warn(`[searchChannels] current-program lookup failed (non-fatal): ${e.message}`);
    }

    // Step 4: stitch the three result sets together, preserving the
    // ranking order from step 1. Include `score` so the frontend's
    // "Best Match" sort (EPGMatcher.js line 955: `if (typeof b.score
    // === 'number' …)`) honors the backend ranking instead of
    // falling back to its alphabetical-with-startsWith fallback —
    // which previously put "[USA] USA Network" and "ACC Network" at
    // the top of a "USA NHL Network" search because `[` and `A`
    // sort before `N`.
    return matched.rows.map((row) => {
      const current = currentMap[row.id];
      const score = typeof row._score === 'number'
        ? row._score
        : parseFloat(row._score) || 0;
      return {
        id: row.id,
        name: row.name,
        icon: row.icon,
        source_name: row.source_name,
        score,
        program_count: countMap[row.id] ?? 0,
        currentProgram: current
          ? {
              id: current.id,
              title: current.title,
              description: current.description,
              start: convertEPGTimestampToISO(current.start_time),
              stop: convertEPGTimestampToISO(current.stop_time)
            }
          : null
      };
    });
  } catch (error) {
    logger.error(`Error searching channels: ${error.message}`);
    return [];
  }
};

/**
 * Get channel details by ID with fuzzy matching fallback
 */
const getChannelById = async (channelId) => {
  try {
    logger.info(`Looking up channel by ID: "${channelId}"`);

    const sql = `
      SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
      FROM epg_channels c
      JOIN epg_sources s ON c.source_id = s.id
      WHERE c.id = $1
    `;

    let result = await postgresService.query(sql, [channelId]);

    // If no results, try variations
    if (result.rows.length === 0) {
      logger.info(`No channel found for exact ID ${channelId}, trying variations`);

      // Try lowercase
      const lowerCaseId = channelId.toLowerCase();
      if (lowerCaseId !== channelId) {
        logger.info(`Trying lowercase variation: "${lowerCaseId}"`);
        result = await postgresService.query(sql, [lowerCaseId]);
      }

      // Try with/without .us domain suffix
      if (result.rows.length === 0) {
        if (channelId.endsWith('.us')) {
          const withoutUsSuffix = channelId.substring(0, channelId.length - 3);
          logger.info(`Trying without .us suffix: "${withoutUsSuffix}"`);
          result = await postgresService.query(sql, [withoutUsSuffix]);
        } else {
          const withUsSuffix = `${channelId}.us`;
          logger.info(`Trying with .us suffix: "${withUsSuffix}"`);
          result = await postgresService.query(sql, [withUsSuffix]);
        }
      }

      // Try without spaces, dashes, dots
      if (result.rows.length === 0) {
        const normalizedId = channelId.replace(/[\s\.\-_]+/g, '').toLowerCase();

        if (normalizedId !== channelId.toLowerCase()) {
          const fuzzySearchSql = `
            SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
            FROM epg_channels c
            JOIN epg_sources s ON c.source_id = s.id
            WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(c.id, ' ', ''), '.', ''), '-', ''), '_', '')) = $1
            LIMIT 5
          `;

          logger.info(`Trying normalized ID (no special chars): "${normalizedId}"`);
          result = await postgresService.query(fuzzySearchSql, [normalizedId]);
        }
      }

      // Try name-based lookup for Travel Channel variations
      if (result.rows.length === 0 && channelId.toLowerCase().includes('travel')) {
        logger.info(`Trying name-based lookup for Travel Channel variations`);
        const travelChannelSql = `
          SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
          FROM epg_channels c
          JOIN epg_sources s ON c.source_id = s.id
          WHERE LOWER(c.name) LIKE '%travel%channel%'
          ORDER BY
            CASE
              WHEN c.id = 'travelchannel.us' THEN 1
              WHEN c.id LIKE 'travelchannel.%' THEN 2
              WHEN c.id LIKE '%travel%channel%' THEN 3
              ELSE 4
            END,
            LENGTH(c.name)
          LIMIT 5
        `;
        result = await postgresService.query(travelChannelSql, []);
      }

      // Try partial name matching
      if (result.rows.length === 0 && channelId.length > 3) {
        const potentialName = channelId
          .replace(/[_\.\-]/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .trim();

        if (potentialName.length > 3) {
          const nameSearchSql = `
            SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
            FROM epg_channels c
            JOIN epg_sources s ON c.source_id = s.id
            WHERE LOWER(c.name) LIKE $1
            ORDER BY
              CASE
                WHEN LOWER(c.name) = $2 THEN 1
                WHEN LOWER(c.name) LIKE $3 || '%' THEN 2
                ELSE 3
              END,
              LENGTH(c.name)
            LIMIT 1
          `;

          logger.info(`Trying name-based lookup with potential name: "${potentialName}"`);
          result = await postgresService.query(nameSearchSql, [
            `%${potentialName}%`,
            potentialName,
            potentialName
          ]);
        }
      }
    }

    // If we found a match, return it with a note if it's not the exact ID
    if (result.rows.length > 0) {
      const channel = result.rows[0];
      if (channel.id !== channelId) {
        logger.info(`Found channel "${channel.name}" with similar ID: "${channel.id}" (originally requested: "${channelId}")`);
      } else {
        logger.info(`Found exact channel match: "${channel.name}" (${channel.id})`);
      }
      return channel;
    }

    logger.info(`No matching channel found for ID: ${channelId}`);
    return null;
  } catch (error) {
    logger.error(`Error getting channel by ID: ${error.message}`);
    return null;
  }
};

/**
 * Get categories for a session (from session storage)
 */
const getCategories = (session) => {
  try {
    if (!session || !session.data || !session.data.channels || !Array.isArray(session.data.channels)) {
      return [];
    }

    // Get unique categories from channels
    const categories = new Set();
    session.data.channels.forEach(channel => {
      if (channel.group && typeof channel.group === 'string') {
        categories.add(channel.group);
      }
    });

    return Array.from(categories).sort();
  } catch (error) {
    logger.error(`Error getting categories: ${error.message}`);
    return [];
  }
};

module.exports = {
  getDatabaseStats,
  searchChannels,
  getChannelById,
  getCategories
};
