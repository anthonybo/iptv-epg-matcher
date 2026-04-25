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
  // threshold + 3 retries with backoff), so wait ~45s before promoting
  // to dead. Non-resilient: frontend recovery is doing the work, so the
  // 120s ceiling is just a safety net.
  const MAX_STALE_TIME_MS = shouldUseResilientProxy ? 45000 : 120000;
  const MAX_SOFT_RECOVERIES = 3;

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

    // Theatre mode uses a coarse 10s tick so 6 concurrent health
    // checks don't eat the main thread. Single view runs at 3s for
    // faster feedback.
    const checkInterval = theatreMode ? 10000 : 3000;
    const freezeThreshold = theatreMode ? checkInterval * 2 : checkInterval * 3;

    healthCheckIntervalRef.current = setInterval(() => {
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

        if (timeSinceLastPlaying >= freezeThreshold) {
          log('error', `Video frozen detected - no progress for ${timeSinceLastPlaying}ms at currentTime ${currentTime}s`, {
            useResilientProxy: shouldUseResilientProxy
          });
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;

          if (shouldUseResilientProxy) {
            // Past 2min frozen the player is effectively dead; keeping
            // mpegts.js running just loops its internal retry and can
            // crash it. Stop cleanly and let the parent find an alt.
            if (timeSinceLastPlaying >= MAX_STALE_TIME_MS) {
              log('error', `Stream dead for ${Math.round(timeSinceLastPlaying / 1000)}s - completely stopping player`);
              streamUnstableRef.current = true;
              cleanupPlayer();
              setError('Stream unavailable. Finding alternative...');
              notifyStreamDead('stale');
              return;
            }

            if (timeSinceLastPlaying >= 30000) {
              log('warn', `Stream frozen for ${Math.round(timeSinceLastPlaying / 1000)}s - still waiting for backend`);
            } else {
              log('info', 'Stream frozen but using resilient proxy - waiting for backend reconnect');
            }
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
        lastKnownCurrentTimeRef.current = currentTime;
        lastPlayingTimeRef.current = Date.now();

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

    log('info', `Health check started (interval: ${checkInterval}ms, freeze threshold: ${freezeThreshold}ms, resilientProxy: ${shouldUseResilientProxy})`);
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
