import React, { useState, useEffect } from 'react';
import EpgRefreshModal from '../EpgRefreshModal';
import SessionManager from '../../utils/sessionManager';

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
    error: null
  });
  const [eventSourceRef, setEventSourceRef] = useState(null);

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

              let sourceStatus = 'pending';
              if (sourceNum < currentSourceNum) {
                sourceStatus = 'complete';
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
                channels: sourceStatus === 'complete' ? (s.channel_count || s.channelCount) : null,
                programs: sourceStatus === 'complete' ? (s.program_count || s.programCount) : null,
                error: null
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

  const connectToSSE = () => {
    const sessionId = SessionManager.getSessionId();
    const eventSource = new EventSource(`/api/events/${sessionId}`);
    setEventSourceRef(eventSource);

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
            let currentSourceUrl = null;

            // Extract "Processing source X/Y: URL"
            const sourceMatch = message.match(/Processing source (\d+)\/(\d+): (.+)/);
            if (sourceMatch) {
              currentSource = parseInt(sourceMatch[1]);
              totalSources = parseInt(sourceMatch[2]);
              currentSourceUrl = sourceMatch[3].trim();
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
            setRefreshProgress(prev => {
              let updatedSources = prev.sources;

              // If we detected a new source being processed, update source statuses
              if (currentSourceUrl && prev.sources.length > 0) {
                // Build a list of enabled source URLs in order
                const enabledSources = prev.sources.filter(s => s.enabled !== false);
                const currentSourceIndex = enabledSources.findIndex(s => s.url === currentSourceUrl);

                updatedSources = prev.sources.map((source) => {
                  // Skip disabled sources
                  if (source.enabled === false) {
                    return source;
                  }

                  // Find this source's position in the enabled list
                  const thisSourceIndex = enabledSources.findIndex(s => s.url === source.url);

                  // Mark sources before current as complete
                  if (currentSourceIndex !== -1 && thisSourceIndex < currentSourceIndex) {
                    return { ...source, status: 'complete' };
                  }

                  // Mark current source as refreshing
                  if (source.url === currentSourceUrl) {
                    return { ...source, status: 'refreshing' };
                  }

                  // Mark sources after current as pending
                  if (currentSourceIndex !== -1 && thisSourceIndex > currentSourceIndex) {
                    return { ...source, status: 'pending' };
                  }

                  return source;
                });
              }

              return {
                ...prev,
                status: 'refreshing',
                currentMessage: message,
                currentSource: currentSource || prev.currentSource,
                totalSources: totalSources || prev.totalSources,
                progressInfo: progressInfo || prev.progressInfo,
                sources: updatedSources
              };
            });
          } else if (data.type === 'epg-complete') {
            // Refresh is complete
            console.log('[EPG REFRESH] Completion event received');
            eventSource.close();

            // Load final results
            setTimeout(async () => {
              const sourcesResponse = await fetch(`/api/epg/${sessionId}/sources?_t=${Date.now()}`);
              if (sourcesResponse.ok) {
                const sourceData = await sourcesResponse.json();
                if (sourceData.sources) {
                  const updatedSources = sourceData.sources.map(source => ({
                    id: source.id,
                    name: source.name || 'Unknown',
                    url: source.url,
                    status: 'complete',
                    channels: source.channel_count || source.channelCount,
                    programs: source.program_count || source.programCount,
                    error: null
                  }));

                  setRefreshProgress({
                    status: 'complete',
                    sources: updatedSources,
                    currentSource: updatedSources.length,
                    totalSources: updatedSources.length,
                    error: null
                  });

                  setRefreshing(false);

                  if (onSourcesUpdated) {
                    onSourcesUpdated(sourceData.sources);
                  }
                }
              }
            }, 1000);
          }
        } catch (err) {
          console.error('[EPG REFRESH] Error parsing SSE event:', err);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[EPG REFRESH] SSE error:', error);
        eventSource.close();
        setEventSourceRef(null);
      };

      return eventSource;
  };

  const refreshEpgData = async () => {
    setRefreshing(true);
    setShowRefreshModal(true);

    // Initialize progress with current sources as pending
    // Only enabled sources will be processed
    const initialSources = sources.map(source => ({
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
      totalSources: enabledCount, // Only count enabled sources
      error: null
    });

    try {
      console.log('[EPG REFRESH] Triggering EPG data refresh from remote sources');

      // Connect to SSE for real-time progress updates
      connectToSSE();

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
        status: 'refreshing'
      }));

      // SSE will handle all progress updates and completion
      // No polling needed - the epg-complete event will trigger when done

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
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-100">
                      {source.name || source.title || 'Unnamed Source'}
                    </p>
                    {source.url && (
                      <p className="mt-1 break-words text-xs font-mono text-slate-500">
                        {source.url}
                      </p>
                    )}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide ${
                      statusStyles[statusKey] || statusStyles.active
                    }`}
                  >
                    {statusLabel}
                  </span>
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
