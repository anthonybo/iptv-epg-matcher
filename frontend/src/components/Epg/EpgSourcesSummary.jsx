import React, { useState, useEffect } from 'react';
import '../../styles.css';
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
        <div className="epg-summary">
          <h3>Current EPG Sources</h3>
          <div className="status-message">
            No EPG sources loaded yet. Use the controls below to add one or load defaults from your provider.
          </div>
        </div>
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
      <div className="epg-summary">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ margin: 0 }}>Current EPG Sources</h3>
          <button
            onClick={refreshEpgData}
            disabled={refreshing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-wait text-white rounded-lg font-medium transition-colors flex items-center gap-2"
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
            {refreshing ? 'Refreshing...' : 'Refresh EPG Sources'}
          </button>
        </div>

        <div className="summary-stats">
          <div className="stat-item">
            <div className="stat-value">
              {formatNumber(activeSources.length)}
              {disabledSources.length > 0 && (
                <span style={{ fontSize: '14px', color: '#6b7280', fontWeight: 'normal' }}>
                  /{formatNumber(sources.length)}
                </span>
              )}
            </div>
            <div className="stat-label">
              Active Sources
              {disabledSources.length > 0 && (
                <span style={{ fontSize: '11px', color: '#9ca3af', display: 'block', marginTop: '2px' }}>
                  ({disabledSources.length} disabled)
                </span>
              )}
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{formatNumber(totals.channels)}</div>
            <div className="stat-label">Total Channels</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{formatNumber(totals.programs)}</div>
            <div className="stat-label">Total Programs</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{formatNumber(averageProgramsPerChannel)}</div>
            <div className="stat-label">Avg Programs/Channel</div>
          </div>
        </div>

        <div className="averages">
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <strong>Sources with Data:</strong> {sourcesWithData.length} of {activeSources.length}
            </div>
            {mostRecentUpdate && (
              <div>
                <strong>Last Refreshed:</strong> {formatDateTime(mostRecentUpdate)}
              </div>
            )}
            <div>
              <strong>Avg Channels/Source:</strong> {formatNumber(averageChannels)}
            </div>
          </div>
        </div>

        <h4>Source Details</h4>
        <div className="source-list">
          {sources.map((source, index) => {
            const channels = pickNumeric(source, ['channelCount', 'channel_count', 'channels']);
            const programs = pickNumeric(source, ['programCount', 'program_count', 'programs', 'program_total']);
            const lastUpdated = source.last_updated || source.lastUpdated || source.updatedAt || source.updated_at;

            // Determine source status
            let sourceStatus = 'active';
            let statusColor = 'green';
            let statusText = 'Active';

            if (source.enabled === false) {
              sourceStatus = 'disabled';
              statusColor = 'gray';
              statusText = 'Disabled';
            } else if (refreshing) {
              // During refresh, don't show failed/offline status
              // Sources are temporarily at 0 while being processed
              if (channels > 0 || programs > 0) {
                sourceStatus = 'active';
                statusColor = 'green';
                statusText = 'Active';
              } else {
                sourceStatus = 'pending';
                statusColor = 'blue';
                statusText = 'Processing';
              }
            } else if (channels === 0 && programs === 0) {
              // Check if it was recently updated but still has no data (failed)
              const updated = lastUpdated ? new Date(lastUpdated) : null;
              const now = new Date();
              const hoursSinceUpdate = updated ? (now - updated) / (1000 * 60 * 60) : null;

              if (hoursSinceUpdate !== null && hoursSinceUpdate < 24) {
                sourceStatus = 'failed';
                statusColor = 'red';
                statusText = 'Failed';
              } else {
                sourceStatus = 'offline';
                statusColor = 'orange';
                statusText = 'Offline';
              }
            } else if (source.verified === false) {
              sourceStatus = 'unverified';
              statusColor = 'yellow';
              statusText = 'Unverified';
            }

            return (
              <div key={source.id || source.url || index} className="source-item" style={{ opacity: sourceStatus === 'disabled' ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <div className="source-name">
                    {source.name || source.title || 'Unnamed Source'}
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium`}
                    style={{
                      backgroundColor: statusColor === 'green' ? '#dcfce7' :
                                     statusColor === 'red' ? '#fee2e2' :
                                     statusColor === 'orange' ? '#fed7aa' :
                                     statusColor === 'yellow' ? '#fef3c7' :
                                     statusColor === 'blue' ? '#dbeafe' :
                                     '#e5e7eb',
                      color: statusColor === 'green' ? '#166534' :
                             statusColor === 'red' ? '#991b1b' :
                             statusColor === 'orange' ? '#9a3412' :
                             statusColor === 'yellow' ? '#854d0e' :
                             statusColor === 'blue' ? '#1e40af' :
                             '#374151'
                    }}
                  >
                    {statusText}
                  </span>
                </div>
                {source.url && (
                  <div className="source-url">{source.url}</div>
                )}
                {source.notes && sourceStatus !== 'active' && (
                  <div style={{ fontSize: '12px', color: '#6b7280', fontStyle: 'italic', marginTop: '4px' }}>
                    {source.notes}
                  </div>
                )}
                <div className="source-counts">
                  <span>{formatNumber(channels)} channels</span>
                  <span>{formatNumber(programs)} programs</span>
                </div>
                <div className="source-updated">
                  Last updated: {formatDateTime(lastUpdated)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
};

export default EpgSourcesSummary;
