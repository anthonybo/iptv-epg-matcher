import React, { useEffect } from 'react';
import { LAYOUT_MODES } from './layoutModes';

/**
 * LayoutPanel — slide-in for changing the grid arrangement and other
 * "how the multi-view looks" toggles. Mirrors FavoritesPanel's
 * structure so the two surfaces feel like siblings.
 *
 *   ┌──────────────────────────┐
 *   │ ◐ LAYOUT          [ ✕ ]  │
 *   │ Grid · Featured · Dual…  │   ← visual layout-mode picker (rows)
 *   │                          │
 *   │ TOGGLES                  │
 *   │ ◯ Live scores ticker     │
 *   │ ◯ Theatre mode           │
 *   └──────────────────────────┘
 */
const LayoutPanel = ({
  isOpen,
  onClose,
  layoutMode,
  onLayoutChange,
  showTicker,
  onToggleTicker,
  isTheatreMode,
  onToggleTheatre,
  streamsCount = 0
}) => {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="absolute inset-0 z-30 bg-slate-950/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Layout"
        className="absolute top-0 left-0 bottom-0 z-40 w-[320px] flex flex-col border-r border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-[12px_0_36px_-12px_rgba(0,0,0,0.7)] mv-anim-panel-in"
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-cyan-400/30 via-cyan-400/10 to-transparent" />

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800/80">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5 text-cyan-300 flex-shrink-0">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
          <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-slate-200 flex-1">
            Layout
          </h2>
          <span className="font-mono text-[10px] tabular-nums text-slate-500">
            {streamsCount} {streamsCount === 1 ? 'tile' : 'tiles'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-100 transition"
            title="Close (Esc)"
          >
            <svg className="w-3.5 h-3.5 transition hover:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {/* Layout modes */}
          <section>
            <h3 className="px-1 mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-600">
              Arrangement
            </h3>
            <ul className="space-y-1">
              {Object.values(LAYOUT_MODES).map((mode) => {
                const active = layoutMode === mode.id;
                return (
                  <li key={mode.id}>
                    <button
                      type="button"
                      onClick={() => onLayoutChange?.(mode.id)}
                      className={`group/lay w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition ${
                        active
                          ? 'bg-cyan-500/10 ring-1 ring-cyan-400/30 text-cyan-100 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]'
                          : 'bg-slate-900/40 ring-1 ring-transparent hover:bg-slate-800/70 hover:ring-slate-700/70 text-slate-300'
                      }`}
                    >
                      <span className={`flex-shrink-0 ${active ? 'text-cyan-300' : 'text-slate-500 group-hover/lay:text-slate-300'} transition`}>
                        {mode.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold leading-tight">{mode.name}</div>
                        <div className="text-[10px] text-slate-500 leading-tight">{mode.description}</div>
                      </div>
                      {active && (
                        <svg className="w-3 h-3 text-cyan-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Toggles */}
          <section>
            <h3 className="px-1 mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-600">
              Overlays
            </h3>
            <ul className="space-y-1">
              <ToggleRow
                label="Live scores ticker"
                hint="Bottom-edge ticker with current games"
                checked={showTicker}
                onChange={onToggleTicker}
                color="emerald"
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                    <rect x="2" y="9" width="20" height="6" rx="1.5" />
                    <path d="M2 12h20" />
                  </svg>
                }
              />
              <ToggleRow
                label="Theatre mode"
                hint="Hide all chrome — pure video"
                checked={isTheatreMode}
                onChange={onToggleTheatre}
                color="amber"
                disabled={streamsCount === 0}
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                }
              />
            </ul>
          </section>
        </div>

        <div className="px-3 py-2 border-t border-slate-800/80 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-slate-600 font-mono">
          <span>Click to apply · live preview</span>
          <kbd className="px-1 py-px rounded bg-slate-900 border border-slate-800 normal-case tracking-normal text-slate-500">Esc</kbd>
        </div>
      </aside>
    </>
  );
};

const ToggleRow = ({ label, hint, checked, onChange, color = 'cyan', icon, disabled = false }) => {
  const accent = {
    emerald: { on: 'bg-emerald-500/15 ring-emerald-400/30 text-emerald-200', icon: 'text-emerald-300', track: 'bg-emerald-500/60' },
    amber:   { on: 'bg-amber-500/15  ring-amber-400/30  text-amber-200',  icon: 'text-amber-300',   track: 'bg-amber-500/60' },
    cyan:    { on: 'bg-cyan-500/15   ring-cyan-400/30   text-cyan-200',   icon: 'text-cyan-300',    track: 'bg-cyan-500/60' }
  }[color] || { on: '', icon: '', track: '' };

  return (
    <li>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        aria-pressed={checked}
        className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition ${
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : checked
            ? `${accent.on} ring-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]`
            : 'bg-slate-900/40 ring-1 ring-transparent hover:bg-slate-800/70 hover:ring-slate-700/70 text-slate-300'
        }`}
      >
        <span className={`flex-shrink-0 ${checked ? accent.icon : 'text-slate-500'} transition`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold leading-tight">{label}</div>
          <div className="text-[10px] text-slate-500 leading-tight">{hint}</div>
        </div>
        {/* Switch */}
        <span
          aria-hidden
          className={`relative inline-flex flex-shrink-0 w-7 h-4 rounded-full transition ${
            checked ? accent.track : 'bg-slate-800'
          } ring-1 ${checked ? 'ring-transparent' : 'ring-slate-700/60'}`}
        >
          <span
            className={`absolute top-0.5 transition-all duration-150 w-3 h-3 rounded-full bg-slate-100 shadow-md ${
              checked ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </span>
      </button>
    </li>
  );
};

export default LayoutPanel;
