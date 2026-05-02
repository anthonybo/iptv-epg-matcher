/**
 * Reddit comment velocity source.
 *
 * Two-layer attribution:
 *
 *   1. DIRECT — comment's thread title or body literally mentions one
 *      of a channel's `reddit_terms` (e.g. "ESPN", "BBC News").
 *
 *   2. INDIRECT — when a sport/topic subreddit is generating high
 *      comment velocity, distribute a fraction of that activity to the
 *      sports/news broadcasters known to carry that sport. Without this
 *      step, sports broadcasters basically never surface — fans of
 *      r/nfl talk about "Mahomes," "Eagles," etc., almost never about
 *      "ESPN" or "Fox Sports" by name. The attribution is fractional
 *      (each broadcaster gets `weight × commentRate`) so the sub doesn't
 *      collapse into a single broadcaster.
 *
 * No auth needed for the public .json endpoints, but Reddit hard-rate-
 * limits unauth at ~30 req/min. We hit ~12 endpoints per refresh, so
 * we're well inside the budget. Custom User-Agent required.
 */

const axios = require('axios');
const logger = require('../../config/logger');

const SUBREDDITS = [
  'news',
  'worldnews',
  'politics',
  'sports',
  'soccer',
  'nfl',
  'nba',
  'baseball',
  'hockey',
  'cricket',
  'formula1',
  'mma',
  'tennis',
  'television',
];

// Per-subreddit indirect attribution: which broadcasters get a slice of
// this sub's comment velocity, and how much (sums to ≤1 per sub). The
// channel ids must match `trending_channels.json`. Sports broadcasters
// don't surface from direct mentions (fans talk about teams/players
// not networks), so this routes the genuine "people are talking
// about this sport" signal to the channels that actually air it.
const INDIRECT_SUB_ATTRIBUTION = {
  nfl: { espn: 0.5, 'fox-sports-au': 0, 'sky-sports': 0 },
  nba: { espn: 0.5, 'tnt-sports-uk': 0.2 },
  baseball: { espn: 0.4 },
  hockey: { espn: 0.3, 'tnt-sports-uk': 0.2 },
  soccer: {
    'sky-sports': 0.25,
    'tnt-sports-uk': 0.2,
    espn: 0.1,
    'bein-sports': 0.15,
    eurosport: 0.1,
    'tnt-sports-br': 0.1,
    'globo-news': 0.05,
    dazn: 0.1,
    'tycsports': 0.05,
  },
  formula1: { 'sky-sports': 0.4, espn: 0.2, eurosport: 0.2 },
  cricket: { 'star-sports-india': 0.4, 'willow-cricket': 0.2, 'sky-sports': 0.1 },
  tennis: { 'sky-sports': 0.2, espn: 0.2, eurosport: 0.3 },
  mma: { espn: 0.3, dazn: 0.2 },
  sports: { espn: 0.2, 'sky-sports': 0.15, 'fox-sports-au': 0.05 },
  news: { 'cnn': 0.1, 'fox-news': 0.1, 'msnbc': 0.05, 'bbc-news': 0.05, 'sky-news': 0.05 },
  worldnews: { 'bbc-news': 0.15, 'reuters': 0.1, 'al-jazeera-english': 0.1, 'france24-english': 0.05, 'dw-english': 0.05 },
  politics: { 'cnn': 0.15, 'fox-news': 0.15, 'msnbc': 0.15 },
  television: {},
};

// Reddit recommends a descriptive UA with version + contact in the
// "Bot/Bot-version (by /u/username)" form. Without this they'll
// rate-limit aggressively (or 429 on the first call). The contact line
// here is accurate for this repo.
const USER_AGENT = 'iptv-epg-matcher/0.2 (linear TV trending ranker; +https://github.com/anthonybo/iptv-epg-matcher)';

const REQUEST_SPACING_MS = 1500;
const RESPONSE_CACHE_TTL_MS = 60 * 1000;
const subCache = new Map(); // sub → { ts, comments }
let lastRequestAt = 0;

