import React from 'react';

/**
 * AdBreakChip — small overlay shown on tiles the commercial detector
 * has auto-muted. Carries an Undo affordance so a false positive can
 * be corrected with a single click: the chip's onUndo handler logs
 * the FP to the server (which relaxes that channel's thresholds and
 * opens a 60s ignore window) and unmutes the tile.
 *
 * Sits centered on the tile, just below the OSD title strip, with
 * subtle amber styling that reads "I'm holding this for you" rather
 * than alarming. Pointer-events-auto so the Undo click registers
 * even though it sits over the video.
 */
const AdBreakChip = ({ onUndo, signals = [] }) => {
  // Human-readable label of which signal(s) fired. Tells the user
  // why we muted — useful for diagnosing whether the detector is
  // jumping at audio dips vs logo changes.
  const reasonLabel = (() => {
    if (signals.length === 0) return 'auto-muted';
    return signals
      .map((s) => (s === 'audio' ? 'silence' : s === 'logo' ? 'logo' : s === 'blackframe' ? 'black' : s))
      .join(' + ');
  })();

  return (
    <div className="absolute top-10 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
      <div className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-slate-900/95 px-3 py-1.5 shadow-lg shadow-black/50 backdrop-blur-md">
        {/* Pulsing amber dot — "we're holding audio off this tile" */}
        <span className="relative inline-flex h-2 w-2 flex-shrink-0">
          <span className="absolute inset-0 rounded-full bg-amber-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-300" />
        </span>
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200">
          Ad break
        </span>
        <span className="font-mono text-[9px] text-slate-500 normal-case tracking-normal">
          · {reasonLabel}
        </span>
        {onUndo && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUndo(); }}
            className="inline-flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded-md border border-slate-700/70 bg-slate-950/60 text-slate-300 text-[9px] font-mono uppercase tracking-wider hover:bg-rose-500/15 hover:border-rose-500/40 hover:text-rose-200 transition"
            title="Not a commercial — restore audio and tell the detector"
          >
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a4 4 0 014 4v0a4 4 0 01-4 4H3m0-8l4-4m-4 4l4 4" />
            </svg>
            Undo
          </button>
        )}
      </div>
    </div>
  );
};

export default AdBreakChip;
