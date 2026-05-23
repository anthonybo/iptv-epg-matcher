import React, { useState, useEffect, useMemo, useRef } from 'react';

/* ──────────────────────────────────────────────────────────────────────
 * EpgRefreshModal — Control-room status panel for EPG refresh.
 *
 * Three things this UI has to nail:
 *   1. SCROLL. The sources list is the primary content; it must fill
 *      the remaining vertical space and scroll within itself. The fix
 *      is `flex-1 min-h-0 overflow-y-auto` on the sources container —
 *      `min-h-0` is what allows a flex-1 child of a flex column to
 *      actually shrink and scroll instead of pushing siblings off.
 *   2. STATUS-FIRST. Every row's accent (tile + chip + left border)
 *      encodes its state in one glance. Mono numerics + caps labels
 *      keep the eye anchored to the data even on a 19-source list.
 *   3. LIVE. The active row pulls counts out of the rolling SSE
 *      `currentMessage` so the user sees the channel/program counters
 *      tick up in real time, not just a spinner.
 *
 * The component intentionally avoids any external chart/animation
 * library — all motion is Tailwind animate-* + CSS transitions.
 * ──────────────────────────────────────────────────────────────── */

// ─── Helpers ──────────────────────────────────────────────────────────
const extractDomain = (url) => {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(url).replace(/^https?:\/\//, '').split('/')[0];
  }
};

const formatInt = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString();
};

// Compact rendering for large counts in tight spaces.
const formatCompact = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
};

// Format an elapsed-ms duration as `mm:ss` or `h:mm:ss` for the
// always-on refresh timer. Used by the header strip and the
// minimized dock — both should agree on the same wall-clock value.
const formatElapsed = (ms) => {
  if (!ms || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

// Extract a source name from any message format the backend emits.
// Listed in priority order — first match wins. The bracket prefix
// is the ground truth when present, but during the early phases of
// a refresh ("Processing source 1/18: X", "Downloading X...",
// "Clearing old data for X...") the message has the name in plain
// text without brackets, and we still want to surface it.
const extractSourceName = (message) => {
  if (!message || typeof message !== 'string') return null;
  // Strongest: bracket prefix from the parser ([X] Parsed N channels…)
  const bracket = message.match(/^\s*\[([^\]]+)\]/);
  if (bracket) return bracket[1].trim();
  // "Processing source 7/18: EPG Share 01 - All Sources"
  const processing = message.match(/Processing source \d+\/\d+:\s*(.+?)\s*$/);
  if (processing) return processing[1].trim();
  // "Downloading EPG.pw - US..."
  const downloading = message.match(/^Downloading\s+(.+?)(?:\.\.\.|\.{3}|$)/);
  if (downloading) return downloading[1].trim();
  // "Parsing EPG.pw - US..."
  const parsing = message.match(/^Parsing\s+(.+?)(?:\.\.\.|\.{3}|$)/);
  if (parsing) return parsing[1].trim();
  // "Clearing old data for X..."
  const clearing = message.match(/Clearing old data for\s+(.+?)(?:\.\.\.|\.{3}|$)/);
  if (clearing) return clearing[1].trim();
  // "✓ Completed X: 1234 channels, 5678 programs"
  const completed = message.match(/(?:✓|✔)\s*Completed\s+(.+?):/);
  if (completed) return completed[1].trim();
  // "✗ Failed X: <error>"
  const failed = message.match(/(?:✗|✖)\s*Failed\s+(.+?):/);
  if (failed) return failed[1].trim();
  return null;
};

// Pull live numeric counts AND the active source name out of the
// rolling SSE message so the active source can display ticking
// values regardless of whether the parent's sources[].status state
// has caught up.
const extractLiveCounts = (message) => {
  if (!message || typeof message !== 'string') return null;

  const sourceName = extractSourceName(message);

  const parsed = message.match(/Parsed ([\d,]+) channels?, ([\d,]+) programs?/i);
  if (parsed) {
    return { phase: 'parsing', channels: parsed[1], programs: parsed[2], sourceName };
  }
  const inserted = message.match(/Inserted ([\d,]+) channels?/i);
  if (inserted) {
    return { phase: 'inserting', channels: inserted[1], sourceName };
  }
  const downloaded = message.match(/Downloaded ([\d.]+)\s*MB/i);
  if (downloaded) {
    return { phase: 'downloading', mb: downloaded[1], sourceName };
  }
  // No numeric counts in this message but we still recovered a name
  // ("Processing source X/Y: …", "Downloading …", etc.).
  if (sourceName) {
    return { phase: 'preparing', sourceName };
  }
  return null;
};

// ─── Atomic icons ─────────────────────────────────────────────────────
const Icon = {
  check: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12.5l5 5L20 7" />
    </svg>
  ),
  x: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  dot: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  ),
  spinner: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.5} className="opacity-20" />
      <path
        d="M21 12a9 9 0 00-9-9"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  ),
  minimize: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
    </svg>
  ),
  close: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  expand: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4M16 4h4v4M4 16v4h4M16 20h4v-4" />
    </svg>
  ),
  chevronDown: (cls) => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  )
};

