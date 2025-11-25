import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
import IPTVPlayer from './IPTVPlayer';
import VideoQualityBadge from './components/VideoQualityBadge';
import ConfirmModal from './components/ConfirmModal';
import { useAppContext } from './contexts/AppContext';
import { showToast } from './components/Toast';
import {
  getMultiviewStreams,
  removeFromMultiview,
  clearMultiview,
  calculateLayout,
  addToMultiview,
  updateMutedState
} from './utils/multiviewManager';

// Memoized stream cell component to prevent unnecessary re-renders
const StreamCell = memo(({
  stream,
  streamKey,
  sessionId,
  isTheatreMode,
  isMuted,
  quality,
  isFindingAlternative,
  onToggleMute,
  onRefresh,
  onFindAlternative,
  onBlacklist,
  onRemove,
  onQualityDetected
}) => {
  return (
    <div
      className={`relative overflow-hidden ${
        isTheatreMode
          ? 'bg-black'
          : 'rounded-xl border border-slate-800/70 bg-slate-900/70 shadow-2xl shadow-slate-950/40'
      }`}
    >
      {/* Stream Header */}
      {!isTheatreMode && (
        <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-slate-900/95 via-slate-900/80 to-transparent p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {stream.logo && (
                <img
                  src={stream.logo}
                  alt=""
                  className="w-5 h-5 rounded object-contain flex-shrink-0"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              )}
              <span className="text-xs font-medium text-slate-200 truncate">
                {stream.name}
              </span>
              {quality && (
                <VideoQualityBadge quality={quality} size="xs" />
              )}
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {/* Mute Button */}
              <button
                onClick={onToggleMute}
                className="p-0.5 rounded hover:bg-slate-700/50 text-slate-400 hover:text-slate-200 transition-colors"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                )}
              </button>
              {/* Refresh Button */}
              <button
                onClick={onRefresh}
                className="p-0.5 rounded hover:bg-blue-500/20 text-slate-400 hover:text-blue-400 transition-colors"
                title="Refresh stream"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              {/* Find Alternative Button */}
              <button
                onClick={onFindAlternative}
                disabled={isFindingAlternative}
                className={`p-0.5 rounded transition-colors ${
                  isFindingAlternative
                    ? 'text-cyan-400 animate-pulse'
                    : 'hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-400'
                }`}
                title="Find another stream (if blacked out)"
              >
                {isFindingAlternative ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                )}
              </button>
              {/* Blacklist Button */}
              <button
                onClick={onBlacklist}
                className="p-0.5 rounded hover:bg-yellow-500/20 text-slate-400 hover:text-yellow-400 transition-colors"
                title="Blacklist this channel"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </button>
              {/* Remove Button */}
              <button
                onClick={onRemove}
                className="p-0.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors"
                title="Remove from multiview"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Video Player */}
      <div className="h-full w-full">
        <IPTVPlayer
          sessionId={sessionId}
          selectedChannel={stream}
          playbackMethod="mpegts-player"
          matchedChannels={{}}
          theatreMode={true}
          muted={isMuted}
          onQualityDetected={onQualityDetected}
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if these specific props change
  return (
    prevProps.streamKey === nextProps.streamKey &&
    prevProps.stream._refreshKey === nextProps.stream._refreshKey &&
    prevProps.isTheatreMode === nextProps.isTheatreMode &&
    prevProps.isMuted === nextProps.isMuted &&
    prevProps.quality?.resolution === nextProps.quality?.resolution &&
    prevProps.isFindingAlternative === nextProps.isFindingAlternative
  );
});

/**
 * MultiViewPage - Display multiple streams in an auto-layout grid
 * Streams persist in localStorage and can be added from any player
 */
