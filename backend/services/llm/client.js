/**
 * LLM client — sends a chat-completion request to whichever provider
 * currently has quota. Tries each provider in round-robin order; if one
 * 429s or otherwise fails, the next provider gets a turn.
 *
 * Cloud-only (no local-llama support). No streaming — returns the full
 * completion string when done, because the use cases here (event
 * synthesis, channel-hint extraction) are batch-style, not chat.
 *
 * Public API:
 *   initLlm()                            — call once on server boot
 *   generateCompletion(messages, opts)   — returns string or null on full exhaustion
 *   isLlmReady()                         — true if at least one provider has a key
 *   getProviderStatus()                  — snapshot of every provider's state
 */

const logger = require('../../config/logger');
const {
  initProviderRegistry,
  getNextProvider,
  signalProviderRateLimit,
  signalProviderSuccess,
  signalProviderFailure,
  updateProviderQuota,
  isAnyProviderAvailable,
  getActiveProviderCount,
  getAllProviderStates
} = require('./providers');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);
const DEFAULT_TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || '0.4');

let ready = false;

function initLlm() {
  initProviderRegistry();
  ready = getActiveProviderCount() > 0;
  if (ready) {
    logger.info(`[LLM] Client ready (${getActiveProviderCount()} providers).`);
  } else {
    logger.info('[LLM] Client started with no providers — generateCompletion() will return null.');
  }
}

function isLlmReady() {
  return ready && isAnyProviderAvailable();
}

function getProviderStatus() {
  return {
    ready,
    providers: getAllProviderStates()
  };
}

/**
 * @typedef  {{ role: 'system'|'user'|'assistant', content: string }} ChatMessage
 * @typedef  {{ temperature?: number, maxTokens?: number, timeoutMs?: number, responseFormat?: 'json'|null }} GenerateOptions
 */

/**
 * @param {Array<ChatMessage>} messages
 * @param {GenerateOptions} [options]
 * @returns {Promise<string|null>} the assistant content, or null if every provider failed
 */
async function generateCompletion(messages, options = {}) {
  if (!ready) return null;

  const maxAttempts = Math.max(1, getActiveProviderCount());
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const provider = getNextProvider();
    if (!provider) {
      logger.info('[LLM] All providers rate-limited.');
      break;
    }

    const result = await callOnce(provider, messages, options);
    if (result !== null) return result;
    // null = transient failure → try next provider
  }
  return null;
}

async function callOnce(provider, messages, options) {
  const url = provider.baseUrl.endsWith('/')
    ? `${provider.baseUrl}chat/completions`
    : `${provider.baseUrl}/chat/completions`;

  const body = {
    model: provider.model,
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    stream: false
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.responseFormat === 'json') {
    // OpenAI-compatible JSON mode — supported by Groq, Gemini, Mistral
    // (Cerebras + SambaNova ignore unknown fields gracefully)
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);

    // Capture quota headers whether the request succeeded or failed
    updateProviderQuota(provider.name, res.headers);

    if (!res.ok) {
      const text = await safeText(res);
      logger.info(`[LLM] ${provider.name} HTTP ${res.status}: ${text.slice(0, 240)}`);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
        signalProviderRateLimit(provider.name, Number.isFinite(retryAfter) ? retryAfter : undefined);
      } else {
        signalProviderFailure(provider.name);
      }
      return null;
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      logger.info(`[LLM] ${provider.name} returned empty content.`);
      signalProviderFailure(provider.name);
      return null;
    }

    signalProviderSuccess(provider.name);
    logger.info(`[LLM] ${provider.name} responded (${content.length} chars).`);
    return content;
  } catch (err) {
    clearTimeout(timer);
    const msg = err?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : (err?.message || String(err));
    logger.warn(`[LLM] ${provider.name} fetch error: ${msg}`);
    signalProviderFailure(provider.name);
    return null;
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/**
 * Convenience helper: send a single user prompt, parse the response as
 * JSON. Returns null on any failure (rate limit, malformed JSON, etc.)
 * so callers can fall back to a non-LLM path cleanly.
 *
 *   const events = await generateJson({
 *     system: 'You are an event extractor. Respond with strict JSON.',
 *     user: 'Given these signals: …',
 *     schema: '{"events": [{ "title": str, "type": str, … }]}'
 *   });
 */
async function generateJson({ system, user, schema, ...options } = {}) {
  if (!user) throw new Error('generateJson: `user` prompt is required');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({
    role: 'user',
    content: schema
      ? `${user}\n\nRespond with ONLY valid JSON matching this schema:\n${schema}`
      : user
  });

  const raw = await generateCompletion(messages, { ...options, responseFormat: 'json' });
  if (!raw) return null;

  // Strip stray markdown fences (Llama/Mistral sometimes return ```json … ```)
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    logger.warn(`[LLM] JSON parse failed: ${e.message}; raw head: ${trimmed.slice(0, 160)}`);
    return null;
  }
}

module.exports = {
  initLlm,
  isLlmReady,
  getProviderStatus,
  generateCompletion,
  generateJson
};
