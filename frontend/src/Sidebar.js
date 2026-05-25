import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UserBadge } from './components/AuthWrapper';

/**
 * Sidebar — the global app navigation. Designed as a patchbay-style rail
 * (matching the multi-view page's MultiViewRail) instead of a full-width
 * sidebar, because the old 288px-wide block consumed real estate on every
 * page even though most users only glance at it a few times per session.
 *
 *   ┌────┐
 *   │ MV │   ← top cap (logo)
 *   │────│
 *   │ N  │
 *   │ A  │
 *   │ V  │
 *   │    │   ← icon-rail body, 56px wide
 *   │ ◉  │     hover → tooltip slides out from the right edge with
 *   │ ◯  │     label + optional count
 *   │ ◯  │
 *   │────│
 *   │ ⇲  │   ← pin/expand toggle, bottom cap
 *   └────┘
 *
 * Two states, persisted to localStorage:
 *   - rail (default, ~56px): icon-only. Hover surfaces a portaled tooltip
 *     with the route label and any count badge.
 *   - expanded (~224px): icon + label + count chip. Reads more like the
 *     traditional sidebar for users who want labels always-on.
 *
 * The hamburger button in the header toggles between the two states. The
 * showSidebar prop is preserved as the "fully hidden" override used by
 * theatre mode etc.
 */

const NAV_ITEMS = [
  { id: 'myiptvs',    label: 'My IPTVs',     countKey: 'userSourcesCount',   icon: <IconBox /> },
  { id: 'epg',        label: 'EPG Sources',  countKey: 'epgSourceCount',     icon: <IconTower /> },
  { id: 'channels',   label: 'Channels',     countKey: 'totalChannels',      icon: <IconMonitor /> },
  { id: 'guide',      label: 'Guide',        countKey: 'matchedChannelCount',icon: <IconGuide /> },
  { id: 'liveevents', label: 'Live Events',  icon: <IconLive /> },
  { id: 'player',     label: 'Player',       icon: <IconPlay /> },
  { id: 'multiview',  label: 'Multi-View',   icon: <IconGrid /> },
  { id: 'movies',     label: 'Movies',       icon: <IconFilm /> },
  { id: 'series',     label: 'TV Series',    icon: <IconSeries /> },
  { id: 'dashboard',  label: 'Dashboard',    icon: <IconRefresh /> },
  { id: 'editor',     label: 'IPTV Editor',  countKey: 'totalMatchesCount',  icon: <IconEdit /> },
  { id: 'publish',    label: 'Credentials',  icon: <IconCard /> }
];

const EXPANDED_STORAGE_KEY = 'iptvguru.sidebar.expanded';
const RAIL_WIDTH = 56;
const EXPANDED_WIDTH = 224;

