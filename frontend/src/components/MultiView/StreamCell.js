import React, { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import IPTVPlayer from '../../IPTVPlayer';
import TileOSD from './TileOSD';

/**
 * StreamCellInner — the actual tile.
 *
 *   ┌────────────────────────────────────────┐
 *   │  ◉ Reelz · 1080p          ⋮⋮⋮          │  ← TileOSD title strip (always on, drag handle)
 *   │                                        │
 *   │             [ video ]                  │
 *   │                                        │
 *   │  🔇  ↻  ❤  │  ⇄  🔍       ⓘ  ⋯        │  ← TileOSD bottom strip (hover-revealed)
 *   └────────────────────────────────────────┘
 *
 * The container has `group/cell` so TileOSD's hover-only bottom strip
 * activates on tile hover. Everything that used to live in the old
 * 9-button header has moved into TileOSD's two strips, with the third
 * cluster of actions (info, overflow → blacklist/find-different/remove)
 * collapsed into an overflow menu so the tile feels like a player, not
 * a console.
 *
 * Heavy memoization (see `arePropsEqual` below) keeps drag operations
 * from churning the video element, which would tear playback.
 */
const StreamCellInner = memo(({
  stream,
  streamKey,
  sessionId,
  isTheatreMode,
  isMuted,
  volume = 1,
  quality,
  isFindingAlternative,
  isFavorited,
  playerType = 'mpegts-player',
  onToggleMute,
  onVolumeChange,
  onRefresh,
  onFindAlternative,
  onFindDifferentGame,
  onAlternateSources,
  onStreamDead,
  onBlacklist,
  onRemove,
  onToggleFavorite,
  onQualityDetected,
  dragHandleProps
}) => {
  return (
    <div
      className={`group/cell relative overflow-hidden h-full ${
        isTheatreMode
          ? 'bg-black'
          : 'rounded-xl border border-slate-800/70 bg-slate-900/70 shadow-2xl shadow-slate-950/40'
      }`}
    >
      {/* On-screen-display overlay. Always-on title strip + hover
          control strip. The strip absorbs all pointer events for its
          own area; everywhere else clicks pass through to the player. */}
      {!isTheatreMode && (
        <TileOSD
          stream={stream}
          quality={quality}
          isMuted={isMuted}
          volume={volume}
          isFavorited={isFavorited}
          isFindingAlternative={isFindingAlternative}
          dragHandleProps={dragHandleProps}
          onToggleMute={onToggleMute}
          onVolumeChange={onVolumeChange}
          onToggleFavorite={onToggleFavorite}
          onRefresh={onRefresh}
          onAlternateSources={onAlternateSources}
          onFindAlternative={onFindAlternative}
          onFindDifferentGame={onFindDifferentGame}
          onBlacklist={onBlacklist}
          onRemove={onRemove}
        />
      )}

      {/* Video Player */}
      <div className="h-full w-full">
        <IPTVPlayer
          sessionId={sessionId}
          selectedChannel={stream}
          playbackMethod={playerType}
          matchedChannels={{}}
          theatreMode={true}
          muted={isMuted}
          volume={volume}
          onQualityDetected={onQualityDetected}
          onStreamDead={onStreamDead}
          useResilientProxy={true}
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison — only re-render on these specific prop changes.
  // Callbacks and dragHandleProps are intentionally excluded; they
  // don't affect video playback.
  return (
    prevProps.streamKey === nextProps.streamKey &&
    prevProps.stream._refreshKey === nextProps.stream._refreshKey &&
    prevProps.isTheatreMode === nextProps.isTheatreMode &&
    prevProps.isMuted === nextProps.isMuted &&
    prevProps.volume === nextProps.volume &&
    prevProps.quality?.resolution === nextProps.quality?.resolution &&
    prevProps.isFindingAlternative === nextProps.isFindingAlternative &&
    prevProps.isFavorited === nextProps.isFavorited &&
    prevProps.playerType === nextProps.playerType
  );
});

/**
 * SortableStreamCell — the dnd-kit wrapper. Forwards every prop into
 * the memoized inner cell so drag-state changes don't tear the player.
 */
export const SortableStreamCell = ({
  stream,
  streamKey,
  sessionId,
  isTheatreMode,
  isMuted,
  volume = 1,
  quality,
  isFindingAlternative,
  isFavorited,
  playerType = 'mpegts-player',
  onToggleMute,
  onVolumeChange,
  onRefresh,
  onFindAlternative,
  onFindDifferentGame,
  onAlternateSources,
  onStreamDead,
  onBlacklist,
  onRemove,
  onToggleFavorite,
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

  const style = {
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition: isDragging ? transition : undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : 1,
    height: '100%'
  };

  const dragHandleProps = { ...attributes, ...listeners };

  return (
    <div ref={setNodeRef} style={style}>
      <StreamCellInner
        stream={stream}
        streamKey={streamKey}
        sessionId={sessionId}
        isTheatreMode={isTheatreMode}
        isMuted={isMuted}
        volume={volume}
        quality={quality}
        isFindingAlternative={isFindingAlternative}
        isFavorited={isFavorited}
        playerType={playerType}
        onToggleMute={onToggleMute}
        onVolumeChange={onVolumeChange}
        onRefresh={onRefresh}
        onFindAlternative={onFindAlternative}
        onFindDifferentGame={onFindDifferentGame}
        onAlternateSources={onAlternateSources}
        onStreamDead={onStreamDead}
        onBlacklist={onBlacklist}
        onRemove={onRemove}
        onToggleFavorite={onToggleFavorite}
        onQualityDetected={onQualityDetected}
        dragHandleProps={dragHandleProps}
      />
    </div>
  );
};

export default SortableStreamCell;
