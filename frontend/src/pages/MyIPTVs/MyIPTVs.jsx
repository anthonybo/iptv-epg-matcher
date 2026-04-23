import React, { useState, useEffect, useMemo } from 'react';
import iptvSourcesService from '../../services/iptvSourcesService';
import Configuration from '../../Configuration';
import StreamDiagnosticsModal from '../../components/StreamDiagnosticsModal';
import DomainSection from './DomainSection';
import { groupSourcesByDomain, getRefreshHostKey } from './utils';

/**
 * My IPTVs management page
 */
const MyIPTVs = ({
  onSourcesUpdated,
  onViewChannels: onViewChannelsProp,
  onLoad,
  loadingError,
  backgroundLoadings,
  setBackgroundLoadings,
  showLoadingPicker,
  setShowLoadingPicker,
  showAddModal,
  setShowAddModal
}) => {
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

  // Load sources on mount
  useEffect(() => {
    loadSources();
  }, []);

  const loadSources = async () => {
    try {
      setLoading(true);
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
      if (onSourcesUpdated) onSourcesUpdated();
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
      if (onSourcesUpdated) onSourcesUpdated();
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
      if (onSourcesUpdated) onSourcesUpdated();
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

  const handleTestStreams = async (sourceId) => {
    const source = sources.find(s => s.id === sourceId);
    const sourceName = source?.nickname || source?.name || 'Source';

    setNotification({
      type: 'info',
      message: `Testing streams for ${sourceName}...`
    });

    try {
      const result = await iptvSourcesService.testStreams(sourceId);

      if (result.success && result.diagnostics) {
        const diag = result.diagnostics;
        let message = `Stream test complete: ${diag.passed}/${diag.tested} passed.`;

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

        // Auto-show diagnostics modal
        setDiagnosticsModal({
          isOpen: true,
          diagnostics: diag,
          sourceName
        });
      }
    } catch (err) {
      console.error('Error testing streams:', err);
      const errorMsg = err.response?.data?.error || 'Failed to test streams';
      setNotification({
        type: 'error',
        message: errorMsg
      });
      setTimeout(() => setNotification(null), 5000);
    }
  };

  const handleRefreshAll = async () => {
    if (isRefreshingAll || sources.length === 0) return;

    setIsRefreshingAll(true);
    setRefreshProgress({ current: 0, total: sources.length });

    // Initialize all sources as loading
    const initialStatus = {};
    sources.forEach(source => {
      initialStatus[source.id] = 'loading';
    });
    setSourceRefreshStatus(initialStatus);

    const startTime = Date.now();

    // Helper function to refresh a single source
    const refreshSource = async (source) => {
      try {
        const result = await iptvSourcesService.refreshAccountInfo(source.id);

        // Update status to success
        setSourceRefreshStatus(prev => ({ ...prev, [source.id]: 'success' }));
        setRefreshProgress(prev => ({ ...prev, current: prev.current + 1 }));

        // Update source data immediately so user sees duration/location as each completes
        if (result.source) {
          setSources(prev => prev.map(s => s.id === source.id ? result.source : s));
        }

        return { sourceId: source.id, status: 'success', result };
      } catch (err) {
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
    sources.forEach(source => {
      const hostKey = getRefreshHostKey(source);
      if (!sourcesByHost[hostKey]) {
        sourcesByHost[hostKey] = [];
      }
      sourcesByHost[hostKey].push(source);
    });

    // Process each host's sources sequentially, but all hosts in parallel
    // This gives us max parallelism while respecting per-host rate limits
    const hostPromises = Object.values(sourcesByHost).map(async (hostSources) => {
      const hostResults = [];
      for (const source of hostSources) {
        const result = await refreshSource(source);
        hostResults.push({ status: 'fulfilled', value: result });
      }
      return hostResults;
    });

    // Wait for all hosts to complete and flatten results
    const hostResults = await Promise.all(hostPromises);
    const results = hostResults.flat();

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    // Count successes and failures
    let successCount = 0;
    let failCount = 0;

    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value.status === 'success') {
        successCount++;
      } else {
        failCount++;
      }
    });

    // Reload sources to get updated data
    await loadSources();
    if (onSourcesUpdated) onSourcesUpdated();

    setIsRefreshingAll(false);
    setRefreshProgress({ current: 0, total: 0 });

    // Set persistent summary (user must dismiss it)
    setRefreshSummary({ successCount, failCount, duration });

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

      {/* Refresh Summary Banner */}
      {refreshSummary && (
        <div className={`rounded-xl border px-4 py-3 mb-4 ${
          refreshSummary.failCount === 0
            ? 'bg-emerald-900/50 border-emerald-500/40 text-emerald-100'
            : 'bg-amber-900/50 border-amber-500/40 text-amber-100'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {refreshSummary.failCount === 0 ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              )}
              <span className="font-medium">
                Refresh complete in {refreshSummary.duration}s: {refreshSummary.successCount} succeeded
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
          <button
            onClick={handleRefreshAll}
            disabled={isRefreshingAll || sources.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/20 px-4 py-2.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-500/60 transition-all shadow-lg shadow-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRefreshingAll ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {refreshProgress.current}/{refreshProgress.total}
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh All
              </>
            )}
          </button>
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
              sourceRefreshStatus={sourceRefreshStatus}
              onEdit={handleEditNickname}
              onDelete={handleDelete}
              onViewChannels={handleViewChannels}
              onRefreshAccountInfo={handleRefreshAccountInfo}
              onEditCredentials={handleEditCredentials}
              onTestStreams={handleTestStreams}
            />
          ))}
        </div>
      )}

      {/* Add Source Modal - Keep mounted to preserve loading state */}
      {/* Only render when there are background loadings OR modal is explicitly shown */}
      {(showAddModal || backgroundLoadings.size > 0) && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 transition-opacity duration-200 ${showAddModal ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
          <div className={`bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col transition-transform duration-200 ${showAddModal ? 'scale-100' : 'scale-95'}`}>
          {/* Modal Header */}
          <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-xl font-semibold text-slate-100">Add IPTV Source</h3>
            <button
              onClick={() => setShowAddModal(false)}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Modal Content */}
          <div className="flex-1 overflow-y-auto p-6">
            <Configuration
              embedded
              onSourceCompleted={async () => {
                // Refresh the source list as each bulk-added source finishes.
                await loadSources();
                if (onSourcesUpdated) onSourcesUpdated();
              }}
              onLoad={async (data) => {
                if (data?.bulk) {
                  await loadSources();
                  if (onSourcesUpdated) onSourcesUpdated();

                  const done = data.done || 0;
                  const failed = data.failed || 0;
                  const total = data.total || done + failed;
                  setNotification({
                    type: failed ? 'info' : 'success',
                    message: failed
                      ? `${done} of ${total} sources loaded (${failed} failed). Review the list above for details.`
                      : `Loaded ${done} source${done === 1 ? '' : 's'}.`
                  });
                  setTimeout(() => setNotification(null), 7000);
                  return;
                }

                await onLoad(data);
                setShowAddModal(false);
                setBackgroundLoadings(new Map()); // Clear all background loadings on completion
                await loadSources();
                if (onSourcesUpdated) onSourcesUpdated();

                setNotification({
                  type: 'success',
                  message: `Source added with ${data.channelCount || 0} channels. Use the test button to check stream connectivity.`
                });
                setTimeout(() => setNotification(null), 5000);
              }}
              error={loadingError}
              allowedTabs={['xtream', 'stalker', 'bulk']}
              onLoadingChange={(isLoading, sessionId, status, variant) => {
                // Track loading state even when modal is closed
                if (isLoading && sessionId) {
                  // Extract source name from status message if possible
                  let sourceName = 'IPTV Source';
                  if (status) {
                    // Try to extract portal URL or server from status
                    const portalMatch = status.match(/portal[:\s]+([^\s,]+)/i);
                    const serverMatch = status.match(/server[:\s]+([^\s,]+)/i);
                    if (portalMatch) sourceName = portalMatch[1];
                    else if (serverMatch) sourceName = serverMatch[1];
                  }

                  setBackgroundLoadings(prev => {
                    const next = new Map(prev);
                    next.set(sessionId, { sessionId, status, variant, sourceName });
                    return next;
                  });
                } else if (sessionId) {
                  // Remove this session from background loadings
                  setBackgroundLoadings(prev => {
                    const next = new Map(prev);
                    next.delete(sessionId);
                    return next;
                  });
                }
              }}
            />
          </div>
        </div>
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
