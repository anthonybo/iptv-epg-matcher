import React, { useCallback, useEffect, useRef, useState } from 'react';
import { addAuthToStreamUrl } from '../utils/streamAuth';

/**
 * DiagnosticsMiniPlayer — small inline player for the Stream Health
 * Diagnostics modal. Plays a channel through the resilient stream
 * proxy so the user can visually confirm the upstream is returning
 * real content instead of an "Account expired" splash that ffprobe
 * would still mark as a healthy MPEG-TS feed.
 *
 * Implementation notes:
 *   - Uses mpegts.js for TS-over-HTTP playback (same library the
 *     multi-view tiles use). Loaded lazily from CDN so the modal
 *     doesn't pull it in until the user actually expands a preview.
 *   - The auth token rides on the URL as `?token=` because <video>
 *     elements can't set Authorization headers.
 *   - Players are torn down on unmount AND when the channel id
 *     changes — without that the previous channel's mpegts pipe
 *     keeps the backend ffprobe alive, which doubles the test load
 *     on the provider every time the user clicks a different row.
 *   - Errors and stream events surface to the user in a slim status
 *     strip — that's the point of the preview, the user wants to
 *     see WHY a "passed" channel actually shows expired video.
 */

const MPEGTS_CDN_URL = 'https://cdn.jsdelivr.net/npm/mpegts.js@latest';

const loadMpegtsOnce = () => {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.mpegts) return Promise.resolve(window.mpegts);
  if (window.__mpegtsLoadPromise) return window.__mpegtsLoadPromise;
  window.__mpegtsLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MPEGTS_CDN_URL;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.onload = () => resolve(window.mpegts);
    s.onerror = () => {
      window.__mpegtsLoadPromise = null;
      reject(new Error('Failed to load mpegts.js from CDN'));
    };
    document.head.appendChild(s);
  });
  return window.__mpegtsLoadPromise;
};

// If the stream never reaches the `playing` state within this window
// AND we've been buffering the whole time, classify it as a broken
// upstream. The user's pass-but-stuck-buffering scenario lived
// indefinitely on a spinner before this timeout — they had no way to
// distinguish "slow start" from "corrupt micro-loop on the provider's
// side" without staring at backend logs. 15 seconds is comfortably
// past the longest legitimate startup we've measured for healthy
// channels (~3-5s).
const FIRST_FRAME_TIMEOUT_MS = 15_000;