// ─── Status semantics ─────────────────────────────────────────────────
// Single source of truth for the four lifecycle states. Every visual
// element reads from this so adding a fifth state is one entry, not a
// hunt-and-replace.
const STATUS = {
  complete: {
    label: 'COMPLETE',
    icon: Icon.check,
    tileBg: 'bg-emerald-500/10',
    tileRing: 'ring-emerald-400/30',
    tileText: 'text-emerald-300',
    chipBg: 'bg-emerald-500/8',
    chipRing: 'ring-emerald-400/30',
    chipText: 'text-emerald-200',
    borderAccent: ''
  },
  refreshing: {
    label: 'LOADING',
    icon: Icon.spinner,
    iconSpin: true,
    tileBg: 'bg-cyan-500/10',
    tileRing: 'ring-cyan-400/40',
    tileText: 'text-cyan-300',
    chipBg: 'bg-cyan-500/10',
    chipRing: 'ring-cyan-400/40',
    chipText: 'text-cyan-200',
    borderAccent: 'before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-cyan-400/80'
  },
  failed: {
    label: 'FAILED',
    icon: Icon.x,
    tileBg: 'bg-rose-500/10',
    tileRing: 'ring-rose-400/30',
    tileText: 'text-rose-300',
    chipBg: 'bg-rose-500/8',
    chipRing: 'ring-rose-400/30',
    chipText: 'text-rose-200',
    borderAccent: 'before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-rose-400/70'
  },
  pending: {
    label: 'PENDING',
    icon: Icon.dot,
    tileBg: 'bg-slate-800/60',
    tileRing: 'ring-slate-700/60',
    tileText: 'text-slate-500',
    chipBg: 'bg-slate-800/40',
    chipRing: 'ring-slate-700/40',
    chipText: 'text-slate-500',
    borderAccent: ''
  },
  disabled: {
    label: 'DISABLED',
    icon: Icon.dot,
    tileBg: 'bg-slate-800/30',
    tileRing: 'ring-slate-800/60',
    tileText: 'text-slate-600',
    chipBg: 'bg-slate-800/30',
    chipRing: 'ring-slate-800/40',
    chipText: 'text-slate-600',
    borderAccent: ''
  }
};

const resolveStatusKey = (source) => {
  if (source.enabled === false) return 'disabled';
  if (source.status === 'complete') return 'complete';
  if (source.status === 'refreshing') return 'refreshing';
  if (source.status === 'failed' || source.status === 'error') return 'failed';
  return 'pending';
};

// ─── Subcomponents ────────────────────────────────────────────────────

const StatusTile = ({ statusKey }) => {
  const cfg = STATUS[statusKey];
  const IconCmp = cfg.icon;
  return (
    <div
      className={`flex-shrink-0 w-8 h-8 rounded-md ${cfg.tileBg} ring-1 ${cfg.tileRing} flex items-center justify-center ${
        cfg.iconSpin ? 'animate-spin-slow' : ''
      }`}
      style={cfg.iconSpin ? { animation: 'spin 1.1s linear infinite' } : undefined}
    >
      {IconCmp(`w-4 h-4 ${cfg.tileText}`)}
    </div>
  );
};

