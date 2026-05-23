import { useRef } from 'react';
import { checkGlobalRecoveryLimits } from '../../utils/player/globalRecoveryQueue';

/**
 * All the recovery + health-check state and logic IPTVPlayer uses.
 *
 * Three escalating flavors of recovery live here:
 *
 *   1. **Soft recovery** — call unload()/load() on the existing mpegts
 *      player. Much cheaper than recreating the player; used when the
 *      stream stalls or ends but the underlying instance is still sane.
 *
 *   2. **Full recovery** (attemptRecovery) — progressive backoff of
 *      retries, then "fresh start" cycles where we tear down and
 *      re-init from scratch via `reinitialize()`. Gives up and calls
 *      onStreamDead once both pools are exhausted.
 *
 *   3. **Health check** — periodic interval that watches `currentTime`.
 *      If it doesn't advance within a freeze threshold, we force either
 *      soft recovery or a notifyStreamDead depending on how long we've
 *      been frozen and whether the resilient proxy is in play.
 *
 * The hook owns every recovery-related ref so nothing in IPTVPlayer
 * has to track them. It does NOT own video-element / player-instance
 * refs — those belong to the player lifecycle and are shared with the
 * mpegts initializer.
 *
 * Note on theatre mode: many paths rate-limit through
 * window.iptvRecoveryQueue so 4-6 simultaneous stream failures don't
 * melt the backend. In single view those checks are skipped.
 */
