import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadFingerprintsForChannel,
  saveFingerprint,
  matchFingerprint,
  deleteLatestFingerprintForChannel
} from '../../utils/adFingerprintStore';

/**
 * useCommercialDetector — per-tile commercial-break detection.
 *
 * Three signals, all running locally in the browser against the
 * already-decoded <video> elements:
 *
 *   1. AUDIO (Phase 1) — Web Audio API analyser over each tile's
 *      audio. Tracks rolling momentary loudness in dBFS, silence
 *      ratio, and step-up vs the 30s rolling baseline. Fires when
 *      silence sustained ≥ 800ms OR loudness jumps +Δ LU for ≥ 1.5s.
 *
 *   2. BLACK FRAME (Phase 2) — rVFC-driven canvas sample at 2 Hz,
 *      64×64 grayscale luma. Mean luma < 0.08 for ≥ 2 consecutive
 *      samples = black-frame boundary signal.
 *
 *   3. LOGO ABSENT (Phase 2) — same sampler, computes a dHash over
 *      the per-channel logo ROI and compares to the calibrated
 *      profile dHash. Hamming distance above the channel's
 *      `logoHammingThreshold` for ≥ 3s = logo gone signal.
 *
 * The hook owns a per-tile state machine:
 *
 *   content  →  candidate  →  in_break  →  content
 *               (any 1 sig)  (2 of 3 within 4s)
 *
 * Emits onBreakStart / onBreakEnd callbacks; consumers read the
 * `tileStates` map for live UI display.
 *
 * **Registration contract.** Cells call `register(key, videoEl, channel)`
 * when their video element is available, and `unregister(key)` on
 * unmount. The hook attaches Web Audio + rVFC handlers per tile.
 *
 * **Channel identity.** Keys use `${sourceId}_${channelId}` (stable
 * across refreshes). Profiles are keyed by `channelId` only since
 * the same channel from different sources is broadcast-identical.
 */

const SAMPLE_RATE_HZ = 4;     // audio analysis cadence
const FRAME_RATE_HZ  = 2;     // visual sample cadence
const ROLLING_BASELINE_MS = 30_000;
const BREAK_END_HOLD_MS = 6_000;       // signals must clear this long to confirm "back to content"
const CANDIDATE_TIMEOUT_MS = 12_000;   // 1 signal alone for this long → drop to content (no partner)
const CONTENT_STABLE_FOR_CAL_MS = 30_000; // tile must sit in content this long before we auto-calibrate the logo
// Duration hysteresis: a candidate-confirmed break must persist this
// long before we actually notify the orchestrator. Hides brief signal
// blips behind the scenes — the AD chip never even appears for
// false-positives that resolve quickly. The shortest legitimate
// commercial block is ~13s (one 15s spot with 2s grace).
const BREAK_COMMIT_MS = 13_000;
// Audio fingerprint sampling: 32-bit signature per ~250ms, rolling
// window of FP_WINDOW_LEN signatures (~5 seconds) is what we match
// against the stored hotlist. The hotlist itself stores longer
// segments captured at commit time.
const FP_WINDOW_LEN = 20;
// dHash size — 8x8 grayscale, compared to next pixel = 64-bit hash.
// Safety hatch: once a tile has been in_break this long, force back
// to content regardless of signals. With Web Audio gain we no longer
// need an aggressive retest cycle — signals are reliable — so this
// is purely a fail-safe in case the detector somehow gets wedged.
const MAX_IN_BREAK_MS = 5 * 60 * 1000;

// dHash size — 8x8 grayscale, compared to next pixel = 64-bit hash.
const DHASH_SIZE = 8;

// One AudioContext per page. Created lazily on first registration
// because browsers reject contexts created before a user gesture.
let sharedAudioContext = null;
const getAudioContext = () => {
  if (!sharedAudioContext) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      sharedAudioContext = new Ctor();
    } catch (e) {
      console.warn('[CommercialDetector] AudioContext unavailable:', e);
      return null;
    }
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
};

// A WeakMap keyed by HTMLVideoElement so we never accidentally call
// createMediaElementSource twice on the same node (Web Audio throws).
const sourceNodeCache = new WeakMap();

const computeDHash = (luma, width, height, x, y, w, h) => {
  // Pull the ROI region pixels from the luma buffer, downsample to
  // (DHASH_SIZE+1) x DHASH_SIZE via box-average, then encode left-to-
  // right luminance gradient bits. 64-bit hash returned as a hex
  // string for cheap Hamming compare later.
  const dw = DHASH_SIZE + 1;
  const dh = DHASH_SIZE;
  const cellW = w / dw;
  const cellH = h / dh;
  const ds = new Uint8Array(dw * dh);
  for (let by = 0; by < dh; by++) {
    for (let bx = 0; bx < dw; bx++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(x + bx * cellW);
      const x1 = Math.floor(x + (bx + 1) * cellW);
      const y0 = Math.floor(y + by * cellH);
      const y1 = Math.floor(y + (by + 1) * cellH);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          if (px < 0 || px >= width || py < 0 || py >= height) continue;
          sum += luma[py * width + px];
          count++;
        }
      }
      ds[by * dw + bx] = count > 0 ? Math.round(sum / count) : 0;
    }
  }

  let hex = '';
  let bits = 0;
  let acc = 0;
  for (let by = 0; by < dh; by++) {
    for (let bx = 0; bx < dw - 1; bx++) {
      const left = ds[by * dw + bx];
      const right = ds[by * dw + bx + 1];
      acc = (acc << 1) | (left < right ? 1 : 0);
      bits++;
      if (bits === 8) {
        hex += acc.toString(16).padStart(2, '0');
        acc = 0;
        bits = 0;
      }
    }
  }
  return hex;
};

const hammingHex = (a, b) => {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = parseInt(a.substr(i, 2), 16) ^ parseInt(b.substr(i, 2), 16);
    // popcount on a byte
    let v = x;
    v = v - ((v >> 1) & 0x55);
    v = (v & 0x33) + ((v >> 2) & 0x33);
    d += (v + (v >> 4)) & 0x0f;
  }
  return d;
};

// Compute a 32-bit audio signature from frequency-domain data.
// Quantizes 32 evenly-spaced frequency bins to 1 bit each based on
// whether the bin's amplitude is above the median of the sampled
// bins. This is a coarser-than-Shazam fingerprint but cheap and
// robust enough for "have I heard this exact audio before" matching
// within a single channel's recent broadcasts.
const computeAudioSignature = (freqBuf) => {
  if (!freqBuf || freqBuf.length === 0) return 0;
  // Skip the very low bins (sub-bass, often noisy) and very high bins
  // (often empty) — sample from ~100Hz to ~8kHz of the spectrum,
  // which is roughly bins [10..fftSize/4] for fftSize=1024 @ 48kHz.
  const start = Math.max(10, Math.floor(freqBuf.length * 0.04));
  const end = Math.min(freqBuf.length - 1, Math.floor(freqBuf.length * 0.6));
  const step = Math.max(1, Math.floor((end - start) / 32));
  const samples = new Array(32);
  for (let i = 0; i < 32; i++) {
    const idx = Math.min(end, start + i * step);
    samples[i] = freqBuf[idx] || 0;
  }
  // Median pivot — copy then sort.
  const sorted = samples.slice().sort((a, b) => a - b);
  const median = sorted[16];
  let sig = 0;
  for (let i = 0; i < 32; i++) {
    if (samples[i] > median) sig = (sig | (1 << i)) >>> 0;
  }
  return sig >>> 0; // ensure unsigned
};

