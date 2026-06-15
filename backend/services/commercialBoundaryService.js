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

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// ── Detection thresholds (tunable) ──────────────────────────────────
const SILENCE_DB = -30;          // silencedetect noise floor (dBFS)
const SILENCE_MIN_S = 0.6;       // min silence duration to count
const BLACK_MIN_S = 0.10;        // min black duration
const BLACK_PIX_TH = 0.10;       // blackdetect pixel threshold
const SCENE_TH = 10;             // scdet score threshold for a cut
// Fusion
const COOCCUR_MS = 2500;         // black & silence within this = a hard boundary (ad insertion marker)
const SCENE_BURST_N = 4;         // this many scene cuts ...
const SCENE_BURST_MS = 6000;     // ... within this window = fast-cut ad burst
const BREAK_QUIET_MS = 35000;    // no boundary for this long → content resumed
const MAX_BREAK_MS = 8 * 60 * 1000; // safety: auto-end a break after this
const RESTART_DELAY_MS = 5000;   // re-spawn analyzer after an unexpected exit

// channelId → analyzer
const analyzers = new Map();

function startAnalysis(channelId, streamUrl, opts = {}) {
  if (!channelId || !streamUrl) return false;
  let a = analyzers.get(channelId);
  if (a) { a.refs += 1; return true; }
  a = {
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
  analyzers.set(channelId, a);
  spawnAnalyzer(a);
  return true;
}

function stopAnalysis(channelId) {
  const a = analyzers.get(channelId);
  if (!a) return;
  a.refs -= 1;
  if (a.refs > 0) return;
  teardown(a);
  analyzers.delete(channelId);
}

function spawnAnalyzer(a) {
  if (a.stopped) return;
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info'];
  if (a.headers) args.push('-headers', a.headers);
  args.push(
    '-i', a.streamUrl,
    // Video: downscale + decimate so the detect filters are cheap, then
    // black + scene-cut detection. Audio: silence detection.
    '-filter:v', `scale=160:90,fps=5,blackdetect=d=${BLACK_MIN_S}:pix_th=${BLACK_PIX_TH},scdet=threshold=${SCENE_TH}`,
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
    evaluate(a, now);
  } else if (line.includes('black_start')) {
    a.lastBlackAt = now;
    evaluate(a, now);
  } else if (line.includes('lavfi.scd.score')) {
    a.sceneCuts.push(now);
    a.sceneCuts = a.sceneCuts.filter((t) => now - t < SCENE_BURST_MS);
    evaluate(a, now);
  }
}

// A "hard boundary" is the strongest blind ad-insertion marker we can
// get: a black frame co-occurring with audio silence, OR a burst of
// scene cuts paired with a recent silence (covers hard-cut ad pods).
function evaluate(a, now) {
  const blackSilence =
    a.lastBlackAt > 0 && a.lastSilenceAt > 0 &&
    Math.abs(a.lastBlackAt - a.lastSilenceAt) < COOCCUR_MS &&
    now - Math.max(a.lastBlackAt, a.lastSilenceAt) < COOCCUR_MS;
  const sceneBurst =
    a.sceneCuts.length >= SCENE_BURST_N &&
    a.lastSilenceAt > 0 && now - a.lastSilenceAt < SCENE_BURST_MS;

  if (!blackSilence && !sceneBurst) return;

  a.breakUntil = now + BREAK_QUIET_MS;
  if (a.state === 'content') {
    a.state = 'in_break';
    a.breakStartedAt = now;
    emit(a, 'start', blackSilence ? ['black+silence'] : ['scene-burst+silence']);
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
      breakType: type,            // 'start' | 'end'
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
    channelId: a.channelId,
    refs: a.refs,
    state: a.state,
    running: Boolean(a.proc)
  }));
}

module.exports = { startAnalysis, stopAnalysis, getStatus };
