import React, { useState, useEffect, useMemo } from 'react';
import iptvSourcesService from '../../services/iptvSourcesService';
import StreamDiagnosticsModal from '../../components/StreamDiagnosticsModal';
import DomainSection from './DomainSection';
import SortMenu from './SortMenu';
import { useTestResults } from './useTestResults';
import { useAppContext } from '../../contexts/AppContext';
import { groupSourcesByDomain, getRefreshHostKey, SORT_OPTIONS, DEFAULT_SORT_KEY } from './utils';

/**
 * My IPTVs management page.
 *
 * The Add-IPTV-Source modal used to live inside this component. It got
 * lifted to AppLayout so a bulk-add can be minimized and survive page
 * navigation. We now refresh our local `sources` list whenever the
 * global `sourceListRevision` counter bumps (incremented by the modal
 * when a source is added / a bulk batch finishes).
 */
const MyIPTVs = ({
  onViewChannels: onViewChannelsProp,
}) => {
  const { sourceListRevision, bumpSourceListRevision, setShowAddModal } = useAppContext();
  const [sources, setSources] = useState([]);
  const domainGroups = useMemo(() => groupSourcesByDomain(sources), [sources]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({ current: 0, total: 0 });
  const [sourceRefreshStatus, setSourceRefreshStatus] = useState({}); // Track status per source: { sourceId: 'loading' | 'success' | 'error' }
  const [refreshSummary, setRefreshSummary] = useState(null); // { successCount, failCount, duration }
  const [diagnosticsModal, setDiagnosticsModal] = useState({ isOpen: false, diagnostics: null, sourceName: '' });

  // Sort state — global default + per-domain overrides. Persisted to
  // localStorage so the user's preference survives reloads. Effective
  // sort key for a domain card = override OR global default.
  const SORT_STORAGE_KEY = 'myiptvs.sortPrefs.v1';
  const [globalSortKey, setGlobalSortKey] = useState(DEFAULT_SORT_KEY);
  const [domainSortKeys, setDomainSortKeys] = useState({}); // { [domainKey]: sortKey }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.global && SORT_OPTIONS[parsed.global]) {
        setGlobalSortKey(parsed.global);
      }
      if (parsed?.byDomain && typeof parsed.byDomain === 'object') {
        // Drop any keys that no longer exist in SORT_OPTIONS so a stale
        // pref from an older version doesn't poison the resolver.
        const cleaned = {};
        for (const [k, v] of Object.entries(parsed.byDomain)) {
          if (SORT_OPTIONS[v]) cleaned[k] = v;
        }
        setDomainSortKeys(cleaned);
      }
    } catch {
      // Corrupt blob — leave defaults.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SORT_STORAGE_KEY,
        JSON.stringify({ global: globalSortKey, byDomain: domainSortKeys })
      );
    } catch {
      // Quota / serialization issues — non-fatal.
    }
  }, [globalSortKey, domainSortKeys]);

  // Effective sort key for a given domain (override OR global default).
  const sortKeyForDomain = (domainKey) =>
    domainSortKeys[domainKey] || globalSortKey;

  const setSortForDomain = (domainKey, sortKey) => {
    setDomainSortKeys((prev) => {
      const next = { ...prev };
      if (!sortKey || sortKey === '__inherit__') {
        delete next[domainKey];
      } else {
        next[domainKey] = sortKey;
      }
      return next;
    });
  };

  const resetAllDomainSortOverrides = () => setDomainSortKeys({});

  // Persisted stream-test results keyed by source id. Survives navigation +
  // page refresh via localStorage so runs are still visible when the user
  // comes back to this page.
  const {
    results: testResults,
    setResult: setTestResult,
    setPendingResult: setPendingTestResult,
    removeResults: removeTestResults,
  } = useTestResults();

  // Load sources on mount + whenever the global AddSourceModal bumps
  // the revision counter (a new single-source add, or each bulk-added
  // source completing). This is how source-list updates flow from the
  // global modal into this page now that the modal no longer renders
  // here.
  useEffect(() => {
    loadSources();
  }, [sourceListRevision]);

  const loadSources = async () => {
    try {
      // Only flash the "Loading sources…" spinner when we have NOTHING
      // to show yet. On a re-fetch (after a source was added in the
      // global modal, after a refresh-all, etc.) we already have the
      // current list rendered and can update in place — toggling
      // loading=true would otherwise collapse every domain card to a
      // big centered spinner mid-flow, hiding the user's expanded
      // panels, scroll position, and any per-row status badges that
      // just landed.
      const isInitialLoad = sources.length === 0;
      if (isInitialLoad) setLoading(true);
      setError(null);
      const data = await iptvSourcesService.getUserSources();
      setSources(data);
    } catch (err) {
      console.error('Error loading sources:', err);
      setError('Failed to load IPTV sources');
    } finally {
      setLoading(false);
    }
  };

  const handleEditNickname = async (sourceId, nickname) => {
    try {
      await iptvSourcesService.updateSourceNickname(sourceId, nickname);
      // Update local state
      setSources(prev => prev.map(s => s.id === sourceId ? { ...s, nickname } : s));
      bumpSourceListRevision();
      setNotification({
        type: 'success',
        message: 'Nickname updated successfully'
      });
      setTimeout(() => setNotification(null), 3000);
    } catch (err) {
      console.error('Error updating nickname:', err);
      setNotification({
        type: 'error',
        message: 'Failed to update nickname'
      });
      setTimeout(() => setNotification(null), 5000);
    }
  };

  const handleDelete = async (sourceId) => {
    try {
      await iptvSourcesService.deleteSource(sourceId);
      // Remove from local state
      setSources(prev => prev.filter(s => s.id !== sourceId));
      // Drop any persisted test result for this source so it doesn't linger.
      removeTestResults([sourceId]);
      bumpSourceListRevision();
      setNotification({
        type: 'success',
        message: 'Source deleted successfully'
      });
      setTimeout(() => setNotification(null), 3000);
    } catch (err) {
      console.error('Error deleting source:', err);
      const errorMsg = err.response?.data?.error || 'Failed to delete source';
      setNotification({
        type: 'error',
        message: errorMsg
      });
      setTimeout(() => setNotification(null), 5000);
    }
  };

  const handleViewChannels = (source) => {
    if (onViewChannelsProp) {
      onViewChannelsProp(source);
    }
  };

  const handleRefreshAccountInfo = async (sourceId) => {
    try {
      const result = await iptvSourcesService.refreshAccountInfo(sourceId);

      if (result.success) {
        setNotification({
          type: 'success',
          message: `Successfully refreshed! Loaded ${result.channelCount} channels and ${result.categoryCount} categories.`
        });
        setTimeout(() => setNotification(null), 5000);

        // Update the source in local state with fresh data from backend
        if (result.source) {
          setSources(prev => prev.map(s => s.id === sourceId ? result.source : s));
        }
      }

      // Also reload all sources to be safe
      await loadSources();
      bumpSourceListRevision();
    } catch (err) {
      console.error('Error refreshing source:', err);
      const errorMsg = err.response?.data?.error || 'Failed to refresh source data';
      setNotification({
        type: 'error',
        message: errorMsg
      });
      setTimeout(() => setNotification(null), 5000);
    }
  };

  // Set of source IDs with an in-flight manual stream test. Lets us:
  //   - keep multi-row manual testing genuinely concurrent (no global lock),
  //   - suppress the auto-opened diagnostics modal when more than one
  //     test is running so finishing tests don't fight over the modal,
  //   - prefix toast notifications with the source name so the user knows
  //     which row a status message belongs to even when several finish
  //     near the same time.
  const inflightTestsRef = React.useRef(new Set());

  const handleTestStreams = async (sourceId) => {
    const source = sources.find(s => s.id === sourceId);
    const sourceName = source?.nickname || source?.name || 'Source';

    // Track this run before it begins so a near-simultaneous second
    // click sees inflightCount > 1 and skips the auto-modal.
    inflightTestsRef.current.add(sourceId);
    const wasSolo = inflightTestsRef.current.size === 1;

    setNotification({
      type: 'info',
      message: `Testing streams for ${sourceName}...`
    });

    // Mark the row as "testing" so the STREAMS chip shows a pending
    // state (same persistence the bulk Test-All path uses). Without
    // this the row stayed visually blank during the test AND ended up
    // with no chip even after success — the diagnostics modal was the
    // only feedback.
    setPendingTestResult(sourceId, { status: 'testing' });

    // Same classifier the bulk Test-All path uses so the chip render
    // matches across both flows.
    const classify = (diag) => {
      const passed = diag?.passed ?? 0;
      const tested = diag?.tested ?? 0;
      if (!tested) return 'error';
      if (passed === tested) return 'passed';
      if (passed === 0) return 'failed';
      return 'partial';
    };

    try {
      const result = await iptvSourcesService.testStreams(sourceId);

      if (result.success && result.diagnostics) {
        const diag = result.diagnostics;
        setTestResult(sourceId, {
          status: classify(diag),
          passed: diag.passed ?? 0,
          tested: diag.tested ?? 0,
          diagnostics: diag,
        });

        // Only auto-open the diagnostics modal when this was the sole
        // test in flight at the time we started AND nothing else has
        // queued up while we were waiting. With multiple manual tests
        // running, the modal would otherwise flap to whichever finishes
        // last — the per-row chip is a better persistent indicator the
        // user can click after the fact.
        const stillSolo = wasSolo && inflightTestsRef.current.size === 1;
        const message = `${sourceName}: ${diag.passed}/${diag.tested} streams passed.`;
        setNotification({
          type: diag.overallStatus === 'failing' ? 'warning' : diag.overallStatus === 'healthy' ? 'success' : 'info',
          message,
          action: {
            label: 'View Details',
            onClick: () => {
              setDiagnosticsModal({
                isOpen: true,
                diagnostics: diag,
                sourceName
              });
            }
          }
        });
        setTimeout(() => setNotification(null), 8000);

        if (stillSolo) {
          setDiagnosticsModal({
            isOpen: true,
            diagnostics: diag,
            sourceName
          });
        }
      } else {
        // API returned success=false. Persist the failure so the row's
        // chip shows the error state (not an indefinite spinner).
        setTestResult(sourceId, {
          status: 'error',
          error: result?.error || 'Test failed',
        });
      }
    } catch (err) {
      console.error('Error testing streams:', err);
      const errorMsg = err.response?.data?.error || err?.message || 'Failed to test streams';
      setTestResult(sourceId, { status: 'error', error: errorMsg });
      setNotification({
        type: 'error',
        message: `${sourceName}: ${errorMsg}`
      });
      setTimeout(() => setNotification(null), 5000);
    } finally {
      inflightTestsRef.current.delete(sourceId);
    }
  };

  // Track which scope is currently refreshing so per-card pills can
  // show progress ONLY on the card that fired the refresh (or every
  // card when the user clicked the page-level button). Without this
  // every domain card's "Refresh all" pill spun up the moment any
  // refresh started anywhere — confusing because they weren't actually
  // refreshing.
  const [refreshingScope, setRefreshingScope] = useState(null); // 'all' | domainKey | null

  // AbortController for the in-flight refresh batch. The Cancel button
  // on the Refresh-all pill calls .abort(), which:
  //   - aborts any in-flight axios call immediately (the browser closes
  //     the connection),
  //   - flips refreshCancelledRef so the host-bucket loop stops firing
  //     new requests after the current one returns.
  // The backend route's req 'close' handler picks up the disconnect
  // and exits its own loop, though an in-progress saveChannels() can't
  // be interrupted mid-INSERT — it'll finish that batch then stop.
  const refreshAbortRef = React.useRef(null);
  const refreshCancelledRef = React.useRef(false);

  const cancelRefresh = () => {
    // Diagnostic — if the user reports "I clicked cancel but it kept
    // going", this log proves the handler actually fired vs. the
    // button click never reaching us.
    console.log('[Refresh] Cancel clicked. abortController present:', !!refreshAbortRef.current);
    refreshCancelledRef.current = true;
    if (refreshAbortRef.current) {
      try { refreshAbortRef.current.abort(); } catch (e) {
        console.warn('[Refresh] AbortController.abort() threw', e);
      }
    }
  };

  // Accepts an optional subset of sources to refresh. With no argument
  // (or an empty subset), refreshes every source — the original
  // page-level "Refresh All" behaviour. With a subset (the per-domain
  // "Refresh all" button passes the card's sources), refreshes just
  // those rows but reuses the same host-bucketed concurrency, status
  // tracking, and summary banner so the UX is identical.
  const handleRefreshAll = async (sourcesToRefresh, scopeKey = null) => {
    const targets = (Array.isArray(sourcesToRefresh) && sourcesToRefresh.length > 0)
      ? sourcesToRefresh
      : sources;
    if (isRefreshingAll || targets.length === 0) return;

    setIsRefreshingAll(true);
    setRefreshingScope(scopeKey || 'all');
    setRefreshProgress({ current: 0, total: targets.length });

    // Fresh AbortController per batch — clearing any leftover from
    // a previous run.
    refreshCancelledRef.current = false;
    refreshAbortRef.current = new AbortController();

    // Initialize THIS run's sources as loading. Don't wipe sourceRefreshStatus
    // for sources NOT in this run — they may still be showing a
    // success/error badge from a previous refresh.
    const initialStatus = { ...sourceRefreshStatus };
    targets.forEach(source => {
      initialStatus[source.id] = 'loading';
    });
    setSourceRefreshStatus(initialStatus);

    const startTime = Date.now();

    // Helper function to refresh a single source
    const refreshSource = async (source) => {
      try {
        const result = await iptvSourcesService.refreshAccountInfo(source.id, {
          signal: refreshAbortRef.current?.signal,
        });

        // Backend reports rate_limited via HTTP 200 + rateLimited:true.
        // The DB row is now `last_refresh_status='rate_limited'`, which
        // getAccountHealth maps to 'warn' (amber) — not 'error' (red).
        // Show the badge as 'success'-ish ('warn-toned') so the user
        // sees the refresh completed without trying again, but the
        // notification distinguishes it from a clean refresh.
        const isRateLimited = result && result.rateLimited === true;
        setSourceRefreshStatus(prev => ({
          ...prev,
          [source.id]: isRateLimited ? 'warn' : 'success'
        }));
        setRefreshProgress(prev => ({ ...prev, current: prev.current + 1 }));

        if (result.source) {
          setSources(prev => prev.map(s => s.id === source.id ? result.source : s));
        } else if (isRateLimited) {
          // Rate-limit path doesn't include result.source. Re-fetch the
          // row so the table picks up the new last_refresh_status and
          // updated last_refresh_attempt timestamp.
          try {
            const updatedSources = await iptvSourcesService.getUserSources();
            const updatedSource = updatedSources.find(s => s.id === source.id);
            if (updatedSource) {
              setSources(prev => prev.map(s => s.id === source.id ? updatedSource : s));
            }
          } catch (reloadErr) {
            console.warn('Failed to reload source after rate-limit', reloadErr);
          }
        }

        return { sourceId: source.id, status: isRateLimited ? 'rate_limited' : 'success', result };
      } catch (err) {
        // Cancellation isn't a real error — the user hit Cancel. Don't
        // mark the row as errored; just clear the loading badge.
        if (err && err.cancelled) {
          setSourceRefreshStatus(prev => {
            const next = { ...prev };
            delete next[source.id];
            return next;
          });
          setRefreshProgress(prev => ({ ...prev, current: prev.current + 1 }));
          return { sourceId: source.id, status: 'cancelled' };
        }

        console.error(`Error refreshing source ${source.id}:`, err);

        // Update status to error
        setSourceRefreshStatus(prev => ({ ...prev, [source.id]: 'error' }));
        setRefreshProgress(prev => ({ ...prev, current: prev.current + 1 }));

        // Reload sources to get updated failure stats from database
        try {
          const updatedSources = await iptvSourcesService.getUserSources();
          const updatedSource = updatedSources.find(s => s.id === source.id);
          if (updatedSource) {
            setSources(prev => prev.map(s => s.id === source.id ? updatedSource : s));
          }
        } catch (reloadErr) {
          console.error('Failed to reload source after error:', reloadErr);
        }

        return { sourceId: source.id, status: 'error', error: err.message };
      }
    };

    // Smart parallel refresh: group sources by host to avoid rate limiting.
    // Different hosts run in parallel; same host is serialized. Stalker MACs get
    // their own bucket since each MAC is rate-limited separately.
    const sourcesByHost = {};
    targets.forEach(source => {
      const hostKey = getRefreshHostKey(source);
      if (!sourcesByHost[hostKey]) {
        sourcesByHost[hostKey] = [];
      }
      sourcesByHost[hostKey].push(source);
    });

    // Process each host's sources sequentially, but all hosts in parallel.
    // The per-iteration `refreshCancelledRef` check is what lets the
    // Cancel button actually stop the queue — without it, even after
    // an .abort() on the in-flight axios, the loop would keep firing
    // the next source.
    const hostPromises = Object.values(sourcesByHost).map(async (hostSources) => {
      const hostResults = [];
      for (const source of hostSources) {
        if (refreshCancelledRef.current) {
          // Drop the loading badge for any source we never got to so
          // the UI doesn't leave them in a permanent "loading" state.
          setSourceRefreshStatus(prev => {
            const next = { ...prev };
            delete next[source.id];
            return next;
          });
          hostResults.push({ status: 'fulfilled', value: { sourceId: source.id, status: 'cancelled' } });
          continue;
        }
        const result = await refreshSource(source);
        hostResults.push({ status: 'fulfilled', value: result });
      }
      return hostResults;
    });

    // Wait for all hosts to complete and flatten results
    const hostResults = await Promise.all(hostPromises);
    const results = hostResults.flat();
    const wasCancelled = refreshCancelledRef.current;

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    // Count successes / rate-limited / cancelled / failures separately
    // so the summary banner can tell the user something useful instead
    // of just incrementing "failed".
    let successCount = 0;
    let rateLimitedCount = 0;
    let cancelledCount = 0;
    let failCount = 0;

    results.forEach(result => {
      if (result.status !== 'fulfilled') {
        failCount++;
        return;
      }
      const v = result.value || {};
      if (v.status === 'success') successCount++;
      else if (v.status === 'rate_limited') rateLimitedCount++;
      else if (v.status === 'cancelled') cancelledCount++;
      else failCount++;
    });

    // No final `loadSources()` here — per-source rows were already
    // updated incrementally inside `refreshSource()` via
    // `setSources(prev => prev.map(...))`, so our local state is
    // current. The previous explicit reload (combined with
    // `bumpSourceListRevision()` which fires *another* reload via
    // the useEffect on sourceListRevision) caused two consecutive
    // `loading=true` flashes — the list collapsed to a spinner
    // twice, hiding the per-row health badges and the success/
    // failure summary banner that this function sets next. Refresh-
    // all doesn't add or remove sources, so the AppContext's
    // userSources doesn't need a bump either.

    setIsRefreshingAll(false);
    setRefreshingScope(null);
    setRefreshProgress({ current: 0, total: 0 });
    refreshAbortRef.current = null;
    refreshCancelledRef.current = false;

    // Set persistent summary (user must dismiss it).
    setRefreshSummary({ successCount, failCount, rateLimitedCount, cancelledCount, wasCancelled, duration });

    // Clear success badges after 8 seconds, keep error badges
    setTimeout(() => {
      setSourceRefreshStatus(prev => {
        const newStatus = {};
        Object.keys(prev).forEach(key => {
          if (prev[key] === 'error') {
            newStatus[key] = prev[key]; // Keep error status
          }
        });
        return newStatus;
      });
    }, 8000);
  };

  const handleEditCredentials = async (sourceId, credentials) => {
    try {
      // Update credentials
      await iptvSourcesService.updateSourceCredentials(sourceId, credentials);

      // Show success notification
      setNotification({
        type: 'success',
        message: 'Credentials updated successfully! Refreshing channels...'
      });
      setTimeout(() => setNotification(null), 5000);

      // Refresh account info to fetch new channels with updated credentials
      await handleRefreshAccountInfo(sourceId);
    } catch (err) {
      console.error('Error updating credentials:', err);
      const errorMsg = err.response?.data?.error || 'Failed to update credentials';
      setNotification({
        type: 'error',
        message: errorMsg
      });
      setTimeout(() => setNotification(null), 5000);
      throw err; // Re-throw so the row's local state can settle
    }
  };

  return (
    <div className="space-y-6">
      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-4 right-4 z-[70] rounded-lg border px-4 py-3 shadow-lg max-w-md ${
          notification.type === 'success'
            ? 'bg-green-900/90 border-green-700 text-green-100'
            : notification.type === 'warning'
            ? 'bg-yellow-900/90 border-yellow-700 text-yellow-100'
            : notification.type === 'info'
            ? 'bg-blue-900/90 border-blue-700 text-blue-100'
            : 'bg-red-900/90 border-red-700 text-red-100'
        }`}>
          <div className="flex items-start gap-3">
            {notification.type === 'success' ? (
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : notification.type === 'warning' ? (
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            ) : notification.type === 'info' ? (
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <div className="flex-1">
              <p className="text-sm font-medium">{notification.message}</p>
              {notification.action && (
                <button
                  onClick={() => {
                    notification.action.onClick();
                    setNotification(null);
                  }}
                  className="mt-2 text-sm underline hover:no-underline opacity-90 hover:opacity-100"
                >
                  {notification.action.label}
                </button>
              )}
            </div>
            <button
              onClick={() => setNotification(null)}
              className="text-current opacity-70 hover:opacity-100 transition-opacity"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Refresh Summary Banner — three states:
            all-good (green), some rate-limited (amber, transient),
            some failed (still amber/red). Rate-limited is amber not
            red because the data is intact and the failure is upstream
            throttling, not an account problem. */}
      {refreshSummary && (
        <div className={`rounded-xl border px-4 py-3 mb-4 ${
          refreshSummary.failCount === 0 && (refreshSummary.rateLimitedCount || 0) === 0
            ? 'bg-emerald-900/50 border-emerald-500/40 text-emerald-100'
            : 'bg-amber-900/50 border-amber-500/40 text-amber-100'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {refreshSummary.failCount === 0 && (refreshSummary.rateLimitedCount || 0) === 0 ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              )}
              <span className="font-medium">
                {refreshSummary.wasCancelled ? 'Refresh cancelled' : 'Refresh complete'} in {refreshSummary.duration}s:
                {' '}{refreshSummary.successCount} succeeded
                {refreshSummary.rateLimitedCount > 0 && (
                  <span className="text-amber-300">, {refreshSummary.rateLimitedCount} rate-limited (provider throttling — try again in a few minutes)</span>
                )}
                {refreshSummary.cancelledCount > 0 && (
                  <span className="text-slate-300">, {refreshSummary.cancelledCount} skipped</span>
                )}
                {refreshSummary.failCount > 0 && <span className="text-red-300">, {refreshSummary.failCount} failed</span>}
              </span>
            </div>
            <button
              onClick={() => setRefreshSummary(null)}
              className="text-current opacity-70 hover:opacity-100 transition-opacity p-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold text-slate-100 mb-2">My IPTV Sources</h2>
          <p className="text-sm text-slate-400">
            Manage your IPTV sources and click on one to view its channels
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SortMenu
            label="Sort all"
            value={globalSortKey}
            onChange={(k) => setGlobalSortKey(k)}
            onResetOverrides={
              Object.keys(domainSortKeys).length > 0 ? resetAllDomainSortOverrides : null
            }
          />
          {isRefreshingAll ? (
            // Mid-refresh: split the button into a spinning progress
            // pill + a Cancel chip the user can click to bail out.
            <div className="inline-flex items-stretch rounded-xl overflow-hidden border border-emerald-500/40 shadow-lg shadow-emerald-900/20">
              <span
                className="inline-flex items-center gap-2 bg-emerald-500/20 text-emerald-100 px-4 py-2.5 text-sm font-semibold"
                title={`Refreshing ${refreshProgress.current}/${refreshProgress.total} sources…`}
              >
                <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span className="tabular-nums">{refreshProgress.current}/{refreshProgress.total}</span>
              </span>
              <button
                onClick={cancelRefresh}
                title="Stop the in-flight refresh"
                aria-label="Cancel refresh"
                className="inline-flex items-center gap-1.5 bg-red-500/20 text-red-100 hover:bg-red-500/30 px-3 py-2.5 text-sm font-semibold transition-colors border-l border-emerald-500/40"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleRefreshAll()}
              disabled={sources.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/20 px-4 py-2.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-500/60 transition-all shadow-lg shadow-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh All
            </button>
          )}
          <button
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/20 px-4 py-2.5 text-sm font-semibold text-blue-100 hover:bg-blue-500/30 hover:border-blue-500/60 transition-all shadow-lg shadow-blue-900/20"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add IPTV Source
          </button>
        </div>
      </header>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mb-3"></div>
            <p className="text-sm text-slate-400">Loading sources...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-200 mb-1">Error</h3>
              <p className="text-sm text-red-100/80">{error}</p>
            </div>
            <button
              onClick={loadSources}
              className="text-sm text-red-300 hover:text-red-200 underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && sources.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/30 p-12 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 text-slate-500 mb-4">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-200 mb-2">No IPTV sources yet</h3>
          <p className="text-sm text-slate-400 mb-4">Add an IPTV source to get started</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/20 px-4 py-2.5 text-sm font-medium text-blue-100 hover:bg-blue-500/30 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add IPTV Source
          </button>
        </div>
      )}

      {/* Sources list — one section per domain, single column for easy scanning */}
      {!loading && !error && sources.length > 0 && (
        <div className="space-y-3">
          {domainGroups.map((group) => (
            <DomainSection
              key={group.key}
              group={group}
              sortKey={sortKeyForDomain(group.key)}
              sortInheritsGlobal={!domainSortKeys[group.key]}
              globalSortKey={globalSortKey}
              onChangeSort={(k) => setSortForDomain(group.key, k)}
              sourceRefreshStatus={sourceRefreshStatus}
              testResults={testResults}
              onSetTestResult={setTestResult}
              onSetPendingTestResult={setPendingTestResult}
              onRemoveTestResults={removeTestResults}
              onEdit={handleEditNickname}
              onDelete={handleDelete}
              onViewChannels={handleViewChannels}
              onRefreshAccountInfo={handleRefreshAccountInfo}
              onRefreshAllInGroup={() => handleRefreshAll(group.sources, group.key)}
              onCancelRefresh={cancelRefresh}
              // Only the card whose refresh is in flight shows the
              // progress pill. Other cards see `isRefreshingAll`
              // (which globally serializes refresh calls) reflected
              // as `disabled` so they can't fire a parallel refresh,
              // but they keep their "Refresh all" label intact.
              isRefreshingThisGroup={refreshingScope === group.key || refreshingScope === 'all'}
              isRefreshingAny={isRefreshingAll}
              refreshProgress={refreshProgress}
              onEditCredentials={handleEditCredentials}
              onTestStreams={handleTestStreams}
              onShowDiagnostics={(source, diagnostics) => {
                setDiagnosticsModal({
                  isOpen: true,
                  diagnostics,
                  sourceName: source.nickname || source.name || 'Source',
                });
              }}
            />
          ))}
        </div>
      )}

      {/* Stream Diagnostics Modal */}
      <StreamDiagnosticsModal
        isOpen={diagnosticsModal.isOpen}
        onClose={() => setDiagnosticsModal({ isOpen: false, diagnostics: null, sourceName: '' })}
        diagnostics={diagnosticsModal.diagnostics}
        sourceName={diagnosticsModal.sourceName}
      />
    </div>
  );
};

export default MyIPTVs;
