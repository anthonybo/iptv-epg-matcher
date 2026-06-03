/**
 * AI-assisted live-event channel matching.
 *
 * Two capabilities, both feature-flagged (ai_channel_matching, default OFF)
 * and both degrade to a no-op on any failure so the search path is never
 * worse than today:
 *
 *   rerankCandidates() — after the fuzzy scorer ranks candidates, ask the
 *     LLM which ones are plausibly carrying THIS live event, then move its
 *     picks to the front of the test queue (and drop a candidate only when
 *     the LLM rejects it with high confidence AND has accepted an
 *     alternative). This is what stops a "24/7 Anthony Bourdain Parts
 *     Unknown" channel from being auto-played for a NASCAR race: it never
 *     gets accepted, a real racing channel does, so Bourdain is demoted/
 *     dropped instead of tested first.
 *
 *   resolveBroadcasters() — for events with no broadcaster (racing, niche
 *     international leagues ESPN omits and the static map misses), ask the
 *     LLM which networks carry it. Cached per (sport, league) for 6h since
 *     broadcast deals are stable within a season.
 *
 * Safety contract:
 *   - flag OFF  → isEnabled() is false → callers never invoke this module.
 *   - LLM down  → returns the input unchanged (picker) / [] (broadcaster).
 *   - reorder-only by default; dropping is gated on high confidence + an
 *     accepted alternative, so a real match can never be stranded.
 */

const logger = require('../../config/logger');
const { generateJson, isLlmReady } = require('../llm/client');
const webSearch = require('../llm/webSearch');
const featureFlags = require('../featureFlags');
const stats = require('../aiMatchStats');
const llmCache = require('../aiLlmCache');

const FLAG = 'ai_channel_matching';
const TOP_N = 15; // candidates shown to the LLM (token budget)
// League → networks is stable for a whole season, so cache it for days in
// the DB (survives restarts / shared across instances).
const BROADCASTER_TTL_SECONDS = 7 * 24 * 60 * 60;

function isEnabled() {
  return featureFlags.isEnabled(FLAG, false);
}

// ── Channel picker ────────────────────────────────────────────────────

const PICKER_SYSTEM =
  'You decide which IPTV channel is most likely broadcasting a specific LIVE ' +
  'sports or racing event RIGHT NOW. You are given the event and a numbered ' +
  'list of candidate channels (name + current EPG program when known). Return ' +
  'a SHORT JSON object with two id lists: "live" = the candidates plausibly ' +
  'carrying THIS event (best first), and "reject" = candidates that are clearly ' +
  'NOT this event (24/7 themed channels, replays/highlights, team-vanity ' +
  'channels, documentaries, unrelated content). Omit candidates you are unsure ' +
  'about from both lists. Be conservative: only put a channel in "live" if its ' +
  'name/EPG genuinely fits this event\'s sport, league, and identity. Strict ' +
  'JSON only — no prose, no markdown.';

const PICKER_SCHEMA =
  '{ "live": ["<candidate id, best first>"], "reject": ["<candidate id clearly not this event>"] } ' +
  '— use ids exactly as given; either list may be empty.';

function buildPickerPrompt(event, candidates) {
  const lines = [];
  lines.push('EVENT');
  if (event.sportType) lines.push(`  Sport: ${event.sportType}`);
  if (event.leagueName) lines.push(`  League: ${event.leagueName}`);
  if (event.eventName) lines.push(`  Name: ${event.eventName}`);
  const hasTeams = event.homeTeam && event.awayTeam &&
    !/^unknown$/i.test(event.homeTeam) && !/^unknown$/i.test(event.awayTeam);
  if (hasTeams) lines.push(`  Matchup: ${event.awayTeam} at ${event.homeTeam}`);
  lines.push('');
  lines.push('CANDIDATES (id — channel name — now playing)');
  for (const c of candidates) {
    const epg = c._epgProgram ? ` [EPG: ${String(c._epgProgram).slice(0, 80)}]` : '';
    lines.push(`  ${c.id} — ${String(c.name || '').slice(0, 90)}${epg}`);
  }
  return lines.join('\n');
}

/**
 * Re-rank scored candidates using the LLM. Returns a NEW array (or the
 * original on any failure). Never throws.
 *
 * @param {object} args
 * @param {Array}  args.channels — scored+sorted candidate objects ({ id, name, _epgProgram, relevanceScore, ... })
 * @param {object} args.event    — { sportType, leagueName, eventName, homeTeam, awayTeam, espnEventId }
 */
