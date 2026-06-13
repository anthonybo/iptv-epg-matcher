import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * MultiViewRail — the patchbay-style left dock for the multi-view page.
 *
 * Sits at the inner left edge of the page (not the app edge — the
 * global hamburger lives there). 52px wide, four verb-named sections
 * separated by hairline rules + tiny mono labels. Each icon is a
 * pressed-button-style square; active state is recessed with an
 * amber accent on the inner edge (the rail's right side).
 *
 * Action semantics:
 *   - Toggle icons (theatre)            → click flips a boolean, glows when on
 *   - Modal icons (trending, settings…) → click runs the open* handler
 *   - Panel icons (favorites, layout)   → click toggles a slide-in panel; the
 *                                         parent owns `activePanel` and decides
 *                                         which panel is mounted
 *   - Action icons (autofill, clear…)   → click runs the action directly
 *
 * Tooltips on hover slide out from the rail's right edge with a kbd
 * hint if the action has a palette shortcut. The rail itself stays
 * visible when a panel is open; only the underlying tiles get the
 * slide-in overlay.
 */

const SECTIONS = [
  {
    key: 'find',
    label: 'Find',
    items: [
      { id: 'search',         kind: 'action', label: 'Search channel',     hint: '/',  icon: ICON_SEARCH() },
      { id: 'autofill',       kind: 'action', label: 'AutoFill tiles',     icon: ICON_BOLT() },
      { id: 'picker',         kind: 'action', label: 'Open picker',        hint: '⌘K', icon: ICON_GRID_BOX() }
    ]
  },
  {
    key: 'discover',
    label: 'Discover',
    items: [
      { id: 'trending',       kind: 'modal',  label: 'Trending now',       icon: ICON_FLAME() },
      { id: 'all-games',      kind: 'modal',  label: 'All games today',    icon: ICON_BALL() },
      { id: 'breaking',       kind: 'modal',  label: 'Breaking events',    icon: ICON_BREAKING() },
      { id: 'youtube',        kind: 'modal',  label: 'YouTube channel',    icon: ICON_YOUTUBE() },
      { id: 'coverage',       kind: 'modal',  label: 'Broadcaster coverage', icon: ICON_BROADCAST() },
      { id: 'social-feed',    kind: 'panel',  label: 'Live chatter (#OPLive)', accent: 'cyan', icon: ICON_CHAT() },
      { id: 'local-news',     kind: 'action', label: 'Local news',         icon: ICON_NEWS() }
    ]
  },
  {
    key: 'saved',
    label: 'Saved',
    items: [
      { id: 'favorites',      kind: 'panel',  label: 'Favorites',          accent: 'amber', icon: ICON_HEART() },
      { id: 'blacklist',      kind: 'modal',  label: 'Blacklist',          icon: ICON_BAN() },
      { id: 'settings',       kind: 'modal',  label: 'Settings',           icon: ICON_GEAR() }
    ]
  },
  {
    key: 'view',
    label: 'View',
    items: [
      { id: 'layout',         kind: 'panel',  label: 'Layout',             icon: ICON_LAYOUT() },
      { id: 'theatre',        kind: 'toggle', label: 'Theatre mode',       accent: 'amber', icon: ICON_THEATRE() },
      { id: 'clear',          kind: 'action', label: 'Clear all',          accent: 'rose',  icon: ICON_TRASH() }
    ]
  }
];

const MultiViewRail = ({
  // Modal openers
  onOpenTrending,
  onOpenAllGames,
  onOpenBreaking,
  onOpenYouTube,
  onOpenCoverage,
  onToggleFeed,
  onOpenBlacklist,
  onOpenSettings,
  onOpenClearConfirm,
  // Action runners
  onSearch,
  onAutoFill,
  onLocalNews,
  onOpenPicker,
  onOpenPalette,
  // Panel toggles
  activePanel,           // 'favorites' | 'layout' | null
  onTogglePanel,         // (id) => void
  feedOpen = false,      // live-chatter side panel open?
  // Toggle states + setters
  isTheatreMode,
  onToggleTheatre,
  // Status props (for icon badges or disabled state)
  hasStreams = false,
  blacklistCount = 0,
  favoritesCount = 0,
  searchingNews = false,
  autoFillProgress = null,
  isSearching = false
}) => {
  const handle = (item) => {
    switch (item.id) {
      case 'search':     return onSearch?.();
      case 'autofill':   return onAutoFill?.();
      case 'picker':     return onOpenPicker?.();
      case 'trending':   return onOpenTrending?.();
      case 'all-games':  return onOpenAllGames?.();
      case 'breaking':   return onOpenBreaking?.();
      case 'youtube':    return onOpenYouTube?.();
      case 'coverage':   return onOpenCoverage?.();
      case 'social-feed': return onToggleFeed?.();
      case 'local-news': return onLocalNews?.();
      case 'favorites':  return onTogglePanel?.('favorites');
      case 'blacklist':  return onOpenBlacklist?.();
      case 'settings':   return onOpenSettings?.();
      case 'layout':     return onTogglePanel?.('layout');
      case 'theatre':    return onToggleTheatre?.();
      case 'clear':      return onOpenClearConfirm?.();
      default:           return undefined;
    }
  };

  // Derive runtime state for each item so the rail renders the right
  // active treatment without piping a 20-field state object.
  const isActive = (item) => {
    // The live-chatter feed is a standalone side column (not part of the
    // single-drawer activePanel set), so it tracks its own open flag.
    if (item.id === 'social-feed') return feedOpen;
    if (item.kind === 'panel') return activePanel === item.id;
    if (item.id === 'theatre') return isTheatreMode;
    return false;
  };

  const isBusy = (item) => {
    if (item.id === 'local-news') return searchingNews;
    if (item.id === 'autofill')   return Boolean(autoFillProgress);
    if (item.id === 'search')     return isSearching;
    return false;
  };

  const isDisabled = (item) => {
    if (item.id === 'clear')   return !hasStreams;
    if (item.id === 'theatre') return !hasStreams;
    return false;
  };

  const badge = (item) => {
    if (item.id === 'blacklist' && blacklistCount > 0) return blacklistCount;
    if (item.id === 'favorites' && favoritesCount > 0) return favoritesCount;
    return null;
  };

  return (
    <nav
      aria-label="Multi-view controls"
      className="relative z-30 flex h-full w-[52px] flex-shrink-0 flex-col border-r border-slate-800/80 bg-slate-950/85 backdrop-blur-sm"
    >
      {/* Inner-edge accent — a 1px cyan hairline along the rail's
          right edge. Reads as the "active rail" of the patchbay,
          subtly inviting you to look at this strip. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-cyan-500/15 to-transparent" />

      {/* Top engraved cap — tiny "MV" logo as a piece of equipment
          panel ID. Reinforces that the rail IS instrumentation, not a
          floating menu. */}
      <div className="flex items-center justify-center py-2.5 border-b border-slate-800/60">
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">MV</span>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map((section, sIdx) => (
          <div key={section.key} className={sIdx > 0 ? 'mt-2.5 pt-2.5 border-t border-slate-800/60' : ''}>
            {/* Engraved section label — silkscreen-style mono. Very
                small, lots of letter-spacing, low contrast — the eye
                groups but doesn't focus on it. */}
            <div className="px-1 mb-1.5 text-center">
              <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                {section.label}
              </span>
            </div>

            <div className="flex flex-col items-center gap-1">
              {section.items.map((item) => (
                <RailButton
                  key={item.id}
                  item={item}
                  active={isActive(item)}
                  busy={isBusy(item)}
                  disabled={isDisabled(item)}
                  badge={badge(item)}
                  onClick={() => handle(item)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom engraved cap — ⌘K affordance, doubles as the palette
          opener. Visually anchors the rail. */}
      <div className="flex items-center justify-center py-2 border-t border-slate-800/60">
        <PaletteButton onClick={onOpenPalette} />
      </div>
    </nav>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────

// `useRailTooltip` — owns hover state + rect tracking for one button so
// the tooltip can be portaled to document.body and escape the rail's
// overflow-y-auto clipping. We re-read the rect on each hover; that's
// cheap (one layout call) and avoids needing a ResizeObserver.
function useRailTooltip() {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  const open = () => {
    if (ref.current) setRect(ref.current.getBoundingClientRect());
  };
  const close = () => setRect(null);
  // Reposition on window resize / page scroll while open so the
  // tooltip stays glued to the icon.
  useEffect(() => {
    if (!rect) return undefined;
    const update = () => { if (ref.current) setRect(ref.current.getBoundingClientRect()); };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [rect]);
  return { ref, rect, open, close };
}

const RailButton = ({ item, active, busy, disabled, badge, onClick }) => {
  const { ref, rect, open, close } = useRailTooltip();

  // Accent maps active glow to a specific palette so different action
  // classes feel different on press. Cyan for nav (Find/Discover),
  // amber for Saved/active panels, rose for destructive.
  const accent = item.accent || (active ? 'amber' : 'cyan');

  const activeBgFor = (a) => ({
    cyan:    'bg-cyan-500/10  ring-1 ring-cyan-400/30  text-cyan-200',
    amber:   'bg-amber-500/10 ring-1 ring-amber-400/30 text-amber-200',
    rose:    'bg-rose-500/10  ring-1 ring-rose-400/30  text-rose-200'
  }[a] || 'bg-slate-800/70 text-slate-200 ring-1 ring-slate-700');

  const hoverAccentFor = (a) => ({
    cyan:  'hover:text-cyan-200 hover:bg-cyan-500/10',
    amber: 'hover:text-amber-200 hover:bg-amber-500/10',
    rose:  'hover:text-rose-200 hover:bg-rose-500/10'
  }[a] || 'hover:text-slate-100 hover:bg-slate-800/60');

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        disabled={disabled}
        aria-pressed={active}
        aria-busy={busy || undefined}
        // Accessibility name comes from aria-label so screen readers
        // still announce the button. We deliberately don't use `title`
        // here — the native OS tooltip would render alongside the
        // portal-rendered RailTooltip on a long hover, producing two
        // overlapping tooltips. aria-label gives equivalent a11y
        // without the visual collision.
        aria-label={item.label + (item.hint ? ` (${item.hint})` : '')}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition ${
          disabled
            ? 'text-slate-700 cursor-not-allowed opacity-50'
            : active
              ? `${activeBgFor(accent)} shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]`
              : `text-slate-400 ${hoverAccentFor(accent)}`
        }`}
      >
        {/* Inner-edge amber accent — only shown for active panels. A
            thin vertical bar on the rail's RIGHT side of the icon,
            pointing toward the open panel like a "this one is on" LED. */}
        {active && item.kind === 'panel' && (
          <span aria-hidden className="pointer-events-none absolute right-[-7px] top-1.5 bottom-1.5 w-[2px] rounded-full bg-amber-300 shadow-[0_0_6px_rgba(251,191,36,0.55)]" />
        )}

        {/* Busy spinner overlay — replaces the icon while busy. */}
        {busy ? (
          <svg viewBox="0 0 24 24" className="w-4 h-4 animate-spin" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <span className="block">{item.icon}</span>
        )}

        {/* Count badge — small mono pill on the icon's top-right. Used
            for blacklist count and favorites count. */}
        {badge != null && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 inline-flex items-center justify-center rounded-full bg-slate-950 ring-1 ring-amber-400/40 text-amber-200 font-mono text-[9px] tabular-nums font-bold leading-none">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>

      <RailTooltip rect={rect} label={item.label} hint={item.hint} />
    </>
  );
};

// The palette opener in the bottom rail cap. Reuses the same tooltip
// portal so the "⌘K — Command palette" hint shows cleanly.
const PaletteButton = ({ onClick }) => {
  const { ref, rect, open, close } = useRailTooltip();
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        aria-label="Command palette (⌘K)"
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:text-cyan-200 hover:bg-cyan-500/10 transition"
      >
        <span className="font-mono text-[9px] font-bold tracking-tight">⌘K</span>
      </button>
      <RailTooltip rect={rect} label="Command palette" hint="⌘K" />
    </>
  );
};

// Portaled tooltip — renders to document.body so the rail's scroll
// container doesn't clip it. Positioned with fixed coordinates from
// the button's bounding rect; placed to the right of the button with
// an 8px gap, vertically centered on the icon.
const RailTooltip = ({ rect, label, hint }) => {
  if (!rect) return null;
  const left = Math.round(rect.right + 8);
  const top = Math.round(rect.top + rect.height / 2);
  return createPortal(
    <span
      aria-hidden
      className="pointer-events-none fixed z-[9998] -translate-y-1/2"
      style={{ left, top }}
    >
      <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-cyan-500/25 bg-slate-900/95 px-2 py-1 shadow-lg shadow-black/40 backdrop-blur-md">
        <span className="text-[11px] font-medium text-slate-100">{label}</span>
        {hint && (
          <kbd className="font-mono text-[9px] text-cyan-300/80 bg-slate-950/80 px-1 py-px rounded border border-slate-800">
            {hint}
          </kbd>
        )}
      </span>
    </span>,
    document.body
  );
};

// ─── Inline SVG icons ─────────────────────────────────────────────────
// Each returned at 16px and inherits currentColor.

function ICON_SEARCH() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}
function ICON_BOLT() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" />
    </svg>
  );
}
function ICON_GRID_BOX() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" />
    </svg>
  );
}
function ICON_FLAME() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c1 4 5 5 5 9a5 5 0 11-10 0c0-2 1-3 2-4-1 4 3 4 3 0 0-2 0-3 0-5z" />
    </svg>
  );
}
function ICON_BALL() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3v18M5.5 5.5l13 13M18.5 5.5l-13 13" />
    </svg>
  );
}
function ICON_BROADCAST() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.93 19.07a10 10 0 010-14.14M19.07 4.93a10 10 0 010 14.14M8.46 16.46a5 5 0 010-7.07M15.54 9.39a5 5 0 010 7.07" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
function ICON_CHAT() {
  // Speech bubble with dots — reads as "live conversation / chatter".
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M21 11.5a8.38 8.38 0 01-8.5 8.5 9 9 0 01-3.9-.9L3 21l1.9-5.6A8.38 8.38 0 014 11.5 8.38 8.38 0 0112.5 3 8.38 8.38 0 0121 11.5z" />
      <circle cx="9" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="16" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ICON_BREAKING() {
  // Pulsing radar / "live-event" silhouette — broadcast tower with a ping arc.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M12 13l-3 8h6l-3-8z" fill="currentColor" stroke="none" />
      <circle cx="12" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <path d="M8.5 5.5a5 5 0 017 0" />
      <path d="M6 3a8 8 0 0112 0" />
    </svg>
  );
}
function ICON_YOUTUBE() {
  // Rounded-rect "play" silhouette — reads as YouTube without using their logo glyph.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-4 h-4">
      <rect x="2.5" y="6" width="19" height="12" rx="3" />
      <path d="M11 9.5l4 2.5-4 2.5v-5z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ICON_NEWS() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
    </svg>
  );
}
function ICON_HEART() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
      <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
    </svg>
  );
}
function ICON_BAN() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}
function ICON_GEAR() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <circle cx="12" cy="12" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
function ICON_LAYOUT() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}
function ICON_THEATRE() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
    </svg>
  );
}
function ICON_TRASH() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

export default MultiViewRail;