// rms over Int8/Uint8 time-domain buffer → dBFS.
const rmsToDbfs = (buf) => {
  let sumSq = 0;
  const N = buf.length;
  for (let i = 0; i < N; i++) {
    const v = (buf[i] - 128) / 128; // -1..1
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / N);
  if (rms <= 1e-6) return -100;
  return 20 * Math.log10(rms);
};

export function useCommercialDetector({
  enabled = false,
  audioEnabled = true,
  logoEnabled = true,   // implies blackframe enabled
  profiles = {},        // { channelId: profile }
  onBreakStart = null,
  onBreakEnd = null,
  // onCalibrate(channelId, dHash, roi) — fires once per tile after 30s
  // of stable `content` state, allowing the orchestrator to PUT the
  // logo signature to the server so future detection has the third
  // signal available.
  onCalibrate = null
}) {
  const [tileStates, setTileStates] = useState({});
  // Per-tile working data — kept in a ref because we mutate it every
  // animation tick without wanting to trigger React renders. We push
  // a single setTileStates update at the end of each tick instead.
  const tilesRef = useRef(new Map());
  const onBreakStartRef = useRef(onBreakStart);
  const onBreakEndRef = useRef(onBreakEnd);
  const onCalibrateRef = useRef(onCalibrate);
  const profilesRef = useRef(profiles);
  const flagsRef = useRef({ enabled, audioEnabled, logoEnabled });

  useEffect(() => { onBreakStartRef.current = onBreakStart; }, [onBreakStart]);
  useEffect(() => { onBreakEndRef.current = onBreakEnd; }, [onBreakEnd]);
  useEffect(() => { onCalibrateRef.current = onCalibrate; }, [onCalibrate]);
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);
  useEffect(() => { flagsRef.current = { enabled, audioEnabled, logoEnabled }; }, [enabled, audioEnabled, logoEnabled]);

  // ─── Per-tile state machine ─────────────────────────────────────

  const updateTile = useCallback((key, partial) => {
    const cur = tilesRef.current.get(key);
    if (!cur) return;
    Object.assign(cur, partial);
    // Push a shallow snapshot to React state for UI consumers.
    setTileStates((prev) => ({
      ...prev,
      [key]: {
        state: cur.state,
        signals: { ...cur.signals },
        lastChanged: cur.lastChanged,
        channelId: cur.channelId
      }
    }));
  }, []);

  const transition = useCallback((key, nextState, signalsSnapshot) => {
    const cur = tilesRef.current.get(key);
    if (!cur || cur.state === nextState) return;
    const prevState = cur.state;
    cur.state = nextState;
    cur.lastChanged = performance.now();
    updateTile(key, {});
    if (nextState === 'in_break' && prevState !== 'in_break') {
      const firingSignals = Object.entries(signalsSnapshot || cur.signals || {})
        .filter(([, v]) => v)
        .map(([k]) => k);
      onBreakStartRef.current?.(key, firingSignals, cur.channelId);
    } else if (nextState === 'content' && prevState === 'in_break') {
      onBreakEndRef.current?.(key, cur.channelId);
    }
  }, [updateTile]);

  // Step a single tile's detection. Reads its accumulators and may
  // transition states. Called from a single rAF/interval driver.
  const stepTile = useCallback((key, now) => {
    const cur = tilesRef.current.get(key);
    if (!cur) return;
    const profile = profilesRef.current[cur.channelId] || {};

    // Respect server-side cooldown window after a false-positive.
    // profile.ignoreUntil is a wall-clock unix-ms timestamp; compare
    // against the same clock for sanity.
    if (profile.ignoreUntil && Date.now() < profile.ignoreUntil) {
      if (cur.state !== 'content') {
        const wasInBreak = cur.state === 'in_break';
        cur.state = 'content';
        cur.candidateSince = null;
        cur.contentClearSince = null;
        cur.contentStableSince = now;
        cur.pendingSince = null;
        cur.watchingSince = null;
        cur.openingBoundaryAt = null;
        cur.breakStartedAt = null;
        cur.cutNormalizedSince = null;
        cur.silencePatternOffSince = null;
        cur.lastChanged = now;
        if (cur.audio) {
          cur.audio.captureBuffer = [];
          cur.audio.captureStartedAt = null;
        }
        if (wasInBreak) onBreakEndRef.current?.(key, cur.channelId);
      }
      return;
    }

    const { audioEnabled: aEn, logoEnabled: lEn } = flagsRef.current;

    // ── Compute signals
    const sig = {
      audio: false,
      blackframe: false,
      logo: false,
      fingerprint: false,
      scte35: false,
      silencePattern: false
    };

    // AUDIO — silence ratio + loudness step.
    //
    // Critical safeguards (learned the hard way):
    //   1. Need enough samples before trusting any audio signal —
    //      HLS-init silence at tile-mount time would otherwise look
    //      like a break.
    //   2. Baseline must never anchor on silence. A tile with brief
    //      startup silence followed by normal content would compute
    //      lu = content_level - silence ≈ +60 LU, way above any
    //      threshold, and false-fire forever.
    //   3. Baseline EMA needs a fast bootstrap (alpha ~ 0.5) for the
    //      first real-content sample, then settle to the slow EMA
    //      so commercials don't poison the steady-state.
    if (aEn && cur.audio) {
      const a = cur.audio;
      const silenceDbfs = profile.silenceDbfs ?? -42;
      // Need ≥ 5s of samples before audio signal is meaningful.
      const MIN_SAMPLES = SAMPLE_RATE_HZ * 5;
      if (a.samples.length < MIN_SAMPLES) {
        cur.lastAudioStats = { warmup: true, samples: a.samples.length };
      } else {
        // Silence ratio over last 1s.
        const winLen = Math.min(a.samples.length, SAMPLE_RATE_HZ * 1);
        let silentCount = 0;
        for (let i = a.samples.length - winLen; i < a.samples.length; i++) {
          if (a.samples[i] < silenceDbfs) silentCount++;
        }
        const silenceRatio = winLen > 0 ? silentCount / winLen : 0;
        const silenceThreshold = profile.silenceThreshold ?? 0.6;

        // Recent mean over last 1.5s.
        let recentSum = 0;
        let recentN = 0;
        const recentLen = Math.min(a.samples.length, Math.round(SAMPLE_RATE_HZ * 1.5));
        for (let i = a.samples.length - recentLen; i < a.samples.length; i++) {
          recentSum += a.samples[i];
          recentN++;
        }
        const recentMean = recentN > 0 ? recentSum / recentN : -100;

        // Only update baseline with content-level audio — silent or
        // near-silent samples (HLS init, deliberate silence, etc.)
        // would otherwise anchor the baseline at -100 dBFS and
        // make every subsequent content sample look like a break.
        const isContentLevel = recentMean > (silenceDbfs + 8);
        if (cur.state === 'content' && isContentLevel) {
          // Fast EMA on the very first sample, slow thereafter.
          const alpha = a.baseline == null ? 0.5 : 0.005;
          a.baseline = a.baseline == null
            ? recentMean
            : (a.baseline * (1 - alpha) + recentMean * alpha);
        }

        // Track whether we've ever seen real content audio on this
        // tile. Until we have, silence isn't a meaningful "break"
        // signal — it might just be HLS-init silence, an empty
        // stream, or a long pause before playback. Audio silence
        // only fires once we've established this is a live, audible
        // feed.
        if (recentMean > (silenceDbfs + 8)) {
          a.hasSeenContent = true;
        }

        const luThreshold = profile.loudnessDeltaLu ?? 3.0;
        const hasValidBaseline = a.baseline != null && a.baseline > (silenceDbfs + 4);
        const lu = hasValidBaseline ? (recentMean - a.baseline) : 0;

        const silenceFires = a.hasSeenContent && silenceRatio >= silenceThreshold;
        const loudnessFires = hasValidBaseline && lu >= luThreshold;

        if (silenceFires || loudnessFires) {
          sig.audio = true;
        }

        // Track silence events specifically — these are the diagnostic
        // signal for commercial-spot transitions. Real ad blocks have
        // 4-8 spots with silence at each boundary; content typically
        // has at most one or two dialog gaps in any 60s window. We
        // record the START of each silence event (off→on transition)
        // and look for the "multiple silence events spaced like ad
        // spots" pattern as a high-confidence single signal.
        const prevSilenceFiring = a.lastSilenceFiring || false;
        if (silenceFires && !prevSilenceFiring) {
          a.silenceEventTimes = a.silenceEventTimes || [];
          a.silenceEventTimes.push(Date.now());
          const SILENCE_WINDOW_MS = 60_000;
          const cutoff = Date.now() - SILENCE_WINDOW_MS;
          while (a.silenceEventTimes.length > 0 && a.silenceEventTimes[0] < cutoff) {
            a.silenceEventTimes.shift();
          }
          // Pattern detection: 2+ silence events in the window with
          // at least one pair spaced 10-35s apart (one US ad spot).
          if (a.silenceEventTimes.length >= 2) {
            const last = a.silenceEventTimes[a.silenceEventTimes.length - 1];
            for (let i = a.silenceEventTimes.length - 2; i >= 0; i--) {
              const gap = last - a.silenceEventTimes[i];
              if (gap >= 10_000 && gap <= 35_000) {
                a.silencePatternMatched = true;
                a.silencePatternAt = Date.now();
                console.info('[CommercialDetector]', key, 'silence-pattern matched', {
                  events: a.silenceEventTimes.length,
                  gap: Math.round(gap)
                });
                break;
              }
            }
          }
        }
        a.lastSilenceFiring = silenceFires;
        // Latch the silence-pattern signal for 30s after match. This
        // is the high-confidence signal we use to commit.
        sig.silencePattern = Boolean(a.silencePatternAt && (Date.now() - a.silencePatternAt) < 30_000);

        cur.lastAudioStats = {
          silenceRatio, lu, baseline: a.baseline, recentMean,
          hasValidBaseline, hasSeenContent: a.hasSeenContent,
          silenceEventsInLast60s: a.silenceEventTimes?.length || 0,
          silencePatternMatched: Boolean(a.silencePatternMatched)
        };
      }
    }

    // BLACK FRAME — from latest sample.
    if (lEn && cur.video) {
      const v = cur.video;
      if (v.lastLuma != null && v.lastLuma < 0.08) {
        // require 2 consecutive black samples
        if (v.blackHits == null) v.blackHits = 0;
        v.blackHits++;
        if (v.blackHits >= 2) sig.blackframe = true;
      } else if (v.lastLuma != null) {
        v.blackHits = 0;
      }

      // LOGO ABSENT — uses TEMPORALLY-SMOOTHED distance against the
      // calibrated reference. Per-frame dHash on a small ROI (12x6
      // pixels in our 64x36 downsample) is noisy enough that
      // thresholding the raw value flickers constantly. We instead
      // threshold the 5-second rolling mean, which is what every
      // production system does.
      if (profile.logoDhash && v.lastLogoDhash && v.logoDistHistory?.length > 0) {
        const dist = hammingHex(profile.logoDhash, v.lastLogoDhash);
        v.lastLogoDistance = dist;
        let sum = 0;
        for (const e of v.logoDistHistory) sum += e.dist;
        const smoothedDist = sum / v.logoDistHistory.length;
        v.lastSmoothedLogoDistance = smoothedDist;
        const thresh = profile.logoHammingThreshold ?? 12;
        // Require 3 seconds of sustained smoothed-distance-above-thresh
        // before firing — keeps brief logo-occlusion events (sports
        // score graphics, transition wipes) from triggering.
        if (smoothedDist > thresh) {
          if (v.logoMissSince == null) v.logoMissSince = now;
          if (now - v.logoMissSince >= 3000) sig.logo = true;
        } else {
          v.logoMissSince = null;
        }
      }
    }

    // CUT RATE — continuous in-break signal. Real ads cut every
    // 2-4 seconds; content cuts every 5-8 seconds. The rolling count
    // of scene cuts in the last 30s is elevated THROUGHOUT an ad
    // block, unlike audio/blackframe which only fire AT boundaries.
    // This is the signal the research said we were missing.
    const cutsIn30s = cur.video?.cutHistory?.length || 0;
    // 7+ cuts in 30s = average cut every ~4.3s = elevated.
    const cutRateElevated = cutsIn30s >= 7;
    cur.lastCutsIn30s = cutsIn30s;

    // FINGERPRINT — match the live window against the channel's
    // hotlist of known commercials. A strong match (≥70% of window
    // signatures within Hamming threshold) is the highest-confidence
    // single signal we have; it alone can confirm a break.
    if (aEn && cur.audio?.fingerprintWindow?.length >= 8 && cur.hotlist?.length > 0) {
      const liveWindow = new Uint32Array(cur.audio.fingerprintWindow);
      let bestRatio = 0;
      for (const entry of cur.hotlist) {
        const m = matchFingerprint(entry.fingerprint, liveWindow, 6);
        if (m.matchRatio > bestRatio) bestRatio = m.matchRatio;
        if (bestRatio >= 0.95) break;
      }
      cur.lastFingerprintRatio = bestRatio;
      if (bestRatio >= 0.7) {
        sig.fingerprint = true;
      }
    }

    // SCTE-35 — when we receive an out-of-band ad-break cue from the
    // stream itself, treat it as an active signal for as long as
    // we're inside the cue range. The textTrack listener sets
    // cur.scte35.activeUntil to the cue's end time (or +120s default).
    if (cur.scte35?.activeUntil && Date.now() < cur.scte35.activeUntil) {
      sig.scte35 = true;
    }

    // Signal-edge logging — log ON↔OFF transitions for each signal so
    // we can see exactly when boundaries occur, even when they don't
    // pair up. Cheap (5 booleans compared) and only logs on change.
    const prevSig = cur.prevSignals || { audio: false, blackframe: false, logo: false, fingerprint: false, scte35: false, silencePattern: false };
    for (const k of ['audio', 'blackframe', 'logo', 'fingerprint', 'scte35', 'silencePattern']) {
      if (sig[k] !== prevSig[k]) {
        console.info('[CommercialDetector]', key, `signal ${k} ${sig[k] ? 'ON' : 'OFF'}`, {
          cutsIn30s,
          smoothedLogoDist: cur.video?.lastSmoothedLogoDistance,
          state: cur.state,
          audioStats: k === 'audio' ? cur.lastAudioStats : undefined
        });
      }
    }
    cur.prevSignals = { ...sig };

    cur.signals = sig;

    // Track boundary events — audio + blackframe co-occurring within
    // ~2s defines an ad-block boundary (content-to-ad or ad-to-content).
    // Boundaries are LATCHED for short durations because in practice
    // audio and blackframe rarely fire in the same single 250ms tick
    // even at a real boundary.
    if (sig.audio) cur.audioBoundaryAt = now;
    if (sig.blackframe) cur.blackframeBoundaryAt = now;
    const BOUNDARY_PAIR_WINDOW_MS = 2_500;
    const audioRecent = cur.audioBoundaryAt && (now - cur.audioBoundaryAt) < BOUNDARY_PAIR_WINDOW_MS;
    const blackframeRecent = cur.blackframeBoundaryAt && (now - cur.blackframeBoundaryAt) < BOUNDARY_PAIR_WINDOW_MS;
    const boundaryEvent = audioRecent && blackframeRecent;

    // High-confidence single-signal triggers — fingerprint match,
    // SCTE-35 cue, or the silence-pattern signal (2+ silence events
    // within 60s spaced like commercial spots). Each alone is
    // reliable enough to commit; pairing isn't required.
    const highConfidenceSingle = Boolean(sig.fingerprint || sig.scte35 || sig.silencePattern);

    // Auto-calibrate logo dHash on stable content (only valid when we
    // believe we ARE in content, i.e., state === 'content').
    if (
      cur.state === 'content' &&
      flagsRef.current.logoEnabled &&
      !profile.logoDhash &&
      !cur.calibrationAttempted &&
      cur.contentStableSince != null &&
      (now - cur.contentStableSince) >= CONTENT_STABLE_FOR_CAL_MS &&
      cur.video?.lastLogoDhash &&
      !cur.video.tainted
    ) {
      const dhash = cur.video.lastLogoDhash;
      const isAllZeros = /^0+$/.test(dhash);
      const isAllOnes = /^f+$/.test(dhash);
      if (isAllZeros || isAllOnes) {
        cur.calibrationAttempted = true;
        console.info('[CommercialDetector]', key, 'auto-cal SKIPPED — degenerate dHash', dhash);
      } else {
        cur.calibrationAttempted = true;
        const roi = { x: 0.78, y: 0.78, w: 0.20, h: 0.18, corner: 'br' };
        console.info('[CommercialDetector]', key, 'auto-calibrating logo', { dhash, roi });
        onCalibrateRef.current?.(cur.channelId, dhash, roi);
      }
    }

    // ─── Boundary-pair state machine ────────────────────────────────
    //
    // States:
    //   content          - normal viewing
    //   watching_break   - opening boundary seen, validating with cut-rate
    //   in_break         - confirmed; orchestrator notified, audio suppressed
    //
    // Transitions:
    //   content → watching_break: opening boundary fires OR high-conf single
    //   watching_break → in_break: cut-rate elevated, fingerprint match,
    //                              SCTE-35 cue, or another boundary
    //   watching_break → content: validation timeout (no confirming
    //                             signal within window)
    //   in_break → content: closing boundary OR sustained low cut-rate
    //                       AND smoothed logo back to normal, OR safety timeout

    if (cur.state === 'content') {
      if (highConfidenceSingle || boundaryEvent) {
        cur.state = 'watching_break';
        cur.watchingSince = now;
        cur.openingBoundaryAt = now;
        cur.cutRateAtOpening = cutsIn30s;
        cur.contentStableSince = null;
        cur.lastChanged = now;
        // Start audio fingerprint capture now so if we commit we
        // have the whole break audio for the hotlist.
        if (cur.audio) {
          cur.audio.captureBuffer = [];
          cur.audio.captureStartedAt = now;
        }
        console.info(
          '[CommercialDetector]', key, 'content → watching_break',
          { boundary: boundaryEvent, highConf: highConfidenceSingle, cutsIn30s }
        );
      }
    } else if (cur.state === 'watching_break') {
      // Heartbeat every 3s so we can see what the validation window
      // is actually observing. Logs once per 3s as long as we stay
      // in this state.
      if (!cur.lastHeartbeatAt || (now - cur.lastHeartbeatAt) >= 3000) {
        cur.lastHeartbeatAt = now;
        console.info('[CommercialDetector]', key, 'watching_break heartbeat', {
          tInState: Math.round(now - cur.watchingSince),
          cutsIn30s,
          cutRateElevated,
          smoothedLogoDist: cur.video?.lastSmoothedLogoDistance,
          logoFiring: sig.logo,
          audioFiring: sig.audio,
          blackframeFiring: sig.blackframe,
          fingerprintRatio: cur.lastFingerprintRatio
        });
      }
      // Validation window — wait up to BREAK_COMMIT_MS for a confirming
      // signal. Acceptable confirmations:
      //   1. Cut-rate elevated (>= 7 cuts in 30s, the continuous in-break
      //      signal that stays active throughout an ad block).
      //   2. Another boundary event after at least 5s — that's the
      //      shortest plausible commercial that already ended, so the
      //      boundary-pair is closed and the break is real.
      //   3. Fingerprint match against the hotlist.
      //   4. SCTE-35 cue from the stream.
      //   5. Sustained smoothed-logo absence (logo signal still firing
      //      AND we already had one boundary — together strong evidence).
      const minPairGap = 5_000;
      const closingBoundary = boundaryEvent && (now - cur.openingBoundaryAt) >= minPairGap;
      const confirmed =
        sig.fingerprint ||
        sig.scte35 ||
        sig.silencePattern ||
        closingBoundary ||
        (cutRateElevated && (now - cur.watchingSince) >= 3_000) ||
        (sig.logo && (now - cur.watchingSince) >= 5_000);

      if (confirmed) {
        cur.state = 'in_break';
        cur.breakStartedAt = now;
        cur.lastChanged = now;
        cur.cutNormalizedSince = null;
        cur.silencePatternOffSince = null;
        const firing = Object.entries(sig).filter(([, v]) => v).map(([k]) => k);
        const reasons = [];
        if (sig.fingerprint) reasons.push('fingerprint');
        if (sig.scte35) reasons.push('scte35');
        if (sig.silencePattern) reasons.push('silence-pattern');
        if (closingBoundary) reasons.push('closing-boundary');
        if (cutRateElevated) reasons.push(`cut-rate(${cutsIn30s})`);
        if (sig.logo) reasons.push('logo-absent');
        console.info('[CommercialDetector]', key, 'BREAK START (committed)', reasons, {
          firingNow: firing,
          audioStats: cur.lastAudioStats,
          smoothedLogoDistance: cur.video?.lastSmoothedLogoDistance,
          cutsIn30s,
          fingerprintRatio: cur.lastFingerprintRatio,
          hotlistSize: cur.hotlist?.length || 0
        });
        onBreakStartRef.current?.(key, [...reasons, ...firing], cur.channelId);
      } else if (now - cur.watchingSince >= BREAK_COMMIT_MS) {
        // No confirming signal arrived — boundary was a false alarm.
        // Log WHY (which checks didn't pass) so we can tune.
        const reason = {
          cutRateElevated,
          cutsIn30s,
          logoSig: sig.logo,
          fingerprintRatio: cur.lastFingerprintRatio,
          scte35: sig.scte35,
          fingerprint: sig.fingerprint,
          watchingMs: Math.round(now - cur.watchingSince),
          hotlistSize: cur.hotlist?.length || 0
        };
        cur.state = 'content';
        cur.watchingSince = null;
        cur.openingBoundaryAt = null;
        cur.contentStableSince = now;
        cur.lastChanged = now;
        cur.lastHeartbeatAt = null;
        if (cur.audio) {
          cur.audio.captureBuffer = [];
          cur.audio.captureStartedAt = null;
        }
        console.info('[CommercialDetector]', key, 'watching_break → content (no confirmation)', reason);
      }
    } else if (cur.state === 'in_break') {
      // Look for the closing boundary OR sustained "we're back in
      // content" evidence. We have three exit paths now because the
      // per-channel signals are unreliable in different ways:
      //   (a) closing-boundary  - audio+blackframe co-occurring; fast & precise
      //   (b) cut-rate normalized + logo-back  - sustained 10s; useful when
      //       logo calibration captured something real
      //   (c) silence-pattern quiet  - silencePattern signal has been OFF
      //       for ≥ 20s; the *only* path that works on channels where the
      //       calibrated logo dHash is noise (e.g. Reelz, where smoothed
      //       distance hovers above threshold during both ads and content,
      //       blocking path b indefinitely)
      const timeInBreak = now - cur.breakStartedAt;
      const closingBoundary = boundaryEvent && timeInBreak >= 10_000;
      const cutRateLow = cutsIn30s < 4;
      const logoBack = !sig.logo; // smoothed logo is no longer firing
      if (cutRateLow && logoBack) {
        if (cur.cutNormalizedSince == null) cur.cutNormalizedSince = now;
      } else {
        cur.cutNormalizedSince = null;
      }
      const sustainedContentReturn = cur.cutNormalizedSince && (now - cur.cutNormalizedSince) >= 10_000;

      // Track how long silencePattern has been OFF. Real ad blocks fire
      // it repeatedly (4-8 spots, each with a 10-35s silence gap). Once
      // it stays OFF, the break is over.
      if (!sig.silencePattern) {
        if (cur.silencePatternOffSince == null) cur.silencePatternOffSince = now;
      } else {
        cur.silencePatternOffSince = null;
      }
      const silencePatternQuiet =
        cur.silencePatternOffSince != null &&
        (now - cur.silencePatternOffSince) >= 20_000 &&
        timeInBreak >= 25_000;

      const finalizeBreakEnd = (reason) => {
        cur.state = 'content';
        cur.breakStartedAt = null;
        cur.cutNormalizedSince = null;
        cur.silencePatternOffSince = null;
        cur.watchingSince = null;
        cur.openingBoundaryAt = null;
        cur.contentStableSince = now;
        cur.lastChanged = now;
        console.info('[CommercialDetector]', key, 'BREAK END', `(${reason})`);
        const cap = cur.audio?.captureBuffer;
        const capStart = cur.audio?.captureStartedAt;
        if (cap && cap.length > SAMPLE_RATE_HZ * 5 && capStart) {
          const fp = new Uint32Array(cap);
          const durationMs = Math.round(now - capStart);
          const channelId = cur.channelId;
          saveFingerprint(channelId, fp, durationMs).then((id) => {
            if (id && Array.isArray(cur.hotlist)) {
              cur.hotlist.push({ id, fingerprint: fp, capturedAt: Date.now(), durationMs });
              console.info('[CommercialDetector]', key, `fingerprint stored (${fp.length} sigs, ${(durationMs/1000).toFixed(1)}s, hotlist size now ${cur.hotlist.length})`);
            }
          });
        }
        if (cur.audio) {
          cur.audio.captureBuffer = [];
          cur.audio.captureStartedAt = null;
          // Reset silence-pattern state so the rolling 60s window
          // that just fired the opening boundary can't immediately
          // re-arm and bounce us back into in_break.
          cur.audio.silenceEventTimes = [];
          cur.audio.silencePatternAt = null;
          cur.audio.silencePatternMatched = false;
          cur.audio.lastSilenceFiring = false;
        }
        onBreakEndRef.current?.(key, cur.channelId);
      };

      // Heartbeat every 5s while in_break — lets us see why we're
      // not finding the closing boundary yet (cut-rate too high,
      // logo still missing, silence-pattern not quiet, etc.)
      if (!cur.lastHeartbeatAt || (now - cur.lastHeartbeatAt) >= 5000) {
        cur.lastHeartbeatAt = now;
        console.info('[CommercialDetector]', key, 'in_break heartbeat', {
          tInBreak: Math.round(timeInBreak),
          cutsIn30s,
          cutRateLow,
          logoBack,
          cutNormalizedSinceMs: cur.cutNormalizedSince ? Math.round(now - cur.cutNormalizedSince) : null,
          silencePatternOffMs: cur.silencePatternOffSince ? Math.round(now - cur.silencePatternOffSince) : null,
          silencePatternQuiet,
          boundaryEventNow: boundaryEvent,
          smoothedLogoDist: cur.video?.lastSmoothedLogoDistance
        });
      }

      if (closingBoundary) finalizeBreakEnd('closing-boundary');
      else if (sustainedContentReturn) finalizeBreakEnd('cut-rate-normalized + logo-back');
      else if (silencePatternQuiet) finalizeBreakEnd('silence-pattern-quiet 20s');
      else if (now - cur.lastChanged >= MAX_IN_BREAK_MS) finalizeBreakEnd('safety-timeout');
    }

    updateTile(key, {});
  }, [transition, updateTile]);

  // ─── Per-tile audio attachment ──────────────────────────────────

  const attachAudio = useCallback((entry, videoEl) => {
    if (!videoEl) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      let source = sourceNodeCache.get(videoEl);
      if (!source) {
        source = ctx.createMediaElementSource(videoEl);
        sourceNodeCache.set(videoEl, source);
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      // GainNode between analyser and destination. The orchestrator
      // controls auto-suppression via `gain.value = 0` instead of
      // setting `video.muted = true`. Critical: the analyser sits
      // BEFORE the gain, so it keeps seeing real audio even while
      // we're suppressing — which is what lets us reliably detect
      // break_end from the audio signal.
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      entry.audio = {
        analyser,
        source,
        gain,
        buf: new Uint8Array(analyser.fftSize),
        // Frequency-domain buffer for fingerprinting. analyser.fftSize/2
        // bins, but we quantize to a fixed 32 for the signature.
        freqBuf: new Uint8Array(analyser.frequencyBinCount),
        samples: [],          // rolling buffer of dBFS values
        maxSamples: SAMPLE_RATE_HZ * 60, // 60s of audio history
        baseline: null,
        // Rolling window of 32-bit fingerprint signatures. Each tick
        // pushes one signature; old signatures fall off the front.
        fingerprintWindow: [],
        // Long buffer used when capturing a confirmed break for
        // hotlist storage. Filled while in pending_break/committed_break,
        // saved on commit.
        captureBuffer: [],
        captureStartedAt: null
      };
    } catch (e) {
      // Most common cause: a MediaElementSource was already created
      // for this video on a different context. We skip and let the
      // detector fall back to visual-only signals.
      console.warn('[CommercialDetector] audio attach failed:', e.message);
      entry.audio = null;
    }
  }, []);

  const detachAudio = useCallback((entry) => {
    if (!entry?.audio) return;
    try {
      entry.audio.analyser?.disconnect();
      // Note: we keep the source node in sourceNodeCache because
      // we can't recreate one for the same video element; it lives
      // for the lifetime of the video.
    } catch { /* ignore */ }
    entry.audio = null;
  }, []);

  // When audioEnabled flips on after tiles have already registered,
  // attach Web Audio to any tile that doesn't have it yet. Catches
  // the "user toggles the feature on mid-session" case.
  useEffect(() => {
    if (!enabled || !audioEnabled) return;
    tilesRef.current.forEach((entry) => {
      if (!entry.audio && entry.videoEl) {
        attachAudio(entry, entry.videoEl);
      }
    });
  }, [enabled, audioEnabled, attachAudio]);

  // ─── Per-tile video sampler ────────────────────────────────────

  const sampleVideoFrame = useCallback((entry) => {
    const { videoEl } = entry;
    if (!videoEl || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return;
    const W = 64;
    const H = 36;
    if (!entry.video.canvas) {
      entry.video.canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
    }
    const ctx2d = entry.video.canvas.getContext('2d');
    if (!ctx2d) return;
    try {
      ctx2d.drawImage(videoEl, 0, 0, W, H);
      const img = ctx2d.getImageData(0, 0, W, H);
      const data = img.data;
      const luma = new Uint8Array(W * H);
      let sum = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        // BT.601 luma weights
        const y = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        luma[p] = y;
        sum += y;
      }
      entry.video.lastLuma = sum / (W * H) / 255; // 0..1

      // ── Scene-cut detection via frame-difference ───────────────
      // Commercials cut every 2-4s, content cuts every 5-8s. The
      // research is explicit that an elevated rolling cut-rate is
      // one of the few signals that stays ACTIVE THROUGHOUT a break
      // (vs the boundary-only audio/blackframe signals). We sample
      // frames at 2 Hz; a cut is a mean-abs-luma-diff above a
      // threshold against the previous sampled frame.
      const nowMs = Date.now();
      if (entry.video.prevLuma && entry.video.prevLuma.length === luma.length) {
        let diffSum = 0;
        for (let i = 0; i < luma.length; i++) {
          diffSum += Math.abs(luma[i] - entry.video.prevLuma[i]);
        }
        const meanDiff = diffSum / luma.length / 255; // 0..1
        entry.video.lastFrameDiff = meanDiff;
        // 0.12 is empirically a decent scene-cut threshold for a
        // 64x36 downsample. Real cuts produce 0.15-0.4; slow camera
        // pans on content stay below 0.08-0.10.
        if (meanDiff > 0.12) {
          entry.video.cutHistory.push(nowMs);
        }
      }
      // Copy luma into prevLuma for the next tick. Use slice to
      // avoid aliasing.
      entry.video.prevLuma = new Uint8Array(luma);
      // Trim cut history to last 30s.
      const CUT_WINDOW_MS = 30_000;
      while (entry.video.cutHistory.length > 0 && nowMs - entry.video.cutHistory[0] > CUT_WINDOW_MS) {
        entry.video.cutHistory.shift();
      }

      // dHash a small bottom-right ROI by default (most network bugs).
      // Profile can override via logoRoi when calibrated.
      const profile = profilesRef.current[entry.channelId] || {};
      const roi = profile.logoRoi || { x: 0.78, y: 0.78, w: 0.20, h: 0.18 };
      const rx = Math.max(0, Math.floor(roi.x * W));
      const ry = Math.max(0, Math.floor(roi.y * H));
      const rw = Math.max(1, Math.floor(roi.w * W));
      const rh = Math.max(1, Math.floor(roi.h * H));
      entry.video.lastLogoDhash = computeDHash(luma, W, H, rx, ry, rw, rh);

      // Temporal smoothing of logo Hamming distance. Per-frame dHash
      // fluctuates significantly because the network bug is small
      // (often 12x6 px at this downsample) — a single frame's
      // distance is noisy. We threshold against the rolling-window
      // mean, which is what every production system does.
      if (profile.logoDhash && entry.video.lastLogoDhash) {
        const dist = hammingHex(profile.logoDhash, entry.video.lastLogoDhash);
        entry.video.logoDistHistory.push({ at: nowMs, dist });
        const LOGO_SMOOTH_MS = 5_000;
        while (entry.video.logoDistHistory.length > 0 && nowMs - entry.video.logoDistHistory[0].at > LOGO_SMOOTH_MS) {
          entry.video.logoDistHistory.shift();
        }
      }
    } catch (e) {
      // CORS-tainted canvas throws SecurityError; once that happens
      // we stop trying.
      if (e.name === 'SecurityError') {
        entry.video.tainted = true;
        console.warn('[CommercialDetector] canvas tainted, visual detection disabled for', entry.channelId);
      }
    }
  }, []);

  // ─── Master driver loop ────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return undefined;
    let audioInterval = null;
    let frameInterval = null;
    let stateInterval = null;

    audioInterval = setInterval(() => {
      const ctx = sharedAudioContext;
      // Guard: don't sample if the AudioContext hasn't been resumed by
      // a user gesture yet — the analyser would return zeros (silence)
      // and we'd false-positive every tile. We attempt one resume per
      // tick; once a gesture has happened the resume succeeds and we
      // stop getting fed zeros.
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        return;
      }
      if (ctx.state !== 'running') return;

      tilesRef.current.forEach((entry) => {
        if (!entry.audio?.analyser) return;
        // Guard: skip if the video element isn't actually playing
        // audio yet. readyState < 2 means we don't have current data;
        // .paused/.ended likewise mean no live audio. The analyser
        // would otherwise see silence and false-positive.
        //
        // Also skip when the video is muted — `video.muted = true`
        // silences the audio that reaches MediaElementSource, so we
        // can't tell real silence from "the user (or we) muted it."
        // Letting muted tiles accumulate silent samples would cause
        // every muted tile to false-positive into `in_break`, which
        // breaks the swap logic: the orchestrator's findContentTile
        // would never find a candidate. By skipping, muted tiles stay
        // in `content` state and remain valid swap targets.
        const vEl = entry.videoEl;
        if (!vEl || vEl.paused || vEl.ended || vEl.readyState < 2 || vEl.muted) return;

        entry.audio.analyser.getByteTimeDomainData(entry.audio.buf);
        const dbfs = rmsToDbfs(entry.audio.buf);
        entry.audio.samples.push(dbfs);
        if (entry.audio.samples.length > entry.audio.maxSamples) {
          entry.audio.samples.shift();
        }

        // Audio fingerprint signature for the same tick. We push to
        // the rolling window (for matching) AND to the capture buffer
        // (for hotlist save on commit). Both are gated by enabled
        // flags higher up.
        entry.audio.analyser.getByteFrequencyData(entry.audio.freqBuf);
        const sig = computeAudioSignature(entry.audio.freqBuf);
        entry.audio.fingerprintWindow.push(sig);
        if (entry.audio.fingerprintWindow.length > FP_WINDOW_LEN) {
          entry.audio.fingerprintWindow.shift();
        }
        // Keep capturing only while we're actively in a break window
        // (signaled by captureStartedAt being non-null).
        if (entry.audio.captureStartedAt != null) {
          entry.audio.captureBuffer.push(sig);
          // Cap to avoid runaway memory if break never ends.
          if (entry.audio.captureBuffer.length > SAMPLE_RATE_HZ * 240) {
            entry.audio.captureBuffer.shift();
          }
        }
      });
    }, Math.round(1000 / SAMPLE_RATE_HZ));

    frameInterval = setInterval(() => {
      tilesRef.current.forEach((entry) => {
        if (entry.video?.tainted) return;
        sampleVideoFrame(entry);
      });
    }, Math.round(1000 / FRAME_RATE_HZ));

    stateInterval = setInterval(() => {
      const now = performance.now();
      tilesRef.current.forEach((entry, key) => stepTile(key, now));
    }, 250);

    return () => {
      if (audioInterval) clearInterval(audioInterval);
      if (frameInterval) clearInterval(frameInterval);
      if (stateInterval) clearInterval(stateInterval);
    };
  }, [enabled, sampleVideoFrame, stepTile]);

  // ─── Public API ────────────────────────────────────────────────

  const register = useCallback((key, videoEl, channel) => {
    if (!key || !videoEl || !channel) return;
    // Skip churn re-registers — if the same video element is being
    // re-registered, treat it as a no-op so we don't tear down the
    // audio chain on every parent re-render.
    const existing = tilesRef.current.get(key);
    if (existing && existing.videoEl === videoEl) return;
    if (existing) {
      detachAudio(existing);
    }
    if (flagsRef.current.enabled) {
      console.info('[CommercialDetector] register', key, '→', channel.name);
    }
    const entry = {
      videoEl,
      channelId: channel.id,
      channelName: channel.name,
      sourceType: channel.sourceType,
      state: 'content',
      signals: { audio: false, blackframe: false, logo: false, fingerprint: false, scte35: false },
      lastChanged: performance.now(),
      candidateSince: null,
      contentClearSince: null,
      contentStableSince: performance.now(),
      pendingSince: null,
      pendingFiringSignals: null,
      calibrationAttempted: false,
      detectorStartedAt: performance.now(),
      detectorStartedWallMs: Date.now(),
      // Audio fingerprint hotlist — populated asynchronously from
      // IndexedDB on register, then appended to on each break_end.
      hotlist: [],
      hotlistLoaded: false,
      // SCTE-35 / EXT-X-DATERANGE state. activeUntil is set when a
      // CUE-OUT (or similar) is observed via the metadata textTrack;
      // sig.scte35 fires while Date.now() < activeUntil.
      scte35: { activeUntil: null, trackListener: null, trackHandlers: [] },
      audio: null,
      video: {
        canvas: null,
        lastLuma: null,
        prevLuma: null,            // previous frame's luma buffer, for cut detection
        lastFrameDiff: 0,
        cutHistory: [],            // timestamps of recent scene cuts (rolling 30s)
        blackHits: 0,
        lastLogoDhash: null,
        logoDistHistory: [],       // rolling 5s of { at, dist } pairs (temporal smoothing)
        logoMissSince: null,
        tainted: false
      },
      // Boundary detection state — content-to-ad and ad-to-content
      // transitions. Audio + blackframe co-occurring within ~2s is
      // an "opening boundary"; a second co-occurrence later is the
      // "closing boundary". Trust the interval between as the break.
      audioBoundaryAt: null,
      blackframeBoundaryAt: null,
      openingBoundaryAt: null,
      watchingSince: null,
      cutRateAtOpening: 0,
      cutNormalizedSince: null,
      silencePatternOffSince: null,
      breakStartedAt: null
    };
    tilesRef.current.set(key, entry);
    if (flagsRef.current.audioEnabled) attachAudio(entry, videoEl);

    // Async load the channel's audio fingerprint hotlist so we can
    // start matching ASAP. Subsequent break_end events append to
    // entry.hotlist directly so the in-memory cache stays warm.
    loadFingerprintsForChannel(channel.id).then((rows) => {
      if (!tilesRef.current.has(key)) return; // tile was unregistered
      entry.hotlist = rows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint instanceof Uint32Array
          ? r.fingerprint
          : new Uint32Array(r.fingerprint),
        capturedAt: r.capturedAt,
        durationMs: r.durationMs
      }));
      entry.hotlistLoaded = true;
      if (entry.hotlist.length > 0) {
        console.info('[CommercialDetector] hotlist loaded', key, `(${entry.hotlist.length} fingerprints)`);
      }
    });

    // SCTE-35 / EXT-X-DATERANGE sniffer — watch the video element's
    // textTracks for metadata cues. hls.js surfaces inband ID3 (TS
    // SCTE-35 PIDs) and EXT-X-DATERANGE this way. When we see a
    // CUE-OUT-style marker, set a sliding activeUntil — the signal
    // stays on until either CUE-IN or the marker's declared duration
    // elapses.
    try {
      const attachScte35 = () => {
        const tracks = videoEl.textTracks;
        if (!tracks) return;
        const handle = (track) => {
          if (track.kind !== 'metadata') return;
          if (track.__mvScte35Hooked) return;
          track.__mvScte35Hooked = true;
          track.mode = 'hidden';
          const onCue = () => {
            for (const cue of track.activeCues || []) {
              try {
                const raw =
                  (cue.value && (cue.value.info || cue.value.data || cue.value.attributes)) ||
                  cue.text ||
                  '';
                const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
                const lower = text.toLowerCase();
                // CUE-OUT family: ad break starting.
                if (
                  lower.includes('cue-out') ||
                  lower.includes('scte35-out') ||
                  lower.includes('scte35out') ||
                  lower.includes('com.apple.hls.interstitial') ||
                  /scte35:\s*\/df/.test(lower)
                ) {
                  // Try to parse declared duration from the cue,
                  // otherwise default to 120s (typical ad block).
                  let durSec = 120;
                  const m = /duration[":=\s]+(\d+(\.\d+)?)/i.exec(text);
                  if (m) durSec = Math.max(15, Math.min(300, parseFloat(m[1])));
                  entry.scte35.activeUntil = Date.now() + durSec * 1000;
                  console.info('[CommercialDetector] SCTE-35 CUE-OUT', key, `(${durSec}s window)`);
                }
                // CUE-IN family: ad break ending.
                if (
                  lower.includes('cue-in') ||
                  lower.includes('scte35-in') ||
                  lower.includes('scte35in')
                ) {
                  entry.scte35.activeUntil = null;
                  console.info('[CommercialDetector] SCTE-35 CUE-IN', key);
                }
              } catch { /* ignore malformed cues */ }
            }
          };
          track.addEventListener('cuechange', onCue);
          entry.scte35.trackHandlers.push({ track, handler: onCue });
        };
        for (let i = 0; i < tracks.length; i++) handle(tracks[i]);
        const onTrackAdd = (e) => handle(e.track);
        tracks.addEventListener && tracks.addEventListener('addtrack', onTrackAdd);
        entry.scte35.trackListener = onTrackAdd;
      };
      attachScte35();
    } catch (e) {
      console.warn('[CommercialDetector] SCTE-35 attach failed', e);
    }

    setTileStates((prev) => ({ ...prev, [key]: { state: entry.state, signals: entry.signals, lastChanged: entry.lastChanged, channelId: entry.channelId } }));
  }, [attachAudio, detachAudio]);

  const unregister = useCallback((key) => {
    const entry = tilesRef.current.get(key);
    if (!entry) return;
    // Tear down SCTE-35 listeners.
    if (entry.scte35) {
      for (const { track, handler } of entry.scte35.trackHandlers || []) {
        try { track.removeEventListener('cuechange', handler); } catch {}
      }
      const tracks = entry.videoEl?.textTracks;
      if (tracks && entry.scte35.trackListener && tracks.removeEventListener) {
        try { tracks.removeEventListener('addtrack', entry.scte35.trackListener); } catch {}
      }
    }
    detachAudio(entry);
    tilesRef.current.delete(key);
    setTileStates((prev) => {
      const { [key]: _omit, ...rest } = prev;
      return rest;
    });
  }, [detachAudio]);

  // Drop the most-recently-added hotlist fingerprint for a channel
  // across all in-memory tile entries. Paired with the IndexedDB
  // delete in the orchestrator's FP path — together they roll back
  // the "we just learned this" capture when the user says it was
  // wrong.
  const forgetLatestHotlistEntry = useCallback((channelId) => {
    if (!channelId) return;
    tilesRef.current.forEach((entry) => {
      if (entry.channelId !== channelId) return;
      if (Array.isArray(entry.hotlist) && entry.hotlist.length > 0) {
        const dropped = entry.hotlist.pop();
        console.info('[CommercialDetector] forgot hotlist entry', channelId, dropped?.id);
      }
    });
  }, []);

  // Suppress / release a tile's audio output via the GainNode in
  // its Web Audio chain. The analyser keeps seeing the real video
  // audio either way — only the speaker output is silenced. This is
  // what lets us detect break_end reliably while a tile is "muted"
  // for the user.
  const suppress = useCallback((key) => {
    const entry = tilesRef.current.get(key);
    if (!entry?.audio?.gain) return;
    try {
      entry.audio.gain.gain.value = 0;
      entry.suppressed = true;
    } catch (e) { console.warn('[CommercialDetector] suppress failed', e); }
  }, []);

  const release = useCallback((key) => {
    const entry = tilesRef.current.get(key);
    if (!entry?.audio?.gain) return;
    try {
      entry.audio.gain.gain.value = 1;
      entry.suppressed = false;
    } catch (e) { console.warn('[CommercialDetector] release failed', e); }
  }, []);

  // Imperatively mark a tile as content (used after a confirmed FP
  // so the orchestrator can re-enable audio immediately).
  const resetTile = useCallback((key) => {
    const entry = tilesRef.current.get(key);
    if (!entry) return;
    entry.state = 'content';
    entry.candidateSince = null;
    entry.contentClearSince = null;
    entry.contentStableSince = performance.now();
    entry.pendingSince = null;
    entry.pendingFiringSignals = null;
    // Boundary-pair fields
    entry.audioBoundaryAt = null;
    entry.blackframeBoundaryAt = null;
    entry.openingBoundaryAt = null;
    entry.watchingSince = null;
    entry.cutNormalizedSince = null;
    entry.silencePatternOffSince = null;
    entry.breakStartedAt = null;
    entry.signals = { audio: false, blackframe: false, logo: false, fingerprint: false, scte35: false };
    entry.lastChanged = performance.now();
    if (entry.audio) {
      entry.audio.captureBuffer = [];
      entry.audio.captureStartedAt = null;
    }
    if (entry.scte35) entry.scte35.activeUntil = null;
    setTileStates((prev) => ({ ...prev, [key]: { state: 'content', signals: entry.signals, lastChanged: entry.lastChanged, channelId: entry.channelId } }));
  }, []);

  // Return current snapshot of a tile's accumulated stats — useful
  // for debugging overlays and for the FP endpoint payload.
  const getDebug = useCallback((key) => {
    const entry = tilesRef.current.get(key);
    if (!entry) return null;
    return {
      state: entry.state,
      signals: entry.signals,
      audio: entry.lastAudioStats,
      logoDistance: entry.video?.lastLogoDistance,
      lastLuma: entry.video?.lastLuma,
      hasLogoCalibration: Boolean(profilesRef.current[entry.channelId]?.logoDhash)
    };
  }, []);

  return {
    tileStates,
    register,
    unregister,
    resetTile,
    suppress,
    release,
    forgetLatestHotlistEntry,
    getDebug
  };
}