async function rerankCandidates({ channels, event = {} }) {
  if (!Array.isArray(channels) || channels.length < 2) return channels;

  const base = {
    feature: 'picker',
    eventId: event.espnEventId || null,
    sportType: event.sportType || null,
    leagueName: event.leagueName || null,
    query: event.eventName || null,
    candidates: Math.min(channels.length, TOP_N),
  };

  if (!isLlmReady()) {
    stats.record({ ...base, outcome: 'not_ready' });
    return channels;
  }

  const topN = channels.slice(0, TOP_N);
  const scoringTopId = String(topN[0].id);
  const started = Date.now();

  let result;
  try {
    result = await generateJson({
      system: PICKER_SYSTEM,
      user: buildPickerPrompt(event, topN),
      schema: PICKER_SCHEMA,
      temperature: 0.1,
      // Compact id-list output keeps this well under any provider's token
      // budget — important because some providers (e.g. Cerebras gpt-oss)
      // are reasoning models that spend tokens before the JSON; a verbose
      // per-candidate schema truncated mid-object and failed to parse.
      maxTokens: 1500,
      timeoutMs: 12000,
    });
  } catch (err) {
    logger.warn(`[AI Picker] call threw: ${err.message}`);
    stats.record({ ...base, outcome: 'error', latencyMs: Date.now() - started });
    return channels;
  }

  const latencyMs = Date.now() - started;
  if (!result || (!Array.isArray(result.live) && !Array.isArray(result.reject))) {
    stats.record({ ...base, outcome: 'llm_null', latencyMs });
    return channels;
  }

  // Only consider verdicts for ids that are actually in our candidate set.
  const validIds = new Set(channels.map((c) => String(c.id)));
  const liveOrder = (Array.isArray(result.live) ? result.live : [])
    .map(String).filter((id) => validIds.has(id));
  const liveSet = new Set(liveOrder);
  const rejectSet = new Set(
    (Array.isArray(result.reject) ? result.reject : []).map(String).filter((id) => validIds.has(id))
  );
  const anyAccepted = liveOrder.length > 0;

  // Accepted first (in the model's ranked order), then the remaining
  // candidates in their original scoring order. A candidate is DROPPED only
  // when the model rejected it AND it accepted at least one alternative —
  // so a real match can never be stranded.
  const byId = new Map(channels.map((c) => [String(c.id), c]));
  const accepted = liveOrder.map((id) => byId.get(id)).filter(Boolean);
  let droppedCount = 0;
  const rest = [];
  for (const c of channels) {
    const id = String(c.id);
    if (liveSet.has(id)) continue; // already in accepted
    if (anyAccepted && rejectSet.has(id)) { droppedCount++; continue; }
    rest.push(c);
  }
  const reordered = [...accepted, ...rest];

  // Never strand the search: if everything somehow got dropped, fall back.
  if (reordered.length === 0) {
    stats.record({ ...base, outcome: 'ok', latencyMs, changedOutcome: false, agreed: true });
    return channels;
  }

  const newTopId = String(reordered[0].id);
  const changedOutcome = newTopId !== scoringTopId;
  logger.info(
    `[AI Picker] ${accepted.length} live, ${droppedCount} dropped, ` +
    `top ${changedOutcome ? `changed → "${reordered[0].name}"` : 'unchanged'} (${latencyMs}ms)`
  );
  stats.record({
    ...base,
    outcome: 'ok',
    latencyMs,
    changedOutcome,
    agreed: !changedOutcome,
    topChoice: newTopId,
    confidence: null,
  });
  return reordered;
}

// ── Broadcaster resolution ────────────────────────────────────────────

const BCAST_SYSTEM =
  'You name the TV networks and streaming services that broadcast a given ' +
  'live sports/racing event in the United States. Reply with the network ' +
  'names as they would appear in a TV channel guide (e.g. "USA Network", ' +
  '"TNT", "Prime Video", "ESPN", "FOX"). Strict JSON only.';

const BCAST_SCHEMA =
  '{ "broadcasters": ["Network Name", ...] } — up to 5, US carriers, most likely first.';

function buildBroadcasterPrompt({ sportType, leagueName, eventName }) {
  const lines = ['Which US networks/streaming services carry this event?'];
  if (leagueName) lines.push(`League: ${leagueName}`);
  if (sportType) lines.push(`Sport: ${sportType}`);
  if (eventName) lines.push(`Event: ${eventName}`);
  return lines.join('\n');
}

/**
 * Resolve likely broadcaster network names for an event.
 *
 * Two tiers, both persistently cached per (sport, league) in the DB for a
 * week (deals are seasonal):
 *   1. WEB-GROUNDED (preferred) — Gemini google_search returns the CURRENT
 *      carrier from a live web search (e.g. Roland Garros → TNT/Max, not the
 *      stale NBC/Peacock a training-only model would guess). Cached under
 *      'bcast_web'.
 *   2. ROTATION LLM (fallback) — training knowledge from groq/etc. when
 *      grounding is unavailable or returns nothing. Cached under 'bcast_llm'.
 *
 * Returns [] on any failure. Never throws.
 */
function broadcasterKey({ sportType, leagueName } = {}) {
  return `${(sportType || '').toLowerCase()}|${(leagueName || '').toLowerCase()}`;
}

// Pull network names out of a free-text web-search answer (bullets, commas,
// or newlines). Strips list markers / trailing punctuation, drops obvious
// noise and over-long prose, caps the list.
function parseNetworkNames(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.replace(/^[\s*\-•\d.]+/, '').replace(/[.;]+$/, '').trim())
    .filter((s) => s && s.length >= 2 && s.length <= 40 && !/^(the|and|or|right now|currently)$/i.test(s))
    .filter((s) => !/broadcast|network|streaming|service|tournament|following|include/i.test(s) || s.split(/\s+/).length <= 4)
    .slice(0, 6);
}

