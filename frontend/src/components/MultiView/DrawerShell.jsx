import React, { useEffect } from 'react';

/**
 * DrawerShell — shared chrome for every multi-view side panel.
 *
 * Designed as a "rack module" that slides in from the rail's right
 * edge. Two minimize affordances so the user is never more than a
 * click away from docking the panel:
 *
 *   1. Header bar — title + minimize/close buttons. Sticky at the
 *      top of the drawer; sized big enough (32px tap targets) to
 *      be unmissable.
 *
 *   2. Floating minimize FAB at the bottom-right of the drawer
 *      body. Useful when the user is deep in scrollable content
 *      (search results, settings sections) and wants to dock without
 *      scrolling back up. Mirrors the header's minimize action.
 *
 * Visibility model:
 *   - `isMounted` controls whether anything renders. Minimized
 *     panels stay mounted (just `display: none`) so children's
 *     async work keeps running.
 *   - `isVisible` flips visible state.
 *
 * Keyboard: Esc minimizes (default — keeps work alive in the dock).
 * Shift+Esc closes for real.
 */
const SPINE_GRADIENTS = {
  cyan:    'from-cyan-300/70 via-cyan-400/20 to-transparent',
  amber:   'from-amber-300/70 via-amber-400/20 to-transparent',
  rose:    'from-rose-300/70 via-rose-400/20 to-transparent',
  emerald: 'from-emerald-300/70 via-emerald-400/20 to-transparent',
  indigo:  'from-indigo-300/70 via-indigo-400/20 to-transparent',
  violet:  'from-violet-300/70 via-violet-400/20 to-transparent',
  sky:     'from-sky-300/70 via-sky-400/20 to-transparent'
};

const SPINE_GLOWS = {
  cyan:    'rgba(34,211,238,0.18)',
  amber:   'rgba(251,191,36,0.18)',
  rose:    'rgba(244,63,94,0.18)',
  emerald: 'rgba(16,185,129,0.18)',
  indigo:  'rgba(99,102,241,0.18)',
  violet:  'rgba(167,139,250,0.18)',
  sky:     'rgba(56,189,248,0.18)'
};

const SPINE_SOLIDS = {
  cyan:    'bg-cyan-300',
  amber:   'bg-amber-300',
  rose:    'bg-rose-300',
  emerald: 'bg-emerald-300',
  indigo:  'bg-indigo-300',
  violet:  'bg-violet-300',
  sky:     'bg-sky-300'
};

const ICON_TEXT = {
  cyan:    'text-cyan-300',
  amber:   'text-amber-300',
  rose:    'text-rose-300',
  emerald: 'text-emerald-300',
  indigo:  'text-indigo-300',
  violet:  'text-violet-300',
  sky:     'text-sky-300'
};

const ICON_BG = {
  cyan:    'bg-cyan-500/10 border-cyan-500/30',
  amber:   'bg-amber-500/10 border-amber-500/30',
  rose:    'bg-rose-500/10 border-rose-500/30',
  emerald: 'bg-emerald-500/10 border-emerald-500/30',
  indigo:  'bg-indigo-500/10 border-indigo-500/30',
  violet:  'bg-violet-500/10 border-violet-500/30',
  sky:     'bg-sky-500/10 border-sky-500/30'
};

const STATUS_DOT_BG = {
  working: 'bg-cyan-400',
  idle:    'bg-emerald-400',
  error:   'bg-rose-400',
  warn:    'bg-amber-300'
};

const STATUS_PILL = {
  working: 'border-cyan-500/30 text-cyan-200 bg-cyan-500/[0.06]',
  idle:    'border-emerald-500/30 text-emerald-200 bg-emerald-500/[0.06]',
  error:   'border-rose-500/40 text-rose-200 bg-rose-500/[0.08]',
  warn:    'border-amber-500/30 text-amber-200 bg-amber-500/[0.06]'
};

