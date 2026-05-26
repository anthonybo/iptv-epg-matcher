/**
 * Breaking-events synthesis pipeline.
 *
 * Pulls real-time hot-thread signals from breaking-news subreddits,
 * feeds them through the LLM rotation client, and emits a clustered
 * list of "things happening right now" with channel hints attached.
 *
 *   Reddit hot threads ──┐
 *                        ├─►  LLM cluster + classify  ─►  [events]
 *   trending velocity ───┘                                    │
 *                                                             ▼
 *                                          ┌──────────────────────────┐
 *                                          │ channel match (per user) │
 *                                          └──────────────────────────┘
 *
 * Caching:
 *   - Raw signals cached internally by each source (10 min)
 *   - LLM synthesis cached globally (15 min) — same for every user
 *   - Channel resolution NOT cached — user-specific (depends on their IPTV
 *     catalog, which can change at any time)
 *
 * If LLM is disabled / all providers exhausted, the function returns a
 * best-effort fallback that just exposes the raw top hot threads
 * untagged — the user still sees breaking activity, just without the
 * synthesized event names and channel hints.
 */

const logger = require('../../config/logger');
const { collectHotThreads } = require('./redditHotSource');
const { collectArticles } = require('./gdeltSource');
const { isLlmReady, generateJson } = require('../llm/client');
const pg = require('../postgresService');

const SYNTH_CACHE_TTL_MS = 15 * 60 * 1000;
const synthCache = { ts: 0, events: null };

const SYSTEM_PROMPT = `You are a real-time event extractor for a live-TV viewer app.

You receive TWO complementary signal streams:
  1. NEWS WIRES (GDELT) — articles filed by global news outlets in the last ~2 hours. These surface real-world incidents (fires, chases, accidents, weather, attacks, political events) the moment any outlet covers them, including hyperlocal incidents.
  2. REDDIT HOT THREADS — what people are actively discussing right now. These surface live sports moments, viral events, ongoing community attention.

Cluster the combined signals into 6–15 distinct ACTIVE events someone might want to watch on live TV right now. Prioritise:
  - HIGH-INTENSITY local incidents (chemical leaks, evacuations, pursuits, fires) — even if only one source covers them
  - LIVE sports games happening right now
  - BREAKING national/international news with TV broadcast coverage
  - Major weather events

Discard:
  - opinion pieces / op-eds / political commentary
  - week-old news / anniversaries / "remember when" posts
  - generic memes, advertising, off-topic content
  - duplicate framings of the same event across sources

For each event, produce ONE row capturing the most newsworthy framing. Combine signals across both streams when they describe the same event.

Respond with strict JSON. No prose, no markdown fences.`;

const SCHEMA = `{
  "events": [
    {
      "title": "short headline-style name (≤ 80 chars)",
      "type": "fire" | "chase" | "weather" | "disaster" | "protest" | "breaking" | "sport" | "politics" | "other",
      "location": "City, State/Country if extractable, else null",
      "summary": "one sentence, ≤ 160 chars",
      "channel_hints": ["KTLA", "KNBC", "FOX 11 LA", "ABC7 LA", "CNN", …],
      "confidence": "high" | "medium" | "low"
    }
  ]
}

channel_hints guidance — populate generously (5–8 hints per event when possible):

  LOCAL events (any incident with a specific US city/state location):
    Always include 3–6 local broadcast affiliates for that market, then add 1–2 national news as backup.
    City-to-affiliates reference (use the full list for that market, not just one):
      Los Angeles / Orange County / Southern California
        → KTLA, KNBC, KCBS, KCAL 9, KABC, FOX 11 LA, ABC7 LA, KTTV
      San Francisco / Bay Area
        → KGO, KPIX, KRON, KTVU, KNTV, ABC7 BAY AREA
      San Diego
        → KGTV, KFMB, KNSD, KUSI
      New York / NYC
        → WABC, WCBS, WNBC, WNYW, NY1, PIX11, ABC7 NY
      Chicago
        → WGN, WLS, WBBM, WMAQ, ABC7 CHICAGO
      Houston / Dallas / Texas
        → KHOU, KPRC, KTRK, KRIV, WFAA, KDFW
      Atlanta
        → WSB, WXIA, WGCL, WAGA
      Seattle, Phoenix, Miami, Boston, Philadelphia, Detroit, Denver, etc.
        → use ABC/NBC/CBS/FOX affiliate call letters for that market when you can.
    PLUS the national-news catch-alls: CNN, FOX NEWS, MSNBC.

  NATIONAL / international news:
    → CNN, FOX NEWS, MSNBC, BBC NEWS, AL JAZEERA, REUTERS, SKY NEWS

  WEATHER (hurricanes, storms, tornadoes):
    → THE WEATHER CHANNEL, plus local market affiliates for the impact zone.

  SPORTS:
    → ESPN, ESPN2, FOX SPORTS, NBC SPORTS, TNT, league-specific (NHL NETWORK, NFL NETWORK, MLB NETWORK, NBA TV)

Order most-specific (local) first, national as backup. Aim for 5–8 hints.`;

