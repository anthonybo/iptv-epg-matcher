/**
 * Persistent LLM response cache (see migration 045).
 *
 * Survives restarts and is shared across instances — unlike an in-memory
 * Map — so stable facts (e.g. "which networks carry this league") are
 * resolved by the LLM once and reused for days. Generic via `namespace`.
 *
 * All methods are defensive: on any DB error they behave as a cache MISS
 * (get → null, set → no-op) so a cache hiccup never breaks the caller —
 * it just falls back to querying the LLM again.
 */

const logger = require('../config/logger');
const postgresService = require('./postgresService');

const makeKey = (namespace, key) => `${namespace}:${String(key).toLowerCase()}`;

/**
 * Look up a fresh cached value. Returns the parsed JSON value or null
 * (miss / expired / error). Bumps the hit counter on a live hit.
 */
async function get(namespace, key) {
  const cacheKey = makeKey(namespace, key);
  try {
    const { rows } = await postgresService.query(
      `UPDATE ai_llm_cache
          SET hits = hits + 1
        WHERE cache_key = $1 AND expires_at > NOW()
        RETURNING value`,
      [cacheKey]
    );
    if (rows.length === 0) return null;
    return rows[0].value;
  } catch (err) {
    logger.warn(`[AiLlmCache] get failed for ${cacheKey}: ${err.message}`);
    return null;
  }
}

/**
 * Store a value with a TTL. Upserts (refreshes expiry on repeat). No-op
 * on error. Never throws.
 * @param {number} ttlSeconds
 */
async function set(namespace, key, value, ttlSeconds) {
  const cacheKey = makeKey(namespace, key);
  const ttl = Math.max(1, Math.round(ttlSeconds || 0));
  try {
    await postgresService.query(
      `INSERT INTO ai_llm_cache (cache_key, namespace, value, expires_at)
       VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' seconds')::interval)
       ON CONFLICT (cache_key) DO UPDATE SET
         value      = EXCLUDED.value,
         namespace  = EXCLUDED.namespace,
         updated_at = NOW(),
         expires_at = EXCLUDED.expires_at`,
      [cacheKey, namespace, JSON.stringify(value), String(ttl)]
    );
  } catch (err) {
    logger.warn(`[AiLlmCache] set failed for ${cacheKey}: ${err.message}`);
  }
}

/** Delete expired rows (call occasionally). Returns count or 0. */
async function prune() {
  try {
    const { rowCount } = await postgresService.query(
      'DELETE FROM ai_llm_cache WHERE expires_at < NOW()'
    );
    return rowCount || 0;
  } catch (err) {
    logger.warn(`[AiLlmCache] prune failed: ${err.message}`);
    return 0;
  }
}

module.exports = { get, set, prune };
