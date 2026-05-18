import React, { useEffect, useRef, useState } from 'react';
import VideoQualityBadge from '../VideoQualityBadge';
import TileInfoButton from './TileInfoButton';

/**
 * TileOSD — the per-tile on-screen-display for a multi-view player.
 *
 * Two surfaces:
 *   1. **Title strip** — always-on, 24px tall, gradient-masked over the
 *      top of the video. Holds the channel slate (logo + name + quality
 *      + a small "LIVE" pulse). The strip is also the **drag handle**,
 *      so you grab anywhere along the top edge.
 *   2. **Control strip** — bottom, 40px tall, gradient-masked. Hidden
 *      at rest, fades + slides in on tile hover. Contains the per-tile
 *      controls users reach for most: mute, refresh, ♥, alt-sources,
 *      find-alternative, plus an overflow "⋯" menu for the rest
 *      (blacklist, find-different-game, remove).
 *
 * The cell underneath this overlay is just the video. Zero buttons at
 * rest = video dominates the visual field; you only see chrome when
 * you intend to.
 *
 * Heart toggle uses the bouncing pop animation (mv-anim-heart-pop) so
 * saving a favorite is a noticeable moment, not a silent color swap.
 */
const TileOSD = ({
  stream,
  quality,
  isMuted,
  volume = 1,
  isFavorited,
  isFindingAlternative,
  dragHandleProps,
  onToggleMute,
  onVolumeChange,
  onToggleFavorite,
  onRefresh,
  onAlternateSources,
  onFindAlternative,
  onFindDifferentGame,
  onBlacklist,
  onRemove
}) => {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  const overflowRef = useRef(null);
  const wasFavorited = useRef(isFavorited);

  // Close overflow on outside click / Esc.
  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onClick = (e) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target)) {
        setOverflowOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setOverflowOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowOpen]);

  // Fire the heart-pop burst only on the off→on transition. Re-clicking
  // off doesn't burst (would feel wrong celebrating unfavoriting).
  const handleHeart = (e) => {
    e?.stopPropagation?.();
    if (!wasFavorited.current) setHeartBurst((b) => b + 1);
    wasFavorited.current = !wasFavorited.current;
    onToggleFavorite?.(e);
  };

  return (
    <div
      className="absolute top-0 left-0 right-0 z-20 px-2 py-1 pointer-events-auto"
      style={{
        background:
          'linear-gradient(to bottom, rgba(2,6,23,0.92) 0%, rgba(2,6,23,0.7) 55%, transparent 100%)'
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        {/* ─── LEFT: title slate + drag handle ──────────────────
            Only this region carries the drag listeners — the right
            cluster needs free pointer events for clicks. */}
        <div
          {...(dragHandleProps || {})}
          className="flex items-center gap-2 min-w-0 flex-1 cursor-grab active:cursor-grabbing select-none"
        >
          {/* Source-type rail dot — matches the picker/strip motif. */}
          <span
            className={`relative flex h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              stream.sourceType === 'xtream'  ? 'bg-sky-400' :
              stream.sourceType === 'stalker' ? 'bg-violet-400' :
              stream.sourceType === 'm3u'     ? 'bg-emerald-400' :
                                                'bg-slate-400'
            }`}
            title={stream.sourceType || 'source'}
          >
            <span className="absolute inset-0 rounded-full opacity-50 animate-ping bg-current" />
          </span>

          {stream.logo && (
            <img
              src={stream.logo}
              alt=""
              className="w-4 h-4 rounded object-contain flex-shrink-0 opacity-90"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}

          <span className="text-[12px] font-semibold text-slate-100 truncate leading-tight min-w-0">
            {stream.name}
          </span>

          {quality && (
            <span className="flex-shrink-0">
              <VideoQualityBadge quality={quality} size="xs" />
            </span>
          )}
        </div>

        {/* ─── RIGHT: controls ───────────────────────────────────
            No drag listeners here, so buttons remain clickable. The
            cluster is always visible to satisfy "I want to see what
            I can do at a glance." Volume + overflow popovers open
            DOWNWARD into the video area so they don't get clipped
            at the top of the tile. */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <VolumeControl
            isMuted={isMuted}
            volume={volume}
            onToggleMute={onToggleMute}
            onVolumeChange={onVolumeChange}
          />

          <OSDButton onClick={onRefresh} title="Refresh stream" color="cyan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </OSDButton>

          {/* Heart with pop motion. */}
          {onToggleFavorite && (
            <OSDButton
              onClick={handleHeart}
              title={isFavorited ? 'Saved · click to unfavorite' : 'Save to favorites'}
              color={isFavorited ? 'amber-on' : 'amber'}
              aria-pressed={isFavorited}
            >
              <span className="relative inline-flex items-center justify-center">
                {heartBurst > 0 && (
                  <>
                    <span
                      key={`ring-${heartBurst}`}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-full mv-anim-heart-ring"
                      style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.55) 0%, transparent 60%)' }}
                    />
                    {[0, 72, 144, 216, 288].map((deg) => (
                      <span
                        key={`spark-${heartBurst}-${deg}`}
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-1/2 w-1 h-1 rounded-full bg-amber-300 mv-anim-heart-spark"
                        style={{ '--spark-angle': `${deg}deg` }}
                      />
                    ))}
                  </>
                )}
                <svg
                  viewBox="0 0 24 24"
                  fill={isFavorited ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth={isFavorited ? 0 : 2}
                  className={`w-3.5 h-3.5 transition-transform ${heartBurst > 0 ? 'mv-anim-heart-pop' : ''}`}
                  key={`heart-${heartBurst}`}
                >
                  <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
                </svg>
              </span>
            </OSDButton>
          )}

          <span aria-hidden className="mx-0.5 h-4 w-px bg-slate-700/70" />

          {onAlternateSources && (
            <OSDButton onClick={onAlternateSources} title="Switch source — alternate accounts carrying this channel" color="emerald">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 16l3 3m0 0l3-3m-3 3V11" />
              </svg>
            </OSDButton>
          )}

          <OSDButton
            onClick={onFindAlternative}
            disabled={isFindingAlternative}
            title="Find another stream (if blacked out)"
            color="cyan"
            active={isFindingAlternative}
          >
            {isFindingAlternative ? (
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 animate-spin" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            )}
          </OSDButton>

          <TileInfoButton stream={stream} quality={quality} />

          {/* Overflow — opens DOWNWARD now that the strip lives on the
              top edge. */}
          <div ref={overflowRef} className="relative">
            <OSDButton
              onClick={(e) => { e.stopPropagation(); setOverflowOpen((v) => !v); }}
              title="More actions"
              color="slate"
              active={overflowOpen}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
              </svg>
            </OSDButton>

            {/* Removed — moved out so this map keeps the right anchor. */}
            {overflowOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-1.5 w-48 rounded-lg border border-slate-700/80 bg-slate-900/95 shadow-2xl shadow-black/60 backdrop-blur-md overflow-hidden mv-anim-palette-in z-30"
              >
                {onFindDifferentGame && (
                  <OverflowItem
                    onClick={() => { onFindDifferentGame?.(); setOverflowOpen(false); }}
                    label="Different game"
                    hint="Replace with another live event"
                    color="violet"
                    icon={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    }
                  />
                )}
                <OverflowItem
                  onClick={() => { onBlacklist?.(); setOverflowOpen(false); }}
                  label="Blacklist"
                  hint="Skip this channel in random/auto-fill"
                  color="amber"
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                  }
                />
              </div>
            )}
          </div>

          {/* Hairline separator before the destructive close action so
              it visually reads as its own group rather than another
              setting toggle. */}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-slate-700/70" />

          {/* Dedicated REMOVE TILE button — primary action gets a
              first-class affordance rather than being buried under
              the overflow. Rose-toned so the destructive intent reads
              at a glance; the icon rotates -90° on hover for a small
              "this will eject" cue. */}
          {onRemove && (
            <OSDButton
              onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
              title="Remove tile from grid"
              color="rose"
              aria-label="Remove tile"
            >
              <svg className="w-3.5 h-3.5 transition group-hover:rotate-90" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </OSDButton>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────

/**
 * OSDButton — small icon button used inside the bottom control strip.
 * The color prop selects the hover/active palette; "amber-on" is the
 * filled-heart state where the icon is already colored at rest.
 */
const OSDButton = ({ children, onClick, title, color = 'slate', active = false, disabled = false, ...rest }) => {
  const palette = {
    slate:    { rest: 'text-slate-300 hover:text-slate-100 hover:bg-slate-700/50', active: 'text-slate-100 bg-slate-700/60' },
    cyan:     { rest: 'text-slate-300 hover:text-cyan-200 hover:bg-cyan-500/15',   active: 'text-cyan-200 bg-cyan-500/15' },
    emerald:  { rest: 'text-slate-300 hover:text-emerald-200 hover:bg-emerald-500/15', active: 'text-emerald-200 bg-emerald-500/15' },
    violet:   { rest: 'text-slate-300 hover:text-violet-200 hover:bg-violet-500/15', active: 'text-violet-200 bg-violet-500/15' },
    amber:    { rest: 'text-slate-300 hover:text-amber-200 hover:bg-amber-500/15',   active: 'text-amber-200 bg-amber-500/15' },
    'amber-on': { rest: 'text-amber-300 hover:text-amber-200 hover:bg-amber-500/15', active: 'text-amber-200 bg-amber-500/15' },
    rose:     { rest: 'text-slate-300 hover:text-rose-200 hover:bg-rose-500/15',     active: 'text-rose-200 bg-rose-500/15' }
  }[color] || { rest: 'text-slate-300 hover:bg-slate-700/50', active: 'text-slate-100 bg-slate-700/60' };

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      title={title}
      disabled={disabled}
      className={`relative inline-flex items-center justify-center w-7 h-7 rounded-md transition ${
        disabled ? 'opacity-50 cursor-not-allowed' : (active ? palette.active : palette.rest)
      }`}
      {...rest}
    >
      {children}
    </button>
  );
};

/**
 * VolumeControl — mute toggle + hover-popover horizontal slider.
 *
 *   ┌────────────────────────────┐
 *   │ 🔈  ██████░░░░░░░░ 60%     │   ← popover, appears above the icon
 *   └────────────────────────────┘
 *        [ 🔈 ]                       ← click toggles mute
 *
 * Click the speaker icon → toggles mute. Hover → slider popover slides
 * in above (the bottom OSD strip is anchored to the tile's bottom, so
 * popovers expand upward over the video). Sliding the thumb invokes
 * onVolumeChange; the hook auto-unmutes when volume > 0.
 */
const VolumeControl = ({ isMuted, volume, onToggleMute, onVolumeChange }) => {
  const [open, setOpen] = useState(false);
  const hideTimerRef = useRef(null);

  const show = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setOpen(true);
  };
  const hideSoon = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setOpen(false), 180);
  };
  // Clean up timer on unmount so we don't try to setState after unmount.
  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  const effective = isMuted ? 0 : Math.max(0, Math.min(1, Number(volume) || 0));
  const pct = Math.round(effective * 100);

  // Pick the icon based on effective level — gives the user a glance-able
  // signal that matches what they'd hear if they unmuted.
  const renderIcon = () => {
    if (isMuted || effective === 0) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      );
    }
    if (effective < 0.5) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
      </svg>
    );
  };

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hideSoon}>
      <OSDButton
        onClick={onToggleMute}
        title={isMuted ? 'Unmute' : 'Mute'}
        color="slate"
        active={isMuted}
      >
        {renderIcon()}
      </OSDButton>

      {open && onVolumeChange && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 mt-1 flex items-center gap-2 px-2 py-1.5 rounded-md border border-slate-700/80 bg-slate-900/95 shadow-2xl shadow-black/60 backdrop-blur-md mv-anim-osd-in z-30"
          onMouseEnter={show}
          onMouseLeave={hideSoon}
        >
          {/* Slider rail with amber fill — custom-styled native range
              input so accessibility + keyboard arrows work for free. */}
          <div className="relative w-28 h-3 flex items-center">
            <div className="absolute inset-x-0 h-1 rounded-full bg-slate-800/90 ring-1 ring-slate-700/60" />
            <div
              className="absolute left-0 h-1 rounded-full bg-gradient-to-r from-amber-300 to-amber-500 shadow-[0_0_4px_rgba(251,191,36,0.4)] transition-[width] duration-75"
              style={{ width: `${pct}%` }}
            />
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={pct}
              onChange={(e) => {
                const next = Number(e.target.value) / 100;
                onVolumeChange?.(next);
              }}
              aria-label="Volume"
              className="relative w-full h-3 appearance-none bg-transparent cursor-pointer focus:outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-200 [&::-webkit-slider-thumb]:ring-2 [&::-webkit-slider-thumb]:ring-amber-400/50 [&::-webkit-slider-thumb]:shadow-[0_0_4px_rgba(251,191,36,0.6)] [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-amber-200 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-amber-400/50"
            />
          </div>
          {/* Live percentage readout — mono so the eye doesn't track digit
              wiggle as the user drags. */}
          <span className="font-mono text-[10px] tabular-nums text-amber-200 w-8 text-right">
            {pct}
          </span>
        </div>
      )}
    </div>
  );
};

const OverflowItem = ({ icon, label, hint, color = 'slate', onClick }) => {
  const accent = {
    slate:  'text-slate-400 group-hover/ovf:text-slate-200',
    cyan:   'text-cyan-300/80 group-hover/ovf:text-cyan-200',
    amber:  'text-amber-300/80 group-hover/ovf:text-amber-200',
    violet: 'text-violet-300/80 group-hover/ovf:text-violet-200',
    rose:   'text-rose-300/80 group-hover/ovf:text-rose-200'
  }[color] || 'text-slate-400';

  return (
    <button
      type="button"
      onClick={onClick}
      className="group/ovf flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-800/80 transition"
    >
      <span className={`flex-shrink-0 ${accent}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-slate-200 truncate">{label}</span>
        <span className="block text-[10px] text-slate-500 truncate">{hint}</span>
      </span>
    </button>
  );
};

export default TileOSD;
