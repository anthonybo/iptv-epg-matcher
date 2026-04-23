import React, { useRef, useState } from 'react';
import EditCredentialsModal from './EditCredentialsModal';
import {
  getAccountHealth,
  getAccountLabel,
  healthDotClasses,
  formatExpDate,
  daysUntilExp,
  formatRelativeTime,
  formatDuration,
  locationLabel,
  buildCredentialsText,
  copyToClipboard,
} from './utils';

const HealthDot = ({ source, refreshStatus }) => {
  const health = getAccountHealth(source, refreshStatus);
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

const DataCell = ({ label, value, tone = 'default', mono }) => {
  const toneClass = tone === 'muted' ? 'text-slate-500'
    : tone === 'warn' ? 'text-amber-300'
    : tone === 'error' ? 'text-red-300'
    : tone === 'good' ? 'text-emerald-300'
    : 'text-slate-200';
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">{label}</span>
      <span className={`text-sm tabular-nums ${mono ? 'font-mono' : ''} ${toneClass}`}>{value}</span>
    </div>
  );
};

const AccountRow = ({
  source,
  refreshStatus,
  onEdit,
  onDelete,
  onViewChannels,
  onRefreshAccountInfo,
  onEditCredentials,
  onTestStreams,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [nickname, setNickname] = useState(source.nickname || source.name || '');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  const [showEditCredentials, setShowEditCredentials] = useState(false);
  const [credentials, setCredentials] = useState({
    url: source.url || '',
    username: source.username || '',
    password: source.password || '',
  });

  const health = getAccountHealth(source, refreshStatus);
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

  const lastRefreshRel = formatRelativeTime(source.last_refresh_attempt || source.last_refreshed);
  const lastRefreshDuration = formatDuration(source.last_refresh_duration_ms);
  const lastRefreshTone = source.last_refresh_status === 'success' ? 'good'
    : source.last_refresh_status === 'error' ? 'error'
    : 'muted';

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
    await onDelete?.(source.id);
    setShowDeleteConfirm(false);
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
        <div className="mt-4 flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
          <span className="text-xs text-red-200 flex-1">Delete this account? This cannot be undone.</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            className="inline-flex items-center rounded-md bg-red-500/80 hover:bg-red-500 px-2.5 py-1 text-xs font-semibold text-white"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false); }}
            className="inline-flex items-center rounded-md border border-slate-700 bg-slate-900 hover:bg-slate-800 px-2.5 py-1 text-xs text-slate-300"
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
        className="flex items-center gap-4 px-5 py-2.5 cursor-pointer select-none"
      >
        {/* Status + account label */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <HealthDot source={source} refreshStatus={refreshStatus} />
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
            <div className="min-w-0 flex-1">
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

        {/* Tabular data cells */}
        <div className="hidden md:flex items-center gap-8 shrink-0">
          <div className="w-20 text-right">
            <DataCell
              label="Channels"
              value={channelCount ? channelCount.toLocaleString() : '—'}
              tone={channelCount ? 'default' : 'muted'}
            />
          </div>
          {expFormatted || connectionsStr ? (
            <div className="w-24">
              <DataCell
                label="Expires"
                value={expFormatted || '—'}
                tone={expTone}
                mono
              />
            </div>
          ) : null}
          {connectionsStr && (
            <div className="w-16">
              <DataCell label="Conn" value={connectionsStr} mono />
            </div>
          )}
          <div className="w-28">
            <DataCell
              label="Last refresh"
              value={lastRefreshRel || '—'}
              tone={lastRefreshTone}
            />
            {lastRefreshDuration && (
              <span className="text-[10px] text-slate-600 font-mono tabular-nums">{lastRefreshDuration}</span>
            )}
          </div>
        </div>

        {/* Action strip */}
        <div className="flex items-center gap-0.5 shrink-0">
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

          <div className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
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
