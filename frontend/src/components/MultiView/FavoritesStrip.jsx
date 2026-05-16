import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * FavoritesStrip — slim horizontal rail of "preset" chips. Click a
 * chip = play that channel into multi-view. Used embedded inside the
 * MultiViewTopBar so there's no separate strip header anymore — the
 * top bar itself carries the FAVORITES label + LED count + collapse.
 *
 * Props:
 *   favorites          — array from useFavorites
 *   streams            — current multi-view streams (used to detect
 *                        already-playing chips so we don't double-add)
 *   streamOrder        — visual-order map keyed by streamKey (used to
 *                        show the "→ TILE #n" badge on live chips)
 *   onPlay(favorite)   — caller wires to addToMultiview + bumpPlayed
 *   onRemove(id)       — caller wires to removeFavorite
 *
 * The component is purely presentational; defers mutation to the
 * parent so useFavorites stays the one cache.
 */
const FavoritesStrip = ({
  favorites = [],
  streams = [],
  streamOrder = {},
  onPlay,
  onRemove
}) => {
  const [playingKey, setPlayingKey] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const railRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
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
  }, [favorites]);

  // Map of (sourceId::channelId) → 1-indexed tile slot for live chips.
  // Lets each chip show "→ TILE #n" instead of just "Live", bridging
  // the strip to the actual tile playing the favorite.
  const liveSlots = useMemo(() => {
    const map = new Map();
    streams.forEach((s, i) => {
      const sk = `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
      const visualOrder = streamOrder?.[sk] ?? i;
      map.set(`${s.sourceId}::${s.id}`, visualOrder + 1);
    });
    return map;
  }, [streams, streamOrder]);

  const railFor = (type) => {
    switch (type) {
      case 'xtream':  return 'from-sky-400 to-blue-500';
      case 'stalker': return 'from-violet-400 to-purple-500';
      case 'm3u':     return 'from-emerald-400 to-teal-500';
      default:        return 'from-slate-500 to-slate-600';
    }
  };

  const subtitleFor = (f) => {
    if (f.sourceType === 'stalker' && f.sourceMac) return f.sourceMac;
    if (f.sourceUsername) return `@${f.sourceUsername}`;
    return f.sourceName || 'Source';
  };

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
    el.scrollBy({ left: dir * Math.max(220, el.clientWidth * 0.6), behavior: 'smooth' });
  };

  if (favorites.length === 0) {
    return <EmptyHint />;
  }

  return (
    <div className="relative h-full flex items-stretch">
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-6 w-5 items-center justify-center rounded-r-md bg-slate-950/90 text-slate-400 ring-1 ring-slate-800 hover:text-amber-200 hover:ring-amber-500/30 transition"
          aria-label="Scroll favorites left"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scrollBy(1)}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-6 w-5 items-center justify-center rounded-l-md bg-slate-950/90 text-slate-400 ring-1 ring-slate-800 hover:text-amber-200 hover:ring-amber-500/30 transition"
          aria-label="Scroll favorites right"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      <div
        ref={railRef}
        className="flex items-stretch gap-1.5 overflow-x-auto pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden snap-x"
        style={{ scrollPaddingLeft: '0.5rem', scrollPaddingRight: '0.5rem' }}
      >
        {favorites.map((fav) => {
          const key = `${fav.sourceId}::${fav.channelId}`;
          const slot = liveSlots.get(key);
          const isLive = slot != null;
          const isPlaying = playingKey === key;
          const isRemoving = removingId === fav.id;
          return (
            <Chip
              key={fav.id}
              fav={fav}
              isLive={isLive}
              tileSlot={slot}
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
  );
};

// ─── Sub-components ────────────────────────────────────────────────────

const Chip = ({
  fav, isLive, tileSlot, isPlaying, isRemoving,
  railClass, subtitle, host, onPlay, onRemove
}) => {
  const disabled = isPlaying || isRemoving;

  // Tooltip text — full account/host context lives in the title attr
  // so the chip itself can stay single-line. The Favorites side panel
  // is the place for inline metadata; the strip is the fast-path.
  const tooltip = isLive
    ? `Playing in tile ${tileSlot} · ${subtitle}${host ? ` · ${host}` : ''}`
    : `Play ${fav.name} · ${subtitle}${host ? ` · ${host}` : ''}`;

  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={disabled || isLive}
      title={tooltip}
      className={`group/chip relative flex-shrink-0 h-full snap-start inline-flex items-center gap-1.5 px-1.5 overflow-hidden rounded-md text-left transition ${
        isLive
          ? 'bg-emerald-500/[0.08] ring-1 ring-emerald-500/30 cursor-default'
          : isPlaying
          ? 'bg-amber-500/[0.10] ring-1 ring-amber-400/40 cursor-wait'
          : isRemoving
          ? 'opacity-40 cursor-not-allowed'
          : 'bg-slate-900/70 ring-1 ring-slate-800/80 hover:ring-amber-500/30 hover:bg-slate-900 hover:-translate-y-px'
      }`}
      style={{ maxWidth: '180px', minWidth: '96px' }}
    >
      {/* Source-color rail — slim vertical accent inside the chip. */}
      <span
        aria-hidden
        className={`relative w-[2px] flex-shrink-0 self-stretch -ml-1.5 bg-gradient-to-b ${
          isLive
            ? 'from-emerald-300 to-emerald-500'
            : isPlaying
            ? 'from-amber-300 to-amber-500'
            : `${railClass} opacity-60 group-hover/chip:opacity-100`
        } transition`}
      />

      {/* Logo. */}
      <div className="relative flex-shrink-0 w-4 h-4 rounded-sm overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
        {fav.logo ? (
          <img
            src={fav.logo}
            alt=""
            className="w-full h-full object-contain"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-500 font-mono text-[7px] uppercase">
            {(fav.name?.[0] || '?').toUpperCase()}
          </div>
        )}
      </div>

      {/* Name — single line, truncated. */}
      <span className="text-[11px] font-semibold text-slate-100 truncate min-w-0 flex-shrink leading-none">
        {fav.name}
      </span>

      {/* Live → tile-slot badge. */}
      {isLive && (
        <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[8.5px] font-bold uppercase tracking-[0.12em] text-emerald-200 border border-emerald-500/30 bg-emerald-500/10 leading-none">
          <span className="font-mono">#{tileSlot}</span>
        </span>
      )}

      {/* Trailing affordance — play icon, spinner, or remove. The
          remove icon only shows on hover (and only when not live). */}
      {isPlaying ? (
        <svg className="flex-shrink-0 w-2.5 h-2.5 animate-spin text-amber-300" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : !isLive && (
        <svg
          className="flex-shrink-0 w-3 h-3 text-amber-300/70 group-hover/chip:text-amber-200 transition-colors"
          fill="currentColor" viewBox="0 0 24 24"
          aria-hidden
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      )}

      {/* Remove "x" — absolute top-right corner, only on hover, only
          when the chip isn't live. Doesn't take layout space when
          hidden. */}
      {!isLive && (
        <span
          role="button"
          tabIndex={-1}
          onClick={onRemove}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute top-0 right-0 opacity-0 group-hover/chip:opacity-100 transition flex items-center justify-center w-3.5 h-3.5 rounded-bl-md bg-slate-950/90 text-slate-500 hover:text-rose-300"
          title="Remove from favorites"
        >
          <svg className="w-2 h-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      )}
    </button>
  );
};

const EmptyHint = () => (
  <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.16em] text-slate-600 px-2">
    <svg className="w-3 h-3 text-amber-300/50 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
    </svg>
    <span>No presets · tap ♥ on any channel to save</span>
  </div>
);

export default FavoritesStrip;
