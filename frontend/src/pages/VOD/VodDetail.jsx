import React, { useEffect, useMemo, useRef, useState } from 'react';
import vodService from '../../services/vodService';
import PosterFallback from './PosterFallback';
import { pickPlaybackTier, browserCapabilities } from '../../utils/browserCapabilities';

/**
 * VodDetail — single movie OR single series detail page. Triggered
 * from VodBrowse by clicking a poster. Shows:
 *
 *   - Backdrop hero with poster + title + year + rating + cast
 *   - Overview synopsis (canonical from TMDB when enriched)
 *   - Sources strip — every account that carries this title
 *   - For SERIES: lazy-loaded seasons + episodes (per-season tabs)
 *   - Big PLAY button that streams via /api/vod-stream/...
 *
 * Player is intentionally a vanilla HTML5 <video> element. VOD
 * files are mp4/mkv, served via the proxy with range support, and
 * the browser handles seeking + audio tracks natively. No mpegts.js
 * needed here (unlike live MPEG-TS).
 */

// Tiny "external link" arrow appended to the IMDb / Wikipedia /
// YouTube chips. Signals that the anchor opens off-site.
const ArrowOutSvg = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-2.5 h-2.5 opacity-70">
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M17 7H8M17 7V16" />
  </svg>
);

// Strip protocol + trailing slashes from a source URL/name so the host
// reads cleanly as the headline. "http://lordstreams.live/" →
// "lordstreams.live"; nicknames pass through untouched.
const hostOf = (raw) => String(raw || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

// Container-extension playability. Chrome's <video> element handles
// mp4 universally (H.264/AAC); mkv plays for H.264-in-mkv but fails on
// HEVC; ts (MPEG transport stream) almost never plays natively — it
// silently shows the poster forever, which is what the user keeps
// hitting on CAM-rip movies that ship as .ts. Used both to pick a
// sensible default source and to badge sources visually so the user
// can pick a different account when their default fails.
const CONTAINER_PLAYABILITY = {
  mp4: { rank: 0, label: 'MP4', tone: 'ok' },
  m4v: { rank: 1, label: 'M4V', tone: 'ok' },
  mkv: { rank: 2, label: 'MKV', tone: 'mixed' },
  webm: { rank: 3, label: 'WEBM', tone: 'ok' },
  mov: { rank: 4, label: 'MOV', tone: 'mixed' },
  avi: { rank: 5, label: 'AVI', tone: 'bad' },
  ts: { rank: 6, label: 'TS', tone: 'bad' },
  mpg: { rank: 7, label: 'MPG', tone: 'bad' },
  flv: { rank: 8, label: 'FLV', tone: 'bad' }
};

/**
 * QualityMenu — small dropdown for the Now-Playing bar. Lives outside
 * the player so the controls don't block the picture.
 *
 * "Source (native)" returns to the picker's natural choice (direct or
 * `-c copy` transmux). Any other choice forces a server-side ffmpeg
 * re-encode at that height. Heights above the source are hidden — no
 * point upscaling, just costs CPU.
 */
const QualityMenu = ({ sourceHeight, qualityHeight, onChange }) => {
  const [open, setOpen] = useState(false);
  // Click-outside handler — gives the menu the usual dismiss-on-blur
  // behavior without pulling in a popover library.
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-slate-700/60 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-300 hover:text-cyan-200 transition"
        title="Pick output quality — non-Source options force a server re-encode"
      >
        Quality
        <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 min-w-[160px] rounded-md bg-slate-950/95 ring-1 ring-slate-700/80 shadow-xl overflow-hidden z-10">
          {[null, 1080, 720, 480].map((h) => {
            if (h && sourceHeight && h > sourceHeight) return null;
            const isActive = (qualityHeight || null) === h;
            const label = h === null ? 'Source (native)' : `${h}p (re-encode)`;
            return (
              <button
                key={String(h)}
                type="button"
                onClick={() => { setOpen(false); onChange(h); }}
                className={`w-full text-left px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition ${
                  isActive
                    ? 'bg-cyan-500/20 text-cyan-100'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Map a pixel height to the conventional resolution label that
// matches detectVideoQuality()'s buckets. Used by the player's
// resolution chip — keeps the same vocabulary the live tile uses
// ("4K" / "2K" / "1080p" / "720p" / "480p") for cross-feature
// consistency.
const labelForHeight = (h) => {
  if (!h) return '';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '2K';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  return `${h}p`;
};

// Detect platform for the VLC deep-link handoff. iOS/Android get
// native URL schemes; desktop falls back to a copy-to-clipboard
// because there's no universal "open VLC with URL" affordance from
// a browser.
const detectPlatform = () => {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'desktop';
};

/**
 * Hand a stream URL off to the user's external VLC.
 *
 * Schemes (verified working in 2026):
 *   iOS:     vlc-x-callback://x-callback-url/stream?url=<encoded>
 *            (Infuse: infuse://x-callback-url/play?url=<encoded>)
 *   Android: intent://<url>#Intent;package=org.videolan.vlc;type=video/*;end
 *   Desktop: there's no universal scheme — best UX is copy-to-clipboard
 *            with a toast, since users on macOS/Win typically have VLC
 *            already and can paste into "Open Network Stream".
 *
 * On every platform the URL we hand off is our proxy URL (so auth /
 * Stalker headers / range support all keep flowing through us) — NEVER
 * the raw upstream URL.
 */
const openInVlc = (proxyUrl) => {
  if (!proxyUrl) return;
  const platform = detectPlatform();
  if (platform === 'ios') {
    window.location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(proxyUrl)}`;
    return;
  }
  if (platform === 'android') {
    window.location.href = `intent:${proxyUrl}#Intent;package=org.videolan.vlc;type=video/*;end`;
    return;
  }
  // Desktop: clipboard + minimal feedback. We can't reliably launch
  // VLC from a browser context without a custom protocol handler the
  // user has registered; copy-paste is the universally-known path.
  try {
    navigator.clipboard.writeText(proxyUrl).then(
      () => {
        // eslint-disable-next-line no-alert
        alert('Stream URL copied. Open VLC → File → Open Network → paste.');
      },
      () => {
        // eslint-disable-next-line no-alert
        prompt('Copy this URL into VLC:', proxyUrl);
      }
    );
  } catch (_) {
    // eslint-disable-next-line no-alert
    prompt('Copy this URL into VLC:', proxyUrl);
  }
};

// Absolute URL builder for the "Open in VLC" handoff. The frontend
// uses relative URLs for the <video> element (cross-origin autoplay
// fights, see streamBase.js), but VLC handlers want a fully-qualified
// URL it can paste into a network stream.
const buildAbsoluteUrl = (relativePath) => {
  if (!relativePath) return null;
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  try {
    return new URL(relativePath, window.location.origin).toString();
  } catch (_) { return relativePath; }
};

// Short human-readable label for the chip rendered on the player.
// Examples:
//   direct       → "DIRECT"
//   copy         → "TRANSMUX TS→MP4" (or just "TRANSMUX" if no probe)
//   audio_only   → "AUDIO RE-ENCODE"
//   video_only   → "VIDEO RE-ENCODE"
//   full         → "TRANSCODE HEVC→H264"
const formatTierLabel = ({ tier, probe }) => {
  switch (tier) {
    case 'direct':
      return 'DIRECT';
    case 'copy':
      return probe?.container
        ? `TRANSMUX ${String(probe.container).toUpperCase()}→MP4`
        : 'TRANSMUX';
    case 'audio_only':
      return probe?.acodec ? `AUDIO RE-ENC ${String(probe.acodec).toUpperCase()}→AAC` : 'AUDIO RE-ENC';
    case 'video_only':
      return probe?.vcodec ? `VIDEO RE-ENC ${String(probe.vcodec).toUpperCase()}→H264` : 'VIDEO RE-ENC';
    case 'full':
      return 'TRANSCODE';
    default:
      return null;
  }
};

const pickPlayableSource = (sources) => {
  if (!sources || !sources.length) return null;
  // Sort by playability rank (lower is better), keep added_at order as
  // the tiebreaker by using a stable sort and not touching ordering
  // within the same rank.
  const scored = sources.map((s, i) => {
    const ext = String(s.container_extension || '').toLowerCase();
    const rank = CONTAINER_PLAYABILITY[ext]?.rank ?? 99;
    return { s, i, rank };
  });
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return scored[0].s;
};

// Type-color mapping — matches the rest of the app (multi-view rail,
// channel picker rail, etc.). xtream=sky, stalker=violet, m3u=emerald.
const TYPE_THEME = {
  xtream:  { dot: 'bg-sky-400',     rail: 'from-sky-400 to-blue-500',         label: 'XTREAM'  },
  stalker: { dot: 'bg-violet-400',  rail: 'from-violet-400 to-purple-500',    label: 'STALKER' },
  m3u:     { dot: 'bg-emerald-400', rail: 'from-emerald-400 to-teal-500',     label: 'M3U'     },
  default: { dot: 'bg-slate-500',   rail: 'from-slate-500 to-slate-600',      label: 'SOURCE'  }
};

/**
 * SourceCard — replaces the old single-line truncated pill. Shows the
 * three pieces of information needed to disambiguate one IPTV account
 * from another on the same upstream host:
 *
 *   1. Host — large mono headline ("lordstreams.live")
 *   2. Account — username pill underneath ("sanders13")
 *   3. Type badge — color-coded rail (xtream / stalker / m3u)
 *
 * Plus optional health signals when the source flags itself as dead:
 *   - Inactive/expired/error account_status → rose ring + tag
 *   - The active source gets a cyan rail + a pulsing "● PLAYING" chip.
 *
 * Sized for a 2-column grid on the detail page (min 220px wide), so a
 * dozen+ sources stack cleanly without wrapping into a meaningless pill
 * jungle.
 */
const SourceCard = ({ source, active, onClick, index }) => {
  const type = (source.source_type || '').toLowerCase();
  const theme = TYPE_THEME[type] || TYPE_THEME.default;
  const host = source.source_nickname || hostOf(source.source_name) || 'unknown';
  const account = source.source_username || null;
  const status = (source.source_account_status || '').toLowerCase();
  const isUnhealthy = status && !['active', 'ok', '', 'good'].includes(status);
  const ext = String(source.container_extension || '').toLowerCase();
  const containerInfo = CONTAINER_PLAYABILITY[ext] || null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${host}${account ? ` · ${account}` : ''}${status ? ` · ${status}` : ''}`}
      className={`group/src relative flex items-stretch gap-2.5 overflow-hidden rounded-lg border text-left transition ${
        active
          ? 'border-cyan-500/40 bg-cyan-500/[0.06] shadow-[0_0_0_1px_rgba(34,211,238,0.15)_inset,0_4px_18px_-8px_rgba(34,211,238,0.4)]'
          : isUnhealthy
          ? 'border-rose-500/25 bg-slate-900/40 hover:border-rose-500/40 hover:bg-rose-500/[0.04]'
          : 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/70'
      }`}
    >
      {/* Color rail — same idiom as MultiViewRail / FavoritesStrip / etc. */}
      <span
        aria-hidden
        className={`relative w-[3px] flex-shrink-0 self-stretch bg-gradient-to-b ${
          active ? 'from-cyan-300 to-cyan-500 shadow-[0_0_10px_rgba(34,211,238,0.5)]' : theme.rail + ' opacity-70 group-hover/src:opacity-100'
        } transition`}
      >
        {active && (
          <span className="absolute -top-0.5 -left-0.5 -right-0.5 h-1.5 rounded-full bg-cyan-300 animate-pulse" />
        )}
      </span>

      {/* Body */}
      <div className="flex-1 min-w-0 py-2 pr-2.5">
        {/* Top row — host + type pill + active indicator */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`flex-shrink-0 inline-flex items-center px-1.5 py-px rounded-sm font-mono text-[8.5px] tracking-[0.12em] ring-1 ${
            active ? 'ring-cyan-500/40 text-cyan-200 bg-cyan-500/10'
                   : 'ring-slate-700/60 text-slate-400 bg-slate-900/60'
          }`}>
            {theme.label}
          </span>
          <span
            className={`flex-1 min-w-0 truncate font-mono text-[12px] tracking-tight leading-tight ${
              active ? 'text-cyan-100' : 'text-slate-100'
            }`}
          >
            {host}
          </span>
          {active && (
            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1 py-px rounded-sm font-mono text-[8.5px] uppercase tracking-[0.14em] text-cyan-300">
              <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
              playing
            </span>
          )}
        </div>

        {/* Bottom row — account chip + index + health tag */}
        <div className="mt-1 flex items-center gap-1.5 min-w-0">
          {account ? (
            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm font-mono text-[10px] text-slate-400 bg-slate-900/60 ring-1 ring-slate-800">
              <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="8" r="4" />
                <path d="M4 22a8 8 0 0116 0" />
              </svg>
              <span className="truncate max-w-[140px]">{account}</span>
            </span>
          ) : (
            <span className="text-[10px] font-mono text-slate-600">no account</span>
          )}
          <span className="flex-shrink-0 text-[9px] font-mono text-slate-600 tabular-nums">
            #{(index ?? 0) + 1}
          </span>
          {containerInfo && (
            <span
              className={`flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-[0.12em] ring-1 ${
                containerInfo.tone === 'ok'
                  ? 'text-emerald-300 bg-emerald-500/[0.08] ring-emerald-500/25'
                  : containerInfo.tone === 'mixed'
                  ? 'text-amber-300 bg-amber-500/[0.08] ring-amber-500/25'
                  : 'text-rose-300 bg-rose-500/[0.08] ring-rose-500/25'
              }`}
              title={
                containerInfo.tone === 'bad'
                  ? `.${ext} repackaged server-side via ffmpeg — plays, but mp4/mkv is lighter on the backend`
                  : containerInfo.tone === 'mixed'
                  ? `.${ext} plays for common codecs; HEVC/AC-3 trigger a backend transcode`
                  : `.${ext} plays natively in browser`
              }
            >
              {containerInfo.label}
            </span>
          )}
          {isUnhealthy && (
            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-[0.12em] text-rose-300 bg-rose-500/[0.08] ring-1 ring-rose-500/25" title={`Account status: ${status}`}>
              {status}
            </span>
          )}
        </div>
      </div>
    </button>
  );
};

/**
 * StreamPlayer — now a thin wrapper around <video>. Everything weird
 * about codecs/containers is solved server-side by the transmux
 * pipeline (see backend/services/ffmpegService.js + the tier picker
 * in utils/browserCapabilities.js). By the time a URL gets here it's
 * either:
 *   - a direct passthrough of a browser-native mp4/mkv-h264, OR
 *   - a fragmented MP4 stream from /api/vod-stream/transmux/...
 * Both play via plain <video src=...> with native seek + controls.
 * `tierLabel` is just a human-readable string from the picker so the
 * UI can surface "Transmuxing (TS → fMP4)" etc. when the user wants
 * to know what's happening.
 */
const StreamPlayer = ({ src, poster, onVlcLink, onHeightChange }) => {
  const videoRef = useRef(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    setLoadError(null);
    if (onHeightChange) onHeightChange(null);
    if (!videoRef.current || !src) return undefined;
    // The user's Play-button click is a valid gesture for autoplay,
    // but the element doesn't always reach .play() on its own — calling
    // it here removes the need for a second click on native controls.
    videoRef.current.src = src;
    const p = videoRef.current.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* autoplay blocked — user can click */ });
    }
    const onMeta = () => {
      const h = videoRef.current?.videoHeight;
      if (h && onHeightChange) onHeightChange(h);
    };
    videoRef.current.addEventListener('loadedmetadata', onMeta);
    videoRef.current.addEventListener('resize', onMeta);
    const el = videoRef.current;
    return () => {
      try {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('resize', onMeta);
        el.src = '';
      } catch (_) {}
    };
    // onHeightChange intentionally not in deps — it's a stable
    // callback from the parent and including it would re-mount the
    // <video> every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Surface real media errors so the user knows when something failed
  // (vs the previous silent-poster behavior with unsupported codecs).
  const handleVideoError = () => {
    const code = videoRef.current?.error?.code;
    const map = {
      1: 'Playback aborted',
      2: 'Network error fetching stream',
      3: 'Decode error (codec issue)',
      4: 'Source not supported — try a different account or use VLC'
    };
    setLoadError(map[code] || `Playback error (code ${code || '?'})`);
  };

  if (!src) return null;
  return (
    <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-slate-800 bg-black">
      <video
        ref={videoRef}
        poster={poster || undefined}
        controls
        playsInline
        preload="metadata"
        className="w-full h-full"
        onError={handleVideoError}
      />
      {loadError && (
        <div className="absolute inset-x-0 bottom-12 mx-4 rounded-md bg-rose-950/85 ring-1 ring-rose-500/40 px-3 py-2 backdrop-blur-sm flex items-start gap-3">
          <p className="flex-1 font-mono text-[11px] text-rose-200">{loadError}</p>
          {onVlcLink && (
            <button
              type="button"
              onClick={onVlcLink}
              className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 ring-1 ring-rose-400/40 text-rose-100"
            >
              Open in VLC
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const SeasonTabs = ({ seasons, activeSeason, onPickSeason }) => (
  <div className="flex items-center gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
    {seasons.map((s) => (
      <button
        key={s.season_number}
        type="button"
        onClick={() => onPickSeason(s.season_number)}
        className={`flex-shrink-0 h-8 px-3 rounded-md border font-mono text-[11px] font-bold uppercase tracking-[0.16em] transition ${
          activeSeason === s.season_number
            ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
            : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200 hover:border-slate-700'
        }`}
      >
        S{String(s.season_number).padStart(2, '0')}
        <span className="ml-1.5 font-normal text-slate-500 tabular-nums">{s.episodes.length}</span>
      </button>
    ))}
  </div>
);

const EpisodeRow = ({ episode, onPlay, playing }) => (
  <button
    type="button"
    onClick={() => onPlay(episode)}
    className={`group/ep w-full flex items-stretch gap-3 p-2 rounded-md border transition text-left ${
      playing
        ? 'border-cyan-500/40 bg-cyan-500/[0.08]'
        : 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/60'
    }`}
  >
    <div className="flex-shrink-0 w-32 aspect-video rounded overflow-hidden bg-slate-950 border border-slate-800 relative">
      {episode.still_url ? (
        <img src={episode.still_url} alt="" className="w-full h-full object-cover"
             onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-slate-700">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6">
            <polygon points="10 8 16 12 10 16 10 8" />
          </svg>
        </div>
      )}
      <span className="absolute top-1 left-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] px-1 py-0.5 rounded bg-slate-950/80 text-slate-300">
        E{String(episode.episode_number || 0).padStart(2, '0')}
      </span>
    </div>
    <div className="flex-1 min-w-0 py-0.5">
      <div className="text-[13px] font-semibold text-slate-100 truncate group-hover/ep:text-cyan-200 transition">
        {episode.title || `Episode ${episode.episode_number}`}
      </div>
      {episode.overview && (
        <div className="mt-1 text-[11.5px] text-slate-400 line-clamp-2 leading-relaxed">
          {episode.overview}
        </div>
      )}
      {episode.runtime_secs && (
        <div className="mt-1 font-mono text-[10px] tabular-nums text-slate-600">
          {Math.round(episode.runtime_secs / 60)} min
        </div>
      )}
    </div>
  </button>
);

const VodDetail = ({ kind, id, onBack, onGenre }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [activeSourceId, setActiveSourceId] = useState(null);
  // Set when the user explicitly picks a source from the SourceCard
  // list. Tells the self-correcting effect to back off — otherwise it
  // snaps back to a .mp4 the moment the user tries to test a .ts/.flv
  // source, and they can never reach the mpegts.js path.
  const userPickedSourceRef = useRef(false);
  const [playingEpisodeStreamId, setPlayingEpisodeStreamId] = useState(null);
  const [streamSrc, setStreamSrc] = useState(null);
  // Human-readable label for the current playback tier — shown as a
  // small chip on the player so the user can see "transmux: ts → fMP4"
  // without opening devtools. Set by handlePlayMovie/Episode.
  const [streamTier, setStreamTier] = useState(null);
  const [streamVlcUrl, setStreamVlcUrl] = useState(null);
  // Width/height from the most recent probe — used to populate the
  // resolution chip on the player and the quality-selector menu (no
  // point offering 1080p if the source itself is 480p).
  const [streamProbe, setStreamProbe] = useState(null);
  // Forced output height (null = source). When set, the next call to
  // startPlayback wires it into the transmux URL → ffmpeg scales the
  // re-encode down to that height.
  const [qualityHeight, setQualityHeight] = useState(null);
  // Live videoHeight from the <video> element — the most accurate
  // signal of what's actually rendering. Falls back to the probe's
  // source height before metadata loads.
  const [streamPlayerHeight, setStreamPlayerHeight] = useState(null);
  const [trailerYtId, setTrailerYtId] = useState(null);
  // True while we're firing an on-demand enrichment for this row.
  const [enriching, setEnriching] = useState(false);
  const enrichTriedRef = useRef(false);
  // Player area — used to scroll back to it when playback starts so
  // a user scrolled down the episode list isn't left wondering
  // whether their click did anything.
  const playerSectionRef = useRef(null);
  // Series-only state
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [activeSeason, setActiveSeason] = useState(null);

  // Collapse/expand the per-source list. Default collapsed so the
  // "Big Cats 24/7 has 13 sources" case doesn't push the episode list
  // way off-screen; the user only needs the list when their active
  // source dies or they want to try a different account.
  const [sourcesExpanded, setSourcesExpanded] = useState(false);

  // Initial fetch — single canonical row + sources list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    enrichTriedRef.current = false;
    // Each new movie/series page starts fresh — let the auto-picker
    // pick a playable default until the user overrides.
    userPickedSourceRef.current = false;
    const fetcher = kind === 'movie' ? vodService.getMovie : vodService.getSeries;
    fetcher(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Prefer a browser-playable container for the default source
        // (.mp4 > .mkv > everything else). Picking the first row by
        // added_at means we frequently land on a .ts CAM rip that
        // Chrome's <video> can't decode — the user sees the poster at
        // 0:00 and assumes the player is broken.
        const sources = d.sources || [];
        const playable = pickPlayableSource(sources);
        if (playable) setActiveSourceId(playable.source_id);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.response?.data?.error || e.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind, id]);

  // Self-correcting source pick: when the data loads (or changes
  // after enrichment), make sure the active source isn't one Chrome
  // can't decode — if it is, and there's a playable alternative,
  // switch to it. Belt-and-suspenders for the initial pick above,
  // since React fast-refresh and component re-mounts can leave a
  // stale activeSourceId pointing at a .ts/.avi source.
  useEffect(() => {
    if (!data) return;
    // Once the user has manually picked a source, stop second-guessing
    // them — even if it's a .ts that we'd normally avoid. mpegts.js
    // will handle it. Without this guard the user can never reach a
    // .ts source because we snap right back to .mp4 on every click.
    if (userPickedSourceRef.current) return;
    const sources = data.sources || [];
    if (!sources.length) return;
    const current = sources.find((s) => s.source_id === activeSourceId);
    if (current) {
      const ext = String(current.container_extension || '').toLowerCase();
      const info = CONTAINER_PLAYABILITY[ext];
      // Only override when the active source is EXPLICITLY known to
      // need software demuxing (.ts/.avi/.mpg/.flv = "bad" tone).
      // Even though mpegts.js handles .ts, .mp4 is cheaper at startup
      // so it's still the better default. Unknown / mixed pass through.
      if (!info || info.tone !== 'bad') return;
    }
    const playable = pickPlayableSource(sources);
    if (playable && playable.source_id !== activeSourceId) {
      setActiveSourceId(playable.source_id);
    }
  }, [data, activeSourceId]);

  // On-demand enrichment: when the detail loads and the row hasn't
  // been enriched yet, kick off the lookup immediately instead of
  // making the user wait for the background worker's turn. Re-fetch
  // the detail once enrichment completes to swap in the rich data.
  useEffect(() => {
    if (loading || !data) return undefined;
    const row = (kind === 'movie' ? data.movie : data.series) || {};
    if (row.enriched_at) return undefined;
    if (enrichTriedRef.current) return undefined;
    enrichTriedRef.current = true;
    let cancelled = false;
    setEnriching(true);
    const enricher = kind === 'movie' ? vodService.enrichMovie : vodService.enrichSeries;
    enricher(id)
      .then((res) => {
        if (cancelled || !res?.ok) {
          if (!cancelled) setEnriching(false);
          return;
        }
        // Re-fetch the detail to get the enriched fields.
        const fetcher = kind === 'movie' ? vodService.getMovie : vodService.getSeries;
        return fetcher(id).then((d2) => {
          if (cancelled) return;
          setData(d2);
          setEnriching(false);
        });
      })
      .catch(() => { if (!cancelled) setEnriching(false); });
    return () => { cancelled = true; };
  }, [loading, data, kind, id]);

  // Scroll-back-to-player when playback starts. Without this, a user
  // scrolled down into the episode list clicks Play and the video
  // mounts at the top of the page with no visual feedback at the
  // click point — they have no idea anything happened. This is the
  // pattern Plex / Jellyfin use; Netflix-style modal takeovers are
  // a larger UX shift we can layer in later if needed.
  useEffect(() => {
    if (!streamSrc && !trailerYtId) return;
    if (!playerSectionRef.current) return;
    playerSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [streamSrc, trailerYtId]);

  // Series episode lazy-fetch when the active source changes.
  useEffect(() => {
    if (kind !== 'series' || !data || !activeSourceId) return undefined;
    let cancelled = false;
    setEpisodesLoading(true);
    setEpisodesError(null);
    vodService.getSeriesEpisodes(id, { sourceId: activeSourceId })
      .then((d) => {
        if (cancelled) return;
        const list = d.seasons || [];
        setSeasons(list);
        if (list.length > 0) setActiveSeason(list[0].season_number);
        setEpisodesLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setEpisodesError(e.response?.data?.error || e.message);
        setEpisodesLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind, id, activeSourceId, data]);

  const activeSource = useMemo(() => {
    if (!data) return null;
    return (data.sources || []).find((s) => s.source_id === activeSourceId) || (data.sources || [])[0] || null;
  }, [data, activeSourceId]);

  // Resolve the playing episode object (with its season number) so
  // the "Now Playing" pill can show S01E03 · Episode Title context.
  const playingEpisode = useMemo(() => {
    if (!playingEpisodeStreamId) return null;
    for (const season of seasons) {
      const ep = (season.episodes || []).find((e) => e.episode_stream_id === playingEpisodeStreamId);
      if (ep) return { ...ep, seasonNumber: season.season_number };
    }
    return null;
  }, [playingEpisodeStreamId, seasons]);

  /**
   * Resolve a playback URL through the probe → tier-pick flow.
   *
   * Three states drive the player:
   *   - streamSrc    — the URL <video> loads (direct or transmux)
   *   - streamTier   — short label rendered as a chip on the player
   *   - streamVlcUrl — absolute proxy URL handed to "Open in VLC"
   *                    when playback fails (or via an explicit button)
   *
   * Probing is fire-and-forget from the caller's perspective: while it
   * runs we optimistically set the direct URL so the user sees PLAY
   * react immediately, then upgrade to the transmux URL once the
   * probe + tier-pick complete. For .mp4-with-h264 (the 60% case)
   * the probe lands on `direct` and nothing changes.
   */
  // overrideHeight: when provided, takes precedence over the
  // `qualityHeight` state — used by handleQualityChange to avoid
  // reading its own stale closure right after setQualityHeight(...).
  const startPlayback = async (kindLocal, streamId, containerExt, overrideHeight) => {
    if (!streamId) return;
    setTrailerYtId(null);
    const directBuilder = kindLocal === 'movie'
      ? vodService.buildMovieStreamUrl
      : vodService.buildEpisodeStreamUrl;

    // Optimistic direct mount only when the container is plausibly
    // browser-native given THIS browser's capabilities. mp4/m4v/mov
    // are universal; mkv only works on Chrome. For anything else (.ts
    // / .avi / unknown) we wait for the probe before setting src —
    // otherwise the <video> hits a decode error and flashes a red
    // overlay before the probe upgrades the URL.
    const ext = String(containerExt || '').toLowerCase();
    const caps = browserCapabilities();
    const canTryDirect = ext === 'mp4' || ext === 'm4v' || ext === 'mov' ||
                         (ext === 'mkv' && caps.canMkv);
    if (canTryDirect) {
      setStreamSrc(directBuilder(streamId));
      setStreamTier(null);
    } else {
      // Clear stream + show a soft "probing" label so the player area
      // doesn't disappear (jarring), but no video element mounts yet.
      setStreamSrc(null);
      setStreamTier('PROBING…');
    }
    setStreamVlcUrl(buildAbsoluteUrl(directBuilder(streamId)));

    try {
      // overrideHeight defaults to undefined; treat that as "use the
      // current state". null is a meaningful caller intent ("Source —
      // no forced height") and must override the state.
      const effectiveHeight = overrideHeight === undefined ? qualityHeight : overrideHeight;
      const decision = await vodService.buildPlaybackUrl(
        kindLocal,
        streamId,
        containerExt,
        pickPlaybackTier,
        { height: effectiveHeight || 0 }
      );
      setStreamSrc(decision.url);
      setStreamTier(formatTierLabel(decision));
      setStreamProbe(decision.probe || null);
      setStreamVlcUrl(buildAbsoluteUrl(directBuilder(streamId)));
    } catch (e) {
      // Probe failed — fall back to direct so something plays, and
      // let the <video> surface its own error if the codec doesn't
      // work.
      setStreamSrc(directBuilder(streamId));
      setStreamTier('DIRECT (probe failed)');
      setStreamProbe(null);
    }
  };

  // Quality switch — user picked a different output height. Track
  // current playing (movie or episode) and rebuild the playback URL.
  // We pass newHeight through to startPlayback as the override so it
  // doesn't read the stale `qualityHeight` state from its closure.
  const handleQualityChange = (newHeight) => {
    setQualityHeight(newHeight);
    if (kind === 'movie' && activeSource) {
      startPlayback('movie', activeSource.movie_stream_id, activeSource.container_extension, newHeight);
    } else if (kind === 'series' && playingEpisode) {
      startPlayback('episode', playingEpisode.episode_stream_id, playingEpisode.container_extension, newHeight);
    }
  };

  // Reset quality override when the user navigates between movies or
  // picks a different source/episode — the previous override may not
  // make sense for the new source (different resolution).
  useEffect(() => { setQualityHeight(null); }, [id, kind]);

  const handlePlayMovie = () => {
    if (!activeSource) return;
    startPlayback('movie', activeSource.movie_stream_id, activeSource.container_extension);
  };

  // Mid-playback source switch: when the user is already watching and
  // picks a different account from the SourceCard list, rerun the
  // probe + tier pick for the new source. Without this the URL stays
  // pinned to whatever source was active at the initial PLAY click.
  useEffect(() => {
    if (kind !== 'movie' || !streamSrc || !activeSource) return;
    startPlayback('movie', activeSource.movie_stream_id, activeSource.container_extension);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource?.movie_stream_id]);

  const handlePlayEpisode = (episode) => {
    if (!episode.episode_stream_id) return;
    setPlayingEpisodeStreamId(episode.episode_stream_id);
    startPlayback('episode', episode.episode_stream_id, episode.container_extension);
  };

  if (loading) {
    return (
      <div className="px-6 py-20 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600">
        Loading {kind}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-6 py-10">
        <div className="px-4 py-3 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 font-mono text-[12px]">
          {error}
        </div>
      </div>
    );
  }
  if (!data) return null;

  // Defensive: an older API response or unenriched-with-no-sources
  // path could leave .movie/.series unset. Falling back to {} keeps
  // optional chain reads (row.backdrop_url, row.genres, …) from
  // crashing the whole page.
  const row = (kind === 'movie' ? data.movie : data.series) || {};
  const sources = data.sources || [];
  const activeSeasonRow = seasons.find((s) => s.season_number === activeSeason) || null;

  return (
    <div className="relative">
      {/* Backdrop hero */}
      {row.backdrop_url && (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-72 pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(2,6,23,0.4) 0%, rgba(2,6,23,1) 90%), url(${row.backdrop_url})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
      )}

      <div className="relative px-6 py-6 max-w-[1200px] mx-auto">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-slate-400 hover:text-slate-100 transition"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to library
        </button>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Poster — fallback layered BEHIND the <img> so it shows
              through when the image is missing OR 404s mid-load. Same
              designed empty state used in the grid for consistency. */}
          <div className="flex-shrink-0 w-40 md:w-56">
            <div className="relative w-full aspect-[2/3] rounded-lg overflow-hidden border border-slate-800 shadow-lg">
              <PosterFallback
                kind={kind}
                title={row.title}
                year={row.year}
              />
              {row.poster_url && (
                <img
                  src={row.poster_url}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
            </div>
          </div>

          {/* Metadata */}
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500 mb-1 flex items-center gap-2">
                <span>{kind === 'movie' ? 'Movie' : 'TV Series'}</span>
                {row.enriched_at && <span className="text-emerald-400">· enriched</span>}
                {enriching && !row.enriched_at && (
                  <span className="text-cyan-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    Looking up metadata…
                  </span>
                )}
              </div>
              <h1 className="text-3xl font-bold text-slate-100 leading-tight">{row.title}</h1>
              <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] tabular-nums text-slate-400 flex-wrap">
                {row.year && <span>{row.year}</span>}
                {Number(row.runtime_secs) > 0 && (
                  <>
                    <span className="text-slate-700">·</span>
                    <span>{Math.round(Number(row.runtime_secs) / 60)} min</span>
                  </>
                )}
                {Number(row.rating_tmdb) > 0 && (
                  <>
                    <span className="text-slate-700">·</span>
                    <span className="text-amber-300">★ {Number(row.rating_tmdb).toFixed(1)}</span>
                  </>
                )}
              </div>
            </div>

            {/* Classification tags. Canonical genres (from enrichment)
                when we have them; otherwise the provider's own category
                bucket as a fallback, so the long tail of unenriched
                titles still shows how it's classified. The fallback is
                styled muted to read as the provider's label, not a
                canonical genre. */}
            {(() => {
              const genres = Array.isArray(row.genres) ? row.genres : [];
              const cats = Array.isArray(data.categories) ? data.categories : [];
              if (genres.length === 0 && cats.length === 0) return null;
              return (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {genres.slice(0, 6).map((g) => (
                    <button
                      key={`g-${g}`}
                      type="button"
                      onClick={() => onGenre && onGenre(g)}
                      title={`Browse ${g} ${kind === 'movie' ? 'movies' : 'series'}`}
                      className="inline-flex items-center h-6 px-2.5 rounded-md border border-slate-800 bg-slate-900/50 text-slate-300 hover:border-cyan-500/60 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors cursor-pointer font-mono text-[10px] uppercase tracking-[0.16em]"
                    >
                      {g}
                    </button>
                  ))}
                  {genres.length === 0 && cats.slice(0, 4).map((c) => (
                    <span
                      key={`c-${c}`}
                      title="Provider category (no canonical genre yet)"
                      className="inline-flex items-center h-6 px-2.5 rounded-md border border-slate-800/70 bg-slate-900/30 text-slate-500 font-mono text-[10px] tracking-[0.12em]"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              );
            })()}

            {!row.overview && !enriching && !row.enriched_at && (
              <p className="text-[12px] text-slate-500 italic max-w-3xl">
                No description available — this title isn't on IMDb yet.
              </p>
            )}

            {row.overview && (
              <p className="text-[13px] text-slate-300 leading-relaxed max-w-3xl">
                {row.overview}
              </p>
            )}

            {/* Trailer thumbnail tile — Plex-style visual entry point.
                Clickable, opens the inline trailer player. Sits between
                the description and the credits so it's a natural eye-
                stop on the page. */}
            {row.trailer_youtube_id && !trailerYtId && (
              <button
                type="button"
                onClick={() => { setStreamSrc(null); setTrailerYtId(row.trailer_youtube_id); }}
                className="group/trailer relative block w-full max-w-[280px] aspect-video rounded-md overflow-hidden border border-slate-800 hover:border-cyan-500/50 focus:outline-none focus:border-cyan-500/60 transition shadow-md"
                title="Watch trailer"
              >
                <img
                  src={`https://img.youtube.com/vi/${row.trailer_youtube_id}/mqdefault.jpg`}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/30 to-slate-950/10 group-hover/trailer:from-slate-950/60 transition" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="w-12 h-12 rounded-full bg-cyan-500/95 flex items-center justify-center shadow-[0_0_24px_-4px_rgba(34,211,238,0.8)] group-hover/trailer:scale-110 transition">
                    <svg viewBox="0 0 24 24" fill="white" className="w-5 h-5 ml-0.5">
                      <polygon points="6 4 20 12 6 20 6 4" />
                    </svg>
                  </span>
                </div>
                <div className="absolute bottom-0 inset-x-0 px-2.5 py-1.5">
                  <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.22em] text-slate-100">Watch trailer</div>
                </div>
              </button>
            )}

            {/* Credits — director + cast as person chips with letter
                avatars, modeled on Plex's cast row. The avatar block
                isn't a real photo, just a typographic initial, but it
                gives the chip the right visual weight. */}
            {(row.director || (Array.isArray(row.cast_json) && row.cast_json.length > 0)) && (
              <div className="space-y-2">
                {row.director && (
                  <div>
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-slate-600 mb-1.5">Director</div>
                    <span className="inline-flex items-center gap-2 h-7 pl-1 pr-3 rounded-full border border-slate-800 bg-slate-900/60 text-[11.5px] text-slate-200">
                      <span className="w-5 h-5 rounded-full bg-slate-800 text-[10px] font-bold text-slate-400 flex items-center justify-center uppercase">
                        {row.director.slice(0, 1)}
                      </span>
                      {row.director}
                    </span>
                  </div>
                )}
                {Array.isArray(row.cast_json) && row.cast_json.length > 0 && (
                  <div>
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-slate-600 mb-1.5">
                      Cast{row.cast_json.length > 12 ? ` · ${row.cast_json.length}` : ''}
                    </div>
                    {/* Two-line person chips when TVMaze cast (with photos +
                        character names) is available, simple name chips when
                        only Cinemeta name data is present. Same chip shell
                        either way so the row reads consistently. */}
                    <div className="flex items-start gap-2 flex-wrap">
                      {row.cast_json.slice(0, 12).map((c, i) => (
                        <span
                          key={`${c.name}-${i}`}
                          className="group/cast inline-flex items-center gap-2 h-12 pl-1 pr-3 rounded-full border border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900 transition"
                          title={c.character ? `${c.name} as ${c.character}` : c.name}
                        >
                          {c.image ? (
                            <img
                              src={c.image}
                              alt=""
                              className="w-10 h-10 rounded-full object-cover bg-slate-800 ring-1 ring-slate-700"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              loading="lazy"
                            />
                          ) : (
                            <span className="w-10 h-10 rounded-full bg-slate-800 text-[14px] font-bold text-slate-400 flex items-center justify-center uppercase ring-1 ring-slate-700">
                              {(c.name || '?').slice(0, 1)}
                            </span>
                          )}
                          <span className="flex flex-col leading-tight pr-1 min-w-0">
                            <span className="text-[12px] font-semibold text-slate-100 truncate max-w-[14ch]">
                              {c.name}
                            </span>
                            {c.character && (
                              <span className="text-[10px] text-slate-500 truncate max-w-[14ch]">
                                {c.character}
                              </span>
                            )}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* External links — IMDb, Wikipedia, YouTube. Anchors with
                target=_blank + noreferrer. The IMDb chip wears its
                amber accent for instant recognition; Wikipedia keeps
                neutral slate; YouTube uses the app's cyan accent. */}
            <div className="space-y-1.5">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-slate-600">More info</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {row.imdb_id && (
                  <a
                    href={`https://www.imdb.com/title/${encodeURIComponent(row.imdb_id)}/`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-amber-500/40 bg-amber-500/[0.08] text-amber-200 hover:bg-amber-500/15 hover:border-amber-400/60 transition font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
                  >
                    IMDb
                    <ArrowOutSvg />
                  </a>
                )}
                <a
                  href={`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(row.title || '')}`}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-slate-800 bg-slate-900/60 text-slate-300 hover:text-slate-100 hover:border-slate-700 transition font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
                >
                  Wikipedia
                  <ArrowOutSvg />
                </a>
                {row.trailer_youtube_id && (
                  <a
                    href={`https://www.youtube.com/watch?v=${encodeURIComponent(row.trailer_youtube_id)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-cyan-500/40 bg-cyan-500/[0.08] text-cyan-200 hover:bg-cyan-500/15 hover:border-cyan-400/60 transition font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
                  >
                    YouTube
                    <ArrowOutSvg />
                  </a>
                )}
              </div>
            </div>

            {/* Source list — collapsed by default. Shows just the
                active source as a single full-width card with a
                "Switch source · N more" toggle. Expanded: full grid
                of every source. Saves screen height when the same
                title is on 10+ sources but keeps everything one click
                away. */}
            {sources.length > 0 && (() => {
              const activeIndex = Math.max(0, sources.findIndex((s) => s.source_id === activeSourceId));
              const activeSrc = sources[activeIndex] || sources[0];
              const moreCount = Math.max(0, sources.length - 1);
              return (
                <div className="pt-2">
                  {/* Section header — always shown */}
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
                      Source
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">·</span>
                    <span className="font-mono text-[14px] tabular-nums text-slate-200">
                      {sources.length}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
                      available
                    </span>
                  </div>

                  {/* Always-visible: the active source */}
                  <SourceCard
                    source={activeSrc}
                    active
                    index={activeIndex}
                    onClick={() => { /* clicking the active card is a no-op */ }}
                  />

                  {/* Expand toggle — collapsed shows "Switch source · 12 more ▾",
                      expanded shows "Hide alternates ▴" */}
                  {moreCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setSourcesExpanded((v) => !v)}
                      className="mt-1.5 w-full flex items-center justify-center gap-2 h-8 px-3 rounded-md border border-dashed border-slate-800 bg-slate-900/30 hover:bg-slate-900/60 hover:border-slate-700 text-slate-500 hover:text-slate-300 font-mono text-[10px] uppercase tracking-[0.18em] transition"
                      aria-expanded={sourcesExpanded}
                    >
                      {sourcesExpanded ? (
                        <>
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                          </svg>
                          Hide alternates
                        </>
                      ) : (
                        <>
                          <span>Switch source</span>
                          <span className="text-slate-700">·</span>
                          <span className="tabular-nums normal-case">{moreCount}</span>
                          <span>more</span>
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </>
                      )}
                    </button>
                  )}

                  {/* Expanded — the rest of the sources in a 2-col grid */}
                  {sourcesExpanded && moreCount > 0 && (
                    <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {sources
                        .map((s, i) => ({ s, i }))
                        .filter(({ i }) => i !== activeIndex)
                        .map(({ s, i }) => (
                          <SourceCard
                            key={s.movie_stream_id || s.series_source_id}
                            source={s}
                            active={false}
                            index={i}
                            onClick={() => {
                              userPickedSourceRef.current = true;
                              setActiveSourceId(s.source_id);
                            }}
                          />
                        ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Actions row — Play + Trailer */}
            {(kind === 'movie' && activeSource) || row.trailer_youtube_id ? (
              <div className="pt-3 flex items-center gap-2 flex-wrap">
                {kind === 'movie' && activeSource && (
                  <button
                    type="button"
                    onClick={() => { setTrailerYtId(null); handlePlayMovie(); }}
                    className="inline-flex items-center gap-2 h-10 px-5 rounded-md border border-emerald-500/50 bg-emerald-500/[0.12] text-emerald-100 hover:bg-emerald-500/20 hover:border-emerald-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_18px_-4px_rgba(16,185,129,0.5)] transition"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <polygon points="6 4 20 12 6 20 6 4" />
                    </svg>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">Play</span>
                  </button>
                )}
                {row.trailer_youtube_id && (
                  <button
                    type="button"
                    onClick={() => { setStreamSrc(null); setTrailerYtId(row.trailer_youtube_id); }}
                    className="inline-flex items-center gap-2 h-10 px-4 rounded-md border border-slate-700 bg-slate-900/60 text-slate-200 hover:text-slate-100 hover:border-slate-600 hover:bg-slate-900 transition"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                      <rect x="3" y="6" width="14" height="12" rx="2" />
                      <path d="M17 9l4-2v10l-4-2" />
                    </svg>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">Trailer</span>
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* Player area — trailer iframe takes precedence when active,
            stream player otherwise. Single shared region so switching
            between Play and Trailer never doubles up the UI. Wrapped
            in a ref so we can scrollIntoView when playback starts. */}
        {(trailerYtId || streamSrc || streamTier) && (
          <div ref={playerSectionRef} className="mt-6 scroll-mt-4">
            {/* Now-Playing pill — gives immediate context after the
                page scrolls. For series, surfaces the active S/E +
                title; for movies + trailers, just the medium. */}
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-cyan-500/40 bg-cyan-500/[0.08] font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-200">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                {trailerYtId ? 'Trailer' : 'Now Playing'}
              </span>
              {streamSrc && playingEpisode && (
                <span className="font-mono text-[11px] tabular-nums text-slate-400">
                  S{String(playingEpisode.seasonNumber || 0).padStart(2, '0')}
                  E{String(playingEpisode.episode_number || 0).padStart(2, '0')}
                  <span className="text-slate-700 mx-1.5">·</span>
                  <span className="text-slate-200 normal-case tracking-normal">
                    {playingEpisode.title || `Episode ${playingEpisode.episode_number}`}
                  </span>
                </span>
              )}
              {streamSrc && kind === 'movie' && (
                <span className="font-mono text-[11px] tabular-nums text-slate-400 normal-case tracking-normal">
                  {row.title}
                </span>
              )}
              {/* Spacer pushes the playback chips to the right edge */}
              <span className="flex-1 min-w-2" />
              {/* Tier + resolution + quality chips — moved out of the
                  player overlay so they don't block the picture. They
                  sit in the Now-Playing bar alongside the title for
                  the same horizontal real estate. */}
              {!trailerYtId && streamTier && (
                <span
                  className="inline-flex items-center h-6 px-2 rounded-md border border-slate-700/60 bg-slate-900/60 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-300"
                  title="Backend playback path"
                >
                  {streamTier}
                </span>
              )}
              {!trailerYtId && (qualityHeight || streamPlayerHeight || streamProbe?.height) && (
                <span
                  className="inline-flex items-center h-6 px-2 rounded-md border border-cyan-500/30 bg-cyan-500/[0.06] font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200"
                  title={qualityHeight ? 'Output forced via server re-encode' : 'Source resolution (native)'}
                >
                  {/* qualityHeight is the user's explicit choice — show
                      it first so a fresh "switch to 480" doesn't flash
                      the previous stream's stale videoHeight while the
                      new ffmpeg pipe spins up. Without a forced height
                      the real <video> videoHeight is the ground truth. */}
                  {labelForHeight(qualityHeight || streamPlayerHeight || streamProbe?.height)}
                  {qualityHeight ? (
                    <span className="ml-1.5 text-amber-300 normal-case tracking-normal">· forced</span>
                  ) : null}
                </span>
              )}
              {!trailerYtId && streamSrc && (
                <QualityMenu
                  sourceHeight={streamProbe?.height || null}
                  qualityHeight={qualityHeight}
                  onChange={handleQualityChange}
                />
              )}
            </div>

            {trailerYtId ? (
              <>
                <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-slate-800 bg-black">
                  <iframe
                    key={trailerYtId}
                    title="Trailer"
                    src={`https://www.youtube-nocookie.com/embed/${trailerYtId}?autoplay=1&rel=0&modestbranding=1`}
                    allow="autoplay; encrypted-media; picture-in-picture"
                    allowFullScreen
                    className="absolute inset-0 w-full h-full"
                    frameBorder="0"
                  />
                </div>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setTrailerYtId(null)}
                    className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 hover:text-slate-200 transition"
                  >
                    Close trailer
                  </button>
                </div>
              </>
            ) : (
              streamSrc ? (
                <StreamPlayer
                  src={streamSrc}
                  poster={row.backdrop_url || row.poster_url}
                  onVlcLink={streamVlcUrl ? () => openInVlc(streamVlcUrl) : null}
                  onHeightChange={setStreamPlayerHeight}
                />
              ) : (
                // Probing phase — soft placeholder so the player area
                // doesn't blink in/out while the probe runs.
                <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-slate-800 bg-black flex items-center justify-center">
                  {(row.backdrop_url || row.poster_url) && (
                    <img src={row.backdrop_url || row.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-30" />
                  )}
                  <div className="relative z-10 flex flex-col items-center gap-3">
                    <div className="w-10 h-10 rounded-full border-2 border-slate-700 border-t-cyan-400 animate-spin" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-400">
                      {streamTier || 'Probing…'}
                    </span>
                  </div>
                </div>
              )
            )}
          </div>
        )}

        {/* SERIES — seasons + episodes */}
        {kind === 'series' && (
          <div className="mt-8 space-y-3">
            <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">
              Episodes
            </h2>
            {episodesLoading ? (
              <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600">
                Loading episodes from provider…
              </div>
            ) : episodesError ? (
              <div className="px-3 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 font-mono text-[11px]">
                {episodesError}
              </div>
            ) : seasons.length === 0 ? (
              <div className="py-6 font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600 text-center">
                No episodes returned by provider
              </div>
            ) : (
              <>
                <SeasonTabs
                  seasons={seasons}
                  activeSeason={activeSeason}
                  onPickSeason={setActiveSeason}
                />
                {activeSeasonRow && (
                  <div className="space-y-2 mt-2">
                    {activeSeasonRow.episodes.map((ep) => (
                      <EpisodeRow
                        key={ep.episode_stream_id || `${ep.episode_number}-${ep.provider_episode_id}`}
                        episode={ep}
                        playing={ep.episode_stream_id === playingEpisodeStreamId}
                        onPlay={handlePlayEpisode}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default VodDetail;
