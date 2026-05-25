/**
 * YouTube service — thin wrapper around the `yt-dlp` binary.
 *
 * Three jobs:
 *   1. resolveChannel(input)   — paste-a-URL / @handle → channel metadata
 *   2. searchChannels(query)   — yt-dlp ytsearch → list of channel candidates
 *   3. resolveLiveStream(uc)   — current live broadcast of a channel → HLS URL
 *
 * HLS URLs returned by YouTube are time-limited (~6h). We cache the
 * resolution result for a few minutes so a freshly-mounted tile doesn't
 * fire its own yt-dlp call every render, but we never return a URL
 * whose embedded expire= param is past — the cache is treated as a
 * miss in that case and a fresh resolution is triggered.
 *
 * yt-dlp spawns are cheap (no Node-side bottleneck) but YouTube rate-
 * limits aggressively — keep concurrent resolutions per channel
 * serialised so multiple tiles asking for the same channel-live URL
 * don't pile up.
 */

const { spawn } = require('child_process');
const logger = require('../config/logger');

const YT_DLP_BIN = process.env.YT_DLP_BIN || '/usr/local/bin/yt-dlp';
const DEFAULT_TIMEOUT_MS = 25_000;

// Resolution cache. Live-stream URLs only — search results are not
// cached server-side (cheap enough on the user's side).
const liveCache = new Map(); // channelId -> { hlsUrl, expiresAt, channel }
const inflightLive = new Map(); // channelId -> Promise

