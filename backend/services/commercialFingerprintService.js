/**
 * Commercial Fingerprint Service — high-precision, marker-free ad detection.
 *
 * This is the verified-best approach for SCTE-35-stripped live restreams (see
 * the deep-research conclusion): a self-bootstrapping audio-fingerprint
 * pipeline that needs NO per-channel models, NO labels, and NO ad markers.
 *
 *   Stage 2 — Per channel, ffmpeg decodes the upstream to mono 22050 Hz PCM
 *             and feeds it to a Shazam-style landmark fingerprinter
 *             (stream-audio-fingerprint). Every channel's fingerprints flow
 *             into a shared rolling index (repIndex).
 *
 *   Stage 3 — Cross-channel / cross-time REPETITION. An ad creative is short
 *             and airs repeatedly across channels and over time; live content
 *             does not. When a channel's recent audio aligns strongly with
 *             audio seen on ANOTHER channel, or on the SAME channel a while
 *             earlier, that span is a repeat → catalogued. A creative is only
 *             PROMOTED to the active mute-catalog once it has been observed at
 *             least MIN_HITS_TO_CONFIRM times in separate windows. That confirm
 *             gate is also what defeats the simulcast/duplicate-feed false
 *             positive: a live game shown on two feeds is ever-changing, so it
 *             never matches the SAME creative twice and is never promoted.
 *
 *   Stage 4 — Live verdict. Each channel's recent audio is continuously matched
 *             against the confirmed ad catalog (adIndex). A strong match is a
 *             high-precision "this channel is in a known ad" signal, broadcast
 *             over SSE as a commercial-break start/end so the client can mute.
 *
 * Cold start: the first airing(s) of a never-before-seen ad cannot be matched
 * (nothing to match against yet) — this is the fundamental, unavoidable limit
 * of fingerprinting. It is solved over time, not per-channel: the catalog fills
 * itself from repetition and persists across sessions, so cold start shrinks
 * the longer the system runs and the more channels are watched.
 *
 * Connection note: one extra upstream connection per distinct channel
 * (ref-counted; N viewers of one channel share it). Opt-in.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const Codegen = require('stream-audio-fingerprint');
const logger = require('../config/logger');
const postgresService = require('./postgresService');
const { broadcastSSEUpdate } = require('../utils/sseUtils');
const { match, isStrong, FRAME_MS } = require('./landmarkMatcher');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// ── Tunables ────────────────────────────────────────────────────────
const TICK_MS = 2000;                 // detection cadence
const REP_EVERY_TICKS = 4;            // run repetition scan every ~8s
const PRUNE_EVERY_TICKS = 30;         // prune rolling index every ~60s

const LIVE_QUERY_MS = 6000;           // recent window matched against the ad catalog
const REP_QUERY_MS = 20000;           // recent window used to detect repeats (ad-length)
const RECENT_KEEP_MS = 32000;         // per-channel fingerprint retention (> REP_QUERY_MS)
const REP_WINDOW_MS = 20 * 60 * 1000; // cross-channel reference retention

const MIN_REP_LANDMARKS = 40;         // aligned landmarks to call a repeat
const MIN_CREATIVE_MS = 8000;         // a repeat must span this long to be an ad creative
const MAX_CREATIVE_MS = 90000;        // …and no longer than this
const SELF_REAIR_MS = 90000;          // same-channel match must be this far apart to count

const LIVE_MATCH_MIN = 20;            // aligned landmarks for a live catalog match
const LIVE_MATCH_SPAN_MS = 3000;      // …spanning at least this long
const AD_QUIET_MS = 5000;             // no catalog match for this long → ad ended

const MIN_HITS_TO_CONFIRM = 2;        // observations before a creative can mute
const MIN_SEPARATION_MS = 60000;      // min gap between counted hits for one creative
const PROVISIONAL_TTL_MS = 6 * 3600 * 1000; // drop unconfirmed one-offs after this

const RESTART_DELAY_MS = 5000;        // re-spawn analyzer after an unexpected exit

const QUERY_FRAMES = (ms) => Math.round(ms / FRAME_MS);

// ── State ───────────────────────────────────────────────────────────
// channelId -> analyzer
const analyzers = new Map();

// Shared cross-channel rolling reference: hcode -> [{ id:channelId, t, addedMs }]
// `t` is a per-channel cumulative frame index (survives analyzer restarts);
// `addedMs` is wall-clock, used only for age pruning.
const repIndex = new Map();

// Catalogued ad creatives.
//   provIndex: hcode -> [{ id:creativeId, t }]   (ALL creatives, for dedup)
//   adIndex:   hcode -> [{ id:creativeId, t }]   (CONFIRMED only, for live mute)
//   creatives: creativeId -> { hitCount, lastHitMs, confirmed, durationMs }
const provIndex = new Map();
const adIndex = new Map();
const creatives = new Map();

let tickTimer = null;
let tickCount = 0;
let catalogLoaded = false;

// ── Index helpers (add/prune on the shared Maps) ────────────────────
function indexAdd(index, hcode, entry) {
  let arr = index.get(hcode);
  if (!arr) { arr = []; index.set(hcode, arr); }
  arr.push(entry);
}

function pruneRepIndex(cutoffMs) {
  let removed = 0;
  for (const [hcode, arr] of repIndex) {
    const kept = arr.filter((e) => e.addedMs >= cutoffMs);
    if (kept.length === 0) { repIndex.delete(hcode); removed += arr.length; }
    else if (kept.length !== arr.length) { repIndex.set(hcode, kept); removed += arr.length - kept.length; }
  }
  if (removed) logger.debug(`[CommercialFP] pruned ${removed} stale repIndex entries`);
}

// ── Catalog load (boot) ─────────────────────────────────────────────
async function loadCatalog() {
  try {
    const meta = await postgresService.query(
      `SELECT id, hit_count, duration_ms, EXTRACT(EPOCH FROM last_seen)*1000 AS last_ms
         FROM commercial_ad_creatives`
    );
    for (const r of meta.rows) {
      creatives.set(Number(r.id), {
        hitCount: r.hit_count,
        lastHitMs: Number(r.last_ms) || 0,
        confirmed: r.hit_count >= MIN_HITS_TO_CONFIRM,
        durationMs: r.duration_ms || 0
      });
    }
    const fps = await postgresService.query(
      `SELECT creative_id, hcode, t FROM commercial_ad_fingerprints`
    );
    for (const r of fps.rows) {
      const id = Number(r.creative_id);
      const entry = { id, t: r.t };
      indexAdd(provIndex, r.hcode, entry);
      if (creatives.get(id)?.confirmed) indexAdd(adIndex, r.hcode, entry);
    }
    catalogLoaded = true;
    const confirmed = Array.from(creatives.values()).filter((c) => c.confirmed).length;
    logger.info(`[CommercialFP] catalog loaded: ${creatives.size} creatives (${confirmed} confirmed), ${fps.rows.length} fingerprints`);
  } catch (e) {
    logger.warn(`[CommercialFP] catalog load failed (table missing? run migration 053): ${e.message}`);
  }
}

// ── Per-channel analyzer lifecycle ──────────────────────────────────
function startAnalysis(sourceId, channelId, streamUrl, opts = {}) {
  if (!channelId || !streamUrl) return false;
  // channel_id is NOT unique across sources, and the upstream URL is
  // source-specific, so analyzers are keyed by the composite (sourceId,
  // channelId) — never by channelId alone.
  const key = `${sourceId}_${channelId}`;
  let a = analyzers.get(key);
  if (a) { a.refs += 1; return true; }
  a = {
    key,
    sourceId,
    channelId,
    streamUrl,
    headers: opts.headers || null,
    refs: 1,
    proc: null,
    cg: null,
    frameBase: 0,        // added to codegen t to keep t monotonic across restarts
    maxCodegenT: 0,
    recent: [],          // [{ hcode, t }] recent fingerprints (RECENT_KEEP_MS)
    adState: 'content',  // 'content' | 'in_ad'
    adCreativeId: null,
    lastAdMatchMs: 0,
    restartTimer: null,
    stopped: false
  };
  analyzers.set(key, a);
  spawnAnalyzer(a);
  ensureTick();
  return true;
}

function stopAnalysis(sourceId, channelId) {
  const key = `${sourceId}_${channelId}`;
  const a = analyzers.get(key);
  if (!a) return;
  a.refs -= 1;
  if (a.refs > 0) return;
  teardown(a);
  analyzers.delete(key);
  if (analyzers.size === 0 && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function spawnAnalyzer(a) {
  if (a.stopped) return;
  // Reconnect flags keep ffmpeg attached to these flaky HTTP live streams:
  // many restream providers close the connection or signal EOF every few
  // seconds, which without these would make ffmpeg exit and force a costly
  // 5s re-spawn gap. -reconnect_at_eof is the key one for live .ts URLs.
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-reconnect', '1', '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '2'
  ];
  if (a.headers) args.push('-headers', a.headers);
  // Audio only — no video decode needed for fingerprinting, which keeps the
  // per-channel CPU cost to decode + fingerprint extraction.
  args.push('-i', a.streamUrl, '-vn', '-ac', '1', '-ar', '22050', '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1');

  let proc;
  try {
    proc = spawn(FFMPEG, args);
  } catch (e) {
    logger.warn(`[CommercialFP] spawn failed ${a.channelId}: ${e.message}`);
    return;
  }
  a.proc = proc;
  const cg = new Codegen();
  a.cg = cg;
  proc.stdout.pipe(cg);

  cg.on('data', (d) => onFingerprints(a, d));
  cg.on('error', (e) => logger.debug(`[CommercialFP] codegen error ${a.channelId}: ${e.message}`));
  proc.on('error', (e) => logger.warn(`[CommercialFP] ffmpeg error ${a.channelId}: ${e.message}`));
  proc.stderr.on('data', () => {}); // drain
  proc.on('exit', (code, signal) => {
    a.proc = null;
    try { cg.destroy(); } catch (e) { /* noop */ }
    if (a.stopped) return;
    // Keep t monotonic across the restart so re-aired ads still align.
    a.frameBase += a.maxCodegenT + 1;
    a.maxCodegenT = 0;
    logger.warn(`[CommercialFP] analyzer ${a.channelId} exited (code=${code} sig=${signal}); restarting in ${RESTART_DELAY_MS}ms`);
    a.restartTimer = setTimeout(() => spawnAnalyzer(a), RESTART_DELAY_MS);
  });
  logger.info(`[CommercialFP] started analyzer for channel ${a.channelId}`);
}

