import { addAuthToStreamUrl } from '../streamAuth';
import { detectVideoQuality } from '../videoQuality';
import { streamBase } from '../streamBase';

/**
 * mpegts.js playback setup for IPTVPlayer — the primary path for
 * TS-over-HTTP streams.
 *
 * Two entry points:
 *   - initializeMpegtsPlayer(ctx): lazy-loads mpegts.js from the CDN if
 *     it isn't already on window, then calls through to the instance.
 *   - initializeMpegtsPlayerInstance(ctx): builds the TS URL, wires up
 *     every mpegts.js / <video> event, and starts playback.
 *
 * The `ctx` bundle is the same shape IPTVPlayer passes to the Clappr
 * initializer — see `initAltPlayers.js`. It carries every ref, state
 * setter, and recovery callback so we don't need a 30-parameter call.
 *
 * Biggest subtleties worth noting:
 *   - Stash buffer + worker are DISABLED in theatre mode. With 6 streams
 *     running, each enabled buffer/worker compounds — empirically this
 *     is what kept memory usable in multi-view.
 *   - In resilient-proxy mode we intentionally do NOT react to `waiting`,
 *     `stalled`, `ended`, mpegts ERROR, or mpegts LOADING_COMPLETE. The
 *     backend is already running its own reconnect loop; calling
 *     player.unload() from the client aborts the in-flight backend
 *     fetch and resets its retry counter. Worse, the unload+load
 *     sequence spawns a SECOND backend ffmpeg pipe while the first is
 *     still alive, and the doubled-up fetches race into a false
 *     stream-dead within seconds. The health-check guard in
 *     useStreamRecovery still promotes a truly-dead stream via
 *     MAX_STALE_TIME_MS (45s frozen currentTime).
 *   - On stream ERROR with a "Maximum call stack size exceeded" or
 *     "Exception" detail we skip recovery entirely — these are internal
 *     corruption that will loop forever if we keep retrying.
 */

export function initializeMpegtsPlayer(ctx) {
  const { log, setError, setLoading } = ctx;

  if (!window.mpegts) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mpegts.js@latest';
    // Needed so window.onerror receives real error details from this CDN
    // script instead of the opaque "Script error." placeholder.
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onload = () => {
      log('info', 'mpegts.js loaded');
      initializeMpegtsPlayerInstance(ctx);
    };
    script.onerror = () => {
      log('error', 'Failed to load mpegts.js');
      setError('Failed to load video player library');
      setLoading(false);
    };
    document.head.appendChild(script);
  } else {
    initializeMpegtsPlayerInstance(ctx);
  }
}

export function validateStreamUrl(ctx, url) {
  const { log, sessionId, selectedChannel, getChannelId } = ctx;

  if (!url || typeof url !== 'string' || !(url.startsWith('http') || url.startsWith('/'))) {
    log('error', 'Invalid stream URL', { url });
    return false;
  }

  if (url.includes('/api/stream/') && !sessionId) {
    log('error', 'Missing session ID in stream URL', { url });
    return false;
  }

  // Defensive: the channel id occasionally contains characters that
  // need URL encoding. If we see the raw id in the path but not an
  // encoded version, re-encode the whole URL once.
  if (selectedChannel && url.includes(getChannelId()) && !url.includes(encodeURIComponent(getChannelId()))) {
    log('warn', 'Channel ID not properly encoded in URL');
    return encodeURI(url);
  }

  return url;
}

