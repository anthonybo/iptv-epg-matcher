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
// hot.json moves much slower than the comments firehose (a hot thread
// stays hot for hours), so we keep it cached far longer to halve the
// request rate and stay well under unauth's ~10 req/min ceiling.
const HOT_CACHE_TTL_MS = 10 * 60 * 1000;
const subCache = new Map(); // sub → { ts, comments }
const hotCache = new Map(); // sub → { ts, threads }
let lastRequestAt = 0;

// Per-channel "what's actually being talked about" snippet — the single
// thread driving the signal. Populated each fetchSignals call. The
// orchestrator pulls this via getSnippets() so the trending UI can
// answer "why is ESPN #1 right now" with the actual hot-thread title +
// real engagement numbers (num_comments, score) instead of a static
// category blurb. Source thread data comes from /r/<sub>/hot.json
// (Reddit's own hot ranking) — comment-velocity data still drives the
// channel-RANKING, but for the SNIPPET we want the canonical hot
// thread, not whatever happened to be in our 100-comment sample.
let lastSnippets = new Map();

// Reddit's own hot ranking proxy (Evan Miller's writeup of Reddit's
// algorithm). We use this to pick the single most-engaging hot thread
// from a sub's hot.json response when there's no direct channel match.
//   log10(score+1) + 0.3 × log10(num_comments+1) − hours_old/12.5
// Comments are weighted lower because they're a follow-on signal of
// score, but they're a strong "people are still actively engaging"
// proxy — without that term, a sticky thread with high upvotes but no
// new comments would rank above an active megathread.
function threadHeat(thread) {
  const score = Math.max(0, thread.score || 0);
  const comments = Math.max(0, thread.num_comments || 0);
  const ageH = Math.max(0, (Date.now() / 1000 - (thread.created_utc || 0)) / 3600);
  return Math.log10(score + 1) + 0.3 * Math.log10(comments + 1) - ageH / 12.5;
}

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