function teardown(a) {
  a.stopped = true;
  clearTimeout(a.restartTimer);
  if (a.cg) { try { a.cg.destroy(); } catch (e) { /* noop */ } a.cg = null; }
  if (a.proc) { try { a.proc.kill('SIGKILL'); } catch (e) { /* noop */ } a.proc = null; }
  logger.info(`[CommercialFP] stopped analyzer for channel ${a.channelId}`);
}

// ── Ingest fingerprints ─────────────────────────────────────────────
function onFingerprints(a, d) {
  const now = Date.now();
  for (let i = 0; i < d.tcodes.length; i++) {
    const ct = d.tcodes[i];
    if (ct > a.maxCodegenT) a.maxCodegenT = ct;
    const t = a.frameBase + ct;
    const hcode = d.hcodes[i];
    a.recent.push({ hcode, t });
    indexAdd(repIndex, hcode, { id: a.key, t, addedMs: now });
  }
  // Trim the per-channel recent buffer by frame age.
  const keepFromT = (a.recent.length ? a.recent[a.recent.length - 1].t : 0) - QUERY_FRAMES(RECENT_KEEP_MS);
  if (a.recent.length > 0 && a.recent[0].t < keepFromT) {
    let i = 0;
    while (i < a.recent.length && a.recent[i].t < keepFromT) i++;
    a.recent.splice(0, i);
  }
}

