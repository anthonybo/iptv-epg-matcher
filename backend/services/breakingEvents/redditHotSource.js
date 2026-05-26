/**
 * Reddit hot-threads source for the BREAKING-EVENTS pipeline.
 *
 * Different goal from `services/trendingChannels/redditVelocitySource`:
 *   trendingChannels asks "which TV channels are people talking about"
 *   breakingEvents asks   "what real-world events are happening RIGHT NOW
 *                          that someone might want to watch on TV"
 *
 * So we hit a different set of subs (breaking-news-flavored, not sports/
 * pop-culture), and we return raw hot-thread tuples without trying to
 * map them to channels — that mapping happens after the LLM clusters
 * the threads into named events.
 */

const axios = require('axios');
const logger = require('../../config/logger');

// Tuned for "things happening right now you might want live TV coverage
// of." Mix of:
//   - breaking news catch-alls (news, breakingnews, worldnews)
//   - high-visibility local-news subjects (PublicFreakout for chases / live
//     cam events, policechase explicitly)
//   - disaster + weather (wildfires, weather, californiawildfires, hurricane)
//   - sports umbrella (sports, soccer, nfl, nba, baseball, hockey)
//   - politics for major political moments
// 10 minute hot-thread cache is plenty — these don't churn much faster
// than that and Reddit unauth is precious budget.
const SUBREDDITS = [
  'news',
  'breakingnews',
  'worldnews',
  'PublicFreakout',
  'policechase',
  'wildfires',
  'CaliforniaWildfires',
  'weather',
  'hurricane',
  'sports',
  'soccer',
  'nfl',
  'nba',
  'baseball',
  'hockey',
  'politics'
];

const USER_AGENT = 'iptv-epg-matcher/0.3 (breaking-events synthesizer; +https://github.com/anthonybo/iptv-epg-matcher)';

// Per-tick budget: 16 subs × ≥1.5s spacing = ~24s. Cached hot.json data
// is reused for HOT_CACHE_TTL_MS so consecutive refreshes don't all
// re-hit the network.
const REQUEST_SPACING_MS = 1500;
const HOT_CACHE_TTL_MS = 10 * 60 * 1000;
const hotCache = new Map();
let lastRequestAt = 0;

// If lastRequestAt got pushed > MAX_WAIT_MS into the future (typically
// from a 429-triggered backoff), every remaining sub in this tick would
// block for the full backoff window — multiplied by N subs — making the
// whole pipeline appear hung. Instead, bail out and serve cached/empty
// for the rest of the tick. The next tick can retry once the window
// expires.
const MAX_WAIT_MS = 8_000;

async function fetchHot(sub, { limit = 12 } = {}) {
  const cached = hotCache.get(sub);
  if (cached && Date.now() - cached.ts < HOT_CACHE_TTL_MS) {
    return cached.threads;
  }

  const wait = Math.max(0, lastRequestAt + REQUEST_SPACING_MS - Date.now());
  if (wait > MAX_WAIT_MS) {
    // Backoff window is too long — skip rather than block. Cache empty
    // briefly so re-entries don't redundantly check.
    logger.debug(`[BreakingEvents:Reddit] /r/${sub} skipped (backoff window ${Math.round(wait / 1000)}s)`);
    hotCache.set(sub, { ts: Date.now() - HOT_CACHE_TTL_MS + 30_000, threads: [] });
    return [];
  }
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  try {
    const resp = await axios.get(`https://old.reddit.com/r/${sub}/hot.json`, {
      params: { limit, raw_json: 1 },
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 8000
    });
    const threads = (resp.data?.data?.children || [])
      .map((c) => c.data)
      .filter((t) => t && !t.stickied && t.title)
      .map((t) => ({
        sub,
        title: t.title,
        flair: t.link_flair_text || null,
        score: t.score || 0,
        numComments: t.num_comments || 0,
        ageHours: Math.round((Date.now() / 1000 - (t.created_utc || 0)) / 3600),
        permalink: t.permalink ? `https://reddit.com${t.permalink}` : null
      }));
    hotCache.set(sub, { ts: Date.now(), threads });
    return threads;
  } catch (e) {
    if (e.response?.status === 429) {
      // 60s backoff (was 5min). Trending-channels already lit Reddit's
      // bucket; we just need to wait long enough for the next tick.
      // The MAX_WAIT_MS skip above ensures even within this 60s window
      // we don't block the whole pipeline on each remaining sub.
      lastRequestAt = Date.now() + 60_000;
      logger.warn(`[BreakingEvents:Reddit] 429 from /r/${sub} — backing off 60s`);
    } else {
      logger.debug(`[BreakingEvents:Reddit] /r/${sub}: ${e.message}`);
    }
    // Cache empty briefly so the rest of this tick doesn't redundantly retry
    hotCache.set(sub, { ts: Date.now() - HOT_CACHE_TTL_MS + 60_000, threads: [] });
    return [];
  }
}

/**
 * @returns {Promise<Array<{sub:string, title:string, flair:string|null, score:number, numComments:number, ageHours:number, permalink:string|null}>>}
 *   Top hot threads across every tracked sub, deduped by title, sorted by
 *   a heat composite (score × comments × recency). Capped at 80 threads
 *   so the LLM prompt stays small.
 */
async function collectHotThreads({ perSub = 8, totalCap = 80 } = {}) {
  const all = [];
  for (const sub of SUBREDDITS) {
    const threads = await fetchHot(sub, { limit: perSub });
    all.push(...threads);
  }

  // Dedupe by exact-title — cross-posts produce duplicates.
  const byTitle = new Map();
  for (const t of all) {
    const key = t.title.toLowerCase().slice(0, 120);
    const prev = byTitle.get(key);
    if (!prev || (t.score + t.numComments) > (prev.score + prev.numComments)) {
      byTitle.set(key, t);
    }
  }

  const deduped = Array.from(byTitle.values());

  // Heat composite — same shape as trendingChannels' threadHeat but
  // operating on the (sub, title) tuple we already extracted.
  const heat = (t) =>
    Math.log10(Math.max(0, t.score) + 1)
    + 0.3 * Math.log10(Math.max(0, t.numComments) + 1)
    - Math.max(0, t.ageHours) / 12.5;

  deduped.sort((a, b) => heat(b) - heat(a));
  return deduped.slice(0, totalCap);
}

module.exports = { collectHotThreads, SUBREDDITS };