async function fetchSubComments(sub) {
  // Per-sub response cache. Subs change slowly enough that re-hitting
  // them every 60s is fine; the per-sub cache lives 60s so a refresh
  // tick that lands inside the window pulls from cache and skips the
  // rate-limited HTTP entirely.
  const cached = subCache.get(sub);
  if (cached && Date.now() - cached.ts < RESPONSE_CACHE_TTL_MS) {
    return { sub, comments: cached.comments };
  }

  // Throttle: Reddit unauth gets ~30 req/10min before 429ing. With 14
  // subs at 1.5s spacing, one refresh tick spreads over ~21s and stays
  // well below the limit.
  const wait = Math.max(0, lastRequestAt + REQUEST_SPACING_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  try {
    // old.reddit.com has noticeably looser unauth rate limits than
    // www.reddit.com (which 429s the first request), but serves the
    // same Listing JSON shape.
    const resp = await axios.get(`https://old.reddit.com/r/${sub}/comments.json`, {
      params: { limit: 100, raw_json: 1 },
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 8000,
    });
    const comments = resp.data?.data?.children?.map((c) => c.data) || [];
    subCache.set(sub, { ts: Date.now(), comments });
    return { sub, comments };
  } catch (e) {
    if (e.response?.status === 429) {
      // Back off harder on a 429 — push our floor for 5 minutes so we
      // don't spam the bucket. Also cache empty so other subs in this
      // tick don't redundantly re-attempt.
      lastRequestAt = Date.now() + 5 * 60_000;
      logger.warn(`[RedditVel] 429 from /r/${sub} — backing off 5min`);
    } else {
      logger.debug(`[RedditVel] /r/${sub}: ${e.message}`);
    }
    subCache.set(sub, { ts: Date.now(), comments: [] });
    return { sub, comments: [] };
  }
}

async function fetchAllSubsSequential() {
  const out = [];
  for (const sub of SUBREDDITS) {
    out.push(await fetchSubComments(sub));
  }
  return out;
}

/**
 * @param {Array<{id: string, reddit_terms?: string[]}>} channels
 * @returns {Promise<Map<string, number>>} channel.id → comments-per-minute attributed
 */
async function fetchSignals(channels) {
  const matchers = channels
    .filter((c) => Array.isArray(c.reddit_terms) && c.reddit_terms.length)
    .map((c) => ({
      id: c.id,
      terms: c.reddit_terms.map((t) => t.toLowerCase()),
    }));
  if (matchers.length === 0) return new Map();

  const perSub = await fetchAllSubsSequential();
  const allComments = perSub.flatMap((r) => r.comments);
  if (allComments.length === 0) return new Map();

  // Determine the spread of timestamps we observed; convert "matched
  // count" into a per-minute rate so it composes with other sources.
  const nows = allComments.map((c) => (c.created_utc || 0) * 1000).filter(Boolean);
  if (nows.length === 0) return new Map();
  const oldest = Math.min(...nows);
  const newest = Math.max(...nows);
  const minutesSpan = Math.max(1, (newest - oldest) / 60_000);

  // 1. DIRECT attribution — explicit mention of a broadcaster.
  const directCounts = new Map();
  for (const c of allComments) {
    const haystack = `${c.link_title || ''} ${c.link_flair_text || ''} ${(c.body || '').slice(0, 500)}`.toLowerCase();
    for (const m of matchers) {
      if (m.terms.some((t) => haystack.includes(t))) {
        directCounts.set(m.id, (directCounts.get(m.id) || 0) + 1);
      }
    }
  }

  // 2. INDIRECT attribution — sub volume × per-broadcaster weight.
  // We use sub-local minutes-span (each sub has its own time window) so
  // a quiet sub doesn't pull down the rate of a busy one.
  const indirectRates = new Map();
  const channelIds = new Set(channels.map((c) => c.id));
  for (const { sub, comments } of perSub) {
    if (comments.length === 0) continue;
    const attribution = INDIRECT_SUB_ATTRIBUTION[sub];
    if (!attribution) continue;
    const ts = comments.map((c) => (c.created_utc || 0) * 1000).filter(Boolean);
    if (ts.length === 0) continue;
    const subSpan = Math.max(1, (Math.max(...ts) - Math.min(...ts)) / 60_000);
    const subRate = comments.length / subSpan; // comments/min in this sub
    for (const [chId, weight] of Object.entries(attribution)) {
      if (!channelIds.has(chId)) continue;
      const contribution = subRate * weight;
      indirectRates.set(chId, (indirectRates.get(chId) || 0) + contribution);
    }
  }

  // Combine: direct (per-comment count → /min) + indirect (already /min).
  const rates = new Map();
  for (const [id, n] of directCounts) rates.set(id, n / minutesSpan);
  for (const [id, r] of indirectRates) {
    rates.set(id, (rates.get(id) || 0) + r);
  }

  if (rates.size > 0) {
    const directHits = directCounts.size;
    const indirectHits = indirectRates.size;
    logger.info(`[RedditVel] ${rates.size} channels (direct=${directHits}, indirect=${indirectHits}) from ${allComments.length} comments / ${SUBREDDITS.length} subs`);
  }
  return rates;
}

module.exports = {
  name: 'reddit',
  enabled: () => true,
  fetchSignals,
};
