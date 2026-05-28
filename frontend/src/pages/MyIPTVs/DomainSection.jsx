import React, { useMemo, useState } from 'react';
import AccountRow from './AccountRow';
import SortMenu from './SortMenu';
import iptvSourcesService from '../../services/iptvSourcesService';
import {
  ACCOUNT_GRID_TEMPLATE,
  DEFAULT_SORT_KEY,
  getAccountHealth,
  healthDotClasses,
  locationLabel,
  sortSources,
} from './utils';

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

const DomainSection = ({
  group,
  sourceRefreshStatus = {},
  // testResults map is the FULL persisted map across all domains; we look up
  // just the entries for this group's sources when rendering summaries.
  testResults = {},
  // Effective sort key for this card. Comes from
  // `MyIPTVs.sortKeyForDomain(group.key)` — either a per-domain
  // override or the global default. `sortInheritsGlobal` is true when
  // no override is set so the sort menu can show the inheritance state.
  sortKey = DEFAULT_SORT_KEY,
  sortInheritsGlobal = true,
  globalSortKey = DEFAULT_SORT_KEY,
  onChangeSort,
  onSetTestResult,
  onSetPendingTestResult,
  onRemoveTestResults,
  onDelete,
  onShowDiagnostics,
  // Per-domain "Refresh all" — proxies to MyIPTVs.handleRefreshAll
  // scoped to this card's sources. Two flags:
  //   isRefreshingThisGroup — this card's refresh is in flight; show
  //     the progress counter on its pill.
  //   isRefreshingAny       — ANY refresh is in flight anywhere; used
  //     only to disable other cards' refresh buttons so we don't fire
  //     a parallel refresh while the global mutex is held.
  // Without separating these, EVERY card's pill spun up whenever any
  // refresh started, making it look like all cards were refreshing.
  onRefreshAllInGroup,
  onCancelRefresh,
  isRefreshingThisGroup = false,
  isRefreshingAny = false,
  refreshProgress = { current: 0, total: 0 },
  ...rowProps
}) => {
  const [collapsed, setCollapsed] = useState(false);
  // confirming: null when idle; { mode: 'all' | 'failed', ids: [sourceId, ...] } when user is confirming a batch delete.
  const [confirming, setConfirming] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // Wall-clock the in-flight delete so the modal can show elapsed
  // seconds and surface a "this is slow because…" hint once we cross
  // the threshold where it stops looking like a quick operation.
  // Without this the UI says "0/6" for 60+ seconds and looks frozen.
  const [deleteStartedAt, setDeleteStartedAt] = useState(null);
  const [deleteElapsedMs, setDeleteElapsedMs] = useState(0);
  React.useEffect(() => {
    if (!deleting || !deleteStartedAt) return undefined;
    const id = setInterval(
      () => setDeleteElapsedMs(Date.now() - deleteStartedAt),
      500
    );
    return () => clearInterval(id);
  }, [deleting, deleteStartedAt]);
  // In-flight UI state stays local to this section — results themselves come from
  // the lifted, persisted map.
  const [testingAll, setTestingAll] = useState(false);
  const [testProgress, setTestProgress] = useState({ done: 0, total: 0 });

  // Sort BEFORE deriving aggregates so summary counts iterate in the
  // same order users see in the list. `sortedSources` is the canonical
  // ordering for this section; everything below reads from it.
  const sortedSources = useMemo(
    () => sortSources(group.sources, sortKey, { refresh: sourceRefreshStatus, testResults }),
    [group.sources, sortKey, sourceRefreshStatus, testResults]
  );

  const counts = sortedSources.reduce((acc, s) => {
    const h = getAccountHealth(s, sourceRefreshStatus[s.id], testResults[s.id]);
    acc[h] = (acc[h] || 0) + 1;
    return acc;
  }, {});

  const totalChannels = sortedSources.reduce((sum, s) => sum + (s.channel_count || 0), 0);
  const tag = typeTag(group.type);

  const firstLocation = sortedSources.map(locationLabel).find(Boolean);
  const allSameLocation = firstLocation && sortedSources.every((s) => {
    const loc = locationLabel(s);
    return !loc || loc === firstLocation;
  });

  const accountCount = sortedSources.length;

  const classifyResult = (diag) => {
    const passed = diag?.passed ?? 0;
    const tested = diag?.tested ?? 0;
    if (!tested) return 'error';
    if (passed === tested) return 'passed';
    if (passed === 0) return 'failed';
    return 'partial';
  };

  const testOne = async (source) => {
    onSetPendingTestResult?.(source.id, { status: 'testing' });
    try {
      const res = await iptvSourcesService.testStreams(source.id);
      const diag = res?.diagnostics;
      if (!res?.success || !diag) {
        onSetTestResult?.(source.id, { status: 'error', error: res?.error || 'Test failed' });
        return;
      }
      onSetTestResult?.(source.id, {
        status: classifyResult(diag),
        passed: diag.passed ?? 0,
        tested: diag.tested ?? 0,
        diagnostics: diag,
      });
    } catch (err) {
      onSetTestResult?.(source.id, {
        status: 'error',
        error: err?.response?.data?.error || err?.message || 'Test failed',
      });
    } finally {
      setTestProgress((p) => ({ ...p, done: p.done + 1 }));
    }
  };

  const handleTestAll = async () => {
    if (testingAll) return;
    setTestingAll(true);
    // Clear only THIS group's old results so results from other domains
    // (stored in the same map) aren't wiped.
    onRemoveTestResults?.(sortedSources.map((s) => s.id));
    setTestProgress({ done: 0, total: sortedSources.length });
    const queue = [...sortedSources];
    const workers = Array.from({ length: Math.min(MAX_TEST_CONCURRENT, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) await testOne(next);
      }
    });
    await Promise.all(workers);
    setTestingAll(false);
  };

  // Summaries and delete-failed scoping look only at this group's sources.
  // (Sort order doesn't matter here, but sortedSources === group.sources by
  // membership so the result is the same.)
  const groupResultsEntries = sortedSources
    .map((s) => [s.id, testResults[s.id]])
    .filter(([, r]) => r);

  const testSummary = (() => {
    if (groupResultsEntries.length === 0) return null;
    let passed = 0, partial = 0, failed = 0, errored = 0, testing = 0;
    for (const [, r] of groupResultsEntries) {
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
    setDeleteStartedAt(Date.now());
    setDeleteElapsedMs(0);
    setProgress({ done: 0, total: ids.length });
    await Promise.allSettled(
      ids.map((id) =>
        Promise.resolve(onDelete(id)).finally(() => {
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        })
      )
    );
    // MyIPTVs.handleDelete already calls removeTestResults for each id it
    // deletes, but call it here too for belt-and-suspenders in case a delete
    // resolves async after our state has moved on.
    onRemoveTestResults?.(ids);
    setDeleting(false);
    setDeleteStartedAt(null);
    setDeleteElapsedMs(0);
    setConfirming(null);
  };

  const failedSourceIds = groupResultsEntries
    .filter(([, r]) => r?.status === 'failed')
    .map(([id]) => id);

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
                ? `Deleting ${progress.done}/${progress.total} accounts from ${group.domain}… (${Math.floor(deleteElapsedMs / 1000)}s)`
                : confirming.mode === 'failed'
                  ? `Delete ${confirming.ids.length} failed account${confirming.ids.length === 1 ? '' : 's'} from ${group.domain}?`
                  : `Delete all ${confirming.ids.length} account${confirming.ids.length === 1 ? '' : 's'} from ${group.domain}?`}
            </h3>
            {deleting && (() => {
              // Show an explanatory hint after the operation starts
              // looking slow. The DELETE cascade has to wait for any
              // in-flight TMDB-enrichment UPDATE on movie_streams to
              // release its row locks — typically a few seconds, but
              // historically up to ~30s when the enrichment ran the
              // unindexed seqscan UPDATE. Both the index (migration
              // 041) and the pause hold (added to the DELETE route)
              // should keep this brief; the hint kicks in only if it
              // genuinely lingers so the user knows the UI isn't
              // frozen and the work is real.
              const elapsedSec = Math.floor(deleteElapsedMs / 1000);
              if (progress.done >= progress.total && progress.total > 0) return null;
              if (elapsedSec < 5) return null;
              if (elapsedSec < 15) {
                return (
                  <span className="hidden md:inline text-xs text-red-300/70">
                    Cascading delete in progress — waiting on the media library to release locks.
                  </span>
                );
              }
              return (
                <span className="hidden md:inline text-xs text-amber-300">
                  Still working — large catalogs can take a minute. Don't refresh.
                </span>
              );
            })()}
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
        // ─── DOMAIN SECTION HEADER — three-row layout ─────────────
        // Row 1: identity (badge + domain + location). Stands alone,
        //        gets all the visual weight. Only the collapse chevron
        //        sits on the right — universal pattern.
        // Row 2: stats strip — accounts/channels, health distribution
        //        with a stacked proportion bar, and test summary
        //        right-aligned. flex-wrap so it gracefully reflows.
        // Row 3: action group — sort, refresh-all, test-all, delete.
        //        Anchored right so the eye knows where the affordances
        //        live. All actions are always visible (no hover-reveal).
        // Each row has its own dedicated horizontal space so no
        // element can overflow into another's territory.
        <header
          onClick={() => setCollapsed((c) => !c)}
          className="relative px-5 pt-3 pb-3 bg-gradient-to-b from-slate-900/80 via-slate-900/55 to-slate-900/30 border-b border-slate-800/60 cursor-pointer select-none hover:from-slate-900/90"
        >
          {/* ── ROW 1 — Identity ─────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span className={`shrink-0 inline-flex items-center px-2 py-0.5 text-[10px] font-bold tracking-[0.2em] rounded border ${tag.cls}`}>
                {tag.label}
              </span>
              <h3 className="text-[15px] font-semibold text-slate-100 truncate min-w-0 tracking-tight">
                {group.domain}
              </h3>
              {allSameLocation && firstLocation && (
                <span className="hidden md:inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-500 truncate max-w-[35%]">
                  <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span className="truncate">{firstLocation}</span>
                </span>
              )}
            </div>
            {/* Chevron pinned top-right — the universal collapse
                affordance. Click on the header anywhere else also
                toggles collapse via the parent onClick. */}
            <span className={`shrink-0 text-slate-500 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </span>
          </div>

          {/* ── ROW 2 — Stats strip ──────────────────────────────── */}
          <div className="mt-2.5 flex items-center gap-4 flex-wrap min-w-0 text-xs">
            {/* Accounts + Channels — paired numeric stats with a
                hairline divider between them. Mono digits, mini-caps
                labels. */}
            <div className="inline-flex items-center gap-4">
              <div className="inline-flex items-baseline gap-1.5">
                <span className="font-mono tabular-nums text-sm font-semibold text-slate-100">{accountCount}</span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">accounts</span>
              </div>
              <span className="h-3 w-px bg-slate-800" aria-hidden="true" />
              <div className="inline-flex items-baseline gap-1.5">
                <span className="font-mono tabular-nums text-sm font-semibold text-slate-100">{totalChannels.toLocaleString()}</span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">channels</span>
              </div>
            </div>

            {/* Vertical divider between data and health */}
            <span className="hidden md:inline-block h-4 w-px bg-slate-800" aria-hidden="true" />

            {/* Health distribution: stacked proportion bar + per-status
                counts. Much richer than the old plain colored text —
                the bar shows the OVERALL story at a glance, the
                numbers fill in detail. */}
            {(() => {
              const entries = [
                { key: 'ok',      label: 'ok',      bar: 'bg-emerald-500', dot: 'bg-emerald-400 shadow-[0_0_5px_rgba(16,185,129,0.55)]', text: 'text-emerald-300' },
                { key: 'warn',    label: 'warn',    bar: 'bg-amber-500',   dot: 'bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.55)]',  text: 'text-amber-300' },
                { key: 'error',   label: 'fail',    bar: 'bg-red-500',     dot: 'bg-red-400 shadow-[0_0_5px_rgba(248,113,113,0.55)]',  text: 'text-red-300' },
                { key: 'loading', label: 'loading', bar: 'bg-blue-500',    dot: 'bg-blue-400 animate-pulse',                          text: 'text-blue-300' },
                { key: 'unknown', label: 'idle',    bar: 'bg-slate-600',   dot: 'bg-slate-500',                                        text: 'text-slate-400' },
              ];
              const visible = entries.filter((e) => counts[e.key]);
              if (visible.length === 0) {
                return (
                  <span className="text-[11px] text-slate-600 italic">no status yet</span>
                );
              }
              return (
                <div className="inline-flex items-center gap-3 min-w-0">
                  <div className="flex h-1.5 w-24 rounded-full overflow-hidden bg-slate-800/80 shrink-0">
                    {visible.map((e) => (
                      <div
                        key={e.key}
                        className={e.bar}
                        style={{ flex: counts[e.key] }}
                        title={`${counts[e.key]} ${e.label}`}
                      />
                    ))}
                  </div>
                  <div className="inline-flex items-center gap-x-2.5 gap-y-1 flex-wrap">
                    {visible.map((e) => (
                      <span key={e.key} className={`inline-flex items-center gap-1 ${e.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${e.dot}`} />
                        <span className="tabular-nums font-semibold">{counts[e.key]}</span>
                        <span className="text-[10px] uppercase tracking-[0.1em] opacity-70">{e.label}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}

            <span className="flex-1" />

            {/* Test summary — right-aligned. Hidden when no tests have
                been run. While testingAll, shows progress; otherwise
                shows passed / partial / failed and an optional
                Remove-N pill when any failed. */}
            {testSummary && (
              <div className="inline-flex items-center gap-2.5 pl-3 md:border-l md:border-slate-800">
                {testingAll ? (
                  <span className="inline-flex items-center gap-1.5 text-blue-300">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="tabular-nums font-semibold">Testing {testProgress.done}/{testProgress.total}</span>
                  </span>
                ) : (
                  <>
                    {testSummary.passed > 0 && (
                      <span className="inline-flex items-center gap-1 text-emerald-300">
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
                      <span className="inline-flex items-center gap-1 text-red-300">
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
          </div>

          {/* ── ROW 3 — Action group ─────────────────────────────── */}
          {/* stopPropagation at the row level so button clicks don't
              accidentally toggle the header's collapse handler. */}
          <div
            className="mt-3 flex items-center justify-end gap-1.5 flex-wrap"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="opacity-70 hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <SortMenu
                compact
                align="right"
                label="Sort"
                value={sortKey}
                inheritOption
                inheriting={sortInheritsGlobal}
                globalSortKey={globalSortKey}
                onChange={onChangeSort}
              />
            </div>

            {/* Refresh-all pill (or split Cancel pill while in flight) */}
            {onRefreshAllInGroup && (
              isRefreshingThisGroup ? (
                <div className="shrink-0 inline-flex items-stretch rounded-md overflow-hidden border border-cyan-500/40">
                  <span
                    className="inline-flex items-center gap-1.5 bg-cyan-500/10 text-cyan-200 px-2 py-1 text-[11px] font-semibold tracking-wide"
                    title={`Refreshing ${refreshProgress.current}/${refreshProgress.total} accounts on ${group.domain}…`}
                  >
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="tabular-nums">{refreshProgress.current}/{refreshProgress.total}</span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onCancelRefresh?.(); }}
                    title="Stop this refresh"
                    aria-label="Cancel refresh"
                    className="inline-flex items-center gap-1 bg-red-500/15 text-red-200 hover:bg-red-500/30 hover:text-red-100 px-2 py-1 text-[11px] font-semibold tracking-wide transition-colors border-l border-cyan-500/40"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRefreshAllInGroup(); }}
                  disabled={isRefreshingAny}
                  title={
                    isRefreshingAny
                      ? 'Another refresh is in progress — wait for it to finish'
                      : `Refresh account info for all ${accountCount} account${accountCount === 1 ? '' : 's'} on ${group.domain}`
                  }
                  aria-label={`Refresh account info for all ${accountCount} account${accountCount === 1 ? '' : 's'} on ${group.domain}`}
                  className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors disabled:cursor-not-allowed ${
                    isRefreshingAny
                      ? 'border-slate-700 bg-slate-800/40 text-slate-500'
                      : 'border-cyan-500/30 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/15 hover:border-cyan-500/50'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Refresh all</span>
                </button>
              )
            )}

            {/* Test-all pill */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleTestAll(); }}
              disabled={testingAll}
              title={`Test streams for all ${accountCount} account${accountCount === 1 ? '' : 's'} on ${group.domain}`}
              aria-label={`Test streams for all ${accountCount} account${accountCount === 1 ? '' : 's'} on ${group.domain}`}
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors disabled:cursor-not-allowed ${
                testingAll
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-200'
                  : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/15 hover:border-emerald-500/50'
              }`}
            >
              {testingAll ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span className="tabular-nums">{testProgress.done}/{testProgress.total}</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>Test all</span>
                </>
              )}
            </button>

            {/* Delete — always visible (was hover-only) but visually
                quieter than the green/cyan action pills. Tints red on
                hover so the destructive intent is unmistakable. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirming({ mode: 'all', ids: sortedSources.map((s) => s.id) });
              }}
              title={`Delete all ${accountCount} account${accountCount === 1 ? '' : 's'}`}
              aria-label={`Delete all ${accountCount} account${accountCount === 1 ? '' : 's'} from ${group.domain}`}
              className="shrink-0 ml-0.5 p-1.5 rounded-md text-slate-600 hover:bg-red-500/10 hover:text-red-300 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </header>
      )}

      {!collapsed && (
        // Rows stay visible during deletion so the card keeps its
        // shape and the user can see WHICH accounts the progress
        // banner is talking about. Previously we hid the rows the
        // moment deletion started, which collapsed the whole card
        // into a single-line red strip — easy to mistake for a
        // page-level alert. Rows still being deleted get a dimmed
        // tone via `pointer-events-none` + opacity below.
        <>
          {/* Column header — anchors the eye for the grid below.
              Only rendered when there's at least one row, and only on
              md+ where the data columns themselves are visible. Same
              ACCOUNT_GRID_TEMPLATE drives both this header and every
              row, so they cannot drift. */}
          {sortedSources.length > 0 && (
            <div
              className="hidden md:grid md:items-center gap-4 px-5 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 bg-slate-950/40 border-b border-slate-800/80 select-none"
              style={{ gridTemplateColumns: ACCOUNT_GRID_TEMPLATE }}
            >
              <span>Account</span>
              <span className="text-right">Channels</span>
              <span className="text-right">Expires</span>
              <span className="text-right">Conn</span>
              <span>Last check</span>
              {/* Streams header carries the same `border-r` the data-row
                  Streams cell does so the hairline divider extends
                  cleanly through the header band at a fixed x. */}
              <span className="self-stretch pr-3 border-r border-slate-800/60 flex items-center">Streams</span>
              {/* Trailing actions cell — empty in the header, but
                  occupies its grid track so the action column lines up
                  with the row's action strip. */}
              <span aria-hidden="true" />
            </div>
          )}

          <div className={`divide-y divide-slate-800/60 ${deleting ? 'pointer-events-none' : ''}`}>
            {sortedSources.map((source) => {
              // While deletion is in flight, dim any row whose ID is
              // queued for deletion so the user can see which ones
              // are about to go (and which one will survive the
              // batch). pointer-events-none on the container above
              // disables further actions until deletion finishes —
              // can't refresh / test / edit a row that's about to
              // disappear.
              const isQueuedForDelete = deleting && confirming?.ids?.includes(source.id);
              return (
                <div
                  key={source.id}
                  className={isQueuedForDelete ? 'opacity-40 transition-opacity' : ''}
                  aria-busy={isQueuedForDelete || undefined}
                >
                  <AccountRow
                    source={source}
                    refreshStatus={sourceRefreshStatus[source.id]}
                    onDelete={onDelete}
                    testResult={testResults[source.id]}
                    onShowDiagnostics={onShowDiagnostics}
                    {...rowProps}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
};

export default DomainSection;