function buildUserPrompt({ threads, articles }) {
  const parts = [];

  if (Array.isArray(articles) && articles.length > 0) {
    const lines = articles.map((a, i) => {
      const age = Math.max(0, Math.round((Date.now() - a.publishedAt) / 60000));
      const country = a.sourceCountry ? `[${a.sourceCountry.slice(0, 14)}]` : '';
      const themes = a.themes?.length ? ` themes=${a.themes.slice(0, 3).join(',')}` : '';
      return `${i + 1}. ${age}m · ${a.domain || '?'} ${country}${themes}: ${a.title}`;
    }).join('\n');
    parts.push(`=== NEWS WIRES (last ~2h, ${articles.length} articles) ===\n${lines}`);
  }

  if (Array.isArray(threads) && threads.length > 0) {
    const lines = threads.map((t, i) => {
      const flair = t.flair ? ` [${t.flair}]` : '';
      return `${i + 1}. r/${t.sub}${flair} (score=${t.score}, ${t.numComments} comments, ${t.ageHours}h old): ${t.title}`;
    }).join('\n');
    parts.push(`=== REDDIT HOT (community attention) ===\n${lines}`);
  }

  if (parts.length === 0) {
    return 'No signals available right now. Return {"events": []}.';
  }

  return parts.join('\n\n') + '\n\nReturn JSON with the clustered events.';
}

/**
 * Synthesize the breaking-events list. Cached globally for 15 minutes.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ events: Array, cachedAt: number, source: 'llm'|'fallback'|'empty' }>}
 */