const MultiViewPage = ({ sessionId }) => {
  const { isTheatreMode, setIsTheatreMode } = useAppContext();
  const [streams, setStreams] = useState([]);
  const [layout, setLayout] = useState({ columns: 1, rows: 1 });
  const [streamQualities, setStreamQualities] = useState({});
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // Initialize all streams as muted by default in multi-view to prevent audio chaos
  // The actual muted state will be populated when streams load
  const [mutedStreams, setMutedStreams] = useState(new Set());

  // Random stream state
  const [showSportDropdown, setShowSportDropdown] = useState(false);
  const [liveSports, setLiveSports] = useState([]);
  const [loadingSports, setLoadingSports] = useState(false);
  const [searchingStream, setSearchingStream] = useState(false);
  const [searchAbortController, setSearchAbortController] = useState(null);

  // Blacklist state
  const [blacklistedChannels, setBlacklistedChannels] = useState([]);
  const [showBlacklistModal, setShowBlacklistModal] = useState(false);
  const [loadingBlacklist, setLoadingBlacklist] = useState(true);
  const [loadingStreams, setLoadingStreams] = useState(true);

  // Settings state
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [autoFillSettings, setAutoFillSettings] = useState(() => {
    const saved = localStorage.getItem('multiview_autofill_settings');
    const defaults = {
      maxSlots: 4,
      avoidDuplicateSources: true,
      avoidDuplicateEvents: true,
      minQuality: 0  // 0 = any, 480, 720, 1080
    };
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaults, ...parsed };
    }
    return defaults;
  });
  const [autoFillProgress, setAutoFillProgress] = useState(null);

  // Search state
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // Find alternative stream state
  const [findingAlternativeFor, setFindingAlternativeFor] = useState(null); // streamKey of stream being replaced

  // Load blacklist from API on mount
  useEffect(() => {
    loadBlacklist();
  }, []);

  const loadBlacklist = async () => {
    try {
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');
      if (!token) {
        console.error('No auth token found');
        setLoadingBlacklist(false);
        return;
      }

      const response = await fetch('/api/live-events/blacklist', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();
      if (data.success) {
        setBlacklistedChannels(data.blacklist.map(item => item.channel_name));
      }
    } catch (error) {
      console.error('Failed to load blacklist:', error);
    } finally {
      setLoadingBlacklist(false);
    }
  };

  // Load streams from API on mount
  useEffect(() => {
    let ignore = false;

    const loadStreams = async () => {
      try {
        setLoadingStreams(true);
        const loaded = await getMultiviewStreams();
        if (!ignore) {
          // Build muted streams Set from database muted state
          const mutedSet = new Set();
          loaded.forEach(stream => {
            const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
            if (stream.muted !== false) {
              mutedSet.add(streamKey);
            }
          });

          setMutedStreams(mutedSet);

          // Wait for next tick to ensure mutedStreams state is processed
          await new Promise(resolve => setTimeout(resolve, 10));

          if (!ignore) {
            setStreams(loaded);
          }
        }
      } catch (error) {
        if (!ignore) {
          console.error('Failed to load multiview streams:', error);
          showToast('Failed to load streams', 'error');
        }
      } finally {
        if (!ignore) {
          setLoadingStreams(false);
        }
      }
    };

    loadStreams();

    // Listen for custom event when streams are added in same tab
    const handleMultiviewUpdate = async () => {
      try {
        const loaded = await getMultiviewStreams();
        if (!ignore) {
          setStreams(prevStreams => {
            // If database has fewer streams than UI, something was deleted - sync with database
            if (loaded.length < prevStreams.length) {
              // Rebuild muted streams Set from database
              const mutedSet = new Set();
              loaded.forEach(stream => {
                const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
                if (stream.muted !== false) {
                  mutedSet.add(streamKey);
                }
              });
              setMutedStreams(mutedSet);

              return loaded;
            }

            // Otherwise, only add new streams (don't replace existing ones)
            const prevKeys = new Set(prevStreams.map(s => `${s.sourceId}_${s.id}`));
            const newStreams = loaded.filter(s => !prevKeys.has(`${s.sourceId}_${s.id}`));

            if (newStreams.length > 0) {
              // Add muted state for newly added streams from database
              setMutedStreams(prev => {
                const updated = new Set(prev);
                newStreams.forEach(s => {
                  // CRITICAL: Must match the streamKey format used in rendering
                  const streamKey = `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
                  // New streams default to muted (muted !== false)
                  if (s.muted !== false) {
                    updated.add(streamKey);
                  }
                });
                return updated;
              });
              return [...prevStreams, ...newStreams];
            }

            return prevStreams;
          });
        }
      } catch (error) {
        if (!ignore) {
          console.error('Failed to reload multiview streams:', error);
          showToast('Failed to reload streams', 'error');
        }
      }
    };

    window.addEventListener('multiviewUpdate', handleMultiviewUpdate);

    return () => {
      ignore = true;
      window.removeEventListener('multiviewUpdate', handleMultiviewUpdate);
    };
  }, []);

  // Update layout when streams change
  useEffect(() => {
    const newLayout = calculateLayout(streams.length);
    setLayout(newLayout);
  }, [streams.length]);

  const toggleMute = async (streamKey) => {
    // Parse streamKey to get channelId and sourceId
    // streamKey format: "sourceId_channelId" or "sourceId_channelId_refreshKey"
    const parts = streamKey.split('_');

    // Handle both formats: "sourceId_channelId" and "sourceId_channelId_refreshKey"
    let sourceId, channelId;
    if (parts.length >= 2) {
      sourceId = parts[0];
      // Join remaining parts except last if it's a timestamp (refreshKey)
      const lastPart = parts[parts.length - 1];
      const isTimestamp = /^\d{13}$/.test(lastPart);

      if (isTimestamp && parts.length > 2) {
        channelId = parts.slice(1, -1).join('_');
      } else {
        channelId = parts.slice(1).join('_');
      }
    } else {
      console.error('[MultiView] Invalid streamKey format:', streamKey);
      return;
    }

    // Update UI immediately for responsiveness
    const wasMuted = mutedStreams.has(streamKey);
    const newMutedState = !wasMuted;

    setMutedStreams(prev => {
      const newSet = new Set(prev);
      if (wasMuted) {
        newSet.delete(streamKey);
      } else {
        newSet.add(streamKey);
      }
      return newSet;
    });

    // Persist to database
    const success = await updateMutedState(channelId, sourceId, newMutedState);

    if (!success) {
      // Revert on failure
      setMutedStreams(prev => {
        const newSet = new Set(prev);
        if (wasMuted) {
          newSet.add(streamKey);
        } else {
          newSet.delete(streamKey);
        }
        return newSet;
      });
      showToast('Failed to update mute state', 'error');
    }
  };

  const handleRefreshStream = (id, sourceId) => {
    // Force re-render of the stream by adding a refresh timestamp
    setStreams(prevStreams => {
      return prevStreams.map(stream => {
        if (stream.id === id && stream.sourceId === sourceId) {
          // Add a refresh timestamp to force React to remount
          return {
            ...stream,
            _refreshKey: Date.now()
          };
        }
        return stream;
      });
    });

    showToast('Stream refreshed', 'success');
  };

  const handleRemoveStream = async (id, sourceId) => {
    try {
      const success = await removeFromMultiview(id, sourceId);
      if (success) {
        // Update state directly instead of reloading from API
        // This prevents other streams from stopping and restarting
        setStreams(prevStreams => prevStreams.filter(
          stream => !(stream.id === id && stream.sourceId === sourceId)
        ));
        // Also remove quality data for the removed stream
        const streamKey = `${sourceId}_${id}`;
        setStreamQualities(prev => {
          const { [streamKey]: removed, ...rest } = prev;
          return rest;
        });
      } else {
        showToast('Failed to remove stream', 'error');
      }
    } catch (error) {
      console.error('Error removing stream:', error);
      showToast('Failed to remove stream', 'error');
    }
  };

  const handleClearAll = async () => {
    try {
      const success = await clearMultiview();
      if (success) {
        // Trigger reload via multiviewUpdate event
        window.dispatchEvent(new Event('multiviewUpdate'));
        setStreamQualities({});
        showToast('All streams cleared', 'success');
      } else {
        showToast('Failed to clear streams', 'error');
      }
    } catch (error) {
      console.error('Error clearing streams:', error);
      showToast('Failed to clear streams', 'error');
    }
  };

  // Memoize quality detection callback to prevent unnecessary re-renders
  const handleQualityDetected = useCallback((streamId, quality) => {
    setStreamQualities(prev => ({
      ...prev,
      [streamId]: quality
    }));
  }, []);

  // Random stream handlers
  const handleRandomStreamClick = async () => {
    if (showSportDropdown) {
      setShowSportDropdown(false);
      return;
    }

    setShowSportDropdown(true);
    setLoadingSports(true);

    try {
      // Get current event IDs and source IDs to exclude
      const currentEventIds = streams
        .map(s => s.espnEventId)
        .filter(id => id);

      const currentSourceIds = streams
        .map(s => s.sourceId)
        .filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        console.error('[Random Stream] No authentication token found');
        setLiveSports([]);
        setLoadingSports(false);
        return;
      }

      const queryParams = currentEventIds.length > 0
        ? `?excludeEventIds=${currentEventIds.join('&excludeEventIds=')}`
        : '';

      const response = await fetch(`/api/live-events/live-sports-summary${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();

      if (data.success) {
        setLiveSports(data.sports || []);
      } else {
        console.error('[Random Stream] Failed to fetch live sports:', data.error);
        setLiveSports([]);
      }
    } catch (error) {
      console.error('Error fetching live sports:', error);
      setLiveSports([]);
    } finally {
      setLoadingSports(false);
    }
  };

  const handleCancelSearch = () => {
    if (searchAbortController) {
      searchAbortController.abort();
      setSearchAbortController(null);
    }
    setSearchingStream(false);
  };

  const handleBlacklistChannel = async (channelName) => {
    if (blacklistedChannels.includes(channelName)) {
      return;
    }

    try {
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');
      const response = await fetch('/api/live-events/blacklist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ channelName })
      });

      const data = await response.json();
      if (data.success) {
        setBlacklistedChannels(prev => [...prev, channelName]);
      } else {
        console.error('Failed to blacklist channel:', data.error);
      }
    } catch (error) {
      console.error('Failed to blacklist channel:', error);
    }
  };

  const handleRemoveFromBlacklist = async (channelName) => {
    try {
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');
      const response = await fetch(`/api/live-events/blacklist/${encodeURIComponent(channelName)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();
      if (data.success) {
        setBlacklistedChannels(prev => prev.filter(name => name !== channelName));
      } else {
        console.error('Failed to remove from blacklist:', data.error);
      }
    } catch (error) {
      console.error('Failed to remove from blacklist:', error);
    }
  };

  const handleRandomAnyChannel = async () => {
    setSearchingStream(true);

    // Create new AbortController for this search
    const abortController = new AbortController();
    setSearchAbortController(abortController);

    try {
      const currentSourceIds = streams
        .map(s => s.sourceId)
        .filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        console.error('[Random Channel] No authentication token found');
        setSearchingStream(false);
        setSearchAbortController(null);
        return;
      }

      const response = await fetch('/api/live-events/random-any-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          excludeSourceIds: currentSourceIds
        }),
        signal: abortController.signal
      });

      const data = await response.json();

      if (data.success && data.channel) {
        // Add the channel to multiview
        const success = await addToMultiview(data.channel);

        if (success) {
          // Trigger reload
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${data.channel.name}" to Multi-View`, 'success');
        } else {
          showToast('Failed to add channel to Multi-View', 'error');
        }
      } else {
        console.error(data.message || 'No working channels found');
        showToast(data.message || 'No working channels found', 'error');
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error finding random channel:', error);
      }
    } finally {
      setSearchingStream(false);
      setSearchAbortController(null);
    }
  };

  const handleRandomSportsChannel = async () => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    try {
      // Get current source IDs to exclude (avoid duplicates)
      const currentSourceIds = streams
        .map(s => s.sourceId)
        .filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        console.error('[Random Sports Channel] No authentication token found');
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        return;
      }

      const response = await fetch('/api/live-events/random-sports-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          excludeSourceIds: currentSourceIds
        })
      });

      const data = await response.json();

      if (data.success && data.channel) {
        // Add to multiview
        const success = await addToMultiview(data.channel);

        if (success) {
          showToast(`Added ${data.channel.name}`, 'success');
          // Trigger update event for this tab
          window.dispatchEvent(new Event('multiviewUpdate'));
        } else {
          showToast('Failed to add channel to multiview', 'error');
        }
      } else {
        showToast(data.error || 'No sports channels found', 'error');
      }
    } catch (error) {
      console.error('[Random Sports Channel] Error:', error);
      showToast('Failed to find random sports channel', 'error');
    } finally {
      setSearchingStream(false);
    }
  };

  const handleSportSelect = async (sportType, leagueName) => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    // Create new AbortController for this search
    const abortController = new AbortController();
    setSearchAbortController(abortController);

    try {
      // Get current event IDs and source IDs to exclude
      const currentEventIds = streams
        .map(s => s.espnEventId)
        .filter(id => id);

      const currentSourceIds = streams
        .map(s => s.sourceId)
        .filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        console.error('[Random Stream] No authentication token found');
        setSearchingStream(false);
        setSearchAbortController(null);
        return;
      }

      const response = await fetch('/api/live-events/random-working-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          sportType,
          leagueName,
          excludeEventIds: currentEventIds,
          excludeSourceIds: currentSourceIds
        }),
        signal: abortController.signal
      });

      const data = await response.json();

      if (data.success && data.channel) {
        // Add the channel to multiview
        const success = await addToMultiview(data.channel);

        if (success) {
          // Trigger reload
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${data.channel.name}" to Multi-View`, 'success');
        } else {
          showToast('Failed to add stream to Multi-View', 'error');
        }
      } else {
        console.error(data.message || 'No working streams found');
        showToast(data.message || 'No working streams found', 'error');
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error finding random stream:', error);
        showToast('Error finding random stream', 'error');
      }
    } finally {
      setSearchingStream(false);
      setSearchAbortController(null);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showSportDropdown && !e.target.closest('.random-stream-dropdown')) {
        setShowSportDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSportDropdown]);

  // Save settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('multiview_autofill_settings', JSON.stringify(autoFillSettings));
  }, [autoFillSettings]);

  // Auto-fill handler - fills multiple slots at once
  const handleAutoFill = async (sportType = null, leagueName = null) => {
    // Calculate how many slots to fill
    const currentStreamCount = streams.length;
    const slotsToFill = Math.max(0, autoFillSettings.maxSlots - currentStreamCount);

    if (slotsToFill === 0) {
      showToast(`Already at max slots (${autoFillSettings.maxSlots})`, 'info');
      return;
    }

    setSearchingStream(true);
    setAutoFillProgress({ found: 0, target: slotsToFill, status: 'Searching...' });
    setShowSportDropdown(false);

    try {
      // Get current event IDs, source IDs, and channel IDs to exclude
      const currentEventIds = autoFillSettings.avoidDuplicateEvents
        ? streams.map(s => s.espnEventId).filter(id => id)
        : [];

      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map(s => s.sourceId).filter(id => id)
        : [];

      const currentChannelIds = streams.map(s => s.id).filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        console.error('[Auto-fill] No authentication token found');
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        setAutoFillProgress(null);
        return;
      }

      const response = await fetch('/api/live-events/auto-fill-streams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          sportType,
          leagueName,
          maxStreams: slotsToFill,
          excludeSourceIds: currentSourceIds,
          excludeEventIds: currentEventIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality
        })
      });

      const data = await response.json();

      if (data.success && data.channels && data.channels.length > 0) {
        setAutoFillProgress({ found: data.channels.length, target: slotsToFill, status: 'Adding streams...' });

        // Add all found channels to multiview
        let addedCount = 0;
        for (const channel of data.channels) {
          const success = await addToMultiview(channel);
          if (success) {
            addedCount++;
            setAutoFillProgress(prev => ({ ...prev, found: addedCount, status: `Added ${addedCount}/${data.channels.length}...` }));
          }
        }

        // Trigger reload
        window.dispatchEvent(new Event('multiviewUpdate'));

        showToast(`Added ${addedCount} stream${addedCount !== 1 ? 's' : ''} to Multi-View`, 'success');
      } else {
        showToast(data.message || 'No working streams found', 'error');
      }
    } catch (error) {
      console.error('[Auto-fill] Error:', error);
      showToast('Failed to auto-fill streams', 'error');
    } finally {
      setSearchingStream(false);
      setAutoFillProgress(null);
    }
  };

  // Search channel handler
  const handleSearchChannel = async (e) => {
    e.preventDefault();

    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      showToast('Enter at least 2 characters to search', 'error');
      return;
    }

    setIsSearching(true);

    try {
      // Get current source IDs and channel IDs to exclude
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map(s => s.sourceId).filter(id => id)
        : [];
      const currentChannelIds = streams.map(s => s.id).filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        showToast('Authentication required', 'error');
        setIsSearching(false);
        return;
      }

      const response = await fetch('/api/live-events/search-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          query: searchQuery.trim(),
          excludeSourceIds: currentSourceIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality
        })
      });

      const data = await response.json();

      if (data.success && data.channel) {
        // Add the channel to multiview
        const success = await addToMultiview(data.channel);

        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${data.channel.name}" to Multi-View`, 'success');
          setSearchQuery('');
          setShowSearchInput(false);
        } else {
          showToast('Failed to add channel to Multi-View', 'error');
        }
      } else {
        showToast(data.message || 'No working channel found', 'error');
      }
    } catch (error) {
      console.error('[Search] Error:', error);
      showToast('Search failed', 'error');
    } finally {
      setIsSearching(false);
    }
  };

  // Find alternative stream handler - replaces current stream with another one
  const handleFindAlternative = async (stream) => {
    const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
    setFindingAlternativeFor(streamKey);

    try {
      // Build list of sources to exclude
      let excludeSourceIds = [];

      // Always exclude the current stream's source (we want a DIFFERENT provider)
      if (stream.sourceId) {
        excludeSourceIds.push(stream.sourceId);
      }

      // If "Avoid Duplicate Sources" is enabled, also exclude sources from other streams in multiview
      if (autoFillSettings.avoidDuplicateSources) {
        const otherSourceIds = streams
          .filter(s => s.id !== stream.id || s.sourceId !== stream.sourceId)
          .map(s => s.sourceId)
          .filter(id => id && !excludeSourceIds.includes(id));
        excludeSourceIds = [...excludeSourceIds, ...otherSourceIds];
      }

      // Only exclude the current channel ID (not other channels - we want similar channels)
      const excludeChannelIds = stream.id ? [stream.id] : [];

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        showToast('Authentication required', 'error');
        setFindingAlternativeFor(null);
        return;
      }

      // Extract a cleaner search term from the channel name
      // Remove common prefixes and suffixes to get the core channel name
      let searchName = stream.name
        .replace(/^[A-Z]{2,}\s*[\|:]\s*/gi, '')  // Remove prefixes like "SLING| ", "USA| ", "NHL: "
        .replace(/^[A-Z]{2,}\s+TEAM\s*[\|:]?\s*/gi, '')  // Remove "NHL TEAM| " style prefixes
        .replace(/\s*(ᴿᴬᵂ|ᴴᴰ|ᶠᴴᴰ|HD|FHD|SD|4K|UHD)\s*/gi, '')  // Remove quality markers
        .replace(/\s*ALTERNATE\s*/gi, '')  // Remove "ALTERNATE"
        .replace(/\s*\(.*?\)\s*/g, '')  // Remove parenthetical content
        .replace(/\s+/g, ' ')  // Normalize spaces
        .trim();

      // If the name is too short after cleaning, use original
      if (searchName.length < 3) {
        searchName = stream.name;
      }

      const response = await fetch('/api/live-events/search-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          query: searchName,
          excludeSourceIds: excludeSourceIds,
          excludeChannelIds: excludeChannelIds,
          minQuality: autoFillSettings.minQuality
        })
      });

      const data = await response.json();

      if (data.success && data.channel) {
        // First remove the old stream
        await removeFromMultiview(stream.id, stream.sourceId);

        // Then add the new channel
        const success = await addToMultiview(data.channel);

        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          const qualityText = data.channel.quality ? ` (${data.channel.quality}p)` : '';
          showToast(`Replaced with "${data.channel.name}"${qualityText}`, 'success');
        } else {
          showToast('Failed to add replacement channel', 'error');
        }
      } else {
        showToast(data.message || 'No alternative channel found', 'error');
      }
    } catch (error) {
      console.error('[Find Alternative] Error:', error);
      showToast('Failed to find alternative', 'error');
    } finally {
      setFindingAlternativeFor(null);
    }
  };


  return (
    <div className="flex flex-col h-screen bg-slate-950">
      {/* Header */}
      {!isTheatreMode && (
        <div className="flex-shrink-0 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm px-4 py-2">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-slate-100">Multi-View</h1>
              <p className="text-xs text-slate-400 truncate">
                {streams.length === 0
                  ? 'Add streams using the + button on any player'
                  : `${streams.length} stream${streams.length !== 1 ? 's' : ''} · ${layout.columns}×${layout.rows} grid`
                }
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Quick Search */}
              <div className="flex items-center gap-2">
                {showSearchInput ? (
                  <form onSubmit={handleSearchChannel} className="flex items-center gap-2">
                    <div className="relative">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search channel..."
                        autoFocus
                        disabled={isSearching}
                        className="w-48 px-3 py-1.5 pl-8 text-xs rounded-lg border border-indigo-600 bg-slate-800/80 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
                      />
                      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </div>
                    <button
                      type="submit"
                      disabled={isSearching || !searchQuery.trim()}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition ${
                        isSearching
                          ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
                          : 'border-indigo-600 bg-indigo-900/40 text-indigo-300 hover:bg-indigo-900/60'
                      }`}
                    >
                      {isSearching ? (
                        <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        'Find'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSearchInput(false);
                        setSearchQuery('');
                      }}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-600 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-slate-300 transition"
                      title="Close search"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </form>
                ) : (
                  <button
                    onClick={() => setShowSearchInput(true)}
                    disabled={searchingStream || isSearching}
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition ${
                      searchingStream || isSearching
                        ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
                        : 'border-indigo-600 bg-indigo-900/20 text-indigo-300 hover:bg-indigo-900/40'
                    }`}
                    title="Search for a channel"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Auto-fill progress indicator */}
              {autoFillProgress && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-700 text-emerald-300 text-xs">
                  <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>{autoFillProgress.status}</span>
                </div>
              )}

              {/* Random Stream Icon Expansion */}
              <div className="flex items-center gap-2 random-stream-dropdown">
                {/* Main Random Button */}
                <button
                  onClick={handleRandomStreamClick}
                  disabled={searchingStream}
                  className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition ${
                    searchingStream
                      ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
                      : showSportDropdown
                      ? 'border-emerald-600 bg-emerald-900/40 text-emerald-300'
                      : 'border-emerald-700 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/40'
                  }`}
                  title="Add Random Live Stream"
                >
                  {searchingStream && !autoFillProgress ? (
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                  )}
                </button>

                {/* Cancel Search Button */}
                {searchingStream && (
                  <button
                    onClick={handleCancelSearch}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-700 bg-red-900/20 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-900/40"
                    title="Cancel Search"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Cancel
                  </button>
                )}

                {/* Expanded Sport Icons */}
                {showSportDropdown && !loadingSports && (
                  <>
                    {/* Auto-fill (Any Sport) Button - Main new feature */}
                    <button
                      onClick={() => handleAutoFill(null, null)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-500 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60 transition text-xs font-semibold"
                      title={`Auto-fill up to ${autoFillSettings.maxSlots} slots with any live sport`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Fill {autoFillSettings.maxSlots - streams.length > 0 ? autoFillSettings.maxSlots - streams.length : 0}
                    </button>

                    {/* Single stream button */}
                    <button
                      onClick={() => handleSportSelect(null, null)}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-emerald-600 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/50 transition"
                      title="Add 1 Random Sport Stream"
                    >
                      <span className="text-xs font-bold">+1</span>
                    </button>

                    {/* Random Sports Channel (General) Icon */}
                    <button
                      onClick={handleRandomSportsChannel}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-orange-600 bg-orange-900/30 text-orange-300 hover:bg-orange-900/50 transition"
                      title="Random Sports Channel (any)"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </button>

                    {/* Divider */}
                    {liveSports.length > 0 && (
                      <div className="w-px h-6 bg-slate-600"></div>
                    )}

                    {/* Sport Icons with auto-fill on click */}
                    {liveSports.map((sport, index) => (
                      <button
                        key={index}
                        onClick={() => handleAutoFill(sport.sport_type, sport.league_name)}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-blue-600 bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 transition font-bold text-xs"
                        title={`Auto-fill ${sport.league_name} (${sport.event_count} live games)`}
                      >
                        {sport.league_name}
                        <span className="text-blue-400/70 font-normal">({sport.event_count})</span>
                      </button>
                    ))}
                  </>
                )}

                {/* Loading Indicator */}
                {showSportDropdown && loadingSports && (
                  <div className="flex items-center px-2">
                    <svg className="animate-spin h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  </div>
                )}
              </div>

              {/* Settings Button */}
              <button
                onClick={() => setShowSettingsModal(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700/50 hover:border-slate-500"
                title="Multi-View Settings"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-slate-400">{autoFillSettings.maxSlots}</span>
              </button>

              {/* Blacklist Button */}
              <button
                onClick={() => setShowBlacklistModal(true)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                  blacklistedChannels.length > 0
                    ? 'border-yellow-700 bg-yellow-900/20 text-yellow-300 hover:bg-yellow-900/40'
                    : 'border-slate-700 bg-slate-900/20 text-slate-400 hover:bg-slate-900/40'
                }`}
                title="Manage Blacklisted Channels"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                Blacklist {blacklistedChannels.length > 0 && `(${blacklistedChannels.length})`}
              </button>

              {streams.length > 0 && (
                <>
                  <button
                    onClick={() => setIsTheatreMode(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-purple-700 bg-purple-900/20 px-3 py-1.5 text-xs font-semibold text-purple-300 transition hover:bg-purple-900/40"
                    title="Theatre Mode"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                    </svg>
                    Theatre
                  </button>
                  <button
                    onClick={() => setShowClearConfirm(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-700 bg-red-900/20 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-900/40"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Clear
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Exit Theatre Mode Button */}
      {isTheatreMode && (
        <button
          onClick={() => setIsTheatreMode(false)}
          className="fixed top-4 right-4 z-50 flex items-center justify-center w-10 h-10 rounded-lg border border-slate-700 bg-slate-900/90 backdrop-blur-sm text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 shadow-2xl"
          title="Exit Theatre Mode"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Grid Container */}
      <div className={`flex-1 overflow-auto ${isTheatreMode ? 'p-0' : 'p-4'}`}>
        {loadingStreams ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mb-4 inline-flex h-24 w-24 items-center justify-center">
                <svg className="animate-spin h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-400">Loading streams...</h3>
            </div>
          </div>
        ) : streams.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mb-4 inline-flex h-24 w-24 items-center justify-center rounded-full bg-slate-800/50">
                <svg className="h-12 w-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h.01M15 10h.01M9.5 15.5c1.5 1 3.5 1 5 0" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-slate-300 mb-2">No Streams Yet</h3>
              <p className="text-slate-500 max-w-md mx-auto">
                Add streams to multiview by clicking the <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-sm font-mono">+</span> button on any player.
              </p>
              <p className="text-slate-600 text-sm mt-2">
                Your streams will persist even after leaving this page.
              </p>
            </div>
          </div>
        ) : (
          <div
            className={`grid h-full ${isTheatreMode ? 'gap-0' : 'gap-3'}`}
            style={{
              gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
              gridTemplateRows: `repeat(${layout.rows}, 1fr)`
            }}
          >
            {streams.map((stream) => {
              const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
              return (
                <StreamCell
                  key={streamKey}
                  stream={stream}
                  streamKey={streamKey}
                  sessionId={sessionId}
                  isTheatreMode={isTheatreMode}
                  isMuted={mutedStreams.has(streamKey)}
                  quality={streamQualities[streamKey]}
                  isFindingAlternative={findingAlternativeFor === streamKey}
                  onToggleMute={() => toggleMute(streamKey)}
                  onRefresh={() => handleRefreshStream(stream.id, stream.sourceId)}
                  onFindAlternative={() => handleFindAlternative(stream)}
                  onBlacklist={() => handleBlacklistChannel(stream.name)}
                  onRemove={() => handleRemoveStream(stream.id, stream.sourceId)}
                  onQualityDetected={(quality) => handleQualityDetected(streamKey, quality)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Clear All Confirmation Modal */}
      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleClearAll}
        title="Clear All Streams"
        message={`Are you sure you want to remove all ${streams.length} stream${streams.length !== 1 ? 's' : ''} from Multi-View?`}
        confirmText="Clear All"
        cancelText="Cancel"
        variant="danger"
      />

      {/* Blacklist Management Modal */}
      {showBlacklistModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-700">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-slate-100">Blacklisted Channels</h2>
                <button
                  onClick={() => setShowBlacklistModal(false)}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                These channels will be excluded from random stream searches
              </p>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {blacklistedChannels.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="w-16 h-16 mx-auto text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                  <p className="text-slate-400">No blacklisted channels</p>
                  <p className="text-sm text-slate-500 mt-1">
                    Click the ban icon on a stream to blacklist it
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {blacklistedChannels.map((channelName, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700 hover:border-slate-600 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <svg className="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                        <span className="text-sm text-slate-200 truncate">{channelName}</span>
                      </div>
                      <button
                        onClick={() => handleRemoveFromBlacklist(channelName)}
                        className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-700 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/40 transition-colors"
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-700 bg-slate-900/50">
              <button
                onClick={() => setShowBlacklistModal(false)}
                className="w-full px-4 py-2 text-sm font-semibold rounded-lg border border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl max-w-md w-full overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-700">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-slate-100">Multi-View Settings</h2>
                <button
                  onClick={() => setShowSettingsModal(false)}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                Configure auto-fill behavior for quick stream population
              </p>
            </div>

            {/* Content */}
            <div className="p-6 space-y-6">
              {/* Max Slots Setting */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Max Auto-Fill Slots
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="9"
                    value={autoFillSettings.maxSlots}
                    onChange={(e) => setAutoFillSettings(prev => ({ ...prev, maxSlots: parseInt(e.target.value) }))}
                    className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  />
                  <span className="w-8 text-center text-lg font-bold text-emerald-400">
                    {autoFillSettings.maxSlots}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  When you click a sport, auto-fill will add up to {autoFillSettings.maxSlots} stream{autoFillSettings.maxSlots !== 1 ? 's' : ''} total
                </p>
              </div>

              {/* Quick Presets */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Quick Presets
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[2, 4, 6, 9].map((num) => (
                    <button
                      key={num}
                      onClick={() => setAutoFillSettings(prev => ({ ...prev, maxSlots: num }))}
                      className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                        autoFillSettings.maxSlots === num
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
                      }`}
                    >
                      {num} slots
                    </button>
                  ))}
                </div>
              </div>

              {/* Avoid Duplicate Sources */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-slate-300">
                    Avoid Duplicate Sources
                  </label>
                  <p className="text-xs text-slate-500">
                    Use different IPTV sources for each stream
                  </p>
                </div>
                <button
                  onClick={() => setAutoFillSettings(prev => ({ ...prev, avoidDuplicateSources: !prev.avoidDuplicateSources }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    autoFillSettings.avoidDuplicateSources ? 'bg-emerald-600' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoFillSettings.avoidDuplicateSources ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Avoid Duplicate Events */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-slate-300">
                    Avoid Duplicate Events
                  </label>
                  <p className="text-xs text-slate-500">
                    Don't add the same game/event twice
                  </p>
                </div>
                <button
                  onClick={() => setAutoFillSettings(prev => ({ ...prev, avoidDuplicateEvents: !prev.avoidDuplicateEvents }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    autoFillSettings.avoidDuplicateEvents ? 'bg-emerald-600' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoFillSettings.avoidDuplicateEvents ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Minimum Quality Setting */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Minimum Stream Quality
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { value: 0, label: 'Any' },
                    { value: 480, label: '480p' },
                    { value: 720, label: '720p' },
                    { value: 1080, label: '1080p' }
                  ].map((quality) => (
                    <button
                      key={quality.value}
                      onClick={() => setAutoFillSettings(prev => ({ ...prev, minQuality: quality.value }))}
                      className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                        autoFillSettings.minQuality === quality.value
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
                      }`}
                    >
                      {quality.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {autoFillSettings.minQuality === 0
                    ? 'Accept any stream quality'
                    : `Only accept streams ${autoFillSettings.minQuality}p or higher`
                  }
                </p>
              </div>

              {/* Current Status */}
              <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>
                    Currently: {streams.length} stream{streams.length !== 1 ? 's' : ''} active
                    {streams.length < autoFillSettings.maxSlots && (
                      <span className="text-emerald-400 ml-1">
                        ({autoFillSettings.maxSlots - streams.length} slot{autoFillSettings.maxSlots - streams.length !== 1 ? 's' : ''} available)
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-700 bg-slate-900/50">
              <button
                onClick={() => setShowSettingsModal(false)}
                className="w-full px-4 py-2 text-sm font-semibold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MultiViewPage;