const StatusChip = ({ statusKey, label }) => {
  const cfg = STATUS[statusKey];
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-md ${cfg.chipBg} ring-1 ${cfg.chipRing} ${cfg.chipText} font-mono text-[9.5px] tracking-[0.16em] uppercase`}
    >
      {label ?? cfg.label}
    </span>
  );
};

const SourceRow = ({ source, isActive, liveCounts }) => {
  const [expanded, setExpanded] = useState(false);
  // isActive overrides the row's stored status. When the modal
  // identifies a source as currently being processed (via the
  // bracket prefix in the SSE message), it should render as
  // 'refreshing' regardless of what the parent's state machine
  // last wrote. Without this override the user sees PENDING on a
  // source that's actively pulling data — exactly the bug visible
  // in the user's earlier screenshot.
  const baseStatusKey = resolveStatusKey(source);
  const statusKey =
    isActive && baseStatusKey !== 'complete' && baseStatusKey !== 'failed' && baseStatusKey !== 'disabled'
      ? 'refreshing'
      : baseStatusKey;
  const cfg = STATUS[statusKey];
  const domain = useMemo(() => extractDomain(source.url), [source.url]);

  // Scroll the active row into view when it first becomes active.
  // Block: 'center' so the row lands in the middle of the scroll
  // area rather than at the top or bottom — easier to read in a
  // long list. Behavior: 'smooth' for a non-jarring transition.
  const rowRef = useRef(null);
  useEffect(() => {
    if (isActive && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [isActive]);

  // Right-side count/status copy. Active rows show LIVE numbers when
  // available; otherwise we fall back to the latest committed totals.
  let rightDetail;
  if (statusKey === 'complete') {
    rightDetail = (
      <span className="font-mono tabular-nums text-[11.5px] text-slate-300">
        {formatInt(source.channels)}
        <span className="text-slate-600 mx-1">·</span>
        {formatInt(source.programs)}
        <span className="text-slate-500 ml-1.5 text-[10px] uppercase tracking-[0.14em]">prog</span>
      </span>
    );
  } else if (statusKey === 'refreshing') {
    let liveText = 'Working…';
    if (liveCounts) {
      if (liveCounts.phase === 'downloading') {
        liveText = (
          <>
            <span className="text-cyan-200">{liveCounts.mb}</span>
            <span className="text-slate-500 ml-1 text-[10px] uppercase tracking-[0.14em]">MB</span>
          </>
        );
      } else if (liveCounts.phase === 'parsing') {
        liveText = (
          <>
            <span className="text-cyan-200">{liveCounts.channels}</span>
            <span className="text-slate-600 mx-1">·</span>
            <span className="text-cyan-200">{liveCounts.programs}</span>
            <span className="text-slate-500 ml-1.5 text-[10px] uppercase tracking-[0.14em]">prog</span>
          </>
        );
      } else if (liveCounts.phase === 'inserting') {
        liveText = (
          <>
            <span className="text-slate-500 text-[10px] uppercase tracking-[0.14em] mr-1">insert</span>
            <span className="text-cyan-200">{liveCounts.channels}</span>
          </>
        );
      }
    }
    rightDetail = (
      <span className="font-mono tabular-nums text-[11.5px] text-cyan-200">{liveText}</span>
    );
  } else if (statusKey === 'failed') {
    rightDetail = (
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="font-mono text-[10.5px] text-rose-300 hover:text-rose-200 max-w-[260px] truncate text-right"
        title={source.error || 'Failed'}
      >
        {source.error || 'Failed'}
      </button>
    );
  } else if (statusKey === 'pending') {
    rightDetail = (
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">queued</span>
    );
  } else if (statusKey === 'disabled') {
    rightDetail = (
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-700">off</span>
    );
  }

  return (
    <div
      ref={rowRef}
      className={`group relative flex items-center gap-3 px-3 h-16 rounded-md border transition-colors ${
        statusKey === 'refreshing'
          ? 'border-cyan-500/25 bg-cyan-500/[0.04]'
          : statusKey === 'failed'
          ? 'border-rose-500/25 bg-rose-500/[0.03] hover:bg-rose-500/[0.05]'
          : statusKey === 'complete'
          ? 'border-slate-800/70 bg-slate-900/30 hover:bg-slate-900/50'
          : statusKey === 'disabled'
          ? 'border-slate-800/40 bg-slate-900/10 opacity-50'
          : 'border-slate-800/60 bg-slate-900/20 hover:bg-slate-900/40'
      } ${cfg.borderAccent} overflow-hidden`}
    >
      <StatusTile statusKey={statusKey} />

      {/* Middle: name + secondary line */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13.5px] font-medium text-slate-100 truncate">{source.name}</span>
          {source.verified === false && source.enabled !== false && (
            <span className="inline-flex items-center h-4 px-1 rounded bg-amber-500/10 ring-1 ring-amber-400/30 text-amber-300 font-mono text-[8.5px] uppercase tracking-[0.16em]">
              Unverified
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-slate-500 truncate mt-0.5">
          {domain || <span className="text-slate-700">no host</span>}
        </div>
      </div>

      {/* Right: counts + chip */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="text-right">{rightDetail}</div>
        <StatusChip statusKey={statusKey} />
        {statusKey === 'failed' && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-slate-600 hover:text-slate-300 transition-colors"
            title={expanded ? 'Collapse' : 'Show full error'}
          >
            <Icon.chevronDown
              cls={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {/* Expanded error overlay for failed rows */}
      {expanded && statusKey === 'failed' && source.error && (
        <div className="absolute inset-x-0 top-full mt-px z-10 px-3 py-2 bg-rose-950/95 ring-1 ring-rose-500/30 rounded-b-md text-[11px] text-rose-200 font-mono break-words whitespace-pre-wrap">
          {source.error}
        </div>
      )}
    </div>
  );
};

// ─── Status strip variants ────────────────────────────────────────────
const StatusStrip = ({ status, displaySourceName, liveCounts, progressInfo, error, fallbackDetail }) => {
  if (status === 'complete' && !error) {
    return (
      <div className="flex items-center gap-3 h-12 px-3 rounded-md bg-emerald-500/[0.06] ring-1 ring-emerald-500/25">
        <div className="w-7 h-7 rounded-md bg-emerald-500/15 ring-1 ring-emerald-400/40 flex items-center justify-center">
          {Icon.check('w-4 h-4 text-emerald-300')}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-300/80">
            Refresh complete
          </div>
          <div className="text-[12.5px] text-emerald-100 truncate">All sources processed</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 h-12 px-3 rounded-md bg-rose-500/[0.06] ring-1 ring-rose-500/30">
        <div className="w-7 h-7 rounded-md bg-rose-500/15 ring-1 ring-rose-400/40 flex items-center justify-center">
          {Icon.x('w-4 h-4 text-rose-300')}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-rose-300/80">
            Refresh failed
          </div>
          <div className="text-[12.5px] text-rose-200 truncate">{error}</div>
        </div>
      </div>
    );
  }

  if (status === 'polling') {
    return (
      <div className="flex items-center gap-3 h-12 px-3 rounded-md bg-amber-500/[0.05] ring-1 ring-amber-500/25">
        <div className="w-7 h-7 rounded-md bg-amber-500/15 ring-1 ring-amber-400/40 flex items-center justify-center">
          <span
            className="w-1.5 h-1.5 rounded-full bg-amber-300"
            style={{ animation: 'pulse 1.8s ease-in-out infinite' }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-amber-300/80">
            Awaiting backend
          </div>
          <div className="text-[12.5px] text-amber-100 truncate">
            Parser still running — backend hasn't streamed completion yet
          </div>
        </div>
      </div>
    );
  }

  if (status === 'starting') {
    return (
      <div className="flex items-center gap-3 h-12 px-3 rounded-md bg-slate-800/40 ring-1 ring-slate-700/60">
        <div className="w-7 h-7 rounded-md bg-slate-700/40 ring-1 ring-slate-600/40 flex items-center justify-center">
          {Icon.spinner('w-4 h-4 text-slate-300 animate-spin')}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-400">
            Initialising
          </div>
          <div className="text-[12.5px] text-slate-200 truncate">
            Resolving configured sources…
          </div>
        </div>
      </div>
    );
  }

  // Default: refreshing — the most common state, with live counts.
  let detail = null;
  if (liveCounts?.phase === 'parsing') {
    detail = (
      <>
        <span className="text-cyan-200 font-mono tabular-nums text-[11.5px]">{liveCounts.channels}</span>
        <span className="text-slate-500 ml-1 text-[10px] uppercase tracking-[0.14em]">ch</span>
        <span className="text-slate-700 mx-2">·</span>
        <span className="text-cyan-200 font-mono tabular-nums text-[11.5px]">{liveCounts.programs}</span>
        <span className="text-slate-500 ml-1 text-[10px] uppercase tracking-[0.14em]">prog</span>
      </>
    );
  } else if (liveCounts?.phase === 'downloading') {
    detail = (
      <>
        <span className="text-cyan-200 font-mono tabular-nums text-[11.5px]">{liveCounts.mb}</span>
        <span className="text-slate-500 ml-1 text-[10px] uppercase tracking-[0.14em]">MB downloaded</span>
      </>
    );
  } else if (liveCounts?.phase === 'inserting') {
    detail = (
      <>
        <span className="text-slate-500 text-[10px] uppercase tracking-[0.14em] mr-1.5">inserting</span>
        <span className="text-cyan-200 font-mono tabular-nums text-[11.5px]">{liveCounts.channels}</span>
        <span className="text-slate-500 ml-1 text-[10px] uppercase tracking-[0.14em]">channels</span>
      </>
    );
  } else if (progressInfo) {
    detail = <span className="text-cyan-200 font-mono text-[11.5px]">{progressInfo}</span>;
  }

  return (
    <div className="flex items-center gap-3 h-12 px-3 rounded-md bg-cyan-500/[0.04] ring-1 ring-cyan-500/25 relative overflow-hidden">
      {/* Subtle animated pulse strip on the left edge to confirm liveness */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[2px] bg-cyan-400/70"
        style={{ animation: 'pulse 1.6s ease-in-out infinite' }}
      />
      <div className="w-7 h-7 rounded-md bg-cyan-500/15 ring-1 ring-cyan-400/40 flex items-center justify-center">
        {Icon.spinner('w-4 h-4 text-cyan-300 animate-spin')}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-300/80 truncate">
          {liveCounts?.phase === 'downloading'
            ? 'Downloading'
            : liveCounts?.phase === 'inserting'
            ? 'Inserting channels'
            : liveCounts?.phase === 'parsing'
            ? 'Parsing XMLTV'
            : 'Working'}
        </div>
        <div className="text-[12.5px] text-cyan-100 truncate">
          {displaySourceName || fallbackDetail || 'Processing source…'}
        </div>
      </div>
      {detail && <div className="flex-shrink-0">{detail}</div>}
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────
const EpgRefreshModal = ({ isOpen, onClose, progress }) => {
  const [isMinimized, setIsMinimized] = useState(false);
  // Refresh-start timestamp + a per-second "now" tick. Stored as
  // useState (NOT useRef) so the value actually triggers re-renders
  // when updated. The parent renders this modal in two different
  // tree positions (with-sources vs no-sources) so refs do NOT
  // persist across that remount — useState's behavior on mount is
  // identical, but `setStartedAt` triggers the visible re-render
  // that a ref mutation wouldn't.
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // CRITICAL: every hook below this point MUST run on every render —
  // including when isOpen is false. React's Rules of Hooks forbid a
  // conditional early return that sits between hook calls, otherwise
  // the hook count varies between renders and you get
  // "Rendered more hooks than during the previous render". Default
  // `progress` to an empty object so the destructure / memo bodies
  // remain safe even when the parent renders us with no props yet.
  const safeProgress = progress || {};
  const {
    sources = [],
    currentSource,
    totalSources,
    status,
    error,
    currentMessage,
    progressInfo,
    currentSourceName
  } = safeProgress;

  const liveCounts = useMemo(() => extractLiveCounts(currentMessage), [currentMessage]);

  // Capture refresh start the first time we observe an active
  // status. Stays set through 'complete' so the user can read the
  // final duration; only clears when the modal closes.
  const isActiveStatus =
    status === 'starting' || status === 'refreshing' || status === 'polling';
  useEffect(() => {
    if (isActiveStatus && startedAt === null) {
      setStartedAt(Date.now());
    }
  }, [isActiveStatus, startedAt]);
  useEffect(() => {
    if (!isOpen) setStartedAt(null);
  }, [isOpen]);

  // Tick `now` every second while active so the elapsed counter
  // updates even when no SSE messages are arriving (e.g.
  // mid-download). We stop ticking on 'complete' to avoid burning
  // CPU on a dialog the user might leave open.
  useEffect(() => {
    if (!isActiveStatus) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActiveStatus]);

  const elapsedMs = startedAt ? now - startedAt : 0;
  const elapsedStr = formatElapsed(elapsedMs);
  const showElapsed = startedAt != null;

  // Derived stats for the header + summary row. We compute these in
  // one pass so the header chip and minimized variant share the same
  // source of truth — there is exactly one "what's the count"
  // calculation in this file.
  const summary = useMemo(() => {
    let complete = 0;
    let failed = 0;
    let pending = 0;
    let refreshing = 0;
    let totalChannels = 0;
    let totalPrograms = 0;
    let enabled = 0;
    for (const s of sources) {
      if (s.enabled === false) continue;
      enabled++;
      const key = resolveStatusKey(s);
      if (key === 'complete') {
        complete++;
        totalChannels += Number(s.channels) || 0;
        totalPrograms += Number(s.programs) || 0;
      } else if (key === 'failed') failed++;
      else if (key === 'refreshing') refreshing++;
      else pending++;
    }
    const finished = complete + failed;
    return { complete, failed, pending, refreshing, enabled, finished, totalChannels, totalPrograms };
  }, [sources]);

  // ─── Safe to early-return now — all hooks have executed above ──
  if (!isOpen) return null;

  // Active-source resolution. Four signals tried in order:
  //   1. liveCounts.sourceName — parsed from THIS message
  //   2. extractSourceName(currentMessage) — covers patterns we
  //      didn't classify into a phase (e.g. raw "Downloading X...")
  //   3. sources[].status === 'refreshing' — parent state
  //   4. currentSourceName — parent's sticky last-seen name
  //
  // The double-pass on currentMessage (via liveCounts AND directly)
  // is intentional: extractLiveCounts returns null when nothing
  // numeric matches AND there's no source name, so we ALSO check
  // currentMessage independently for any embedded name we can
  // recover.
  const activeNameFromMessage =
    liveCounts?.sourceName || extractSourceName(currentMessage) || null;
  const displaySourceName =
    activeNameFromMessage ||
    sources.find((s) => s.status === 'refreshing')?.name ||
    currentSourceName ||
    null;

  // Final fallback shown in the status strip when no source name
  // can be recovered: the raw SSE message text. Better to show
  // "Downloaded 150.98 MB" verbatim than a generic ellipsis that
  // tells the user nothing about what's happening.
  const displayDetailFallback = currentMessage && currentMessage.length < 200
    ? currentMessage.replace(/^\[[^\]]+\]\s*/, '')  // strip our own bracket prefix to avoid double-rendering
    : null;

  // Find the matching row by name so we can force-highlight it as
  // active even if its stored status is still 'pending'. Name match
  // is case-insensitive + whitespace-trimmed to survive minor format
  // drift between the SSE message and the config file.
  const normaliseName = (s) => String(s || '').trim().toLowerCase();
  const activeRowKey = displaySourceName
    ? normaliseName(displaySourceName)
    : null;

  // Progress fraction. Prefer the explicit currentSource/totalSources
  // from the SSE stream when we have them; otherwise fall back to a
  // derived ratio from the sources array (some refreshes start before
  // the "Processing source X/Y" message is broadcast).
  const ratioNum = currentSource ?? summary.finished;
  const ratioDen = totalSources ?? summary.enabled;
  const ratioPct = ratioDen > 0 ? Math.min(100, Math.round((ratioNum / ratioDen) * 100)) : 0;

  const toggleMinimize = () => setIsMinimized((v) => !v);

  // ─── Minimized floating dock ────────────────────────────────────────
  if (isMinimized) {
    const allDone = status === 'complete' && !error;
    return (
      <div
        onClick={toggleMinimize}
        role="button"
        tabIndex={0}
        className="fixed bottom-6 right-6 z-50 w-[340px] bg-slate-950/95 backdrop-blur border border-slate-800/80 ring-1 ring-slate-800/60 rounded-lg shadow-2xl cursor-pointer hover:border-cyan-500/40 hover:ring-cyan-500/20 transition-colors group"
      >
        <div className="px-3 py-2.5 flex items-center gap-3">
          {/* Status dot */}
          <div
            className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${
              allDone
                ? 'bg-emerald-500/15 ring-1 ring-emerald-400/40'
                : error
                ? 'bg-rose-500/15 ring-1 ring-rose-400/40'
                : 'bg-cyan-500/15 ring-1 ring-cyan-400/40'
            }`}
          >
            {allDone
              ? Icon.check('w-3.5 h-3.5 text-emerald-300')
              : error
              ? Icon.x('w-3.5 h-3.5 text-rose-300')
              : Icon.spinner('w-3.5 h-3.5 text-cyan-300 animate-spin')}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-400">
                EPG Refresh
              </span>
              <span className="flex items-center gap-2 font-mono tabular-nums text-[10.5px]">
                {showElapsed && (
                  <span className={allDone ? 'text-emerald-300' : 'text-slate-400'}>{elapsedStr}</span>
                )}
                <span className="text-cyan-200">
                  {ratioNum} / {ratioDen}
                </span>
              </span>
            </div>
            {/* Progress bar */}
            <div className="mt-1.5 h-1 rounded-full bg-slate-800/80 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${
                  allDone ? 'bg-emerald-400/80' : error ? 'bg-rose-400/80' : 'bg-cyan-400/80'
                }`}
                style={{ width: `${ratioPct}%` }}
              />
            </div>
            {/* Live detail line */}
            <div className="mt-1 text-[10.5px] text-slate-400 truncate">
              {allDone
                ? `${formatInt(summary.complete)} sources · ${formatCompact(summary.totalChannels)} channels`
                : error
                ? <span className="text-rose-300">{error}</span>
                : displaySourceName
                ? <>
                    <span className="text-slate-500">on </span>
                    <span className="text-slate-200">{displaySourceName}</span>
                  </>
                : 'Working…'}
            </div>
          </div>

          {/* Expand affordance */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleMinimize();
            }}
            className="flex-shrink-0 w-7 h-7 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors flex items-center justify-center"
            title="Expand"
          >
            {Icon.expand('w-3.5 h-3.5')}
          </button>
        </div>
      </div>
    );
  }

  // ─── Full modal ────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div
        className="bg-slate-950 border border-slate-800/80 ring-1 ring-slate-800/40 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col"
        style={{ height: 'min(720px, 90vh)' }}
      >
        {/* ─── Header strip ─────────────────────────────────────────── */}
        <div className="flex-shrink-0 flex items-center h-12 px-4 border-b border-slate-800/80">
          {/* Status pip — tiny live indicator */}
          <span
            className={`w-1.5 h-1.5 rounded-full mr-3 ${
              status === 'complete' && !error
                ? 'bg-emerald-400'
                : error
                ? 'bg-rose-400'
                : 'bg-cyan-400'
            }`}
            style={
              status !== 'complete' && !error
                ? { animation: 'pulse 1.4s ease-in-out infinite' }
                : undefined
            }
          />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.24em] text-slate-300">
            EPG Refresh
          </span>

          {/* Count badge */}
          {ratioDen > 0 && (
            <span className="ml-3 inline-flex items-center h-5 px-1.5 rounded bg-cyan-500/10 ring-1 ring-cyan-400/30 text-cyan-200 font-mono tabular-nums text-[10.5px]">
              {ratioNum}
              <span className="text-slate-500 mx-1">/</span>
              {ratioDen}
            </span>
          )}

          {/* Tiny status counters — at-a-glance health */}
          {sources.length > 0 && (
            <div className="hidden sm:flex items-center gap-2 ml-3 text-[10px] font-mono tracking-[0.14em] uppercase">
              {summary.complete > 0 && (
                <span className="text-emerald-300/80">{summary.complete} ok</span>
              )}
              {summary.failed > 0 && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-rose-300/80">{summary.failed} fail</span>
                </>
              )}
              {summary.pending > 0 && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-slate-500">{summary.pending} queue</span>
                </>
              )}
            </div>
          )}

          <div className="flex-1" />

          {/* Elapsed-time counter — visible from the moment the
              modal observes an active refresh status. Mono
              tabular-nums keeps width stable as digits tick. */}
          {showElapsed && (
            <span className="inline-flex items-center gap-1.5 mr-2 px-1.5 h-5 rounded bg-slate-900/60 ring-1 ring-slate-800/80 font-mono tabular-nums text-[10.5px] text-slate-300">
              <span className="text-[9.5px] uppercase tracking-[0.18em] text-slate-500">elapsed</span>
              <span className={status === 'complete' && !error ? 'text-emerald-300' : 'text-slate-100'}>
                {elapsedStr}
              </span>
            </span>
          )}

          {status !== 'complete' && (
            <button
              type="button"
              onClick={toggleMinimize}
              className="w-7 h-7 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors flex items-center justify-center"
              title="Minimize"
            >
              {Icon.minimize('w-4 h-4')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-1 w-7 h-7 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors flex items-center justify-center"
            title={status === 'complete' ? 'Close' : 'Dismiss'}
          >
            {Icon.close('w-4 h-4')}
          </button>
        </div>

        {/* ─── Status strip (live "what's happening now") ───────────── */}
        <div className="flex-shrink-0 px-4 pt-3">
          <StatusStrip
            status={status}
            displaySourceName={displaySourceName}
            liveCounts={liveCounts}
            progressInfo={progressInfo}
            error={error}
            fallbackDetail={displayDetailFallback}
          />
        </div>

        {/* ─── Progress bar + label ─────────────────────────────────── */}
        {ratioDen > 0 && (
          <div className="flex-shrink-0 px-4 pt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
                Overall progress
              </span>
              <span className="font-mono tabular-nums text-[11px] text-slate-400">
                <span className={status === 'complete' && !error ? 'text-emerald-300' : 'text-cyan-200'}>
                  {ratioNum}
                </span>
                <span className="text-slate-600 mx-1">/</span>
                <span className="text-slate-300">{ratioDen}</span>
                <span className="text-slate-500 ml-1.5 text-[10px] uppercase tracking-[0.14em]">
                  sources · {ratioPct}%
                </span>
                {showElapsed && (
                  <>
                    <span className="text-slate-700 mx-2">·</span>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500 mr-1">
                      elapsed
                    </span>
                    <span className={status === 'complete' && !error ? 'text-emerald-300' : 'text-slate-200'}>
                      {elapsedStr}
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${
                  status === 'complete' && !error
                    ? 'bg-gradient-to-r from-emerald-500 to-emerald-400'
                    : error
                    ? 'bg-gradient-to-r from-rose-500 to-rose-400'
                    : 'bg-gradient-to-r from-cyan-500 to-cyan-400'
                }`}
                style={{ width: `${ratioPct}%` }}
              />
            </div>
          </div>
        )}

        {/* ─── Sources label ────────────────────────────────────────── */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 pt-4 pb-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500">
            Sources
            <span className="text-slate-700 mx-1.5">·</span>
            <span className="text-slate-400 tabular-nums">{sources.length}</span>
          </span>
          {summary.totalChannels > 0 && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 tabular-nums">
              <span className="text-slate-300">{formatInt(summary.totalChannels)}</span>
              <span className="text-slate-500 mx-1">ch</span>
              <span className="text-slate-700">·</span>
              <span className="text-slate-300 ml-1.5">{formatInt(summary.totalPrograms)}</span>
              <span className="text-slate-500 mx-1">prog</span>
            </span>
          )}
        </div>

        {/* ─── Sources list (THE scrollable area) ───────────────────── */}
        {/* flex-1 + min-h-0 is the actual scroll-fix. Without min-h-0,
            a flex-1 child won't shrink below its content's natural
            height, which is exactly the bug we're fixing. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          {sources.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className="w-10 h-10 rounded-md bg-slate-800/40 ring-1 ring-slate-700/60 flex items-center justify-center mb-3">
                {Icon.spinner('w-5 h-5 text-slate-400 animate-spin')}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">
                Scanning configuration
              </div>
              <div className="text-[12px] text-slate-400 max-w-sm">
                Waiting for the first source list to arrive from the backend…
              </div>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {sources.map((source, index) => {
                const isActive =
                  activeRowKey != null && normaliseName(source.name) === activeRowKey;
                return (
                  <li key={source.id || source.url || index}>
                    <SourceRow
                      source={source}
                      isActive={isActive}
                      liveCounts={isActive ? liveCounts : null}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ─── Footer ───────────────────────────────────────────────── */}
        {status === 'complete' && (
          <div className="flex-shrink-0 flex items-center justify-between px-4 h-12 border-t border-slate-800/80">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 tabular-nums">
              <span className="text-emerald-300">{summary.complete}</span>
              <span className="text-slate-500 ml-1">complete</span>
              {summary.failed > 0 && (
                <>
                  <span className="text-slate-700 mx-2">·</span>
                  <span className="text-rose-300">{summary.failed}</span>
                  <span className="text-slate-500 ml-1">failed</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200 hover:bg-emerald-500/[0.12] hover:border-emerald-400/60 transition-colors font-mono text-[10.5px] uppercase tracking-[0.18em]"
            >
              {Icon.check('w-3.5 h-3.5')}
              Done
            </button>
          </div>
        )}
        {error && status !== 'complete' && (
          <div className="flex-shrink-0 flex items-center justify-end px-4 h-12 border-t border-slate-800/80 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-700/80 bg-slate-900/40 text-slate-300 hover:bg-slate-800/60 hover:border-slate-600 transition-colors font-mono text-[10.5px] uppercase tracking-[0.18em]"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default EpgRefreshModal;
