/**
 * Free-tier LLM provider registry — rotates between OpenAI-compatible
 * cloud providers so we never get stuck behind one provider's rate
 * limits. Ported from the stormwire project (TypeScript → JavaScript,
 * cloud-only — no local-llama support).
 *
 * Providers (all free tier):
 *   - Groq         · llama-3.3-70b-versatile          · 30 RPM
 *   - Cerebras     · gpt-oss-120b                      · 30 RPM
 *   - Gemini       · gemini-2.5-flash                  · 15 RPM, 1500 RPD
 *   - SambaNova    · Meta-Llama-3.3-70B-Instruct       · daily quota
 *   - Mistral      · mistral-small-latest              · 1 RPS
 *
 * Env vars (mirror stormwire's so the same keys work in both projects):
 *   LLM_ENABLED=true|false
 *   LLM_PROVIDER=rotation                      (preferred — uses all keys below)
 *   LLM_ROTATION_ORDER=groq,cerebras,gemini    (optional; defaults to all-with-keys)
 *   LLM_API_KEY_GROQ=…
 *   LLM_API_KEY_CEREBRAS=…
 *   LLM_API_KEY_GEMINI=…
 *   LLM_API_KEY_SAMBANOVA=…
 *   LLM_API_KEY_MISTRAL=…
 *
 * The registry tracks per-provider quota by parsing standard
 * `x-ratelimit-*` response headers — when a provider returns 0 daily
 * requests remaining, it's auto-paused until the reset timestamp.
 */

const logger = require('../../config/logger');

// ── Provider definitions (all OpenAI-compatible) ────────────────────

