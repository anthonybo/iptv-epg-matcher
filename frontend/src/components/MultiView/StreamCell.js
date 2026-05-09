import React, { memo, useState, useEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import IPTVPlayer from '../../IPTVPlayer';
import VideoQualityBadge from '../VideoQualityBadge';

// Format a date as local time "7:10 PM" plus a short relative context
// ("starts in 2h 15m" / "started 1h ago" / "tomorrow 8:30 AM").
const formatLocalStart = (iso, now = Date.now()) => {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;

  const diffMin = Math.round((ts - now) / 60000);
  const absMin = Math.abs(diffMin);

  const timeStr = new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });

  // Include the day label when it's not "today" in the user's locale.
  const today = new Date(now);
  const when = new Date(ts);
  const sameDay = today.toDateString() === when.toDateString();
  const dayLabel = sameDay
    ? null
    : when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const fmtDur = (mins) => {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  };

  let relative;
  if (absMin < 1) relative = 'now';
  else if (diffMin > 0) relative = `starts in ${fmtDur(absMin)}`;
  else relative = `started ${fmtDur(absMin)} ago`;

  return { timeStr, dayLabel, relative, diffMin };
};

// Collapse the messy ESPN status_type into a simple UI state.
const deriveEventState = (event) => {
  if (!event) return 'unknown';
  if (event.is_live) return 'live';
  const s = (event.status_type || '').toUpperCase();
  if (s.includes('IN_PROGRESS') || s.includes('HALFTIME')) return 'live';
  if (s.includes('FINAL') || s.includes('END_')) return 'final';
  if (s.includes('POSTPONED') || s.includes('CANCELED') || s.includes('SUSPEND')) return 'postponed';
  if (s.includes('DELAYED')) return 'delayed';
  return 'upcoming';
};

