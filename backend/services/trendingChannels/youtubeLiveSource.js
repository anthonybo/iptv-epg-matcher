/**
 * YouTube Live concurrent-viewers source.
 *
 * For each mapped channel that has `youtube_channel_id`, find its
 * currently-live broadcast and read `liveStreamingDetails.concurrentViewers`.
 * That's our strongest live-now signal — most major news broadcasters run
 * 24/7 official YouTube live mirrors (BBC, Sky, Al Jazeera, France 24, DW,
 * NHK, ABC News Live, NBC News NOW, CBS News, Bloomberg, CNBC, Reuters).
 *
 * Disabled when YOUTUBE_API_KEY is missing — silent no-op so the rest of
 * the trending pipeline still works on Reddit/Bluesky alone.
 *
 * Quota: search.list = 100 units/call, videos.list = 1 unit/call.
 * We use the cheap path: `search.list?channelId=X&eventType=live&type=video`
 * (1 search per channel = 100 units) then `videos.list` for batched stats
 * (1 unit per call, max 50 video IDs per call). With ~25 mapped channels
 * × 1 refresh/min → 25 × 100 + a few videos.list = 2500 units/min, way
 * over the default 10k/day cap. So we cache aggressively (5 min TTL on
 * the search step — broadcasters don't start/stop live streams often)
 * and only re-run the cheap stats lookup every 60s.
 */

const axios = require('axios');
const logger = require('../../config/logger');

const API_KEY = process.env.YOUTUBE_API_KEY || '';
const BASE = 'https://www.googleapis.com/youtube/v3';

// channelId -> { videoId, ts }
const liveVideoCache = new Map();
const SEARCH_TTL_MS = 5 * 60 * 1000;

function enabled() {
  return Boolean(API_KEY);
}

async function findLiveVideoId(channelId) {
  const cached = liveVideoCache.get(channelId);
  if (cached && Date.now() - cached.ts < SEARCH_TTL_MS) {
    return cached.videoId;
  }
  try {
    const resp = await axios.get(`${BASE}/search`, {
      params: {
        key: API_KEY,
        channelId,
        eventType: 'live',
        type: 'video',
        part: 'id',
        maxResults: 1,
      },
      timeout: 8000,
    });
    const videoId = resp.data?.items?.[0]?.id?.videoId || null;
    liveVideoCache.set(channelId, { videoId, ts: Date.now() });
    return videoId;
  } catch (e) {
    logger.debug(`[YouTubeLive] search failed for ${channelId}: ${e.message}`);
    liveVideoCache.set(channelId, { videoId: null, ts: Date.now() });
    return null;
  }
}

async function fetchConcurrentViewers(videoIds) {
  if (videoIds.length === 0) return new Map();
  const out = new Map();
  // videos.list accepts up to 50 ids per call
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const resp = await axios.get(`${BASE}/videos`, {
        params: {
          key: API_KEY,
          id: batch.join(','),
          part: 'liveStreamingDetails',
        },
        timeout: 8000,
      });
      for (const item of resp.data?.items || []) {
        const v = item.liveStreamingDetails?.concurrentViewers;
        if (v != null) out.set(item.id, parseInt(v, 10) || 0);
      }
    } catch (e) {
      logger.debug(`[YouTubeLive] videos.list batch failed: ${e.message}`);
    }
  }
  return out;
}

/**
 * @param {Array<{id: string, youtube_channel_id?: string|null}>} channels
 * @returns {Promise<Map<string, number>>} channel.id → concurrent viewers
 */
async function fetchSignals(channels) {
  if (!enabled()) return new Map();
  const targeted = channels.filter((c) => c.youtube_channel_id);
  if (targeted.length === 0) return new Map();

  const videoIds = [];
  const idByVideo = new Map();
  await Promise.all(
    targeted.map(async (c) => {
      const vid = await findLiveVideoId(c.youtube_channel_id);
      if (vid) {
        videoIds.push(vid);
        idByVideo.set(vid, c.id);
      }
    })
  );

  const viewersByVideo = await fetchConcurrentViewers(videoIds);
  const out = new Map();
  for (const [vid, viewers] of viewersByVideo) {
    const channelId = idByVideo.get(vid);
    if (channelId) out.set(channelId, viewers);
  }
  if (out.size > 0) {
    logger.info(`[YouTubeLive] ${out.size} channels with concurrent viewers`);
  }
  return out;
}

module.exports = {
  name: 'youtube',
  enabled,
  fetchSignals,
};
