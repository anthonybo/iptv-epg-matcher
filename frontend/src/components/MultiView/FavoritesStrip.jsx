import React, { useEffect, useMemo, useState, useRef } from 'react';

/**
 * FavoritesStrip — horizontal "preset rack" mounted above the multi-view
 * grid. Single click = play into multi-view (the explicit fast-fill
 * affordance). Same visual language as ChannelPickerModal rows: each
 * card carries a source-type color rail, mono account subtitle, and a
 * "live now" treatment when that exact (source, channel) is already on
 * screen.
 *
 * Props:
 *   favorites          — array from useFavorites
 *   loading            — initial fetch flag (skeleton row)
 *   streams            — current multi-view streams (used to detect
 *                        already-playing chips so we don't double-add)
 *   onPlay(favorite)   — caller wires this to addToMultiview + bumpPlayed
 *   onRemove(id)       — caller wires this to removeFavorite
 *
 * The component is purely presentational — it owns its collapse/expand
 * state in localStorage (per-user pref, not session) but defers all
 * mutation to the parent so the favorites cache stays in one place.
 */
const STORAGE_KEY = 'multiview_favorites_strip_collapsed';

const FavoritesStrip = ({
  favorites = [],
  loading = false,
  streams = [],
  onPlay,
  onRemove
}) => {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; }
    catch { return false; }
  });
  const [playingKey, setPlayingKey] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const railRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); }
    catch { /* ignore */ }
  }, [collapsed]);

  // Track scrollability of the rail so we can show the arrow controls
  // only when needed (rather than always-visible chrome eating space).
  useEffect(() => {
    if (collapsed) return undefined;
    const el = railRef.current;
    if (!el) return undefined;
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 2);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [collapsed, favorites]);

  const liveKeys = useMemo(
    () => new Set(streams.map((s) => `${s.sourceId}::${s.id}`)),
    [streams]
  );

  // Source-type → rail palette (same map as ChannelPickerModal). Each
  // chip's left rail uses these as gradient stops so the picker and the
  // strip feel like one continuous control surface.
  const railFor = (type) => {
    switch (type) {
      case 'xtream':  return 'from-sky-400 to-blue-500';
      case 'stalker': return 'from-violet-400 to-purple-500';
      case 'm3u':     return 'from-emerald-400 to-teal-500';
      default:        return 'from-slate-500 to-slate-600';
    }
  };

  // The auto-label subtitle. xtream/m3u → username, stalker → MAC.
  // Always shown so the user can disambiguate 10 chips called "Reelz".
  const subtitleFor = (f) => {
    if (f.sourceType === 'stalker' && f.sourceMac) return f.sourceMac;
    if (f.sourceUsername) return `@${f.sourceUsername}`;
    return f.sourceName || 'Source';
  };

  // Hostname-only secondary; useful when two accounts share the same
  // username across different providers (rare but happens).
  const hostOf = (url) => {
    if (!url) return null;
    try { return new URL(url).host.toLowerCase(); }
    catch { return null; }
  };

  const handlePlay = async (fav) => {
    if (!onPlay || playingKey || removingId === fav.id) return;
    const key = `${fav.sourceId}::${fav.channelId}`;
    setPlayingKey(key);
    try { await onPlay(fav); }
    finally { setPlayingKey(null); }
  };

  const handleRemove = async (e, fav) => {
    e.stopPropagation();
    if (!onRemove || removingId) return;
    setRemovingId(fav.id);
    try { await onRemove(fav.id); }
    finally { setRemovingId(null); }
  };

  const scrollBy = (dir) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.6), behavior: 'smooth' });
  };

  // ─── Empty / Loading skeleton ───────────────────────────────────────
  const showEmptyHint = !loading && favorites.length === 0;

  return (
    <div
      className="relative border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-sm"
      style={{
        // Hairline accent at the bottom edge — same motif as the modal
        // top-strip; ties the surface to the rest of the control chrome.
        backgroundImage:
          'linear-gradient(to bottom, rgba(2,6,23,0) 0%, rgba(2,6,23,0) 80%, rgba(15,23,42,0.4) 100%)'
      }}
    >
      {/* Header row — tight, mono, with a heartbeat dot. */}
      <div className="flex items-center justify-between px-4 pt-2 pb-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="group/header flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400 hover:text-amber-200 transition"
          title={collapsed ? 'Show favorites' : 'Hide favorites'}
        >
          {/* Heart icon doubling as the collapse affordance — pulses softly
              when there's at least one favorite, dim otherwise. */}
          <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
            {favorites.length > 0 && (
              <span className="absolute inset-0 rounded-full bg-amber-400/20 animate-ping" />
            )}
            <svg
              viewBox="0 0 24 24"
              className={`relative h-3.5 w-3.5 ${
                favorites.length > 0 ? 'text-amber-300' : 'text-slate-600'
              } transition group-hover/header:text-amber-200`}
              fill="currentColor"
            >
              <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
            </svg>
          </span>
          <span>Favorites</span>
          <span className="font-mono text-[10px] text-slate-500 tracking-normal tabular-nums">
            {loading ? '—' : favorites.length}
          </span>
          {/* Chevron — rotates with collapse state */}
          <svg
            className={`h-3 w-3 text-slate-600 transition-transform ${collapsed ? '' : 'rotate-180'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Right-side hint — tiny micro-copy that fades to background. */}
        {!collapsed && favorites.length > 0 && (
          <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
            Click to play · Hover for remove
          </span>
        )}
      </div>

      {/* Body — either the rail of chips, the empty hint, or nothing
          (when collapsed). */}
      {!collapsed && (
        <div className="relative px-4 pb-3">
          {showEmptyHint ? (
            <EmptyHint />
          ) : (
            <div className="relative">
              {/* Left scroll button */}
              {canScrollLeft && (
                <button
                  type="button"
                  onClick={() => scrollBy(-1)}
                  className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-9 w-7 items-center justify-center rounded-r-md bg-slate-950/80 text-slate-400 ring-1 ring-slate-800 backdrop-blur-sm hover:text-amber-200 hover:ring-amber-500/30 transition"
                  aria-label="Scroll favorites left"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              {/* Right scroll button */}
              {canScrollRight && (
                <button
                  type="button"
                  onClick={() => scrollBy(1)}
                  className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-9 w-7 items-center justify-center rounded-l-md bg-slate-950/80 text-slate-400 ring-1 ring-slate-800 backdrop-blur-sm hover:text-amber-200 hover:ring-amber-500/30 transition"
                  aria-label="Scroll favorites right"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              <div
                ref={railRef}
                className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden snap-x"
                style={{ scrollPaddingLeft: '1rem', scrollPaddingRight: '1rem' }}
              >
                {loading && favorites.length === 0
                  ? Array.from({ length: 4 }).map((_, i) => <SkeletonChip key={`sk-${i}`} />)
                  : favorites.map((fav) => {
                      const key = `${fav.sourceId}::${fav.channelId}`;
                      const isLive = liveKeys.has(key);
                      const isPlaying = playingKey === key;
                      const isRemoving = removingId === fav.id;
                      return (
                        <Chip
                          key={fav.id}
                          fav={fav}
                          isLive={isLive}
                          isPlaying={isPlaying}
                          isRemoving={isRemoving}
                          railClass={railFor(fav.sourceType)}
                          subtitle={subtitleFor(fav)}
                          host={hostOf(fav.sourceUrl)}
                          onPlay={() => handlePlay(fav)}
                          onRemove={(e) => handleRemove(e, fav)}
                        />
                      );
                    })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────

const Chip = ({
  fav, isLive, isPlaying, isRemoving, railClass, subtitle, host, onPlay, onRemove
}) => {
  const disabled = isPlaying || isRemoving;

  // The chip is a button so keyboard tab + Enter works.
  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={disabled || isLive}
      title={isLive ? 'Already on screen' : `Play ${fav.name}`}
      className={`group/chip relative flex-shrink-0 w-[210px] snap-start flex items-stretch gap-2 overflow-hidden rounded-xl text-left transition ${
        isLive
          ? 'bg-emerald-500/[0.07] ring-1 ring-emerald-500/30 cursor-default'
          : isPlaying
          ? 'bg-amber-500/[0.10] ring-1 ring-amber-400/40 cursor-wait'
          : isRemoving
          ? 'opacity-40 cursor-not-allowed'
          : 'bg-slate-900/60 ring-1 ring-slate-800/80 hover:ring-amber-500/30 hover:bg-slate-900/90 hover:-translate-y-px hover:shadow-[0_8px_24px_-12px_rgba(251,191,36,0.25)]'
      }`}
    >
      {/* Source-color rail. */}
      <span
        className={`relative w-[3px] flex-shrink-0 self-stretch bg-gradient-to-b ${
          isLive
            ? 'from-emerald-300 to-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
            : isPlaying
            ? 'from-amber-300 to-amber-500 shadow-[0_0_8px_rgba(251,191,36,0.5)]'
            : `${railClass} opacity-60 group-hover/chip:opacity-100`
        } transition`}
      >
        {isLive && (
          <span className="absolute -top-0.5 -left-0.5 -right-0.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
        )}
      </span>

      {/* Logo tile. */}
      <div className="relative flex-shrink-0 w-10 h-10 my-2 rounded-md overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
        {fav.logo ? (
          <img
            src={fav.logo}
            alt=""
            className="w-full h-full object-contain"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-500 font-mono text-[11px] uppercase">
            {(fav.name?.[0] || '?').toUpperCase()}
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/5" />
      </div>

      {/* Two-line text column. */}
      <div className="flex-1 min-w-0 flex flex-col justify-center py-2 pr-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold text-slate-100 truncate flex-1 min-w-0">
            {fav.name}
          </span>
          {isLive && (
            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1 py-0 rounded text-[8px] font-bold uppercase tracking-[0.14em] text-emerald-300 bg-emerald-500/15 border border-emerald-500/25">
              <span className="w-1 h-1 rounded-full bg-emerald-400" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5 min-w-0">
          <span
            className={`flex-shrink-0 font-mono text-[10px] truncate ${
              fav.sourceType === 'stalker' ? 'text-violet-300/90' : 'text-cyan-300/90'
            }`}
            title={subtitle}
          >
            {subtitle}
          </span>
          {host && (
            <>
              <span className="text-slate-700">·</span>
              <span className="font-mono text-[10px] text-slate-500 truncate min-w-0">
                {host}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Hover-only remove. Positioned absolutely so it doesn't fight
          the layout when invisible. */}
      {!isLive && (
        <span
          role="button"
          tabIndex={-1}
          onClick={onRemove}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover/chip:opacity-100 transition flex items-center justify-center w-5 h-5 rounded-md bg-slate-950/80 text-slate-500 ring-1 ring-slate-800 hover:text-rose-300 hover:ring-rose-500/40 hover:bg-rose-500/10"
          title="Remove from favorites"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      )}

      {/* Trailing play affordance — appears on hover, slides in. */}
      {!isLive && !isPlaying && (
        <span className="absolute bottom-1.5 right-2 opacity-0 group-hover/chip:opacity-100 transition flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-amber-300/90">
          <span>Play</span>
          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      )}
      {isPlaying && (
        <span className="absolute bottom-1.5 right-2 text-amber-300">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </span>
      )}
    </button>
  );
};

const SkeletonChip = () => (
  <div className="flex-shrink-0 w-[210px] h-[56px] rounded-xl bg-slate-900/40 ring-1 ring-slate-800/60 animate-pulse" />
);

const EmptyHint = () => (
  <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/30 px-4 py-2.5 text-[11px] text-slate-500">
    <svg className="w-4 h-4 text-amber-300/60 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
    </svg>
    <span>
      <span className="text-slate-300 font-medium">No favorites yet.</span>{' '}
      Tap the heart on any channel in the picker to keep it here for one-click play.
    </span>
  </div>
);

export default FavoritesStrip;