function runYtDlp(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    let stdout = '';
    let stderr = '';
    let timer = null;

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || stdout).split('\n').filter(Boolean).slice(-3).join(' | ');
        reject(new Error(`yt-dlp exit ${code}: ${tail || '(no output)'}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseJsonLines(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch (_) { /* skip non-JSON noise */ }
  }
  return out;
}

function extractExpireParam(url) {
  const m = /[?&]expire=(\d+)/.exec(url || '');
  return m ? Number(m[1]) * 1000 : null;
}

function pickBestHls(formats) {
  // Prefer combined audio+video HLS streams (no DASH-only / video-only).
  const candidates = (formats || []).filter((f) => {
    const proto = String(f.protocol || '');
    return proto === 'm3u8' || proto === 'm3u8_native';
  }).filter((f) => f.acodec !== 'none' && f.vcodec !== 'none');

  if (candidates.length === 0) {
    // Fallback: any HLS, even if vcodec/acodec missing.
    const any = (formats || []).filter((f) => /m3u8/.test(String(f.protocol || '')));
    if (any.length === 0) return null;
    any.sort((a, b) => (b.height || 0) - (a.height || 0));
    return any[0];
  }

  // Prefer 720p as a balance between quality and tile bandwidth; allow up.
  candidates.sort((a, b) => {
    const targetA = Math.abs((a.height || 0) - 720);
    const targetB = Math.abs((b.height || 0) - 720);
    if (targetA !== targetB) return targetA - targetB;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return candidates[0];
}

function toChannelSummary(j) {
  return {
    channelId: j.channel_id || j.uploader_id || null,
    name: j.channel || j.uploader || j.title || 'YouTube channel',
    handle: j.uploader_id?.startsWith?.('@') ? j.uploader_id
          : (j.uploader_url || '').match(/@([\w.-]+)/)?.[0] || null,
    channelUrl: j.channel_url || j.uploader_url || null,
    avatarUrl: pickAvatar(j),
    isLive: !!j.is_live || j.live_status === 'is_live',
    liveStatus: j.live_status || null,
    description: j.description ? String(j.description).slice(0, 300) : null
  };
}

function pickAvatar(j) {
  // yt-dlp's "thumbnails" is a list; for a channel resolve we get
  // the channel banner, for a live video resolve we get the video
  // poster. Either is acceptable for a small avatar tile.
  const list = j.thumbnails || [];
  if (Array.isArray(list) && list.length) {
    const sorted = [...list].sort((a, b) => (b.preference || 0) - (a.preference || 0) || (b.height || 0) - (a.height || 0));
    return sorted[0]?.url || null;
  }
  return j.thumbnail || null;
}

/**
 * Normalize user input into a yt-dlp-accepted target.
 *
 * For channel-style URLs (handles, /channel/UC..., bare @-handles),
 * we ALWAYS append /live — this restricts yt-dlp to the channel's
 * live tab (single resource) instead of expanding the full uploads
 * playlist which takes 30+ seconds. The /live endpoint exists for
 * every channel even when not currently broadcasting.
 *
 *   "https://www.youtube.com/@LofiGirl"            → @LofiGirl/live
 *   "https://www.youtube.com/channel/UC..."        → channel/UC.../live
 *   "https://www.youtube.com/watch?v=abc"          → as-is (specific video)
 *   "https://youtu.be/abc"                         → as-is
 *   "@LofiGirl"                                    → wraps + /live
 *   "UC..."                                        → wraps + /live
 *   bare query                                     → null (use search path)
 */
function normalizeInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const appendLive = (url) => {
    if (/\/live\/?$/.test(url) || /\/live\?/.test(url)) return url;
    return url.replace(/\/+$/, '') + '/live';
  };

  if (/^https?:\/\//i.test(s)) {
    // Specific video URLs (watch, youtu.be, /live/<id>) — leave alone.
    if (/\/watch\?|youtu\.be\/|\/live\/[\w-]+/.test(s)) return s;
    // Channel-style URLs — append /live to skip the uploads-playlist walk.
    if (/youtube\.com\/(@[\w.-]+|channel\/UC[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/.test(s)) {
      return appendLive(s);
    }
    return s;
  }
  if (/^@[\w.-]+$/.test(s)) return `https://www.youtube.com/${s}/live`;
  if (/^UC[\w-]{20,}$/.test(s)) return `https://www.youtube.com/channel/${s}/live`;
  return null;
}

/**
 * Resolve any YouTube URL or handle to channel-level metadata.
 *
 * Fast path: hit /live (already in normalized URL). If the channel
 * is broadcasting, we get full video metadata back. If not, yt-dlp
 * errors with "channel is not currently live" and we fall back to
 * a flat-playlist probe of the channel home (cheap — single entry).
 */
async function resolveChannel(rawInput) {
  const liveTarget = normalizeInput(rawInput);
  if (!liveTarget) {
    throw new Error('Pass a YouTube URL, @handle, or UC… channel id.');
  }

  try {
    const stdout = await runYtDlp([
      '-J',
      '--no-warnings',
      '--no-check-certificate',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout', '15',
      liveTarget
    ], { timeoutMs: 25_000 });

    const j = JSON.parse(stdout.trim());
    const summary = toChannelSummary(j);
    if (summary.channelId) return summary;
  } catch (err) {
    const msg = String(err.message || '');
    const isOffline = /not currently live|offline|no live|This live event will begin|no live streams/i.test(msg);
    if (!isOffline) throw err;
    // fall through to static-metadata fallback
  }

  // Fallback: resolve the channel home with --flat-playlist + a single
  // playlist item. yt-dlp returns the channel-level metadata block
  // (name, channel_id, thumbnails) without walking the full uploads list.
  const homeTarget = liveTarget.replace(/\/live\/?$/, '');
  const stdout = await runYtDlp([
    '-J',
    '--no-warnings',
    '--no-check-certificate',
    '--flat-playlist',
    '--playlist-end', '1',
    '--socket-timeout', '15',
    homeTarget
  ], { timeoutMs: 25_000 });

  const j = JSON.parse(stdout.trim());
  const channelId = j.channel_id || j.uploader_id || j.id || null;
  if (!channelId || !/^UC[\w-]{20,}$/.test(channelId)) {
    throw new Error('Could not extract a YouTube channel id from that URL.');
  }
  return {
    channelId,
    name: j.channel || j.uploader || j.title || 'YouTube channel',
    handle: j.uploader_id?.startsWith?.('@') ? j.uploader_id
          : (j.uploader_url || j.channel_url || '').match(/@([\w.-]+)/)?.[0] || null,
    channelUrl: j.channel_url || j.uploader_url || homeTarget,
    avatarUrl: pickAvatar(j),
    isLive: false,
    liveStatus: 'not_live',
    description: j.description ? String(j.description).slice(0, 300) : null
  };
}

/**
 * Search YouTube via yt-dlp's ytsearch: protocol. Returns video hits
 * with their channel info — we dedupe by channel so the user picks
 * a CHANNEL to favorite (not a specific video).
 */
async function searchChannels(query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  // ytsearchN — gives N video matches; we extract channel info from
  // each. --flat-playlist keeps it cheap (no per-video page fetch).
  const stdout = await runYtDlp([
    '-J',
    '--no-warnings',
    '--no-check-certificate',
    '--flat-playlist',
    '--default-search', 'ytsearch',
    '--socket-timeout', '15',
    `ytsearch${Math.max(limit * 2, 12)}:${q}`
  ], { timeoutMs: 25_000 });

  const json = stdout.trim();
  if (!json) return [];
  let parsed;
  try { parsed = JSON.parse(json); } catch (e) { return []; }

  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const byChannel = new Map();
  for (const e of entries) {
    const channelId = e.channel_id || e.uploader_id || null;
    if (!channelId) continue;
    if (byChannel.has(channelId)) continue;
    byChannel.set(channelId, {
      channelId,
      name: e.channel || e.uploader || 'YouTube channel',
      handle: (e.uploader_url || '').match(/@([\w.-]+)/)?.[0] || null,
      channelUrl: e.channel_url || e.uploader_url || (channelId ? `https://www.youtube.com/channel/${channelId}` : null),
      avatarUrl: pickAvatar(e),
      // Best-effort live signal from the search result itself.
      isLive: !!e.is_live || e.live_status === 'is_live',
      // Sample video that surfaced the channel — useful as a "preview".
      sampleVideoTitle: e.title || null,
      sampleVideoId: e.id || null
    });
    if (byChannel.size >= limit) break;
  }
  return Array.from(byChannel.values());
}

/**
 * Resolve a channel's current live broadcast to an HLS URL.
 *
 * If the channel isn't currently live, returns { isLive: false }
 * with no hlsUrl. Caller (frontend tile) should show an OFFLINE state.
 */
async function resolveLiveStream(channelId, { force = false } = {}) {
  if (!channelId) throw new Error('channelId required');

  // 1. Cache hit (if not expired)
  if (!force) {
    const cached = liveCache.get(channelId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.payload;
    }
  }

  // 2. Coalesce concurrent resolves for the same channel
  if (inflightLive.has(channelId)) {
    return inflightLive.get(channelId);
  }

  const p = (async () => {
    const target = `https://www.youtube.com/channel/${channelId}/live`;
    let stdout;
    try {
      stdout = await runYtDlp([
        '-J',
        '--no-warnings',
        '--no-check-certificate',
        '--no-playlist',
        '--skip-download',
        '--socket-timeout', '15',
        target
      ], { timeoutMs: 30_000 });
    } catch (err) {
      // Distinguish "not currently live" from real errors. yt-dlp
      // emits "ERROR: ... is offline" or similar to stderr.
      const msg = String(err.message || '');
      if (/offline|no live|not currently live|This live event will begin/i.test(msg)) {
        const payload = { isLive: false, channel: null, hlsUrl: null };
        liveCache.set(channelId, { payload, expiresAt: Date.now() + 60_000 });
        return payload;
      }
      throw err;
    }

    const j = JSON.parse(stdout);
    const channel = toChannelSummary(j);
    if (!channel.isLive) {
      const payload = { isLive: false, channel, hlsUrl: null };
      liveCache.set(channelId, { payload, expiresAt: Date.now() + 60_000 });
      return payload;
    }

    const fmt = pickBestHls(j.formats);
    if (!fmt || !fmt.url) {
      throw new Error('Channel is live but no HLS manifest was returned.');
    }

    const expireAtFromUrl = extractExpireParam(fmt.url);
    // Be conservative: cache until min(URL expire, 30 min from now).
    const cacheUntil = Math.min(
      expireAtFromUrl ? expireAtFromUrl - 60_000 : Date.now() + 30 * 60_000,
      Date.now() + 30 * 60_000
    );

    const payload = {
      isLive: true,
      channel,
      hlsUrl: fmt.url,
      height: fmt.height || null,
      tbr: fmt.tbr || null,
      videoId: j.id || null,
      videoTitle: j.title || null
    };
    liveCache.set(channelId, { payload, expiresAt: cacheUntil });
    return payload;
  })();

  inflightLive.set(channelId, p);
  try {
    return await p;
  } finally {
    inflightLive.delete(channelId);
  }
}

/**
 * Lightweight "is this channel live right now?" probe used by the
 * favorites strip — does NOT cache to liveCache because we don't want
 * a stale failed probe to break the next real playback request.
 */
async function checkLiveStatus(channelId) {
  try {
    const r = await resolveLiveStream(channelId);
    return { channelId, isLive: !!r.isLive, channel: r.channel || null };
  } catch (e) {
    return { channelId, isLive: false, error: e.message };
  }
}

function clearCache(channelId) {
  if (channelId) liveCache.delete(channelId);
  else liveCache.clear();
}

module.exports = {
  resolveChannel,
  searchChannels,
  resolveLiveStream,
  checkLiveStatus,
  clearCache,
  // exposed for tests
  _normalizeInput: normalizeInput,
  _pickBestHls: pickBestHls
};
