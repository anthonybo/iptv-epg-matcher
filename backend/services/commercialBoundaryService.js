/**
 * Commercial Boundary Service — server-side ad-break detection.
 *
 * Why server-side: the client-side detector (useCommercialDetector) was
 * dead-on-arrival (suspended AudioContext, CORS, sub-pixel logo, an
 * impossible signal gate) AND it damaged playback. The proxy already has
 * the decoded stream, so we run ffmpeg's silencedetect + blackdetect +
 * scdet on a per-channel analyzer, fuse the boundaries into ad-break
 * start/end, and broadcast them over the existing SSE channel. The
 * multiview orchestrator consumes those events to mute/swap.
 *
 * SCTE-35 (the only deterministic cue) is stripped by these restream
 * providers (verified: live channels carry only h264+aac, no data PID),
 * so this is necessarily a best-effort heuristic — multi-second latency
 * and a non-zero false-positive rate. All thresholds are tunable
 * constants below; every decision is logged so it can be tuned against
 * real ad breaks.
 *
 * Connection note: each analyzer opens ONE extra upstream connection per
 * distinct channel (ref-counted, so N viewers of the same channel share
 * one). Providers with tight per-account connection caps may reject it —
 * hence opt-in.
 */
const { spawn } = require('child_process');
const logger = require('../config/logger');
const { broadcastSSEUpdate } = require('../utils/sseUtils');
const featureFlags = require('./featureFlags');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Deep signal logging — every black/silence/scene detection + every evaluate
// decision. Off by default (it's chatty); flip the 'commercial_debug' feature
// flag at runtime (hot-reloaded, no restart) to diagnose detection. Always
// available via COMMERCIAL_DEBUG=1 too.
const dbg = (msg) => {
  if (process.env.COMMERCIAL_DEBUG === '1' || featureFlags.isEnabled('commercial_debug', false)) {
    logger.info(`[CommercialBoundary] ${msg}`);
  }
};

// ── Detection thresholds (tunable) ──────────────────────────────────
// Empirically measured on the actual live restreams (see the accuracy
// investigation): real inter-segment silence sits at ~-20..-25 dBFS for
// ~0.3-0.6s (so -30dB/0.6s fired ~never), the only black frames produced are
// ~0.2s (so 0.25s missed 100%), and pic_th's 0.98 default lets a small logo /
// score-bug defeat black detection entirely.
const SILENCE_DB = -24;          // silencedetect noise floor (dBFS) — matches measured gaps
const SILENCE_MIN_S = 0.4;       // min silence duration (real gaps are 0.3-0.6s)
const BLACK_MIN_S = 0.12;        // min black duration (measured ad-boundary black ≈ 0.2s)
const BLACK_PIX_TH = 0.10;       // per-pixel luma threshold for "black"
const BLACK_PIC_TH = 0.90;       // fraction of pixels that must be black (was ffmpeg's
                                 // 0.98 default → a ~2% logo/bug blocked all detection)
const SCENE_TH = 10;             // scdet score threshold (kept for logging, NOT a trigger)
// Fusion
const COOCCUR_MS = 2500;         // black & silence within this = a hard ad-insertion boundary
const BREAK_QUIET_MS = 35000;    // no boundary for this long → content resumed
const MAX_BREAK_MS = 8 * 60 * 1000; // safety: auto-end a break after this
const RESTART_DELAY_MS = 5000;   // re-spawn analyzer after an unexpected exit

// `${sourceId}_${channelId}` → analyzer (channel_id isn't unique across sources)
const analyzers = new Map();

function startAnalysis(sourceId, channelId, streamUrl, opts = {}) {
  if (!channelId || !streamUrl) return false;
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
    state: 'content',
    lastBlackAt: 0,
    lastSilenceAt: 0,
    sceneCuts: [],
    breakUntil: 0,
    breakStartedAt: 0,
    quietTimer: null,
    restartTimer: null,
    proc: null,
    stopped: false
  };
  analyzers.set(key, a);
  spawnAnalyzer(a);
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
}