export function initializeMpegtsPlayerInstance(ctx) {
  const {
    log,
    sessionId,
    selectedChannel,
    getChannelId,
    theatreMode,
    muted,
    shouldUseResilientProxy,
    onQualityDetected,
    onStreamPlaying,
    containerRef,
    videoElementRef,
    playerInstanceRef,
    recoveryTimeoutRef,
    stallTimerRef,
    lastPlayingTimeRef,
    lastKnownCurrentTimeRef,
    currentChannelIdRef,
    isInitializingRef,
    isRecoveringRef,
    hasCalledOnStreamDeadRef,
    streamUnstableRef,
    retryCountRef,
    freshStartCountRef,
    totalRecoveryAttemptsRef,
    softRecoveryCountRef,
    failureCountRef,
    recoveryTimestampsRef,
    setError,
    setLoading,
    setRecoveryStatus,
    setVideoQuality,
    setVideoElementKey,
    clearRecoveryState,
    addTrackedListener,
    attemptRecovery,
    attemptSoftRecovery,
    notifyStreamDead,
    startHealthCheck
  } = ctx;

  if (!window.mpegts) {
    log('error', 'mpegts.js not available');
    setError('Player library not available');
    setLoading(false);
    return;
  }

  log('info', 'Initializing mpegts.js player', { useResilientProxy: shouldUseResilientProxy });

  // Resilient endpoint handles retry/reconnect at the backend. The
  // standard endpoint relies on our frontend recovery logic. Cache-bust
  // only the standard endpoint — the resilient one is a long-lived
  // proxy connection we don't want to churn.
  // streamBase() points us at the backend port directly in dev so the
  // long-running stream connection doesn't burn an HTTP/1.1 slot on
  // localhost:3000. See utils/streamBase.js for the full reasoning.
  const SB = streamBase();
  let baseTsUrl;
  if (shouldUseResilientProxy) {
    baseTsUrl = `${SB}/api/stream/resilient/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
    log('info', 'Using resilient stream proxy (backend-level retry)');
  } else {
    baseTsUrl = `${SB}/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
  }
  if (selectedChannel?.sourceId) {
    baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
  }
  if (!shouldUseResilientProxy) {
    baseTsUrl += `&_t=${Date.now()}`;
  }

  let proxyTsUrl = addAuthToStreamUrl(baseTsUrl);
  proxyTsUrl = validateStreamUrl(ctx, proxyTsUrl);
  if (!proxyTsUrl) {
    setError('Invalid stream URL. Please try another channel.');
    setLoading(false);
    return;
  }

  try {
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }

    const videoEl = document.createElement('video');
    videoEl.id = 'mpegts-video';
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.controls = !theatreMode;
    videoEl.muted = muted;
    containerRef.current.appendChild(videoEl);

    videoElementRef.current = videoEl;
    setVideoElementKey((prev) => prev + 1);

    if (!window.mpegts.getFeatureList().mseLivePlayback) {
      log('error', 'MSE not supported in this browser');
      setError(
        'Your browser does not support the required video playback features. Try using VLC instead.'
      );
      setLoading(false);
      return;
    }

    // mpegts.js emits thousands of log lines per second. In multi-view
    // that compounds into measurable CPU overhead, so turn it all off.
    if (theatreMode && window.mpegts.LoggingControl) {
      window.mpegts.LoggingControl.enableAll = false;
      window.mpegts.LoggingControl.enableDebug = false;
      window.mpegts.LoggingControl.enableVerbose = false;
      window.mpegts.LoggingControl.enableInfo = false;
      window.mpegts.LoggingControl.enableWarn = false;
      window.mpegts.LoggingControl.enableError = false;
    }

    const player = window.mpegts.createPlayer({
      type: 'mse',
      url: proxyTsUrl,
      isLive: true,

      // Multi-view vs single-view resource strategy:
      //   multi-view — disable stash buffer + worker, tight latency window
      //   single-view — enable both, wider buffers for quality
      enableStashBuffer: !theatreMode,
      stashInitialSize: theatreMode ? 32 * 1024 : 384 * 1024,
      enableWorker: !theatreMode,

      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: theatreMode ? 1.5 : 3.0,
      liveBufferLatencyMinRemain: theatreMode ? 0.3 : 1.5,

      // 2MB per stream × 6 streams = 12MB in theatre mode.
      maxBufferSize: theatreMode ? 2 * 1024 * 1024 : 64 * 1024 * 1024,

      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: theatreMode ? 10 : 300,
      autoCleanupMinBackwardDuration: theatreMode ? 5 : 180,

      lazyLoad: false,
      lazyLoadMaxDuration: 3 * 60,
      lazyLoadRecoverDuration: 30,

      liveSync: true,
      liveSyncMaxLatency: theatreMode ? 2.0 : 4.0,
      liveSyncTargetLatency: theatreMode ? 1.0 : 2.0,
      liveSyncPlaybackRate: theatreMode ? 1.15 : 1.05
    });

    player.attachMediaElement(videoEl);

    // Two timers cover the "stream never starts" failure mode:
    //
    //  1. EARLY-BUFFER (1.2s) — Surfaces a status so the user isn't
    //     staring at the bare native <video> spinner while mpegts.js
    //     burns its own retry budget. Function form so it doesn't
    //     clobber an ERROR-driven message already set.
    //
    //  2. NO-PLAY ESCALATION (20s) — startHealthCheck() only runs
    //     after the first 'playing' event. If the upstream is
    //     permanently dead and we never play, the health check
    //     never starts. This timer is the failsafe: if currentTime
    //     is still 0 at 20s, escalate to stream-dead so the parent
    //     can remount or show an error.
    //
    // Critical: these timers are cleared on 'playing' (real
    // playback) NOT on 'loadeddata'. MSE source open fires
    // 'loadeddata' even when no actual playback ever happens, which
    // was clearing the escalation early and letting a dead stream
    // sit indefinitely. The existing 'playing' handler below
    // already clears both via cleanupPlayer's listener teardown
    // and the explicit clearTimeout we add here.
    // Sentinel check used by both timers: if cleanupPlayer has nulled
    // out playerInstanceRef, this IPTVPlayer was unmounted (including
    // React StrictMode's intentional dev-time double-mount). The
    // first mount's timers would otherwise fire ~20s later — two
    // notifyStreamDead calls = instant 2-cycle give-up before the
    // real attempt has had a chance.
    const isUnmounted = () => playerInstanceRef.current == null;

    const earlyBufferTimer = setTimeout(() => {
      if (isUnmounted()) return;
      if (videoEl.currentTime > 0) return;
      if (getChannelId() !== currentChannelIdRef.current) return;
      setRecoveryStatus((prev) => prev ?? 'Connecting — buffering stream');
    }, 1200);

    const NO_PLAY_TIMEOUT_MS = 20000;
    const noPlayTimer = setTimeout(() => {
      if (isUnmounted()) return;
      if (videoEl.currentTime > 0) return;
      if (getChannelId() !== currentChannelIdRef.current) return;
      log('error', `[init] no playback within ${NO_PLAY_TIMEOUT_MS}ms — escalating to stream-dead`);
      streamUnstableRef.current = true;
      setError('Stream unavailable. Try Find Alternative or refresh the page.');
      setRecoveryStatus(null);
      notifyStreamDead('no_play_timeout');
    }, NO_PLAY_TIMEOUT_MS);

    // Clear timers only when real playback starts (currentTime > 0
    // confirms the video element is actually advancing). 'timeupdate'
    // fires repeatedly during playback, so we check the first one
    // with a non-zero time and clear both timers. mpegts.js's
    // SourceOpen / loadeddata events fire BEFORE actual frames flow
    // and were clearing the no-play escalation prematurely.
    const clearStartupTimers = () => {
      if (videoEl.currentTime > 0) {
        clearTimeout(earlyBufferTimer);
        clearTimeout(noPlayTimer);
        videoEl.removeEventListener('timeupdate', clearStartupTimers);
      }
    };
    addTrackedListener(videoEl, 'timeupdate', clearStartupTimers);

    player.on(window.mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
      log('error', 'mpegts player error', {
        errorType,
        errorDetail,
        errorInfo,
        useResilientProxy: shouldUseResilientProxy
      });
      setLoading(false);
      isInitializingRef.current = false;

      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed, skipping retry');
        return;
      }

      // Internal JS corruption — keep retrying and we'll just stack up
      // the same crash. Mark the stream unstable and bail to parent.
      const errorMsg = errorInfo?.msg || errorInfo?.message || '';
      if (
        errorMsg.includes('Maximum call stack size exceeded') ||
        errorMsg.includes('stack') ||
        errorDetail === 'Exception'
      ) {
        log('error', 'Fatal internal error - not attempting recovery', { errorMsg });
        setError('Stream corrupted. Finding alternative...');
        streamUnstableRef.current = true;
        notifyStreamDead('corrupted');
        return;
      }

      let errorContext = 'Stream error';
      if (errorType === window.mpegts.ErrorTypes.NETWORK_ERROR) {
        if (errorDetail === window.mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID) {
          const statusCode = errorInfo?.code || 'unknown';
          errorContext = `Network error (HTTP ${statusCode})`;
        } else {
          errorContext = `Network error (${errorDetail})`;
        }
      } else if (errorType === window.mpegts.ErrorTypes.MEDIA_ERROR) {
        errorContext = `Media error (${errorDetail})`;
      }

      // Resilient proxy mode: the backend is already running its own
      // reconnect loop (ffmpeg + the resilient stream wrapper). Calling
      // attemptSoftRecovery here aborts the in-flight backend fetch and
      // spawns a SECOND ffmpeg pipe — directly observed in logs as two
      // FFMPEG ids active for the same channel ~6s apart, with the
      // first one's "Client disconnected" landing in the same second
      // as the new auto-find request fires. The doubled-up fetches
      // race and the player ends up declaring a healthy stream dead.
      //
      // For the same reasons the file already early-returns on
      // <video> waiting/stalled/ended in resilient mode, route ERROR
      // and LOADING_COMPLETE the same way: do nothing here, and let
      // the health-check guard in useStreamRecovery promote a truly
      // dead stream via MAX_STALE_TIME_MS (45s of frozen currentTime).
      // The 'corrupted' fast-path above still fires for unrecoverable
      // crashes — only the network/media transient cascade is silenced.
      if (shouldUseResilientProxy) {
        log('info', `mpegts ${errorContext} — backend handles reconnect in resilient mode, not soft-recovering`);
        // Bump the failure counter so the chyron can say "3 attempts
        // failed" instead of a generic "buffering". Reset on the
        // first 'playing' event along with the other counters.
        if (failureCountRef) failureCountRef.current += 1;
        const n = failureCountRef ? failureCountRef.current : 1;
        setRecoveryStatus(
          n === 1
            ? `Connection failed — retrying (${errorContext})`
            : `${n} attempts failed — retrying (${errorContext})`
        );
        return;
      }

      attemptSoftRecovery(errorContext);
    });

    player.on(window.mpegts.Events.LOADING_COMPLETE, () => {
      log('warn', 'Stream loading complete (server closed connection)', {
        useResilientProxy: shouldUseResilientProxy
      });

      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed, ignoring loading complete');
        return;
      }

      // Same reasoning as the ERROR handler — see the comment above.
      // mpegts.js fires LOADING_COMPLETE for transient EOFs on the
      // backend response (e.g. when ffmpeg's upstream socket cycles
      // and our io-controller sees the response close briefly) even
      // though the backend is fine. In resilient mode the client
      // shouldn't react: triggering player.unload()/load() spawns a
      // second concurrent ffmpeg pipe and the doubled-up fetches
      // cascade into a false stream-dead within seconds. Health-check
      // (MAX_STALE_TIME_MS) handles a truly-dead stream.
      if (shouldUseResilientProxy) {
        log('info', 'Stream loading complete — backend handles reconnect in resilient mode');
        if (failureCountRef) failureCountRef.current += 1;
        const n = failureCountRef ? failureCountRef.current : 1;
        setRecoveryStatus(
          n === 1
            ? 'Server closed connection — retrying'
            : `${n} attempts failed — retrying (server closed connection)`
        );
        return;
      }
      attemptSoftRecovery('Stream ended (loading complete)');
    });

    player.load();

    const detectQualityMpegts = (eventType = 'check') => {
      const qualityInfo = detectVideoQuality(videoEl.videoWidth, videoEl.videoHeight);
      if (qualityInfo) {
        log('info', `Video quality detected (${eventType}): ${qualityInfo.resolution} (${qualityInfo.width}x${qualityInfo.height})`);
        setVideoQuality(qualityInfo);
        if (onQualityDetected) onQualityDetected(qualityInfo);
      }
    };

    addTrackedListener(videoEl, 'playing', () => {
      log('info', 'Video playing');
      setLoading(false);
      setError(null);
      setRecoveryStatus(null);

      if (recoveryTimeoutRef.current) {
        clearTimeout(recoveryTimeoutRef.current);
        recoveryTimeoutRef.current = null;
      }

      // Reset every recovery counter on `playing`. The previous behaviour
      // only reset hasCalledOnStreamDeadRef, leaving retry/timestamp/soft
      // counters intact — so a stream that hiccuped twice during startup
      // and then played fine still entered subsequent failures with the
      // chronic-unstable budget half-spent. A handful of transient blips
      // past that point would trip isStreamChronicallyUnstable() and
      // promote the slot to dead, which is exactly the "channels load in
      // fine then automatically get replaced" symptom.
      lastPlayingTimeRef.current = Date.now();
      lastKnownCurrentTimeRef.current = videoEl.currentTime;
      clearRecoveryState();
      isInitializingRef.current = false;
      hasCalledOnStreamDeadRef.current = false;
      if (retryCountRef) retryCountRef.current = 0;
      if (freshStartCountRef) freshStartCountRef.current = 0;
      if (totalRecoveryAttemptsRef) totalRecoveryAttemptsRef.current = 0;
      if (softRecoveryCountRef) softRecoveryCountRef.current = 0;
      if (failureCountRef) failureCountRef.current = 0;
      if (recoveryTimestampsRef) recoveryTimestampsRef.current = [];
      if (streamUnstableRef) streamUnstableRef.current = false;

      // Notify the multi-view chain breaker that this slot reached a
      // healthy state — useFindAlternative listens and resets the
      // shared per-chain swap counter so a future failure on this slot
      // doesn't carry over the previous stream's budget.
      try {
        window.dispatchEvent(new CustomEvent('iptv:streamPlaying', {
          detail: {
            channelId: getChannelId(),
            sourceId: selectedChannel?.sourceId,
            searchQuery: selectedChannel?.searchQuery || null,
            espnEventName: selectedChannel?.espnEventName || null,
            name: selectedChannel?.name || null
          }
        }));
      } catch (_) { /* CustomEvent unsupported, ignore */ }

      if (onStreamPlaying) onStreamPlaying();

      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }

      detectQualityMpegts('playing');
      startHealthCheck();
    });

    // Resolution-change listener only in single view. In theatre mode
    // the initial detection is enough and per-slot listeners add up.
    if (!theatreMode) {
      addTrackedListener(videoEl, 'resize', () => detectQualityMpegts('resize'));
    }

    let lastTimeUpdate = 0;
    const timeUpdateThrottle = theatreMode ? 1000 : 250;

    addTrackedListener(videoEl, 'timeupdate', () => {
      const now = Date.now();
      if (now - lastTimeUpdate < timeUpdateThrottle) return;
      lastTimeUpdate = now;

      lastPlayingTimeRef.current = now;

      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }

      // If the video is actively advancing, whatever triggered recovery
      // is over. Clear the banner + isRecoveringRef here — without this,
      // mpegts' unload()/load() path doesn't pause the <video>, so the
      // `playing` event never re-fires and the recovery state would stay
      // stuck (this was the "Reconnecting (soft N/N) never clears"
      // production incident).
      if (isRecoveringRef.current) {
        isRecoveringRef.current = false;
      }
      if (recoveryTimeoutRef.current) {
        clearTimeout(recoveryTimeoutRef.current);
        recoveryTimeoutRef.current = null;
      }
      setRecoveryStatus((prev) => (prev == null ? prev : null));
    });

    const handleStall = (eventType) => {
      // In resilient-proxy mode the backend already owns reconnection.
      // Calling player.unload() here would cancel the in-flight backend
      // fetch and restart it from attempt 1 — producing the "Reconnecting
      // (soft N/N) stuck on a playing video" symptom we saw. The
      // health-check promotes truly-dead streams via MAX_STALE_TIME_MS.
      if (shouldUseResilientProxy) return;

      log('warn', `Video ${eventType} - checking for stall`);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);

      const stallTimeout = theatreMode ? 15000 : 10000;

      stallTimerRef.current = setTimeout(() => {
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed, ignoring stall');
          return;
        }
        const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;
        // 10s window matches mpegts.js stash-buffer behavior — anything
        // shorter was triggering a full unload/load during key-frame
        // alignment.
        if (timeSinceLastPlaying > 10000) {
          log('error', `Video stalled for ${timeSinceLastPlaying}ms`);
          attemptSoftRecovery('Stream stalled');
        }
      }, stallTimeout);
    };

    addTrackedListener(videoEl, 'waiting', () => handleStall('waiting'));
    addTrackedListener(videoEl, 'stalled', () => handleStall('stalled'));

    addTrackedListener(videoEl, 'error', () => {
      log('error', 'Video error', { error: videoEl.error });
      setLoading(false);
      isInitializingRef.current = false;
      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed, skipping recovery on video error');
        return;
      }
      // Resilient-mode guard — same reasoning as the sibling 'ended',
      // 'waiting' (handleStall), mpegts ERROR, and LOADING_COMPLETE
      // handlers: calling attemptRecovery here cancels the in-flight
      // backend fetch and spawns a fresh ffmpeg via cleanupPlayer +
      // reinit. That was the *second* cancellation source we hadn't
      // capped — distinct from PlayerView's notifyStreamDead loop,
      // because attemptRecovery cycles internally up to MAX_RETRIES
      // (6) before notifying. With this guard, the no-play timer +
      // health check own the escalation path and PlayerView's
      // MAX_REMOUNT_CYCLES cap bounds the total attempts.
      if (shouldUseResilientProxy) {
        if (failureCountRef) failureCountRef.current += 1;
        const n = failureCountRef ? failureCountRef.current : 1;
        setRecoveryStatus(
          n === 1
            ? 'Connection failed — retrying (video element error)'
            : `${n} attempts failed — retrying (video element error)`
        );
        return;
      }
      attemptRecovery('Video element error');
    });

    addTrackedListener(videoEl, 'ended', () => {
      log('warn', 'Live stream ended unexpectedly');
      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed, ignoring stream end');
        return;
      }
      // Same reasoning as handleStall: let the backend drive reconnect
      // in resilient mode; otherwise try a soft reload first.
      if (shouldUseResilientProxy) return;
      attemptSoftRecovery('Stream ended (video element)');
    });

    player.play().catch(() => {
      // Autoplay blocked — expected in many browsers, not an error.
    });

    playerInstanceRef.current = player;
  } catch (e) {
    log('error', 'Error initializing mpegts.js player', { error: e.message });
    setError(`Error initializing player: ${e.message}`);
    setLoading(false);
  }
}
