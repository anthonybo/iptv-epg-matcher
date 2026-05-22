import React, { useMemo, useCallback } from 'react';
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

  // Get stream IDs for SortableContext - sorted by visual order
  const streamIds = useMemo(() => {
    const keys = streams.map(s => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`);
    // Sort by visual order if available, otherwise by original array position
    return [...keys].sort((a, b) => {
      const orderA = streamOrder[a] ?? keys.indexOf(a);
      const orderB = streamOrder[b] ?? keys.indexOf(b);
      return orderA - orderB;
    });
  }, [streams, streamOrder]);

  // Memoize grid container style
  const gridContainerStyle = useMemo(() => {
    return getGridContainerStyle(layoutMode, isTheatreMode, streams.length, layout);
  }, [layoutMode, isTheatreMode, streams.length, layout]);

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
        {/* Unified Layout Container - streams rendered once, CSS controls layout */}
        <div
          className="h-full"
          style={gridContainerStyle}
        >
          {streams.map((stream) => {
            const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
            // Get visual order for this stream (default to its position in streamIds)
            const visualOrder = streamOrder[streamKey] ?? streamIds.indexOf(streamKey);

            // Calculate grid position based on layout mode and VISUAL order
            const { gridColumn, gridRow } = getStreamGridPosition(layoutMode, visualOrder, streams.length);

            const isFeatured = layoutMode !== 'grid' && (
              (layoutMode.startsWith('featured') && visualOrder === 0) ||
              (layoutMode.startsWith('dual') && visualOrder < 2)
            );

            // Use CSS order property for grid layout ordering
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
                  stream={stream}
                  streamKey={streamKey}
                  sessionId={sessionId}
                  isTheatreMode={isTheatreMode}
                  isMuted={mutedStreams.has(streamKey)}
                  volume={streamVolumes?.[`${stream.sourceId}_${stream.id}`] ?? 1}
                  quality={streamQualities[streamKey]}
                  isFindingAlternative={findingAlternativeFor && findingAlternativeFor.has && findingAlternativeFor.has(streamKey)}
                  isFavorited={isFavorited ? isFavorited(stream.sourceId, stream.id) : false}
                  isAutoMuted={Boolean(autoMutedKeys?.has?.(streamKey))}
                  adSignals={tileStates?.[streamKey]?.signals
                    ? Object.entries(tileStates[streamKey].signals).filter(([, v]) => v).map(([k]) => k)
                    : []}
                  playerType={playerType}
                  onToggleMute={() => onToggleMute(streamKey)}
                  onVolumeChange={onVolumeChange ? (v) => onVolumeChange(`${stream.sourceId}_${stream.id}`, v) : null}
                  onUndoAdMute={onUndoAdMute ? () => onUndoAdMute(streamKey) : null}
                  onVideoElement={onRegisterVideoElement
                    ? (videoEl) => {
                        if (videoEl) onRegisterVideoElement(streamKey, videoEl, stream);
                        else onUnregisterVideoElement?.(streamKey);
                      }
                    : null}
                  onRefresh={() => onRefresh(stream.id, stream.sourceId)}
                  onFindAlternative={() => onFindAlternative(stream, false)}
                  onFindDifferentGame={() => onFindDifferentGame(stream)}
                  onAlternateSources={onAlternateSources ? () => onAlternateSources(stream) : null}
                  onStreamDead={
                    onStreamDead
                      ? () => onStreamDead(stream)
                      // Fallback for callers that haven't wired
                      // onStreamDead: keep the old behavior of jumping
                      // straight to find-alternative.
                      : () => onFindAlternative(stream, true)
                  }
                  onBlacklist={() => onBlacklist(stream.name)}
                  onRemove={() => onRemove(stream.id, stream.sourceId)}
                  onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(stream) : null}
                  onQualityDetected={(quality) => onQualityDetected(streamKey, quality)}
                  isFeatured={isFeatured}
                />
              </div>
            );
          })}
        </div>
      </SortableContext>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeId ? (() => {
          const stream = streams.find(s => `${s.sourceId}_${s.id}_${s._refreshKey || ''}` === activeId);
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
