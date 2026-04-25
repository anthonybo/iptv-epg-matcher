import { addAuthToStreamUrl } from '../streamAuth';
import { detectVideoQuality } from '../videoQuality';

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
 *     `stalled`, or `ended` on the <video>. The backend is already
 *     running its own reconnect loop; calling player.unload() from the
 *     client aborts the in-flight backend fetch and resets its retry
 *     counter. The health-check guard in IPTVPlayer still promotes a
 *     truly-dead stream via MAX_STALE_TIME_MS.
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
  let baseTsUrl;
  if (shouldUseResilientProxy) {
    baseTsUrl = `/api/stream/resilient/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
    log('info', 'Using resilient stream proxy (backend-level retry)');
  } else {
    baseTsUrl = `/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
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

      // Resilient proxy mode: the backend has its own retry loop. If it
      // surfaces an error to us it's already exhausted; don't double
      // up with frontend recovery.
      if (shouldUseResilientProxy) {
        log('info', 'Using resilient proxy - backend retry exhausted, showing error');
        setError(`${errorContext}. Finding alternative...`);
        notifyStreamDead('exhausted');
        return;
      }

      attemptRecovery(errorContext);
    });

    player.on(window.mpegts.Events.LOADING_COMPLETE, () => {
      log('warn', 'Stream loading complete (server closed connection)', {
        useResilientProxy: shouldUseResilientProxy
      });

      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed, ignoring loading complete');
        return;
      }

      if (shouldUseResilientProxy) {
        log('info', 'Using resilient proxy - backend connection closed, showing error');
        setError('Stream ended. Finding alternative...');
        notifyStreamDead('closed');
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

      // Don't reset retry counters on every `playing` — a stream that
      // briefly plays then dies would loop forever. attemptRecovery()
      // resets them after 30s of sustained playback instead.
      lastPlayingTimeRef.current = Date.now();
      lastKnownCurrentTimeRef.current = videoEl.currentTime;
      clearRecoveryState();
      isInitializingRef.current = false;
      hasCalledOnStreamDeadRef.current = false;

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