const CLOUD_PROVIDERS = {
  groq:      { name: 'groq',      baseUrl: 'https://api.groq.com/openai/v1',                          defaultModel: 'llama-3.3-70b-versatile' },
  cerebras:  { name: 'cerebras',  baseUrl: 'https://api.cerebras.ai/v1',                              defaultModel: 'gpt-oss-120b' },
  gemini:    { name: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',defaultModel: 'gemini-2.5-flash' },
  sambanova: { name: 'sambanova', baseUrl: 'https://api.sambanova.ai/v1',                             defaultModel: 'Meta-Llama-3.3-70B-Instruct' },
  mistral:   { name: 'mistral',   baseUrl: 'https://api.mistral.ai/v1',                               defaultModel: 'mistral-small-latest' }
};

// ── Module-level state ──────────────────────────────────────────────

/** @type {Array<ProviderState>} */
let providers = [];

/**
 * @typedef {Object} ProviderState
 * @property {string} name
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {number} rateLimitedUntil      epoch ms; 0 = available
 * @property {number} consecutiveFailures
 * @property {number} lastUsed              epoch ms
 * @property {number} totalRequests
 * @property {number} totalFailures
 * @property {number|null} remainingRequests
 * @property {number|null} remainingRequestsDay
 * @property {number|null} remainingTokens
 * @property {number|null} limitRequests
 * @property {number|null} quotaResetAt
 */

// ── Initialization ───────────────────────────────────────────────────

function initProviderRegistry() {
  providers = [];

  const mode = process.env.LLM_PROVIDER || 'rotation';
  if (process.env.LLM_ENABLED !== 'true') {
    logger.info('[LLM] LLM_ENABLED is not "true" — provider registry empty.');
    return;
  }

  const keys = {
    groq:      process.env.LLM_API_KEY_GROQ      || '',
    cerebras:  process.env.LLM_API_KEY_CEREBRAS  || '',
    gemini:    process.env.LLM_API_KEY_GEMINI    || '',
    sambanova: process.env.LLM_API_KEY_SAMBANOVA || '',
    mistral:   process.env.LLM_API_KEY_MISTRAL   || ''
  };

  const rotationOrder = (process.env.LLM_ROTATION_ORDER || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (mode === 'rotation') {
    const order = rotationOrder.length > 0
      ? rotationOrder
      : Object.keys(keys).filter((k) => keys[k]);

    for (const name of order) {
      const def = CLOUD_PROVIDERS[name];
      const key = keys[name];
      if (!def || !key) continue;
      providers.push(makeProviderState(def, key));
    }
  } else {
    // Single-provider mode (backward-compatible escape hatch)
    const def = CLOUD_PROVIDERS[mode];
    const key = keys[mode] || process.env.LLM_API_KEY || '';
    if (def && key) {
      providers.push(makeProviderState(def, key));
    }
  }

  if (providers.length > 0) {
    logger.info(`[LLM] Provider registry ready: ${providers.map((p) => p.name).join(', ')} (${providers.length})`);
  } else {
    logger.warn('[LLM] No LLM provider keys configured (LLM_API_KEY_GROQ, _CEREBRAS, etc.) — features depending on LLM will return empty.');
  }
}

function makeProviderState(def, apiKey) {
  return {
    name: def.name,
    baseUrl: def.baseUrl,
    apiKey,
    // Per-provider model override via env (e.g. LLM_MODEL_CEREBRAS) so a
    // model rename/deprecation can be fixed without a code change. Falls
    // back to the built-in default.
    model: process.env[`LLM_MODEL_${def.name.toUpperCase()}`] || def.defaultModel,
    rateLimitedUntil: 0,
    consecutiveFailures: 0,
    lastUsed: 0,
    totalRequests: 0,
    totalFailures: 0,
    remainingRequests: null,
    remainingRequestsDay: null,
    remainingTokens: null,
    limitRequests: null,
    quotaResetAt: null
  };
}

// ── Rotation logic ───────────────────────────────────────────────────

/**
 * Pick the next available provider. Sort key:
 *   1. Push providers with very low daily quota (<3) to the end
 *   2. Otherwise round-robin by lastUsed
 */
function getNextProvider() {
  const now = Date.now();
  const available = providers.filter((p) => now >= p.rateLimitedUntil);
  if (available.length === 0) return null;

  available.sort((a, b) => {
    const aRemaining = a.remainingRequestsDay ?? a.remainingRequests ?? Infinity;
    const bRemaining = b.remainingRequestsDay ?? b.remainingRequests ?? Infinity;
    const aLow = aRemaining < 3 ? 1 : 0;
    const bLow = bRemaining < 3 ? 1 : 0;
    if (aLow !== bLow) return aLow - bLow;
    return a.lastUsed - b.lastUsed;
  });
  return available[0];
}

function signalProviderRateLimit(name, retryAfterSec) {
  const p = providers.find((s) => s.name === name);
  if (!p) return;

  p.consecutiveFailures++;
  // retry-after if server gave us one, otherwise exponential backoff (30s, 60s, 120s, …, capped 300s)
  const backoffSec = typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec)
    ? retryAfterSec
    : Math.min(300, 30 * Math.pow(2, p.consecutiveFailures - 1));
  p.rateLimitedUntil = Date.now() + backoffSec * 1000;
  p.totalFailures++;

  logger.info(`[LLM] ${name} rate-limited — backing off ${backoffSec}s (failures: ${p.consecutiveFailures})`);
}

/**
 * Read quota info from response headers. Different providers use
 * different header names — handle the union:
 *   - Groq / Cerebras / SambaNova: x-ratelimit-remaining-requests, -requests-day, -tokens
 *   - Mistral: x-ratelimit-remaining-req-minute, -tokens-minute
 */
function updateProviderQuota(name, headers) {
  const p = providers.find((s) => s.name === name);
  if (!p) return;

  const get = (h) => (typeof headers.get === 'function' ? headers.get(h) : (headers[h] ?? null));

  const remaining = get('x-ratelimit-remaining-requests');
  if (remaining != null) p.remainingRequests = parseInt(remaining, 10);

  const remainingDay = get('x-ratelimit-remaining-requests-day');
  if (remainingDay != null) p.remainingRequestsDay = parseInt(remainingDay, 10);

  const remainingTokens = get('x-ratelimit-remaining-tokens');
  if (remainingTokens != null) p.remainingTokens = parseInt(remainingTokens, 10);

  const limit = get('x-ratelimit-limit-requests');
  if (limit != null) p.limitRequests = parseInt(limit, 10);

  // Mistral-style headers
  const remainingReqMin = get('x-ratelimit-remaining-req-minute');
  if (remainingReqMin != null) p.remainingRequests = parseInt(remainingReqMin, 10);

  const limitReqMin = get('x-ratelimit-limit-req-minute');
  if (limitReqMin != null) p.limitRequests = parseInt(limitReqMin, 10);

  const remainingTokensMin = get('x-ratelimit-remaining-tokens-minute');
  if (remainingTokensMin != null) p.remainingTokens = parseInt(remainingTokensMin, 10);

  const reset = get('x-ratelimit-reset-requests');
  if (reset != null) {
    const val = parseFloat(reset);
    if (val > 1e9) p.quotaResetAt = val * 1000;
    else if (val > 0) p.quotaResetAt = Date.now() + val * 1000;
  }

  // Auto-pause exhausted providers until their reset window
  const effectiveRemaining = p.remainingRequestsDay ?? p.remainingRequests;
  if (effectiveRemaining != null && effectiveRemaining <= 0 && p.quotaResetAt) {
    p.rateLimitedUntil = p.quotaResetAt;
    logger.info(`[LLM] ${name} quota exhausted — paused until ${new Date(p.quotaResetAt).toISOString()}`);
  }
}

function signalProviderSuccess(name) {
  const p = providers.find((s) => s.name === name);
  if (!p) return;
  p.consecutiveFailures = 0;
  p.lastUsed = Date.now();
  p.totalRequests++;
}

function signalProviderFailure(name) {
  const p = providers.find((s) => s.name === name);
  if (!p) return;
  p.consecutiveFailures++;
  p.totalFailures++;
}

// ── Query API ────────────────────────────────────────────────────────

function isAnyProviderAvailable() {
  const now = Date.now();
  return providers.some((p) => now >= p.rateLimitedUntil);
}

function getActiveProviderCount() {
  return providers.length;
}

function getAllProviderStates() {
  return providers.map((p) => ({
    name: p.name,
    model: p.model,
    rateLimited: Date.now() < p.rateLimitedUntil,
    rateLimitedUntil: p.rateLimitedUntil || null,
    remainingRequests: p.remainingRequests,
    remainingRequestsDay: p.remainingRequestsDay,
    remainingTokens: p.remainingTokens,
    limitRequests: p.limitRequests,
    quotaResetAt: p.quotaResetAt,
    totalRequests: p.totalRequests,
    totalFailures: p.totalFailures,
    lastUsed: p.lastUsed || null
  }));
}

module.exports = {
  CLOUD_PROVIDERS,
  initProviderRegistry,
  getNextProvider,
  signalProviderRateLimit,
  signalProviderSuccess,
  signalProviderFailure,
  updateProviderQuota,
  isAnyProviderAvailable,
  getActiveProviderCount,
  getAllProviderStates
};
