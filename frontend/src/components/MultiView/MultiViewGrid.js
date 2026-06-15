import React, { useMemo, useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy
} from '@dnd-kit/sortable';
import { SortableStreamCell } from './StreamCell';
import { getGridContainerStyle, getStreamGridPosition } from './layoutModes';
import { calculateLayout } from '../../utils/multiviewManager';

const keyOf = (s) => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
// Stable identity for the parked set — excludes _refreshKey (which changes
// when a stream auto-refreshes) so a parked stream stays parked across a
// refresh instead of popping back into the grid.
const minKeyOf = (s) => `${s.sourceId}_${s.id}`;

// Bottom "parked streams" shelf geometry. Tiles are positioned ABSOLUTELY
// inside the same grid container they normally live in — they never leave
// the React tree, so the <video>/mpegts instance keeps playing with zero
// re-buffer while parked. Width is a pure-CSS clamp against the container
// (no ResizeObserver needed): tiles shrink to fit as more get parked.
const SHELF_TILE_H = 88;
const SHELF_PAD = 14;
const SHELF_GAP = 8;
const SHELF_H = SHELF_TILE_H + SHELF_PAD * 2;

const MultiViewGrid = ({
  streams,
  streamOrder,
  sessionId,
  isTheatreMode,
  layout,
  layoutMode,
  mutedStreams,
  streamVolumes,
  streamQualities,
  findingAlternativeFor,
  activeId,
  loadingStreams,
  playerType = 'mpegts-player',
  isFavorited,
  // Commercial detector
  autoMutedKeys,
  tileStates,
  onRegisterVideoElement,
  onUnregisterVideoElement,
  onUndoAdMute,
  // Minimize-to-tray
  minimizedKeys,
  onToggleMinimize,
  // Callbacks
  onDragStart,
  onDragEnd,
  onToggleMute,
  onVolumeChange,
  onRefresh,
  onStreamDead,
  onFindAlternative,
  onFindDifferentGame,
  onAlternateSources,
  onBlacklist,
  onRemove,
  onToggleFavorite,
  onQualityDetected
}) => {
  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px of movement required before drag starts
      },
    })
  );

  const [shelfOpen, setShelfOpen] = useState(true);

  const minimized = useMemo(
    () => (minimizedKeys instanceof Set ? minimizedKeys : new Set(minimizedKeys || [])),
    [minimizedKeys]
  );

  // Split active (in the grid) from parked (in the shelf). Order preserved.
  const activeStreams = useMemo(
    () => streams.filter((s) => !minimized.has(minKeyOf(s))),
    [streams, minimized]
  );
  const minimizedStreams = useMemo(
    () => streams.filter((s) => minimized.has(minKeyOf(s))),
    [streams, minimized]
  );
  const minCount = minimizedStreams.length;
  const hasShelf = minCount > 0 && !isTheatreMode;
  const shelfExpanded = hasShelf && shelfOpen;

  // SortableContext + grid placement operate on ACTIVE streams only, so the
  // grid reflows to fill the space a parked stream vacated.
  const streamIds = useMemo(() => {
    const keys = activeStreams.map(keyOf);
    return [...keys].sort((a, b) => {
      const orderA = streamOrder[a] ?? keys.indexOf(a);
      const orderB = streamOrder[b] ?? keys.indexOf(b);
      return orderA - orderB;
    });
  }, [activeStreams, streamOrder]);

  const activeOrder = useMemo(() => new Map(streamIds.map((k, i) => [k, i])), [streamIds]);

  // Grid container style is computed against the ACTIVE count; we add
  // relative positioning + bottom padding so the absolutely-positioned
  // shelf tiles have room and don't cover the bottom grid row.
  const containerStyle = useMemo(() => {
    // Grid columns/rows MUST be derived from the ACTIVE (non-parked) count,
    // not the `layout` prop — that prop is computed from the TOTAL stream
    // count, so parking a stream would leave its old cell empty instead of
    // the grid reflowing to fill the freed space. (When nothing is parked
    // this equals the passed `layout`, so no behavior change there.)
    const activeLayout = calculateLayout(activeStreams.length);
    const base = getGridContainerStyle(layoutMode, isTheatreMode, activeStreams.length, activeLayout);
    return {
      ...base,
      position: 'relative',
      ...(shelfExpanded ? { paddingBottom: `${SHELF_H}px` } : {})
    };
  }, [layoutMode, isTheatreMode, activeStreams.length, shelfExpanded]);

  // Responsive parked-tile width: clamp(min readable, even split, max).
  const wExpr = `min(200px, (100% - ${SHELF_PAD * 2 + Math.max(0, minCount - 1) * SHELF_GAP}px) / ${minCount || 1})`;
  const shelfTileStyle = useCallback((idx) => ({
    position: 'absolute',
    bottom: `${SHELF_PAD}px`,
    left: `calc(${SHELF_PAD}px + ${idx} * (${wExpr} + ${SHELF_GAP}px))`,
    width: wExpr,
    height: `${SHELF_TILE_H}px`,
    zIndex: 41
  }), [wExpr]);
  // Collapsed: keep parked tiles mounted (still playing) but tucked away
  // off the visible shelf so only the pill shows.
  const hiddenTileStyle = {
    position: 'absolute',
    width: '1px',
    height: '1px',
    bottom: 0,
    left: 0,
    opacity: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: 0
  };

  const cellProps = (stream) => {
    const streamKey = keyOf(stream);
    return {
      stream,
      streamKey,
      sessionId,
      isTheatreMode,
      isMuted: mutedStreams.has(streamKey),
      volume: streamVolumes?.[`${stream.sourceId}_${stream.id}`] ?? 1,
      quality: streamQualities[streamKey],
      isFindingAlternative: findingAlternativeFor && findingAlternativeFor.has && findingAlternativeFor.has(streamKey),
      isFavorited: isFavorited ? isFavorited(stream.sourceId, stream.id) : false,
      isAutoMuted: Boolean(autoMutedKeys?.has?.(streamKey)),
      adSignals: tileStates?.[streamKey]?.signals
        ? Object.entries(tileStates[streamKey].signals).filter(([, v]) => v).map(([k]) => k)
        : [],
      playerType,
      onToggleMute: () => onToggleMute(streamKey),
      onVolumeChange: onVolumeChange ? (v) => onVolumeChange(`${stream.sourceId}_${stream.id}`, v) : null,
      onUndoAdMute: onUndoAdMute ? () => onUndoAdMute(streamKey) : null,
      onVideoElement: onRegisterVideoElement
        ? (videoEl) => {
            if (videoEl) onRegisterVideoElement(streamKey, videoEl, stream);
            else onUnregisterVideoElement?.(streamKey);
          }
        : null,
      onRefresh: () => onRefresh(stream.id, stream.sourceId),
      onFindAlternative: () => onFindAlternative(stream, false),
      onFindDifferentGame: () => onFindDifferentGame(stream),
      onAlternateSources: onAlternateSources ? () => onAlternateSources(stream) : null,
      onStreamDead: onStreamDead ? () => onStreamDead(stream) : () => onFindAlternative(stream, true),
      onBlacklist: () => onBlacklist(stream.name),
      onRemove: () => onRemove(stream.id, stream.sourceId),
      onToggleFavorite: onToggleFavorite ? () => onToggleFavorite(stream) : null,
      onQualityDetected: (quality) => onQualityDetected(streamKey, quality)
    };
  };

  if (loadingStreams) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-4 inline-flex h-24 w-24 items-center justify-center">
            <svg className="animate-spin h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-400">Loading streams...</h3>
        </div>
      </div>
    );
  }

  if (streams.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-4 inline-flex h-24 w-24 items-center justify-center rounded-full bg-slate-800/50">
            <svg className="h-12 w-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h.01M15 10h.01M9.5 15.5c1.5 1 3.5 1 5 0" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-slate-300 mb-2">No Streams Yet</h3>
          <p className="text-slate-500 max-w-md mx-auto">
            Add streams to multiview by clicking the <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-sm font-mono">+</span> button on any player.
          </p>
          <p className="text-slate-600 text-sm mt-2">
            Your streams will persist even after leaving this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={streamIds} strategy={rectSortingStrategy}>
        {/* Unified Layout Container — streams rendered once, CSS controls
            layout. Parked streams stay in this same map (so they never
            remount) and just get absolute shelf positioning. */}
        <div
          className="h-full"
          style={containerStyle}
        >
          {streams.map((stream) => {
            const streamKey = keyOf(stream);
            const isMin = minimized.has(minKeyOf(stream));

            // ── Parked (shelf) tile ─────────────────────────────────
            if (isMin) {
              const shelfIdx = minimizedStreams.findIndex((s) => keyOf(s) === streamKey);
              return (
                <div
                  key={streamKey}
                  className={`group/park min-h-0 min-w-0 rounded-lg overflow-hidden ring-1 ring-slate-700/70 bg-black shadow-[0_4px_16px_rgba(0,0,0,0.5)] transition-[box-shadow] ${shelfExpanded ? 'hover:ring-cyan-400/60' : ''}`}
                  style={shelfExpanded ? shelfTileStyle(shelfIdx) : hiddenTileStyle}
                >
                  <SortableStreamCell {...cellProps(stream)} isFeatured={false} isMinimized />
                  {/* Always-visible channel name — the OSD title strip is
                      hidden on parked tiles, so label it here. */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pb-1 pt-3">
                    <span className="block truncate text-[10px] font-medium leading-tight text-slate-100">{stream.name}</span>
                  </div>
                  {/* Click anywhere to restore — convenient when no error
                      overlay is covering the centre. */}
                  <button
                    type="button"
                    onClick={() => onToggleMinimize?.(minKeyOf(stream))}
                    title={`Restore "${stream.name}" to the grid`}
                    className="absolute inset-0 z-[60] bg-slate-950/0 hover:bg-slate-950/40 transition-colors"
                  />
                  {/* GUARANTEED controls — z-[110] sits ABOVE the player's
                      error modal (zIndex 100), so a parked tile is ALWAYS
                      restorable (and removable), even when its stream has
                      errored and the red "Stream Error" modal is showing. */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onToggleMinimize?.(minKeyOf(stream)); }}
                    title={`Restore "${stream.name}" to the grid`}
                    className="absolute top-1 left-1 z-[110] inline-flex items-center gap-1 rounded-md bg-cyan-500/95 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-950 shadow-lg ring-1 ring-cyan-300/50 hover:bg-cyan-400"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} className="w-2.5 h-2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 14h6v6M20 10h-6V4M14 10l6-6M10 14l-6 6" />
                    </svg>
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRemove(stream.id, stream.sourceId); }}
                    title={`Remove "${stream.name}"`}
                    className="absolute top-1 right-1 z-[110] inline-flex h-5 w-5 items-center justify-center rounded bg-slate-950/85 text-slate-300 ring-1 ring-slate-700/70 transition hover:bg-rose-600/85 hover:text-white"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} className="w-3 h-3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            }

            // ── Active (grid) tile ──────────────────────────────────
            const visualOrder = activeOrder.get(streamKey) ?? 0;
            const { gridColumn, gridRow } = getStreamGridPosition(layoutMode, visualOrder, activeStreams.length);
            const isFeatured = layoutMode !== 'grid' && (
              (layoutMode.startsWith('featured') && visualOrder === 0) ||
              (layoutMode.startsWith('dual') && visualOrder < 2)
            );
            const style = {
              order: visualOrder,
              ...(gridColumn || gridRow ? { gridColumn, gridRow } : {})
            };

            return (
              <div
                key={streamKey}
                className="min-h-0 min-w-0"
                style={style}
              >
                <SortableStreamCell
                  {...cellProps(stream)}
                  isFeatured={isFeatured}
                  onMinimize={onToggleMinimize ? () => onToggleMinimize(minKeyOf(stream)) : null}
                />
              </div>
            );
          })}

          {/* ── Parked shelf chrome ──────────────────────────────────
              Backdrop + label sit BEHIND the parked tiles (which are
              positioned absolutely above). Rendered last so it overlays
              the bottom grid padding, not the tiles. */}
          {shelfExpanded && (
            <div
              className="absolute inset-x-0 bottom-0 z-30 flex items-center border-t border-cyan-500/20 bg-slate-950/85 backdrop-blur-sm pointer-events-none"
              style={{ height: `${SHELF_H}px` }}
            >
              <div className="pointer-events-auto absolute left-3 top-1.5 flex items-center gap-2">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-cyan-300/80">
                  Parked · {minCount}
                </span>
                <button
                  type="button"
                  onClick={() => setShelfOpen(false)}
                  title="Collapse tray"
                  className="inline-flex h-4 w-4 items-center justify-center rounded text-slate-500 hover:text-slate-200 transition"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="w-3 h-3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7-7-7" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Collapsed pill — restores the shelf. Tiles stay mounted +
              playing while collapsed. */}
          {hasShelf && !shelfOpen && (
            <button
              type="button"
              onClick={() => setShelfOpen(true)}
              title="Show parked streams"
              className="absolute bottom-3 left-3 z-40 inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-slate-950/90 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-200 shadow-lg backdrop-blur transition hover:border-cyan-400/60 hover:bg-slate-900"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path strokeLinecap="round" d="M3 20h18" />
              </svg>
              {minCount} parked
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="w-3 h-3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </SortableContext>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeId ? (() => {
          const stream = streams.find((s) => keyOf(s) === activeId);
          if (!stream) return null;
          return (
            <div className="bg-slate-900 rounded-xl border-2 border-cyan-500 shadow-2xl opacity-90 p-2">
              <div className="flex items-center gap-2 text-slate-200">
                {stream.logo && (
                  <img src={stream.logo} alt="" className="w-6 h-6 rounded" />
                )}
                <span className="text-sm font-medium truncate">{stream.name}</span>
              </div>
            </div>
          );
        })() : null}
      </DragOverlay>
    </DndContext>
  );
};

export default MultiViewGrid;