const Sidebar = ({
  showSidebar,
  activeTab,
  setActiveTab,
  handleReset,
  totalChannels = 0,
  categoryCount = 0,
  matchedChannelCount = 0,
  totalMatchesCount = 0,
  epgSourceCount = 0,
  userSourcesCount = 0,
  // ── User / session chrome (moved here from the now-removed app header) ──
  sessionId = null,
  user = null,
  onOpenSessionDebugger,
  onOpenServerStatus,
  // Fully hide the sidebar (different from the expand/collapse toggle —
  // this returns ALL the screen real estate to page content). The logo
  // cap doubles as the hide button.
  onHide
}) => {
  // Persist expanded preference across sessions. Falsy default keeps new
  // installs in the compact rail until the user opts in.
  const [expanded, setExpandedState] = useState(() => {
    try { return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === '1'; }
    catch { return false; }
  });
  const setExpanded = useCallback((next) => {
    setExpandedState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      try { window.localStorage.setItem(EXPANDED_STORAGE_KEY, value ? '1' : '0'); }
      catch { /* ignore quota errors */ }
      return value;
    });
  }, []);

  if (!showSidebar) return null;

  const counts = { totalChannels, matchedChannelCount, totalMatchesCount, epgSourceCount, userSourcesCount };
  const width = expanded ? EXPANDED_WIDTH : RAIL_WIDTH;

  return (
    <aside
      className="sticky top-0 z-30 flex h-screen flex-col border-r border-slate-800/80 bg-slate-950/85 text-slate-200 backdrop-blur-sm transition-[width] duration-200 ease-out"
      style={{ width: `${width}px` }}
    >
      {/* ── Top cap — logo + product name. Click to fully hide the
              sidebar (reclaims the full viewport for content). The
              hover state shifts the logo to a "<<" glyph to telegraph
              the hide affordance, and a tooltip / title makes it
              explicit. The same area in expanded mode shows the
              product name with a chevron-left hint on hover. */}
      <button
        type="button"
        onClick={onHide}
        disabled={!onHide}
        className={`group/cap relative flex h-12 flex-shrink-0 items-center border-b border-slate-800/70 overflow-hidden transition focus:outline-none focus:ring-1 focus:ring-inset focus:ring-cyan-500/40 ${
          onHide ? 'hover:bg-slate-900/60 cursor-w-resize' : 'cursor-default'
        } ${expanded ? 'w-full justify-start gap-2 px-3' : 'w-full justify-center'}`}
        aria-label="Hide sidebar"
        title={onHide ? 'Hide sidebar' : 'IPTV Guru'}
      >
        <span className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30 transition group-hover/cap:bg-cyan-500/25 group-hover/cap:ring-cyan-400/50">
          {/* Default: TV logo. Hover: chevron-left glyph that says "tuck
              me away". Cross-faded via opacity for a subtle reveal. */}
          <svg className="absolute h-3.5 w-3.5 transition-opacity duration-150 group-hover/cap:opacity-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
            <polyline points="17 2 12 7 7 2" />
          </svg>
          <svg className="absolute h-3.5 w-3.5 opacity-0 transition-opacity duration-150 group-hover/cap:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
          </svg>
        </span>
        {expanded && (
          <>
            <span className="font-semibold text-[13px] tracking-tight text-slate-100 truncate">IPTV Guru</span>
            <span className="ml-auto font-mono text-[9px] tracking-[0.14em] uppercase text-slate-600 opacity-0 group-hover/cap:opacity-100 transition-opacity">hide</span>
          </>
        )}
        {/* Inner-edge accent — matches MultiViewRail. */}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-cyan-500/15 to-transparent" />
      </button>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <nav
        className="relative flex-1 overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Primary navigation"
      >
        {expanded && (
          <p className="px-3 mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-600">
            Navigation
          </p>
        )}
        <div className={`flex flex-col items-stretch ${expanded ? 'gap-0.5 px-2' : 'gap-1 px-2 items-center'}`}>
          {NAV_ITEMS.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              expanded={expanded}
              isActive={activeTab === item.id}
              count={item.countKey ? counts[item.countKey] : undefined}
              onClick={() => setActiveTab(item.id)}
            />
          ))}
        </div>

        {/* Statistics block — only visible in expanded mode AND when data
            has loaded. The compact rail keeps focus on navigation. */}
        {expanded && totalChannels > 0 && (
          <div className="mt-4 mx-2 rounded-md border border-slate-800/70 bg-slate-900/40 px-3 py-2.5">
            <p className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-600">
              Stats
            </p>
            <dl className="space-y-1 text-[11px] text-slate-400">
              <StatRow label="Channels"   value={totalChannels} />
              <StatRow label="Categories" value={categoryCount} />
              <StatRow label="Matches"    value={matchedChannelCount} />
              <StatRow label="EPG Src"    value={epgSourceCount} />
            </dl>
            <button
              type="button"
              onClick={handleReset}
              className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            >
              <IconRefreshSm /> Reset
            </button>
          </div>
        )}
      </nav>

      {/* ── Bottom cap — user / session + expand toggle ──────────────
          Owns the user avatar (with account menu), an optional session-
          debug indicator, and the rail expand/collapse toggle. The
          global app header used to host these; consolidating them here
          gives content pages 100% of the vertical viewport. */}
      <div className="flex-shrink-0 border-t border-slate-800/70 px-2 py-1.5 flex flex-col gap-1.5">
        {/* User row — dropdown opens upward (top-left) since we're at
            the sidebar bottom. */}
        {user && (
          <UserBadge
            user={user}
            onOpenSessionDebugger={onOpenSessionDebugger}
            onOpenServerStatus={onOpenServerStatus}
            // Compact rail = 56px wide; an upward menu would clip into
            // the multi-view rail beside it. Pop to the right instead.
            // Expanded sidebar is 224px wide — upward fits naturally.
            placement={expanded ? 'top-left' : 'right-bottom'}
            variant={expanded ? 'row' : 'compact'}
          />
        )}

        {/* Session indicator — tiny mono chip with a live green dot.
            Hidden in compact mode (the dot lives on the user avatar
            via the menu). */}
        {expanded && sessionId && typeof sessionId === 'string' && (
          <button
            type="button"
            onClick={onOpenSessionDebugger}
            className="group/sess flex items-center gap-1.5 px-2 py-0.5 rounded-sm font-mono text-[9.5px] tracking-[0.04em] text-slate-500 bg-slate-900/40 ring-1 ring-slate-800/60 hover:text-cyan-200 hover:ring-cyan-500/30 transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
            title={`Session ${sessionId} — click for debugger`}
          >
            <span aria-hidden className="h-1 w-1 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)] flex-shrink-0" />
            <span className="truncate">
              {sessionId.length > 22 ? `${sessionId.slice(0, 7)}…${sessionId.slice(-6)}` : sessionId}
            </span>
          </button>
        )}

        {/* Expand / collapse toggle */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`flex items-center gap-2 rounded-md text-slate-400 hover:text-cyan-200 hover:bg-cyan-500/10 transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40 ${
            expanded ? 'w-full px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]' : 'h-9 w-9 self-center justify-center'
          }`}
          title={expanded ? 'Collapse to icon rail' : 'Expand sidebar'}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <IconCollapse />
              <span>Collapse</span>
            </>
          ) : (
            <IconExpand />
          )}
        </button>
      </div>
    </aside>
  );
};

