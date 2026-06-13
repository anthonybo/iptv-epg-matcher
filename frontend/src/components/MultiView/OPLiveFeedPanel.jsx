import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * OPLiveFeedPanel — a realtime X/Twitter hashtag feed that opens BESIDE
 * the multiview video grid (not as an overlay), so you can watch a show
 * and read the live chatter at the same time. Built for following
 * #OPLive (On Patrol: Live) but the tag is editable.
 *
 * Unlike the DrawerShell panels (absolutely positioned overlays), this
 * renders as a real flex sibling of the content column in MultiViewPage,
 * so opening it shrinks the grid instead of covering the videos.
 *
 * Data comes from GET /api/social-feed?tag=… which the backend fetches
 * via a cookie-authenticated scraper and dedupes into Postgres. The
 * panel polls every POLL_MS while open. When the backend reports
 * configured=false (no X_COOKIES), we show a "connect X" hint.
 *
 * Props:
 *   tag          current hashtag (no '#'), owned + persisted by parent
 *   onChangeTag  (tag) => void  — commit an edited tag
 *   width        current panel width in px (owned + persisted by parent)
 *   onResize     (width) => void — commit a dragged width
 *   onClose      () => void
 *   bottomGap    px to reserve at the bottom (live-scores ticker height)
 */

const POLL_MS = 30_000;
const MIN_W = 300;
const MAX_W = 640;

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

