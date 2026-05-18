import React from 'react';

/**
 * MultiViewTaskBar — vertical right-side dock for minimized drawer
 * modules. Designed as the visual counterpart to the left rail:
 * thin, dark, with mono labels and identity-colored module spines.
 *
 * Only mounts when at least one panel is in the 'minimized' state.
 * Sits inside the content column (anchored to its right edge) so it
 * doesn't span the entire viewport bottom — that keeps the live
 * scores ticker uncontested at the very bottom of the page.
 *
 * Each chip:
 *   - 2px right spine in the module's identity color
 *   - small SVG icon
 *   - LED-style status dot (cyan ping when working, emerald solid
 *     when idle/has-data)
 *   - hover slides a label tooltip to the LEFT of the chip
 *
 * Click anywhere on the chip body to restore. X (hover-revealed)
 * closes for real.
 */

const SPINE_BG = {
  cyan:    'bg-cyan-400',
  amber:   'bg-amber-300',
  rose:    'bg-rose-400',
  emerald: 'bg-emerald-400',
  indigo:  'bg-indigo-400',
  violet:  'bg-violet-400',
  sky:     'bg-sky-400'
};

const SPINE_GLOW = {
  cyan:    '0 0 6px rgba(34,211,238,0.55)',
  amber:   '0 0 6px rgba(251,191,36,0.55)',
  rose:    '0 0 6px rgba(244,63,94,0.55)',
  emerald: '0 0 6px rgba(16,185,129,0.55)',
  indigo:  '0 0 6px rgba(99,102,241,0.55)',
  violet:  '0 0 6px rgba(167,139,250,0.55)',
  sky:     '0 0 6px rgba(56,189,248,0.55)'
};

const ICON_TEXT = {
  cyan:    'text-cyan-300/90',
  amber:   'text-amber-300/90',
  rose:    'text-rose-300/90',
  emerald: 'text-emerald-300/90',
  indigo:  'text-indigo-300/90',
  violet:  'text-violet-300/90',
  sky:     'text-sky-300/90'
};

const STATUS_DOT_BG = {
  working: 'bg-cyan-400',
  idle:    'bg-emerald-400',
  error:   'bg-rose-400',
  warn:    'bg-amber-300'
};

const STATUS_TEXT = {
  working: 'text-cyan-300/90',
  idle:    'text-emerald-300/90',
  error:   'text-rose-300/90',
  warn:    'text-amber-300/90'
};

const TaskChip = ({ panel, onRestore, onClose }) => {
  const spineBg = SPINE_BG[panel.spineColor] || SPINE_BG.cyan;
  const spineGlow = SPINE_GLOW[panel.spineColor] || SPINE_GLOW.cyan;
  const iconText = ICON_TEXT[panel.spineColor] || ICON_TEXT.cyan;
  const statusKind = panel.status?.kind || 'idle';
  const dotBg = STATUS_DOT_BG[statusKind] || STATUS_DOT_BG.idle;
  const statusText = STATUS_TEXT[statusKind] || STATUS_TEXT.idle;
  const working = statusKind === 'working';

  return (
    <div className="group/chip relative inline-flex items-center mv-anim-chip-in">
      <button
        type="button"
        onClick={onRestore}
        title={`Restore ${panel.title}${panel.status?.text ? ` · ${panel.status.text}` : ''}`}
        className="relative inline-flex flex-col items-center justify-center w-10 h-10 rounded-md border border-slate-800/80 bg-slate-900/70 hover:bg-slate-800/80 hover:border-slate-700 transition shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_1px_4px_-1px_rgba(0,0,0,0.4)]"
      >
        {/* Module spine on the RIGHT edge of the chip — points
            toward the slide-in direction of the drawer (left). */}
        <span
          aria-hidden
          className={`absolute right-0 top-1 bottom-1 w-[2px] rounded-l ${spineBg}`}
          style={{ boxShadow: spineGlow }}
        />

        {/* Icon */}
        {panel.icon && (
          <span className={`w-3.5 h-3.5 flex items-center justify-center ${iconText}`}>
            {panel.icon}
          </span>
        )}

        {/* Status dot bottom-right corner — small LED. */}
        {panel.status?.text && (
          <span className={`absolute bottom-0.5 left-1.5 inline-flex h-1.5 w-1.5 rounded-full ${dotBg}`}>
            {working && (
              <>
                <span className="absolute inset-0 rounded-full bg-cyan-400 opacity-60 animate-ping" />
                <span className="absolute inset-0 rounded-full bg-cyan-300 opacity-90 mv-anim-led-breath" />
              </>
            )}
          </span>
        )}
      </button>

      {/* Hover tooltip — title + live status, slides in from the right. */}
      <div className="pointer-events-none absolute right-full top-1/2 -translate-y-1/2 mr-2 opacity-0 -translate-x-1 group-hover/chip:opacity-100 group-hover/chip:translate-x-0 transition duration-150 z-10">
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-900/95 border border-slate-700 shadow-lg whitespace-nowrap">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-200">
            {panel.title}
          </span>
          {panel.status?.text && (
            <span className={`font-mono text-[10px] tabular-nums ${statusText} pl-2 border-l border-slate-700`}>
              {panel.status.text}
            </span>
          )}
        </div>
      </div>

      {/* Close (X) — appears on hover, top-right outside the chip. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose?.(); }}
        title="Close · discard this panel"
        className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-slate-950 border border-slate-700 text-slate-500 opacity-0 group-hover/chip:opacity-100 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-500/50 transition flex items-center justify-center shadow"
      >
        <svg className="w-2 h-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

const MultiViewTaskBar = ({ panels = [], onRestore, onClose, topOffset = 0, bottomOffset = 0 }) => {
  if (!panels.length) return null;

  return (
    <div
      className="absolute right-0 z-50 w-12 flex flex-col items-center gap-1.5 px-1 py-2 bg-slate-950 border-l border-slate-800/80"
      style={{
        top: topOffset,
        bottom: bottomOffset,
        boxShadow: 'inset 1px 0 0 rgba(34,211,238,0.06), -8px 0 24px -16px rgba(0,0,0,0.6)'
      }}
      role="region"
      aria-label="Docked panels"
    >
      {/* Section marker at the top — mono label that sets the metaphor.
          Rotated -90deg so it reads vertically along the dock spine. */}
      <div className="w-full flex flex-col items-center gap-1 pb-2 border-b border-slate-800/80">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-3 h-3 text-slate-600">
          <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-slate-700 tabular-nums">
          {String(panels.length).padStart(2, '0')}
        </span>
      </div>

      {/* Chips stack vertically. Overflow scrolls (hidden scrollbar)
          so an absurd number of minimized panels still fits. */}
      <div className="flex-1 min-h-0 w-full flex flex-col items-center gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {panels.map((p) => (
          <TaskChip
            key={p.id}
            panel={p}
            onRestore={() => onRestore?.(p.id)}
            onClose={() => onClose?.(p.id)}
          />
        ))}
      </div>
    </div>
  );
};

export default React.memo(MultiViewTaskBar);
