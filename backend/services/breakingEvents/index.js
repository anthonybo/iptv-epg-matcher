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
const webSearch = require('../llm/webSearch');
const pg = require('../postgresService');

const SYNTH_CACHE_TTL_MS = 15 * 60 * 1000;
const synthCache = { ts: 0, events: null };

// Web-grounded breaking events run ALONGSIDE the Reddit/GDELT synthesizer
// (which is left untouched). They backstop the common case where both free
// feeds are rate-limited (429) and enrich the populated case. Cached
// user-independently like synthCache.
const GROUNDED_CACHE_TTL_MS = 15 * 60 * 1000;
const groundedCache = { ts: 0, events: null };

// Per-user cache of channel-MATCHED events. attachChannelMatches is the
// expensive step (it scans the 874k-row iptv_channels_search shadow). The
// synthesized+grounded events are stable for ~15 min, so the matched
// result is too — caching it keeps repeated polls/refreshes instant
// instead of re-running the match each time. Keyed by userId; a content
// signature guards against serving stale matches when the events change.
const MATCH_CACHE_TTL_MS = 15 * 60 * 1000;
const matchCache = new Map(); // userId -> { ts, sig, events }

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
/**
 * ADDITIVE source: query the live web (Gemini google_search grounding) for
 * what's breaking RIGHT NOW. This does NOT replace the Reddit/GDELT
 * synthesizer — it runs alongside it. It's the reliable path when both free
 * feeds are 429'd (which is most of the time), and otherwise enriches the
 * synthesized set. User-independent, cached 15 min. Returns [] on any
 * failure / when grounding isn't configured.
 */
async function fetchGroundedBreaking({ force = false } = {}) {
  if (!webSearch.isAvailable()) return [];
  if (!force && groundedCache.events && Date.now() - groundedCache.ts < GROUNDED_CACHE_TTL_MS) {
    return groundedCache.events;
  }
  const prompt =
    'What are the most significant BREAKING news events and major live happenings in the ' +
    'United States RIGHT NOW (active wildfires, severe weather, police chases / manhunts / ' +
    'standoffs, major sports moments, and major breaking national news)? Respond with ONLY a ' +
    'JSON object {"events":[ ... ]}, max 10 events, each: {"title":"short headline","type":' +
    '"fire|chase|weather|disaster|protest|breaking|sport|politics|other","location":"city, ST ' +
    'or null","summary":"one sentence","channel_hints":[...]}.\n' +
    'channel_hints MUST be actual TELEVISION channels a viewer could tune to that are likely ' +
    'airing coverage of this story: relevant national news/weather networks (e.g. CNN, Fox ' +
    'News, MSNBC, The Weather Channel, ABC News, NBC News, CBS News; ESPN/Fox Sports for ' +
    'sports) AND, for a LOCAL story, the specific local TV affiliate CALL LETTERS for that ' +
    'city (for example Albuquerque/New Mexico → KOB, KOAT, KRQE; Los Angeles → KTLA, KABC, ' +
    'KNBC). Give 4-6. NEVER list government agencies (e.g. NIFC), websites, apps, fire/weather ' +
    'maps, wire services, or generic phrases like "local news" — ONLY real broadcast TV ' +
    'channel names/call letters.\n' +
    'No prose, no markdown.';

  let r;
  try {
    // json:true → forces structured output (Groq compound otherwise
    // intermittently returns a prose refusal that fails to parse).
    r = await webSearch.search(prompt, { timeoutMs: 20000, json: true });
  } catch (err) {
    logger.warn(`[BreakingEvents:grounded] call failed: ${err.message}`);
    return groundedCache.events || [];
  }
  if (!r || !r.text) return groundedCache.events || [];

  let arr;
  try {
    let txt = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Accept either {"events":[...]} (JSON object mode) or a bare [...]
    // array (some providers ignore json mode). Slice to the JSON payload.
    const objStart = txt.indexOf('{');
    const arrStart = txt.indexOf('[');
    if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
      const end = txt.lastIndexOf(']');
      if (end > arrStart) arr = JSON.parse(txt.slice(arrStart, end + 1));
    } else if (objStart !== -1) {
      const end = txt.lastIndexOf('}');
      const obj = JSON.parse(txt.slice(objStart, end + 1));
      arr = Array.isArray(obj) ? obj : (Array.isArray(obj.events) ? obj.events : []);
    }
  } catch (err) {
    logger.warn(`[BreakingEvents:grounded] JSON parse failed: ${err.message}`);
    return groundedCache.events || [];
  }
  if (!Array.isArray(arr)) return groundedCache.events || [];

  const events = arr.slice(0, 10).map((e) => ({
    title: String(e.title || '').slice(0, 160),
    type: normalizeType(e.type),
    location: e.location || null,
    summary: String(e.summary || '').slice(0, 240),
    channel_hints: Array.isArray(e.channel_hints) ? e.channel_hints.slice(0, 6).map(String) : [],
    confidence: ['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'high',
    sources: [],
    grounded: true,
  })).filter((e) => e.title);

  groundedCache.events = events;
  groundedCache.ts = Date.now();
  logger.info(`[BreakingEvents:grounded] ${events.length} web-grounded events (${r.sources} sources)`);
  return events;
}