// Route X media (video.twimg.com / pbs.twimg.com) through our same-origin
// backend proxy. X's CDNs refuse playback when embedded from a non-x.com
// origin, so pointing <video>/<img> at the raw URL errors ("couldn't
// load"); the proxy relays the bytes from our origin instead.
function mediaSrc(url) {
  if (!url) return url;
  return /\/\/[^/]*twimg\.com\//.test(url)
    ? `/api/social-feed/media?url=${encodeURIComponent(url)}`
    : url;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Deterministic accent color from a handle so avatars are distinguishable.
const AVATAR_COLORS = ['#0ea5e9', '#f43f5e', '#f59e0b', '#10b981', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];
function avatarColor(handle) {
  const s = String(handle || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Linkify @mentions, #hashtags, and t.co/http links inside post text.
function renderText(text) {
  if (!text) return null;
  const parts = text.split(/(\s+)/);
  return parts.map((tok, i) => {
    if (/^https?:\/\/\S+/.test(tok)) {
      return (
        <a key={i} href={tok} target="_blank" rel="noopener noreferrer"
           onClick={(e) => e.stopPropagation()} className="text-cyan-400 hover:underline break-all">
          {tok.replace(/^https?:\/\/(www\.)?/, '').slice(0, 28)}{tok.length > 34 ? '…' : ''}
        </a>
      );
    }
    if (/^[#@][\w]+$/.test(tok)) {
      return <span key={i} className="text-cyan-400">{tok}</span>;
    }
    return <span key={i}>{tok}</span>;
  });
}

// Fullscreen overlay for a single image. Click anywhere or Esc to close.
function ImageLightbox({ url, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-6">
      <img src={mediaSrc(url)} alt="" className="max-w-full max-h-full object-contain" />
      <button onClick={onClose} aria-label="Close"
              className="absolute top-4 right-4 p-2 rounded-md bg-white/10 text-white hover:bg-white/20">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
          <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>,
    document.body
  );
}

const ExpandIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 3H4v4M16 3h4v4M4 17v4h4M20 17v4h-4" />
  </svg>
);

// One media tile. Photos open a fullscreen lightbox; videos play inline
// with native controls (incl. fullscreen) and load only on demand
// (preload=none); GIFs autoplay-loop muted like on X. A hover "expand"
// button gives an explicit fullscreen affordance.
function MediaItem({ m, postUrl, onExpandImage }) {
  const vidRef = useRef(null);
  const [failed, setFailed] = useState(false);

  if (m.type === 'photo') {
    if (failed) return null;
    return (
      <div className="relative rounded-md overflow-hidden bg-slate-800 aspect-video group/media">
        <img
          src={mediaSrc(m.thumb || m.url)} alt="" loading="lazy"
          onError={() => setFailed(true)}
          onClick={() => onExpandImage(m.url || m.thumb)}
          className="w-full h-full object-cover cursor-zoom-in"
        />
        <button
          onClick={(e) => { e.stopPropagation(); onExpandImage(m.url || m.thumb); }}
          aria-label="Expand image" title="Expand"
          className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white/90 opacity-0 group-hover/media:opacity-100 transition hover:bg-black/80"
        >
          {ExpandIcon}
        </button>
      </div>
    );
  }

  // video / animated gif
  if (failed || !m.url) {
    return (
      <a href={postUrl} target="_blank" rel="noopener noreferrer"
         className="flex items-center justify-center rounded-md bg-slate-800/60 aspect-video text-[11px] text-slate-400 hover:text-cyan-300">
        Couldn’t load — open on X ↗
      </a>
    );
  }
  const enterFs = (e) => {
    e.stopPropagation();
    const el = vidRef.current;
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el?.webkitEnterFullscreen) el.webkitEnterFullscreen();
  };
  return (
    <div className="relative rounded-md overflow-hidden bg-black aspect-video group/media">
      <video
        ref={vidRef}
        src={mediaSrc(m.url)}
        poster={m.thumb ? mediaSrc(m.thumb) : undefined}
        controls={!m.gif}
        autoPlay={Boolean(m.gif)}
        loop={Boolean(m.gif)}
        muted={Boolean(m.gif)}
        playsInline
        preload={m.gif ? 'auto' : 'none'}
        onError={() => setFailed(true)}
        className="w-full h-full object-contain bg-black"
      />
      {m.gif && (
        <span className="absolute bottom-1 left-1 px-1 rounded bg-black/70 text-[8px] font-bold tracking-wider text-white/90">GIF</span>
      )}
      <button
        onClick={enterFs}
        aria-label="Fullscreen" title="Fullscreen"
        className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white/90 opacity-0 group-hover/media:opacity-100 transition hover:bg-black/80"
      >
        {ExpandIcon}
      </button>
    </div>
  );
}

function PostCard({ post, onExpandImage }) {
  const handle = post.author_handle || 'unknown';
  const media = Array.isArray(post.media) ? post.media.filter((m) => m && (m.url || m.thumb)) : [];
  const postUrl = post.url || `https://x.com/${handle}`;
  return (
    <div className="rounded-lg border border-slate-800/70 bg-slate-900/50 hover:border-slate-700 transition-colors p-2.5 mb-2">
      <div className="flex items-start gap-2">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-slate-950"
          style={{ background: avatarColor(handle) }}
        >
          {handle.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] leading-tight">
            <span className="font-semibold text-slate-200 truncate">{post.author_name || handle}</span>
            <span className="text-slate-500 truncate">@{handle}</span>
            <a href={postUrl} target="_blank" rel="noopener noreferrer" title="Open on X"
               className="ml-auto flex-shrink-0 inline-flex items-center gap-0.5 text-slate-600 hover:text-cyan-400">
              {timeAgo(post.posted_at)}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M9 7h8v8" />
              </svg>
            </a>
          </div>
          {post.text && (
            <p className="mt-1 text-[12.5px] leading-snug text-slate-300 whitespace-pre-wrap break-words">
              {renderText(post.text)}
            </p>
          )}
          {media.length > 0 && (
            <div className={`mt-2 grid gap-1 ${media.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {media.slice(0, 4).map((m, i) => (
                <MediaItem key={i} m={m} postUrl={postUrl} onExpandImage={onExpandImage} />
              ))}
            </div>
          )}
          {(post.likes > 0 || post.retweets > 0 || post.replies > 0) && (
            <div className="mt-1.5 flex items-center gap-3 text-[10px] text-slate-500 font-mono tabular-nums">
              {post.replies > 0 && <span>💬 {post.replies}</span>}
              {post.retweets > 0 && <span>🔁 {post.retweets}</span>}
              {post.likes > 0 && <span>♥ {post.likes}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const OPLiveFeedPanel = ({ tag, onChangeTag, width, onResize, onClose, bottomGap = 0 }) => {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tagInput, setTagInput] = useState(tag);
  const [lightbox, setLightbox] = useState(null); // image url shown fullscreen

  const [w, setW] = useState(width);
  const dragRef = useRef(null);

  // Keep the editable tag input and the drag width in sync if the parent
  // changes them externally.
  useEffect(() => { setTagInput(tag); }, [tag]);
  useEffect(() => { setW(width); }, [width]);

  const fetchFeed = useCallback(async (force = false) => {
    const token = getToken();
    if (!token) { setError('Not signed in'); setLoading(false); return; }
    if (force) setRefreshing(true);
    try {
      const qs = new URLSearchParams({ tag: tag || 'OPLive' });
      if (force) qs.set('force', '1');
      const res = await fetch(`/api/social-feed?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setPosts(Array.isArray(data.posts) ? data.posts : []);
      setConfigured(data.configured !== false);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      setError(e.message || 'Failed to load feed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tag]);

  // Initial fetch + 30s poll, re-armed whenever the tag changes.
  useEffect(() => {
    setLoading(true);
    fetchFeed(false);
    const id = setInterval(() => fetchFeed(false), POLL_MS);
    return () => clearInterval(id);
  }, [fetchFeed]);

  const commitTag = () => {
    const next = tagInput.trim().replace(/^#+/, '');
    if (next && next !== tag) onChangeTag?.(next);
    else setTagInput(tag);
  };

  // ── Drag-to-resize from the left edge. Width is live-bound to the
  //    panel so flexbox reflows the grid as you drag; we persist on
  //    release. Listeners attach to window so the drag survives the
  //    cursor leaving the 6px grabber. ──
  const startDrag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    const onMove = (ev) => {
      const next = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)));
      setW(next);
      dragRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (dragRef.current != null) onResize?.(dragRef.current);
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className="relative z-30 flex h-full flex-shrink-0 flex-col border-l border-slate-800/80 bg-slate-950"
      style={{ width: `${w}px`, paddingBottom: bottomGap }}
    >
      {/* Left-edge resize grabber */}
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        className="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize z-40 hover:bg-cyan-500/30"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-slate-800/80 flex-shrink-0">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 ${refreshing ? 'animate-ping' : ''}`} />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
        </span>
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300 flex-shrink-0">
          Live chatter
        </span>
        <div className="flex items-center min-w-0 flex-1 rounded bg-slate-900/80 border border-slate-800 px-1.5 ml-1">
          <span className="text-slate-500 text-[12px]">#</span>
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            onBlur={commitTag}
            spellCheck={false}
            aria-label="Hashtag to follow"
            className="w-full bg-transparent text-[12px] text-cyan-300 placeholder-slate-600 px-1 py-1 outline-none"
            placeholder="OPLive"
          />
        </div>
        <button
          type="button"
          onClick={() => fetchFeed(true)}
          aria-label="Refresh feed"
          className="flex-shrink-0 p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
               className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M5 9a7 7 0 0111-3.5L20 9M19 15a7 7 0 01-11 3.5L4 15" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close feed"
          className="flex-shrink-0 p-1 rounded text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 transition"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2.5 py-2.5 min-h-0">
        {!configured ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">Connect X</span>
            <p className="text-[12px] text-slate-500 leading-relaxed">
              Set <code className="text-cyan-400">X_COOKIES</code> in <code className="text-slate-400">backend/.env</code> with your logged-in
              x.com session cookies (at minimum <code className="text-cyan-400">auth_token</code> and <code className="text-cyan-400">ct0</code>),
              then restart the backend.
            </p>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <svg viewBox="0 0 24 24" className="w-5 h-5 animate-spin text-cyan-400" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500">Loading #{tag}…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 px-3 text-center">
            <span className="text-[12px] text-rose-400">{error}</span>
            <button onClick={() => fetchFeed(true)} className="text-[11px] text-cyan-400 hover:underline">Retry</button>
          </div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 px-3 text-center">
            <p className="text-[12px] text-slate-500">No posts for <span className="text-cyan-400">#{tag}</span> yet.</p>
            <p className="text-[11px] text-slate-600">New posts appear here automatically while the show is live.</p>
          </div>
        ) : (
          posts.map((p) => <PostCard key={p.post_id} post={p} onExpandImage={setLightbox} />)
        )}
      </div>

      {lightbox && <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />}

      {/* Footer status */}
      <div className="flex items-center justify-between px-3 h-7 border-t border-slate-800/80 flex-shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-slate-600">
        <span>{configured ? `${posts.length} posts` : 'not connected'}</span>
        {lastUpdated && <span>updated {timeAgo(new Date(lastUpdated).toISOString())} ago</span>}
      </div>
    </div>
  );
};

export default OPLiveFeedPanel;
