import React, { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * FavoritesPanel — slide-in management panel for favorites.
 *
 * Rendered to the right of the page rail, 320px wide, full page
 * height. Slides in with `mv-anim-panel-in` and dims the tile grid
 * behind it via a click-to-close backdrop.
 *
 * Capabilities the slim TopBar strip doesn't have:
 *   - Filter by name / host / account
 *   - Drag-to-reorder via @dnd-kit
 *   - Per-row metadata (play count, last played)
 *   - Ghost preset slot empty state
 *
 * Click a row = play (same fast-path as the strip). The X removes.
 */
const FavoritesPanel = ({
  isOpen,
  onClose,
  favorites = [],
  streams = [],
  onPlay,
  onRemove,
  onReorder
}) => {
  const [filter, setFilter] = useState('');
  const [playingKey, setPlayingKey] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [orderedIds, setOrderedIds] = useState(() => favorites.map((f) => f.id));

  // Keep local order in sync with the server-order whenever favorites
  // change (add/remove/reload), but allow drag to mutate it locally
  // before we ship the reorder PATCH.
  useEffect(() => {
    setOrderedIds(favorites.map((f) => f.id));
  }, [favorites]);

  // Esc closes.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Live keys (sourceId::channelId) → which favorites are currently
  // on screen. We render a "Live" badge so the user doesn't waste a
  // click trying to add a duplicate.
  const liveKeys = useMemo(
    () => new Set(streams.map((s) => `${s.sourceId}::${s.id}`)),
    [streams]
  );

  const byId = useMemo(
    () => new Map(favorites.map((f) => [f.id, f])),
    [favorites]
  );

  const orderedFavorites = useMemo(
    () => orderedIds.map((id) => byId.get(id)).filter(Boolean),
    [orderedIds, byId]
  );

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return orderedFavorites;
    return orderedFavorites.filter((fav) =>
      [fav.name, fav.sourceName, fav.sourceUsername, fav.sourceMac, fav.sourceUrl]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(f))
    );
  }, [filter, orderedFavorites]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderedIds((prev) => {
      const oldIdx = prev.indexOf(active.id);
      const newIdx = prev.indexOf(over.id);
      if (oldIdx === -1 || newIdx === -1) return prev;
      const next = arrayMove(prev, oldIdx, newIdx);
      // Persist reorder (fire-and-forget, optimistic UI already shows
      // the new order). Errors roll back inside useFavorites.
      onReorder?.(next);
      return next;
    });
  };

  const handlePlay = async (fav) => {
    if (!onPlay || playingKey) return;
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

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop. Click outside the panel to dismiss. The rail
          itself stays visible — only the tiles get dimmed. */}
      <div
        className="absolute inset-0 z-30 bg-slate-950/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />

      <aside
        role="dialog"
        aria-label="Favorites"
        className="absolute top-0 left-0 bottom-0 z-40 w-[320px] flex flex-col border-r border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-[12px_0_36px_-12px_rgba(0,0,0,0.7)] mv-anim-panel-in"
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-amber-400/30 via-amber-400/10 to-transparent" />

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800/80">
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 text-amber-300 flex-shrink-0">
            <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
          </svg>
          <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-slate-200 flex-1">
            Favorites
          </h2>
          <span
            className={`relative inline-flex items-center px-1.5 py-0.5 rounded-sm font-mono text-[10px] tabular-nums tracking-tight border ${
              favorites.length > 0
                ? 'text-amber-200 border-amber-500/30 bg-amber-500/[0.04] shadow-[inset_0_1px_2px_rgba(0,0,0,0.55),0_0_8px_rgba(251,191,36,0.12)]'
                : 'text-slate-600 border-slate-800 bg-slate-950 shadow-[inset_0_1px_2px_rgba(0,0,0,0.55)]'
            }`}
          >
            {String(favorites.length).padStart(2, '0')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-100 transition"
            title="Close (Esc)"
          >
            <svg className="w-3.5 h-3.5 transition hover:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Filter */}
        {favorites.length > 0 && (
          <div className="px-3 py-2 border-b border-slate-800/80">
            <div className={`relative rounded-md border transition ${
              filter
                ? 'border-cyan-500/30 bg-slate-900'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}>
              <svg className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 ${
                filter ? 'text-cyan-300' : 'text-slate-500'
              }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name, host, account…"
                className="w-full bg-transparent pl-7 pr-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
          {favorites.length === 0 ? (
            <GhostSlots />
          ) : filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-[11px] text-slate-500">
              No favorites match
              <div className="font-mono text-cyan-300/80 mt-1">"{filter}"</div>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={filtered.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="space-y-1">
                  {filtered.map((fav) => {
                    const key = `${fav.sourceId}::${fav.channelId}`;
                    const isLive = liveKeys.has(key);
                    const isPlaying = playingKey === key;
                    const isRemoving = removingId === fav.id;
                    return (
                      <SortableRow
                        key={fav.id}
                        fav={fav}
                        isLive={isLive}
                        isPlaying={isPlaying}
                        isRemoving={isRemoving}
                        onPlay={() => handlePlay(fav)}
                        onRemove={(e) => handleRemove(e, fav)}
                      />
                    );
                  })}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-2 border-t border-slate-800/80 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-slate-600 font-mono">
          <span>Drag to reorder · click to play</span>
          <kbd className="px-1 py-px rounded bg-slate-900 border border-slate-800 normal-case tracking-normal text-slate-500">Esc</kbd>
        </div>
      </aside>
    </>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────

const SortableRow = ({ fav, isLive, isPlaying, isRemoving, onPlay, onRemove }) => {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging
  } = useSortable({ id: fav.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  const railClass = {
    xtream:  'from-sky-400 to-blue-500',
    stalker: 'from-violet-400 to-purple-500',
    m3u:     'from-emerald-400 to-teal-500'
  }[fav.sourceType] || 'from-slate-500 to-slate-600';

  const subtitle = fav.sourceType === 'stalker' && fav.sourceMac
    ? fav.sourceMac
    : fav.sourceUsername
      ? `@${fav.sourceUsername}`
      : fav.sourceName || 'Source';

  let host = null;
  try { host = fav.sourceUrl ? new URL(fav.sourceUrl).host : null; } catch { /* ignore */ }

  return (
    <li ref={setNodeRef} style={style}>
      <div
        className={`group/row relative flex items-stretch gap-2 rounded-lg overflow-hidden transition ${
          isLive
            ? 'bg-emerald-500/[0.08] ring-1 ring-emerald-500/25 cursor-default'
            : isPlaying
            ? 'bg-amber-500/[0.10] ring-1 ring-amber-400/40 cursor-wait'
            : isRemoving
            ? 'opacity-40 cursor-not-allowed'
            : isDragging
            ? 'bg-slate-800/80 ring-1 ring-cyan-400/30'
            : 'bg-slate-900/50 ring-1 ring-transparent hover:bg-slate-800/70 hover:ring-slate-700/70'
        }`}
      >
        {/* Source rail */}
        <span
          aria-hidden
          className={`relative w-[2px] flex-shrink-0 self-stretch bg-gradient-to-b ${railClass} ${
            isLive ? 'opacity-100' : 'opacity-70 group-hover/row:opacity-100'
          } transition`}
        />

        {/* Drag handle */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="flex-shrink-0 self-stretch w-5 flex items-center justify-center text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
          aria-label="Drag to reorder"
        >
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
            <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
          </svg>
        </button>

        {/* Clickable body — entire row except the drag-handle and X */}
        <button
          type="button"
          onClick={onPlay}
          disabled={isLive || isPlaying || isRemoving}
          className="flex-1 min-w-0 flex items-center gap-2.5 py-2 pr-3 text-left"
        >
          <div className="relative flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
            {fav.logo ? (
              <img
                src={fav.logo}
                alt=""
                className="w-full h-full object-contain"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-500 font-mono text-[10px] uppercase">
                {(fav.name?.[0] || '?').toUpperCase()}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-semibold text-slate-100 truncate flex-1">
                {fav.name}
              </span>
              {isLive && (
                <span className="flex-shrink-0 inline-flex items-center px-1 rounded text-[8px] font-bold uppercase tracking-[0.14em] text-emerald-200 bg-emerald-500/15 border border-emerald-500/25">
                  Live
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 mt-px text-[10px] min-w-0">
              <span
                className={`font-mono truncate flex-shrink ${
                  fav.sourceType === 'stalker' ? 'text-violet-300' : 'text-cyan-300/90'
                }`}
                title={subtitle}
              >
                {subtitle}
              </span>
              {host && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="font-mono text-slate-500 truncate min-w-0">{host}</span>
                </>
              )}
            </div>
          </div>

          {!isLive && !isPlaying && (
            <svg className="w-3 h-3 text-slate-600 group-hover/row:text-amber-300 transition flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
          {isPlaying && (
            <svg className="w-3 h-3 animate-spin text-amber-300 flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
        </button>

        {/* Hover-only remove */}
        {!isLive && (
          <button
            type="button"
            onClick={onRemove}
            disabled={isRemoving}
            className="flex-shrink-0 self-stretch w-7 flex items-center justify-center text-slate-600 opacity-0 group-hover/row:opacity-100 hover:text-rose-300 hover:bg-rose-500/10 transition"
            title="Remove from favorites"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </li>
  );
};

const GhostSlots = () => (
  <div className="space-y-1.5 px-1 py-3">
    {[1, 2, 3, 4, 5].map((n) => (
      <div
        key={n}
        className="relative h-12 rounded-lg border border-dashed border-slate-800/80 bg-slate-900/20 mv-bg-hash overflow-hidden"
      >
        <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-700">
          Slot {String(n).padStart(2, '0')}
        </span>
        <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[8px] uppercase tracking-[0.2em] text-slate-700">
          Empty
        </span>
        {n === 1 && (
          <span className="absolute inset-0 flex items-center justify-center text-amber-300/30">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
            </svg>
          </span>
        )}
      </div>
    ))}
    <p className="px-3 pt-2 text-center text-[10px] font-mono uppercase tracking-[0.16em] text-slate-600">
      Tap <span className="text-amber-300/70">♥</span> on any channel to fill a slot
    </p>
  </div>
);

export default FavoritesPanel;