// ── The detection tick ──────────────────────────────────────────────
function ensureTick() {
  if (tickTimer) return;
  tickTimer = setInterval(onTick, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
}

function onTick() {
  tickCount++;
  const runRep = tickCount % REP_EVERY_TICKS === 0;
  for (const a of analyzers.values()) {
    try {
      liveMatch(a);
      if (runRep) detectRepetition(a);
    } catch (e) {
      logger.debug(`[CommercialFP] tick error ${a.channelId}: ${e.message}`);
    }
  }
  if (tickCount % PRUNE_EVERY_TICKS === 0) {
    pruneRepIndex(Date.now() - REP_WINDOW_MS);
    pruneProvisional().catch(() => {});
  }
}

function recentQuery(a, ms) {
  if (a.recent.length === 0) return [];
  const fromT = a.recent[a.recent.length - 1].t - QUERY_FRAMES(ms);
  const q = [];
  for (let i = a.recent.length - 1; i >= 0; i--) {
    if (a.recent[i].t < fromT) break;
    q.push(a.recent[i]);
  }
  return q;
}

// Stage 4 — live match against the confirmed catalog.
function liveMatch(a) {
  const now = Date.now();
  if (adIndex.size > 0) {
    const q = recentQuery(a, LIVE_QUERY_MS);
    if (q.length >= LIVE_MATCH_MIN) {
      const res = match(q, adIndex);
      const top = res[0];
      if (top && isStrong(top, { minCount: LIVE_MATCH_MIN, minSpanMs: LIVE_MATCH_SPAN_MS })) {
        a.lastAdMatchMs = now;
        if (a.adState === 'content') {
          a.adState = 'in_ad';
          a.adCreativeId = top.id;
          emitBreak(a, 'start', top.id);
        }
      }
    }
  }
  if (a.adState === 'in_ad' && now - a.lastAdMatchMs > AD_QUIET_MS) {
    a.adState = 'content';
    const cid = a.adCreativeId;
    a.adCreativeId = null;
    emitBreak(a, 'end', cid);
  }
}

// Stage 3 — cross-channel / cross-time repetition → catalog.
function detectRepetition(a) {
  const q = recentQuery(a, REP_QUERY_MS);
  if (q.length < MIN_REP_LANDMARKS) return;
  const res = match(q, repIndex);

  for (const r of res) {
    // Skip the channel matching its own just-added entries (offset ≈ 0).
    if (r.id === a.key && Math.abs(r.offset) * FRAME_MS < SELF_REAIR_MS) continue;
    if (!isStrong(r, { minCount: MIN_REP_LANDMARKS, minSpanMs: MIN_CREATIVE_MS })) continue;
    if (r.spanMs > MAX_CREATIVE_MS) continue;

    // The matched span is a repeated creative. Pull its fingerprints from the
    // query, normalize t to start at 0.
    const fps = r.matchedQueryIdx.map((qi) => q[qi]);
    if (fps.length < MIN_REP_LANDMARKS) continue;
    catalogCandidate(fps, r.spanMs).catch((e) =>
      logger.debug(`[CommercialFP] catalog error: ${e.message}`));
    return; // one candidate per scan is plenty
  }
}

// Dedup a candidate against the existing catalog by FINGERPRINT MATCH (two real
// airings never produce identical fingerprint sets, so an exact key won't
// dedup them — alignment does). Bump an existing creative, or insert a new
// provisional one; promote to the live catalog once confirmed.
async function catalogCandidate(fps, spanMs) {
  const minT = Math.min(...fps.map((f) => f.t));
  const norm = fps.map((f) => ({ hcode: f.hcode, t: f.t - minT }));
  const now = Date.now();

  // Does this already match a known creative?
  if (provIndex.size > 0) {
    const res = match(norm, provIndex);
    const top = res[0];
    if (top && isStrong(top, { minCount: MIN_REP_LANDMARKS, minSpanMs: MIN_CREATIVE_MS })) {
      const c = creatives.get(top.id);
      if (c && now - c.lastHitMs >= MIN_SEPARATION_MS) {
        await bumpCreative(top.id);
        c.hitCount += 1;
        c.lastHitMs = now;
        if (!c.confirmed && c.hitCount >= MIN_HITS_TO_CONFIRM) {
          c.confirmed = true;
          promoteToAdIndex(top.id);
          logger.info(`[CommercialFP] promoted creative ${top.id} to active ad catalog (hits=${c.hitCount}, ~${Math.round(c.durationMs / 1000)}s)`);
        }
      }
      return; // known creative — handled
    }
  }

  // New, never-seen creative → provisional (not yet muting).
  const key = creativeKey(norm);
  const durationMs = Math.round(spanMs);
  const id = await insertCreative(key, durationMs, norm);
  if (id == null) return;
  creatives.set(id, { hitCount: 1, lastHitMs: now, confirmed: MIN_HITS_TO_CONFIRM <= 1, durationMs });
  for (const f of norm) indexAdd(provIndex, f.hcode, { id, t: f.t });
  if (MIN_HITS_TO_CONFIRM <= 1) promoteToAdIndex(id);
  logger.info(`[CommercialFP] new provisional creative ${id} (~${Math.round(durationMs / 1000)}s, ${norm.length} fp) — needs ${MIN_HITS_TO_CONFIRM} hits to confirm`);
}

function promoteToAdIndex(id) {
  // Copy this creative's fingerprints from provIndex into adIndex.
  for (const [hcode, arr] of provIndex) {
    for (const e of arr) if (e.id === id) indexAdd(adIndex, hcode, e);
  }
}

function creativeKey(norm) {
  const h = crypto.createHash('sha1');
  h.update(norm.map((f) => f.hcode).sort((x, y) => x - y).join(','));
  return h.digest('hex');
}

// ── DB writes ───────────────────────────────────────────────────────
async function insertCreative(key, durationMs, fps) {
  const ins = await postgresService.query(
    `INSERT INTO commercial_ad_creatives (creative_key, duration_ms)
     VALUES ($1, $2)
     ON CONFLICT (creative_key) DO UPDATE
       SET hit_count = commercial_ad_creatives.hit_count + 1, last_seen = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [key, durationMs]
  );
  const row = ins.rows[0];
  if (!row) return null;
  const id = Number(row.id);
  if (!row.inserted) return id; // key collision = same set already stored
  const hcodes = fps.map((f) => f.hcode);
  const ts = fps.map((f) => f.t);
  await postgresService.query(
    `INSERT INTO commercial_ad_fingerprints (creative_id, hcode, t)
     SELECT $1, * FROM unnest($2::int[], $3::int[])`,
    [id, hcodes, ts]
  );
  return id;
}

async function bumpCreative(id) {
  await postgresService.query(
    `UPDATE commercial_ad_creatives
        SET hit_count = hit_count + 1, last_seen = now()
      WHERE id = $1`,
    [id]
  );
}

async function pruneProvisional() {
  try {
    const cutoff = new Date(Date.now() - PROVISIONAL_TTL_MS).toISOString();
    const del = await postgresService.query(
      `DELETE FROM commercial_ad_creatives
        WHERE hit_count < $1 AND last_seen < $2
      RETURNING id`,
      [MIN_HITS_TO_CONFIRM, cutoff]
    );
    if (del.rows.length === 0) return;
    const gone = new Set(del.rows.map((r) => Number(r.id)));
    for (const id of gone) creatives.delete(id);
    for (const [hcode, arr] of provIndex) {
      const kept = arr.filter((e) => !gone.has(e.id));
      if (kept.length === 0) provIndex.delete(hcode); else provIndex.set(hcode, kept);
    }
    logger.debug(`[CommercialFP] pruned ${gone.size} stale provisional creatives`);
  } catch (e) {
    logger.debug(`[CommercialFP] provisional prune failed: ${e.message}`);
  }
}

// ── SSE ─────────────────────────────────────────────────────────────
function emitBreak(a, type, creativeId) {
  logger.info(`[CommercialFP] channel ${a.channelId}: ad ${type}${creativeId != null ? ` (creative ${creativeId})` : ''}`);
  try {
    broadcastSSEUpdate({
      type: 'commercial-break',
      channelId: a.channelId,
      sourceId: a.sourceId,
      breakType: type,          // 'start' | 'end'
      source: 'fingerprint',
      confidence: 'high',
      creativeId: creativeId != null ? creativeId : null,
      timestamp: new Date().toISOString()
    }, null);
  } catch (e) {
    logger.warn(`[CommercialFP] SSE emit failed: ${e.message}`);
  }
}

// ── Introspection ───────────────────────────────────────────────────
function getStatus() {
  return {
    catalogLoaded,
    creatives: creatives.size,
    confirmed: Array.from(creatives.values()).filter((c) => c.confirmed).length,
    repIndexHashes: repIndex.size,
    analyzers: Array.from(analyzers.values()).map((a) => ({
      sourceId: a.sourceId,
      channelId: a.channelId,
      refs: a.refs,
      running: Boolean(a.proc),
      adState: a.adState,
      recentFps: a.recent.length
    }))
  };
}

module.exports = { startAnalysis, stopAnalysis, getStatus, loadCatalog };

// Internal surface for integration tests only (not used by the app).
module.exports._internals = {
  catalogCandidate, detectRepetition, liveMatch, loadCatalog,
  repIndex, adIndex, provIndex, creatives
};
