import React, { useEffect, useRef, useState } from 'react';
import EditCredentialsModal from './EditCredentialsModal';
import {
  ACCOUNT_GRID_TEMPLATE,
  getAccountHealth,
  getAccountLabel,
  healthDotClasses,
  formatExpDate,
  daysUntilExp,
  formatRelativeTime,
  formatAbsoluteTime,
  formatDuration,
  lastSourceCheckAt,
  locationLabel,
  buildCredentialsText,
  copyToClipboard,
} from './utils';

const HealthDot = ({ source, refreshStatus, testResult }) => {
  const health = getAccountHealth(source, refreshStatus, testResult);
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${healthDotClasses[health]}`}
      aria-label={health}
    />
  );
};

const accentClasses = {
  default: 'hover:text-slate-200',
  emerald: 'hover:text-emerald-300',
  amber: 'hover:text-amber-300',
  red: 'hover:text-red-300',
  blue: 'hover:text-blue-300',
};

const ActionButton = ({ onClick, title, disabled, spinning, accent = 'default', children }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
    disabled={disabled}
    title={title}
    aria-label={title}
    className={`shrink-0 p-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed
      text-slate-500 hover:bg-slate-800/80 ${accentClasses[accent] || accentClasses.default}`}
  >
    <span className={spinning ? 'inline-block animate-spin' : undefined}>{children}</span>
  </button>
);

const icons = {
  view: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  ),
  refresh: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  ),
  test: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  edit: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  ),
  creds: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  ),
  trash: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  ),
  copy: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  ),
  check: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ),
  chevron: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  ),
};

// Tone → text color. Same scale used by everything that surfaces a
// health / expiry / refresh signal.
const TONE = {
  default: 'text-slate-200',
  muted:   'text-slate-500',
  warn:    'text-amber-300',
  error:   'text-red-300',
  good:    'text-emerald-300',
};

// Faint middle-dot placeholder for "no value". Reads as "this column
// exists but has nothing to say" without the visual weight of "—"
// (which a casual scan can confuse with a real value).
const Placeholder = () => (
  <span className="text-slate-700 select-none" aria-hidden="true">·</span>
);

// Right-aligned, mono, tabular numeric cell. Used for channels /
// expires / conn — every digit lands in the same column position.
const NumCell = ({ value, tone = 'default', title, hidden }) => (
  <div
    className={`hidden md:flex md:items-center md:justify-end font-mono text-sm tabular-nums leading-none ${TONE[tone]} ${hidden ? 'invisible' : ''}`}
    title={title}
  >
    {value || <Placeholder />}
  </div>
);

const testPillMeta = {
  testing: { tone: 'bg-blue-500/15 border-blue-500/40 text-blue-300', dot: 'bg-blue-400 animate-pulse' },
  passed: { tone: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300', dot: 'bg-emerald-400' },
  partial: { tone: 'bg-amber-500/15 border-amber-500/40 text-amber-300', dot: 'bg-amber-400' },
  failed: { tone: 'bg-red-500/15 border-red-500/40 text-red-300', dot: 'bg-red-400' },
  error: { tone: 'bg-red-500/15 border-red-500/40 text-red-300', dot: 'bg-red-400' },
};

const AccountRow = ({
  source,
  refreshStatus,
  testResult,
  onEdit,
  onDelete,
  onViewChannels,
  onRefreshAccountInfo,
  onEditCredentials,
  onTestStreams,
  onShowDiagnostics,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [nickname, setNickname] = useState(source.nickname || source.name || '');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  // Locks the Delete button while the request is in flight. Without
  // this, the parent's notification toast was the only feedback and
  // the button stayed clickable — users (rightly) hammered it because
  // nothing on the row changed for ~1s after the click. Each click
  // fired another DELETE on the backend; logs showed `Deleted source
  // X for user Y` repeating 5-6× per attempt.
  const [isDeleting, setIsDeleting] = useState(false);
  // Live elapsed-time counter while the row is refreshing — gives the
  // user something to watch instead of staring at a frozen icon and
  // wondering "did this actually do anything?". Resets when the
  // refresh ends.
  const [refreshElapsedMs, setRefreshElapsedMs] = useState(0);
  // True when this row is doing refresh work — either the local
  // ActionButton state (single-source click) OR the page-level
  // sourceRefreshStatus marker (used by both flows now).
  const isRefreshActive = isRefreshing || refreshStatus === 'loading';

  useEffect(() => {
    if (!isRefreshActive) {
      setRefreshElapsedMs(0);
      return undefined;
    }
    const startedAt = Date.now();
    setRefreshElapsedMs(0);
    const id = setInterval(() => {
      setRefreshElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, [isRefreshActive]);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  const [showEditCredentials, setShowEditCredentials] = useState(false);
  const [credentials, setCredentials] = useState({
    url: source.url || '',
    username: source.username || '',
    password: source.password || '',
  });

  // Bundled-EPG state (post-035). Local refreshing flag so the
  // button can show a spinner while ingest runs (5-90s depending on
  // provider EPG size). Optimistic status update so the user sees
  // "pending" the moment they click; the real status comes back in
  // the response and overwrites.
  const [isRefreshingBundledEpg, setIsRefreshingBundledEpg] = useState(false);
  const [optimisticBundledEpg, setOptimisticBundledEpg] = useState(null);
  const bundledEpgView = optimisticBundledEpg || {
    status: source.bundled_epg_status,
    error: source.bundled_epg_error,
    channelCount: source.bundled_epg_channel_count || 0,
    programCount: source.bundled_epg_program_count || 0,
    lastRefreshed: source.bundled_epg_last_refreshed,
    url: source.bundled_epg_url
  };
  // Clear optimistic state when the underlying source row updates so
  // the polled status (truth) takes over again.
  useEffect(() => { setOptimisticBundledEpg(null); }, [
    source.bundled_epg_status,
    source.bundled_epg_last_refreshed
  ]);

  const handleRefreshBundledEpg = async () => {
    if (isRefreshingBundledEpg) return;
    setIsRefreshingBundledEpg(true);
    setOptimisticBundledEpg({
      ...bundledEpgView,
      status: 'pending',
      error: null
    });
    try {
      const res = await fetch(`/api/iptv/sources/${source.id}/refresh-bundled-epg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('authToken') || ''}` },
        body: JSON.stringify({})
      });
      const body = await res.json().catch(() => ({}));
      if (body && body.status) {
        setOptimisticBundledEpg({
          status: body.status.bundled_epg_status,
          error: body.status.bundled_epg_error,
          channelCount: body.status.bundled_epg_channel_count || 0,
          programCount: body.status.bundled_epg_program_count || 0,
          lastRefreshed: body.status.bundled_epg_last_refreshed,
          url: body.status.bundled_epg_url
        });
      }
    } catch (e) {
      setOptimisticBundledEpg({
        ...bundledEpgView,
        status: 'failed',
        error: String(e.message || e)
      });
    } finally {
      setIsRefreshingBundledEpg(false);
    }
  };

  const health = getAccountHealth(source, refreshStatus, testResult);
  const accentRail = {
    ok: 'before:bg-emerald-500/60',
    warn: 'before:bg-amber-500/60',
    error: 'before:bg-red-500/60',
    loading: 'before:bg-blue-500/60',
    unknown: 'before:bg-slate-700',
  }[health];

  const channelCount = source.channel_count || 0;
  const expFormatted = formatExpDate(source.exp_date);
  const daysLeft = daysUntilExp(source.exp_date);
  const expTone = daysLeft === null ? 'muted' : daysLeft < 0 ? 'error' : daysLeft <= 7 ? 'warn' : 'default';

  // "Last refresh" timestamp with fallbacks. Bulk-added sources don't
  // populate last_refresh_attempt / last_refreshed even after a
  // successful fetch, so without the updated_at / created_at fallback
  // the column was always "—" for newly-imported sources. lastSourceCheckAt
  // returns the freshest available timestamp.
  const lastRefreshTs = lastSourceCheckAt(source);
  const lastRefreshRel = formatRelativeTime(lastRefreshTs);
  const lastRefreshAbs = formatAbsoluteTime(lastRefreshTs);
  const lastRefreshDuration = formatDuration(source.last_refresh_duration_ms);
  const lastRefreshTone = source.last_refresh_status === 'success' ? 'good'
    : source.last_refresh_status === 'error' ? 'error'
    : 'muted';
  // Tag the timestamp's source so the tooltip can say "imported"
  // vs "checked" — refresh-stamped fields are an explicit health
  // verification; updated_at/created_at are just the row's audit time.
  const lastRefreshOrigin =
    (source.last_refresh_attempt || source.last_successful_refresh || source.last_refreshed)
      ? 'checked'
      : 'imported';

  const connectionsStr = (source.active_connections !== null && source.active_connections !== undefined)
    ? `${source.active_connections}/${source.max_connections || '?'}`
    : null;

  const accountStatusStr = source.account_status || null;
  const location = locationLabel(source);

  const handleSaveNickname = async () => {
    const value = nickname.trim();
    if (value && value !== (source.nickname || source.name || '')) {
      await onEdit?.(source.id, value);
    }
    setIsEditingNickname(false);
  };

  const handleDelete = async () => {
    if (isDeleting) return; // hard guard against double-fire
    setIsDeleting(true);
    try {
      await onDelete?.(source.id);
      // Parent will unmount this row on success, so the setState
      // below may never commit — but if the delete failed and the
      // row stays mounted, we need to flip the lock back so the
      // user can retry.
      setShowDeleteConfirm(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try { await onRefreshAccountInfo?.(source.id); } finally { setIsRefreshing(false); }
  };

  const handleTest = async () => {
    if (!onTestStreams) return;
    setIsTesting(true);
    try { await onTestStreams(source.id); } finally { setIsTesting(false); }
  };

  const handleSaveCredentials = async () => {
    await onEditCredentials?.(source.id, credentials);
    setShowEditCredentials(false);
  };

  const handleCopyCredentials = async () => {
    const ok = await copyToClipboard(buildCredentialsText(source));
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  // Inline detail panel when expanded — shows the data that doesn't fit in one row.
  const renderExpanded = () => (
    <div className="pl-8 pr-4 pb-4 pt-1 bg-slate-950/40 border-t border-slate-800/60">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-3 text-sm">
        {source.username && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Username</span>
            <span className="font-mono text-slate-200 truncate">{source.username}</span>
          </div>
        )}
        {source.password && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Password</span>
            <span className="font-mono text-slate-200 truncate">{source.password}</span>
          </div>
        )}
        {source.mac_address && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">MAC</span>
            <span className="font-mono text-slate-200 truncate">{source.mac_address}</span>
          </div>
        )}
        {location && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Server</span>
            <span className="text-slate-200 truncate">{location}</span>
          </div>
        )}
        {accountStatusStr && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Account</span>
            <span className={`text-sm ${accountStatusStr === 'Active' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {accountStatusStr}{source.is_trial === 1 ? ' · Trial' : ''}
            </span>
          </div>
        )}
        {source.last_successful_refresh && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Last success</span>
            <span className="text-slate-300">{formatRelativeTime(source.last_successful_refresh)}</span>
          </div>
        )}
        {(source.failure_count || 0) > 0 && (
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Failures</span>
            <span className={`${source.failure_count >= 3 ? 'text-red-300' : 'text-amber-300'}`}>
              {source.failure_count}× {source.last_failure_time ? `· last ${formatRelativeTime(source.last_failure_time)}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Provider EPG (bundled) — auto-ingested from the source's
          own xmltv.php (Xtream) or url-tvg header (M3U). See
          backend/services/bundledEpgService.js. Stalker sources skip
          this entirely because MAG portals don't expose a standard
          EPG endpoint. */}
      {(source.type === 'xtream' || source.type === 'm3u') && (
        <div className="mt-4 rounded-md border border-slate-800/70 bg-slate-900/40">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800/70 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Provider EPG
              </span>
              {(() => {
                const s = bundledEpgView.status;
                const map = {
                  ok:      { label: 'OK',       cls: 'bg-emerald-500/15 ring-emerald-400/30 text-emerald-200' },
                  pending: { label: 'PENDING',  cls: 'bg-cyan-500/15 ring-cyan-400/30 text-cyan-200' },
                  failed:  { label: 'NO EPG',   cls: 'bg-amber-500/15 ring-amber-400/30 text-amber-200' },
                  no_url:  { label: 'NO URL',   cls: 'bg-slate-700/40 ring-slate-600/40 text-slate-400' },
                };
                const m = map[s] || { label: 'NEVER', cls: 'bg-slate-700/30 ring-slate-700/40 text-slate-500' };
                return (
                  <span className={`inline-flex h-5 items-center rounded px-1.5 ring-1 font-mono text-[9.5px] uppercase tracking-[0.18em] ${m.cls}`}>
                    {m.label}
                  </span>
                );
              })()}
              {bundledEpgView.channelCount > 0 && (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500 tabular-nums">
                  <span className="text-slate-300">{bundledEpgView.channelCount.toLocaleString()}</span> ch
                  <span className="mx-1.5 text-slate-700">·</span>
                  <span className="text-slate-300">{bundledEpgView.programCount.toLocaleString()}</span> prog
                </span>
              )}
              {bundledEpgView.lastRefreshed && (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
                  · {formatRelativeTime(bundledEpgView.lastRefreshed)}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleRefreshBundledEpg}
              disabled={isRefreshingBundledEpg || bundledEpgView.status === 'pending'}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/[0.08] px-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200 transition hover:border-cyan-400/60 hover:bg-cyan-500/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
              title="Re-fetch the provider's bundled EPG. Usually runs automatically after each channel refresh."
            >
              {isRefreshingBundledEpg ? (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
                  <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1015.5-6.36M21 5v5h-5" />
                </svg>
              )}
              Refresh EPG
            </button>
          </div>
          <div className="px-3 py-2 text-[11px]">
            {bundledEpgView.url ? (
              <div className="truncate font-mono text-slate-500" title={bundledEpgView.url}>
                {bundledEpgView.url.replace(/(password=)[^&]*/i, '$1•••')}
              </div>
            ) : (
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
                No EPG URL discovered yet
              </div>
            )}
            {bundledEpgView.status === 'failed' && bundledEpgView.error && (
              <div className="mt-1.5 break-words rounded border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1 font-mono text-[10.5px] text-amber-200">
                <span className="text-amber-300/80">Channels are fine — only the provider's bundled EPG is unavailable:</span> {bundledEpgView.error}
              </div>
            )}
            {bundledEpgView.status === 'no_url' && (
              <div className="mt-1.5 font-mono text-[10px] text-slate-500">
                {source.type === 'm3u'
                  ? "Provider's playlist has no `url-tvg`/`x-tvg-url` header. EPG must come from a public source."
                  : "Provider credentials don't expose a /xmltv.php endpoint."}
              </div>
            )}
          </div>
        </div>
      )}

      {source.last_refresh_error && (
        <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200 font-mono leading-relaxed break-words">
          {source.last_refresh_error}
        </div>
      )}

      {onTestStreams && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleTest(); }}
            disabled={isRefreshing || isTesting}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {isTesting ? 'Testing…' : 'Test streams'}
          </button>
        </div>
      )}

      {showDeleteConfirm && (
        <div className={`mt-4 flex items-center gap-2 rounded-md border px-3 py-2 transition ${
          isDeleting
            ? 'border-red-500/60 bg-red-500/15'
            : 'border-red-500/40 bg-red-500/10'
        }`}>
          <span className="text-xs text-red-200 flex-1">
            {isDeleting ? 'Deleting account…' : 'Delete this account? This cannot be undone.'}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            disabled={isDeleting}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-white transition ${
              isDeleting
                ? 'bg-red-700/70 cursor-wait'
                : 'bg-red-500/80 hover:bg-red-500'
            }`}
          >
            {isDeleting && (
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false); }}
            disabled={isDeleting}
            className="inline-flex items-center rounded-md border border-slate-700 bg-slate-900 hover:bg-slate-800 px-2.5 py-1 text-xs text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );

  const rowClickable = !isEditingNickname;

  return (
    <div className={`group/row relative
      before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 ${accentRail}
      ${expanded ? 'bg-slate-900/40' : 'hover:bg-slate-900/30'} transition-colors`}
    >
      <div
        role={rowClickable ? 'button' : undefined}
        tabIndex={rowClickable ? 0 : -1}
        onClick={() => rowClickable && setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (!rowClickable) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v); }
        }}
        className="flex md:grid md:items-center gap-3 md:gap-4 px-5 py-2.5 cursor-pointer select-none"
        // CSS grid template lives in a single shared constant so this
        // row and the column header in DomainSection literally cannot
        // drift apart. Below the md: breakpoint we fall back to flex
        // (the data cells go display:none, so the account label fills
        // and actions sit on the right — same mobile UX as before).
        style={{ gridTemplateColumns: ACCOUNT_GRID_TEMPLATE }}
      >
        {/* Col 1 — Account label */}
        <div className="flex items-center gap-3 min-w-0 flex-1 md:flex-none">
          <HealthDot source={source} refreshStatus={refreshStatus} testResult={testResult} />
          {isEditingNickname ? (
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={handleSaveNickname}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSaveNickname(); }
                if (e.key === 'Escape') { e.preventDefault(); setNickname(source.nickname || source.name || ''); setIsEditingNickname(false); }
              }}
              autoFocus
              className="flex-1 min-w-0 rounded-md border border-blue-500/60 bg-slate-900 px-2 py-1 text-sm font-medium text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          ) : (
            <div className="min-w-0 flex-1 md:flex-none">
              <div className="text-sm font-semibold text-slate-100 truncate">
                {getAccountLabel(source)}
              </div>
              {source.nickname && (source.username || source.mac_address) && (
                <div className="text-[11px] font-mono text-slate-500 truncate">
                  {source.username || source.mac_address}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Col 2 — Channels (right-aligned, mono) + tiny EPG dot.
            The dot reads the bundled_epg_status at a glance:
            emerald = ok, cyan-pulse = pending, rose = failed,
            slate = no_url / never. Hovering shows the tooltip with
            counts; clicking the row to expand reveals the full
            Provider EPG panel with the refresh button. */}
        <div className="flex items-center justify-end gap-2 min-w-0">
          <NumCell
            value={channelCount ? channelCount.toLocaleString() : null}
            tone={channelCount ? 'default' : 'muted'}
            title={channelCount ? `${channelCount.toLocaleString()} channels` : 'No channel count yet'}
          />
          {(source.type === 'xtream' || source.type === 'm3u') && (() => {
            const s = bundledEpgView.status;
            const meta = {
              ok:      { color: 'bg-emerald-400', ring: 'ring-emerald-400/30', tip: `EPG OK · ${bundledEpgView.channelCount.toLocaleString()} ch · ${bundledEpgView.programCount.toLocaleString()} prog` },
              pending: { color: 'bg-cyan-400 animate-pulse', ring: 'ring-cyan-400/30', tip: 'EPG refreshing…' },
              failed:  { color: 'bg-rose-400', ring: 'ring-rose-400/30', tip: `EPG failed: ${bundledEpgView.error || 'unknown error'}` },
              no_url:  { color: 'bg-slate-600', ring: 'ring-slate-700/40', tip: 'No bundled EPG URL discovered' }
            };
            const m = meta[s] || { color: 'bg-slate-700', ring: 'ring-slate-800/40', tip: 'Provider EPG not fetched yet' };
            return (
              <span
                className={`h-2 w-2 rounded-full ${m.color} ring-2 ${m.ring}`}
                title={m.tip}
                aria-label={m.tip}
              />
            );
          })()}
        </div>

        {/* Col 3 — Expires (right-aligned, mono, tone tracks days-left) */}
        <NumCell
          value={expFormatted}
          tone={expTone}
          title={
            daysLeft === null ? 'No expiration on file'
              : daysLeft < 0 ? `Expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago`
              : `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
          }
        />

        {/* Col 4 — Conn (right-aligned, mono) */}
        <NumCell
          value={connectionsStr}
          title={connectionsStr ? `${connectionsStr} concurrent connections in use` : 'Connection limit unknown'}
        />

        {/* Col 5 — Last check (left-aligned with optional sub-line) */}
        <div
          className="hidden md:flex md:flex-col md:justify-center min-w-0 leading-none"
          title={
            lastRefreshAbs
              ? `${lastRefreshOrigin === 'imported' ? 'Imported' : 'Checked'} ${lastRefreshAbs}`
              : undefined
          }
        >
          <span className={`text-sm ${TONE[lastRefreshTone] || TONE.default} truncate`}>
            {lastRefreshRel || <Placeholder />}
          </span>
          {lastRefreshRel && (lastRefreshDuration || lastRefreshOrigin === 'imported') && (
            <span className="mt-1 text-[10px] text-slate-600 font-mono tabular-nums truncate">
              {lastRefreshDuration || 'imported'}
            </span>
          )}
        </div>

        {/* Col 6 — Streams (pill + optional "tested ago").
            Carries the hairline that visually separates the data block
            from the action strip — anchored on this cell's right edge
            so the divider sits at a fixed x (right edge of the 6.25rem
            Streams track) in both the header and every row. */}
        <div className="hidden md:flex md:flex-col md:justify-center min-w-0 leading-none md:self-stretch md:pr-3 md:border-r md:border-slate-800/60">
          {(() => {
            if (!testResult) return <Placeholder />;
            const testedRel = formatRelativeTime(testResult.testedAt);
            const testedAbs = formatAbsoluteTime(testResult.testedAt);
            const pillBase = 'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none';
            const pillMeta = testPillMeta[testResult.status] || testPillMeta.failed;
            return (
              <>
                {testResult.status === 'testing' ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-blue-300 leading-none">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    Testing…
                  </span>
                ) : testResult.status === 'error' ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); }}
                    title={`${testResult.error || 'Test failed'}${testedAbs ? ` · ${testedAbs}` : ''}`}
                    className={`${pillBase} self-start ${testPillMeta.error.tone}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${testPillMeta.error.dot}`} />
                    Error
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onShowDiagnostics && testResult.diagnostics) {
                        onShowDiagnostics(source, testResult.diagnostics);
                      }
                    }}
                    title={`${testResult.passed}/${testResult.tested} streams passed${testedAbs ? ` · tested ${testedAbs}` : ''} — click for details`}
                    className={`${pillBase} self-start tabular-nums transition-colors hover:brightness-110 ${pillMeta.tone}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${pillMeta.dot}`} />
                    {testResult.passed}/{testResult.tested}
                  </button>
                )}
                {testResult.status !== 'testing' && testedRel && (
                  <span
                    className="mt-1 text-[10px] text-slate-600 font-mono tabular-nums truncate"
                    title={testedAbs || undefined}
                  >
                    {testedRel}
                  </span>
                )}
              </>
            );
          })()}
        </div>

        {/* Col 7 — Action strip. Fixed 17rem track (see
            ACCOUNT_GRID_TEMPLATE comment); right-aligned content via
            justify-end so View/Chevron hug the section's right edge.
            Hairline divider is rendered on the Streams cell's right
            edge instead of here so header and rows align identically. */}
        <div className="flex items-center justify-end gap-0.5 shrink-0 md:self-stretch md:pl-2">
          {/* Copy stays always-visible — it's the most common "export to notes" action. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleCopyCredentials(); }}
            title={copied ? 'Copied to clipboard' : 'Copy login info'}
            aria-label="Copy login info"
            className={`shrink-0 p-1.5 rounded-md transition-colors ${
              copied
                ? 'text-emerald-300 bg-emerald-500/10'
                : 'text-slate-500 hover:bg-slate-800/80 hover:text-slate-200'
            }`}
          >
            {copied ? icons.check : icons.copy}
          </button>

          <div className={`flex items-center gap-0.5 ${
            isRefreshActive || isTesting
              ? 'opacity-100'
              : 'opacity-0 group-hover/row:opacity-100 focus-within:opacity-100'
          } transition-opacity`}>
            {(source.type === 'xtream' || source.type === 'stalker') && (
              <>
                <ActionButton onClick={handleRefresh} disabled={isRefreshing || isTesting} spinning={isRefreshing} title="Refresh">
                  {icons.refresh}
                </ActionButton>
                {onTestStreams && (
                  <ActionButton onClick={handleTest} disabled={isRefreshing || isTesting} spinning={isTesting} title="Test streams" accent="emerald">
                    {icons.test}
                  </ActionButton>
                )}
              </>
            )}
            {source.type === 'xtream' && (
              <ActionButton onClick={() => setShowEditCredentials(true)} title="Edit credentials" accent="amber">
                {icons.creds}
              </ActionButton>
            )}
            <ActionButton onClick={() => setIsEditingNickname(true)} title="Rename">
              {icons.edit}
            </ActionButton>
            <ActionButton
              onClick={() => (expanded ? setShowDeleteConfirm(true) : (setExpanded(true), setShowDeleteConfirm(true)))}
              title="Delete"
              accent="red"
            >
              {icons.trash}
            </ActionButton>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onViewChannels?.(source); }}
            title="View channels"
            className="ml-1 inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-xs font-semibold text-blue-300 hover:bg-blue-500/10 hover:border-blue-500/30 transition-colors"
          >
            View{icons.view}
          </button>
          <span className={`ml-1 text-slate-600 transition-transform ${expanded ? 'rotate-180' : ''}`}>
            {icons.chevron}
          </span>
        </div>
      </div>

      {/* Refreshing banner — unmissable status strip directly below
          the row body. Replaces the "tiny rotating SVG inside a
          hover-hidden button" feedback that left users wondering if
          the refresh was even running. The animated stripe + live
          elapsed-time counter gives a constant visual cue that the
          backend is doing work. */}
      {isRefreshActive && (
        <div
          className="relative flex items-center gap-3 px-5 py-2 bg-blue-500/[0.07] border-t border-blue-500/20 overflow-hidden"
          aria-live="polite"
        >
          {/* Indeterminate progress stripe — diagonal bands that
              translate continuously, the universal "still working"
              signal. Pointer-events:none so the row clicks land. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-30 mv-refresh-stripe"
            style={{
              backgroundImage:
                'repeating-linear-gradient(-45deg, rgba(59,130,246,0.35) 0 12px, transparent 12px 24px)',
              backgroundSize: '34px 100%'
            }}
          />
          {/* Pulsing LED */}
          <span className="relative inline-flex items-center justify-center flex-shrink-0">
            <span className="absolute inline-flex h-3 w-3 rounded-full bg-blue-400 opacity-60 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-300 shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
          </span>
          <span className="relative font-mono text-[11px] uppercase tracking-[0.2em] text-blue-200 font-semibold">
            Refreshing
          </span>
          <span className="relative font-mono text-[11px] text-blue-300/80 truncate">
            Fetching channels &amp; categories from {source.type === 'stalker' ? 'Stalker portal' : 'Xtream API'}…
          </span>
          <span className="relative ml-auto font-mono text-[11px] tabular-nums text-blue-200 flex-shrink-0">
            {(refreshElapsedMs / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      {expanded && renderExpanded()}

      {showEditCredentials && (
        <EditCredentialsModal
          sourceId={source.id}
          credentials={credentials}
          onChange={setCredentials}
          onSubmit={handleSaveCredentials}
          onClose={() => setShowEditCredentials(false)}
        />
      )}
    </div>
  );
};

export default AccountRow;
