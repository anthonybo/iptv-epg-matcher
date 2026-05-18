import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../utils/apiClient';
import { parseBulkSources, describeEntry } from '../utils/bulkSourceParser';
import { registerSession } from '../services/SSEService';
import iptvSourcesService from '../services/iptvSourcesService';

const inputClasses =
  'w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60';

const typeBadge = (type) => {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold';
  if (type === 'xtream') return `${base} bg-blue-500/20 text-blue-200 border border-blue-500/40`;
  return `${base} bg-purple-500/20 text-purple-200 border border-purple-500/40`;
};

const typeRailClass = (type, active) => {
  if (type === 'xtream') {
    return active
      ? 'bg-gradient-to-b from-blue-400 via-blue-500 to-blue-600'
      : 'bg-blue-500/30';
  }
  return active
    ? 'bg-gradient-to-b from-purple-400 via-purple-500 to-purple-600'
    : 'bg-purple-500/25';
};

const normalizeHost = (url) => {
  try { return new URL(url).host.toLowerCase(); } catch { return String(url || '').toLowerCase(); }
};

const normalizeMac = (mac) => String(mac || '').replace(/[:-]/g, '').toUpperCase();

const matchExisting = (entry, sources) => {
  if (!entry || !Array.isArray(sources) || sources.length === 0) return null;
  const targetHost = normalizeHost(entry.server);
  if (entry.type === 'xtream') {
    return sources.find((s) =>
      s.type === 'xtream'
      && normalizeHost(s.url) === targetHost
      && String(s.username || '') === String(entry.username || '')
    ) || null;
  }
  if (entry.type === 'stalker') {
    return sources.find((s) =>
      s.type === 'stalker'
      && normalizeHost(s.url) === targetHost
      && normalizeMac(s.mac_address) === normalizeMac(entry.mac)
    ) || null;
  }
  return null;
};

const formatExpDate = (expDate) => {
  if (!expDate || expDate === 'null') return null;
  const seconds = parseInt(expDate, 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toLocaleDateString();
};

const statusMeta = {
  pending: { label: 'Queued', bar: 'bg-slate-600', text: 'text-slate-400' },
  queuing: { label: 'Starting…', bar: 'bg-blue-500', text: 'text-blue-300' },
  loading: { label: 'Loading', bar: 'bg-blue-500', text: 'text-blue-300' },
  done: { label: 'Done', bar: 'bg-emerald-500', text: 'text-emerald-300' },
  failed: { label: 'Failed', bar: 'bg-red-500', text: 'text-red-300' },
};

// Translate raw backend stage names into plain-English labels the user can
// actually read. Unknown stages fall through to the status label (Loading etc.).
const STAGE_LABELS = {
  starting: 'Connecting to server',
  init: 'Connecting to server',
  checking_cache: 'Checking cache',
  cache_check: 'Checking cache',
  loading_channels: 'Downloading channel list',
  loading_xtream: 'Downloading channel list',
  loading_stalker: 'Downloading channel list',
  parsing_channels: 'Parsing channels',
  channels_loaded: 'Channels loaded',
  loading_epg: 'Loading guide data',
  loading_epg_source: 'Loading guide data',
  processing_epg: 'Matching guide data',
  finalizing: 'Saving to database',
  persisting: 'Saving to database',
  complete: 'Done',
};

const stageLabel = (state) => {
  if (state.stage && STAGE_LABELS[state.stage]) return STAGE_LABELS[state.stage];
  if (state.stage) {
    // Pretty-print unknown snake_case/dashed stages: "loading_channels" -> "Loading channels"
    const pretty = state.stage.replace(/[_-]+/g, ' ').trim();
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }
  return statusMeta[state.status]?.label || 'Working';
};

const formatElapsed = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
};

const STALL_SOFT_MS = 10000;  // shimmer + "Still working"
const STALL_HARD_MS = 60000;  // amber notice promoting the message

// ─── Edit-panel sub-components ─────────────────────────────────────

/**
 * FormatExampleCard — single supported-format reference card. Header
 * label, mono code block, hover-revealed Copy button. Used in the
 * collapsible format drawer.
 */
