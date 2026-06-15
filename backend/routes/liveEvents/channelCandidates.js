/**
 * POST /api/live-events/channel-candidates
 *
 * Returns a ranked LIST of IPTV channels matching a free-form query —
 * NO ffprobe testing. Used by the front-end picker UIs:
 *   - Header search "reelz" → modal listing every Reelz variant (US: Reelz HD,
 *     REELZ Famous & Infamous, USA Reelz, …) so the user picks the one
 *     they actually want instead of the first one search-channel happens
 *     to validate first.
 *   - Per-tile "alternate sources" button → list of channels with the
 *     same/similar name across the user's other sources so the user can
 *     swap sources manually without burning the auto-find chain.
 *
 * Why a separate endpoint vs. flagging /search-channel?
 *   /search-channel runs the relevance scorer + alias matcher + ffprobe
 *   loop, which is the right thing for ticker clicks (we want a working
 *   stream NOW). For the picker we want every plausible candidate fast
 *   and let the user pick — validation happens at play time. ffprobe-ing
 *   25 channels just to populate a list is 5–10s wasted on every modal
 *   open.
 *
 * Body params:
 *   query              — required, ≥2 chars
 *   excludeSourceIds[] — sources already in the multiview grid
 *   excludeChannelIds[]— current stream + recently-failed channels
 *   limit              — clamp to [5, 50], default 25
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { expandBroadcaster, hasAlias } = require('../../utils/broadcasterAliases');

router.post('/channel-candidates', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const {
    query,
    excludeSourceIds = [],
    excludeChannelIds = [],
    excludeChannels = [],
    limit: rawLimit = 25
  } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({
      success: false,
      error: 'Query must be at least 2 characters'
    });
  }

  const searchQuery = query.trim();
  // Bumped cap from 50 → 200. With per-account dedupe (not per-host),
  // a channel like "Reelz" can legitimately have 50+ rows when the
  // user has 10 accounts on each of 5 providers. The Picker UI scrolls
  // and has a filter input, so a long list is fine; what's NOT fine
  // is silently truncating to 15 when the user expected to see every
  // option.
  const limit = Math.max(5, Math.min(200, parseInt(rawLimit) || 50));

  try {
    // Tokenise the query — same approach as the brand-mode filter in
    // searchChannel.js. We don't apply the strict subset gate here
    // because the user is asking for a *list*; let everything that
    // contains the primary token through and rank by name proximity.
    const queryLower = searchQuery.toLowerCase();
    const queryTokens = queryLower
      .split(/[\s:|=\\/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    if (queryTokens.length === 0) queryTokens.push(queryLower);

    // Brand-alias auto-expansion. When the query exactly matches a
    // broadcaster code we know about ("SECN+", "MLB.TV", "TNT", etc.),
    // fold the alias bag into the OR-set so the picker surfaces every
    // catalog-naming variant (e.g. " :SEC+  10" overflow slots when
    // the user types "SECN+", or "SEC NETWORK +" with a space).
    // Without this the per-tile "Switch source" picker silently
    // returned 0 candidates whenever the catalog labelled the channel
    // differently from what ESPN reported — see 2026-05-08 22:09 SECN+
    // log where searchQuery was "SECN+" but the actual channels were
    // " :SEC+  10" / " :SEC+  100" / etc.
    const expandedAliases = hasAlias(searchQuery)
      ? expandBroadcaster(searchQuery)
          .filter((a) => typeof a === 'string' && a.trim().length >= 3)
          .map((a) => a.trim())
      : [];
    if (expandedAliases.length > 0) {
      logger.info(
        `[Channel Candidates] Brand-alias expand "${searchQuery}" → ${expandedAliases.length}: ${expandedAliases.join(', ')}`
      );
    }

    // Build params + WHERE incrementally so the placeholder numbering
    // stays in lockstep with the array index.
    const params = [userId];
    const placeholder = (val) => {
      params.push(val);
      return `$${params.length}`;
    };

    // ───────────────────────────────────────────────────────────────
    // Build a Postgres tsquery from the user's input + brand-alias
    // expansion. We query iptv_channels_search (migration 033), a
    // NON-partitioned shadow with a single GIN(tsvector) index —
    // bypassing the 65-partition catalog enumeration that was costing
    // 3.5s of planning time on cold connections (logs 2026-05-22
    // 10:39:47, "nhl network" → 15s timeout).
    //
    // Config: 'simple' (no English stemming, no stop-words). Channel
    // names like "USA HD" or "NHL Network" need every token preserved
    // verbatim; stemming would silently rewrite "Networks" → "network"
    // (occasionally helpful) but also drop tokens like "and" / "the"
    // / "of" (e.g. "The Movie Channel" would lose "The"). Simple is
    // safer for this domain.
    //
    // Per-token escaping: tsquery is a fragile mini-language. We
    // strip every non-alphanumeric char, lowercase, then join with
    // operators — no user-supplied character can reach the parser.
    // ───────────────────────────────────────────────────────────────
    const tsqEscape = (t) =>
      String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const queryTokensForFts = queryTokens.map(tsqEscape).filter((t) => t.length >= 2);
    const aliasGroups = expandedAliases
      .map((alias) =>
        String(alias)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .map(tsqEscape)
          .filter((t) => t.length >= 2)
      )
      .filter((tokens) => tokens.length > 0);

    // Primary clause: AND-all-tokens with prefix matching. "nhl
    // network" → 'nhl:* & network:*' — matches names that contain
    // BOTH tokens, where each token can be a prefix (so "NHLN" alone
    // does NOT satisfy the "nhl & network" AND, but "NHL Network HD"
    // does). Order-independent: "USA NHL Network" matches too.
    const queryAndClause = queryTokensForFts.length > 0
      ? '(' + queryTokensForFts.map((t) => `${t}:*`).join(' & ') + ')'
      : null;

    // Alias clauses: each expanded alias becomes its own AND-token
    // group, all OR'd together. So expanding "NHL NETWORK" → "NHLN"
    // gives ('nhln:*') as a separate clause, matching channels named
    // just "NHLN" that would miss the AND-clause above.
    const aliasOrClauses = aliasGroups.map(
      (toks) => '(' + toks.map((t) => `${t}:*`).join(' & ') + ')'
    );

    const tsqueryParts = [queryAndClause, ...aliasOrClauses].filter(Boolean);
    if (tsqueryParts.length === 0) {
      // Defensive — should be impossible given the ≥2-char guard above
      return res.json({ success: true, query: searchQuery, candidates: [] });
    }
    const tsqueryString = tsqueryParts.join(' | ');
    const tsqueryPh = placeholder(tsqueryString);

    // Substring fallback so the picker also surfaces names the word-prefix
    // tsquery misses — mid-word matches ("Superjail" for "jail") and partial
    // fragments. Unindexed, but scoped to one user's rows and bounded by the
    // 8s statement_timeout below. Escape LIKE wildcards in the user's input.
    const ilikeArg = `%${searchQuery.replace(/[\\%_]/g, '\\$&')}%`;
    const ilikePh = placeholder(ilikeArg);

    let sourceExclusion = '';
    if (excludeSourceIds.length > 0) {
      const ph = excludeSourceIds.map((id) => placeholder(id)).join(', ');
      sourceExclusion = `AND s.id NOT IN (${ph})`;
    }

    // Exclude tiles already on screen. Prefer composite (source_id, channel_id)
    // pairs — a channel_id alone is NOT unique across accounts/providers
    // (xtream stream ids collide), so `channel_id NOT IN (...)` would hide
    // EVERY account's copy of a channel the user is currently watching. That
    // was the bug: one playing "24/7 Jackass" tile (xtream_526396) hid all 18
    // of its accounts, dropping the result from 22 to 4. Legacy channel_id
    // list kept as a fallback for any older caller.
    let channelExclusion = '';
    if (Array.isArray(excludeChannels) && excludeChannels.length > 0) {
      const conds = excludeChannels
        .filter((c) => c && c.channelId != null)
        .map((c) => `(cs.source_id = ${placeholder(c.sourceId)} AND cs.channel_id = ${placeholder(String(c.channelId))})`);
      if (conds.length > 0) channelExclusion = `AND NOT (${conds.join(' OR ')})`;
    } else if (excludeChannelIds.length > 0) {
      const ph = excludeChannelIds.map((id) => placeholder(id)).join(', ');
      channelExclusion = `AND cs.channel_id NOT IN (${ph})`;
    }

    // Overfetch — we dedupe by (lower(name), host, account) below.
    const limitPh = placeholder(limit * 4);

    const sql = `
      SELECT
        cs.channel_id  AS id,
        cs.name        AS name,
        cs.logo_url    AS logo,
        cs.stream_url  AS url,
        cs.tvg_id      AS epg_channel_id,
        cs.group_title AS category,
        s.id           AS source_id,
        s.name         AS source_name,
        s.type         AS source_type,
        s.url          AS source_url,
        s.username     AS source_username,
        s.password     AS source_password,
        s.mac_address  AS source_mac
      FROM iptv_channels_search cs
      JOIN iptv_sources s ON cs.source_id = s.id
      WHERE cs.user_id = $1
        AND (
          cs.name_tsv @@ to_tsquery('simple', ${tsqueryPh})
          OR cs.name ILIKE ${ilikePh} ESCAPE '\\'
        )
        ${sourceExclusion}
        ${channelExclusion}
      ORDER BY cs.name
      LIMIT ${limitPh}
    `;

    // Hard ceiling. Now that we query the non-partitioned shadow
    // (single table, single GIN index, single plan), even a cold
    // connection finishes in 1-3s. 8s is generous belt-and-braces.
    // SET LOCAL only takes effect inside a transaction.
    const rows = await postgresService.transaction(async (client) => {
      await client.query('SET LOCAL statement_timeout = 8000');
      const result = await client.query(sql, params);
      return result.rows;
    });

    // Dedupe by (lower(name), host, account). Earlier this was just
    // (name, host) which collapsed a user's 5 xtream accounts on the
    // same upstream provider into one row — the OPPOSITE of what the
    // picker wants. The whole point of the manual switch-source UI
    // is to let the user try a different account when one is throttled
    // / blacklisted by the upstream. Keep one row per (name, host,
    // account) so each credential pair is distinctly pickable but a
    // duplicate row from the same source/account (rare; happens when
    // the same provider lists a channel under two channel_ids) still
    // collapses.
    const hostOf = (url) => {
      if (!url) return '';
      try { return new URL(url).host.toLowerCase(); }
      catch { return ''; }
    };
    const accountIdOf = (r) =>
      r.source_type === 'stalker'
        ? (r.source_mac || '').toLowerCase()
        : (r.source_username || '').toLowerCase();
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = `${(r.name || '').toLowerCase().trim()}::${hostOf(r.source_url || r.url)}::${accountIdOf(r)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    // Pre-tokenise each alias once so the per-row scoring doesn't redo
    // it on every iteration. Each alias becomes a Set of full tokens
    // (length ≥ 2 after splitting on whitespace/colon/pipe). A channel
    // is rewarded +25 if any alias's full token-set is a subset of its
    // own — that's the "this is a linear feed for the alias family"
    // signal (e.g. a channel named "USA: SEC NETWORK+" tokens
    // {usa,sec,network+} contains the {sec,network+} alias-set).
    const aliasTokenSets = expandedAliases.map((a) => {
      return new Set(
        String(a)
          .toLowerCase()
          .split(/[\s:|=\\/]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2)
      );
    }).filter((s) => s.size > 0);

    // Score each candidate by name proximity to the query. Goal: surface
    // the linear feed ("US: Reelz HD") above per-event variants
    // ("REELZ Famous & Infamous"). Pure tie-break logic — the picker
    // UI shows everything regardless of score.
    //   +50 starts-with primary query
    //   +30 name length ≤ 12   — short names = likely linear feed
    //   +15 name length ≤ 20
    //   −30 name length > 40   — usually per-event PPV
    //    −5 trailing parens/brackets — region/quality decoration
    //   +20 per query token that appears as a FULL token in the name
    //   +25 per matching alias token-set (subset of channel tokens)
    const scored = deduped.map((r) => {
      const name = String(r.name || '');
      const lower = name.toLowerCase();
      let score = 100;
      if (lower.startsWith(queryLower)) score += 50;
      if (name.length <= 12) score += 30;
      else if (name.length <= 20) score += 15;
      else if (name.length > 40) score -= 30;
      if (/\(.*\)|\[.*\]/.test(name)) score -= 5;
      const channelTokens = new Set(
        lower
          .split(/[\s:|=\\/]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2)
      );
      let tokenHits = 0;
      for (const tok of queryTokens) if (channelTokens.has(tok)) tokenHits += 1;
      score += tokenHits * 20;
      // Alias subset bonus — a "USA: SEC NETWORK+" containing all of
      // the {sec,network+} alias tokens earns more than a bare
      // " :SEC+  10" overflow slot, even though both legitimately
      // match the SECN+ family. Picker UI shows both; this just sorts
      // the canonical linear feed first when one exists.
      for (const aSet of aliasTokenSets) {
        let isSubset = true;
        for (const tok of aSet) {
          if (!channelTokens.has(tok)) { isSubset = false; break; }
        }
        if (isSubset) score += 25;
      }
      return { ...r, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);

    const candidates = scored.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.name,
      logo: r.logo,
      url: r.url,
      sourceId: r.source_id,
      sourceName: r.source_name,
      sourceType: r.source_type,
      sourceUrl: r.source_url,
      sourceUsername: r.source_username,
      sourcePassword: r.source_password,
      sourceMac: r.source_mac,
      category: r.category,
      epgChannelId: r.epg_channel_id
    }));

    logger.info(
      `[Channel Candidates] query="${searchQuery}" → ${candidates.length} candidates ` +
      `(matched=${rows.length}, deduped=${deduped.length}, excludedSources=${excludeSourceIds.length}, excludedTiles=${(excludeChannels && excludeChannels.length) || excludeChannelIds.length})`
    );

    return res.json({
      success: true,
      query: searchQuery,
      candidates
    });
  } catch (error) {
    // Postgres surfaces statement_timeout cancellations as a query
    // with code "57014". Treat those as a soft failure with no
    // candidates so the picker UI shows "no matches" instead of an
    // error banner — the user's next attempt at a more specific
    // query usually resolves it.
    if (error.code === '57014') {
      logger.warn(`[Channel Candidates] query="${searchQuery}" timed out (>5s)`);
      return res.json({
        success: true,
        query: searchQuery,
        candidates: [],
        timedOut: true
      });
    }
    logger.error('[Channel Candidates] failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Candidate lookup failed'
    });
  }
});

module.exports = router;