/* ─── NavItem — handles both rail and expanded layouts ───────────────── */

const NavItem = ({ item, expanded, isActive, count, onClick }) => {
  const tooltip = useRailTooltip();

  if (expanded) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`group/row relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40 ${
          isActive
            ? 'bg-cyan-500/[0.10] text-cyan-100 ring-1 ring-cyan-500/25'
            : 'text-slate-300 hover:bg-slate-800/70 hover:text-slate-100'
        }`}
      >
        {/* Left rail mark for active state. */}
        <span
          aria-hidden
          className={`absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-5 rounded-r-sm transition ${
            isActive ? 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.4)]' : 'bg-transparent'
          }`}
        />
        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition ${
          isActive ? 'text-cyan-200' : 'text-slate-400 group-hover/row:text-slate-200'
        }`}>
          {item.icon}
        </span>
        <span className={`flex-1 truncate text-left font-medium ${isActive ? 'text-cyan-100' : ''}`}>
          {item.label}
        </span>
        {typeof count === 'number' && count > 0 && (
          <span className={`flex-shrink-0 px-1.5 py-px rounded-sm font-mono text-[9px] tabular-nums tracking-[0.04em] ${
            isActive ? 'bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-500/30' : 'bg-slate-800/80 text-slate-400'
          }`}>
            {formatCount(count)}
          </span>
        )}
      </button>
    );
  }

  // Rail (compact) layout — icon-only, tooltip on hover, count dot.
  return (
    <button
      type="button"
      ref={tooltip.ref}
      onMouseEnter={tooltip.open}
      onMouseLeave={tooltip.close}
      onFocus={tooltip.open}
      onBlur={tooltip.close}
      onClick={onClick}
      className={`group/cell relative flex h-9 w-9 items-center justify-center rounded-md transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40 ${
        isActive
          ? 'bg-cyan-500/[0.12] ring-1 ring-cyan-500/30 text-cyan-200 shadow-[0_0_10px_rgba(34,211,238,0.15)]'
          : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
      }`}
      aria-current={isActive ? 'page' : undefined}
      aria-label={item.label}
    >
      {item.icon}
      {typeof count === 'number' && count > 0 && (
        <span
          aria-hidden
          className={`absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full font-mono text-[8.5px] font-semibold leading-[14px] tabular-nums text-center ring-1 ${
            isActive ? 'bg-cyan-500 text-slate-950 ring-cyan-300' : 'bg-slate-800 text-slate-300 ring-slate-700'
          }`}
        >
          {formatCount(count)}
        </span>
      )}
      {tooltip.rect && (
        <RailTooltip rect={tooltip.rect} label={item.label} count={count} />
      )}
    </button>
  );
};

/* ─── Rail tooltip — portaled so it escapes the rail's overflow clip ── */

function useRailTooltip() {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  const open = () => { if (ref.current) setRect(ref.current.getBoundingClientRect()); };
  const close = () => setRect(null);
  useEffect(() => {
    if (!rect) return undefined;
    const sync = () => { if (ref.current) setRect(ref.current.getBoundingClientRect()); };
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [rect]);
  return { ref, rect, open, close };
}

const RailTooltip = ({ rect, label, count }) => {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[60] flex items-center gap-2 rounded-md border border-slate-700/80 bg-slate-900/95 px-2.5 py-1 shadow-2xl shadow-black/60 backdrop-blur-md"
      style={{
        left: rect.right + 8,
        top: rect.top + rect.height / 2,
        transform: 'translateY(-50%)'
      }}
    >
      <span className="text-[11px] font-medium text-slate-100">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-cyan-300">
          {formatCount(count)}
        </span>
      )}
    </div>,
    document.body
  );
};

/* ─── Misc sub-components ────────────────────────────────────────────── */

const RailButton = ({ label, onClick, icon }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800/70 transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
    aria-label={label}
    title={label}
  >
    {icon}
  </button>
);

const StatRow = ({ label, value }) => (
  <div className="flex items-center justify-between gap-2">
    <dt className="text-slate-500">{label}</dt>
    <dd className="font-mono text-slate-200 tabular-nums">{formatCount(value)}</dd>
  </div>
);

function formatCount(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1)}k`.replace('.0k', 'k');
  return `${Math.round(v / 1000)}k`;
}