async function synthesizeEvents({ force = false, onProgress } = {}) {
  // onProgress(ev) — optional callback the streaming route uses to push
  // SSE updates. Shape: { type: 'source_start'|'source_ok'|'source_err'|
  // 'synthesis_start'|'synthesis_ok'|'cache_hit', ...payload }
  const emit = (type, payload = {}) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ type, ...payload }); } catch (_) { /* swallow */ }
  };

  if (!force && synthCache.events && Date.now() - synthCache.ts < SYNTH_CACHE_TTL_MS) {
    emit('cache_hit', { age: Date.now() - synthCache.ts });
    return { events: synthCache.events, cachedAt: synthCache.ts, source: 'llm', fromCache: true };
  }

  const t0 = Date.now();
  // Fire both sources in parallel. Each emits its own start/ok/err
  // so the SSE consumer can show "Reddit: ✓ 50 signals · GDELT: ✗ 429"
  // as soon as each individually settles, rather than waiting for the
  // pair. Promise.all is fine here because each branch swallows its
  // own error and resolves with [].
  const threadsPromise = (async () => {
    const t = Date.now();
    emit('source_start', { source: 'reddit' });
    try {
      const v = await collectHotThreads({ perSub: 8, totalCap: 50 });
      emit('source_ok', { source: 'reddit', count: v.length, ms: Date.now() - t });
      return v;
    } catch (e) {
      emit('source_err', { source: 'reddit', error: e.message, ms: Date.now() - t });
      return [];
    }
  })();
  const articlesPromise = (async () => {
    const t = Date.now();
    emit('source_start', { source: 'gdelt' });
    try {
      const v = await collectArticles({ maxRecords: 120, timespanHours: 2 });
      emit('source_ok', { source: 'gdelt', count: v.length, ms: Date.now() - t });
      return v;
    } catch (e) {
      emit('source_err', { source: 'gdelt', error: e.message, ms: Date.now() - t });
      return [];
    }
  })();
  const [threads, articles] = await Promise.all([threadsPromise, articlesPromise]);
  logger.info(`[BreakingEvents] Collected ${threads.length} hot threads + ${articles.length} GDELT articles in ${Date.now() - t0}ms.`);

  if (threads.length === 0 && articles.length === 0) {
    return { events: [], cachedAt: Date.now(), source: 'empty' };
  }

  if (!isLlmReady()) {
    // LLM unavailable — degrade to a raw-signals view so the user still
    // sees something. Prefer GDELT articles (cleaner headlines) over
    // Reddit threads (more conversational); pad with threads if we're
    // short on articles.
    const fromGdelt = articles.slice(0, 10).map((a) => ({
      title: a.title.slice(0, 160),
      type: classifyArticle(a),
      location: a.sourceCountry || null,
      summary: `${a.domain} — ${Math.round((Date.now() - a.publishedAt) / 60000)}m ago`,
      channel_hints: [],
      confidence: 'low',
      sources: a.url ? [a.url] : []
    }));
    const fromReddit = threads.slice(0, Math.max(0, 12 - fromGdelt.length)).map((t) => ({
      title: t.title.slice(0, 160),
      type: classifyByText(t),
      location: null,
      summary: `r/${t.sub} — ${t.numComments} comments`,
      channel_hints: [],
      confidence: 'low',
      sources: t.permalink ? [t.permalink] : []
    }));
    return {
      events: [...fromGdelt, ...fromReddit],
      cachedAt: Date.now(),
      source: 'fallback'
    };
  }

  emit('synthesis_start', { threadCount: threads.length, articleCount: articles.length });
  const tLlm0 = Date.now();
  const result = await generateJson({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({ threads, articles }),
    schema: SCHEMA,
    maxTokens: 2000,
    temperature: 0.3,
    timeoutMs: 45_000
  });
  const llmMs = Date.now() - tLlm0;
  emit('synthesis_ok', { ms: llmMs, eventCount: result?.events?.length || 0 });
  logger.info(`[BreakingEvents] LLM synthesis returned in ${llmMs}ms.`);

  if (!result || !Array.isArray(result.events)) {
    logger.warn('[BreakingEvents] LLM returned no parseable events; using fallback.');
    const fallback = [
      ...articles.slice(0, 8).map((a) => ({
        title: a.title.slice(0, 160),
        type: classifyArticle(a),
        location: a.sourceCountry || null,
        summary: `${a.domain}`,
        channel_hints: [],
        confidence: 'low',
        sources: a.url ? [a.url] : []
      })),
      ...threads.slice(0, 4).map((t) => ({
        title: t.title.slice(0, 160),
        type: classifyByText(t),
        location: null,
        summary: `r/${t.sub}`,
        channel_hints: [],
        confidence: 'low',
        sources: t.permalink ? [t.permalink] : []
      }))
    ];
    return { events: fallback, cachedAt: Date.now(), source: 'fallback' };
  }

  // Attach source URLs by matching event titles fuzzily against BOTH
  // GDELT articles (preferred — first-party reporting) and Reddit
  // permalinks. Each event gets up to 3 source links.
  const events = result.events.slice(0, 15).map((e) => ({
    title: String(e.title || '').slice(0, 160),
    type: normalizeType(e.type),
    location: e.location || null,
    summary: String(e.summary || '').slice(0, 240),
    channel_hints: Array.isArray(e.channel_hints) ? e.channel_hints.slice(0, 6).map(String) : [],
    confidence: ['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'medium',
    sources: pickRelatedSources(e, articles, threads)
  }));

  synthCache.events = events;
  synthCache.ts = Date.now();
  return { events, cachedAt: synthCache.ts, source: 'llm' };
}

function classifyByText(thread) {
  const t = thread.title.toLowerCase();
  const s = thread.sub.toLowerCase();
  if (s.includes('wildfire') || /fire|wildfire|blaze/.test(t)) return 'fire';
  if (s.includes('policechase') || /pursuit|chase/.test(t)) return 'chase';
  if (s === 'weather' || s.includes('hurricane') || /storm|tornado|hurricane/.test(t)) return 'weather';
  if (['nfl', 'nba', 'baseball', 'hockey', 'soccer', 'sports'].includes(s)) return 'sport';
  if (s === 'politics') return 'politics';
  if (s === 'publicfreakout') return 'breaking';
  return 'breaking';
}

