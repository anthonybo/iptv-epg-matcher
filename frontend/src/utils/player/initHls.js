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
        // Sentinel log so we can verify HMR loaded the patched module.
        // The recoverMediaError-on-first-error path was added in this
        // build; if every new player instance prints this line, the
        // browser is running the current code. Uses console.log
        // directly because the `log` helper is gated off in
        // theatreMode (multiview) — see IPTVPlayer.js:137. Remove
        // once stable.
        console.log(`[hls ${getChannelId()}] initHls v2 (recoverMediaError-first) loaded`);

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

        // Diagnostics + progress watchdog need to live BEFORE the
        // native-HLS early return below, because Safari users (Mac +
        // iOS) take that path and we still need to know when their
        // stream isn't actually rendering. We bypass the IPTVPlayer
        // log() helper because it's gated by theatreMode; console.warn
        // / console.error are intercepted by utils/logger.js and
        // relayed to the backend.
        const cid = getChannelId();
        const tag = `[hls ${cid}]`;
        const mountedAt = Date.now();
        const sinceMount = () => Date.now() - mountedAt;

        // Recovery state — declared BEFORE the <video> listeners so the
        // listener closures can reference these without hitting a TDZ
        // ReferenceError if an event fires synchronously during setup.
        // `hlsRef.current` is null on the Safari (native HLS) path —
        // assigned below for the hls.js path.
        const hlsRef = { current: null };
        let lastMediaRecoveryAt = 0;
        let mediaRecoveryAttempts = 0;

        addTrackedListener(videoEl, 'playing', () => {
            log('info', 'Video playing');
            setLoading(false);
            setError(null);
            setRecoveryStatus(null);
            isInitializingRef.current = false;
            hasCalledOnStreamDeadRef.current = false;
            // Successful playback proves the previous recovery (if any)
            // worked — reset the burst counter so the next isolated
            // demuxer error gets the full retry budget instead of
            // inheriting whatever count was at the time of the last
            // error.
            mediaRecoveryAttempts = 0;

            // Notify the multi-view chain breaker that this slot is
            // healthy so a future failure doesn't carry the previous
            // stream's chain count. See useFindAlternative for the
            // listener side.
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
            } catch (_) { /* ignore */ }

            if (onStreamPlaying) onStreamPlaying();
            detectQualityHls('playing');
        });
        if (!theatreMode) {
            addTrackedListener(videoEl, 'resize', () => detectQualityHls('resize'));
        }

        // <video> diagnostic events. Suppress events fired during the
        // first 2s of mount — a stalled-while-loading is normal and
        // would otherwise spam.
        addTrackedListener(videoEl, 'stalled', () => {
            if (sinceMount() > 2000) console.warn(`${tag} <video> stalled (no data) at t=${videoEl.currentTime.toFixed(1)}s`);
        });
        addTrackedListener(videoEl, 'waiting', () => {
            if (sinceMount() > 2000) console.warn(`${tag} <video> waiting (buffering) at t=${videoEl.currentTime.toFixed(1)}s`);
        });
        addTrackedListener(videoEl, 'error', () => {
            const err = videoEl.error;
            const code = err?.code;
            console.error(`${tag} <video> error code=${code} msg=${err?.message}`);
            // Codes 3 (DECODE) and 4 (SRC_NOT_SUPPORTED, includes
            // DEMUXER_ERROR_COULD_NOT_PARSE) are terminal for the
            // current source — Chrome's media pipeline gives up and
            // won't recover passively. Before declaring the stream
            // dead we give hls.js one shot at recoverMediaError(),
            // which swaps the demuxer + reattaches MSE buffers and
            // rescues a lot of "first segment was a glitch" cases
            // that previously triggered an immediate find-alternative
            // swap. Only escalate to notifyStreamDead if recovery has
            // already been tried within the last 15s (i.e. the
            // recovered stream errored AGAIN — the upstream is
            // genuinely broken).
            if ((code === 3 || code === 4) && !hasCalledOnStreamDeadRef.current) {
                const now = Date.now();
                // If the last attempt was >30s ago, that counts as
                // "stream actually recovered" — reset the burst counter.
                if (lastMediaRecoveryAt > 0 && now - lastMediaRecoveryAt > 30000) {
                    mediaRecoveryAttempts = 0;
                }
                console.log(`${tag} error-recovery diag: hlsRef.current=${hlsRef.current ? 'set' : 'NULL'} attempts=${mediaRecoveryAttempts} streamDead=${hasCalledOnStreamDeadRef.current}`);
                if (hlsRef.current && mediaRecoveryAttempts < 2) {
                    mediaRecoveryAttempts += 1;
                    lastMediaRecoveryAt = now;
                    setRecoveryStatus(`Stream glitched — reloading (${mediaRecoveryAttempts}/2)…`);
                    try {
                        if (mediaRecoveryAttempts === 1) {
                            hlsRef.current.recoverMediaError();
                            console.log(`${tag} attempted recoverMediaError() after <video> error code=${code}`);
                        } else {
                            // Second attempt: hls.js docs recommend
                            // swapping the audio codec then retrying
                            // recoverMediaError — handles the case
                            // where the demux error is in the audio
                            // pipeline (AAC ↔ AC-3 transitions etc.).
                            try { hlsRef.current.swapAudioCodec(); } catch (_) {}
                            hlsRef.current.recoverMediaError();
                            console.log(`${tag} attempted swapAudioCodec()+recoverMediaError() after second <video> error code=${code}`);
                        }
                        return;
                    } catch (recoverErr) {
                        console.warn(`${tag} recovery attempt ${mediaRecoveryAttempts} threw — escalating`, recoverErr);
                    }
                }
                if (watchdogId) clearInterval(watchdogId);
                watchdogId = null;
                setError('Playback failed. Finding alternative…');
                notifyStreamDead(`hls_video_error_${code}_after_${mediaRecoveryAttempts}_recoveries`);
            }
        });
        addTrackedListener(videoEl, 'ended', () => {
            console.warn(`${tag} <video> ended (live should not end)`);
        });

        // ────────────────────────────────────────────────────────────
        // No-progress watchdog
        // ────────────────────────────────────────────────────────────
        // Catches the "playing event fired but currentTime never moves"
        // case — this happens when the stream's bitstream is malformed
        // or uses a codec the browser MSE/native-HLS path doesn't fully
        // support, so the player attaches and reports "playing" but
        // produces no frames. Neither the hls.js error path nor the
        // <video> stalled/waiting/error events surface this — the
        // stream looks alive from the player's perspective.
        //
        // The Channel 9 AU netball test surfaced exactly this:
        // ffprobe verified the stream, ffmpeg ran for 27s, "Video
        // playing" fired, but the user saw a black box and nothing
        // ever recovered.
        let lastObservedTime = 0;
        let lastProgressAt = Date.now();
        let watchdogId = null;
        const STALL_TIMEOUT_MS = 30000;
        const startWatchdog = () => {
            if (watchdogId) return;
            watchdogId = setInterval(() => {
                try {
                    const el = videoElementRef.current;
                    if (!el || !el.parentElement) {
                        clearInterval(watchdogId);
                        watchdogId = null;
                        return;
                    }
                    if (el.paused) {
                        // user-paused or pre-play; reset the deadline
                        lastProgressAt = Date.now();
                        return;
                    }
                    const ct = el.currentTime || 0;
                    if (ct > lastObservedTime + 0.1) {
                        lastObservedTime = ct;
                        lastProgressAt = Date.now();
                        return;
                    }
                    const idleMs = Date.now() - lastProgressAt;
                    if (idleMs >= STALL_TIMEOUT_MS) {
                        console.error(`${tag} watchdog: no playback progress for ${Math.round(idleMs / 1000)}s — declaring dead`);
                        clearInterval(watchdogId);
                        watchdogId = null;
                        if (!hasCalledOnStreamDeadRef.current) {
                            setError('Stream not playing. Finding alternative…');
                            notifyStreamDead('hls_no_progress');
                        }
                    }
                } catch (e) {
                    // videoEl was torn down underneath us — exit cleanly.
                    if (watchdogId) clearInterval(watchdogId);
                    watchdogId = null;
                }
            }, 5000);
        };

        // ============================================================
        // Native HLS path (iOS Safari, macOS Safari)
        // ============================================================
        // Safari's <video> can play .m3u8 directly — and its native
        // implementation handles live-edge tracking + recovery itself.
        // hls.js explicitly recommends *not* attaching on Safari.
        //
        // GOTCHA: `canPlayType('application/vnd.apple.mpegurl')` returns
        // truthy on Chrome iOS (WebKit) AND on some Chromium builds
        // that have partial HLS support. If we take the native path
        // there, we lose hls.js's recoverMediaError() handle — which
        // is exactly what we need to fix the DEMUXER swap-loop. Force
        // hls.js whenever it's supported, falling back to native HLS
        // only when MSE is unavailable.
        if (!Hls.isSupported() && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            console.log(`${tag} taking NATIVE HLS path (no MSE) — recoverMediaError unavailable`);
            videoEl.src = playlistUrl;
            videoEl.play().catch(() => {});
            startWatchdog();
            playerInstanceRef.current = {
                destroy: () => {
                    if (watchdogId) clearInterval(watchdogId);
                    watchdogId = null;
                    videoEl.removeAttribute('src');
                    videoEl.load();
                }
            };
            return;
        }

        if (!Hls.isSupported()) {
            console.warn(`${tag} Neither native HLS nor MSE-based hls.js available`);
            setError('Your browser does not support HLS playback');
            setLoading(false);
            return;
        }

        // ============================================================
        // hls.js path (Chrome/Firefox/Edge/etc.)
        // ============================================================
        console.log(`${tag} taking HLS.JS path — recoverMediaError available`);
        const hls = new Hls({
            // Per hls.js docs: liveSyncDurationCount default is 3.
            //   "Decreasing this value is likely to cause playback
            //   stalls."
            // Our previous value of 2 was below the documented floor
            // and was almost certainly contributing to the "froze a
            // few seconds in" symptom — hls.js was trying to play
            // within 4s of the live edge while ffmpeg was still
            // writing fragment N+1.
            liveSyncDurationCount: theatreMode ? 3 : 4,
            // Must be strictly > liveSyncDurationCount per docs.
            // Default is Infinity — we set explicit ceilings so a
            // long stall triggers a recovery seek instead of getting
            // stuck.
            liveMaxLatencyDurationCount: theatreMode ? 8 : 12,
            // Always run the demuxer in a Web Worker. Disabling it in
            // multi-view (the previous "save memory" tradeoff) caused
            // simultaneous DEMUXER_ERROR_COULD_NOT_PARSE failures: with
            // 4-6 hls.js instances all transmuxing MPEG-TS → fMP4 on
            // the main thread, they starved each other and produced
            // malformed `appendBuffer` calls that Chrome rejected. The
            // few extra MB per worker is cheap compared to "every
            // tile dies at once".
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: theatreMode ? 10 : 30,
            // Modern Load Policy API. The previous fragLoadingMaxRetry /
            // manifestLoadingMaxRetry / etc. keys were deprecated and
            // silently ignored — hls.js was using its defaults the
            // whole time. We mirror the documented defaults verbatim
            // for visibility, with a slightly higher errorRetry budget
            // on the manifest + playlist paths since our backend is on
            // the LAN and the cost of an extra retry is trivial.
            manifestLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: Infinity,
                    maxLoadTimeMs: 20000,
                    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
                    errorRetry:   { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 8000 }
                }
            },
            playlistLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: 10000,
                    maxLoadTimeMs: 20000,
                    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
                    errorRetry:   { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 8000 }
                }
            },
            fragLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: 10000,
                    maxLoadTimeMs: 120000,
                    timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
                    errorRetry:   { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
                }
            }
        });

        // Expose to the <video> error handler (registered earlier so its
        // closure can't reference `hls` directly).
        hlsRef.current = hls;

        hls.attachMedia(videoEl);

        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            log('info', 'hls.js attached, loading playlist');
            hls.loadSource(playlistUrl);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            videoEl.play().catch(() => {});
            startWatchdog();
        });

        hls.on(Hls.Events.LEVEL_LOADED, () => {
            // First playlist fetch succeeded → cancel any "loading" UI.
            setLoading(false);
        });

        let lastNonFatalAt = 0;
        // Bounded retry counters for FATAL networkError. Without these
        // the case below silently looped: if the upstream produced
        // 503 on every manifest fetch (which happens when our backend
        // ffmpeg gets EOF mid-stream and writes nothing further), the
        // hls.js NETWORK_ERROR branch just kept calling startLoad()
        // forever and the player sat in "Reconnecting…" with no
        // escalation. Two windows so we can be patient with single
        // segment hiccups but quick to declare death on a manifest
        // that's persistently 5xx-ing.
        let manifestFailures = 0;
        let firstManifestFailureAt = 0;
        let segmentFailures = 0;
        let firstSegmentFailureAt = 0;
        let mediaFailures = 0;
        let firstMediaFailureAt = 0;
        const MANIFEST_FAIL_WINDOW_MS = 12000;
        const MANIFEST_FAIL_LIMIT = 3;
        const SEGMENT_FAIL_WINDOW_MS = 25000;
        const SEGMENT_FAIL_LIMIT = 5;
        // Tighter window for media errors. When MSE rejects a codec it
        // bursts dozens of events per second, so the window is short
        // and the limit deliberately low — recoverMediaError() either
        // works on the first 1-2 attempts or it never will.
        const MEDIA_FAIL_WINDOW_MS = 4000;
        const MEDIA_FAIL_LIMIT = 4;

        hls.on(Hls.Events.ERROR, (_event, data) => {
            const { type, details, fatal } = data;
            if (!fatal) {
                // Throttle non-fatal warning logs to one per 2s so a
                // flapping fragment doesn't spam.
                const now = Date.now();
                if (now - lastNonFatalAt > 2000) {
                    lastNonFatalAt = now;
                    console.warn(`${tag} non-fatal ${type}/${details}`, {
                        url: data.url,
                        reason: data.reason,
                        response: data.response?.code
                    });
                }
                return;
            }

            console.error(`${tag} FATAL ${type}/${details}`, {
                url: data.url,
                reason: data.reason,
                response: data.response?.code
            });
            switch (type) {
                case Hls.ErrorTypes.NETWORK_ERROR: {
                    const now = Date.now();
                    // hls.js details strings are stable per-event-type
                    // (manifestLoadError, levelLoadError,
                    // fragLoadError, etc.). The two we care about:
                    //   * manifest/level — the playlist itself is
                    //     unreachable. If this 5xx-loops, the stream
                    //     is dead, no amount of retry helps.
                    //   * frag — a single segment failed; retries
                    //     usually recover when the encoder catches up.
                    const isManifest = /manifest|level/i.test(String(details || ''));
                    if (isManifest) {
                        if (!firstManifestFailureAt || now - firstManifestFailureAt > MANIFEST_FAIL_WINDOW_MS) {
                            firstManifestFailureAt = now;
                            manifestFailures = 0;
                        }
                        manifestFailures += 1;
                        if (manifestFailures >= MANIFEST_FAIL_LIMIT) {
                            console.error(`${tag} manifest failed ${manifestFailures}× in ${(now - firstManifestFailureAt) / 1000}s — declaring dead`);
                            setError('Stream unavailable. Finding alternative…');
                            notifyStreamDead(`hls_fatal_manifest_${manifestFailures}_failures`);
                            try { hls.destroy(); } catch (_) {}
                            break;
                        }
                        setRecoveryStatus(`Reconnecting (${manifestFailures}/${MANIFEST_FAIL_LIMIT})…`);
                    } else {
                        if (!firstSegmentFailureAt || now - firstSegmentFailureAt > SEGMENT_FAIL_WINDOW_MS) {
                            firstSegmentFailureAt = now;
                            segmentFailures = 0;
                        }
                        segmentFailures += 1;
                        if (segmentFailures >= SEGMENT_FAIL_LIMIT) {
                            console.error(`${tag} segment failed ${segmentFailures}× in ${(now - firstSegmentFailureAt) / 1000}s — declaring dead`);
                            setError('Stream unavailable. Finding alternative…');
                            notifyStreamDead(`hls_fatal_segment_${segmentFailures}_failures`);
                            try { hls.destroy(); } catch (_) {}
                            break;
                        }
                        setRecoveryStatus(`Reconnecting (${segmentFailures}/${SEGMENT_FAIL_LIMIT})…`);
                    }
                    try { hls.startLoad(); } catch (_) {}
                    break;
                }
                case Hls.ErrorTypes.MEDIA_ERROR: {
                    // Same windowed-retry guard as the network branch,
                    // for the same reason: hls.js can fire fatal
                    // mediaError 50+ times in a single second when MSE
                    // rejects a codec (e.g. AC-3 audio in an
                    // un-transcoded HLS). The default
                    // recoverMediaError() loop NEVER escalates and we
                    // had to wait 30s for the no-progress watchdog —
                    // see 2026-05-08 21:51 log where Spectrum Sportsnet
                    // LA flooded with bufferAddCodecError. Bound it so
                    // the dead-channel handler kicks in within seconds.
                    const now = Date.now();
                    if (!firstMediaFailureAt || now - firstMediaFailureAt > MEDIA_FAIL_WINDOW_MS) {
                        firstMediaFailureAt = now;
                        mediaFailures = 0;
                    }
                    mediaFailures += 1;
                    if (mediaFailures >= MEDIA_FAIL_LIMIT) {
                        console.error(`${tag} media error ${mediaFailures}× in ${(now - firstMediaFailureAt) / 1000}s — declaring dead (likely codec mismatch)`);
                        setError('Stream codec unsupported. Finding alternative…');
                        notifyStreamDead(`hls_fatal_media_${details}_${mediaFailures}`);
                        try { hls.destroy(); } catch (_) {}
                        break;
                    }
                    setRecoveryStatus(`Stream glitched — reloading (${mediaFailures}/${MEDIA_FAIL_LIMIT})…`);
                    try { hls.recoverMediaError(); } catch (_) {}
                    break;
                }
                default:
                    setError('Stream unavailable. Finding alternative…');
                    notifyStreamDead(`hls_fatal_${type}`);
                    try { hls.destroy(); } catch (_) {}
                    break;
            }
        });

        // Reset fatal-error counters once a fragment lands, so a tile
        // that recovered after a transient blip gets the full retry
        // budget the next time it hiccups (instead of inheriting the
        // last incident's count and dying on a single later miss).
        hls.on(Hls.Events.FRAG_LOADED, () => {
            manifestFailures = 0;
            firstManifestFailureAt = 0;
            segmentFailures = 0;
            firstSegmentFailureAt = 0;
            mediaFailures = 0;
            firstMediaFailureAt = 0;
        });

        // Wrap hls.destroy so the watchdog stops cleanly when the
        // player is torn down (channel switch, page unmount, etc.).
        const originalDestroy = hls.destroy.bind(hls);
        hls.destroy = () => {
            if (watchdogId) clearInterval(watchdogId);
            watchdogId = null;
            originalDestroy();
        };
        playerInstanceRef.current = hls;
    } catch (e) {
        log('error', 'Error initializing hls.js player', { error: e.message });
        setError(`Error initializing player: ${e.message}`);
        setLoading(false);
    }
}