const DrawerShell = ({
  isMounted,
  isVisible,
  width = 480,
  topGap = 0,
  bottomGap = 0,
  title,
  subtitle,
  icon,
  spineColor = 'cyan',
  status,
  badge,
  onMinimize,
  onClose,
  footer,
  children,
  onVisibleFocus,
  hasOpenedBefore = false
}) => {
  useEffect(() => {
    if (!isVisible) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (e.shiftKey) onClose?.();
        else onMinimize?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVisible, onMinimize, onClose]);

  useEffect(() => {
    if (!isVisible) return undefined;
    const t = setTimeout(() => onVisibleFocus?.(), 60);
    return () => clearTimeout(t);
  }, [isVisible, onVisibleFocus]);

  if (!isMounted) return null;

  const spine = SPINE_GRADIENTS[spineColor] || SPINE_GRADIENTS.cyan;
  const spineGlow = SPINE_GLOWS[spineColor] || SPINE_GLOWS.cyan;
  const spineSolid = SPINE_SOLIDS[spineColor] || SPINE_SOLIDS.cyan;
  const iconText = ICON_TEXT[spineColor] || ICON_TEXT.cyan;
  const iconBg = ICON_BG[spineColor] || ICON_BG.cyan;
  const statusKind = status?.kind || 'idle';
  const dotBg = STATUS_DOT_BG[statusKind] || STATUS_DOT_BG.idle;
  const pillCls = STATUS_PILL[statusKind] || STATUS_PILL.idle;
  const animClass = hasOpenedBefore ? 'mv-anim-drawer-restore' : 'mv-anim-drawer-in';

  return (
    <aside
      role="dialog"
      aria-label={title}
      aria-hidden={!isVisible}
      style={{
        width: `${width}px`,
        top: topGap,
        bottom: bottomGap,
        boxShadow: isVisible
          ? `20px 0 50px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(148,163,184,0.04), inset -1px 0 0 ${spineGlow}`
          : 'none'
      }}
      className={`absolute left-0 z-40 flex flex-col border-r border-slate-800/80 bg-slate-950 ${
        isVisible ? animClass : 'hidden'
      }`}
    >
      {/* Right-edge module spine — colored gradient hairline that
          identifies the module. Slim LED at the top echoes the
          taskbar chip's left spine. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b ${spine}`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute right-0 top-4 w-px h-8 ${spineSolid}`}
        style={{ boxShadow: `0 0 10px ${spineGlow.replace('0.18', '0.7')}` }}
      />

      {/* ── HEADER — big, clear, sticky ───────────────────────────── */}
      <header
        className="sticky top-0 z-20 flex-shrink-0 border-b border-slate-800/80 bg-slate-950"
        style={{
          // Subtle ambient gradient tinted to the spine color so each
          // drawer's identity reads even at a glance.
          backgroundImage: `linear-gradient(180deg, ${spineGlow} -200%, transparent 80%)`
        }}
      >
        {/* Title row — generous 48px tall so the buttons are real
            click targets, and the module title reads as a chapter
            heading rather than a footnote. */}
        <div className="flex items-center gap-3 px-4 h-12">
          {icon && (
            <span
              className={`flex-shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-md border ${iconBg} ${iconText}`}
            >
              <span className="w-3.5 h-3.5">{icon}</span>
            </span>
          )}

          <div className="min-w-0 flex-1">
            <h2 className="font-mono text-[12px] font-bold uppercase tracking-[0.22em] text-slate-100 truncate leading-tight">
              {title}
            </h2>
            {subtitle && (
              <div className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-slate-500 truncate leading-tight mt-0.5">
                {subtitle}
              </div>
            )}
          </div>

          {badge}

          {/* Status pill — visible whenever the panel is reporting
              live state. */}
          {status?.text && (
            <span
              className={`hidden md:inline-flex items-center gap-1.5 px-2 py-1 rounded-md border font-mono text-[10px] tabular-nums ${pillCls}`}
              title={status.text}
            >
              <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotBg}`}>
                {statusKind === 'working' && (
                  <span className="absolute inset-0 rounded-full bg-cyan-400 opacity-60 animate-ping" />
                )}
              </span>
              <span className="truncate max-w-[140px]">{status.text}</span>
            </span>
          )}

          {/* Button cluster — sized to be unmissable. 32×32 hit areas
              with explicit borders so they don't look like text. */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={onMinimize}
              title="Minimize · keeps running in the dock (Esc)"
              aria-label="Minimize"
              className="group/min h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800 hover:border-slate-700 hover:text-cyan-200 transition shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
            >
              <svg className="w-3.5 h-3.5 transition group-hover/min:-translate-y-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 19h14" />
              </svg>
            </button>

            <button
              type="button"
              onClick={onClose}
              title="Close · ends the session (Shift+Esc)"
              aria-label="Close"
              className="group/x h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-rose-500/15 hover:border-rose-500/40 hover:text-rose-200 transition shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
            >
              <svg className="w-3.5 h-3.5 transition group-hover/x:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        {children}

        {/* Floating MINIMIZE FAB — always reachable regardless of how
            deep the body is scrolled. Bottom-right corner, just above
            the drawer footer (if present). Mirrors the header's
            minimize action so users with mouse focus on the body
            never have to mouse back up. */}
        <button
          type="button"
          onClick={onMinimize}
          title="Minimize (Esc)"
          aria-label="Minimize"
          className="group/fab pointer-events-auto absolute bottom-3 right-3 z-30 h-9 px-3 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:border-slate-600 hover:text-cyan-200 transition shadow-[0_8px_20px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.05)]"
        >
          <svg className="w-3 h-3 transition group-hover/fab:-translate-y-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 19h14" />
          </svg>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Dock</span>
          <kbd className="ml-0.5 px-1 py-px rounded bg-slate-950/80 border border-slate-700 font-mono text-[9px] normal-case tracking-normal text-slate-500">Esc</kbd>
        </button>
      </div>

      {/* ── Footer (optional) ─────────────────────────────────────── */}
      {footer && (
        <div className="flex-shrink-0 px-3 py-2 border-t border-slate-800/80 text-[9px] uppercase tracking-[0.18em] text-slate-600 font-mono">
          {footer}
        </div>
      )}
    </aside>
  );
};

// Memo so the drawer chrome doesn't re-render when the parent
// re-renders for unrelated reasons (commercial-orchestrator audio
// samples at 4Hz, ticker timer ticks, etc.). Props need to be
// stable for this to be effective — the parent uses useCallback
// for all event handlers.
export default React.memo(DrawerShell);