// Merge grounded events into the synthesized set, deduped by a normalized
// title so the same story from both pipelines shows once. Synthesized
// (Reddit/GDELT) events keep priority/order; grounded extras are appended.
function mergeBreaking(primary, grounded) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set((primary || []).map((e) => norm(e.title)));
  const extra = (grounded || []).filter((e) => {
    const k = norm(e.title);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...(primary || []), ...extra].slice(0, 20);
}

/* ────────── DB persistence (preload + background refresh) ──────────── */
// Events persist so the tab can show the last-known still-active set
// instantly while a fresh pull runs. User-independent (no channel data).
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000; // an event stays "active" 3h after last seen

const eventKey = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);

// Fire-and-forget UPSERT of the merged event set, refreshing last_seen /
// expires_at for stories seen again. Prunes expired rows opportunistically.
function persistEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const sql = `
    INSERT INTO breaking_events
      (event_key, title, type, location, summary, channel_hints, confidence, grounded, sources, last_seen, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb, CURRENT_TIMESTAMP, $10)
    ON CONFLICT (event_key) DO UPDATE SET
      title = EXCLUDED.title, type = EXCLUDED.type, location = EXCLUDED.location,
      summary = EXCLUDED.summary, channel_hints = EXCLUDED.channel_hints,
      confidence = EXCLUDED.confidence, grounded = breaking_events.grounded OR EXCLUDED.grounded,
      sources = EXCLUDED.sources, last_seen = CURRENT_TIMESTAMP, expires_at = EXCLUDED.expires_at
  `;
  const expires = new Date(Date.now() + ACTIVE_WINDOW_MS).toISOString();
  Promise.all(events.map((e) => {
    const k = eventKey(e.title);
    if (!k) return Promise.resolve();
    return pg.query(sql, [
      k, String(e.title || '').slice(0, 200), e.type || null, e.location || null,
      String(e.summary || '').slice(0, 400), JSON.stringify(e.channel_hints || []),
      e.confidence || null, Boolean(e.grounded), JSON.stringify(e.sources || []), expires,
    ]).catch(() => {});
  }))
    .then(() => pg.query('DELETE FROM breaking_events WHERE expires_at < CURRENT_TIMESTAMP').catch(() => {}))
    .catch((err) => logger.warn(`[BreakingEvents] persist failed: ${err.message}`));
}

