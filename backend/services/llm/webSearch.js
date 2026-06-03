/**
 * Web-search abstraction — "use whatever's available, smartly."
 *
 * Several of our plugged-in providers can do live web search for free, with
 * very different limits. Rather than hardcode one, this layer registers all
 * available web-search backends and picks among them per request:
 *
 *   • groq    — Groq `compound-mini`: built-in web search (Tavily). Free tier
 *               ~250 req + 70K tok/min. Generous → preferred by default.
 *   • gemini  — Gemini `google_search` grounding. Model configurable; the
 *               default gemini-2.5-flash free tier is only ~20 req/DAY, so
 *               it's a fallback.
 *
 * Selection:
 *   - preference (featureFlags 'web_search_provider'): 'auto' | 'groq' | 'gemini'.
 *       'auto'  → smart order (env WEB_SEARCH_ORDER or built-in AUTO_ORDER).
 *       specific → that provider first, then the others as fallback so a
 *                  rate-limited choice still degrades gracefully.
 *   - availability: only providers whose API key is set.
 *   - health: a provider that 429s is backed off and skipped until it cools
 *             down, so we automatically flow to the next available one.
 *
 * search() returns { text, sources, provider } or null (all unavailable/failed).
 * Never throws to the caller.
 */

const logger = require('../../config/logger');
const featureFlags = require('../featureFlags');

const GEMINI_MODEL = process.env.LLM_GEMINI_GROUNDING_MODEL || 'gemini-2.5-flash';

// ── Provider implementations ──────────────────────────────────────────
// Each run() resolves { text, sources } on success, or throws an Error.
// A rate-limit (429) throw sets err.rateLimited = true so the registry
// can back the provider off and move on.

async function runGroqCompound(prompt, { timeoutMs = 15000, country = 'united states', json = false } = {}) {
  const key = process.env.LLM_API_KEY_GROQ;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.LLM_GROQ_SEARCH_MODEL || 'groq/compound-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1500,
        // JSON object mode forces structured output — without it the
        // compound model intermittently returns a prose refusal
        // ("I'm sorry, …") that fails JSON parsing downstream.
        response_format: json ? { type: 'json_object' } : undefined,
        search_settings: country ? { country } : undefined,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { const e = new Error('groq 429'); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error(`groq HTTP ${res.status}`);
    const payload = await res.json();
    const msg = payload?.choices?.[0]?.message;
    const text = msg?.content || '';
    if (!text) throw new Error('groq empty content');
    const executed = Array.isArray(msg?.executed_tools) ? msg.executed_tools : [];
    const sources = executed.filter((t) => /search/i.test(t?.type || t?.name || '')).length || (executed.length ? 1 : 0);
    return { text, sources };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function runGeminiGrounding(prompt, { timeoutMs = 15000 } = {}) {
  const key = process.env.LLM_API_KEY_GEMINI;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { const e = new Error('gemini 429'); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
    const json = await res.json();
    const cand = json?.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('gemini empty content');
    const sources = (cand?.groundingMetadata?.groundingChunks || []).length;
    return { text, sources };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

const PROVIDERS = {
  groq:   { id: 'groq',   label: 'Groq Compound',     keyEnv: 'LLM_API_KEY_GROQ',   run: runGroqCompound },
  gemini: { id: 'gemini', label: 'Gemini Grounding',  keyEnv: 'LLM_API_KEY_GEMINI', run: runGeminiGrounding },
};

const AUTO_ORDER = (process.env.WEB_SEARCH_ORDER || 'groq,gemini')
  .split(',').map((s) => s.trim()).filter((id) => PROVIDERS[id]);

// ── Health tracking ───────────────────────────────────────────────────
const health = {}; // id -> { rateLimitedUntil, fails, ok, lastUsed, lastError }
for (const id of Object.keys(PROVIDERS)) health[id] = { rateLimitedUntil: 0, fails: 0, ok: 0, lastUsed: 0, lastError: null };

const isProviderAvailable = (id) => Boolean(process.env[PROVIDERS[id].keyEnv]);
const isProviderHealthy = (id, now) => health[id].rateLimitedUntil <= now;

function markRateLimited(id, now, retryAfterMs) {
  const h = health[id];
  h.fails += 1;
  // Flat ~60s backoff (or the server-provided retry-after). Groq's limits are
  // largely PER-MINUTE, so a short cooldown lets it recover fast; Gemini's
  // daily cap will just re-trip this harmlessly. An escalating multi-minute
  // backoff (the old behaviour) kept providers cold long after they'd reset.
  const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(5 * 60 * 1000, retryAfterMs)
    : 60 * 1000;
  h.rateLimitedUntil = now + backoff;
  h.lastError = 'rate-limited';
}

/** Any web-search provider configured at all? */
function isAvailable() {
  return Object.keys(PROVIDERS).some(isProviderAvailable);
}

function getPreference() {
  const p = featureFlags.getValue('web_search_provider', 'auto');
  return (p === 'groq' || p === 'gemini' || p === 'auto') ? p : 'auto';
}

// Build the ordered try-list given the preference, availability and health.
function buildOrder(now) {
  const pref = getPreference();
  let order = pref === 'auto' ? [...AUTO_ORDER] : [pref, ...AUTO_ORDER.filter((id) => id !== pref)];
  order = order.filter(isProviderAvailable);
  // Prefer healthy providers, but keep rate-limited ones at the end as a
  // last resort (better to retry a cooling provider than return nothing).
  const healthy = order.filter((id) => isProviderHealthy(id, now));
  const cooling = order.filter((id) => !isProviderHealthy(id, now));
  return [...healthy, ...cooling];
}

/**
 * Run a web search through the best available provider.
 * @returns {Promise<{text:string, sources:number, provider:string}|null>}
 */
async function search(prompt, opts = {}) {
  const now = Date.now();
  const order = buildOrder(now);
  if (order.length === 0) return null;

  for (const id of order) {
    const h = health[id];
    try {
      const { text, sources } = await PROVIDERS[id].run(prompt, opts);
      h.ok += 1;
      h.fails = 0;
      h.rateLimitedUntil = 0;
      h.lastUsed = Date.now();
      h.lastError = null;
      logger.info(`[WebSearch] ${id} ok (${sources} sources)`);
      return { text, sources, provider: id };
    } catch (err) {
      if (err.rateLimited) {
        markRateLimited(id, Date.now());
        logger.info(`[WebSearch] ${id} rate-limited → next provider`);
      } else {
        h.fails += 1;
        h.lastError = err.message;
        logger.warn(`[WebSearch] ${id} failed: ${err.message} → next provider`);
      }
      // try next provider
    }
  }
  logger.warn('[WebSearch] all providers failed/exhausted');
  return null;
}

/** Snapshot for the dashboard. */
function getStatus() {
  const now = Date.now();
  return {
    preference: getPreference(),
    autoOrder: AUTO_ORDER,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      available: isProviderAvailable(p.id),
      rateLimited: !isProviderHealthy(p.id, now),
      ok: health[p.id].ok,
      fails: health[p.id].fails,
      lastUsed: health[p.id].lastUsed || null,
      lastError: health[p.id].lastError,
    })),
  };
}

module.exports = { search, isAvailable, getStatus, getPreference, PROVIDER_IDS: Object.keys(PROVIDERS) };