export default function useStreamRecovery({
  // config
  theatreMode,
  skipRecovery,
  shouldUseResilientProxy,
  playbackMethod,

  // services
  log,
  cleanupPlayer,
  reinitialize, // (method: string) => void — dispatches to the right initializePlayer
  getChannelId,

  // setters
  setError,
  setLoading,
  setRecoveryStatus,

  // lifecycle refs (owned by IPTVPlayer)
  videoElementRef,
  playerInstanceRef,
  currentChannelIdRef,
  lastPlayingTimeRef,
  lastKnownCurrentTimeRef,
  healthCheckIntervalRef,
  stallTimerRef,
  isInitializingRef,

  // callbacks
  onStreamDead,
  onStreamError
}) {
  // Recovery refs — all owned by the hook. Exposed back out so
  // cleanupPlayer and the mpegts initializer can read/reset them.
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef(null);
  const lastErrorTimeRef = useRef(0);
  const freshStartCountRef = useRef(0);
  const isRecoveringRef = useRef(false);
  const recoveryTimeoutRef = useRef(null);
  const hasCalledOnStreamDeadRef = useRef(false);
  const totalRecoveryAttemptsRef = useRef(0);
  const recoveryTimestampsRef = useRef([]);
  const streamUnstableRef = useRef(false);
  const softRecoveryCountRef = useRef(0);

  // Theatre mode drives tighter limits across the board — with 4-6
  // concurrent streams the per-stream budget has to be smaller so the
  // system total doesn't blow up.
  const MAX_TOTAL_RECOVERY_ATTEMPTS = theatreMode ? 10 : 20;
  const RECOVERY_WINDOW_MS = theatreMode ? 30000 : 60000;
  const MAX_RECOVERIES_IN_WINDOW = theatreMode ? 4 : 6;
  // Resilient proxy mode: backend has ~30-35s retry budget (20s stale
  // threshold + 3 retries with backoff). 15s catches a dead backend
  // pipe quickly enough that auto-refresh (via handleStreamDead →
  // refreshStream in MultiViewPage) can fully restore the stream
  // inside a 25-30s total window.
  //
  // Non-resilient mode (single view, direct-to-upstream): used to
  // keep a 120s ceiling, but that left the single-view player
  // staring at a frozen frame for two full minutes before any
  // escalation. Tightened to 25s — the buffer-drain fast-path now
  // fires in this mode too (see "buffer drained" branch below) so
  // we get out of a dead upstream pipe quickly.
  const MAX_STALE_TIME_MS = shouldUseResilientProxy ? 15000 : 25000;
  const MAX_SOFT_RECOVERIES = 3;

  // Playhead-nudge thresholds. Shorter than the soft-recovery escalation
  // because a nudge is cheap (a sub-frame seek on the existing video
  // element) — it never touches the backend connection, so we can try
  // it aggressively. Three attempts before we let the heavier health-
  // check tiers take over. Pattern borrowed from hls.js's
  // nudgeOffset / nudgeMaxRetry.
  //
  // CRITICAL: nudging only helps when the MSE buffer has FUTURE data
  // beyond currentTime (single-frame underrun gaps). If the buffer
  // is fully drained (no future bytes), the freeze is caused by the
  // backend pipe dropping and no amount of seeking helps. The health
  // check guards against this by skipping the nudge tier when
  // `videoEl.buffered` ends at or before currentTime — see the
  // `hasFutureBuffer` check below.
  const NUDGE_FREEZE_THRESHOLD_MS = 4000;
  const NUDGE_AMOUNT_S = 0.1;
  const MAX_NUDGES_PER_FREEZE = 2;

  const clearRecoveryState = (decrementActive = false) => {
    if (theatreMode && (isRecoveringRef.current || decrementActive)) {
      if (window.iptvRecoveryQueue.activeRecoveries > 0) {
        window.iptvRecoveryQueue.activeRecoveries--;
      }
    }
    isRecoveringRef.current = false;
  };

  const notifyStreamDead = (reason = '') => {
    if (hasCalledOnStreamDeadRef.current) {
      log('info', `Skipping duplicate onStreamDead call (reason: ${reason})`);
      return;
    }
    // Clear any stale "Reconnecting (soft N/N)..." banner so the UI
    // doesn't show two conflicting recovery states at once.
    setRecoveryStatus(null);
    if (onStreamDead) {
      hasCalledOnStreamDeadRef.current = true;
      log('info', `Notifying parent: stream dead (reason: ${reason})`);
      onStreamDead(reason);
    }
  };

  const isStreamChronicallyUnstable = () => {
    const now = Date.now();
    recoveryTimestampsRef.current = recoveryTimestampsRef.current.filter(
      (ts) => now - ts < RECOVERY_WINDOW_MS
    );
    recoveryTimestampsRef.current.push(now);

    if (recoveryTimestampsRef.current.length > MAX_RECOVERIES_IN_WINDOW) {
      log(
        'error',
        `Stream is chronically unstable: ${recoveryTimestampsRef.current.length} recoveries in ${RECOVERY_WINDOW_MS / 1000}s`
      );
      streamUnstableRef.current = true;
      return true;
    }
    return false;
  };

  const attemptRecovery = (errorContext = '') => {
    if (skipRecovery) {
      log('info', 'Skip recovery enabled (auto-test mode) - not retrying');
      setError('Stream failed');
      if (onStreamError) onStreamError();
      return;
    }

    if (theatreMode && window.iptvRecoveryQueue.globalPaused) {
      log('info', 'Global recovery paused - too many failures across all streams');
      setError('Multiple streams failing. Please wait or refresh the page.');
      notifyStreamDead();
      return;
    }

    if (streamUnstableRef.current) {
      log('info', 'Stream marked as unstable, not attempting recovery');
      notifyStreamDead();
      return;
    }

    if (isStreamChronicallyUnstable()) {
      setError('Stream is unstable. Try "Find Alternative" or refresh the page.');
      isRecoveringRef.current = false;
      notifyStreamDead();
      return;
    }

    if (theatreMode && !checkGlobalRecoveryLimits(log)) {
      setError('Too many stream failures. Please wait or refresh the page.');
      isRecoveringRef.current = false;
      notifyStreamDead();
      return;
    }

    totalRecoveryAttemptsRef.current++;
    if (totalRecoveryAttemptsRef.current > MAX_TOTAL_RECOVERY_ATTEMPTS) {
      log('error', `Maximum total recovery attempts (${MAX_TOTAL_RECOVERY_ATTEMPTS}) exceeded - giving up`);
      setError('Stream unavailable after multiple recovery attempts. Please refresh the page.');
      isRecoveringRef.current = false;
      notifyStreamDead();
      return;
    }

    if (isRecoveringRef.current) {
      log('info', 'Recovery already in progress, skipping duplicate attempt');
      return;
    }

    if (getChannelId() !== currentChannelIdRef.current) {
      log('info', 'Channel changed, skipping recovery');
      return;
    }

    const now = Date.now();
    const timeSinceLastError = now - lastErrorTimeRef.current;

    // After 30s of steady playback, treat this as a fresh incident —
    // reset all counters so the next error gets the full retry budget.
    if (timeSinceLastError > 30000) {
      retryCountRef.current = 0;
      freshStartCountRef.current = 0;
      totalRecoveryAttemptsRef.current = 0;
      softRecoveryCountRef.current = 0;
      recoveryTimestampsRef.current = [];
      streamUnstableRef.current = false;
      log('info', 'Resetting retry counters after successful playback period');
    }

    isRecoveringRef.current = true;
    lastErrorTimeRef.current = now;

    // Multi-view rate limiting prevents stack overflow from recursive
    // recovery calls and keeps the kernel's socket buffers from being
    // exhausted by churn when 4-6 streams fail together.
    if (theatreMode) {
      const queue = window.iptvRecoveryQueue;
      const timeSinceLastGlobalRecovery = now - queue.lastRecoveryTime;

      if (
        timeSinceLastGlobalRecovery < 500 ||
        queue.activeRecoveries >= queue.maxConcurrentRecoveries
      ) {
        if (queue.pendingRecoveries.length >= queue.maxPendingRecoveries) {
          log('warn', 'Too many pending recoveries, dropping this attempt');
          isRecoveringRef.current = false;
          return;
        }
        const delayMs = Math.max(500 - timeSinceLastGlobalRecovery, 0) + Math.random() * 500;
        isRecoveringRef.current = false;
        const recoveryTimer = setTimeout(() => {
          const idx = queue.pendingRecoveries.indexOf(recoveryTimer);
          if (idx > -1) queue.pendingRecoveries.splice(idx, 1);
          attemptRecovery(errorContext);
        }, delayMs);
        queue.pendingRecoveries.push(recoveryTimer);
        return;
      }
      queue.lastRecoveryTime = now;
      queue.activeRecoveries++;
    }

    const MAX_RETRIES = 6;
    const MAX_FRESH_STARTS = 3;
    const retryCount = retryCountRef.current;

    if (retryCount < MAX_RETRIES) {
      // Slower cadence in multi-view (1/2/3/5/8/10s) vs single
      // (0.5/1/2/3/5/8s). The extra delay matters when 6 streams are
      // all hammering the backend at once.
      const delays = theatreMode
        ? [1000, 2000, 3000, 5000, 8000, 10000]
        : [500, 1000, 2000, 3000, 5000, 8000];
      const retryDelay = delays[Math.min(retryCount, delays.length - 1)];

      retryCountRef.current++;
      const attemptNum = retryCount + 1;

      setRecoveryStatus(`Reconnecting (${attemptNum}/${MAX_RETRIES})...`);
      setLoading(false);

      retryTimerRef.current = setTimeout(() => {
        if (getChannelId() !== currentChannelIdRef.current) {
          clearRecoveryState();
          setRecoveryStatus(null);
          return;
        }

        cleanupPlayer();

        // We do NOT clear isRecoveringRef here — let the `playing`
        // event clear it when the stream actually starts. A safety
        // timeout below catches the case where the player silently
        // never starts.
        if (recoveryTimeoutRef.current) {
          clearTimeout(recoveryTimeoutRef.current);
        }

        const recoveryTimeout = theatreMode ? 15000 : 10000;
        recoveryTimeoutRef.current = setTimeout(() => {
          if (isRecoveringRef.current) {
            log('warn', 'Recovery timeout - player did not start within timeout');
            clearRecoveryState();
            if (
              retryCountRef.current < MAX_RETRIES ||
              freshStartCountRef.current < MAX_FRESH_STARTS
            ) {
              attemptRecovery('Recovery timeout - player did not start');
            } else {
              log('error', 'Recovery timeout and all retries exhausted');
              setError('Stream unavailable. Please try another channel or refresh the page.');
              notifyStreamDead('timeout_exhausted');
            }
          }
        }, recoveryTimeout);

        reinitialize(playbackMethod);
      }, retryDelay);
    } else if (freshStartCountRef.current < MAX_FRESH_STARTS) {
      freshStartCountRef.current++;
      const freshStartNum = freshStartCountRef.current;

      log('info', `Max retries exceeded. Attempting fresh start (${freshStartNum}/${MAX_FRESH_STARTS})...`);
      setRecoveryStatus(`Fresh restart (${freshStartNum}/${MAX_FRESH_STARTS})...`);
      setLoading(false);

      retryCountRef.current = 0;
      const freshStartDelay = 5000;

      retryTimerRef.current = setTimeout(() => {
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed during fresh start delay, aborting');
          clearRecoveryState();
          setRecoveryStatus(null);
          return;
        }

        log('info', `Executing fresh start ${freshStartNum}`);
        setRecoveryStatus(`Fresh restart (${freshStartNum}/${MAX_FRESH_STARTS})...`);

        cleanupPlayer();
        isInitializingRef.current = false;

        if (recoveryTimeoutRef.current) {
          clearTimeout(recoveryTimeoutRef.current);
        }

        const freshStartTimeout = theatreMode ? 20000 : 15000;
        recoveryTimeoutRef.current = setTimeout(() => {
          if (isRecoveringRef.current) {
            log('warn', 'Fresh start timeout - player did not start');
            clearRecoveryState();
            if (freshStartCountRef.current < MAX_FRESH_STARTS) {
              attemptRecovery('Fresh start timeout - player did not start');
            } else {
              log('error', 'Fresh start timeout and all fresh starts exhausted');
              setError('Stream unavailable. Please try another channel or refresh the page.');
              notifyStreamDead('fresh_start_exhausted');
            }
          }
        }, freshStartTimeout);

        reinitialize(playbackMethod);
      }, freshStartDelay);
    } else {
      log('error', `Stream failed after ${MAX_RETRIES} retries and ${MAX_FRESH_STARTS} fresh starts`);
      setError('Stream unavailable. Please try another channel or refresh the page.');
      clearRecoveryState(true);
      notifyStreamDead();
    }
  };

  const attemptSoftRecovery = (errorContext = '') => {
    if (skipRecovery) {
      log('info', 'Skip recovery enabled (auto-test mode) - not attempting soft recovery');
      setError('Stream failed');
      if (onStreamError) onStreamError();
      return;
    }

    if (theatreMode && window.iptvRecoveryQueue.globalPaused) {
      log('info', 'Global recovery paused - too many failures across all streams');
      setError('Multiple streams failing. Please wait or refresh the page.');
      notifyStreamDead();
      return;
    }

    if (streamUnstableRef.current) {
      log('info', 'Stream marked as unstable, not attempting soft recovery');
      notifyStreamDead();
      return;
    }

    if (isStreamChronicallyUnstable()) {
      setError('Stream is unstable. Try "Find Alternative" or refresh the page.');
      isRecoveringRef.current = false;
      notifyStreamDead();
      return;
    }

    if (theatreMode && !checkGlobalRecoveryLimits(log)) {
      setError('Too many stream failures. Please wait or refresh the page.');
      isRecoveringRef.current = false;
      notifyStreamDead();
      return;
    }

    // Without a live player instance we can't unload/load — escalate
    // straight to full recovery.
    if (!playerInstanceRef.current) {
      log('info', 'No player instance for soft recovery, falling back to full recovery');
      attemptRecovery(errorContext);
      return;
    }

    if (getChannelId() !== currentChannelIdRef.current) {
      log('info', 'Channel changed, skipping soft recovery');
      return;
    }

    if (isRecoveringRef.current) {
      log('info', 'Recovery already in progress, skipping soft recovery');
      return;
    }

    softRecoveryCountRef.current++;
    if (softRecoveryCountRef.current > MAX_SOFT_RECOVERIES) {
      log('info', `Soft recovery limit (${MAX_SOFT_RECOVERIES}) reached, falling back to full recovery`);
      softRecoveryCountRef.current = 0;
      attemptRecovery(errorContext);
      return;
    }

    log('info', `Attempting soft recovery (${softRecoveryCountRef.current}/${MAX_SOFT_RECOVERIES}): ${errorContext}`);
    isRecoveringRef.current = true;
    setRecoveryStatus(`Reconnecting (soft ${softRecoveryCountRef.current}/${MAX_SOFT_RECOVERIES})...`);

    if (theatreMode) {
      const queue = window.iptvRecoveryQueue;
      const now = Date.now();
      const timeSinceLastGlobalRecovery = now - queue.lastRecoveryTime;

      if (
        timeSinceLastGlobalRecovery < 500 ||
        queue.activeRecoveries >= queue.maxConcurrentRecoveries
      ) {
        if (queue.pendingRecoveries.length >= queue.maxPendingRecoveries) {
          log('warn', 'Too many pending recoveries, dropping soft recovery attempt');
          isRecoveringRef.current = false;
          return;
        }
        const delayMs = Math.max(500 - timeSinceLastGlobalRecovery, 0) + Math.random() * 500;
        isRecoveringRef.current = false;
        const recoveryTimer = setTimeout(() => {
          const idx = queue.pendingRecoveries.indexOf(recoveryTimer);
          if (idx > -1) queue.pendingRecoveries.splice(idx, 1);
          attemptSoftRecovery(errorContext);
        }, delayMs);
        queue.pendingRecoveries.push(recoveryTimer);
        return;
      }
      queue.lastRecoveryTime = now;
      queue.activeRecoveries++;
    }

    try {
      const player = playerInstanceRef.current;

      log('info', 'Soft recovery: unloading stream');
      player.unload();

      const reloadDelay = theatreMode ? 1000 : 500;

      setTimeout(() => {
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed during soft recovery, aborting');
          clearRecoveryState();
          setRecoveryStatus(null);
          return;
        }

        if (!playerInstanceRef.current) {
          log('info', 'Player destroyed during soft recovery, falling back to full recovery');
          clearRecoveryState();
          attemptRecovery(errorContext);
          return;
        }

        log('info', 'Soft recovery: reloading stream');
        player.load();

        player.play().catch(() => {
          // Autoplay blocked — expected, the user can click to play.
        });

        const softRecoveryTimeout = theatreMode ? 10000 : 8000;
        const timeoutId = setTimeout(() => {
          if (isRecoveringRef.current) {
            log('warn', 'Soft recovery timeout - stream did not start');
            clearRecoveryState();
            if (softRecoveryCountRef.current < MAX_SOFT_RECOVERIES) {
              attemptSoftRecovery('Soft recovery timeout');
            } else {
              softRecoveryCountRef.current = 0;
              attemptRecovery('Soft recovery failed');
            }
          }
        }, softRecoveryTimeout);

        recoveryTimeoutRef.current = timeoutId;
      }, reloadDelay);
    } catch (e) {
      log('error', 'Soft recovery failed with exception', { error: e.message });
      clearRecoveryState();
      softRecoveryCountRef.current = 0;
      attemptRecovery(errorContext + ' (soft recovery exception)');
    }
  };

  const startHealthCheck = () => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }

    // Theatre mode: tightened from 10s to 5s, then 5s to 3s after
    // user reports of slow recovery. Faster detection means earlier
    // escalation to refresh, which is the only thing that fixes a
    // dead backend pipe.
    const checkInterval = theatreMode ? 3000 : 3000;
    const freezeThreshold = theatreMode ? 8000 : checkInterval * 3;
    // Nudge counter resets every time currentTime advances; tracked in
    // this closure so it stays scoped to the current health-check run.
    let nudgesThisFreeze = 0;
    // Timestamp of the first health-check tick that observed a frozen
    // playhead in the CURRENT freeze episode. Used purely for log
    // timestamps so we can correlate the timeline of recovery
    // decisions when debugging.
    let freezeStartedAt = 0;
    // Track previous tick time so we can detect timer throttling
    // (Chrome throttles background-tab timers to 1Hz after 5min idle
    // and 1/min after 30min). If we see >2× the expected interval
    // between ticks, log it — this distinguishes "stream actually
    // froze for N seconds" from "timer was paused for N seconds".
    let lastTickAt = 0;

    healthCheckIntervalRef.current = setInterval(() => {
      // Tick-interval anomaly detection. setInterval is supposed to
      // fire every `checkInterval` ms; if the gap is >2× expected,
      // the browser throttled us (almost always: tab in background).
      // Log it so we can distinguish "stream genuinely froze" from
      // "we just couldn't observe it".
      const tickNow = Date.now();
      if (lastTickAt > 0) {
        const gap = tickNow - lastTickAt;
        if (gap > checkInterval * 2) {
          log(
            'warn',
            `[health] tick gap ${gap}ms (expected ~${checkInterval}ms) — likely tab-background throttling`
          );
        }
      }
      lastTickAt = tickNow;

      const videoEl = videoElementRef.current;
      if (!videoEl) return;
      if (videoEl.paused) return;

      if (videoEl.ended) {
        log('error', 'Video in ended state - live stream should never end', {
          useResilientProxy: shouldUseResilientProxy
        });
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;

        if (shouldUseResilientProxy) {
          setError('Stream ended. Finding alternative...');
          notifyStreamDead('ended');
          return;
        }

        attemptSoftRecovery('Stream ended (health check)');
        return;
      }

      if (getChannelId() !== currentChannelIdRef.current) {
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;
        return;
      }

      const currentTime = videoEl.currentTime;
      const lastKnownTime = lastKnownCurrentTimeRef.current;

      // If currentTime hasn't moved, measure how long we've been frozen
      // and escalate based on that. Also catches the "stuck at 0"
      // case where the stream never started in the first place.
      if (currentTime === lastKnownTime) {
        const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;
        if (freezeStartedAt === 0) {
          freezeStartedAt = Date.now();
          log(
            'info',
            `[health] freeze begins at currentTime=${currentTime.toFixed(2)}s (since-last-playing=${timeSinceLastPlaying}ms)`
          );
        }

        // Compute "future buffer" — how much playable data sits AHEAD
        // of the current playhead. When this is 0, the MSE buffer is
        // drained and the freeze is caused by the network/backend
        // stopping, NOT by an MSE underrun. Playhead nudges can't
        // help in that case — seeking into nothing keeps you frozen
        // — so we skip the nudge tier and escalate directly to the
        // refresh path (notifyStreamDead → handleStreamDead in
        // MultiViewPage → refreshStream).
        let futureBufferS = 0;
        try {
          const tr = videoEl.buffered;
          for (let i = 0; i < tr.length; i++) {
            if (tr.start(i) <= currentTime && tr.end(i) > currentTime) {
              futureBufferS = tr.end(i) - currentTime;
              break;
            }
          }
        } catch (_) { /* buffered ranges can throw before any data loads */ }
        const hasFutureBuffer = futureBufferS > 0.1;

        // Tier 0: playhead nudge — ONLY when there's future buffer.
        // Most MSE single-frame underrun stalls are fixed by a tiny
        // seek; backend-disconnect freezes are not (seeking into
        // nothing stays frozen).
        if (
          hasFutureBuffer &&
          timeSinceLastPlaying >= NUDGE_FREEZE_THRESHOLD_MS &&
          timeSinceLastPlaying < freezeThreshold &&
          nudgesThisFreeze < MAX_NUDGES_PER_FREEZE
        ) {
          try {
            const before = videoEl.currentTime;
            videoEl.currentTime = before + NUDGE_AMOUNT_S;
            nudgesThisFreeze++;
            log(
              'info',
              `[health] nudge ${nudgesThisFreeze}/${MAX_NUDGES_PER_FREEZE} (frozen ${timeSinceLastPlaying}ms at ${before.toFixed(2)}s, futureBuffer=${futureBufferS.toFixed(2)}s)`
            );
          } catch (e) {
            log('warn', `[health] nudge failed: ${e.message}`);
          }
          return;
        }

        // Fast-path: buffer drained AND past freezeThreshold —
        // upstream pipe is dead. Fires in BOTH modes:
        //   - Resilient proxy: notifyStreamDead → parent (multi-view)
        //     triggers refreshStream which re-spawns the backend
        //     ffmpeg session.
        //   - Direct upstream (single view): there's no parent
        //     handler, so we self-recover by tearing down and
        //     re-running attemptRecovery — same path the soft-
        //     recovery loop would eventually reach but without
        //     waiting through the 3-soft + 6-retry escalation chain
        //     first. The user wasn't getting any escalation at all
        //     in this branch before (logs showed back-to-back
        //     "freeze begins" with no recovery).
        if (
          !hasFutureBuffer &&
          timeSinceLastPlaying >= freezeThreshold
        ) {
          log(
            'error',
            `[health] buffer drained + frozen ${timeSinceLastPlaying}ms — upstream pipe dead, escalating`,
            { currentTime, futureBufferS, resilient: shouldUseResilientProxy }
          );
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;
          streamUnstableRef.current = true;
          cleanupPlayer();
          setError('Stream unavailable. Refreshing…');
          // Fire notifyStreamDead in BOTH modes. Previously the
          // non-resilient branch called attemptRecovery which spent
          // ~90s burning through 6 retries + 3 fresh starts on the
          // same dead URL before eventually reaching notifyStreamDead.
          // The user saw constant freezes with no recovery for over
          // a minute. Now the dead-pipe signal hits the parent (the
          // PlayerView / MultiViewPage handler) immediately and a
          // fresh remount is triggered ~3s later — same UX both
          // modes get from the resilient proxy path.
          notifyStreamDead('buffer_drained');
          return;
        }

        if (timeSinceLastPlaying >= freezeThreshold) {
          log(
            'error',
            `[health] video frozen ${timeSinceLastPlaying}ms at currentTime=${currentTime.toFixed(2)}s (futureBuffer=${futureBufferS.toFixed(2)}s)`,
            { useResilientProxy: shouldUseResilientProxy }
          );
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;

          if (shouldUseResilientProxy) {
            if (timeSinceLastPlaying >= MAX_STALE_TIME_MS) {
              log(
                'error',
                `[health] stream dead for ${Math.round(timeSinceLastPlaying / 1000)}s — stopping player, notifying parent for refresh`
              );
              streamUnstableRef.current = true;
              cleanupPlayer();
              setError('Stream unavailable. Refreshing…');
              notifyStreamDead('stale');
              return;
            }

            log(
              'info',
              `[health] frozen ${timeSinceLastPlaying}ms but resilient proxy may still recover — waiting (limit ${MAX_STALE_TIME_MS}ms)`
            );
            // Restart so MAX_STALE_TIME_MS can fire next tick.
            startHealthCheck();
            return;
          }

          attemptSoftRecovery('Stream frozen');
        }
      } else {
        // currentTime advanced: clear any leftover recovery state. The
        // timeupdate handler in initMpegts does this every second
        // already, but it stops firing during mpegts unload/load which
        // is exactly when we need this safety-net.
        if (freezeStartedAt > 0) {
          log(
            'info',
            `[health] freeze resolved after ${Date.now() - freezeStartedAt}ms (nudges used: ${nudgesThisFreeze})`
          );
          freezeStartedAt = 0;
        }
        lastKnownCurrentTimeRef.current = currentTime;
        lastPlayingTimeRef.current = Date.now();
        // Reset nudge budget — the stream is healthy again, give the
        // next freeze its own full nudge quota.
        nudgesThisFreeze = 0;

        if (isRecoveringRef.current) {
          isRecoveringRef.current = false;
        }
        if (recoveryTimeoutRef.current) {
          clearTimeout(recoveryTimeoutRef.current);
          recoveryTimeoutRef.current = null;
        }
        setRecoveryStatus((prev) => (prev == null ? prev : null));
      }
    }, checkInterval);

    log('info', `[health] started (interval=${checkInterval}ms, freezeThreshold=${freezeThreshold}ms, maxStale=${MAX_STALE_TIME_MS}ms, resilient=${shouldUseResilientProxy})`);
  };

  return {
    // functions
    attemptRecovery,
    attemptSoftRecovery,
    clearRecoveryState,
    startHealthCheck,
    notifyStreamDead,
    isStreamChronicallyUnstable,

    // refs (exposed so cleanupPlayer + initializers can touch them)
    retryCountRef,
    retryTimerRef,
    lastErrorTimeRef,
    freshStartCountRef,
    isRecoveringRef,
    recoveryTimeoutRef,
    hasCalledOnStreamDeadRef,
    totalRecoveryAttemptsRef,
    recoveryTimestampsRef,
    streamUnstableRef,
    softRecoveryCountRef
  };
}
