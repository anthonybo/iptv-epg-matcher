import React, { useState } from 'react';
import AccountRow from './AccountRow';
import { getAccountHealth, healthDotClasses, locationLabel } from './utils';

const HealthSummary = ({ counts }) => {
  const entries = [
    { key: 'ok', label: 'working', tone: 'text-emerald-300' },
    { key: 'warn', label: 'warning', tone: 'text-amber-300' },
    { key: 'error', label: 'failed', tone: 'text-red-300' },
    { key: 'loading', label: 'loading', tone: 'text-blue-300' },
    { key: 'unknown', label: 'unknown', tone: 'text-slate-400' },
  ];
  const visible = entries.filter((e) => counts[e.key]);
  if (visible.length === 0) return null;
  return (
    <div className="flex items-center gap-4 text-xs">
      {visible.map((e) => (
        <span key={e.key} className={`inline-flex items-center gap-1.5 ${e.tone}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${healthDotClasses[e.key]}`} />
          <span className="tabular-nums font-semibold">{counts[e.key]}</span>
          <span className="text-[11px] uppercase tracking-[0.08em] opacity-70">{e.label}</span>
        </span>
      ))}
    </div>
  );
};

const typeTag = (type) => ({
  xtream: { label: 'XTREAM', cls: 'text-blue-300 border-blue-500/40 bg-blue-500/5' },
  stalker: { label: 'STALKER', cls: 'text-purple-300 border-purple-500/40 bg-purple-500/5' },
  m3u: { label: 'M3U', cls: 'text-slate-300 border-slate-600/60 bg-slate-500/5' },
}[type] || { label: String(type || '').toUpperCase(), cls: 'text-slate-300 border-slate-600/60 bg-slate-500/5' });

const DomainSection = ({ group, sourceRefreshStatus = {}, onDelete, ...rowProps }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const counts = group.sources.reduce((acc, s) => {
    const h = getAccountHealth(s, sourceRefreshStatus[s.id]);
    acc[h] = (acc[h] || 0) + 1;
    return acc;
  }, {});

  const totalChannels = group.sources.reduce((sum, s) => sum + (s.channel_count || 0), 0);
  const tag = typeTag(group.type);

  const firstLocation = group.sources.map(locationLabel).find(Boolean);
  const allSameLocation = firstLocation && group.sources.every((s) => {
    const loc = locationLabel(s);
    return !loc || loc === firstLocation;
  });

  const accountCount = group.sources.length;

  const handleDeleteAll = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    setProgress({ done: 0, total: accountCount });
    // Fire in parallel — these are independent DELETEs. allSettled so one
    // failure doesn't short-circuit the others; MyIPTVs.handleDelete already
    // shows a per-failure notification.
    const ids = group.sources.map((s) => s.id);
    await Promise.allSettled(
      ids.map((id) =>
        Promise.resolve(onDelete(id)).finally(() => {
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        })
      )
    );
    setDeleting(false);
    setConfirming(false);
  };

  return (
    <section className="group/section rounded-xl border border-slate-800/80 bg-slate-950/40 overflow-hidden shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]">
      {confirming ? (
        <header className="flex items-center gap-4 px-5 py-3.5 bg-red-950/30 border-b border-red-500/30">
          <div className="flex items-baseline gap-3 min-w-0 flex-1">
            <svg className="w-4 h-4 shrink-0 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3 className="text-sm font-semibold text-red-100 truncate">
              {deleting
                ? `Deleting ${progress.done}/${progress.total} accounts from ${group.domain}…`
                : `Delete all ${accountCount} account${accountCount === 1 ? '' : 's'} from ${group.domain}?`}
            </h3>
            {!deleting && (
              <span className="hidden md:inline text-xs text-red-300/70">
                This removes every account on this domain. Channels are cleared too.
              </span>
            )}
          </div>

          {!deleting && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
                className="inline-flex items-center rounded-md border border-slate-700 bg-slate-900 hover:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleDeleteAll(); }}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-500/90 hover:bg-red-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-red-950/40 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete {accountCount}
              </button>
            </div>
          )}

          {deleting && (
            <div className="shrink-0 w-40 h-1 rounded-full bg-red-900/40 overflow-hidden">
              <div
                className="h-full bg-red-400 transition-all duration-150"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
          )}
        </header>
      ) : (
        <header
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-4 px-5 py-3.5 bg-gradient-to-r from-slate-900/80 via-slate-900/50 to-slate-900/20 border-b border-slate-800/60 cursor-pointer select-none hover:from-slate-900/90"
        >
          <div className="flex items-baseline gap-3 min-w-0 flex-1">
            <h3 className="text-base font-semibold text-slate-100 truncate tracking-tight">
              {group.domain}
            </h3>
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-[0.14em] border ${tag.cls}`}>
              {tag.label}
            </span>
            {allSameLocation && (
              <span className="hidden md:inline text-xs text-slate-500 truncate">
                · {firstLocation}
              </span>
            )}
          </div>

          <div className="hidden md:flex items-center gap-6">
            <HealthSummary counts={counts} />
            <div className="flex items-center gap-6 text-xs">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Accounts</span>
                <span className="text-sm tabular-nums font-semibold text-slate-200">{accountCount}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">Channels</span>
                <span className="text-sm tabular-nums font-semibold text-slate-200">{totalChannels.toLocaleString()}</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
            title={`Delete all ${accountCount} account${accountCount === 1 ? '' : 's'}`}
            aria-label={`Delete all ${accountCount} account${accountCount === 1 ? '' : 's'} from ${group.domain}`}
            className="shrink-0 p-1.5 rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-300 transition-colors opacity-0 group-hover/section:opacity-100 focus:opacity-100"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          <span className={`shrink-0 text-slate-500 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        </header>
      )}

      {!collapsed && !deleting && (
        <div className="divide-y divide-slate-800/60">
          {group.sources.map((source) => (
            <AccountRow
              key={source.id}
              source={source}
              refreshStatus={sourceRefreshStatus[source.id]}
              onDelete={onDelete}
              {...rowProps}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export default DomainSection;