const DiagnosticsMiniPlayer = ({ sessionId, channelId, sourceId, channelName, onClose }) => {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  // Counts how many bytes the underlying ffmpeg pipe has produced
  // (read from the <video>'s buffered ranges). If it climbs but the
  // video never starts playing, that's the "corrupt loop, ffprobe
  // passed but no playable frames" case from the backend logs.
  const [status, setStatus] = useState('loading'); // loading | playing | error | broken
  const [statusMessage, setStatusMessage] = useState('Loading player…');
  const [isMuted, setIsMuted] = useState(true);
  const startedAtRef = useRef(null);
  const hasReachedPlayingRef = useRef(false);

  const teardown = useCallback(() => {
    try {
      if (playerRef.current) {
        try { playerRef.current.pause(); } catch { /* noop */ }
        try { playerRef.current.unload(); } catch { /* noop */ }
        try { playerRef.current.detachMediaElement(); } catch { /* noop */ }
        try { playerRef.current.destroy(); } catch { /* noop */ }
        playerRef.current = null;
      }
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch { /* noop */ }
      }
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    if (!sessionId || !channelId) {
      setStatus('error');
      setStatusMessage('Missing session/channel context');
      return undefined;
    }
    let cancelled = false;
    let firstFrameTimer = null;
    setStatus('loading');
    setStatusMessage('Loading player…');
    hasReachedPlayingRef.current = false;
    startedAtRef.current = Date.now();

    (async () => {
      let mpegts;
      try {
        mpegts = await loadMpegtsOnce();
      } catch (e) {
        if (!cancelled) {
          setStatus('error');
          setStatusMessage(e.message || 'Failed to load player');
        }
        return;
      }
      if (cancelled || !videoRef.current) return;
      if (!mpegts?.isSupported?.()) {
        setStatus('error');
        setStatusMessage('MSE not supported in this browser');
        return;
      }

      // Build the resilient stream URL. Token rides as a query param
      // because <video> can't carry Authorization headers. source_id
      // disambiguates when the same channel_id exists across multiple
      // accounts (common for Xtream — every Reelz row from every
      // account ships with channel_id like "xtream_12345" on different
      // sources).
      const base = `/api/stream/resilient/${encodeURIComponent(sessionId)}/${encodeURIComponent(channelId)}?source_id=${sourceId}`;
      const streamUrl = addAuthToStreamUrl(base);

      const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: streamUrl },
        {
          enableStashBuffer: false,
          stashInitialSize: 64,
          autoCleanupSourceBuffer: true,
          // Smaller buffer than multi-view tiles — we want to see
          // the stream NOW, not wait for it to fill.
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 3,
          liveBufferLatencyMinRemain: 0.5
        }
      );

      playerRef.current = player;
      player.attachMediaElement(videoRef.current);
      player.load();

      player.on(mpegts.Events.ERROR, (errType, errDetail) => {
        if (cancelled) return;
        setStatus('error');
        setStatusMessage(`Player error: ${errType}${errDetail ? ` · ${errDetail}` : ''}`);
      });

      const video = videoRef.current;
      const onPlaying = () => {
        if (cancelled) return;
        hasReachedPlayingRef.current = true;
        if (firstFrameTimer) {
          clearTimeout(firstFrameTimer);
          firstFrameTimer = null;
        }
        setStatus('playing');
        setStatusMessage('Live · receiving frames');
      };
      const onWaiting = () => {
        if (cancelled) return;
        if (!hasReachedPlayingRef.current) {
          const sec = ((Date.now() - startedAtRef.current) / 1000).toFixed(1);
          setStatusMessage(`Buffering… ${sec}s`);
        } else {
          setStatusMessage('Re-buffering — upstream is hiccuping');
        }
      };
      const onStalled = () => {
        if (cancelled) return;
        setStatusMessage('Stalled — upstream may have dropped');
      };
      video.addEventListener('playing', onPlaying);
      video.addEventListener('waiting', onWaiting);
      video.addEventListener('stalled', onStalled);

      // Periodic counter while we wait for first frame so the user
      // sees the timer climb instead of a frozen "Buffering…".
      const bufferTick = setInterval(() => {
        if (cancelled || hasReachedPlayingRef.current) return;
        const sec = ((Date.now() - startedAtRef.current) / 1000).toFixed(1);
        setStatusMessage(`Buffering… ${sec}s`);
      }, 500);

      // First-frame timeout — the actual diagnostic. If 15s pass and
      // we never reached `playing`, this is the user's "passed
      // ffprobe but corrupt upstream" case. Backend logs in this
      // state show the tell-tale pattern of "Invalid DTS… replacing
      // by guess" + "Will reconnect… error=End of file" looping
      // constantly. Tearing down the player here also stops the
      // server-side ffmpeg loop from chewing CPU.
      firstFrameTimer = setTimeout(() => {
        if (cancelled || hasReachedPlayingRef.current) return;
        teardown();
        setStatus('broken');
        setStatusMessage(
          'Stream passed ffprobe but never produced playable frames. ' +
          'Upstream is likely returning corrupt data or a short EOF loop ' +
          '(common signature: looping micro-bursts with bad timestamps).'
        );
      }, FIRST_FRAME_TIMEOUT_MS);

      // Kick playback. mpegts.js wires up to the video element; this
      // bubbles up the autoplay policy.
      try {
        await video.play();
      } catch (e) {
        // Autoplay was blocked. The Mute toggle stays usable.
        if (!cancelled) {
          setStatusMessage('Click play to start');
        }
      }

      return () => clearInterval(bufferTick);
    })();

    return () => {
      cancelled = true;
      if (firstFrameTimer) clearTimeout(firstFrameTimer);
      teardown();
    };
    // We intentionally re-mount when channel changes to fully reset
    // the player chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId, sourceId, teardown]);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      {/* Player surface — 16:9 aspect with a subtle scanline texture
          fallback so an "expired" splash with no audio still reads
          as "yes there's an image here". */}
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          muted={isMuted}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />

        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80">
            <div className="flex items-center gap-2 text-slate-300 text-xs font-mono">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {statusMessage}
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-rose-950/40 px-4 text-center">
            <svg className="w-6 h-6 text-rose-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3v.008m9-3.758a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[11px] font-mono text-rose-200 max-w-full break-words">{statusMessage}</span>
          </div>
        )}

        {/* `broken` is distinct from `error` — ffprobe passed, the
            handshake works, bytes are flowing, but the stream never
            produces playable video. This is the specific case the
            preview was built for: amber so the user clocks "this is
            the diagnostic the test missed" instead of a generic
            error. */}
        {status === 'broken' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-amber-950/40 px-4 text-center">
            <svg className="w-7 h-7 text-amber-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 3.75h.008M5.05 19h13.9c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.32 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-200">
              No playable frames
            </span>
            <span className="text-[11px] font-mono text-amber-100/90 max-w-full break-words leading-relaxed">
              {statusMessage}
            </span>
          </div>
        )}
      </div>

      {/* Status strip + controls */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-slate-800 bg-slate-900/70">
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full flex-shrink-0 ${
            status === 'playing' ? 'bg-emerald-400' :
            status === 'error'   ? 'bg-rose-400' :
            status === 'broken'  ? 'bg-amber-400' :
                                   'bg-amber-300'
          }`}
        >
          {status === 'playing' && (
            <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-60 animate-ping" />
          )}
        </span>
        <span className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-300 truncate flex-1">
          {statusMessage}
        </span>

        <button
          type="button"
          onClick={() => {
            const next = !isMuted;
            setIsMuted(next);
            if (videoRef.current) videoRef.current.muted = next;
          }}
          title={isMuted ? 'Unmute' : 'Mute'}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
        >
          {isMuted ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={() => { teardown(); onClose?.(); }}
          title="Close preview"
          className="p-1 rounded hover:bg-rose-500/15 text-slate-400 hover:text-rose-200 transition"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default React.memo(DiagnosticsMiniPlayer);
