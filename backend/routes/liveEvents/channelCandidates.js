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

    // SQL filter: name must contain the full query phrase OR any
    // expanded alias. We deliberately do NOT OR in individual tokens
    // — for a user with ~1M channels, a token like "nhl" or
    // "network" matches tens of thousands of rows and the trgm
    // index's BitmapOr explodes the working set; resolving 67-source
    // JOIN + sort over that set used to push response times past 5
    // minutes. Instead, the AND-all-tokens fallback below catches
    // out-of-order phrasings ("ESPN NHL" vs "NHL ESPN") without the
    // selectivity blowup.
    const orParts = [];
    const seenLikes = new Set();
    const orTerms = [
      queryLower,
      ...expandedAliases.map((a) => a.toLowerCase())
    ];
    for (const tok of orTerms) {
      if (!tok || tok.length < 3 || seenLikes.has(tok)) continue;
      seenLikes.add(tok);
      orParts.push(`c.name ILIKE ${placeholder(`%${tok}%`)}`);
    }

    // AND-all-tokens fallback for multi-token queries. Requires every
    // ≥3-char token to appear somewhere in the name (in any order).
    // This catches "NHL Network HD", "USA NHL Network", and other
    // permutations that the bare phrase ILIKE misses, while still
    // being trgm-indexed and selective (each token narrows the set).
    if (queryTokens.length > 1) {
      const longTokens = queryTokens.filter((t) => t.length >= 3);
      if (longTokens.length >= 2) {
        const andClauses = longTokens.map(
          (t) => `c.name ILIKE ${placeholder(`%${t}%`)}`
        );
        orParts.push(`(${andClauses.join(' AND ')})`);
      }
    }

    let sourceExclusion = '';
    if (excludeSourceIds.length > 0) {
      const ph = excludeSourceIds.map((id) => placeholder(id)).join(', ');
      sourceExclusion = `AND s.id NOT IN (${ph})`;
    }

    let channelExclusion = '';
    if (excludeChannelIds.length > 0) {
      const ph = excludeChannelIds.map((id) => placeholder(id)).join(', ');
      channelExclusion = `AND c.channel_id NOT IN (${ph})`;
    }

    // Overfetch — we dedupe by (lower(name), host, account) below.
    const limitPh = placeholder(limit * 4);

    const sql = `
      SELECT
        c.channel_id  AS id,
        c.name        AS name,
        c.logo_url    AS logo,
        c.stream_url  AS url,
        c.tvg_id      AS epg_channel_id,
        c.group_title AS category,
        s.id          AS source_id,
        s.name        AS source_name,
        s.type        AS source_type,
        s.url         AS source_url,
        s.username    AS source_username,
        s.password    AS source_password,
        s.mac_address AS source_mac
      FROM iptv_channels c
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE s.user_id = $1
        AND (${orParts.join(' OR ')})
        ${sourceExclusion}
        ${channelExclusion}
      ORDER BY c.name
      LIMIT ${limitPh}
    `;

    // Hard ceiling so a pathological pattern can never tie up a
    // server-side worker for minutes. 5s is generous given the trgm
    // index — previous 5-minute response times were a query-shape
    // problem (low-selectivity tokens OR'd together), but the
    // timeout is a belt-and-braces guard against future regressions.
    // SET LOCAL only takes effect inside a transaction, so we use
    // the transaction wrapper to scope it correctly.
    const rows = await postgresService.transaction(async (client) => {
      await client.query('SET LOCAL statement_timeout = 5000');
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
      `(matched=${rows.length}, deduped=${deduped.length}, excludedSources=${excludeSourceIds.length}, excludedChannels=${excludeChannelIds.length})`
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
