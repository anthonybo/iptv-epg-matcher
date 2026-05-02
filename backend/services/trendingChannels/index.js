/**
 * Trending channels orchestrator.
 *
 * Combines per-source live popularity signals into a single ranked list
 * of "what TV channels are people watching/talking about right now"
 * across the globe. Designed for ~60s refresh — fast enough to feel
 * live, slow enough to stay inside YouTube's 10k unit/day quota and
 * Reddit's unauth rate limit.
 *
 * Composition (per the second-pass research):
 *   0.50 × YouTube Live concurrentViewers (24/7 official news streams)
 *   0.25 × Twitch restream viewer_count (sports finals, breaking news)
 *   0.15 × Reddit comments-per-minute (broadcast-relevant subreddits)
 *   0.10 × Bluesky mention rate (decayed firehose count)
 *
 * Each raw signal is min-max-normalised to [0, 1] across the channel
 * set so a source with a small dynamic range doesn't dominate. Channels
 * with zero contribution from every source are dropped.
 *
 * On-disk channel map: backend/config/trending_channels.json
 */

const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');

const youtubeSource = require('./youtubeLiveSource');
const twitchSource = require('./twitchLiveSource');
const redditSource = require('./redditVelocitySource');
const blueskySource = require('./blueskyVelocitySource');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'trending_channels.json');

const SOURCE_WEIGHTS = {
  youtube: 0.50,
  twitch: 0.25,
  reddit: 0.15,
  bluesky: 0.10,
};

const REFRESH_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;

let cachedChannels = null;
let cachedConfigMtime = 0;

function loadChannels() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cachedChannels && stat.mtimeMs === cachedConfigMtime) return cachedChannels;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cachedChannels = Array.isArray(parsed.channels) ? parsed.channels : [];
    cachedConfigMtime = stat.mtimeMs;
    logger.info(`[TrendingChannels] loaded ${cachedChannels.length} channel mappings`);
    return cachedChannels;
  } catch (e) {
    logger.warn(`[TrendingChannels] config load failed: ${e.message}`);
    return cachedChannels || [];
  }
}

function minMaxNormalise(values) {
  // Returns Map(key → value in [0, 1]). Any channel with a positive
  // raw signal contributes proportionally — the top contributor lands
  // at 1.0, channels with no entry are simply absent (treated as 0
  // when composited).
  if (values.size === 0) return new Map();
  const arr = Array.from(values.values());
  const max = Math.max(...arr);
  if (max <= 0) return new Map();
  const out = new Map();
  for (const [k, v] of values) {
    if (v > 0) out.set(k, v / max);
  }
  return out;
}

let lastSnapshot = {
  generatedAt: 0,
  ranked: [],
  byId: new Map(),
  sourcesActive: [],
};

let inflightPromise = null;
let refreshTimer = null;

async function gather() {
  const channels = loadChannels();
  if (channels.length === 0) {
    return { ranked: [], sourcesActive: [] };
  }

  const sources = [
    { source: youtubeSource, weight: SOURCE_WEIGHTS.youtube },
    { source: twitchSource, weight: SOURCE_WEIGHTS.twitch },
    { source: redditSource, weight: SOURCE_WEIGHTS.reddit },
    { source: blueskySource, weight: SOURCE_WEIGHTS.bluesky },
  ];

  const results = await Promise.all(
    sources.map(async ({ source, weight }) => {
      if (!source.enabled()) return { name: source.name, weight, raw: new Map(), enabled: false };
      try {
        const raw = await source.fetchSignals(channels);
        return { name: source.name, weight, raw, enabled: true };
      } catch (e) {
        logger.warn(`[TrendingChannels] ${source.name} fetchSignals threw: ${e.message}`);
        return { name: source.name, weight, raw: new Map(), enabled: true };
      }
    })
  );

  // Re-balance weights across the sources that ran AND produced any
  // data this tick — otherwise a single source going dark drags the
  // composite down uniformly.
  const contributing = results.filter((r) => r.raw.size > 0);
  const totalActiveWeight = contributing.reduce((s, r) => s + r.weight, 0) || 1;

  const composite = new Map();
  const perSource = new Map();
  for (const { name, weight, raw } of contributing) {
    const norm = minMaxNormalise(raw);
    const reweighted = weight / totalActiveWeight;
    for (const [id, normVal] of norm) {
      composite.set(id, (composite.get(id) || 0) + normVal * reweighted);
      let bucket = perSource.get(id);
      if (!bucket) { bucket = {}; perSource.set(id, bucket); }
      bucket[name] = { raw: raw.get(id), normalized: Number(normVal.toFixed(4)) };
    }
  }

  const byId = new Map(channels.map((c) => [c.id, c]));
  const ranked = Array.from(composite.entries())
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => {
      const ch = byId.get(id) || { id };
      return {
        id,
        name: ch.name,
        region: ch.region,
        category: ch.category,
        score: Number(score.toFixed(4)),
        signals: perSource.get(id) || {},
      };
    });

  return {
    ranked,
    sourcesActive: contributing.map((r) => r.name),
    sourcesEnabled: results.filter((r) => r.enabled).map((r) => r.name),
  };
}

async function refresh() {
  if (inflightPromise) return inflightPromise;
  inflightPromise = (async () => {
    const start = Date.now();
    try {
      const result = await gather();
      lastSnapshot = {
        generatedAt: Date.now(),
        ranked: result.ranked,
        byId: new Map(result.ranked.map((r) => [r.id, r])),
        sourcesActive: result.sourcesActive,
        sourcesEnabled: result.sourcesEnabled,
        durationMs: Date.now() - start,
      };
      logger.info(`[TrendingChannels] refresh: ${result.ranked.length} ranked, sources=[${result.sourcesActive.join(',')}], ${Date.now() - start}ms`);
    } catch (e) {
      logger.warn(`[TrendingChannels] refresh failed: ${e.message}`);
    } finally {
      inflightPromise = null;
    }
    return lastSnapshot;
  })();
  return inflightPromise;
}

function startRefreshLoop() {
  if (refreshTimer) return;
  // Fire once immediately, then every interval. Use setInterval rather
  // than chained timeouts so a slow refresh doesn't stretch the cadence.
  refresh().catch(() => {});
  refreshTimer = setInterval(() => {
    refresh().catch(() => {});
  }, REFRESH_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown
  if (refreshTimer.unref) refreshTimer.unref();
  logger.info(`[TrendingChannels] refresh loop started (every ${REFRESH_INTERVAL_MS / 1000}s)`);
}

function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function getSnapshot() {
  return lastSnapshot;
}

function isStale() {
  return Date.now() - lastSnapshot.generatedAt > STALE_THRESHOLD_MS;
}

module.exports = {
  startRefreshLoop,
  stopRefreshLoop,
  refresh,
  getSnapshot,
  isStale,
  loadChannels,
};
