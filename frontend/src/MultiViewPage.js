import React, { useState, useEffect, useCallback, useRef } from 'react';
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

// Import extracted components
import {
  LAYOUT_MODES,
  MultiViewHeader,
  MultiViewGrid,
  SettingsModal,
  BlacklistModal
} from './components/MultiView';

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
      minQuality: 0
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
  const [findingAlternativeFor, setFindingAlternativeFor] = useState(null);

  // Layout mode state
  const [layoutMode, setLayoutMode] = useState(() => {
    const saved = localStorage.getItem('multiview_layout_mode');
    return saved || 'grid';
  });
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const layoutButtonRef = useRef(null);
  const [streamOrder, setStreamOrder] = useState({});

  // Load blacklist from API on mount
  useEffect(() => {
    loadBlacklist();
  }, []);

  const loadBlacklist = async () => {
    try {
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');
      if (!token) {
        setLoadingBlacklist(false);
        return;
      }

      const response = await fetch('/api/live-events/blacklist', {
        headers: { 'Authorization': `Bearer ${token}` }
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
          const mutedSet = new Set();
          loaded.forEach(stream => {
            const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
            if (stream.muted !== false) {
              mutedSet.add(streamKey);
            }
          });

          setMutedStreams(mutedSet);
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

    const handleMultiviewUpdate = async () => {
      try {
        const loaded = await getMultiviewStreams();
        if (!ignore) {
          setStreams(prevStreams => {
            if (loaded.length < prevStreams.length) {
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

            const prevKeys = new Set(prevStreams.map(s => `${s.sourceId}_${s.id}`));
            const newStreams = loaded.filter(s => !prevKeys.has(`${s.sourceId}_${s.id}`));

            if (newStreams.length > 0) {
              setMutedStreams(prev => {
                const updated = new Set(prev);
                newStreams.forEach(s => {
                  const streamKey = `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
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

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('multiview_autofill_settings', JSON.stringify(autoFillSettings));
  }, [autoFillSettings]);

  // Save layout mode to localStorage
  useEffect(() => {
    localStorage.setItem('multiview_layout_mode', layoutMode);
  }, [layoutMode]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showSportDropdown && !e.target.closest('.random-stream-dropdown')) {
        setShowSportDropdown(false);
      }
      if (showLayoutMenu &&
          !e.target.closest('.layout-menu-dropdown') &&
          !e.target.closest('.layout-menu-portal')) {
        setShowLayoutMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSportDropdown, showLayoutMenu]);

  // Stream management handlers
  const toggleMute = async (streamKey) => {
    const parts = streamKey.split('_');
    let sourceId, channelId;
    if (parts.length >= 2) {
      sourceId = parts[0];
      const lastPart = parts[parts.length - 1];
      const isTimestamp = /^\d{13}$/.test(lastPart);
      if (isTimestamp && parts.length > 2) {
        channelId = parts.slice(1, -1).join('_');
      } else {
        channelId = parts.slice(1).join('_');
      }
    } else {
      return;
    }

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

    const success = await updateMutedState(channelId, sourceId, newMutedState);
    if (!success) {
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
    setStreams(prevStreams => {
      return prevStreams.map(stream => {
        if (stream.id === id && stream.sourceId === sourceId) {
          return { ...stream, _refreshKey: Date.now() };
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
        setStreams(prevStreams => prevStreams.filter(
          stream => !(stream.id === id && stream.sourceId === sourceId)
        ));
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

  const handleQualityDetected = useCallback((streamId, quality) => {
    setStreamQualities(prev => ({ ...prev, [streamId]: quality }));
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
      const currentEventIds = streams.map(s => s.espnEventId).filter(id => id);
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        setLiveSports([]);
        setLoadingSports(false);
        return;
      }

      const queryParams = currentEventIds.length > 0
        ? `?excludeEventIds=${currentEventIds.join('&excludeEventIds=')}`
        : '';

      const response = await fetch(`/api/live-events/live-sports-summary${queryParams}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setLiveSports(data.sports || []);
      } else {
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
    if (blacklistedChannels.includes(channelName)) return;

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
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setBlacklistedChannels(prev => prev.filter(name => name !== channelName));
      }
    } catch (error) {
      console.error('Failed to remove from blacklist:', error);
    }
  };

  const handleRandomSportsChannel = async () => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    try {
      const currentSourceIds = streams.map(s => s.sourceId).filter(id => id);
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
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
        body: JSON.stringify({ excludeSourceIds: currentSourceIds })
      });

      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          showToast(`Added ${data.channel.name}`, 'success');
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

  const handleRandomAnyChannel = async () => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    try {
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map(s => s.sourceId).filter(id => id)
        : [];
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        return;
      }

      const response = await fetch('/api/live-events/random-any-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          excludeSourceIds: currentSourceIds,
          minQuality: autoFillSettings.minQuality
        })
      });

      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          showToast(`Added ${data.channel.name}`, 'success');
          window.dispatchEvent(new Event('multiviewUpdate'));
        } else {
          showToast('Failed to add channel to multiview', 'error');
        }
      } else {
        showToast(data.error || 'No channels found', 'error');
      }
    } catch (error) {
      console.error('[Random Any Channel] Error:', error);
      showToast('Failed to find random channel', 'error');
    } finally {
      setSearchingStream(false);
    }
  };

  const handleSportSelect = async (sportType, leagueName) => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    const abortController = new AbortController();
    setSearchAbortController(abortController);

    try {
      const currentEventIds = streams.map(s => s.espnEventId).filter(id => id);
      const currentSourceIds = streams.map(s => s.sourceId).filter(id => id);
      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
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
        const success = await addToMultiview(data.channel);
        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${data.channel.name}" to Multi-View`, 'success');
        } else {
          showToast('Failed to add stream to Multi-View', 'error');
        }
      } else {
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

  const handleAutoFill = async (sportType = null, leagueName = null) => {
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
      const currentEventIds = autoFillSettings.avoidDuplicateEvents
        ? streams.map(s => s.espnEventId).filter(id => id)
        : [];
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map(s => s.sourceId).filter(id => id)
        : [];
      const currentChannelIds = streams.map(s => s.id).filter(id => id);

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
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

        let addedCount = 0;
        for (const channel of data.channels) {
          const success = await addToMultiview(channel);
          if (success) {
            addedCount++;
            setAutoFillProgress(prev => ({ ...prev, found: addedCount, status: `Added ${addedCount}/${data.channels.length}...` }));
          }
        }

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

  const handleSearchChannel = async (e) => {
    e.preventDefault();

    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      showToast('Enter at least 2 characters to search', 'error');
      return;
    }

    setIsSearching(true);

    try {
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

  const handleFindAlternative = async (stream) => {
    const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
    setFindingAlternativeFor(streamKey);

    try {
      // Exclude sources already in use in multiview (one source = one stream)
      let excludeSourceIds = [];
      if (stream.sourceId) {
        excludeSourceIds.push(stream.sourceId);
      }

      // Always exclude other sources in multiview - one source per stream
      const otherSourceIds = streams
        .filter(s => s.id !== stream.id || s.sourceId !== stream.sourceId)
        .map(s => s.sourceId)
        .filter(id => id && !excludeSourceIds.includes(id));
      excludeSourceIds = [...excludeSourceIds, ...otherSourceIds];

      const excludeChannelIds = stream.id ? [stream.id] : [];

      const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');

      if (!token) {
        showToast('Authentication required', 'error');
        setFindingAlternativeFor(null);
        return;
      }

      // Use stored search query or event name if available, otherwise extract from channel name
      // Priority: searchQuery > espnEventName > cleaned channel name
      let searchName = stream.searchQuery || stream.espnEventName;
      let searchOffset = stream.searchOffset || 0;

      if (!searchName) {
        // Extract a cleaner search term from the channel name
        // Try to find the actual channel/show name after any prefix
        searchName = stream.name
          // Remove provider prefixes like "Peacock Live | ", "SLING| ", "USA| "
          .replace(/^[^|]+\|\s*/gi, '')
          // Remove prefixes like "NHL TEAM| "
          .replace(/^[A-Z]{2,}\s+TEAM\s*[\|:]?\s*/gi, '')
          // Remove quality markers
          .replace(/\s*(ᴿᴬᵂ|ᴴᴰ|ᶠᴴᴰ|HD|FHD|SD|4K|UHD)\s*/gi, '')
          // Remove "ALTERNATE"
          .replace(/\s*ALTERNATE\s*/gi, '')
          // Remove parenthetical content
          .replace(/\s*\(.*?\)\s*/g, '')
          // Normalize spaces
          .replace(/\s+/g, ' ')
          .trim();

        if (searchName.length < 3) {
          searchName = stream.name;
        }
        // Start from beginning when no stored offset
        searchOffset = 0;
      }

      console.log(`[Find Alternative] Stream data: searchQuery="${stream.searchQuery}", espnEventName="${stream.espnEventName}", name="${stream.name}"`);
      console.log(`[Find Alternative] Searching for "${searchName}" starting at offset ${searchOffset}`);

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
          minQuality: autoFillSettings.minQuality,
          searchOffset: searchOffset
        })
      });

      const data = await response.json();

      if (data.success && data.channel) {
        await removeFromMultiview(stream.id, stream.sourceId);
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

  // Drag and drop handlers
  const handleDragStart = useCallback((event) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      setStreamOrder(currentOrder => {
        const streamKeys = streams.map(s => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`);
        const getOrder = (key) => currentOrder[key] ?? streamKeys.indexOf(key);
        const activeOrder = getOrder(active.id);
        const overOrder = getOrder(over.id);

        const newOrder = {};
        streamKeys.forEach(key => {
          const currentKeyOrder = getOrder(key);
          if (key === active.id) {
            newOrder[key] = overOrder;
          } else if (activeOrder < overOrder) {
            if (currentKeyOrder > activeOrder && currentKeyOrder <= overOrder) {
              newOrder[key] = currentKeyOrder - 1;
            } else {
              newOrder[key] = currentKeyOrder;
            }
          } else {
            if (currentKeyOrder >= overOrder && currentKeyOrder < activeOrder) {
              newOrder[key] = currentKeyOrder + 1;
            } else {
              newOrder[key] = currentKeyOrder;
            }
          }
        });

        return newOrder;
      });
    }
  }, [streams]);

  return (
    <div className="flex flex-col h-screen bg-slate-950">
      {/* Header */}
      {!isTheatreMode && (
        <MultiViewHeader
          streams={streams}
          layout={layout}
          showSearchInput={showSearchInput}
          setShowSearchInput={setShowSearchInput}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          isSearching={isSearching}
          onSearchChannel={handleSearchChannel}
          showSportDropdown={showSportDropdown}
          searchingStream={searchingStream}
          autoFillProgress={autoFillProgress}
          liveSports={liveSports}
          loadingSports={loadingSports}
          onRandomStreamClick={handleRandomStreamClick}
          onCancelSearch={handleCancelSearch}
          onAutoFill={handleAutoFill}
          onSportSelect={handleSportSelect}
          onRandomSportsChannel={handleRandomSportsChannel}
          onRandomAnyChannel={handleRandomAnyChannel}
          autoFillSettings={autoFillSettings}
          onShowSettings={() => setShowSettingsModal(true)}
          layoutMode={layoutMode}
          showLayoutMenu={showLayoutMenu}
          setShowLayoutMenu={setShowLayoutMenu}
          onLayoutChange={setLayoutMode}
          layoutButtonRef={layoutButtonRef}
          blacklistedChannels={blacklistedChannels}
          onShowBlacklist={() => setShowBlacklistModal(true)}
          onTheatreMode={() => setIsTheatreMode(true)}
          onShowClearConfirm={() => setShowClearConfirm(true)}
        />
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
      <div className={`flex-1 ${isTheatreMode ? 'p-0 overflow-hidden' : 'p-4 overflow-auto'}`}>
        <MultiViewGrid
          streams={streams}
          streamOrder={streamOrder}
          sessionId={sessionId}
          isTheatreMode={isTheatreMode}
          layout={layout}
          layoutMode={layoutMode}
          mutedStreams={mutedStreams}
          streamQualities={streamQualities}
          findingAlternativeFor={findingAlternativeFor}
          activeId={activeId}
          loadingStreams={loadingStreams}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onToggleMute={toggleMute}
          onRefresh={handleRefreshStream}
          onFindAlternative={handleFindAlternative}
          onBlacklist={handleBlacklistChannel}
          onRemove={handleRemoveStream}
          onQualityDetected={handleQualityDetected}
        />
      </div>

      {/* Modals */}
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

      <BlacklistModal
        isOpen={showBlacklistModal}
        onClose={() => setShowBlacklistModal(false)}
        blacklistedChannels={blacklistedChannels}
        onRemoveFromBlacklist={handleRemoveFromBlacklist}
      />

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        streams={streams}
        autoFillSettings={autoFillSettings}
        setAutoFillSettings={setAutoFillSettings}
      />
    </div>
  );
};

export default MultiViewPage;