// Pull the top hot threads for one sub. Cached aggressively (10 min) so
// rebuilds of the trending snapshot don't spam Reddit. limit=15 gives
// us enough threads to find a per-channel direct mention while keeping
// the response small. Same shared throttle as comments.json.
async function fetchSubHotThreads(sub) {
  const cached = hotCache.get(sub);
  if (cached && Date.now() - cached.ts < HOT_CACHE_TTL_MS) {
    return { sub, threads: cached.threads };
  }
  const wait = Math.max(0, lastRequestAt + REQUEST_SPACING_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  try {
    const resp = await axios.get(`https://old.reddit.com/r/${sub}/hot.json`, {
      params: { limit: 15, raw_json: 1 },
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 8000,
    });
    const threads = (resp.data?.data?.children || [])
      .map((c) => c.data)
      // Skip pinned/admin posts — they're "hot" administratively, not
      // organically. They lock at the top of every sub forever.
      .filter((t) => t && !t.stickied && t.title);
    hotCache.set(sub, { ts: Date.now(), threads });
    return { sub, threads };
  } catch (e) {
    if (e.response?.status === 429) {
      lastRequestAt = Date.now() + 5 * 60_000;
      logger.warn(`[RedditVel] 429 from /r/${sub}/hot — backing off 5min`);
    } else {
      logger.debug(`[RedditVel] /r/${sub}/hot: ${e.message}`);
    }
    // Cache empty short-term so the rest of this tick doesn't retry.
    // Using a SHORTER TTL (60s) than success cache so we recover
    // quickly when the rate-limit window passes.
    hotCache.set(sub, { ts: Date.now() - HOT_CACHE_TTL_MS + 60_000, threads: [] });
    return { sub, threads: [] };
  }
}

async function fetchAllHotSequential() {
  const out = [];
  for (const sub of SUBREDDITS) {
    out.push(await fetchSubHotThreads(sub));
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

  // Run the comments fetch (drives the channel-RANKING via velocity)
  // and the hot-threads fetch (drives the SNIPPET content) in
  // parallel. Both share the same 1.5s rate-limit slot via
  // lastRequestAt, so they serialize across endpoints automatically —
  // we just don't have to wait for one before kicking off the other.
  const [perSub, perSubHot] = await Promise.all([
    fetchAllSubsSequential(),
    fetchAllHotSequential(),
  ]);
  const allComments = perSub.flatMap((r) => r.comments);
  if (allComments.length === 0 && perSubHot.every((r) => r.threads.length === 0)) {
    return new Map();
  }

  // Determine the spread of comment timestamps; convert "matched count"
  // into a per-minute rate so it composes with other sources.
  const nows = allComments.map((c) => (c.created_utc || 0) * 1000).filter(Boolean);
  const oldest = nows.length ? Math.min(...nows) : Date.now();
  const newest = nows.length ? Math.max(...nows) : Date.now();
  const minutesSpan = Math.max(1, (newest - oldest) / 60_000);

  // 1. DIRECT attribution from comments — count comments whose thread
  // title or body mentions a broadcaster's reddit_terms. Drives ranking.
  const directCounts = new Map();
  for (const c of allComments) {
    const haystack = `${c.link_title || ''} ${c.link_flair_text || ''} ${(c.body || '').slice(0, 500)}`.toLowerCase();
    for (const m of matchers) {
      if (m.terms.some((t) => haystack.includes(t))) {
        directCounts.set(m.id, (directCounts.get(m.id) || 0) + 1);
      }
    }
  }

  // 2. INDIRECT attribution — sub-local comment velocity × per-channel
  // weight. Keep track of which sub gave each channel its strongest
  // contribution so we can pick the right hot thread for the snippet.
  const indirectRates = new Map();
  const indirectTopSub = new Map(); // chId → { sub, contribution }
  const channelIds = new Set(channels.map((c) => c.id));
  for (const { sub, comments } of perSub) {
    if (comments.length === 0) continue;
    const attribution = INDIRECT_SUB_ATTRIBUTION[sub];
    if (!attribution) continue;
    const ts = comments.map((c) => (c.created_utc || 0) * 1000).filter(Boolean);
    if (ts.length === 0) continue;
    const subSpan = Math.max(1, (Math.max(...ts) - Math.min(...ts)) / 60_000);
    const subRate = comments.length / subSpan;
    for (const [chId, weight] of Object.entries(attribution)) {
      if (!channelIds.has(chId)) continue;
      const contribution = subRate * weight;
      indirectRates.set(chId, (indirectRates.get(chId) || 0) + contribution);
      const prev = indirectTopSub.get(chId);
      if (!prev || contribution > prev.contribution) {
        indirectTopSub.set(chId, { sub, contribution });
      }
    }
  }

  // Combine: direct (per-comment count → /min) + indirect (already /min).
  const rates = new Map();
  for (const [id, n] of directCounts) rates.set(id, n / minutesSpan);
  for (const [id, r] of indirectRates) {
    rates.set(id, (rates.get(id) || 0) + r);
  }

  // Build SNIPPETS from the hot-threads endpoint. This is where we get
  // real engagement numbers (num_comments in the hundreds/thousands,
  // not 12) and Reddit's own canonical hot ranking instead of "which
  // thread happened to dominate our 100-comment sample."
  //
  // For each channel, prefer (in order):
  //   1. The hot-thread (across ALL sampled subs) whose title/flair
  //      mentions the broadcaster terms — that's the news story or game
  //      that actually mentions this channel by name. Pick the highest
  //      threadHeat score among matches.
  //   2. The hot-thread with the highest threadHeat in the sub that
  //      gave this channel its biggest indirect contribution — e.g. for
  //      ESPN that's typically the r/nfl megathread, which IS the
  //      "what game is being talked about" answer the user wanted.
  const allHotThreads = perSubHot.flatMap((r) =>
    (r.threads || []).map((t) => ({ ...t, _sub: r.sub }))
  );
  const hotBySub = new Map();
  for (const { sub, threads } of perSubHot) {
    if (!threads || threads.length === 0) continue;
    const ranked = [...threads].sort((a, b) => threadHeat(b) - threadHeat(a));
    hotBySub.set(sub, ranked);
  }

  const snippets = new Map();
  for (const m of matchers) {
    if (!rates.has(m.id)) continue;
    // Pass 1 — direct: any hot thread whose title/flair mentions terms
    let bestDirect = null;
    let bestDirectHeat = -Infinity;
    for (const t of allHotThreads) {
      const hay = `${t.title || ''} ${t.link_flair_text || ''}`.toLowerCase();
      if (!m.terms.some((term) => hay.includes(term))) continue;
      const h = threadHeat(t);
      if (h > bestDirectHeat) { bestDirectHeat = h; bestDirect = t; }
    }
    if (bestDirect) {
      snippets.set(m.id, {
        attribution: 'direct',
        title: bestDirect.title,
        subreddit: bestDirect._sub || bestDirect.subreddit,
        comments: bestDirect.num_comments || 0,
        score: bestDirect.score || 0,
        permalink: bestDirect.permalink || null,
        ageHours: Math.round((Date.now() / 1000 - (bestDirect.created_utc || 0)) / 3600),
      });
      continue;
    }
    // Pass 2 — indirect: top hot thread in the strongest contributing sub
    const indirectInfo = indirectTopSub.get(m.id);
    if (indirectInfo) {
      const ranked = hotBySub.get(indirectInfo.sub);
      const top = ranked && ranked[0];
      if (top) {
        snippets.set(m.id, {
          attribution: 'indirect',
          title: top.title,
          subreddit: indirectInfo.sub,
          comments: top.num_comments || 0,
          score: top.score || 0,
          permalink: top.permalink || null,
          ageHours: Math.round((Date.now() / 1000 - (top.created_utc || 0)) / 3600),
        });
      }
    }
  }
  lastSnippets = snippets;

  if (rates.size > 0) {
    const directHits = directCounts.size;
    const indirectHits = indirectRates.size;
    const hotCount = allHotThreads.length;
    logger.info(`[RedditVel] ${rates.size} channels (direct=${directHits}, indirect=${indirectHits}) · ${snippets.size} snippets from ${hotCount} hot threads / ${allComments.length} comments / ${SUBREDDITS.length} subs`);
  }
  return rates;
}

function getSnippets() {
  return lastSnippets;
}

module.exports = {
  name: 'reddit',
  enabled: () => true,
  fetchSignals,
  getSnippets,
};