const FormatExampleCard = ({ label, sample, tone = 'cyan' }) => {
  const [copied, setCopied] = useState(false);
  const TONES = {
    cyan:    { label: 'text-cyan-300/90',    border: 'border-cyan-500/20',    glow: 'rgba(34,211,238,0.18)' },
    emerald: { label: 'text-emerald-300/90', border: 'border-emerald-500/20', glow: 'rgba(16,185,129,0.18)' },
    violet:  { label: 'text-violet-300/90',  border: 'border-violet-500/20',  glow: 'rgba(167,139,250,0.18)' },
    sky:     { label: 'text-sky-300/90',     border: 'border-sky-500/20',     glow: 'rgba(56,189,248,0.18)' },
    amber:   { label: 'text-amber-300/90',   border: 'border-amber-500/20',   glow: 'rgba(251,191,36,0.18)' }
  };
  const t = TONES[tone] || TONES.cyan;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sample);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`group/fmt relative rounded-md border ${t.border} bg-slate-950 overflow-hidden`} style={{ boxShadow: `inset 0 1px 0 ${t.glow}` }}>
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-slate-800/60 bg-slate-900/40">
        <span className={`font-mono text-[9px] font-bold uppercase tracking-[0.22em] ${t.label}`}>
          {label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-[0.16em] transition ${
            copied
              ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30'
              : 'bg-slate-900/60 text-slate-500 border border-slate-800 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          {copied ? (
            <>
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-slate-200 whitespace-pre overflow-x-auto [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
        {sample}
      </pre>
    </div>
  );
};

// Static reference for the format drawer. Keeping these here (not
// inside the component) so they don't re-create on every render.
const FORMAT_EXAMPLES = [
  {
    label: 'Standard M3U URL',
    tone: 'sky',
    sample: 'http://host:port/get.php?username=alice&password=hunter2&type=m3u_plus'
  },
  {
    label: 'Portal + labeled credentials',
    tone: 'cyan',
    sample: 'Portal: http://host:8080\nUsername: alice | Password: hunter2\nUsername: bob   | Password: sw0rdf1sh'
  },
  {
    label: 'Column list',
    tone: 'emerald',
    sample: 'canal-pro.xyz:8080    alice:hunter2    0/3    Active\ncanal-pro.xyz:8080    bob:sw0rdf1sh    1/3    Active'
  },
  {
    label: 'Stalker block',
    tone: 'violet',
    sample: 'Real ➤  Some Provider\nPortal ➤ http://portal:8080/c/\nMac    ➤ 00:1A:79:AA:BB:CC'
  },
  {
    label: 'Bare MAC list (uses Default Portal)',
    tone: 'amber',
    sample: '[MAC] ✔ 00:1A:79:11:22:33\n[MAC] ✔ 00:1A:79:44:55:66\n[MAC] ✔ 00:1A:79:77:88:99'
  }
];

// Quick heuristic counters so the textarea can show a live recognition
// hint as the user types — without running the actual parser on every
// keystroke. Cheap regex sweeps; the canonical count comes from
// parseBulkSources when Parse is clicked.
const URL_LIKE = /https?:\/\/[^\s|,]+/gi;
const MAC_LIKE = /(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/g;
const countInputSignals = (text) => {
  if (!text) return { lines: 0, urls: 0, macs: 0 };
  const trimmed = text.replace(/\r/g, '');
  const nonEmpty = trimmed.split('\n').filter((l) => l.trim().length > 0);
  const urls = (trimmed.match(URL_LIKE) || []).length;
  const macs = (trimmed.match(MAC_LIKE) || []).length;
  return { lines: nonEmpty.length, urls, macs };
};

// ─── Progress-panel sub-components ─────────────────────────────────
// All defined at module level so they're stable references (no
// remount on each parent render). They're presentation-only — no
// state of their own except local UI affordances.

/**
 * StackedProgressBar — the headline visual at the top of the bulk-
 * add panel. Four segments side-by-side: done (emerald), failed
 * (rose), loading (cyan w/ animated stripe), queued (slate). Each
 * segment's width is proportional to its share of the total. Count
 * labels overlay each segment when it's wide enough to fit.
 *
 * Heavy treatment (h-7) on purpose — this is the "is my bulk job
 * working" answer and should be readable from 8 feet away.
 */
const StackedProgressBar = ({ done, failed, loading, queued, total, isRunning }) => {
  const safeTotal = Math.max(total, 1);
  const pct = (n) => (n / safeTotal) * 100;
  const segments = [
    { key: 'done',    count: done,    pct: pct(done),    bg: 'bg-emerald-500',         label: 'done',    text: 'text-emerald-100' },
    { key: 'failed',  count: failed,  pct: pct(failed),  bg: 'bg-rose-500',            label: 'failed',  text: 'text-rose-100' },
    { key: 'loading', count: loading, pct: pct(loading), bg: 'bg-cyan-500 mv-refresh-stripe-light', label: 'loading', text: 'text-cyan-100', striped: true },
    { key: 'queued',  count: queued,  pct: pct(queued),  bg: 'bg-slate-700',           label: 'queued',  text: 'text-slate-300' }
  ];

  return (
    <div className="relative h-7 rounded-md overflow-hidden border border-slate-800/80 bg-slate-900/40 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]">
      <div className="absolute inset-0 flex">
        {segments.map((seg) => (
          seg.count > 0 && (
            <div
              key={seg.key}
              className={`relative h-full ${seg.bg} transition-[width] duration-300 overflow-hidden`}
              style={{ width: `${seg.pct}%` }}
              title={`${seg.count} ${seg.label}`}
            >
              {/* Stripe overlay on the loading segment so it's
                  visibly "in motion" even when its width isn't
                  changing. */}
              {seg.striped && isRunning && (
                <div
                  aria-hidden
                  className="absolute inset-0 mv-refresh-stripe opacity-50"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(-45deg, rgba(255,255,255,0.18) 0 6px, transparent 6px 14px)',
                    backgroundSize: '20px 100%'
                  }}
                />
              )}
              {/* Inline count — only render when the segment is
                  wide enough to fit it without ellipsis. */}
              {seg.pct >= 8 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className={`font-mono text-[11px] font-bold tabular-nums ${seg.text} drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]`}>
                    {seg.count}
                  </span>
                </div>
              )}
            </div>
          )
        ))}
      </div>
      {/* Subtle inner highlight on the top edge for depth. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/10" />
    </div>
  );
};

/**
 * FilterChip — toggle pill in the strip below the bar. Mirrors the
 * stacked-bar segment colors so the user reads "I'm filtering by
 * the rose segment" instinctively.
 */
const FilterChip = ({ active, onClick, label, count, tone }) => {
  const TONES = {
    slate:   { active: 'border-slate-600 bg-slate-800 text-slate-100',          rest: 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200' },
    emerald: { active: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200', rest: 'border-slate-800 bg-slate-900/40 text-emerald-300/80 hover:text-emerald-200' },
    rose:    { active: 'border-rose-500/50 bg-rose-500/15 text-rose-200',       rest: 'border-slate-800 bg-slate-900/40 text-rose-300/80 hover:text-rose-200' },
    cyan:    { active: 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200',       rest: 'border-slate-800 bg-slate-900/40 text-cyan-300/80 hover:text-cyan-200' }
  };
  const t = TONES[tone] || TONES.slate;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition ${
        active ? t.active : t.rest
      }`}
    >
      <span>{label}</span>
      <span className="font-mono text-[10px] tabular-nums">
        {count}
      </span>
    </button>
  );
};

/**
 * ErrorGroupCard — fingerprints identical error strings. Header
 * shows a big count badge + the error message; expanding shows the
 * list of affected source labels. Solves the original UX problem
 * (24 identical lines of unreadable red text per row → one card).
 */
const ErrorGroupCard = ({ group, expanded, onToggle }) => {
  const count = group.sources.length;
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.06] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-rose-500/10 transition text-left"
      >
        {/* Count badge — the dominant visual on the card. */}
        <span className="flex-shrink-0 inline-flex items-center justify-center min-w-[36px] h-7 px-2 rounded border border-rose-500/40 bg-rose-500/15 font-mono text-[11px] font-bold tabular-nums text-rose-100">
          {count}×
        </span>
        <span className="min-w-0 flex-1 font-mono text-[11px] text-rose-200 truncate">
          {group.error}
        </span>
        <svg
          className={`flex-shrink-0 w-3 h-3 text-rose-300/70 transition ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 pt-1 border-t border-rose-500/20 bg-rose-500/[0.03]">
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-rose-300/60 mb-1.5">
            Affected sources
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.sources.map((s, i) => {
              const label = s.entry.type === 'xtream'
                ? (s.entry.username || '—')
                : (s.entry.mac || '—');
              return (
                <span
                  key={i}
                  className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-rose-500/25 bg-rose-500/[0.06] text-rose-200/90"
                >
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * HostGroup — a single host's accounts collapsed into a labeled
 * section. The header row shows host + per-host status counts; the
 * body is the list of compact source rows for that host. Default
 * expanded; can be collapsed when the user has triaged this host.
 */
const HostGroup = ({ host, items, collapsed, onToggle, renderRow }) => {
  // Per-host aggregate counts so the header gives a glanceable
  // summary even when the body is collapsed.
  const counts = items.reduce((acc, it) => {
    const s = it.state.status;
    if (s === 'done') acc.done++;
    else if (s === 'failed') acc.failed++;
    else if (s === 'pending') acc.queued++;
    else acc.loading++;
    return acc;
  }, { done: 0, failed: 0, loading: 0, queued: 0 });

  return (
    <div className="rounded-md border border-slate-800/80 bg-slate-950 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2 bg-slate-900/40 hover:bg-slate-900/70 transition border-b border-slate-800/60 text-left"
      >
        <svg
          className={`flex-shrink-0 w-3 h-3 text-slate-500 transition ${collapsed ? '' : 'rotate-90'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-3.5 h-3.5 text-slate-500 flex-shrink-0">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
        </svg>
        <span className="font-mono text-[11.5px] text-slate-100 truncate flex-1 font-medium">
          {host}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums flex-shrink-0">
          <span className="text-slate-600">{items.length} accounts</span>
          {counts.done > 0    && <span className="text-emerald-300">{counts.done}✓</span>}
          {counts.failed > 0  && <span className="text-rose-300">{counts.failed}✗</span>}
          {counts.loading > 0 && <span className="text-cyan-300">{counts.loading}⟳</span>}
          {counts.queued > 0  && <span className="text-slate-500">{counts.queued}…</span>}
        </span>
      </button>
      {!collapsed && (
        <ul className="px-2 py-2 space-y-1">
          {items.map(renderRow)}
        </ul>
      )}
    </div>
  );
};

// Cap how many loads run concurrently on the backend. Each load hammers the
// channel table with 500-row INSERT batches; running too many at once hits
// Postgres `statement_timeout` and starves unrelated queries (/api/epg/init etc.).
const MAX_CONCURRENT = 2;

const createSession = async () => {
  const res = await apiClient.post('/session/create');
  const sessionId = res?.data?.sessionId;
  if (!sessionId) throw new Error('Failed to create session');
  return sessionId;
};

const submitEntry = async (entry) => {
  const sessionId = await createSession();
  try {
    await registerSession(sessionId);
  } catch (_err) {
    // Non-fatal — SSE registration isn't required for the backend to process.
  }

  const formData = new FormData();
  formData.append('sessionId', sessionId);
  if (entry.type === 'xtream') {
    formData.append('xtreamServer', entry.server);
    formData.append('xtreamUsername', entry.username);
    formData.append('xtreamPassword', entry.password);
  } else {
    formData.append('portalUrl', entry.server);
    formData.append('macAddress', entry.mac);
  }

  const response = await apiClient.post('/load', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  if (!response?.data?.success) {
    throw new Error(response?.data?.error || 'Load request was rejected');
  }
  return sessionId;
};

const BulkAddSources = ({ onSourceCompleted, onAllDone, onBulkProgressChange }) => {
  const [rawText, setRawText] = useState('');
  const [defaultPortal, setDefaultPortal] = useState('');
  const [parsed, setParsed] = useState(null);
  const [phase, setPhase] = useState('edit'); // 'edit' | 'running' | 'finished'
  const [entryStates, setEntryStates] = useState([]);
  // 1Hz "now" tick so elapsed timers and stall detection re-render without
  // each row owning its own interval.
  const [now, setNow] = useState(() => Date.now());
  const eventSourcesRef = useRef([]);
  const completedNotifiedRef = useRef(false);
  const queueRef = useRef({ pending: [], active: 0 });

  // ─── Progress-panel view state ─────────────────────────────────────
  // The user is staring at 39 rows in a modal — they need filters,
  // collapsible host groups, and an error-fingerprint summary so 24
  // identical HTTP 512 failures don't drown the readable rows. These
  // bits only affect rendering; the EventSource pipe + queue pump
  // don't see them.
  const [progressFilter, setProgressFilter] = useState('all'); // 'all' | 'loading' | 'failed' | 'done' | 'queued'
  // Hosts collapse to a single header row when toggled off. Default
  // is expanded for everything — but a user reviewing 100+ rows can
  // collapse a host they've already triaged.
  const [collapsedHosts, setCollapsedHosts] = useState(() => new Set());
  // Each unique error message has its own group card. Expanded =
  // shows the affected source list. Collapsed by default — the
  // header chip + count is the user's primary signal; the list is
  // there if they want to drill in.
  const [expandedErrorGroups, setExpandedErrorGroups] = useState(() => new Set());
  // Format-reference drawer in the edit panel. Closed by default;
  // the textarea is the primary affordance and the help is a
  // disclosable secondary layer.
  const [showFormatExamples, setShowFormatExamples] = useState(false);

  useEffect(() => () => {
    eventSourcesRef.current.forEach((es) => {
      try { es.close(); } catch (_err) { /* ignore */ }
    });
    eventSourcesRef.current = [];
  }, []);

  // Pulse `now` once a second while any row is running so timers/stall cues
  // stay live. Stops on its own once everything is terminal.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const hasPreview = parsed && (parsed.entries.length > 0 || parsed.errors.length > 0);
  const preview = useMemo(() => parsed?.entries || [], [parsed]);

  const doneCount = entryStates.filter((s) => s.status === 'done').length;
  const failedCount = entryStates.filter((s) => s.status === 'failed').length;
  const activeCount = entryStates.filter((s) => s.status === 'queuing' || s.status === 'loading').length;
  const waitingCount = entryStates.filter((s) => s.status === 'pending').length;
  const allTerminal = phase === 'running' && entryStates.length > 0 && activeCount === 0 && waitingCount === 0;

  useEffect(() => {
    if (allTerminal && !completedNotifiedRef.current) {
      completedNotifiedRef.current = true;
      setPhase('finished');
      if (onAllDone) onAllDone({ done: doneCount, failed: failedCount, total: entryStates.length });
    }
  }, [allTerminal, doneCount, failedCount, entryStates.length, onAllDone]);

  // Bridge bulk-add state into the parent's background-loadings tracker so:
  //   1) the floating progress bubble at the bottom-right of the app
  //      appears while a bulk-add is in flight,
  //   2) the parent keeps the modal mounted (under the
  //      `backgroundLoadings.size > 0` condition) when the user clicks X,
  //   3) closing the modal therefore doesn't kill in-flight EventSources
  //      OR drop the queue — the loop keeps pumping the remaining queued
  //      sources because BulkAddSources stays alive.
  // Without this, closing the modal mid-bulk silently discarded the queue
  // (only the 2 in-flight sources finished; the other 34 evaporated).
  //
  // The callback is stashed in a ref so the effect's dep array only
  // contains the actual data values. Including the callback prop
  // directly caused an infinite render loop: parent passes a fresh
  // arrow on every render → effect re-fires → effect calls back into
  // parent → parent re-renders → new arrow → loop. Reading via ref
  // makes the effect insensitive to callback identity changes.
  const onBulkProgressChangeRef = useRef(onBulkProgressChange);
  useEffect(() => {
    onBulkProgressChangeRef.current = onBulkProgressChange;
  }, [onBulkProgressChange]);

  useEffect(() => {
    const cb = onBulkProgressChangeRef.current;
    if (!cb) return;
    const isActive = phase === 'running' && entryStates.length > 0;
    cb({
      isActive,
      phase,
      total: entryStates.length,
      done: doneCount,
      failed: failedCount,
      loading: activeCount,
      queued: waitingCount,
    });
  }, [phase, entryStates.length, doneCount, failedCount, activeCount, waitingCount]);

  const updateEntry = (idx, patch) => {
    setEntryStates((prev) => {
      if (!prev[idx]) return prev;
      const current = prev[idx];
      // "Meaningful" = user-visible change; bumps lastUpdatedAt so stall detection
      // resets. Heartbeat-only events (no stage/progress/message/count change)
      // don't reset the clock.
      const meaningful =
        (patch.status !== undefined && patch.status !== current.status)
        || (patch.stage !== undefined && patch.stage !== current.stage)
        || (patch.message !== undefined && patch.message !== current.message)
        || (patch.progress !== undefined && patch.progress !== current.progress)
        || (patch.channelCount !== undefined && patch.channelCount !== current.channelCount);
      const next = prev.slice();
      next[idx] = {
        ...current,
        ...patch,
        ...(meaningful ? { lastUpdatedAt: Date.now() } : {}),
      };
      return next;
    });
  };

  const finalizeEntry = (idx, es, patch) => {
    try { es.close(); } catch (_err) { /* ignore */ }
    eventSourcesRef.current = eventSourcesRef.current.filter((x) => x !== es);
    updateEntry(idx, patch);
    if (patch.status === 'done' && patch.sessionId && onSourceCompleted) {
      try { onSourceCompleted(patch.sessionId); } catch (_err) { /* ignore */ }
    }
    releaseSlot();
  };

  const releaseSlot = () => {
    queueRef.current.active = Math.max(0, queueRef.current.active - 1);
    pumpQueue();
  };

  const pumpQueue = () => {
    while (
      queueRef.current.active < MAX_CONCURRENT
      && queueRef.current.pending.length > 0
    ) {
      const next = queueRef.current.pending.shift();
      queueRef.current.active += 1;
      // Fire-and-forget; startEntry handles its own error path and calls releaseSlot.
      startEntry(next.idx, next.entry);
    }
  };

  const startEntry = async (idx, entry) => {
    const startedAt = Date.now();
    // Stamp startedAt via a direct state merge so stall/elapsed math has a
    // baseline even before the first SSE event lands.
    setEntryStates((prev) => {
      if (!prev[idx]) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], startedAt, lastUpdatedAt: startedAt };
      return next;
    });
    updateEntry(idx, { status: 'queuing', message: 'Creating session…' });
    try {
      const sessionId = await submitEntry(entry);
      updateEntry(idx, { status: 'loading', sessionId, message: 'Load started', progress: 1 });
      subscribeProgress(idx, sessionId);
    } catch (err) {
      updateEntry(idx, {
        status: 'failed',
        error: err?.response?.data?.error || err?.message || 'Unknown error',
      });
      releaseSlot();
    }
  };

  const subscribeProgress = (idx, sessionId) => {
    let es;
    try {
      es = new EventSource(`/api/stream-updates/${sessionId}`);
    } catch (_err) {
      updateEntry(idx, { status: 'failed', error: 'EventSource unsupported' });
      return;
    }
    eventSourcesRef.current.push(es);

    const safeParse = (raw) => {
      try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
    };

    // Backend emits events through a mix of code paths:
    //   - detailedProgressService.js emits `percentage` (not `progress`)
    //   - some paths write `event: <type>\n` (named); the legacy sendSSEUpdate
    //     in sseUtils.js writes ONLY `data: ...\n\n` (unnamed)
    // Unnamed frames only fire onmessage, so we can't rely on addEventListener
    // for `complete`/`error` — onmessage has to be the canonical router.
    const getProgressNumber = (data) => {
      if (typeof data?.progress === 'number') return data.progress;
      if (typeof data?.percentage === 'number') return data.percentage;
      return null;
    };

    const applyProgress = (data) => {
      const patch = {};
      const n = getProgressNumber(data);
      if (n !== null) patch.progress = Math.max(0, n);
      if (typeof data.stage === 'string') patch.stage = data.stage;
      if (typeof data.message === 'string') patch.message = data.message;
      const nextChannelCount = data.channelCount ?? data.totalChannels;
      if (typeof nextChannelCount === 'number' && nextChannelCount > 0) patch.channelCount = nextChannelCount;
      if (Object.keys(patch).length > 0) updateEntry(idx, patch);
    };

    const handleComplete = (data) => {
      const n = getProgressNumber(data);
      finalizeEntry(idx, es, {
        status: 'done',
        progress: n !== null ? Math.max(n, 100) : 100,
        stage: 'complete',
        message: data.message || 'Complete',
        channelCount: data.channelCount || data.totalChannels,
        sessionId,
      });
    };

    const handleErrorEvent = (data) => {
      finalizeEntry(idx, es, {
        status: 'failed',
        error: data.message || data.error || 'Load failed',
        sessionId,
      });
    };

    const handleChannelsAvailable = (data) => {
      const channels = data.channelCount || data.totalChannels;
      updateEntry(idx, {
        stage: 'channels_loaded',
        ...(typeof channels === 'number' && channels > 0 ? { channelCount: channels } : {}),
        progress: Math.max(getProgressNumber(data) ?? 30, 30),
        message: channels ? `${channels.toLocaleString()} channels loaded` : 'Channels loaded',
      });
    };

    const routeByType = (data) => {
      const type = data?.type;
      if (type === 'complete') { handleComplete(data); return; }
      if (type === 'error') { handleErrorEvent(data); return; }
      if (type === 'channels_available' || type === 'channels-available') { handleChannelsAvailable(data); return; }
      // Fall through: everything else (progress, heartbeat, message, stage-only frames)
      // gets applied as a progress update if it carries any useful fields.
      applyProgress(data);
    };

    // onmessage catches unnamed SSE frames (the legacy broadcast path).
    es.onmessage = (e) => routeByType(safeParse(e.data));
    // Named listeners catch the direct-write paths that DO set event: <type>.
    es.addEventListener('progress', (e) => applyProgress(safeParse(e.data)));
    es.addEventListener('channels_available', (e) => handleChannelsAvailable(safeParse(e.data)));
    es.addEventListener('channels-available', (e) => handleChannelsAvailable(safeParse(e.data)));
    es.addEventListener('complete', (e) => handleComplete(safeParse(e.data)));
    es.addEventListener('error', (e) => handleErrorEvent(safeParse(e.data)));
    // Connection-level errors (e.g. transient network) don't mark the entry failed —
    // backend may still be processing and a reconnect will pick up the next event.
  };

  const [parsing, setParsing] = useState(false);
  const [checkingExisting, setCheckingExisting] = useState(false);
  // Bumps whenever a new parse starts so a slow in-flight getUserSources call
  // from the previous click can't clobber a fresh preview when it finally returns.
  const parseTokenRef = useRef(0);

  const handleParse = () => {
    setParsing(true);
    // Phase 1: synchronous regex parse. Renders immediately — no waiting on
    // the existing-sources HTTP call (which can queue behind backend DB work
    // during a bulk load and make Parse feel stuck).
    const result = parseBulkSources(rawText, { defaultPortal });
    const token = parseTokenRef.current + 1;
    parseTokenRef.current = token;
    setParsed({
      ...result,
      entries: result.entries.map((entry) => ({
        ...entry,
        alreadyExists: false,
        existingSource: null,
        selected: true,
      })),
    });
    setParsing(false);

    // Phase 2: background existing-source check. When it lands, merge the
    // alreadyExists / existingSource flags and flip selected off for dupes —
    // unless a newer parse has started in the meantime.
    setCheckingExisting(true);
    iptvSourcesService.getUserSources()
      .then((existing) => {
        if (parseTokenRef.current !== token) return;
        setParsed((prev) => {
          if (!prev) return prev;
          const nextEntries = prev.entries.map((entry) => {
            const match = matchExisting(entry, existing);
            return {
              ...entry,
              alreadyExists: Boolean(match),
              existingSource: match || null,
              // Only flip selected off for freshly-discovered duplicates. If
              // the user manually toggled a row while we were waiting, respect
              // that — only auto-override the initial default-true state.
              selected: match ? false : entry.selected,
            };
          });
          return { ...prev, entries: nextEntries };
        });
      })
      .catch(() => {
        // Non-fatal — everything just stays marked as New.
      })
      .finally(() => {
        if (parseTokenRef.current === token) setCheckingExisting(false);
      });
  };

  const setAllSelection = (mode) => {
    setParsed((prev) => {
      if (!prev) return prev;
      const nextEntries = prev.entries.map((entry) => {
        if (mode === 'all') return { ...entry, selected: true };
        if (mode === 'none') return { ...entry, selected: false };
        // 'new' — select only entries that don't already exist.
        return { ...entry, selected: !entry.alreadyExists };
      });
      return { ...prev, entries: nextEntries };
    });
  };

  const toggleEntry = (index) => {
    setParsed((prev) => {
      if (!prev) return prev;
      const nextEntries = prev.entries.map((entry, i) => (
        i === index ? { ...entry, selected: !entry.selected } : entry
      ));
      return { ...prev, entries: nextEntries };
    });
  };

  const handleReparse = () => {
    eventSourcesRef.current.forEach((es) => {
      try { es.close(); } catch (_err) { /* ignore */ }
    });
    eventSourcesRef.current = [];
    queueRef.current = { pending: [], active: 0 };
    completedNotifiedRef.current = false;
    setParsed(null);
    setEntryStates([]);
    setPhase('edit');
  };

  const handleRemove = (index) => {
    setParsed((prev) => {
      if (!prev) return prev;
      return { ...prev, entries: prev.entries.filter((_, i) => i !== index) };
    });
  };

  const handleSubmit = () => {
    const selected = preview.filter((entry) => entry.selected);
    if (!selected.length) return;
    completedNotifiedRef.current = false;
    const initial = selected.map((entry) => ({
      entry,
      status: 'pending',
      progress: 0,
      stage: null,
      message: selected.length > MAX_CONCURRENT ? 'Waiting for open slot…' : '',
      channelCount: 0,
      error: null,
      sessionId: null,
    }));
    setEntryStates(initial);
    setPhase('running');

    queueRef.current = {
      pending: selected.map((entry, idx) => ({ idx, entry })),
      active: 0,
    };
    pumpQueue();
  };

  // Re-queue every failed entry so the user can retry transient
  // rate-limits (which is exactly what the 24× HTTP 512 cluster in
  // their last bulk-add looked like). Reset the failed rows back to
  // 'pending' with cleared error/progress, then pump the queue.
  // Sources that are still loading or already done are left alone.
  const handleRetryFailed = () => {
    const failedIndices = entryStates
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.status === 'failed')
      .map(({ i }) => i);
    if (failedIndices.length === 0) return;

    completedNotifiedRef.current = false;
    setPhase('running');
    setEntryStates((prev) => prev.map((s, i) => {
      if (!failedIndices.includes(i)) return s;
      return {
        ...s,
        status: 'pending',
        progress: 0,
        stage: null,
        message: failedIndices.length > MAX_CONCURRENT ? 'Waiting for open slot…' : '',
        channelCount: 0,
        error: null,
        sessionId: null,
        startedAt: null,
        lastUpdatedAt: Date.now()
      };
    }));

    // Append the retried entries to the queue with their original
    // indices so the SSE-driven updateEntry calls still land on the
    // right row.
    queueRef.current.pending.push(
      ...failedIndices.map((i) => ({ idx: i, entry: entryStates[i].entry }))
    );
    pumpQueue();
  };

  // Drop everything that hasn't started yet. Sources already loading
  // run to completion (we can't tear down an in-flight backend job
  // from the client cleanly without losing the channels that already
  // imported). Pending entries get a 'cancelled' status so the user
  // sees a clear record of "this never got a chance" — distinct from
  // failed (which means it tried and the upstream rejected it).
  const handleCancelRemaining = () => {
    queueRef.current.pending = [];
    setEntryStates((prev) => prev.map((s) => {
      if (s.status !== 'pending') return s;
      return {
        ...s,
        status: 'failed',
        error: 'Cancelled before start',
        lastUpdatedAt: Date.now()
      };
    }));
  };

  const toggleHost = (host) => {
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host); else next.add(host);
      return next;
    });
  };

  const toggleErrorGroup = (key) => {
    setExpandedErrorGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const renderEditPanel = () => {
    // Live recognition signals — pure functions of rawText. Updates
    // every keystroke; cheap regex sweeps so this is fine inline.
    const signals = countInputSignals(rawText);
    const hasContent = rawText.trim().length > 0;

    // "User clicked Parse but parser returned nothing recognizable."
    // Detected from existing state (no new state needed): parse ran,
    // result was empty in BOTH entries and errors.
    const parsedNothing =
      parsed && parsed.entries.length === 0 && parsed.errors.length === 0 && hasContent;

    return (
      <section className="space-y-4">
        {/* ── HEADER STRIP ─────────────────────────────────────────
            Mono-caps section label + plain-English subtitle on the
            left; help-toggle chip on the right. The chip opens the
            format drawer below. Visually quieter than the prior
            `text-lg font-semibold` heading — the textarea is the
            star of the show, not the header. */}
        <div className="flex items-end justify-between gap-3 pb-2 border-b border-slate-800/80">
          <div className="min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
              Input · raw sources
            </div>
            <div className="mt-1 text-[13px] text-slate-300">
              Paste any mix of Xtream accounts, MAG/Stalker portals, or bulk MAC lists. Each line is auto-detected.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowFormatExamples((v) => !v)}
            aria-expanded={showFormatExamples}
            className={`flex-shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border transition ${
              showFormatExamples
                ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-cyan-200 hover:border-cyan-500/30'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
              {showFormatExamples ? 'Hide formats' : 'View formats'}
            </span>
          </button>
        </div>

        {/* ── FORMAT REFERENCE DRAWER ──────────────────────────────
            Bouncy slide-down using the existing `mv-anim-palette-in`
            keyframes. Each example is a self-contained card with
            its own Copy button so the user can grab the syntax
            without retyping. Closed by default — out of the way. */}
        {showFormatExamples && (
          <div className="mv-anim-palette-in rounded-lg border border-slate-800/80 bg-slate-900/40 p-3 space-y-2">
            <div className="flex items-center gap-2 pb-1.5 mb-1 border-b border-slate-800/60">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-3.5 h-3.5 text-cyan-300/70">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                Supported formats — click Copy to grab a starter template
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {FORMAT_EXAMPLES.map((ex, i) => (
                <FormatExampleCard key={i} label={ex.label} sample={ex.sample} tone={ex.tone} />
              ))}
            </div>
          </div>
        )}

        {/* ── DEFAULT PORTAL STRIP ─────────────────────────────────
            Sits ABOVE the textarea as a compact header strip; the
            user reads it as "this is what we'll use for unqualified
            MAC lines below". Violet accent matches the Stalker
            source-type color since this field is Stalker-only. */}
        <div className="rounded-md border border-violet-500/20 bg-violet-500/[0.04] overflow-hidden">
          <div className="flex items-stretch">
            <div className="flex items-center gap-2 px-3 py-2 border-r border-violet-500/15 bg-violet-500/[0.05]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-3.5 h-3.5 text-violet-300/80 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2a4 4 0 014-4h4m0 0l-3-3m3 3l-3 3M5 7h14v12H5V7z" />
              </svg>
              <div className="leading-tight">
                <div className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-violet-200/90">
                  Default Portal
                </div>
                <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-violet-400/60">
                  for bare MAC lines
                </div>
              </div>
            </div>
            <input
              type="text"
              placeholder="http://z1mac.com:8080/c/  (optional)"
              value={defaultPortal}
              onChange={(e) => setDefaultPortal(e.target.value)}
              className="flex-1 bg-transparent px-3 py-2 text-[12.5px] font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none"
            />
          </div>
        </div>

        {/* ── SOURCES TERMINAL ────────────────────────────────────
            The textarea is the actual workspace. Custom border so
            it reads as a code terminal: dark plate, mono content,
            cyan-tinted edge when there's recognizable content, and
            a live counter overlay in the bottom-right corner. */}
        <div className={`relative rounded-md border bg-slate-950 transition-colors overflow-hidden ${
          parsedNothing
            ? 'border-rose-500/40 shadow-[0_0_0_3px_rgba(244,63,94,0.06)]'
            : signals.urls + signals.macs > 0
              ? 'border-cyan-500/30 shadow-[0_0_0_3px_rgba(34,211,238,0.05)]'
              : 'border-slate-800'
        }`}>
          {/* Top rail — terminal-style chrome strip. */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800/80 bg-slate-900/40">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500/40" />
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/40" />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
              <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.22em] text-slate-600">
                sources.txt
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
              <span className="text-slate-500">
                {signals.lines}<span className="text-slate-700"> lines</span>
              </span>
              {signals.urls > 0 && (
                <>
                  <span className="text-slate-800">·</span>
                  <span className="text-sky-300/90">
                    {signals.urls}<span className="text-sky-500/60"> URL{signals.urls === 1 ? '' : 's'}</span>
                  </span>
                </>
              )}
              {signals.macs > 0 && (
                <>
                  <span className="text-slate-800">·</span>
                  <span className="text-violet-300/90">
                    {signals.macs}<span className="text-violet-500/60"> MAC{signals.macs === 1 ? '' : 's'}</span>
                  </span>
                </>
              )}
            </div>
          </div>

          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={'# Paste any mix — auto-detected line-by-line\n\nhttp://server1/get.php?username=u1&password=p1&type=m3u_plus\nhttp://server1/get.php?username=u2&password=p2&type=m3u_plus\n\nPortal ➤ http://portal/c/\nMac    ➤ 00:1A:79:AA:BB:CC\n\n[MAC] ✔ 00:1A:79:11:22:33'}
            className="w-full bg-transparent px-3.5 py-3 text-[12.5px] font-mono leading-relaxed text-slate-100 placeholder:text-slate-700 focus:outline-none resize-y min-h-[14rem]"
          />
        </div>

        {/* ── COULDN'T-RECOGNIZE WARNING ──────────────────────────
            Fires when the user clicked Parse but the parser found
            zero entries AND zero errors — the prior silent-fail
            mode. Inline rose card with the diagnosis + a quick
            link to the format drawer. */}
        {parsedNothing && (
          <div className="mv-anim-palette-in rounded-md border border-rose-500/40 bg-rose-500/[0.06] px-3 py-2.5 flex items-start gap-2.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 text-rose-300 flex-shrink-0 mt-0.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3v.008m9-3.758a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10.5px] font-bold uppercase tracking-[0.18em] text-rose-200">
                Couldn't recognize any sources in that input
              </div>
              <div className="mt-1 text-[12px] text-rose-200/80">
                The parser scanned your input and didn't find any Xtream URLs, Stalker portals, or MAC lines.
                {' '}
                <button
                  type="button"
                  onClick={() => setShowFormatExamples(true)}
                  className="underline decoration-rose-500/50 hover:decoration-rose-300 text-rose-100"
                >
                  Show supported formats
                </button>
                {' '}or try one of the templates above.
              </div>
            </div>
          </div>
        )}

        {/* ── ACTION FOOTER ───────────────────────────────────────
            Mono caps live tally on the left; emerald Parse CTA on
            the right with a clear "Parse N lines →" call. The CTA
            gets an inner glow when enabled so it reads as the
            primary action. Disabled state is flat with a tooltip. */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/60">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            {hasContent ? (
              <>
                Ready to parse
                <span className="text-slate-700"> · </span>
                <span className="text-slate-300 tabular-nums normal-case tracking-normal">
                  {signals.lines} non-empty line{signals.lines === 1 ? '' : 's'}
                </span>
              </>
            ) : (
              <span className="text-slate-600">Paste sources above to begin</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {hasPreview && (
              <button
                type="button"
                onClick={handleReparse}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-900 hover:text-slate-200 transition font-mono text-[10px] font-bold uppercase tracking-[0.16em]"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={handleParse}
              disabled={parsing || !hasContent}
              title={!hasContent ? 'Paste some sources to parse.' : undefined}
              className={`inline-flex items-center gap-2 h-9 px-4 rounded-md border transition ${
                parsing
                  ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200 cursor-wait'
                  : !hasContent
                    ? 'border-slate-800 bg-slate-900/40 text-slate-700 cursor-not-allowed'
                    : 'border-emerald-500/50 bg-emerald-500/[0.12] text-emerald-100 hover:bg-emerald-500/20 hover:border-emerald-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_18px_-4px_rgba(16,185,129,0.5)]'
              }`}
            >
              {parsing ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">Parsing…</span>
                </>
              ) : (
                <>
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">
                    {hasContent ? `Parse ${signals.lines} line${signals.lines === 1 ? '' : 's'}` : 'Parse'}
                  </span>
                  <svg className="w-3.5 h-3.5 transition group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </>
              )}
            </button>
          </div>
        </div>
      </section>
    );
  };

  const renderPreviewRow = (entry, i) => {
    const { alreadyExists, selected, existingSource, type } = entry;
    const expDate = alreadyExists ? formatExpDate(existingSource?.exp_date) : null;
    const channelCount = alreadyExists ? (existingSource?.channel_count || 0) : 0;

    return (
      <div
        key={`${type}-${i}`}
        role="button"
        tabIndex={0}
        onClick={() => toggleEntry(i)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggleEntry(i);
          }
        }}
        className={`relative flex items-stretch gap-0 rounded-lg border transition-colors duration-150 cursor-pointer select-none overflow-hidden group ${
          selected
            ? 'border-slate-700 bg-slate-900/60 hover:border-slate-600'
            : alreadyExists
              ? 'border-slate-800/70 bg-slate-900/30 opacity-70 hover:opacity-90 hover:border-amber-500/30'
              : 'border-slate-800/70 bg-slate-900/30 opacity-60 hover:opacity-90 hover:border-slate-700'
        }`}
      >
        <span className={`w-1 shrink-0 transition-colors duration-150 ${typeRailClass(type, selected)}`} />

        <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3">
          <span
            aria-hidden
            className={`shrink-0 flex items-center justify-center w-5 h-5 rounded-md border transition-all duration-150 ${
              selected
                ? 'bg-blue-500 border-blue-400 shadow-[0_0_0_3px_rgba(59,130,246,0.15)]'
                : 'bg-slate-900 border-slate-600 group-hover:border-slate-400'
            }`}
          >
            {selected && (
              <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 10.5l3.5 3.5L15 7" />
              </svg>
            )}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`text-xs font-semibold tracking-[0.12em] uppercase ${
                type === 'xtream' ? 'text-blue-300/80' : 'text-purple-300/80'
              }`}>
                {type === 'xtream' ? 'Xtream' : 'Stalker'}
              </span>
              <span className="text-slate-100 text-sm font-semibold truncate">
                {type === 'xtream' ? entry.username : entry.mac}
              </span>
            </div>
            <div className="text-xs text-slate-400 truncate font-mono">{entry.server}</div>
          </div>

          <div className="shrink-0 flex flex-col items-end gap-0.5 text-right">
            {alreadyExists ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase text-amber-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  Already added
                </span>
                <span className="text-[11px] text-slate-500">
                  {channelCount.toLocaleString()} ch
                  {expDate ? ` · exp ${expDate}` : ''}
                </span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase text-emerald-300/90">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                New
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleRemove(i);
            }}
            className="shrink-0 -mr-1 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800/80 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Remove from list"
            aria-label="Remove from list"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  const renderPreview = () => {
    const total = preview.length;
    const existingCount = preview.filter((e) => e.alreadyExists).length;
    const newCount = total - existingCount;
    const selectedCount = preview.filter((e) => e.selected).length;
    const canSubmit = selectedCount > 0;

    const filterButton = (mode, label) => {
      const isActive =
        (mode === 'all' && selectedCount === total && total > 0)
        || (mode === 'none' && selectedCount === 0)
        || (mode === 'new' && selectedCount === newCount && preview.every((e) => e.selected === !e.alreadyExists));
      return (
        <button
          type="button"
          onClick={() => setAllSelection(mode)}
          className={`px-3 py-1.5 text-xs font-semibold tracking-wide transition-colors ${
            isActive
              ? 'bg-slate-800 text-slate-100 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.25)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {label}
        </button>
      );
    };

    return (
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h4 className="text-base font-semibold text-slate-100">Preview</h4>
            <div className="mt-1 flex items-center gap-3 text-xs tracking-wide">
              <span className="text-emerald-300/90">
                <span className="font-semibold text-emerald-200">{newCount}</span> new
              </span>
              {existingCount > 0 && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-amber-300/90">
                    <span className="font-semibold text-amber-200">{existingCount}</span> already added
                  </span>
                </>
              )}
              <span className="text-slate-700">·</span>
              <span className="text-slate-500">
                <span className="font-semibold text-slate-300">{total}</span> total
              </span>
              {checkingExisting && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="inline-flex items-center gap-1.5 text-slate-500">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Checking existing…
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900/60 overflow-hidden divide-x divide-slate-800">
            {filterButton('new', 'Only new')}
            {filterButton('all', 'All')}
            {filterButton('none', 'None')}
          </div>
        </div>

        {existingCount > 0 && (
          <p className="text-xs text-slate-500 leading-relaxed">
            Already-added accounts are unchecked by default. Re-checking one will re-download its channels and refresh account info.
          </p>
        )}

        {parsed?.errors?.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100 space-y-1">
            {parsed.errors.map((err, i) => (
              <div key={i}>
                <span className="font-semibold">Line {err.line}:</span> {err.reason}
                <div className="text-amber-300/80 truncate">{err.text}</div>
              </div>
            ))}
          </div>
        )}

        {total > 0 && (
          <div className="space-y-1.5">
            {preview.map(renderPreviewRow)}
          </div>
        )}

        {total > 0 && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="text-xs text-slate-500">
              {canSubmit
                ? `${selectedCount} of ${total} selected`
                : 'Nothing selected — check at least one source to continue'}
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/40 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:brightness-90"
            >
              {canSubmit
                ? `Add ${selectedCount} Source${selectedCount === 1 ? '' : 's'}`
                : 'Add Sources'}
            </button>
          </div>
        )}
      </section>
    );
  };

  // ── Compact single-row renderer (~32px tall) ─────────────────────
  // Replaces the old card-per-source layout. Each row is one
  // operational line with: status dot · type chip · username ·
  // inline progress bar · numeric column · status pill. Density:
  // 12-15 rows visible at modal default size, ~30 with a tall window.
  const renderProgressRow = (state, idx) => {
    const pct = typeof state.progress === 'number' ? Math.min(100, Math.max(0, state.progress)) : 0;
    const active = state.status === 'queuing' || state.status === 'loading';
    const terminal = state.status === 'done' || state.status === 'failed';
    const elapsed = state.startedAt
      ? (terminal && state.lastUpdatedAt ? state.lastUpdatedAt - state.startedAt : now - state.startedAt)
      : 0;
    const sinceUpdate = state.lastUpdatedAt ? now - state.lastUpdatedAt : 0;
    const stalledHard = active && sinceUpdate >= STALL_HARD_MS;
    const stageText = state.status === 'done'
      ? 'Done'
      : state.status === 'failed'
        ? (state.error === 'Cancelled before start' ? 'Cancelled' : 'Failed')
        : stageLabel(state);

    const isInDbPhase = (state.stage === 'persisting' || state.stage === 'finalizing');

    // Pull the "saved / total" numbers out of the persisting-phase
    // message ("Saving channels to database… 500 / 8,238 (39%)").
    // The numbers are what the user actually wants to see during
    // this slow phase — without them the row sits at "97%" for
    // minutes and feels frozen. Declared BEFORE barWidth because
    // barWidth uses it (TDZ issue otherwise).
    let saveProgress = null;
    if (isInDbPhase && state.message) {
      const m = state.message.match(/([\d,]+)\s*\/\s*([\d,]+)\s*(?:\(\s*(\d+)\s*%\s*\))?/);
      if (m) {
        const saved = parseInt(m[1].replace(/,/g, ''), 10);
        const total = parseInt(m[2].replace(/,/g, ''), 10);
        const innerPct = m[3] != null ? parseInt(m[3], 10)
                                       : (total > 0 ? Math.round((saved / total) * 100) : 0);
        if (Number.isFinite(saved) && Number.isFinite(total) && total > 0) {
          saveProgress = { saved, total, pct: innerPct };
        }
      }
    }

    // Inline progress fill — colored bar that sits BEHIND the row
    // content, not above/below.
    //
    // The pipeline's outer `pct` advances through milestones
    // (fetched=10, parsed=40, persisting=97, complete=100) so it
    // would freeze at 97% for the entire 5-minute INSERT loop —
    // visually indistinguishable from a frozen row. During the
    // persisting phase we use the INNER save-phase % instead so
    // the bar fills smoothly 0→100% as channels land in the DB.
    // The user sees real motion proportional to the actual work
    // remaining, which is the bulk of the wall-clock time anyway.
    const barWidth = state.status === 'done' ? 100
      : state.status === 'failed' ? 0
      : (saveProgress ? saveProgress.pct : pct);

    const trackBg = state.status === 'done' ? 'bg-emerald-500/10'
      : state.status === 'failed' ? 'bg-rose-500/10'
      : stalledHard ? 'bg-amber-500/10'
      : 'bg-slate-900/60';
    const fillBg = state.status === 'done' ? 'bg-emerald-500/25'
      : state.status === 'failed' ? 'bg-rose-500/20'
      : 'bg-cyan-500/15';

    const dotBg = state.status === 'done' ? 'bg-emerald-400'
      : state.status === 'failed' ? 'bg-rose-400'
      : active ? 'bg-cyan-400'
      : 'bg-slate-600';

    const typeChip = state.entry.type === 'xtream'
      ? 'text-sky-300 border-sky-500/30 bg-sky-500/[0.08]'
      : 'text-violet-300 border-violet-500/30 bg-violet-500/[0.08]';

    const statusText = state.status === 'done' ? 'text-emerald-300'
      : state.status === 'failed' ? 'text-rose-300'
      : active ? 'text-cyan-200'
      : 'text-slate-500';

    // Label — just the username for xtream (host is in the group
    // header) or the MAC for stalker. describeEntry returns the
    // host-included version; we strip the host since it's redundant
    // when grouped.
    const label = state.entry.type === 'xtream'
      ? (state.entry.username || describeEntry(state.entry))
      : (state.entry.mac || describeEntry(state.entry));

    return (
      <li key={idx} className="group">
        <div className={`relative flex items-center gap-2 h-9 px-3 rounded-md border border-slate-800/80 ${trackBg} overflow-hidden`}>
          {/* Inline progress fill — sits BEHIND the content. */}
          <div
            aria-hidden
            className={`absolute inset-y-0 left-0 ${fillBg} transition-[width] duration-300`}
            style={{ width: `${barWidth}%` }}
          />
          {/* Animated stripe overlay during the slow DB save step,
              so the user can distinguish "downloading channels" from
              "writing to the DB" at a glance. */}
          {active && isInDbPhase && (
            <div
              aria-hidden
              className="absolute inset-y-0 pointer-events-none opacity-30 mv-refresh-stripe"
              style={{
                left: 0,
                width: `${barWidth}%`,
                backgroundImage:
                  'repeating-linear-gradient(-45deg, rgba(34,211,238,0.45) 0 8px, transparent 8px 16px)',
                backgroundSize: '24px 100%'
              }}
            />
          )}

          {/* All content rides above the fill. */}
          <span className={`relative z-10 flex-shrink-0 w-1.5 h-1.5 rounded-full ${dotBg}`}>
            {active && (
              <span className="absolute inset-0 rounded-full bg-cyan-400 opacity-60 animate-ping" />
            )}
          </span>

          <span className={`relative z-10 flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded border font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${typeChip}`}>
            {state.entry.type === 'xtream' ? 'XTR' : 'STK'}
          </span>

          <span className="relative z-10 min-w-0 flex-1 font-mono text-[11.5px] text-slate-100 truncate">
            {label}
          </span>

          {/* Right-aligned numeric column. During the persisting
              (DB save) phase, the channel count is replaced with
              a live "saved / total" display so the user can watch
              progress climb instead of staring at a static total.
              Order: channels · pct · elapsed. */}
          <span className="relative z-10 hidden sm:flex items-center gap-2.5 font-mono text-[10.5px] tabular-nums text-slate-400 flex-shrink-0">
            {saveProgress ? (
              // Persisting phase — show live per-batch progress.
              // saved/total replaces the static channel count, and
              // the percentage shown is the INNER save-phase pct
              // (not the outer 97-99% pipeline band) so it climbs
              // 0→100 visibly during the long INSERT loop.
              <span
                title={`Saved ${saveProgress.saved.toLocaleString()} of ${saveProgress.total.toLocaleString()} channels (${saveProgress.pct}%)`}
                className="inline-flex items-baseline gap-1"
              >
                <span className="text-cyan-200">{saveProgress.saved.toLocaleString()}</span>
                <span className="text-slate-600">/</span>
                <span>{saveProgress.total.toLocaleString()}</span>
                <span className="text-slate-600 ml-0.5">ch</span>
              </span>
            ) : (
              state.channelCount > 0 && state.status !== 'failed' && (
                <span title={`${state.channelCount.toLocaleString()} channels`}>
                  {state.channelCount.toLocaleString()}<span className="text-slate-600 ml-0.5">ch</span>
                </span>
              )
            )}
            {active && (saveProgress
              ? (
                <span title={`${saveProgress.pct}% saved`} className="text-cyan-200">
                  {saveProgress.pct}%
                </span>
              )
              : (typeof state.progress === 'number' && (
                <span title={`${Math.round(pct)}%`} className="text-cyan-200">
                  {Math.round(pct)}%
                </span>
              ))
            )}
            {(active || terminal) && state.startedAt && (
              <span title={`elapsed ${formatElapsed(elapsed)}`} className="text-slate-500">
                {formatElapsed(elapsed)}
              </span>
            )}
          </span>

          <span className={`relative z-10 flex-shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${statusText}`}>
            {stalledHard && active ? 'Stalled' : stageText}
          </span>
        </div>

        {/* Per-row error message — only shown when status is failed
            AND the error isn't already represented in the error-
            fingerprint card above. Currently we always show it
            inline for symmetry; the group card is the bird's-eye
            summary, the row is the per-source detail. */}
        {state.status === 'failed' && state.error && state.error !== 'Cancelled before start' && (
          <div className="mt-1 px-3 text-[10.5px] font-mono text-rose-400/80 truncate" title={state.error}>
            ↳ {state.error}
          </div>
        )}
      </li>
    );
  };

  // Wall-clock span across the whole batch.
  const wallClock = (() => {
    const withStart = entryStates.filter((s) => s.startedAt);
    if (withStart.length === 0) return null;
    const earliest = Math.min(...withStart.map((s) => s.startedAt));
    if (phase === 'finished') {
      const latest = Math.max(...withStart.map((s) => s.lastUpdatedAt || s.startedAt));
      return latest - earliest;
    }
    return now - earliest;
  })();

  // Group entries by normalized host so the modal reads as a list
  // of providers, not a list of 39 sources that all repeat the same
  // host string. The user previously stared at "http://mrtrb.xyz:8080"
  // 39 times — once per row.
  const buildHostGroups = (states) => {
    const groups = new Map();
    states.forEach((s, idx) => {
      const host = normalizeHost(s.entry.server) || 'unknown';
      if (!groups.has(host)) groups.set(host, []);
      groups.get(host).push({ state: s, idx });
    });
    return groups;
  };

  // Bucket failures by error message so 24 copies of "HTTP 512:
  // Unknown Error" collapse into a single card with a count badge.
  // The user lost the readable rows under 24 lines of identical
  // red text — fingerprinting + group display fixes that.
  const buildErrorGroups = (states) => {
    const groups = new Map();
    states.forEach((s) => {
      if (s.status !== 'failed' || !s.error || s.error === 'Cancelled before start') return;
      const key = s.error.trim();
      if (!groups.has(key)) {
        groups.set(key, { error: key, sources: [] });
      }
      groups.get(key).sources.push(s);
    });
    return Array.from(groups.values()).sort((a, b) => b.sources.length - a.sources.length);
  };

  const matchesFilter = (state) => {
    if (progressFilter === 'all') return true;
    if (progressFilter === 'loading') return state.status === 'queuing' || state.status === 'loading';
    if (progressFilter === 'failed') return state.status === 'failed';
    if (progressFilter === 'done') return state.status === 'done';
    if (progressFilter === 'queued') return state.status === 'pending';
    return true;
  };

  const renderProgressPanel = () => {
    const total = entryStates.length;
    const finishedCount = doneCount + failedCount;
    const overallPct = total > 0 ? Math.round((finishedCount / total) * 100) : 0;

    // Filtered + grouped rows
    const filteredStates = entryStates.filter(matchesFilter);
    const hostGroups = buildHostGroups(filteredStates);
    const errorGroups = phase === 'edit' ? [] : buildErrorGroups(entryStates);
    const hostsSorted = Array.from(hostGroups.keys()).sort();

    const phaseLabel = phase === 'finished' ? 'Run complete' : 'Run in progress';
    const isRunning = phase === 'running';

    return (
      <section className="space-y-4">

        {/* ── STICKY HEADER ──────────────────────────────────────
            Headline visual: stacked progress bar + big mono counts.
            Sticky at the top so it stays visible while scrolling
            through the rows below. */}
        <div className="sticky top-0 z-20 -mx-5 px-5 py-3 -mt-5 mb-2 bg-slate-950 border-b border-slate-800/80 backdrop-blur">
          {/* Title row */}
          <div className="flex items-baseline justify-between gap-3 mb-2.5">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                {phaseLabel}
              </span>
              <span className="font-mono text-[10px] text-slate-700">·</span>
              <span className="font-mono text-[10px] tabular-nums text-slate-400">
                {wallClock !== null ? formatElapsed(wallClock) : '0s'}
              </span>
              {isRunning && (
                <>
                  <span className="font-mono text-[10px] text-slate-700">·</span>
                  <span className="font-mono text-[10px] text-slate-500">
                    Max {MAX_CONCURRENT} concurrent
                  </span>
                </>
              )}
            </div>
            <div className="flex items-baseline gap-1.5 flex-shrink-0">
              <span className="text-[28px] leading-none font-bold font-mono tabular-nums text-slate-100">
                {finishedCount}
              </span>
              <span className="text-slate-600 font-mono text-base">/</span>
              <span className="font-mono tabular-nums text-slate-500 text-base">{total}</span>
            </div>
          </div>

          {/* Stacked progress bar — done | failed | loading | queued.
              The headline at-a-glance "what's the state of this job".
              Each segment colored + labeled with a count overlay
              when wide enough to fit. */}
          <StackedProgressBar
            done={doneCount}
            failed={failedCount}
            loading={activeCount}
            queued={waitingCount}
            total={total}
            isRunning={isRunning}
          />

          {/* Filter chips + summary counts. The counts here mirror
              the bar segments — they double as filter buttons. */}
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterChip
                active={progressFilter === 'all'}
                onClick={() => setProgressFilter('all')}
                label="All"
                count={total}
                tone="slate"
              />
              {doneCount > 0 && (
                <FilterChip
                  active={progressFilter === 'done'}
                  onClick={() => setProgressFilter('done')}
                  label="Done"
                  count={doneCount}
                  tone="emerald"
                />
              )}
              {failedCount > 0 && (
                <FilterChip
                  active={progressFilter === 'failed'}
                  onClick={() => setProgressFilter('failed')}
                  label="Failed"
                  count={failedCount}
                  tone="rose"
                />
              )}
              {activeCount > 0 && (
                <FilterChip
                  active={progressFilter === 'loading'}
                  onClick={() => setProgressFilter('loading')}
                  label="Loading"
                  count={activeCount}
                  tone="cyan"
                />
              )}
              {waitingCount > 0 && (
                <FilterChip
                  active={progressFilter === 'queued'}
                  onClick={() => setProgressFilter('queued')}
                  label="Queued"
                  count={waitingCount}
                  tone="slate"
                />
              )}
            </div>

            <span className="font-mono text-[10px] tabular-nums text-slate-500">
              {overallPct}% complete
            </span>
          </div>
        </div>

        {/* ── ERROR FINGERPRINT CARDS ────────────────────────────
            Group identical errors so 24× HTTP 512s collapse to a
            single card with a big count badge + expandable affected-
            sources list. This is what the user couldn't read before:
            small red text repeating per row. Now it's one prominent
            card and the per-row clutter goes away. */}
        {errorGroups.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3 text-rose-300">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3v.008m9-3.758a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                Errors · {errorGroups.length} unique signature{errorGroups.length === 1 ? '' : 's'} across {failedCount} source{failedCount === 1 ? '' : 's'}
              </span>
            </div>
            {errorGroups.map((group, i) => (
              <ErrorGroupCard
                key={i}
                group={group}
                expanded={expandedErrorGroups.has(group.error)}
                onToggle={() => toggleErrorGroup(group.error)}
              />
            ))}
          </div>
        )}

        {/* ── HOST-GROUPED SOURCE LIST ───────────────────────────
            Sources collapsed into a per-host group. The host header
            shows the host + its in-flight stats; the rows beneath
            are the per-account progress lines. Default state is
            expanded; the user can collapse hosts they've triaged. */}
        <div className="max-h-[55vh] overflow-y-auto pr-1 space-y-3 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
          {hostsSorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-600">
                No sources match this filter
              </span>
              {progressFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setProgressFilter('all')}
                  className="mt-3 px-3 py-1 rounded-md border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-xs"
                >
                  Show all sources
                </button>
              )}
            </div>
          ) : (
            hostsSorted.map((host) => (
              <HostGroup
                key={host}
                host={host}
                items={hostGroups.get(host)}
                collapsed={collapsedHosts.has(host)}
                onToggle={() => toggleHost(host)}
                renderRow={(item) => renderProgressRow(item.state, item.idx)}
              />
            ))
          )}
        </div>

        {/* ── FOOTER ACTIONS ─────────────────────────────────────
            Sticky-style row of decisive actions. Cancel remaining
            (pending only) on the left, Retry failed (re-queues all
            failed entries) on the right. Both visually distinct
            from the rest of the UI so they don't get lost. */}
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-800/80">
          <div className="flex items-center gap-2">
            {waitingCount > 0 && isRunning && (
              <button
                type="button"
                onClick={handleCancelRemaining}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-700 bg-slate-900/60 hover:bg-rose-500/10 hover:border-rose-500/30 hover:text-rose-200 text-slate-300 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.16em]">
                  Cancel {waitingCount} queued
                </span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {failedCount > 0 && (
              <button
                type="button"
                onClick={handleRetryFailed}
                title={`Re-queue ${failedCount} failed source${failedCount === 1 ? '' : 's'} for another attempt`}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/[0.08] text-amber-200 hover:bg-amber-500/15 hover:border-amber-500/50 transition shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_12px_-4px_rgba(251,191,36,0.4)]"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.16em]">
                  Retry {failedCount} failed
                </span>
              </button>
            )}
            {phase === 'finished' && (
              <button
                type="button"
                onClick={handleReparse}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-200 hover:bg-emerald-500/15 hover:border-emerald-500/50 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.16em]">
                  Add more
                </span>
              </button>
            )}
          </div>
        </div>
      </section>
    );
  };

  return (
    <div className="mt-8 space-y-8">
      {phase === 'edit' && renderEditPanel()}
      {phase === 'edit' && hasPreview && renderPreview()}
      {(phase === 'running' || phase === 'finished') && renderProgressPanel()}
    </div>
  );
};

export default BulkAddSources;
