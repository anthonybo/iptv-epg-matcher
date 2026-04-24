import { addAuthToStreamUrl } from '../streamAuth';
import { detectVideoQuality } from '../videoQuality';

/**
 * Alternate playback backends for IPTVPlayer. We almost always use
 * mpegts.js, but keep these around for:
 *   - `hls-player` → Clappr (HLS fallback for providers that transcode)
 *   - `vlc-link`   → renders a copyable URL so the user can paste into VLC
 *   - `test-video` → plays Big Buck Bunny so we can verify the container
 *                    is wiring audio/video correctly when real streams fail
 *
 * Each initializer takes the same `ctx` bundle so IPTVPlayer only has
 * to construct one object. The ctx holds every ref + state setter +
 * helper the initializer needs — we avoid a 20-parameter signature by
 * funneling them through this object.
 */

export function initializeClapprPlayer(ctx) {
  const {
    log,
    sessionId,
    selectedChannel,
    getChannelId,
    theatreMode,
    setError,
    setLoading,
    setRecoveryStatus,
    setVideoQuality,
    setVideoElementKey,
    onQualityDetected,
    containerRef,
    playerInstanceRef,
    videoElementRef,
    recoveryTimeoutRef,
    stallTimerRef,
    lastPlayingTimeRef,
    currentChannelIdRef,
    isInitializingRef,
    clearRecoveryState,
    addTrackedListener,
    attemptRecovery
  } = ctx;

  if (!window.Clappr) {
    log('warn', 'Clappr not loaded yet');
    setError('Player library not loaded yet. Please wait a moment and try again.');
    setLoading(false);
    return;
  }

  let baseUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}`;
  // Scope the search to the originating source so we don't match a
  // same-named channel from a different IPTV provider.
  if (selectedChannel?.sourceId) {
    baseUrl += `?source_id=${selectedChannel.sourceId}`;
  }
  const proxyHlsUrl = addAuthToStreamUrl(baseUrl);

  log('info', 'Initializing Clappr player', { url: proxyHlsUrl });

  try {
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }

    const playerEl = document.createElement('div');
    playerEl.id = 'player-wrapper';
    playerEl.style.width = '100%';
    playerEl.style.height = '100%';
    containerRef.current.appendChild(playerEl);

    playerInstanceRef.current = new window.Clappr.Player({
      source: proxyHlsUrl,
      parentId: '#player-wrapper',
      width: '100%',
      height: '100%',
      autoPlay: true,
      hideMediaControl: theatreMode,
      disableVideoTagContextMenu: theatreMode,
      hlsjsConfig: {
        enableWorker: true,
        lowLatencyMode: false,
        debug: false,
        // Multi-view runs 4–6 streams at once; shrink buffers so 6×30MB
        // doesn't blow past what we can keep resident in memory.
        maxBufferLength: theatreMode ? 5 : 30,
        maxMaxBufferLength: theatreMode ? 10 : 60,
        maxBufferSize: theatreMode ? 5 * 1000 * 1000 : 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        backBufferLength: theatreMode ? 5 : 90,
        liveSyncDurationCount: theatreMode ? 1 : 3,
        liveMaxLatencyDurationCount: theatreMode ? 3 : 10,
        startFragPrefetch: false,
        testBandwidth: false,
        xhrSetup: () => {}
      },
      playback: { playInline: true }
    });

    playerInstanceRef.current.on(window.Clappr.Events.PLAYER_READY, () => {
      try {
        const videoEl = playerInstanceRef.current.core.activePlayback.el;
        if (videoEl) {
          videoElementRef.current = videoEl;
          setVideoElementKey((prev) => prev + 1);
        }
      } catch (err) {
        log('warn', 'Could not get video element for Clappr player', err);
      }
    });

    const detectQualityClappr = (eventType = 'check') => {
      try {
        const videoEl = videoElementRef.current;
        if (!videoEl) return;
        const qualityInfo = detectVideoQuality(videoEl.videoWidth, videoEl.videoHeight);
        if (qualityInfo) {
          log('info', `Video quality detected (${eventType}): ${qualityInfo.resolution} (${qualityInfo.width}x${qualityInfo.height})`);
          setVideoQuality(qualityInfo);
          if (onQualityDetected) onQualityDetected(qualityInfo);
        }
      } catch (err) {
        log('warn', 'Could not detect video quality for Clappr player', err);
      }
    };

    playerInstanceRef.current.on(window.Clappr.Events.PLAYER_PLAY, () => {
      log('info', 'Playback started');
      setLoading(false);
      setError(null);
      setRecoveryStatus(null);

      if (recoveryTimeoutRef.current) {
        clearTimeout(recoveryTimeoutRef.current);
        recoveryTimeoutRef.current = null;
      }

      // We intentionally do NOT reset retry counters here — that happens
      // in attemptRecovery only after 30s of steady playback. Resetting
      // on every PLAY event would let us loop forever if the stream
      // stalls seconds after playing.
      lastPlayingTimeRef.current = Date.now();
      clearRecoveryState();
      isInitializingRef.current = false;

      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }

      detectQualityClappr('playing');

      // Single-view only: react to resolution changes from adaptive
      // bitrate. In theatre mode the initial detection is enough and
      // we don't need the extra listener per slot.
      if (!theatreMode) {
        const videoEl = videoElementRef.current;
        if (videoEl) {
          const resizeHandler = () => detectQualityClappr('resize');
          addTrackedListener(videoEl, 'resize', resizeHandler);
        }
      }
    });

    let lastClapprTimeUpdate = 0;
    const clapprTimeUpdateThrottle = theatreMode ? 1000 : 250;

    playerInstanceRef.current.on(window.Clappr.Events.PLAYER_TIMEUPDATE, () => {
      const now = Date.now();
      if (now - lastClapprTimeUpdate < clapprTimeUpdateThrottle) return;
      lastClapprTimeUpdate = now;
      lastPlayingTimeRef.current = now;
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    });

    const handleClapprStall = (eventType) => {
      log('warn', `Clappr ${eventType} - checking for stall`);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);

      // Longer stall-window in theatre mode to reduce connection churn
      // — aggressive reconnection triggered kernel buffer leaks before.
      const stallTimeout = theatreMode ? 15000 : 10000;

      stallTimerRef.current = setTimeout(() => {
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed, ignoring stall');
          return;
        }
        const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;
        if (timeSinceLastPlaying > 5000) {
          log('error', `Clappr stalled for ${timeSinceLastPlaying}ms`);
          attemptRecovery('Stream stalled');
        }
      }, stallTimeout);
    };

    playerInstanceRef.current.on(window.Clappr.Events.PLAYER_BUFFERING, () =>
      handleClapprStall('buffering')
    );
    playerInstanceRef.current.on(window.Clappr.Events.PLAYER_BUFFERFULL, () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    });

    playerInstanceRef.current.on(window.Clappr.Events.PLAYER_ERROR, (error) => {
      log('error', 'Clappr player error', { error });
      setLoading(false);
      isInitializingRef.current = false;
      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed, skipping retry');
        return;
      }
      attemptRecovery('Player error');
    });
  } catch (e) {
    log('error', 'Error initializing player', { error: e.message });
    setError(`Error initializing player: ${e.message}`);
    setLoading(false);
  }
}

export function initializeVlcLink(ctx) {
  const {
    log,
    sessionId,
    selectedChannel,
    getChannelId,
    containerRef,
    setLoading
  } = ctx;

  log('info', 'Initializing VLC link page');

  let baseTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
  if (selectedChannel?.sourceId) {
    baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
  }
  const proxyTsUrl = addAuthToStreamUrl(baseTsUrl);

  while (containerRef.current.firstChild) {
    containerRef.current.removeChild(containerRef.current.firstChild);
  }

  const linkContainer = document.createElement('div');
  Object.assign(linkContainer.style, {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    padding: '20px',
    boxSizing: 'border-box',
    textAlign: 'center'
  });

  const title = document.createElement('h3');
  title.textContent = 'Stream Link for External Player';
  title.style.marginBottom = '10px';

  const description = document.createElement('p');
  description.textContent =
    'This stream may not play in the browser. Copy this URL and paste it into VLC Media Player or another external player.';
  description.style.marginBottom = '20px';
  description.style.maxWidth = '500px';

  const urlBox = document.createElement('div');
  urlBox.textContent = proxyTsUrl;
  Object.assign(urlBox.style, {
    padding: '10px',
    background: '#333',
    borderRadius: '4px',
    marginBottom: '15px',
    wordBreak: 'break-all',
    maxWidth: '90%'
  });

  const copyButton = document.createElement('button');
  copyButton.textContent = 'Copy URL';
  Object.assign(copyButton.style, {
    padding: '8px 16px',
    backgroundColor: '#4CAF50',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer'
  });
  copyButton.onclick = () => {
    navigator.clipboard
      .writeText(proxyTsUrl)
      .then(() => {
        copyButton.textContent = 'Copied!';
        setTimeout(() => {
          copyButton.textContent = 'Copy URL';
        }, 2000);
      })
      .catch((err) => {
        console.error('Copy failed:', err);
        copyButton.textContent = 'Copy Failed';
      });
  };

  linkContainer.appendChild(title);
  linkContainer.appendChild(description);
  linkContainer.appendChild(urlBox);
  linkContainer.appendChild(copyButton);
  containerRef.current.appendChild(linkContainer);

  setLoading(false);
}

export function initializeTestVideo(ctx) {
  const {
    log,
    theatreMode,
    muted,
    containerRef,
    videoElementRef,
    addTrackedListener,
    setLoading,
    setError
  } = ctx;

  log('info', 'Initializing test video');

  // Big Buck Bunny — known-good MP4 to verify the player container can
  // actually render anything. Useful as a sanity check when real
  // streams fail across the board.
  const testUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

  while (containerRef.current.firstChild) {
    containerRef.current.removeChild(containerRef.current.firstChild);
  }

  const videoEl = document.createElement('video');
  videoEl.style.width = '100%';
  videoEl.style.height = '100%';
  videoEl.controls = !theatreMode;
  videoEl.muted = muted;
  videoEl.src = testUrl;
  containerRef.current.appendChild(videoEl);
  videoElementRef.current = videoEl;

  addTrackedListener(videoEl, 'playing', () => {
    log('info', 'Test video playing');
    setLoading(false);
    setError(null);
  });

  addTrackedListener(videoEl, 'error', () => {
    log('error', 'Test video error', { error: videoEl.error });
    setError('Error playing test video.');
    setLoading(false);
  });

  videoEl.play().catch(() => {
    // Autoplay blocked — expected in many browsers, not an error.
  });
}
