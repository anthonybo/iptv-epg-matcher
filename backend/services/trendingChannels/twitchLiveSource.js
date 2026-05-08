/**
 * Twitch live restream proxy.
 *
 * Cable broadcasts often appear as "IRL"/"Just Chatting"/"Sports" Twitch
 * streams (frequently DMCA'd, but the aggregate viewer counts during
 * breaking news / finals / big matches are a real proxy for what people
 * are tuning into). We pull the top-N streams per relevant category with
 * Helix `Get Streams`, then match each stream's title against per-channel
 * regex from the config map and sum viewer_count per channel.
 *
 * Disabled when TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are missing.
 *
 * Token caching: app-access-tokens last ~60 days; we refresh on 401.
 */

const axios = require('axios');
const logger = require('../../config/logger');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2/token';

// Categories where TV restreams typically end up. Game IDs are stable.
// Pulled from the Helix Get Games endpoint reference; "Sports", "News &
// Politics", "Talk Shows & Podcasts", "Just Chatting", "IRL" (legacy).
const CATEGORY_NAMES = ['Sports', 'News & Politics', 'Talk Shows & Podcasts', 'Just Chatting'];

let tokenCache = { token: null, exp: 0 };

// Per-channel "what's on the top restream right now" snippet —
// repopulated each fetchSignals call. Read by the orchestrator via
// getSnippets() so the trending response can describe what's literally
// being broadcast (e.g. "🔴 Cowboys vs Eagles SNF") instead of just the
// channel name.
let lastSnippets = new Map();

function enabled() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function getAppToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const resp = await axios.post(OAUTH, null, {
    params: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    },
    timeout: 8000,
  });
  tokenCache = {
    token: resp.data.access_token,
    exp: Date.now() + (resp.data.expires_in * 1000),
  };
  return tokenCache.token;
}

async function helixGet(path, params, retried = false) {
  const token = await getAppToken();
  try {
    const resp = await axios.get(`${HELIX}${path}`, {
      params,
      headers: { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    return resp.data;
  } catch (e) {
    if (e.response?.status === 401 && !retried) {
      tokenCache = { token: null, exp: 0 };
      return helixGet(path, params, true);
    }
    throw e;
  }
}

let categoryIdCache = null;
async function resolveCategoryIds() {
  if (categoryIdCache) return categoryIdCache;
  try {
    const resp = await helixGet('/games', {
      // Helix accepts repeated `name` query params
      name: CATEGORY_NAMES,
    });
    categoryIdCache = (resp.data || []).map((g) => g.id);
    return categoryIdCache;
  } catch (e) {
    logger.debug(`[TwitchLive] resolve categories: ${e.message}`);
    categoryIdCache = [];
    return [];
  }
}

async function fetchTopStreams(gameIds, perGame = 100) {
  const out = [];
  for (const gid of gameIds) {
    try {
      const resp = await helixGet('/streams', {
        game_id: gid,
        first: perGame,
        type: 'live',
      });
      out.push(...(resp.data || []));
    } catch (e) {
      logger.debug(`[TwitchLive] streams for game ${gid}: ${e.message}`);
    }
  }
  return out;
}

/**
 * @param {Array<{id: string, twitch_match?: string|null}>} channels
 * @returns {Promise<Map<string, number>>} channel.id → summed viewer_count
 */
async function fetchSignals(channels) {
  if (!enabled()) return new Map();
  const matchers = channels
    .filter((c) => c.twitch_match)
    .map((c) => ({ id: c.id, re: new RegExp(c.twitch_match, 'i') }));
  if (matchers.length === 0) return new Map();

  let streams = [];
  try {
    const gameIds = await resolveCategoryIds();
    streams = await fetchTopStreams(gameIds, 100);
  } catch (e) {
    logger.warn(`[TwitchLive] fetch failed: ${e.message}`);
    return new Map();
  }

  const sums = new Map();
  // For each matched channel keep the single highest-viewer stream's
  // title — that's the most representative "what's on" line. Lower-rank
  // restreams are usually low-quality clones of the same content.
  const topByChannel = new Map(); // chId → { title, userName, viewers }
  for (const s of streams) {
    const title = `${s.title || ''} ${s.user_name || ''}`;
    for (const { id, re } of matchers) {
      if (re.test(title)) {
        sums.set(id, (sums.get(id) || 0) + (s.viewer_count || 0));
        const prev = topByChannel.get(id);
        const viewers = s.viewer_count || 0;
        if (!prev || viewers > prev.viewers) {
          topByChannel.set(id, {
            title: s.title || '',
            userName: s.user_name || '',
            viewers,
          });
        }
      }
    }
  }
  lastSnippets = topByChannel;
  if (sums.size > 0) {
    logger.info(`[TwitchLive] ${sums.size} channels with restream viewers (from ${streams.length} streams scanned)`);
  }
  return sums;
}

function getSnippets() {
  return lastSnippets;
}

module.exports = {
  name: 'twitch',
  enabled,
  fetchSignals,
  getSnippets,
};