function spawnAnalyzer(a) {
  if (a.stopped) return;
  // Reconnect flags keep ffmpeg attached to these flaky HTTP live streams —
  // many restream providers close the connection / signal EOF every few
  // seconds, which without these makes ffmpeg exit (code 0) and forces a
  // costly re-spawn gap, losing detection continuity. (Same fix as the
  // fingerprint analyzer.)
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'info',
    '-reconnect', '1', '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '2'
  ];
  if (a.headers) args.push('-headers', a.headers);
  args.push(
    '-i', a.streamUrl,
    // Explicit stream selection — make audio mapping intent clear (it was
    // already auto-mapped, but be explicit).
    '-map', '0:v:0', '-map', '0:a:0',
    // Video: downscale + sample at 8fps (catches ~0.12s black frames) then
    // black + scene-cut detection. pic_th below ffmpeg's 0.98 default so a
    // small logo/score-bug doesn't block a near-black ad-boundary frame.
    '-filter:v', `scale=160:90,fps=8,blackdetect=d=${BLACK_MIN_S}:pix_th=${BLACK_PIX_TH}:pic_th=${BLACK_PIC_TH},scdet=threshold=${SCENE_TH}`,
    '-filter:a', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_S}`,
    '-f', 'null', '-'
  );
  let proc;
  try {
    proc = spawn(FFMPEG, args);
  } catch (e) {
    logger.warn(`[CommercialBoundary] spawn failed ${a.channelId}: ${e.message}`);
    return;
  }
  a.proc = proc;
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d.toString();
    if (buf.length > 16384) buf = buf.slice(-16384);
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) parseLine(a, line);
  });
  proc.on('error', (e) => logger.warn(`[CommercialBoundary] ffmpeg error ${a.channelId}: ${e.message}`));
  proc.on('exit', (code, signal) => {
    a.proc = null;
    if (a.stopped) return;
    // Unexpected exit while still wanted (provider hiccup) → re-spawn.
    logger.warn(`[CommercialBoundary] analyzer ${a.channelId} exited (code=${code} sig=${signal}); restarting in ${RESTART_DELAY_MS}ms`);
    a.restartTimer = setTimeout(() => spawnAnalyzer(a), RESTART_DELAY_MS);
  });
  logger.info(`[CommercialBoundary] started analyzer for channel ${a.channelId}`);
}

function parseLine(a, line) {
  const now = Date.now();
  if (line.includes('silence_start')) {
    a.lastSilenceAt = now;
    a.silenceCount = (a.silenceCount || 0) + 1;
    dbg(`${a.channelId}: silence_start (#${a.silenceCount})`);
    evaluate(a, now);
  } else if (line.includes('silence_end')) {
    const d = line.match(/silence_duration:\s*([\d.]+)/);
    dbg(`${a.channelId}: silence_end dur=${d ? d[1] : '?'}s`);
  } else if (line.includes('black_start')) {
    a.lastBlackAt = now;
    a.blackCount = (a.blackCount || 0) + 1;
    dbg(`${a.channelId}: black_start (#${a.blackCount})`);
    evaluate(a, now);
  } else if (line.includes('black_end') || line.includes('black_duration')) {
    const d = line.match(/black_duration:\s*([\d.]+)/);
    dbg(`${a.channelId}: black_end dur=${d ? d[1] : '?'}s`);
  } else if (line.includes('lavfi.scd.score') || line.includes('scd.score')) {
    // Scene cuts are logged for diagnostics only — they no longer trigger a
    // break (the old scene-burst path was almost all false positives on
    // fast-cut content). Only black+silence co-occurrence triggers now.
    a.sceneCount = (a.sceneCount || 0) + 1;
    const sc = line.match(/scd\.score[^\d]*([\d.]+)/);
    dbg(`${a.channelId}: scene_cut score=${sc ? sc[1] : '?'} (#${a.sceneCount})`);
  }
}

// The ad-insertion boundary marker: a black frame co-occurring with audio
// silence. (The old scene-cut-burst fallback was dropped — it fired on any
// fast-cut content and was the source of the false "ad break" chips that never
// muted.) Co-occurrence of black AND silence is specific enough that on 120s of
// live sport it produced zero false boundaries, so it's trusted to mute.
function evaluate(a, now) {
  const blackSilence =
    a.lastBlackAt > 0 && a.lastSilenceAt > 0 &&
    Math.abs(a.lastBlackAt - a.lastSilenceAt) < COOCCUR_MS &&
    now - Math.max(a.lastBlackAt, a.lastSilenceAt) < COOCCUR_MS;

  // Visibility into WHY a boundary did/didn't fire — the key diagnostic.
  dbg(`${a.channelId}: evaluate blackSilence=${blackSilence} ` +
      `| Δblack-silence=${a.lastBlackAt && a.lastSilenceAt ? Math.abs(a.lastBlackAt - a.lastSilenceAt) : 'n/a'}ms ` +
      `ageBlack=${a.lastBlackAt ? now - a.lastBlackAt : 'never'}ms ageSilence=${a.lastSilenceAt ? now - a.lastSilenceAt : 'never'}ms state=${a.state}`);

  if (!blackSilence) return;

  a.breakUntil = now + BREAK_QUIET_MS;
  if (a.state === 'content') {
    a.state = 'in_break';
    a.breakStartedAt = now;
    a.confidence = 'medium'; // black+silence → trusted enough to mute
    emit(a, 'start', ['black+silence']);
    scheduleQuietCheck(a);
  }
}

function scheduleQuietCheck(a) {
  clearTimeout(a.quietTimer);
  const ms = Math.max(1000, a.breakUntil - Date.now());
  a.quietTimer = setTimeout(() => {
    if (a.state !== 'in_break') return;
    const now = Date.now();
    if (now >= a.breakUntil || now - a.breakStartedAt > MAX_BREAK_MS) {
      a.state = 'content';
      emit(a, 'end', []);
    } else {
      scheduleQuietCheck(a); // a fresh boundary pushed breakUntil out
    }
  }, ms);
}

function emit(a, type, signals) {
  logger.info(`[CommercialBoundary] channel ${a.channelId}: break ${type}${signals.length ? ' (' + signals.join(',') + ')' : ''}`);
  try {
    broadcastSSEUpdate({
      type: 'commercial-break',
      channelId: a.channelId,
      sourceId: a.sourceId,
      breakType: type,                  // 'start' | 'end'
      source: 'boundary',               // vs 'fingerprint' (high-confidence)
      confidence: a.confidence || 'low',
      signals,
      timestamp: new Date().toISOString()
    }, null);
  } catch (e) {
    logger.warn(`[CommercialBoundary] SSE emit failed: ${e.message}`);
  }
}

function teardown(a) {
  a.stopped = true;
  clearTimeout(a.quietTimer);
  clearTimeout(a.restartTimer);
  if (a.proc) {
    try { a.proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    a.proc = null;
  }
  logger.info(`[CommercialBoundary] stopped analyzer for channel ${a.channelId}`);
}

function getStatus() {
  return Array.from(analyzers.values()).map((a) => ({
    sourceId: a.sourceId,
    channelId: a.channelId,
    refs: a.refs,
    state: a.state,
    running: Boolean(a.proc)
  }));
}

module.exports = { startAnalysis, stopAnalysis, getStatus };