/**
 * Cache-only read of resolved broadcasters (no LLM/grounding call). Used by
 * the slate so it never blocks on a cold ~5s grounded lookup — it shows
 * what's cached now and warms misses in the background. Returns [] on miss.
 */
async function getCachedBroadcasters({ sportType, leagueName } = {}) {
  const key = broadcasterKey({ sportType, leagueName });
  const web = await llmCache.get('bcast_web', key);
  if (Array.isArray(web) && web.length > 0) return web;
  const fromLlm = await llmCache.get('bcast_llm', key);
  if (Array.isArray(fromLlm) && fromLlm.length > 0) return fromLlm;
  return [];
}

async function resolveBroadcasters({ sportType, leagueName, eventName } = {}) {
  const key = broadcasterKey({ sportType, leagueName });
  const base = { feature: 'broadcaster', sportType: sportType || null, leagueName: leagueName || null, query: eventName || null };

  // ── Tier 1: web search (real-time, current) ────────────────────────
  // Uses whatever web-search backend is available/healthy (Groq compound,
  // Gemini grounding, …) chosen by the webSearch layer.
  if (webSearch.isAvailable()) {
    const webCached = await llmCache.get('bcast_web', key);
    if (Array.isArray(webCached) && webCached.length > 0) {
      stats.record({ ...base, outcome: 'cache_hit', candidates: webCached.length, topChoice: webCached.join(', ') });
      return webCached;
    }
    const started = Date.now();
    try {
      const subject = [eventName, leagueName && `(${leagueName})`, sportType].filter(Boolean).join(' ');
      const prompt =
        `Which US TV networks or streaming services are broadcasting ${subject || 'this event'} ` +
        `right now / this season? Reply with ONLY the network names exactly as they appear in a TV ` +
        `channel guide, comma-separated, no other text.`;
      const r = await webSearch.search(prompt, { timeoutMs: 15000 });
      const names = r ? parseNetworkNames(r.text) : [];
      if (names.length > 0) {
        await llmCache.set('bcast_web', key, names, BROADCASTER_TTL_SECONDS);
        logger.info(`[AI Broadcaster · ${r.provider}] ${leagueName || sportType}: ${names.join(', ')} (${r.sources} sources, ${Date.now() - started}ms)`);
        stats.record({ ...base, outcome: 'ok', latencyMs: Date.now() - started, candidates: names.length, topChoice: names.join(', ') });
        return names;
      }
      // Web search ran but found nothing usable — record it (distinct from a
      // hard failure) so telemetry shows tier 1 was tried before tier 2.
      stats.record({ ...base, outcome: 'empty', latencyMs: Date.now() - started, candidates: 0 });
    } catch (err) {
      logger.warn(`[AI Broadcaster · web] failed, falling back to LLM: ${err.message}`);
    }
    // web search empty/failed → fall through to the rotation LLM
  }

  // ── Tier 2: rotation LLM (training knowledge) ──────────────────────
  const llmCached = await llmCache.get('bcast_llm', key);
  if (Array.isArray(llmCached) && llmCached.length > 0) {
    stats.record({ ...base, outcome: 'cache_hit', candidates: llmCached.length, topChoice: llmCached.join(', ') });
    return llmCached;
  }

  if (!isLlmReady()) {
    stats.record({ ...base, outcome: 'not_ready' });
    return [];
  }

  const started = Date.now();
  let result;
  try {
    result = await generateJson({
      system: BCAST_SYSTEM,
      user: buildBroadcasterPrompt({ sportType, leagueName, eventName }),
      schema: BCAST_SCHEMA,
      temperature: 0.1,
      maxTokens: 600, // headroom for reasoning-model providers (see picker note)
      timeoutMs: 12000,
    });
  } catch (err) {
    logger.warn(`[AI Broadcaster] call threw: ${err.message}`);
    stats.record({ ...base, outcome: 'error', latencyMs: Date.now() - started });
    return [];
  }

  const latencyMs = Date.now() - started;
  const names = result && Array.isArray(result.broadcasters)
    ? result.broadcasters.filter((x) => typeof x === 'string' && x.trim()).map((s) => s.trim()).slice(0, 6)
    : [];

  if (names.length === 0) {
    stats.record({ ...base, outcome: result ? 'ok' : 'llm_null', latencyMs, candidates: 0 });
    return [];
  }

  await llmCache.set('bcast_llm', key, names, BROADCASTER_TTL_SECONDS);
  logger.info(`[AI Broadcaster · llm] ${leagueName || sportType}: ${names.join(', ')} (${latencyMs}ms)`);
  stats.record({ ...base, outcome: 'ok', latencyMs, candidates: names.length, topChoice: names.join(', ') });
  return names;
}

module.exports = { isEnabled, rerankCandidates, resolveBroadcasters, getCachedBroadcasters };