// Load the still-active persisted events (user-independent).
async function loadPersistedActive(limit = 20) {
  try {
    const { rows } = await pg.query(
      `SELECT title, type, location, summary, channel_hints, confidence, grounded, sources
         FROM breaking_events
        WHERE expires_at > CURRENT_TIMESTAMP
        ORDER BY last_seen DESC
        LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      title: r.title,
      type: normalizeType(r.type),
      location: r.location || null,
      summary: r.summary || '',
      channel_hints: Array.isArray(r.channel_hints) ? r.channel_hints : [],
      confidence: r.confidence || 'medium',
      grounded: Boolean(r.grounded),
      sources: Array.isArray(r.sources) ? r.sources : [],
    }));
  } catch (err) {
    logger.warn(`[BreakingEvents] loadPersistedActive failed: ${err.message}`);
    return [];
  }
}

/**
 * Instant preload: the last-known still-active events from the DB, with this
 * user's channel matches attached. Returns { events, source, count } — used
 * by the SSE route to populate the tab immediately before the live refresh.
 */
async function getPersistedBreakingEvents(userId) {
  const persisted = await loadPersistedActive(20);
  if (persisted.length === 0) return { events: [], source: 'db-empty', count: 0 };
  const events = await attachChannelMatches(userId, persisted);
  return { events, source: 'db-cache', count: events.length };
}

async function getBreakingEvents(userId, opts = {}) {
  // `opts.onProgress` (if provided) is forwarded into synthesis so
  // the SSE route can stream per-source updates.
  const emit = (type, payload = {}) => {
    if (typeof opts.onProgress !== 'function') return;
    try { opts.onProgress({ type, ...payload }); } catch (_) {}
  };

  // Run the (untouched) Reddit/GDELT synthesizer and the additive
  // web-grounded source IN PARALLEL — grounding no longer waits for the
  // ~20s Reddit/GDELT backoff to finish first.
  const groundingOn = webSearch.isAvailable();
  if (groundingOn) emit('source_start', { source: 'grounding' });
  const groundedT0 = Date.now();
  const [synth, grounded] = await Promise.all([
    synthesizeEvents(opts),
    groundingOn
      ? fetchGroundedBreaking({ force: opts.force })
          .then((g) => {
            const ms = Date.now() - groundedT0;
            if (g.length === 0) {
              // Be honest in the UI: "rate-limited" (all backends throttled)
              // vs "found nothing", instead of a misleading 0.
              const ws = webSearch.getStatus();
              const allLimited = (ws.providers || []).filter((p) => p.available).every((p) => p.rateLimited);
              if (allLimited) emit('source_err', { source: 'grounding', error: 'rate-limited', ms });
              else emit('source_ok', { source: 'grounding', count: 0, ms });
            } else {
              emit('source_ok', { source: 'grounding', count: g.length, ms });
            }
            return g;
          })
          .catch(() => { emit('source_err', { source: 'grounding', ms: Date.now() - groundedT0 }); return []; })
      : Promise.resolve([]),
  ]);

  const merged = mergeBreaking(synth.events, grounded);
  // Persist the merged (user-independent) set so subsequent loads can preload
  // it instantly while a fresh pull runs in the background. Fire-and-forget.
  if (merged.length > 0) persistEvents(merged);
  emit('matching_start', { count: merged.length });

  // Per-user matched-events cache: skip the expensive channel match when
  // the merged event set is unchanged and still fresh.
  const sig = `${merged.length}:${merged.map((e) => e.title).join('|')}`;
  const cachedMatch = matchCache.get(userId);
  let events;
  if (!opts.force && cachedMatch && cachedMatch.sig === sig && Date.now() - cachedMatch.ts < MATCH_CACHE_TTL_MS) {
    events = cachedMatch.events;
  } else {
    events = await attachChannelMatches(userId, merged);
    matchCache.set(userId, { ts: Date.now(), sig, events });
  }
  emit('matching_ok', { count: events.length });

  // Reflect that grounding contributed, so the UI isn't "empty" when the
  // synthesizer struck out but grounding found events.
  const source = synth.source === 'empty'
    ? (grounded.length > 0 ? 'grounded' : 'empty')
    : (grounded.length > 0 ? `${synth.source}+grounded` : synth.source);

  return { ...synth, events, source };
}

/* ────────── Match-index warmer ─────────────────────────────────────── */

// The channel-match query is ~70ms warm but ~40s COLD — the first hit after
// the 874k-row iptv_channels_search GIN index + heap pages get evicted has
// to read them from disk. There's no background synthesis schedule, so the
// first user to open the Breaking tab would eat that cold cost. This warmer
// runs the real match (via attachChannelMatches with common news/sports
// hints) shortly after boot and on an interval, keeping those pages hot so
// user-facing matches stay fast.
const WARM_HINTS = [
  'CNN', 'FOX NEWS', 'MSNBC', 'ESPN', 'THE WEATHER CHANNEL', 'ABC NEWS',
  'NBC NEWS', 'CBS NEWS', 'BBC NEWS', 'FOX SPORTS 1', 'KTLA', 'NEWSNATION',
];
let warmerStarted = false;

async function warmMatchCache() {
  try {
    const u = await pg.query('SELECT DISTINCT user_id FROM iptv_channels_search WHERE user_id IS NOT NULL LIMIT 5');
    const t = Date.now();
    for (const row of u.rows) {
      // Reuse the exact match path so we warm precisely the pages it reads.
      await attachChannelMatches(row.user_id, [{ channel_hints: WARM_HINTS, title: 'warm', type: 'other', summary: '', location: null }]).catch(() => {});
    }
    logger.info(`[BreakingEvents] match index warmed for ${u.rows.length} user(s) in ${Date.now() - t}ms`);
  } catch (err) {
    logger.warn(`[BreakingEvents] match warm failed: ${err.message}`);
  }
}

/** Start the background warmer (call once from server boot). */
function startMatchWarmer() {
  if (warmerStarted) return;
  warmerStarted = true;
  setTimeout(() => { warmMatchCache(); }, 30 * 1000);          // ~30s after boot
  setInterval(() => { warmMatchCache(); }, 10 * 60 * 1000);    // every 10 min
  logger.info('[BreakingEvents] match-index warmer scheduled');
}

module.exports = {
  getBreakingEvents,
  getPersistedBreakingEvents,
  synthesizeEvents,
  startMatchWarmer,
  // Exposed for tests / smoke runs
  _collectHotThreads: collectHotThreads
};