// Info tooltip component for stream details
const StreamInfoTooltip = ({ stream, quality }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [event, setEvent] = useState(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const pollTimerRef = useRef(null);

  const isVisible = isHovered || isPinned;
  const eventId = stream.espnEventId;

  // When the tooltip opens, fetch the live event's current state (score,
  // clock, status_type, start/end). Refresh every 30s while open to match
  // the backend's score-update cadence. Tick a 30s clock too so the
  // "starts in …" countdown stays current without extra network.
  useEffect(() => {
    if (!isVisible || !eventId) return undefined;

    let cancelled = false;
    const fetchEvent = async () => {
      try {
        setEventLoading(true);
        const res = await fetch(`/api/live-scores/${encodeURIComponent(eventId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.success && data.score) setEvent(data.score);
      } catch (_e) {
        // Non-fatal — tooltip still shows stream metadata.
      } finally {
        if (!cancelled) setEventLoading(false);
      }
    };

    fetchEvent();
    pollTimerRef.current = setInterval(() => {
      fetchEvent();
      setNowTick(Date.now());
    }, 30000);

    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [isVisible, eventId]);

  // Format source type for display
  const formatSourceType = (type) => {
    if (!type) return 'Unknown';
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  // Truncate long strings
  const truncate = (str, maxLen = 30) => {
    if (!str) return 'N/A';
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
  };

  // Pull just the hostname out of the portal URL so two streams on the
  // same provider are easy to compare at a glance (lordstreams.live vs
  // fistikgibisin.com) without the full URL taking up a whole line.
  const sourceHost = (() => {
    if (!stream.sourceUrl) return null;
    try { return new URL(stream.sourceUrl).host; }
    catch { return null; }
  })();

  const state = deriveEventState(event);
  const startInfo = formatLocalStart(event?.event_start, nowTick);
  const hasScore = event && (event.home_score != null || event.away_score != null);

  const badge = (() => {
    switch (state) {
      case 'live':
        return { label: 'LIVE', cls: 'bg-red-500/25 text-red-200 border border-red-400/40' };
      case 'upcoming':
        return { label: 'UPCOMING', cls: 'bg-amber-500/20 text-amber-200 border border-amber-400/40' };
      case 'final':
        return { label: 'FINAL', cls: 'bg-slate-500/25 text-slate-200 border border-slate-400/40' };
      case 'delayed':
        return { label: 'DELAYED', cls: 'bg-orange-500/25 text-orange-200 border border-orange-400/40' };
      case 'postponed':
        return { label: 'POSTPONED', cls: 'bg-slate-500/25 text-slate-400 border border-slate-400/30' };
      default:
        return null;
    }
  })();

  return (
    <div className="relative">
      <button
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          setIsPinned(!isPinned);
        }}
        className={`p-0.5 rounded transition-colors ${
          isPinned
            ? 'bg-blue-500/30 text-blue-300'
            : 'hover:bg-slate-700/50 text-slate-400 hover:text-slate-200'
        }`}
        title={isPinned ? 'Click to unpin' : 'Stream info (click to pin)'}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      {isVisible && (
        <div
          className={`absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border bg-slate-900/95 shadow-xl shadow-black/50 p-3 text-xs ${
            isPinned ? 'border-blue-500/50' : 'border-slate-700'
          }`}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Event header — always comes first when we know the event */}
          {(event || stream.espnEventName) && (
            <div className="mb-2 pb-2 border-b border-slate-700">
              <div className="flex items-start gap-2">
                {badge && (
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}>
                    {badge.label}
                    {state === 'upcoming' && startInfo && startInfo.diffMin > 0 && (
                      <span className="ml-1 font-normal normal-case tracking-normal opacity-80">
                        · in {startInfo.relative.replace('starts in ', '')}
                      </span>
                    )}
                  </span>
                )}
                {eventLoading && !event && (
                  <span className="text-[10px] text-slate-500">loading…</span>
                )}
              </div>

              <div className="mt-1.5 font-semibold text-slate-100 leading-tight">
                {event?.event_name || stream.espnEventName || stream.name}
              </div>

              {(event?.league_name || event?.sport_type) && (
                <div className="mt-0.5 text-[10px] text-slate-500 uppercase tracking-wide">
                  {[event.league_name, event.sport_type].filter(Boolean).join(' · ')}
                </div>
              )}

              {/* Score — prefer team-line layout when we have it */}
              {hasScore && event.home_team && event.away_team && (
                <div className="mt-2 space-y-0.5">
                  <div className="flex justify-between items-baseline">
                    <span className="text-slate-300 truncate mr-2">{event.away_team}</span>
                    <span className={`font-mono font-semibold ${state === 'live' ? 'text-white' : 'text-slate-300'}`}>
                      {event.away_score ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-slate-300 truncate mr-2">{event.home_team}</span>
                    <span className={`font-mono font-semibold ${state === 'live' ? 'text-white' : 'text-slate-300'}`}>
                      {event.home_score ?? '—'}
                    </span>
                  </div>
                  {(event.game_status || event.game_clock) && (
                    <div className="mt-1 text-[10px] text-slate-400">
                      {[event.game_status, event.game_clock].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              )}

              {/* Start time line — always shown when we know the start */}
              {startInfo && (
                <div className="mt-2 text-[11px] text-slate-300">
                  {state === 'upcoming' ? 'Starts' : 'Started'}{' '}
                  <span className="text-slate-100 font-medium">
                    {startInfo.dayLabel ? `${startInfo.dayLabel}, ` : ''}{startInfo.timeStr}
                  </span>
                  <span className="text-slate-500"> · {startInfo.relative}</span>
                </div>
              )}
            </div>
          )}

          {/* Stream / source details (collapsed, secondary) */}
          <div className="space-y-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Channel:</span>
              <span className="text-slate-300 truncate text-right flex-1">
                {stream.name}
              </span>
            </div>

            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Source:</span>
              <span className="text-slate-300 truncate text-right flex-1">
                {stream.sourceName || `Source ${stream.sourceId}`}
              </span>
            </div>

            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Type:</span>
              <span className="text-slate-300">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  stream.sourceType === 'xtream' ? 'bg-blue-500/20 text-blue-300' :
                  stream.sourceType === 'stalker' ? 'bg-purple-500/20 text-purple-300' :
                  stream.sourceType === 'm3u' ? 'bg-green-500/20 text-green-300' :
                  'bg-slate-500/20 text-slate-300'
                }`}>
                  {formatSourceType(stream.sourceType)}
                </span>
              </span>
            </div>

            {quality && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Quality:</span>
                <span className="text-slate-300">
                  {quality.resolution} ({quality.width}x{quality.height})
                </span>
              </div>
            )}

            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Channel ID:</span>
              <span className="text-slate-400 font-mono text-[10px] truncate text-right flex-1">
                {truncate(stream.id, 25)}
              </span>
            </div>

            {sourceHost && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Host:</span>
                <span className="text-slate-300 font-mono text-[10px] truncate text-right flex-1">
                  {sourceHost}
                </span>
              </div>
            )}

            {stream.sourceUsername && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Account:</span>
                <span className="text-cyan-300 font-mono text-[10px] truncate text-right flex-1">
                  {truncate(stream.sourceUsername, 28)}
                </span>
              </div>
            )}

            {stream.sourceMac && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">MAC:</span>
                <span className="text-slate-400 font-mono text-[10px]">
                  {stream.sourceMac}
                </span>
              </div>
            )}

            {stream.searchQuery && !stream.espnEventName && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Search:</span>
                <span className="text-slate-400 truncate text-right flex-1">
                  {truncate(stream.searchQuery, 20)}
                </span>
              </div>
            )}
          </div>

          {/* Footer hint */}
          <div className={`mt-2 pt-2 border-t border-slate-700 text-[10px] text-center ${
            isPinned ? 'text-blue-400' : 'text-slate-500'
          }`}>
            {isPinned ? 'Pinned - click icon to unpin' : 'Click icon to pin'}
          </div>
        </div>
      )}
    </div>
  );
};

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
  playerType = 'mpegts-player',
  onToggleMute,
  onRefresh,
  onFindAlternative,
  onFindDifferentGame,
  onAlternateSources,
  onStreamDead,
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
              {/* Info Button */}
              <StreamInfoTooltip stream={stream} quality={quality} />
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
              {/* Alternate Sources Button — open the picker for this
                  channel's name across all the user's sources. Lets
                  the user manually swap to a different source carrying
                  the same channel without burning the auto-find chain. */}
              {onAlternateSources && (
                <button
                  onClick={onAlternateSources}
                  className="p-0.5 rounded hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-400 transition-colors"
                  title="Switch source — pick from other channels with this name"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 16l3 3m0 0l3-3m-3 3V11" />
                  </svg>
                </button>
              )}
              {/* Find Different Game Button */}
              {onFindDifferentGame && (
                <button
                  onClick={onFindDifferentGame}
                  className="p-0.5 rounded hover:bg-purple-500/20 text-slate-400 hover:text-purple-400 transition-colors"
                  title="Replace with a different live game"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                </button>
              )}
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
          playbackMethod={playerType}
          matchedChannels={{}}
          theatreMode={true}
          muted={isMuted}
          onQualityDetected={onQualityDetected}
          onStreamDead={onStreamDead}
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
    prevProps.isFindingAlternative === nextProps.isFindingAlternative &&
    prevProps.playerType === nextProps.playerType
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
  playerType = 'mpegts-player',
  onToggleMute,
  onRefresh,
  onFindAlternative,
  onFindDifferentGame,
  onAlternateSources,
  onStreamDead,
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
        playerType={playerType}
        onToggleMute={onToggleMute}
        onRefresh={onRefresh}
        onFindAlternative={onFindAlternative}
        onFindDifferentGame={onFindDifferentGame}
        onAlternateSources={onAlternateSources}
        onStreamDead={onStreamDead}
        onBlacklist={onBlacklist}
        onRemove={onRemove}
        onQualityDetected={onQualityDetected}
        dragHandleProps={dragHandleProps}
      />
    </div>
  );
};

export default SortableStreamCell;
