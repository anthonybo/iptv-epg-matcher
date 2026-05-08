/**
 * Bluesky firehose mention-velocity source.
 *
 * Subscribes to Bluesky's Jetstream WebSocket — a public, no-auth,
 * filtered firehose of every post on the network — and counts mentions
 * of broadcaster handles per channel. Decays the count exponentially so
 * older mentions weigh less; the value returned is "effective mentions
 * over the last ~5 minutes."
 *
 * Why Jetstream over the standard XRPC firehose: it streams already-
 * decoded JSON (no CBOR/DAG-CBOR repos to assemble), so we can match
 * substrings without per-message protocol overhead.
 *
 * Singleton: one connection for the whole process. Reconnects with
 * exponential backoff on close. The connection is established lazily
 * the first time fetchSignals() is called.
 *
 * Endpoint: wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post
 *
 * Uses Node's native WebSocket (Node 22+).
 */

const logger = require('../../config/logger');

const WebSocketCtor = typeof WebSocket !== 'undefined' ? WebSocket : null;

const ENDPOINT =
  'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';

const HALF_LIFE_MS = 5 * 60 * 1000; // mention weight halves every 5 min
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_MS;

// channel.id → { score, lastTs }
const scoreState = new Map();

// channel.id → array of recent matched posts (oldest first), each
// { text, ts }. Capped per channel — reading getSnippets() picks the
// most recent. This gives the trending UI a real "what people are
// posting about <channel> right now" excerpt rather than just a count.
const RECENT_POSTS_PER_CHANNEL = 8;
const recentPosts = new Map();

let ws = null;
let backoffMs = 1000;
let started = false;
let lastChannelsForMatchers = [];
let matchers = []; // { id, needles: string[] }

function rebuildMatchers(channels) {
  matchers = channels
    .filter((c) => c.bsky_handle)
    .map((c) => {
      const h = String(c.bsky_handle).toLowerCase();
      // match @handle, bare handle, or full URL fragment
      const needles = [`@${h}`, h];
      return { id: c.id, needles };
    });
  lastChannelsForMatchers = channels;
}

function decayedScore(state, now) {
  if (!state) return 0;
  const dt = Math.max(0, now - state.lastTs);
  return state.score * Math.exp(-DECAY_LAMBDA * dt);
}

function applyMention(channelId, now, postText) {
  const prev = scoreState.get(channelId);
  const decayed = decayedScore(prev, now);
  scoreState.set(channelId, { score: decayed + 1, lastTs: now });
  if (postText) {
    let buf = recentPosts.get(channelId);
    if (!buf) { buf = []; recentPosts.set(channelId, buf); }
    buf.push({ text: postText, ts: now });
    if (buf.length > RECENT_POSTS_PER_CHANNEL) buf.shift();
  }
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch { return; }
  if (msg.kind !== 'commit') return;
  const op = msg.commit;
  if (op?.collection !== 'app.bsky.feed.post') return;
  if (op?.operation !== 'create') return;
  const text = op.record?.text;
  if (!text) return;
  const lower = text.toLowerCase();
  const now = Date.now();
  for (const m of matchers) {
    if (m.needles.some((n) => lower.includes(n))) {
      applyMention(m.id, now, text);
    }
  }
}

function connect() {
  if (!WebSocketCtor) return;
  try {
    ws = new WebSocketCtor(ENDPOINT);
  } catch (e) {
    logger.debug(`[BskyVel] connect threw: ${e.message}`);
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open', () => {
    backoffMs = 1000;
    logger.info('[BskyVel] connected to Jetstream');
  });
  ws.addEventListener('message', (event) => {
    // event.data is a string for text frames
    handleMessage(typeof event.data === 'string' ? event.data : event.data?.toString());
  });
  ws.addEventListener('error', (event) => {
    logger.debug(`[BskyVel] ws error: ${event?.message || 'unknown'}`);
  });
  ws.addEventListener('close', () => {
    ws = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  const wait = Math.min(backoffMs, 60_000);
  backoffMs = Math.min(backoffMs * 2, 60_000);
  setTimeout(connect, wait);
}

function ensureStarted(channels) {
  if (started) {
    if (channels !== lastChannelsForMatchers) rebuildMatchers(channels);
    return;
  }
  started = true;
  rebuildMatchers(channels);
  if (!WebSocketCtor) {
    logger.info('[BskyVel] native WebSocket unavailable (need Node 22+) — source disabled');
    return;
  }
  connect();
}

/**
 * @param {Array<{id: string, bsky_handle?: string|null}>} channels
 * @returns {Promise<Map<string, number>>} channel.id → decayed mention score (~mentions in last 5 min)
 */
async function fetchSignals(channels) {
  ensureStarted(channels);
  if (!WebSocketCtor) return new Map();
  const now = Date.now();
  const out = new Map();
  for (const [id, state] of scoreState) {
    const v = decayedScore(state, now);
    if (v >= 0.1) out.set(id, v);
  }
  return out;
}

function getSnippets() {
  // Map<channelId, { text, ts }> — most recent matched post per channel
  // (single excerpt; the rolling buffer is for future "scroll through
  // mentions" UX, but the modal just shows the freshest one today).
  const out = new Map();
  for (const [id, buf] of recentPosts) {
    if (!buf || buf.length === 0) continue;
    const latest = buf[buf.length - 1];
    if (!latest?.text) continue;
    out.set(id, { text: latest.text, ts: latest.ts });
  }
  return out;
}

module.exports = {
  name: 'bluesky',
  enabled: () => Boolean(WebSocketCtor),
  fetchSignals,
  getSnippets,
};