function classifyArticle(article) {
  const t = String(article.title || '').toLowerCase();
  const themes = (article.themes || []).map((x) => String(x).toUpperCase()).join(' ');
  if (themes.includes('WILDFIRE')  || /\b(fire|wildfire|blaze|chemical\s+\w*tank)\b/.test(t)) return 'fire';
  if (themes.includes('TERROR')    || /attack|bombing|shooting|stabbing/.test(t)) return 'breaking';
  if (themes.includes('HURRICANE') || themes.includes('TORNADO') || /hurricane|tornado|storm|flood/.test(t)) return 'weather';
  if (/earthquake|tsunami|volcano|landslide/.test(t)) return 'disaster';
  if (/pursuit|chase|manhunt|standoff|hostage/.test(t)) return 'chase';
  if (/protest|rally|march|demonstrat/.test(t)) return 'protest';
  if (/(game|match|playoff|championship|finals?)\b/.test(t)) return 'sport';
  if (themes.includes('ELECTION') || /election|senate|congress|parliament|president/.test(t)) return 'politics';
  return 'breaking';
}

function normalizeType(t) {
  const v = String(t || '').toLowerCase();
  const allowed = ['fire', 'chase', 'weather', 'disaster', 'protest', 'breaking', 'sport', 'politics', 'other'];
  return allowed.includes(v) ? v : 'breaking';
}

function pickRelatedThreads(event, threads, max = 3) {
  const eventWords = String(event.title || '').toLowerCase()
    .split(/\W+/).filter((w) => w.length > 3);
  if (eventWords.length === 0) return [];
  const scored = threads.map((t) => {
    const words = new Set(t.title.toLowerCase().split(/\W+/));
    const overlap = eventWords.filter((w) => words.has(w)).length;
    return { t, overlap };
  }).filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, max).map((x) => x.t);
}

/**
 * Pick up to 3 source URLs for an event from both GDELT articles
 * (preferred — first-party reporting) and Reddit permalinks. Word-
 * overlap heuristic.
 */
function pickRelatedSources(event, articles, threads, max = 3) {
  const eventWords = String(event.title || '').toLowerCase()
    .split(/\W+/).filter((w) => w.length > 3);
  if (eventWords.length === 0) return [];

  const score = (text) => {
    const words = new Set(String(text).toLowerCase().split(/\W+/));
    return eventWords.filter((w) => words.has(w)).length;
  };

  const articleHits = articles
    .map((a) => ({ url: a.url, overlap: score(a.title), kind: 'article' }))
    .filter((x) => x.overlap > 0 && x.url);

  const threadHits = threads
    .map((t) => ({ url: t.permalink, overlap: score(t.title), kind: 'reddit' }))
    .filter((x) => x.overlap > 0 && x.url);

  // Prefer articles (better source citations); then reddit.
  return [...articleHits, ...threadHits]
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, max)
    .map((x) => x.url);
}

/* ────────── Channel resolution (per-user) ──────────────────────────── */

/**
 * For each event, look up the user's iptv_channels for any of the
 * channel_hints. Returns the event with a `channels` array of
 * { id, name, sourceId, sourceName } tuples (top 3 per event).
 */