/* ─── Icon glyphs ────────────────────────────────────────────────────── */

const SVG_PROPS = {
  className: 'h-4 w-4',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
};

function LogoMark() {
  return (
    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30">
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
        <polyline points="17 2 12 7 7 2" />
      </svg>
    </span>
  );
}

function IconBox()    { return <svg {...SVG_PROPS}><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>; }
function IconTower()  { return <svg {...SVG_PROPS}><path d="M4 22h16" /><path d="M5 2v5h14V2" /><path d="M19 9H5l-2 5h18l-2-5Z" /><path d="M7 14v4" /><path d="M17 14v4" /></svg>; }
function IconMonitor(){ return <svg {...SVG_PROPS}><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>; }
function IconGuide()  { return <svg {...SVG_PROPS}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M22 7h-4M22 12h-4M22 17h-4M6 7h6M6 12h6M6 17h6" /></svg>; }
function IconLive()   { return <svg {...SVG_PROPS}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></svg>; }
function IconPlay()   { return <svg {...SVG_PROPS}><circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" /></svg>; }
function IconGrid()   { return <svg {...SVG_PROPS}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>; }
function IconFilm()   { return <svg {...SVG_PROPS}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 8h20M2 16h20M7 4v16M17 4v16" /></svg>; }
function IconSeries() { return <svg {...SVG_PROPS}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M8 12h8" /></svg>; }
function IconRefresh(){ return <svg {...SVG_PROPS}><path d="M3 3v6h6M21 21v-6h-6M3 9a9 9 0 0 1 15-6.7M21 15a9 9 0 0 1-15 6.7" /></svg>; }
function IconEdit()   { return <svg {...SVG_PROPS}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>; }
function IconCard()   { return <svg {...SVG_PROPS}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 9.5h20" /></svg>; }
function IconRefreshSm(){ return <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 1 3 6.7" /><path d="M3 21v-6h6" /></svg>; }
function IconExpand() { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>; }
function IconCollapse(){ return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>; }

export default Sidebar;
