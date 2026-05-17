import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * TileInfoButton — the "ⓘ" affordance in the tile OSD. Click pins the
 * popover open (useful for staring at the score line for a minute);
 * hover shows it transiently. When pinned and the stream has an
 * espnEventId, polls /api/live-scores/:id every 30s for live score
 * updates.
 *
 * Lifted from the old StreamCell header row so TileOSD can compose it
 * without StreamCell still owning the tooltip code.
 */
const formatLocalStart = (iso, now = Date.now()) => {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const diffMin = Math.round((ts - now) / 60000);
  const absMin = Math.abs(diffMin);
  const timeStr = new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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

const TileInfoButton = ({ stream, quality }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [event, setEvent] = useState(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [anchorRect, setAnchorRect] = useState(null);
  const pollTimerRef = useRef(null);
  const buttonRef = useRef(null);

  const isVisible = isHovered || isPinned;
  const eventId = stream.espnEventId;

  // When the popover is visible, track the button's bounding rect so
  // the portaled popover stays glued to it across scroll/resize.
  // The popover lives in document.body so it escapes the tile's
  // overflow-hidden clip — that's how it can extend beyond the OSD
  // strip without getting cut off.
  useEffect(() => {
    if (!isVisible) return undefined;
    const update = () => {
      if (buttonRef.current) setAnchorRect(buttonRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [isVisible]);

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
      } catch (_e) { /* non-fatal */ }
      finally { if (!cancelled) setEventLoading(false); }
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

  const formatSourceType = (type) => (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Unknown');
  const truncate = (str, maxLen = 30) => (!str ? 'N/A' : str.length > maxLen ? `${str.substring(0, maxLen)}…` : str);

  const sourceHost = (() => {
    if (!stream.sourceUrl) return null;
    try { return new URL(stream.sourceUrl).host; } catch { return null; }
  })();

  const state = deriveEventState(event);
  const startInfo = formatLocalStart(event?.event_start, nowTick);
  const hasScore = event && (event.home_score != null || event.away_score != null);

  const badge = (() => {
    switch (state) {
      case 'live':      return { label: 'LIVE',      cls: 'bg-red-500/25 text-red-200 border border-red-400/40' };
      case 'upcoming':  return { label: 'UPCOMING',  cls: 'bg-amber-500/20 text-amber-200 border border-amber-400/40' };
      case 'final':     return { label: 'FINAL',     cls: 'bg-slate-500/25 text-slate-200 border border-slate-400/40' };
      case 'delayed':   return { label: 'DELAYED',   cls: 'bg-orange-500/25 text-orange-200 border border-orange-400/40' };
      case 'postponed': return { label: 'POSTPONED', cls: 'bg-slate-500/25 text-slate-400 border border-slate-400/30' };
      default: return null;
    }
  })();

  // Popover positioning — anchored to the button's right edge so the
  // panel grows leftward (avoids overflowing the screen on right-most
  // tiles in a grid). The 8px gap matches mt-2 / mb-2.
  const popoverStyle = anchorRect
    ? {
        position: 'fixed',
        top: Math.round(anchorRect.bottom + 8),
        right: Math.round(window.innerWidth - anchorRect.right),
        width: 288 // w-72
      }
    : { position: 'fixed', top: 0, right: 0, width: 288, visibility: 'hidden' };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={(e) => { e.stopPropagation(); setIsPinned((v) => !v); }}
        className={`relative inline-flex items-center justify-center w-7 h-7 rounded-md transition ${
          isPinned
            ? 'text-cyan-200 bg-cyan-500/15'
            : 'text-slate-300 hover:text-cyan-200 hover:bg-cyan-500/15'
        }`}
        title={isPinned ? 'Click to unpin info' : 'Stream info — click to pin'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      {isVisible && createPortal(
        <div
          className={`z-[9999] rounded-lg border bg-slate-900/95 shadow-xl shadow-black/60 p-3 text-xs backdrop-blur-md mv-anim-palette-in ${
            isPinned ? 'border-cyan-500/50' : 'border-slate-700'
          }`}
          style={popoverStyle}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onClick={(e) => e.stopPropagation()}
        >
          {(event || stream.espnEventName) && (
            <div className="mb-2 pb-2 border-b border-slate-800/80">
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
                {eventLoading && !event && <span className="text-[10px] text-slate-500">loading…</span>}
              </div>
              <div className="mt-1.5 font-semibold text-slate-100 leading-tight">
                {event?.event_name || stream.espnEventName || stream.name}
              </div>
              {(event?.league_name || event?.sport_type) && (
                <div className="mt-0.5 text-[10px] text-slate-500 uppercase tracking-wide">
                  {[event.league_name, event.sport_type].filter(Boolean).join(' · ')}
                </div>
              )}
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

          <div className="space-y-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Channel:</span>
              <span className="text-slate-300 truncate text-right flex-1">{stream.name}</span>
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
                  stream.sourceType === 'xtream'  ? 'bg-sky-500/20 text-sky-300' :
                  stream.sourceType === 'stalker' ? 'bg-violet-500/20 text-violet-300' :
                  stream.sourceType === 'm3u'     ? 'bg-emerald-500/20 text-emerald-300' :
                                                    'bg-slate-500/20 text-slate-300'
                }`}>
                  {formatSourceType(stream.sourceType)}
                </span>
              </span>
            </div>
            {quality && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Quality:</span>
                <span className="text-slate-300">{quality.resolution} ({quality.width}x{quality.height})</span>
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
                <span className="text-violet-300 font-mono text-[10px]">{stream.sourceMac}</span>
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

          <div className={`mt-2 pt-2 border-t border-slate-800/80 text-[10px] text-center ${
            isPinned ? 'text-cyan-400' : 'text-slate-500'
          }`}>
            {isPinned ? 'Pinned — click ⓘ to unpin' : 'Click ⓘ to pin'}
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default TileInfoButton;