async function attachChannelMatches(userId, events) {
  if (!userId || !Array.isArray(events) || events.length === 0) return events;

  // Collect unique normalized hints across all events
  const hintSet = new Set();
  for (const e of events) {
    for (const h of e.channel_hints || []) {
      const norm = String(h).trim();
      if (norm) hintSet.add(norm);
    }
  }
  if (hintSet.size === 0) return events;

  // Resolve hints against the user's channel catalog.
  //
  // We hit `iptv_channels_search` (denormalised shadow with user_id +
  // name_tsv GIN index) for fast token-based matching. A LATERAL join
  // caps each hint at 25 raw matches before the planner gives up, then
  // JS dedupes by normalized name so we don't fill the top 3 with
  // `:ESPN+ 103`, `:ESPN+ 104`, `:ESPN+ 105` near-duplicates.
  //
  // Hint scoring (highest wins):
  //   • word-boundary regex match (`\mESPN\M` in `US: ESPN HD`)   → 0.95
  //   • substring (lower(name) LIKE '%espn%')                     → 0.85
  //   • fallback nothing → row never reaches us via the tsv filter
  //
  // tsvector predicate handles the actual GIN-indexed prefilter so we
  // never scan all 850k channels.
  const hints = Array.from(hintSet);
  const sql = `
    WITH input AS (
      SELECT unnest($1::text[]) AS hint, generate_series(1, array_length($1, 1)) AS ord
    )
    SELECT
      input.hint              AS hint,
      input.ord               AS hint_ord,
      m.channel_id            AS channel_id,
      m.name                  AS name,
      m.source_id             AS source_id,
      m.stream_url            AS stream_url,
      m.logo_url              AS logo_url,
      s.name                  AS source_name,
      s.type                  AS source_type,
      m.sim                   AS sim
    FROM input
    JOIN LATERAL (
      SELECT
        c.channel_id,
        c.name,
        c.source_id,
        c.stream_url,
        c.logo_url,
        CASE
          WHEN lower(c.name) ~ ('\\m' || lower(input.hint) || '\\M') THEN 0.95
          WHEN lower(c.name) LIKE '%' || lower(input.hint) || '%'    THEN 0.85
          ELSE 0
        END AS sim
      FROM iptv_channels_search c
      WHERE c.user_id = $2
        AND c.name_tsv @@ plainto_tsquery('simple', input.hint)
        AND c.name NOT ILIKE '%.mp4%'
        AND c.stream_url IS NOT NULL
      ORDER BY sim DESC, length(c.name) ASC
      LIMIT 25
    ) m ON true
    LEFT JOIN iptv_sources s ON s.id = m.source_id
    WHERE m.sim > 0
    ORDER BY input.ord, m.sim DESC, length(m.name) ASC
  `;

  let rows = [];
  try {
    const result = await pg.query(sql, [hints, userId]);
    rows = result.rows || [];
  } catch (err) {
    logger.warn(`[BreakingEvents] channel match query failed: ${err.message}`);
    return events;
  }

  // Group: hint → up to 3 DISTINCT-by-normalized-name channels.
  // De-dup key: collapse whitespace, strip surrounding punctuation, lower.
  const normalizeName = (n) => String(n || '')
    .toLowerCase()
    .replace(/[^\w\s+]/g, ' ')    // drop punctuation except + (for ESPN+)
    .replace(/\s+/g, ' ')
    .trim();

  const byHint = new Map();
  // 4 channels per hint (was 3). With most LA hints resolving to
  // 2–3 catalog variants ("US: KTLA", "CAR: KTLA", "|CA| KTLA"),
  // bumping to 4 keeps quality high without flooding.
  const PER_HINT = 4;
  for (const r of rows) {
    const list = byHint.get(r.hint) || [];
    if (list.length >= PER_HINT) continue;
    const norm = normalizeName(r.name);
    if (list.some((x) => normalizeName(x.name) === norm)) continue;
    list.push({
      id: r.channel_id,
      name: r.name,
      sourceId: r.source_id,
      sourceName: r.source_name,
      sourceType: r.source_type,    // 'xtream' | 'stalker' | 'm3u' — backend POST fills source auth from this
      url: r.stream_url,            // required by the multiview POST validator
      logo: r.logo_url,
      similarity: Number(r.sim) || 0
    });
    byHint.set(r.hint, list);
  }

  // Attach to each event. Dedupe channels across multiple hints — the
  // same event may surface ESPN via two different hints. Cap at 10
  // per event so a local incident in LA (5+ affiliates × 2–3 variants
  // each) can show every option without scrolling off-screen.
  const PER_EVENT = 10;
  return events.map((e) => {
    const seen = new Set();
    const channels = [];
    for (const h of e.channel_hints || []) {
      const matches = byHint.get(h) || [];
      for (const m of matches) {
        const key = `${m.sourceId}::${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        channels.push({ ...m, matched_hint: h });
        if (channels.length >= PER_EVENT) break;
      }
      if (channels.length >= PER_EVENT) break;
    }
    return { ...e, channels };
  });
}

/**
 * Top-level entrypoint used by the route.
 *
 *   const result = await getBreakingEvents(userId, { force: true });
 *   // { events: […], cachedAt, source }
 */
async function getBreakingEvents(userId, opts = {}) {
  // `opts.onProgress` (if provided) is forwarded into synthesis so
  // the SSE route can stream per-source updates.
  const synth = await synthesizeEvents(opts);
  if (typeof opts.onProgress === 'function') {
    try { opts.onProgress({ type: 'matching_start', count: synth.events.length }); } catch (_) {}
  }
  const events = await attachChannelMatches(userId, synth.events);
  if (typeof opts.onProgress === 'function') {
    try { opts.onProgress({ type: 'matching_ok', count: events.length }); } catch (_) {}
  }
  return { ...synth, events };
}

module.exports = {
  getBreakingEvents,
  synthesizeEvents,
  // Exposed for tests / smoke runs
  _collectHotThreads: collectHotThreads
};
