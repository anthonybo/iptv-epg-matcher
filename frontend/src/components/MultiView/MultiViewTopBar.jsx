import React, { useEffect, useRef } from 'react';
import FavoritesStrip from './FavoritesStrip';

/**
 * MultiViewTopBar — the slim 40px control panel above the tile grid.
 *
 * Three zones, left to right:
 *   1. PRESETS label + LED counter + favorites strip (collapsible)
 *   2. Auto-fill progress chip (only while running)
 *   3. Search input (when expanded) + ⌘K hint
 *
 * Replaces the old MultiViewHeader entirely. Everything that used to
 * be a labelled button up here has moved to the left rail.
 */
const MultiViewTopBar = ({
  // Favorites
  favorites,
  streams,
  streamOrder,
  onPlayFavorite,
  onRemoveFavorite,
  // Inline search input (toggled by rail's "⌕ Search")
  showSearchInput,
  setShowSearchInput,
  searchQuery,
  setSearchQuery,
  isSearching,
  onSearchChannel,
  // Auto-fill progress (shows pill while filling)
  autoFillProgress,
  // Random/searching stream cancel (visible mid-search)
  searchingStream,
  onCancelSearch,
  // Palette
  onOpenPalette
}) => {
  const inputRef = useRef(null);

  // Auto-focus the search input when revealed, and bind Esc to close it.
  useEffect(() => {
    if (!showSearchInput) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowSearchInput?.(false);
        setSearchQuery?.('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [showSearchInput, setShowSearchInput, setSearchQuery]);

  const favCount = favorites?.length || 0;

  return (
    <header
      className="relative flex-shrink-0 h-10 flex items-stretch border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-sm"
      role="banner"
      aria-label="Multi-view top bar"
    >
      {/* Hairline cyan accent on the bottom edge — same motif as the
          rail's right edge. Visually closes the corner where the rail
          meets the top bar. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-500/15 to-transparent" />

      {/* ─── Zone 1: PRESETS label + LED count + strip ──────────────── */}
      <div className="flex items-center gap-2 pl-3 pr-2 flex-1 min-w-0">
        {/* Engraved I-beam endmark — like the bracket on a rack unit. */}
        <span aria-hidden className="flex flex-col gap-px flex-shrink-0">
          <span className="h-px w-2 bg-amber-300/60" />
          <span className="h-2 w-px bg-amber-300/60" />
          <span className="h-px w-2 bg-amber-300/60" />
        </span>

        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400 flex-shrink-0">
          Presets
        </span>

        {/* LED-style two-digit count. Recessed border + inset shadow +
            amber glow when populated; dark/dim when empty. */}
        <span
          className={`relative inline-flex items-center px-1.5 py-0.5 rounded-sm font-mono text-[10px] tabular-nums tracking-tight border flex-shrink-0 ${
            favCount > 0
              ? 'text-amber-200 border-amber-500/30 bg-amber-500/[0.04] shadow-[inset_0_1px_2px_rgba(0,0,0,0.55),0_0_8px_rgba(251,191,36,0.12)]'
              : 'text-slate-600 border-slate-800 bg-slate-950 shadow-[inset_0_1px_2px_rgba(0,0,0,0.55)]'
          }`}
          aria-label={`${favCount} favorites`}
        >
          {String(favCount).padStart(2, '0')}
        </span>

        {/* Slim divider — tiny vertical hairline before the strip. */}
        <span aria-hidden className="h-4 w-px bg-slate-800 flex-shrink-0 mx-0.5" />

        {/* The strip itself — fills the remaining width and scrolls
            horizontally when it overflows. Single-line chips inside,
            so 28px tall is plenty even after rounding for the icon
            and ring. */}
        <div className="flex-1 min-w-0 h-[26px]">
          <FavoritesStrip
            favorites={favorites}
            streams={streams}
            streamOrder={streamOrder}
            onPlay={onPlayFavorite}
            onRemove={onRemoveFavorite}
          />
        </div>
      </div>

      {/* ─── Zone 2: Inline AutoFill progress chip + cancel ─────────── */}
      {(autoFillProgress || searchingStream) && (
        <div className="flex items-center gap-1.5 px-2 flex-shrink-0 border-l border-slate-800/80">
          {autoFillProgress && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-[10px] font-mono uppercase tracking-wide">
              <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="truncate max-w-[200px]">{autoFillProgress.status}</span>
            </span>
          )}
          {searchingStream && onCancelSearch && (
            <button
              type="button"
              onClick={onCancelSearch}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 text-[10px] font-mono uppercase tracking-wide hover:bg-rose-500/20 transition"
              title="Cancel search"
            >
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Cancel
            </button>
          )}
        </div>
      )}

      {/* ─── Zone 3: Search input (when shown) + palette hint ───────── */}
      <div className="flex items-center gap-2 px-3 flex-shrink-0 border-l border-slate-800/80">
        {showSearchInput ? (
          <form onSubmit={onSearchChannel} className="flex items-center gap-1">
            <div className="relative">
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-cyan-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search channels…"
                disabled={isSearching}
                className="w-56 h-6 pl-7 pr-2 text-[11px] rounded-md border border-cyan-500/40 bg-slate-900 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:opacity-50"
              />
            </div>
            <button
              type="submit"
              disabled={isSearching || !searchQuery.trim()}
              className="inline-flex items-center justify-center h-6 px-2 rounded-md border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 text-[10px] font-mono uppercase tracking-wider hover:bg-cyan-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              Find
            </button>
            <button
              type="button"
              onClick={() => { setShowSearchInput(false); setSearchQuery(''); }}
              className="inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition"
              title="Close search (Esc)"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={onOpenPalette}
            className="group/k inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-slate-800 bg-slate-900/80 text-slate-500 hover:text-cyan-200 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition"
            title="Open command palette"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="font-mono text-[9px] uppercase tracking-[0.18em]">Find anything</span>
            <kbd className="font-mono text-[9px] text-slate-500 group-hover/k:text-cyan-300 bg-slate-950 px-1 py-px rounded border border-slate-800">⌘K</kbd>
          </button>
        )}
      </div>
    </header>
  );
};

export default MultiViewTopBar;
