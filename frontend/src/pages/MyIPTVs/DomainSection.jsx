import React, { useState } from 'react';
import AccountRow from './AccountRow';
import iptvSourcesService from '../../services/iptvSourcesService';
import { getAccountHealth, healthDotClasses, locationLabel } from './utils';

// Cap concurrent test-streams so we don't saturate the backend (each test
// probes several channels with ffprobe). 2 is the same ceiling we use for
// bulk load.
const MAX_TEST_CONCURRENT = 2;

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

const DomainSection = ({ group, sourceRefreshStatus = {}, onDelete, onShowDiagnostics, ...rowProps }) => {
  const [collapsed, setCollapsed] = useState(false);
  // confirming: null when idle; { mode: 'all' | 'failed', ids: [sourceId, ...] } when user is confirming a batch delete.
  const [confirming, setConfirming] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // Per-source test results: { [sourceId]: { status: 'testing'|'passed'|'partial'|'failed'|'error', passed, tested, diagnostics, error } }
  const [testResults, setTestResults] = useState({});
  const [testingAll, setTestingAll] = useState(false);
  const [testProgress, setTestProgress] = useState({ done: 0, total: 0 });

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

  const classifyResult = (diag) => {
    const passed = diag?.passed ?? 0;
    const tested = diag?.tested ?? 0;
    if (!tested) return 'error';
    if (passed === tested) return 'passed';
    if (passed === 0) return 'failed';
    return 'partial';
  };

  const testOne = async (source) => {
    setTestResults((prev) => ({ ...prev, [source.id]: { status: 'testing' } }));
    try {
      const res = await iptvSourcesService.testStreams(source.id);
      const diag = res?.diagnostics;
      if (!res?.success || !diag) {
        setTestResults((prev) => ({
          ...prev,
          [source.id]: { status: 'error', error: res?.error || 'Test failed' },
        }));
        return;
      }
      setTestResults((prev) => ({
        ...prev,
        [source.id]: {
          status: classifyResult(diag),
          passed: diag.passed ?? 0,
          tested: diag.tested ?? 0,
          diagnostics: diag,
        },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [source.id]: {
          status: 'error',
          error: err?.response?.data?.error || err?.message || 'Test failed',
        },
      }));
    } finally {
      setTestProgress((p) => ({ ...p, done: p.done + 1 }));
    }
  };

  const handleTestAll = async () => {
    if (testingAll) return;
    setTestingAll(true);
    setTestResults({});
    setTestProgress({ done: 0, total: group.sources.length });
    // Simple bounded-concurrency loop so we respect MAX_TEST_CONCURRENT.
    const queue = [...group.sources];
    const workers = Array.from({ length: Math.min(MAX_TEST_CONCURRENT, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) await testOne(next);
      }
    });
    await Promise.all(workers);
    setTestingAll(false);
  };

  const testSummary = (() => {
    const ids = Object.keys(testResults);
    if (ids.length === 0) return null;
    let passed = 0, partial = 0, failed = 0, errored = 0, testing = 0;
    for (const id of ids) {
      const r = testResults[id];
      if (r.status === 'passed') passed += 1;
      else if (r.status === 'partial') partial += 1;
      else if (r.status === 'failed') failed += 1;
      else if (r.status === 'error') errored += 1;
      else if (r.status === 'testing') testing += 1;
    }
    return { passed, partial, failed, errored, testing };
  })();

  const handleDeleteConfirmed = async () => {
    if (!onDelete || deleting || !confirming?.ids?.length) return;
    const ids = confirming.ids;
    setDeleting(true);
    setProgress({ done: 0, total: ids.length });
    // Fire in parallel — independent DELETEs. allSettled so one failure doesn't
    // short-circuit the others; MyIPTVs.handleDelete surfaces per-failure notifications.
    await Promise.allSettled(
      ids.map((id) =>
        Promise.resolve(onDelete(id)).finally(() => {
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        })
      )
    );
    // Clear stale test results for the rows we just removed so a future re-run
    // doesn't show dangling pills if an ID is ever recycled.
    setTestResults((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    setDeleting(false);
    setConfirming(null);
  };

  const failedSourceIds = Object.entries(testResults)
    .filter(([, r]) => r?.status === 'failed')
    .map(([id]) => Number(id))
    .filter((id) => group.sources.some((s) => s.id === id));

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
                : confirming.mode === 'failed'
                  ? `Delete ${confirming.ids.length} failed account${confirming.ids.length === 1 ? '' : 's'} from ${group.domain}?`
                  : `Delete all ${confirming.ids.length} account${confirming.ids.length === 1 ? '' : 's'} from ${group.domain}?`}
            </h3>
            {!deleting && (
              <span className="hidden md:inline text-xs text-red-300/70">
                {confirming.mode === 'failed'
                  ? 'These accounts scored 0 passing streams on the last test.'
                  : 'This removes every account on this domain. Channels are cleared too.'}
              </span>
            )}
          </div>

          {!deleting && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setConfirming(null); }}
                className="inline-flex items-center rounded-md border border-slate-700 bg-slate-900 hover:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleDeleteConfirmed(); }}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-500/90 hover:bg-red-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-red-950/40 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete {confirming.ids.length}
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

          {testSummary && (
            <div className="hidden md:flex items-center gap-3 pl-3 border-l border-slate-800 text-xs">
              {testingAll ? (
                <span className="inline-flex items-center gap-2 text-blue-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <span className="tabular-nums">
                    Testing {testProgress.done}/{testProgress.total}
                  </span>
                </span>
              ) : (
                <>
                  {testSummary.passed > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-emerald-300">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="tabular-nums font-semibold">{testSummary.passed}</span>
                    </span>
                  )}
                  {testSummary.partial > 0 && (
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                      <span className="tabular-nums font-semibold">{testSummary.partial}</span>
                    </span>
                  )}
                  {(testSummary.failed + testSummary.errored) > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-red-300">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      <span className="tabular-nums font-semibold">{testSummary.failed + testSummary.errored}</span>
                    </span>
                  )}
                  {failedSourceIds.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirming({ mode: 'failed', ids: failedSourceIds });
                      }}
                      title="Delete accounts that scored 0 passing streams"
                      className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 hover:border-red-500/60 px-2 py-0.5 text-[11px] font-semibold text-red-200 tracking-wide transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Remove {failedSourceIds.length}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleTestAll(); }}
            disabled={testingAll}
            title={`Test streams for all ${accountCount} account${accountCount === 1 ? '' : 's'}`}
            aria-label={`Test streams for all ${accountCount} account${accountCount === 1 ? '' : 's'} on ${group.domain}`}
            className={`shrink-0 p-1.5 rounded-md transition-colors disabled:cursor-not-allowed ${
              testingAll
                ? 'text-blue-300 bg-blue-500/10 opacity-100'
                : 'text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-300 opacity-0 group-hover/section:opacity-100 focus:opacity-100'
            }`}
          >
            {testingAll ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming({ mode: 'all', ids: group.sources.map((s) => s.id) });
            }}
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
              testResult={testResults[source.id]}
              onShowDiagnostics={onShowDiagnostics}
              {...rowProps}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export default DomainSection;
