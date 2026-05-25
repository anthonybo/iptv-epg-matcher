import Hls from 'hls.js';
import apiClient from '../apiClient';

/**
 * hls.js playback for YouTube live channels in multi-view tiles.
 *
 * The flow is:
 *   1. Hit /api/youtube/channel/:channelId/live to ask the backend
 *      (which spawns yt-dlp) for the current live HLS manifest URL.
 *   2. If the channel is broadcasting, plug the URL straight into
 *      hls.js. YouTube's HLS CDN serves CORS-compatible playlists
 *      so no backend proxy is needed.
 *   3. If the channel is OFFLINE, surface that to the user via the
 *      player's error overlay (set via setError) — the tile then
 *      shows the "not currently live" state until they refresh or
 *      pick a different channel.
 *
 * HLS URLs from YouTube carry an `expire` param (~6h TTL). On fatal
 * NETWORK_ERROR we re-resolve once before giving up — covers the
 * expired-URL case without flooding yt-dlp with retries.
 */

const MAX_RESOLVE_RETRIES = 2;

export async function initializeYoutubeHlsPlayer(ctx) {
  const {
    log,
    selectedChannel,
    getChannelId,
    theatreMode,
    muted,
    setError,
    setLoading,
    setRecoveryStatus,
    setVideoQuality,
    setVideoElementKey,
    containerRef,
    playerInstanceRef,
    videoElementRef,
    isInitializingRef,
    currentChannelIdRef,
    clearRecoveryState,
    addTrackedListener,
    notifyStreamDead,
    onStreamPlaying,
    onQualityDetected
  } = ctx;

  const channelId = getChannelId();
  if (!/^UC[\w-]{20,}$/.test(channelId || '')) {
    log('error', 'YouTube playback requires a UC… channel id', { channelId });
    setError('Not a YouTube channel id.');
    setLoading(false);
    isInitializingRef.current = false;
    return;
  }

  // IPTVPlayer.initializePlayer already set isInitializingRef / currentChannelIdRef
  // before calling us — no need to re-guard.
  setLoading(true);
  setError(null);
  setRecoveryStatus('Resolving YouTube live stream…');

  // ─── 1. Resolve current HLS URL via backend ─────────────────────
  let resolveAttempts = 0;
  async function resolveHls(force = false) {
    resolveAttempts += 1;
    const url = `/youtube/channel/${channelId}/live${force ? '?force=1' : ''}`;
    const r = await apiClient.get(url);
    return r.data || {};
  }

  let resolved;
  try {
    resolved = await resolveHls();
  } catch (e) {
    log('error', 'Failed to resolve YouTube live HLS', { msg: e.message });
    setError(`Could not resolve YouTube stream: ${e.response?.data?.error || e.message}`);
    setLoading(false);
    isInitializingRef.current = false;
    return;
  }

  if (!resolved.isLive || !resolved.hlsUrl) {
    setError('This YouTube channel is not currently live.');
    setRecoveryStatus(null);
    setLoading(false);
    isInitializingRef.current = false;
    return;
  }

  // ─── 2. Mount <video> element ───────────────────────────────────
  try {
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }
    const videoEl = document.createElement('video');
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.style.objectFit = theatreMode ? 'contain' : 'cover';
    videoEl.controls = false;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = !!muted;
    // NB: we intentionally do NOT set crossOrigin='anonymous' —
    // googlevideo.com does not return CORS headers, and requesting
    // CORS makes the manifest + segment fetches fail outright. The
    // resulting cross-origin "taint" only matters if Web Audio
    // attaches to the element (it silently silences a tainted
    // source). We avoid that by NOT registering YouTube tiles with
    // the commercial detector — see StreamCell's onVideoElement
    // pass-through, which is null for YouTube tiles.
    containerRef.current.appendChild(videoEl);
    videoElementRef.current = videoEl;
    setVideoElementKey((k) => (k || 0) + 1);
  } catch (e) {
    log('error', 'Failed to mount YouTube <video>', { msg: e.message });
    setError(`Failed to mount video element: ${e.message}`);
    setLoading(false);
    isInitializingRef.current = false;
    return;
  }

  // ─── 3. Attach hls.js (or fall back to native HLS on Safari) ────
  function attachHls(hlsUrl) {
    const videoEl = videoElementRef.current;
    if (!videoEl) return;

    // Tear down any previous instance.
    if (playerInstanceRef.current && typeof playerInstanceRef.current.destroy === 'function') {
      try { playerInstanceRef.current.destroy(); } catch (_) {}
      playerInstanceRef.current = null;
    }

    // Native HLS path (Safari, iOS). Simpler + more reliable on those.
    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = hlsUrl;
      addTrackedListener(videoEl, 'loadedmetadata', () => {
        videoEl.play().catch(() => {});
      });
      addTrackedListener(videoEl, 'playing', () => {
        clearRecoveryState();
        setLoading(false);
        setError(null);
        setRecoveryStatus(null);
        onStreamPlaying?.();
        try {
          const q = { resolution: `${videoEl.videoWidth}x${videoEl.videoHeight}` };
          setVideoQuality(q);
          onQualityDetected?.(q);
        } catch (_) {}
      });
      addTrackedListener(videoEl, 'error', () => {
        // No introspection on native; treat as dead.
        log('warn', 'native HLS error on YouTube stream, asking for alternative');
        notifyStreamDead?.();
      });
      return;
    }

    if (!Hls.isSupported()) {
      setError('hls.js is not supported in this browser, and native HLS playback failed.');
      setLoading(false);
      return;
    }

    const hls = new Hls({
      lowLatencyMode: false,                // YouTube live is HLS-VOD-style
      backBufferLength: 30,
      maxBufferLength: 20,
      maxMaxBufferLength: 40,
      manifestLoadingTimeOut: 15_000,
      levelLoadingTimeOut: 15_000,
      fragLoadingTimeOut: 20_000
    });
    playerInstanceRef.current = hls;

    hls.loadSource(hlsUrl);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      videoEl.play().catch((e) => log('warn', 'autoplay rejected', { msg: e.message }));
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const level = data?.details;
      if (level && setVideoQuality) {
        const w = data?.level?.width || 0;
        const h = data?.level?.height || 0;
        if (w && h) {
          const q = { resolution: `${w}x${h}` };
          setVideoQuality(q);
          onQualityDetected?.(q);
        }
      }
    });
    addTrackedListener(videoEl, 'playing', () => {
      clearRecoveryState();
      setLoading(false);
      setError(null);
      setRecoveryStatus(null);
      onStreamPlaying?.();
    });

    hls.on(Hls.Events.ERROR, async (_evt, data) => {
      if (!data?.fatal) return;
      log('warn', 'fatal hls.js error on YouTube stream', { type: data.type, details: data.details });

      // Expired manifest URL → re-resolve once.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && resolveAttempts < MAX_RESOLVE_RETRIES) {
        setRecoveryStatus('Re-resolving YouTube manifest…');
        try {
          const fresh = await resolveHls(true);
          if (fresh.isLive && fresh.hlsUrl) {
            try { hls.destroy(); } catch (_) {}
            attachHls(fresh.hlsUrl);
            return;
          }
          if (!fresh.isLive) {
            setError('YouTube channel is no longer live.');
            setLoading(false);
            return;
          }
        } catch (e) {
          log('warn', 'YouTube re-resolve failed', { msg: e.message });
        }
      }

      // Otherwise give up → multi-view's stream-dead handler picks up.
      try { hls.destroy(); } catch (_) {}
      playerInstanceRef.current = null;
      setError('YouTube stream playback failed.');
      setLoading(false);
      notifyStreamDead?.();
    });
  }

  try {
    attachHls(resolved.hlsUrl);
    setRecoveryStatus(null);
  } finally {
    isInitializingRef.current = false;
  }
}
