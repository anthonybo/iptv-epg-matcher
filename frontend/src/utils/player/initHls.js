import Hls from 'hls.js';
import { addAuthToStreamUrl } from '../streamAuth';
import { detectVideoQuality } from '../videoQuality';

/**
 * hls.js playback for IPTVPlayer. Used in tandem with the backend's
 * /api/stream/hls/:sessionId/:channelId/index.m3u8 endpoint, which
 * runs ffmpeg with HTTP-reconnect flags and segments the upstream TS
 * into a rolling HLS playlist.
 *
 * Why this exists:
 *   - mpegts.js does not auto-reconnect on live EOF (hard-coded in
 *     io-controller.js). Every Xtream socket close was bubbling up to
 *     us as LOADING_COMPLETE.
 *   - hls.js has a real live-recovery state machine (segment retry,
 *     gap skipping, recoverMediaError on MSE corruption).
 *   - Native HLS in iOS Safari + macOS Safari plays the same playlist
 *     directly off `<video src>`, so iPad/iPhone work for free.
 *
 * Recovery model (much simpler than mpegts.js):
 *   - hls.js fires `Hls.Events.ERROR` with `fatal: true|false`
 *   - non-fatal errors auto-recover internally (we just log)
 *   - fatal NETWORK_ERROR → call `hls.startLoad()`
 *   - fatal MEDIA_ERROR → call `hls.recoverMediaError()`
 *   - fatal OTHER_ERROR → notifyStreamDead so the multi-view picks an
 *     alternative source
 *
 * No 600-line `useStreamRecovery` needed. This is the whole reason we
 * switched.
 */

function buildPlaylistUrl({ sessionId, getChannelId, selectedChannel }) {
    const cid = encodeURIComponent(getChannelId());
    let url = `/api/stream/hls/${sessionId}/${cid}/index.m3u8`;
    if (selectedChannel?.sourceId) {
        url += `?source_id=${selectedChannel.sourceId}`;
    }
    return url;
}

export function initializeHlsPlayer(ctx) {
    const {
        log,
        sessionId,
        selectedChannel,
        getChannelId,
        theatreMode,
        muted,
        onQualityDetected,
        onStreamPlaying,
        containerRef,
        videoElementRef,
        playerInstanceRef,
        currentChannelIdRef,
        isInitializingRef,
        hasCalledOnStreamDeadRef,
        setError,
        setLoading,
        setRecoveryStatus,
        setVideoQuality,
        setVideoElementKey,
        addTrackedListener,
        notifyStreamDead,
    } = ctx;

    const playlistUrl = addAuthToStreamUrl(buildPlaylistUrl({ sessionId, getChannelId, selectedChannel }));

    if (!containerRef.current) {
        log('error', 'No container for hls.js');
        setError('Player container not available');
        setLoading(false);
        return;
    }

    try {
        while (containerRef.current.firstChild) {
            containerRef.current.removeChild(containerRef.current.firstChild);
        }

        const videoEl = document.createElement('video');
        videoEl.id = 'hls-video';
        videoEl.style.width = '100%';
        videoEl.style.height = '100%';
        videoEl.controls = !theatreMode;
        videoEl.muted = muted;
        videoEl.playsInline = true;
        videoEl.autoplay = true;
        containerRef.current.appendChild(videoEl);

        videoElementRef.current = videoEl;
        setVideoElementKey((prev) => prev + 1);

        const detectQualityHls = (eventType = 'check') => {
            const info = detectVideoQuality(videoEl.videoWidth, videoEl.videoHeight);
            if (info) {
                log('info', `Video quality detected (${eventType}): ${info.resolution}`);
                setVideoQuality(info);
                if (onQualityDetected) onQualityDetected(info);
            }
        };

        addTrackedListener(videoEl, 'playing', () => {
            log('info', 'Video playing');
            setLoading(false);
            setError(null);
            setRecoveryStatus(null);
            isInitializingRef.current = false;
            hasCalledOnStreamDeadRef.current = false;
            if (onStreamPlaying) onStreamPlaying();
            detectQualityHls('playing');
        });
        if (!theatreMode) {
            addTrackedListener(videoEl, 'resize', () => detectQualityHls('resize'));
        }

        // ============================================================
        // Native HLS path (iOS Safari, macOS Safari)
        // ============================================================
        // Safari's <video> can play .m3u8 directly — and its native
        // implementation handles live-edge tracking + recovery itself.
        // hls.js explicitly recommends *not* attaching on Safari.
        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            log('info', 'Using native HLS (Safari)');
            videoEl.src = playlistUrl;
            videoEl.play().catch(() => {});
            playerInstanceRef.current = { destroy: () => { videoEl.removeAttribute('src'); videoEl.load(); } };
            return;
        }

        if (!Hls.isSupported()) {
            log('error', 'Neither native HLS nor MSE-based hls.js available');
            setError('Your browser does not support HLS playback');
            setLoading(false);
            return;
        }

        // ============================================================
        // hls.js path (Chrome/Firefox/Edge/etc.)
        // ============================================================
        const hls = new Hls({
            // Live-stream tuning. Keep latency reasonable in multi-view
            // but don't chase the live edge so aggressively we keep
            // hitting buffer underruns.
            liveSyncDurationCount: theatreMode ? 2 : 3,
            liveMaxLatencyDurationCount: theatreMode ? 6 : 10,
            // Quietly retry transient fragment failures.
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 500,
            fragLoadingMaxRetryTimeout: 8000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 500,
            levelLoadingMaxRetry: 4,
            // Drop the worker in theatre mode — 6 web workers (one per
            // tile) compounded the memory pressure we hit before.
            enableWorker: !theatreMode,
            lowLatencyMode: false,
            backBufferLength: theatreMode ? 10 : 30,
        });

        hls.attachMedia(videoEl);

        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            log('info', 'hls.js attached, loading playlist');
            hls.loadSource(playlistUrl);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            videoEl.play().catch(() => {});
        });

        hls.on(Hls.Events.LEVEL_LOADED, () => {
            // First playlist fetch succeeded → cancel any "loading" UI.
            setLoading(false);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
            const { type, details, fatal } = data;
            if (!fatal) {
                // hls.js recovers non-fatal errors internally — log only
                // the noisy ones.
                if (/error|fail/i.test(details)) {
                    log('warn', `hls non-fatal: ${type}/${details}`);
                }
                return;
            }

            log('error', `hls fatal: ${type}/${details}`);
            switch (type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    setRecoveryStatus('Reconnecting…');
                    try { hls.startLoad(); } catch (_) {}
                    break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                    setRecoveryStatus('Recovering decoder…');
                    try { hls.recoverMediaError(); } catch (_) {}
                    break;
                default:
                    setError('Stream unavailable. Finding alternative…');
                    notifyStreamDead(`hls_fatal_${type}`);
                    try { hls.destroy(); } catch (_) {}
                    break;
            }
        });

        playerInstanceRef.current = hls;
    } catch (e) {
        log('error', 'Error initializing hls.js player', { error: e.message });
        setError(`Error initializing player: ${e.message}`);
        setLoading(false);
    }
}
