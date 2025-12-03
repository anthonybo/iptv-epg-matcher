import React, { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import IPTVPlayer from '../../IPTVPlayer';
import VideoQualityBadge from '../VideoQualityBadge';

// Inner stream cell component - contains the video player and is heavily memoized
// This component should NEVER re-render due to drag/drop operations
const StreamCellInner = memo(({
  stream,
  streamKey,
  sessionId,
  isTheatreMode,
  isMuted,
  quality,
  isFindingAlternative,
  onToggleMute,
  onRefresh,
  onFindAlternative,
  onBlacklist,
  onRemove,
  onQualityDetected,
  dragHandleProps
}) => {
  return (
    <div
      className={`relative overflow-hidden h-full ${
        isTheatreMode
          ? 'bg-black'
          : 'rounded-xl border border-slate-800/70 bg-slate-900/70 shadow-2xl shadow-slate-950/40'
      }`}
    >
      {/* Stream Header */}
      {!isTheatreMode && (
        <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-slate-900/95 via-slate-900/80 to-transparent p-2">
          <div className="flex items-center justify-between gap-2">
            {/* Drag Handle */}
            {dragHandleProps && (
              <div
                {...dragHandleProps}
                className="p-1 rounded cursor-grab active:cursor-grabbing hover:bg-slate-700/50 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                title="Drag to reorder"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                </svg>
              </div>
            )}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {stream.logo && (
                <img
                  src={stream.logo}
                  alt=""
                  className="w-5 h-5 rounded object-contain flex-shrink-0"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              )}
              <span className="text-xs font-medium text-slate-200 truncate">
                {stream.name}
              </span>
              {quality && (
                <VideoQualityBadge quality={quality} size="xs" />
              )}
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {/* Mute Button */}
              <button
                onClick={onToggleMute}
                className="p-0.5 rounded hover:bg-slate-700/50 text-slate-400 hover:text-slate-200 transition-colors"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                )}
              </button>
              {/* Refresh Button */}
              <button
                onClick={onRefresh}
                className="p-0.5 rounded hover:bg-blue-500/20 text-slate-400 hover:text-blue-400 transition-colors"
                title="Refresh stream"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              {/* Find Alternative Button */}
              <button
                onClick={onFindAlternative}
                disabled={isFindingAlternative}
                className={`p-0.5 rounded transition-colors ${
                  isFindingAlternative
                    ? 'text-cyan-400 animate-pulse'
                    : 'hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-400'
                }`}
                title="Find another stream (if blacked out)"
              >
                {isFindingAlternative ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                )}
              </button>
              {/* Blacklist Button */}
              <button
                onClick={onBlacklist}
                className="p-0.5 rounded hover:bg-yellow-500/20 text-slate-400 hover:text-yellow-400 transition-colors"
                title="Blacklist this channel"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </button>
              {/* Remove Button */}
              <button
                onClick={onRemove}
                className="p-0.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors"
                title="Remove from multiview"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Video Player */}
      <div className="h-full w-full">
        <IPTVPlayer
          sessionId={sessionId}
          selectedChannel={stream}
          playbackMethod="mpegts-player"
          matchedChannels={{}}
          theatreMode={true}
          muted={isMuted}
          onQualityDetected={onQualityDetected}
          useResilientProxy={true} // Always use backend retry for multi-view streams
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if these specific props change
  // Callbacks and dragHandleProps are excluded - they don't affect video playback
  return (
    prevProps.streamKey === nextProps.streamKey &&
    prevProps.stream._refreshKey === nextProps.stream._refreshKey &&
    prevProps.isTheatreMode === nextProps.isTheatreMode &&
    prevProps.isMuted === nextProps.isMuted &&
    prevProps.quality?.resolution === nextProps.quality?.resolution &&
    prevProps.isFindingAlternative === nextProps.isFindingAlternative
  );
});

// Sortable wrapper - handles drag and drop, re-renders freely without affecting video
export const SortableStreamCell = ({
  stream,
  streamKey,
  sessionId,
  isTheatreMode,
  isMuted,
  quality,
  isFindingAlternative,
  onToggleMute,
  onRefresh,
  onFindAlternative,
  onBlacklist,
  onRemove,
  onQualityDetected
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: streamKey });

  // Only apply transform during active dragging
  const style = {
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition: isDragging ? transition : undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : 1,
    height: '100%'
  };

  // Combine attributes and listeners for the drag handle
  const dragHandleProps = { ...attributes, ...listeners };

  return (
    <div ref={setNodeRef} style={style}>
      <StreamCellInner
        stream={stream}
        streamKey={streamKey}
        sessionId={sessionId}
        isTheatreMode={isTheatreMode}
        isMuted={isMuted}
        quality={quality}
        isFindingAlternative={isFindingAlternative}
        onToggleMute={onToggleMute}
        onRefresh={onRefresh}
        onFindAlternative={onFindAlternative}
        onBlacklist={onBlacklist}
        onRemove={onRemove}
        onQualityDetected={onQualityDetected}
        dragHandleProps={dragHandleProps}
      />
    </div>
  );
};

export default SortableStreamCell;
