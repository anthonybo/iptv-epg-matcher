import React, { useState, useEffect } from 'react';
import EpgRefreshModal from '../EpgRefreshModal';
import SessionManager from '../../utils/sessionManager';
import apiClient from '../../utils/apiClient';

const formatNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }
  return numeric.toLocaleString();
};

const pickNumeric = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  return 0;
};

const formatDateTime = (value) => {
  if (!value) {
    return 'Unknown';
  }

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  } catch (err) {
    return value;
  }
};

const EpgSourcesSummary = ({ sources = [], onSourcesUpdated }) => {
  const statusStyles = {
    active: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
    disabled: 'border-slate-700 bg-slate-900/80 text-slate-400',
    pending: 'border-blue-500/40 bg-blue-500/15 text-blue-200',
    refreshing: 'border-blue-500/40 bg-blue-500/15 text-blue-200',
    complete: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
    failed: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
    offline: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
    unverified: 'border-yellow-500/40 bg-yellow-500/15 text-yellow-200',
    processing: 'border-blue-500/40 bg-blue-500/15 text-blue-200',
  };

  const [refreshing, setRefreshing] = useState(false);
  const [showRefreshModal, setShowRefreshModal] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({
    status: 'starting',
    sources: [],
    currentSource: 0,
    totalSources: 0,
    currentSourceName: null,
    error: null
  });
  const [eventSourceRef, setEventSourceRef] = useState(null);
  const [refreshingSource, setRefreshingSource] = useState(null); // Track which individual source is refreshing
  const [statusModal, setStatusModal] = useState({ show: false, type: 'success', message: '', details: null });
  const [deletingSource, setDeletingSource] = useState(null); // Track which source is being deleted
  const [confirmDelete, setConfirmDelete] = useState(null); // Show confirmation modal for delete

  // Check if EPG refresh is already running on component mount
  useEffect(() => {
    const checkRefreshStatus = async () => {
      try {
        const response = await fetch('/api/epg/refresh-status');
        if (response.ok) {
          const status = await response.json();
          if (status.isRunning) {
            console.log('[EPG REFRESH] Detected running refresh, reconnecting...');
            // Reconnect to the running refresh
            setRefreshing(true);
            setShowRefreshModal(true);

            // Include ALL sources (both system and user-added)
            // Initialize sources with proper status based on current progress
            const initialSources = sources.map((s, idx) => {
              // Disabled sources should stay disabled
              if (s.enabled === false) {
                return {
                  id: s.id,
                  name: s.name || 'Unknown',
                  url: s.url,
                  enabled: s.enabled,
                  verified: s.verified,
                  notes: s.notes,
                  status: 'disabled',
                  channels: s.channel_count || s.channelCount || null,
                  programs: s.program_count || s.programCount || null,
                  error: null
                };
              }

              const sourceNum = idx + 1;
              const currentSourceNum = status.currentSource || 0;

              // Check if this source is in the completedSources array from backend
              const completedSource = (status.completedSources || []).find(
                cs => cs.name === s.name
              );

              let sourceStatus = 'pending';
              let channels = null;
              let programs = null;
              let error = null;

              if (completedSource) {
                // Use status from backend's completedSources array
                sourceStatus = completedSource.status; // 'complete' or 'failed'
                channels = completedSource.channelCount;
                programs = completedSource.programCount;
                error = completedSource.error || null;
              } else if (sourceNum < currentSourceNum) {
                sourceStatus = 'complete';
                channels = s.channel_count || s.channelCount;
                programs = s.program_count || s.programCount;
              } else if (sourceNum === currentSourceNum) {
                sourceStatus = 'refreshing';
              }

              return {
                id: s.id,
                name: s.name || 'Unknown',
                url: s.url,
                enabled: s.enabled,
                verified: s.verified,
                notes: s.notes,
                status: sourceStatus,
                channels: channels,
                programs: programs,
                error: error
              };
            });

            const enabledCount = sources.filter(s => s.enabled !== false).length;

            setRefreshProgress({
              status: 'refreshing',
              sources: initialSources,
              currentSource: status.currentSource || 0,
              totalSources: status.totalSources || enabledCount,
              currentMessage: status.lastMessage,
              error: null
            });

            // Reconnect to SSE
            connectToSSE();
          }
        }
      } catch (error) {
        console.error('[EPG REFRESH] Error checking refresh status:', error);
      }
    };

    checkRefreshStatus();
  }, []);

  const handleViewRefreshDetails = async () => {
    // Load the latest refresh status before showing the modal
    try {
      const response = await fetch('/api/epg/refresh-status');
      if (response.ok) {
        const status = await response.json();
        if (status.completedSources && status.completedSources.length > 0) {
          // Include ALL sources (both system and user-added)
          const completedSourcesWithStatus = sources.map(source => {
            const completedSource = status.completedSources.find(cs => cs.name === source.name);
            if (completedSource) {
              return {
                ...source,
                status: completedSource.status,
                channels: completedSource.channelCount,
                programs: completedSource.programCount,
                error: completedSource.error || null
              };
            }
            return {
              ...source,
              status: 'pending',
              channels: null,
              programs: null,
              error: null
            };
          });

          setRefreshProgress({
            status: 'complete',
            sources: completedSourcesWithStatus,
            currentSource: status.totalSources,
            totalSources: status.totalSources,
            currentMessage: status.lastMessage,
            error: null
          });
        }
      }
    } catch (error) {
      console.error('[EPG REFRESH] Error loading refresh status:', error);
    }

    setShowRefreshModal(true);
  };

  const connectToSSE = () => {
    return new Promise((resolve) => {
      const sessionId = SessionManager.getSessionId();
      const eventSource = new EventSource(`/api/events/${sessionId}`);
      setEventSourceRef(eventSource);

      // Resolve promise when connection opens
      eventSource.onopen = () => {
        console.log('[EPG REFRESH] SSE connection established');
        resolve();
      };

      // Listen for epg-complete event (custom event type)
      eventSource.addEventListener('epg-complete', async (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[EPG REFRESH] epg-complete event received:', data);
          eventSource.close();

          // Load final results from refresh-status endpoint
          setTimeout(async () => {
            const statusResponse = await fetch(`/api/epg/refresh-status?_t=${Date.now()}`);
            if (statusResponse.ok) {
              const status = await statusResponse.json();

              // Use completedSources from backend if available
              if (status.completedSources && status.completedSources.length > 0) {
                console.log('[EPG REFRESH] completedSources from backend:', status.completedSources);

                // Update progress state with completion data
                setRefreshProgress(prev => {
                  console.log('[EPG REFRESH] Current sources before mapping:', prev.sources);

                  const updatedSources = prev.sources.map(source => {
                    // Find matching completed source from backend
                    const completedSource = status.completedSources.find(
                      cs => cs.name === source.name
                    );

                    if (completedSource) {
                      console.log('[EPG REFRESH] Matched completed source:', source.name, '→', completedSource.status);
                      return {
                        ...source,
                        status: completedSource.status,
                        channels: completedSource.channelCount,
                        programs: completedSource.programCount,
                        error: completedSource.error || null
                      };
                    }

                    console.log('[EPG REFRESH] No match for source:', source.name);
                    return source;
                  });

                  console.log('[EPG REFRESH] Updated sources after mapping:', updatedSources);

                  return {
                    status: 'complete',
                    sources: updatedSources,
                    currentSource: status.totalSources,
                    totalSources: status.totalSources,
                    currentMessage: status.lastMessage,
                    error: null
                  };
                });

                setRefreshing(false);

                // Fetch updated sources for the parent component
                const sourcesResponse = await fetch(`/api/epg/${sessionId}/sources?_t=${Date.now()}`);
                if (sourcesResponse.ok && onSourcesUpdated) {
                  const sourceData = await sourcesResponse.json();
                  if (sourceData.sources) {
                    onSourcesUpdated(sourceData.sources);
                  }
                }
              }
            }
          }, 500);
        } catch (error) {
          console.error('[EPG REFRESH] Error handling epg-complete event:', error);
        }
      });

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[EPG REFRESH] SSE event:', data);

          if (data.type === 'epg-progress') {
            const message = data.message;

            // Parse the message to extract useful info
            let currentSource = null;
            let totalSources = null;
            let progressInfo = null;
            let currentSourceName = null;

            // Extract "Processing source X/Y: Source Name"
            const sourceMatch = message.match(/Processing source (\d+)\/(\d+): (.+)/);
            if (sourceMatch) {
              currentSource = parseInt(sourceMatch[1]);
              totalSources = parseInt(sourceMatch[2]);
              currentSourceName = sourceMatch[3].trim();
              console.log('[EPG REFRESH] Extracted currentSourceName:', currentSourceName, 'from message:', message);
            }

            // Extract progress numbers like "Processed 65000 programs"
            const programMatch = message.match(/Processed (\d+) programs/);
            if (programMatch) {
              progressInfo = `${parseInt(programMatch[1]).toLocaleString()} programs processed`;
            }

            // Extract channel info like "Processed 24189 channels"
            const channelMatch = message.match(/Processed (\d+) channels/);
            if (channelMatch) {
              progressInfo = `${parseInt(channelMatch[1]).toLocaleString()} channels extracted`;
            }

            // Update progress with real-time message from Python script
            console.log('[EPG REFRESH] Updating progress with message:', message);
            setRefreshProgress(prev => {
              console.log('[EPG REFRESH] Previous state:', prev);
              let updatedSources = prev.sources;

              // Check for completed source in message like "✓ Completed EPG Share 01 - All Sources: 15279 channels, 50000 programs"
              const completedMatch = message.match(/✓ Completed (.+?):\s*(\d+) channels?,\s*(\d+) programs?/);
              if (completedMatch) {
                const completedSourceName = completedMatch[1];
                const channelCount = parseInt(completedMatch[2]);
                const programCount = parseInt(completedMatch[3]);

                console.log(`[EPG REFRESH] ✓ Completed match found: "${completedSourceName}" (${channelCount} channels, ${programCount} programs)`);
                console.log('[EPG REFRESH] Current sources:', prev.sources.map(s => s.name));

                // Find and update the completed source
                updatedSources = prev.sources.map(source => {
                  if (source.name === completedSourceName) {
                    console.log(`[EPG REFRESH] ✓ Matched source: ${source.name} → status: complete`);
                    return {
                      ...source,
                      status: 'complete',
                      channels: channelCount,
                      programs: programCount
                    };
                  }
                  return source;
                });
              }

              // Check for failed source in message like "✗ Failed EPG Share 01: error message"
              const failedMatch = message.match(/✗ Failed (.+?):\s*(.+)$/);
              if (failedMatch) {
                const failedSourceName = failedMatch[1];
                const errorMessage = failedMatch[2];

                console.log(`[EPG REFRESH] ✗ Failed match found: "${failedSourceName}" (${errorMessage})`);

                // Find and update the failed source
                updatedSources = prev.sources.map(source => {
                  if (source.name === failedSourceName) {
                    return {
                      ...source,
                      status: 'failed',
                      error: errorMessage
                    };
                  }
                  return source;
                });
              }

              // If we detected a new source being processed, update source statuses
              if (currentSourceName && prev.sources.length > 0) {
                // Build a list of enabled sources in order
                const enabledSources = prev.sources.filter(s => s.enabled !== false);
                const currentSourceIndex = enabledSources.findIndex(s => s.name === currentSourceName);

                updatedSources = updatedSources.map((source) => {
                  // Skip disabled sources
                  if (source.enabled === false) {
                    return source;
                  }

                  // Don't override already completed/failed sources
                  if (source.status === 'complete' || source.status === 'failed') {
                    return source;
                  }

                  // Find this source's position in the enabled list
                  const thisSourceIndex = enabledSources.findIndex(s => s.url === source.url);

                  // Mark sources before current as complete (if not already marked)
                  if (currentSourceIndex !== -1 && thisSourceIndex < currentSourceIndex) {
                    return { ...source, status: 'complete' };
                  }

                  // Mark current source as refreshing
                  if (source.name === currentSourceName) {
                    return { ...source, status: 'refreshing' };
                  }

                  // Mark sources after current as pending
                  if (currentSourceIndex !== -1 && thisSourceIndex > currentSourceIndex) {
                    return { ...source, status: 'pending' };
                  }

                  return source;
                });
              }

              const newState = {
                ...prev,
                status: 'refreshing',
                currentMessage: message,
                currentSource: currentSource || prev.currentSource,
                totalSources: totalSources || prev.totalSources,
                currentSourceName: currentSourceName || prev.currentSourceName,
                progressInfo: progressInfo || prev.progressInfo,
                sources: updatedSources
              };
              console.log('[EPG REFRESH] New state - currentSourceName:', newState.currentSourceName, 'extracted:', currentSourceName, 'prev:', prev.currentSourceName);
              return newState;
            });
          }
          // Note: epg-complete is handled by addEventListener('epg-complete') above
        } catch (err) {
          console.error('[EPG REFRESH] Error parsing SSE event:', err);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[EPG REFRESH] SSE error:', error);
        eventSource.close();
        setEventSourceRef(null);
      };
    });
  };

  const refreshEpgData = async () => {
    setRefreshing(true);
    setShowRefreshModal(true);

    // Include ALL EPG sources (both system and user-added)
    const initialSources = sources
      .map(source => ({
        id: source.id,
        name: source.name || 'Unknown',
        url: source.url,
        enabled: source.enabled,
        verified: source.verified,
        notes: source.notes,
        status: source.enabled === false ? 'disabled' : 'pending',
        channels: null,
        programs: null,
        error: null
      }));

    const enabledCount = initialSources.filter(s => s.enabled !== false).length;

    setRefreshProgress({
      status: 'starting',
      sources: initialSources,
      currentSource: 0,
      totalSources: enabledCount,
      error: null,
      currentMessage: 'Initializing EPG refresh...'
    });

    try {
      console.log('[EPG REFRESH] Triggering EPG data refresh from remote sources');

      const response = await fetch('/api/epg/parse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ force: true })
      });

      if (!response.ok) {
        throw new Error(`Failed to trigger EPG refresh: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      console.log('[EPG REFRESH] Refresh triggered:', result);

      setRefreshProgress(prev => ({
        ...prev,
        status: 'refreshing',
        currentMessage: 'EPG refresh started, polling for updates...'
      }));

      // Start polling for progress updates every 500ms for real-time updates
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch('/api/epg/refresh-status');
          if (!statusResponse.ok) {
            console.error('[EPG REFRESH] Failed to fetch status');
            return;
          }

          const status = await statusResponse.json();
          console.log('[EPG REFRESH] Status update:', status);

          if (!status.isRunning) {
            // Refresh is complete
            clearInterval(pollInterval);
            console.log('[EPG REFRESH] Refresh complete, loading final results...');

            // Load completedSources from backend and update modal to show checkmarks
            if (status.completedSources && status.completedSources.length > 0) {
              // Include ALL sources (both system and user-added)
              const completedSourcesWithStatus = sources.map(source => {
                const completedSource = status.completedSources.find(cs => cs.name === source.name);
                if (completedSource) {
                  return {
                    ...source,
                    status: completedSource.status,
                    channels: completedSource.channelCount,
                    programs: completedSource.programCount,
                    error: completedSource.error || null
                  };
                }
                return {
                  ...source,
                  status: 'pending',
                  channels: null,
                  programs: null,
                  error: null
                };
              });

              setRefreshProgress({
                status: 'complete',
                sources: completedSourcesWithStatus,
                currentSource: status.totalSources,
                totalSources: status.totalSources,
                currentMessage: 'EPG sources refreshed successfully!',
                error: null
              });
            } else {
              setRefreshProgress(prev => ({
                ...prev,
                status: 'complete',
                currentMessage: 'EPG refresh complete!'
              }));
            }

            // Reload sources but keep modal open to show results
            await loadSources();
            setRefreshing(false);
            // Don't close modal - let user see the results and click Close
          } else {
            // Update progress
            setRefreshProgress(prev => ({
              ...prev,
              currentMessage: status.lastMessage || 'Processing EPG data...',
              currentSource: status.currentSource || prev.currentSource,
              totalSources: status.totalSources || prev.totalSources
            }));
          }
        } catch (pollError) {
          console.error('[EPG REFRESH] Error polling status:', pollError);
        }
      }, 500);

      // Store interval ID so we can clear it if component unmounts
      window.epgPollInterval = pollInterval

    } catch (error) {
      console.error('[EPG REFRESH] Error refreshing EPG data:', error);
      setRefreshProgress(prev => ({
        ...prev,
        status: 'complete',
        error: `Failed to refresh EPG data: ${error.message}`
      }));
      setRefreshing(false);
    }
  };

  const closeRefreshModal = () => {
    // Close SSE connection if open
    if (eventSourceRef) {
      eventSourceRef.close();
      setEventSourceRef(null);
    }

    setShowRefreshModal(false);
    setRefreshProgress({
      status: 'starting',
      sources: [],
      currentSource: 0,
      totalSources: 0,
      error: null
    });
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef) {
        eventSourceRef.close();
      }
      // Clear polling interval if active
      if (window.epgPollInterval) {
        clearInterval(window.epgPollInterval);
        window.epgPollInterval = null;
      }
    };
  }, [eventSourceRef]);

  if (!sources.length) {
    return (
      <>
        <EpgRefreshModal
          isOpen={showRefreshModal}
          onClose={closeRefreshModal}
          progress={refreshProgress}
        />
        <section className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-8 shadow-2xl shadow-slate-950/40">
          <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-2xl font-semibold text-slate-100">Current EPG Sources</h3>
              <p className="mt-1 text-sm text-slate-400">
                No EPG sources loaded yet. Add a source to generate guide data for your channels.
              </p>
            </div>
            <button
              onClick={refreshEpgData}
              disabled={refreshing}
              className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold text-white transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-950 ${
                refreshing
                  ? 'cursor-wait bg-slate-700/70'
                  : 'bg-blue-600 hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-900/40'
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={refreshing ? 'animate-spin' : ''}
              >
                <path d="M23 4v6h-6"></path>
                <path d="M1 20v-6h6"></path>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
                <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh EPG Sources'}
            </button>
          </header>
        </section>
      </>
    );
  }

  // Calculate stats
  const activeSources = sources.filter(s => s.enabled !== false);
  const disabledSources = sources.filter(s => s.enabled === false);
  const sourcesWithData = sources.filter(s => {
    const channels = pickNumeric(s, ['channelCount', 'channel_count', 'channels']);
    const programs = pickNumeric(s, ['programCount', 'program_count', 'programs', 'program_total']);
    return channels > 0 || programs > 0;
  });

  const totals = sources.reduce(
    (acc, source) => {
      // Only count enabled sources in totals
      if (source.enabled !== false) {
        acc.channels += pickNumeric(source, ['channelCount', 'channel_count', 'channels']);
        acc.programs += pickNumeric(source, ['programCount', 'program_count', 'programs', 'program_total']);
      }
      return acc;
    },
    { channels: 0, programs: 0 }
  );

  const averageChannels = activeSources.length > 0 ? Math.round(totals.channels / activeSources.length) : 0;
  const averageProgramsPerChannel =
    totals.channels > 0 ? Math.round(totals.programs / totals.channels) : 0;

  // Find most recent update
  const mostRecentUpdate = sources.reduce((latest, source) => {
    const updated = source.last_updated || source.lastUpdated || source.updatedAt || source.updated_at;
    if (!updated) return latest;
    const date = new Date(updated);
    if (!latest || date > latest) return date;
    return latest;
  }, null);

  // Refresh individual source
  const refreshSingleSource = async (sourceUrl) => {
    try {
      setRefreshingSource(sourceUrl);

      const response = await apiClient.post('/epg-refresh/source', {
        url: sourceUrl
      });

      if (response.data.success) {
        console.log(`[EPG] Successfully refreshed source: ${sourceUrl}`);

        // Show success modal
        setStatusModal({
          show: true,
          type: 'success',
          message: 'EPG Source Refreshed Successfully',
          details: {
            channels: response.data.channelCount || 0,
            programs: response.data.programCount || 0
          }
        });

        // Trigger sources list refresh
        window.dispatchEvent(new CustomEvent('epgSourcesUpdated', {
          detail: { timestamp: Date.now() }
        }));

        if (onSourcesUpdated) {
          onSourcesUpdated();
        }
      }
    } catch (error) {
      console.error(`[EPG] Error refreshing source:`, error);

      // Show error modal
      setStatusModal({
        show: true,
        type: 'error',
        message: 'Failed to Refresh EPG Source',
        details: {
          error: error.response?.data?.error || error.message
        }
      });
    } finally {
      setRefreshingSource(null);
    }
  };

  // Delete user EPG source
  const deleteUserSource = async (source) => {
    try {
      setDeletingSource(source.id);

      // Extract the numeric ID from the source ID (e.g., "user_1" -> "1")
      const sourceId = source.id.replace('user_', '');

      const response = await apiClient.delete(`/user-epg-sources/${sourceId}`);

      if (response.data.success) {
        console.log(`[EPG] Successfully deleted source: ${source.name}`);

        // Show success modal
        setStatusModal({
          show: true,
          type: 'success',
          message: 'EPG Source Deleted Successfully',
          details: {
            name: source.name
          }
        });

        // Trigger sources list refresh
        window.dispatchEvent(new CustomEvent('epgSourcesUpdated', {
          detail: { timestamp: Date.now() }
        }));

        if (onSourcesUpdated) {
          onSourcesUpdated();
        }
      }
    } catch (error) {
      console.error(`[EPG] Error deleting source:`, error);

      // Show error modal
      setStatusModal({
        show: true,
        type: 'error',
        message: 'Failed to Delete EPG Source',
        details: {
          error: error.response?.data?.error || error.message
        }
      });
    } finally {
      setDeletingSource(null);
      setConfirmDelete(null);
    }
  };

  return (
    <>
      <EpgRefreshModal
        isOpen={showRefreshModal}
        onClose={closeRefreshModal}
        progress={refreshProgress}
      />

      {/* Status Modal for single source operations */}
      {statusModal.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-slate-900 rounded-lg shadow-xl max-w-md w-full border border-slate-700">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
              <h3 className="text-lg font-semibold text-slate-100">
                {statusModal.message}
              </h3>
              <button
                onClick={() => setStatusModal({ show: false, type: 'success', message: '', details: null })}
                className="text-slate-400 hover:text-slate-200 transition-colors"
                title="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              {statusModal.type === 'success' && (
                <div className="flex items-start gap-3 p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                  <svg className="w-6 h-6 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-emerald-200 font-medium">
                      {statusModal.details?.name ? 'EPG source deleted' : 'Successfully loaded EPG data'}
                    </p>
                    {statusModal.details?.channels !== undefined && (
                      <div className="mt-2 text-sm text-emerald-300">
                        <p>Channels: {statusModal.details.channels.toLocaleString()}</p>
                        <p>Programs: {statusModal.details.programs.toLocaleString()}</p>
                      </div>
                    )}
                    {statusModal.details?.name && (
                      <p className="mt-2 text-sm text-emerald-300">
                        {statusModal.details.name}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {statusModal.type === 'error' && (
                <div className="flex items-start gap-3 p-4 bg-rose-500/10 rounded-lg border border-rose-500/20">
                  <svg className="w-6 h-6 text-rose-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-rose-200 font-medium">An error occurred</p>
                    {statusModal.details && statusModal.details.error && (
                      <p className="mt-2 text-sm text-rose-300 break-words">
                        {statusModal.details.error}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end px-6 py-4 border-t border-slate-700">
              <button
                onClick={() => setStatusModal({ show: false, type: 'success', message: '', details: null })}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Delete */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-slate-900 rounded-lg shadow-xl max-w-md w-full border border-slate-700">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
              <h3 className="text-lg font-semibold text-slate-100">
                Confirm Delete
              </h3>
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-slate-400 hover:text-slate-200 transition-colors"
                title="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              <div className="flex items-start gap-3 p-4 bg-amber-500/10 rounded-lg border border-amber-500/20">
                <svg className="w-6 h-6 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="flex-1">
                  <p className="text-amber-200 font-medium">Are you sure you want to delete this EPG source?</p>
                  <p className="mt-2 text-sm text-slate-300">
                    <strong>{confirmDelete.name}</strong>
                  </p>
                  <p className="mt-2 text-sm text-slate-400">
                    This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-6 py-2 bg-slate-700 text-slate-200 rounded-lg hover:bg-slate-600 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteUserSource(confirmDelete)}
                disabled={deletingSource === confirmDelete.id}
                className="px-6 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-wait"
              >
                {deletingSource === confirmDelete.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-8 shadow-2xl shadow-slate-950/40">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-2xl font-semibold text-slate-100">Current EPG Sources</h3>
            <p className="mt-1 text-sm text-slate-400">
              Monitor source health and refresh whenever your guide data needs an update.
            </p>
          </div>
          <button
            onClick={refreshEpgData}
            disabled={refreshing}
            className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold text-white transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-950 ${
              refreshing
                ? 'cursor-wait bg-slate-700/70'
                : 'bg-blue-600 hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-900/40'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? 'animate-spin' : ''}
            >
              <path d="M23 4v6h-6"></path>
              <path d="M1 20v-6h6"></path>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
              <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh EPG Sources'}
          </button>
        </header>

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-inner shadow-slate-950/30">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Active Sources</p>
            <p className="mt-3 text-3xl font-semibold text-slate-100">
              {formatNumber(activeSources.length)}
              {disabledSources.length > 0 && (
                <span className="ml-1 text-base font-medium text-slate-500">
                  /{formatNumber(sources.length)}
                </span>
              )}
            </p>
            {disabledSources.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">{disabledSources.length} disabled</p>
            )}
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-inner shadow-slate-950/30">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Total Channels</p>
            <p className="mt-3 text-3xl font-semibold text-slate-100">{formatNumber(totals.channels)}</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-inner shadow-slate-950/30">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Total Programs</p>
            <p className="mt-3 text-3xl font-semibold text-slate-100">{formatNumber(totals.programs)}</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-inner shadow-slate-950/30">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Avg Programs/Channel</p>
            <p className="mt-3 text-3xl font-semibold text-slate-100">{formatNumber(averageProgramsPerChannel)}</p>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-6 rounded-2xl border border-slate-800/70 bg-slate-900/60 p-6 text-sm text-slate-300">
          <p className="flex items-center gap-2">
            <span className="text-slate-400">Sources with data:</span>
            <span className="font-semibold text-slate-100">{sourcesWithData.length}</span>
            <span className="text-slate-500">of {activeSources.length}</span>
          </p>
          {mostRecentUpdate && (
            <p className="flex items-center gap-2">
              <span className="text-slate-400">Last refreshed:</span>
              <span className="font-medium text-slate-100">{formatDateTime(mostRecentUpdate)}</span>
            </p>
          )}
          <p className="flex items-center gap-2">
            <span className="text-slate-400">Avg channels/source:</span>
            <span className="font-medium text-slate-100">{formatNumber(averageChannels)}</span>
          </p>
        </div>

        <h4 className="mt-10 text-lg font-semibold text-slate-200">Source Details</h4>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {sources.map((source, index) => {
            const channels = pickNumeric(source, ['channelCount', 'channel_count', 'channels']);
            const programs = pickNumeric(source, ['programCount', 'program_count', 'programs', 'program_total']);
            const lastUpdated = source.last_updated || source.lastUpdated || source.updatedAt || source.updated_at;

            // Determine source status
            let statusKey = 'active';
            let statusLabel = 'Active';

            if (source.enabled === false) {
              statusKey = 'disabled';
              statusLabel = 'Disabled';
            } else if (refreshing) {
              // During refresh, don't show failed/offline status
              // Sources are temporarily at 0 while being processed
              if (channels > 0 || programs > 0) {
                statusKey = 'active';
                statusLabel = 'Active';
              } else {
                statusKey = 'processing';
                statusLabel = 'Processing';
              }
            } else if (channels === 0 && programs === 0) {
              // Check if it was recently updated but still has no data (failed)
              const updated = lastUpdated ? new Date(lastUpdated) : null;
              const now = new Date();
              const hoursSinceUpdate = updated ? (now - updated) / (1000 * 60 * 60) : null;

              if (hoursSinceUpdate !== null && hoursSinceUpdate < 24) {
                statusKey = 'failed';
                statusLabel = 'Failed';
              } else {
                statusKey = 'offline';
                statusLabel = 'Offline';
              }
            } else if (source.verified === false) {
              statusKey = 'unverified';
              statusLabel = 'Unverified';
            }

            return (
              <article
                key={source.id || source.url || index}
                className={`rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-slate-950/20 transition-colors hover:border-slate-700 hover:bg-slate-900 ${
                  statusKey === 'disabled' ? 'opacity-60' : ''
                }`}
              >
                <header className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-100">
                      {source.name || source.title || 'Unnamed Source'}
                    </p>
                    {source.url && (
                      <p className="mt-1 break-words text-xs font-mono text-slate-500">
                        {source.url}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => refreshSingleSource(source.url)}
                      disabled={refreshing || refreshingSource === source.url}
                      className={`rounded-lg p-1.5 transition-colors ${
                        refreshingSource === source.url
                          ? 'cursor-wait text-blue-400'
                          : refreshing
                          ? 'cursor-not-allowed text-slate-600'
                          : 'text-slate-400 hover:bg-slate-800 hover:text-blue-400'
                      }`}
                      title="Refresh this source"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={refreshingSource === source.url ? 'animate-spin' : ''}
                      >
                        <path d="M23 4v6h-6"></path>
                        <path d="M1 20v-6h6"></path>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
                        <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                      </svg>
                    </button>
                    {source.isUserSource && (
                      <button
                        onClick={() => setConfirmDelete(source)}
                        disabled={refreshing || deletingSource === source.id}
                        className={`rounded-lg p-1.5 transition-colors ${
                          deletingSource === source.id
                            ? 'cursor-wait text-rose-400'
                            : refreshing
                            ? 'cursor-not-allowed text-slate-600'
                            : 'text-slate-400 hover:bg-slate-800 hover:text-rose-400'
                        }`}
                        title="Delete this source"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18"></path>
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                          <line x1="10" y1="11" x2="10" y2="17"></line>
                          <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                      </button>
                    )}
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide ${
                        statusStyles[statusKey] || statusStyles.active
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </div>
                </header>
                {source.notes && statusKey !== 'active' && (
                  <p className="mb-3 text-xs italic text-slate-500">{source.notes}</p>
                )}
                <dl className="flex items-center justify-between text-xs text-slate-400">
                  <div>
                    <dt className="font-medium text-slate-500">Channels</dt>
                    <dd className="text-slate-200">{formatNumber(channels)}</dd>
                  </div>
                  <div className="text-right">
                    <dt className="font-medium text-slate-500">Programs</dt>
                    <dd className="text-slate-200">{formatNumber(programs)}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-slate-500">
                  Last updated: <span className="text-slate-300">{formatDateTime(lastUpdated)}</span>
                </p>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
};

export default EpgSourcesSummary;
