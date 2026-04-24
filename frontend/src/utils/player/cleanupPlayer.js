/**
 * Full teardown for an IPTVPlayer instance. Call from the unmount
 * effect and whenever we're about to re-initialize the player so we
 * don't leak the previous mpegts instance / video element.
 *
 * Handles, in order:
 *   1. Cancel every pending timer (retry, recovery, stall, health).
 *   2. Drop this instance's slot in the shared global recovery queue.
 *   3. Reset stall-detection timing refs so the next stream starts fresh.
 *   4. Remove every tracked <video> event listener (we track them in
 *      `videoListenersRef` so we can reliably unhook here — forgetting
 *      this was the source of the multi-view memory leak in the past).
 *   5. Hard-stop the <video>: pause, clear src, call load().
 *   6. Run the mpegts.js documented teardown order:
 *        pause() → unload() → detachMediaElement() → destroy()
 *   7. Detach the <video> from the DOM entirely.
 *
 * `log` is optional. `theatreMode` flips behavior 2 (queue flush).
 */
export function cleanupPlayer({
  retryTimerRef,
  recoveryTimeoutRef,
  stallTimerRef,
  healthCheckIntervalRef,
  videoListenersRef,
  videoElementRef,
  playerInstanceRef,
  lastPlayingTimeRef,
  lastKnownCurrentTimeRef,
  theatreMode,
  log = () => {}
}) {
  if (retryTimerRef.current) {
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }

  if (recoveryTimeoutRef.current) {
    clearTimeout(recoveryTimeoutRef.current);
    recoveryTimeoutRef.current = null;
  }

  if (stallTimerRef.current) {
    clearTimeout(stallTimerRef.current);
    stallTimerRef.current = null;
  }

  if (healthCheckIntervalRef.current) {
    clearInterval(healthCheckIntervalRef.current);
    healthCheckIntervalRef.current = null;
  }

  // In multi-view, flush any pending recoveries queued on the shared
  // window queue — we're tearing this player down anyway.
  if (theatreMode && window.iptvRecoveryQueue?.pendingRecoveries?.length > 0) {
    window.iptvRecoveryQueue.pendingRecoveries.forEach((timer) => clearTimeout(timer));
    window.iptvRecoveryQueue.pendingRecoveries = [];
  }

  // Reset so the next stream doesn't immediately trip the stall check.
  lastPlayingTimeRef.current = Date.now();
  lastKnownCurrentTimeRef.current = 0;

  // Remove tracked listeners BEFORE detaching the element from the DOM.
  // We use console.log directly so this is visible in theatre mode too.
  if (videoElementRef.current && videoListenersRef.current.length > 0) {
    console.log(
      `[IPTVPlayer] Cleanup: Removing ${videoListenersRef.current.length} event listeners`
    );
    for (const { event, handler } of videoListenersRef.current) {
      try {
        videoElementRef.current.removeEventListener(event, handler);
      } catch (e) {
        // ignore
      }
    }
    videoListenersRef.current = [];
  }

  // Hard-stop the <video> so the decoder releases buffers. Swallow
  // errors — at this point we just want the element inert.
  if (videoElementRef.current) {
    try {
      videoElementRef.current.pause();
      videoElementRef.current.src = '';
      videoElementRef.current.load();
    } catch (e) {
      // ignore
    }
  }

  if (playerInstanceRef.current) {
    log('info', 'Destroying player instance');
    try {
      // mpegts.js documented teardown order
      if (typeof playerInstanceRef.current.pause === 'function') {
        try {
          playerInstanceRef.current.pause();
        } catch (e) {
          // ignore
        }
      }
      if (typeof playerInstanceRef.current.unload === 'function') {
        log('info', 'Unloading mpegts player');
        playerInstanceRef.current.unload();
      }
      if (typeof playerInstanceRef.current.detachMediaElement === 'function') {
        log('info', 'Detaching media element from mpegts player');
        playerInstanceRef.current.detachMediaElement();
      }
      playerInstanceRef.current.destroy();
      log('info', 'Player destroyed successfully');
    } catch (e) {
      log('error', 'Error destroying player', { error: e.message });
    }
    playerInstanceRef.current = null;
  }

  if (videoElementRef.current && videoElementRef.current.parentNode) {
    log('info', 'Removing video element from DOM');
    videoElementRef.current.parentNode.removeChild(videoElementRef.current);
  }
  videoElementRef.current = null;
}
