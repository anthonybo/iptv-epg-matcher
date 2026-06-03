/**
 * Feature flags — tiny JSON-backed, runtime-toggleable flag store.
 *
 * Separate from routes/settings.js (which is an unauthenticated generic
 * KV bag) so feature toggles get their own namespace, default-OFF
 * semantics, and an in-memory cache for the hot path. Flags persist to
 * config/feature-flags.json and survive restarts. Flips happen in-process
 * via setFlag(), so the cache is write-through and always current.
 *
 * Public API:
 *   isEnabled(key, default=false) — boolean, cheap (cached)
 *   setFlag(key, value)           — persist + update cache, returns value
 *   getAll()                      — { [key]: value }
 */

const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

const CONFIG_DIR = path.join(__dirname, '../config');
const FLAGS_FILE = path.join(CONFIG_DIR, 'feature-flags.json');

// Known flags + their defaults. Unknown keys still work, but listing the
// defaults here keeps "what can I toggle" discoverable and gives a sane
// value before the file exists.
const DEFAULTS = {
  ai_channel_matching: false,
  // Which web-search backend to use: 'auto' (smart pick among available),
  // 'groq' (Groq compound), or 'gemini' (Gemini grounding).
  web_search_provider: 'auto',
  // Runtime kill switch for the TMDB VOD enrichment worker (lets us stop its
  // heavy movie_streams scan, e.g. while building an index, without a restart).
  pause_vod_enrichment: false,
};

let cache = null;
let cacheMtimeMs = 0;

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (err) {
      logger.error(`[FeatureFlags] could not create config dir: ${err.message}`);
    }
  }
}

function load() {
  // Reload when the file changes on disk so the running process always
  // reflects the persisted state — even if another process (a script, or
  // a future second instance) wrote it. stat() per call is cheap and
  // isEnabled() is low-frequency.
  try {
    if (fs.existsSync(FLAGS_FILE)) {
      const mtimeMs = fs.statSync(FLAGS_FILE).mtimeMs;
      if (cache && mtimeMs === cacheMtimeMs) return cache;
      cache = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')) || {};
      cacheMtimeMs = mtimeMs;
    } else if (!cache) {
      cache = {};
    }
  } catch (err) {
    logger.error(`[FeatureFlags] load failed, using defaults: ${err.message}`);
    if (!cache) cache = {};
  }
  return cache;
}

function persist() {
  ensureDir();
  try {
    fs.writeFileSync(FLAGS_FILE, JSON.stringify(cache, null, 2), 'utf8');
    try { cacheMtimeMs = fs.statSync(FLAGS_FILE).mtimeMs; } catch (_) { /* best effort */ }
    return true;
  } catch (err) {
    logger.error(`[FeatureFlags] save failed: ${err.message}`);
    return false;
  }
}

function isEnabled(key, defaultValue) {
  const flags = load();
  if (Object.prototype.hasOwnProperty.call(flags, key)) {
    return Boolean(flags[key]);
  }
  if (typeof defaultValue === 'boolean') return defaultValue;
  return Boolean(DEFAULTS[key]);
}

function setFlag(key, value) {
  const flags = load();
  flags[key] = Boolean(value);
  cache = flags;
  persist();
  logger.info(`[FeatureFlags] ${key} = ${flags[key]}`);
  return flags[key];
}

// Generic (non-boolean) value accessors — for settings like enum strings.
function getValue(key, defaultValue) {
  const flags = load();
  if (Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
  return defaultValue !== undefined ? defaultValue : DEFAULTS[key];
}

function setValue(key, value) {
  const flags = load();
  flags[key] = value;
  cache = flags;
  persist();
  logger.info(`[FeatureFlags] ${key} = ${JSON.stringify(value)}`);
  return value;
}

function getAll() {
  // Merge defaults under any persisted overrides so the caller always
  // sees every known flag with its effective value.
  return { ...DEFAULTS, ...load() };
}

module.exports = { isEnabled, setFlag, getValue, setValue, getAll, DEFAULTS };
