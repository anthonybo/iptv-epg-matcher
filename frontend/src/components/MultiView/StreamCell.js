import React, { memo, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import IPTVPlayer from '../../IPTVPlayer';
import TileOSD from './TileOSD';
import AdBreakChip from './AdBreakChip';

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
  isAutoMuted = false,
  adSignals = [],
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
  onUndoAdMute,
  onVideoElement,
  onQualityDetected,
  dragHandleProps
}) => {
  // YouTube tiles use a dedicated init path that resolves a fresh
  // HLS URL via yt-dlp on each play. The IPTV-side resilient proxy
  // / mpegts path doesn't apply.
  const isYoutube = stream?.sourceType === 'youtube';
  const effectivePlayerType = isYoutube ? 'youtube-hls' : playerType;
  const effectiveUseResilientProxy = isYoutube ? false : true;
  return (
    <div
      className={`group/cell relative overflow-hidden h-full ${
        isTheatreMode
          ? 'bg-black'
          : 'rounded-xl border border-slate-800/70 bg-slate-900/70 shadow-2xl shadow-slate-950/40'
      }`}
    >
      {/* Ad-break chip — appears when the commercial detector has
          muted this tile. Undo button logs a false-positive and
          unmutes. Mounted above the OSD's title strip vertically so
          it doesn't get covered by it. */}
      {!isTheatreMode && isAutoMuted && (
        <AdBreakChip signals={adSignals} onUndo={onUndoAdMute} />
      )}

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
          /* IPTV-only actions — null for YouTube tiles so the buttons
             hide entirely. Find-Alternative and Alternate-Sources both
             walk the IPTV catalog; Find-Different-Game is sports-list
             driven; Blacklist filters the IPTV random-fill pool. None
             of those map to a YouTube channel. */
          onAlternateSources={isYoutube ? null : onAlternateSources}
          onFindAlternative={isYoutube ? null : onFindAlternative}
          onFindDifferentGame={isYoutube ? null : onFindDifferentGame}
          onBlacklist={isYoutube ? null : onBlacklist}
          onRemove={onRemove}
        />
      )}

      {/* Video Player */}
      <div className="h-full w-full">
        <IPTVPlayer
          sessionId={sessionId}
          selectedChannel={stream}
          playbackMethod={effectivePlayerType}
          matchedChannels={{}}
          theatreMode={true}
          muted={isMuted}
          volume={volume}
          onQualityDetected={onQualityDetected}
          onStreamDead={onStreamDead}
          onVideoElement={isYoutube ? null : onVideoElement}
          useResilientProxy={effectiveUseResilientProxy}
          /* Cancel button on the loading overlay routes to onRemove
             so the user can ALWAYS bail out of a hung tile, even when
             the overlay would otherwise be covering the OSD's × button. */
          onCancel={onRemove}
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
    prevProps.isAutoMuted === nextProps.isAutoMuted &&
    prevProps.adSignals === nextProps.adSignals &&
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
  isAutoMuted = false,
  adSignals = [],
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
  onUndoAdMute,
  onVideoElement,
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
        isAutoMuted={isAutoMuted}
        adSignals={adSignals}
        playerType={playerType}
        onToggleMute={onToggleMute}
        onVolumeChange={onVolumeChange}
        onUndoAdMute={onUndoAdMute}
        onVideoElement={onVideoElement}
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
