import React from 'react';
import { useChannels } from './hooks/useChannels';
import CategorySidebar from './CategorySidebar';
import ChannelGrid from './ChannelGrid';
import ChannelCard from './ChannelCard';
import ChannelTable from './ChannelTable';
import PiPPlayer from './PiPPlayer';
import IPTVPlayer from '../../IPTVPlayer';
import VideoQualityBadge from '../VideoQualityBadge';
import { addToMultiview } from '../../utils/multiviewManager';
import { showToast } from '../Toast';

/**
 * ChannelsView - Main view for browsing and filtering channels
 * @param {string} sessionId - Session ID for fetching channel data
 * @param {Function} onChannelSelect - Callback when a channel is clicked
 * @param {object} selectedChannel - Currently selected channel
 * @param {object} matchedChannels - Matched channel data
 * @param {object} sourceFilter - IPTV source to filter by (optional)
 * @param {array} availableSources - List of available IPTV sources
 * @param {Function} onSourceChange - Callback when source selection changes
 */
const ChannelsView = ({ sessionId, onChannelSelect, selectedChannel, matchedChannels = {}, sourceFilter = null, availableSources = [], onSourceChange }) => {
  const [showSourceMenu, setShowSourceMenu] = React.useState(false);
  const [viewMode, setViewMode] = React.useState(() => {
    // Load view preference from localStorage
    return localStorage.getItem('channelsViewMode') || 'table';
  });
  const [pipChannel, setPipChannel] = React.useState(null);
  const sourceMenuRef = React.useRef(null);

  // Auto-test state
  const [autoTesting, setAutoTesting] = React.useState(false);
  const [currentTestIndex, setCurrentTestIndex] = React.useState(0);
  const [showAutoTestPlayer, setShowAutoTestPlayer] = React.useState(false);
  const [autoTestChannel, setAutoTestChannel] = React.useState(null);
  const [foundWorkingChannel, setFoundWorkingChannel] = React.useState(false);
  const [autoTestPhase, setAutoTestPhase] = React.useState('checking'); // 'checking' or 'verifying'
  const [autoTestStatus, setAutoTestStatus] = React.useState(''); // Status message for UI

  // Auto-test refs (to prevent race conditions)
  const autoTestingRef = React.useRef(false);
  const currentTestIndexRef = React.useRef(0);
  const channelsRef = React.useRef([]);
  const isAdvancingRef = React.useRef(false);
  const autoTestTimerRef = React.useRef(null);
  const errorDebounceRef = React.useRef(null);
  const originalConsoleErrorRef = React.useRef(null);
  const originalConsoleLogRef = React.useRef(null);
  const playerErrorListenerRef = React.useRef(null);
  const playerLogListenerRef = React.useRef(null);
  const abortControllerRef = React.useRef(null); // For cancelling HEAD requests

  // Save view mode preference to localStorage
  const handleViewModeChange = (mode) => {
    setViewMode(mode);
    localStorage.setItem('channelsViewMode', mode);
  };

  // Handle PiP preview
  const handlePipPreview = (channel) => {
    setPipChannel(channel);
  };

  const handleClosePip = () => {
    setPipChannel(null);
  };

  // Close dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(event.target)) {
        setShowSourceMenu(false);
      }
    };

    if (showSourceMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSourceMenu]);

  const {
    channels,
    categories,
    selectedCategories,
    searchTerm,
    loading,
    error,
    hasMore,
    setSearchTerm,
    toggleCategory,
    clearCategoryFilters,
    loadMore,
    totalChannels,
    filteredCount
  } = useChannels(sessionId, sourceFilter?.id);

  // Auto-test functions (defined after useChannels so 'channels' is available)
  const cleanupErrorListener = React.useCallback(() => {
    if (playerErrorListenerRef.current && originalConsoleErrorRef.current) {
      console.error = originalConsoleErrorRef.current;
      playerErrorListenerRef.current = null;
    }
    if (playerLogListenerRef.current && originalConsoleLogRef.current) {
      console.log = originalConsoleLogRef.current;
      playerLogListenerRef.current = null;
    }
  }, []);

  // Forward declaration - will be defined below
  const handleNextChannelRef = React.useRef(null);

  const setupErrorListener = React.useCallback(() => {
    cleanupErrorListener();

    // Common error/success detection function
    const checkForErrors = (logString) => {
      // Check if video is successfully playing
      if (logString.includes('[INFO] Video playing')) {
        if (autoTestingRef.current) {
          if (originalConsoleLogRef.current) {
            originalConsoleLogRef.current('[Auto-Test] Working channel found! Stopping auto-test.');
          }
          // Clear timeout since we found a working channel
          if (autoTestTimerRef.current) {
            clearTimeout(autoTestTimerRef.current);
            autoTestTimerRef.current = null;
          }
          // Clear any pending error debounce
          if (errorDebounceRef.current) {
            clearTimeout(errorDebounceRef.current);
            errorDebounceRef.current = null;
          }
          // Stop auto-testing but keep the highlight and player visible
          setAutoTesting(false);
          autoTestingRef.current = false;
          setFoundWorkingChannel(true);
          // Note: We keep showAutoTestPlayer=true and autoTestChannel set
          // so the working channel stays highlighted and visible in PiP
        }
        return;
      }

      // Check for errors
      if (logString.includes('[ERROR] mpegts player error') ||
          logString.includes('[ERROR] Video error') ||
          logString.includes('HttpStatusCodeInvalid') ||
          logString.includes('NetworkError') ||
          logString.includes('Video error') ||
          logString.includes('MediaError') ||
          logString.includes('404') ||
          logString.includes('403') ||
          logString.includes('502') ||
          logString.includes('Bad Gateway')) {

        if (autoTestingRef.current && !isAdvancingRef.current) {
          // In auto-test mode, skip immediately on first error - no retries needed
          // Only advance once (debounce prevents multiple errors from same channel triggering multiple advances)
          if (!errorDebounceRef.current) {
            if (originalConsoleLogRef.current) {
              originalConsoleLogRef.current('[Auto-Test] Stream error detected, moving to next channel immediately...');
            }
            errorDebounceRef.current = setTimeout(() => {
              errorDebounceRef.current = null;
              if (handleNextChannelRef.current) {
                handleNextChannelRef.current();
              }
            }, 500); // Small delay to ensure error is fully processed
          }
        }
      }
    };

    // Intercept console.error
    if (!originalConsoleErrorRef.current) {
      originalConsoleErrorRef.current = console.error;
    }

    playerErrorListenerRef.current = (...args) => {
      originalConsoleErrorRef.current.apply(console, args);
      const errorString = args.join(' ');
      checkForErrors(errorString);
    };

    console.error = playerErrorListenerRef.current;

    // Intercept console.log (for IPTVPlayer errors)
    if (!originalConsoleLogRef.current) {
      originalConsoleLogRef.current = console.log;
    }

    playerLogListenerRef.current = (...args) => {
      originalConsoleLogRef.current.apply(console, args);
      const logString = args.join(' ');
      checkForErrors(logString);
    };

    console.log = playerLogListenerRef.current;
  }, [cleanupErrorListener]);

  /**
   * Check if a stream is reachable using HEAD request (Phase 1)
   * Returns true if stream is reachable, false otherwise
   */
  const checkStreamAvailability = React.useCallback(async (channel) => {
    try {
      // Cancel any previous HEAD request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Create new abort controller for this request
      abortControllerRef.current = new AbortController();

      const token = localStorage.getItem('auth_token');
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      const baseUrl = window.location.hostname === 'localhost'
        ? 'http://localhost:5001'
        : window.location.origin;

      const streamUrl = `${baseUrl}/api/stream/${sessionId}/${channel.id}?source_id=${channel.sourceId}`;

      console.log(`[Auto-Test Phase 1] Checking availability: ${channel.name}`);
      setAutoTestStatus(`Checking: ${channel.name}`);

      const response = await fetch(streamUrl, {
        method: 'HEAD',
        headers,
        signal: abortControllerRef.current.signal,
        timeout: 5000 // 5 second timeout for HEAD requests
      });

      if (response.ok) {
        console.log(`[Auto-Test Phase 1] ✓ Stream is reachable: ${channel.name}`);
        return true;
      } else {
        console.log(`[Auto-Test Phase 1] ✗ Stream unavailable (${response.status}): ${channel.name}`);
        return false;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`[Auto-Test Phase 1] Request aborted for: ${channel.name}`);
        return false;
      }
      console.log(`[Auto-Test Phase 1] ✗ Stream check failed: ${channel.name} - ${error.message}`);
      return false;
    }
  }, [sessionId]);

  const handleNextChannel = React.useCallback(async () => {
    if (isAdvancingRef.current) {
      console.log('[Auto-Test] Already advancing, ignoring duplicate call');
      return;
    }

    isAdvancingRef.current = true;

    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }

    if (errorDebounceRef.current) {
      clearTimeout(errorDebounceRef.current);
      errorDebounceRef.current = null;
    }

    const testChannels = channelsRef.current;
    let currentIndex = currentTestIndexRef.current;

    console.log(`[Auto-Test] Current index: ${currentIndex}, Total channels: ${testChannels.length}`);

    if (currentIndex >= testChannels.length - 1) {
      console.log('[Auto-Test] Stopping - reached end of channels');
      setAutoTesting(false);
      autoTestingRef.current = false;
      isAdvancingRef.current = false;
      setAutoTestStatus('No working streams found');
      return;
    }

    // Resume auto-testing if it was stopped after finding a working channel
    if (!autoTestingRef.current) {
      console.log('[Auto-Test] Resuming auto-test...');
      setAutoTesting(true);
      autoTestingRef.current = true;
      setFoundWorkingChannel(false);
      setupErrorListener();
    }

    // PHASE 1: Check stream availability with HEAD requests
    // Loop through channels until we find one that passes HEAD check
    let nextIndex = currentIndex + 1;
    let channelFound = false;
    let testedCount = 0;
    const maxToCheck = 100; // Safety limit

    setAutoTestPhase('checking');

    while (nextIndex < testChannels.length && !channelFound && testedCount < maxToCheck) {
      const candidateChannel = testChannels[nextIndex];

      console.log(`[Auto-Test] Testing channel ${nextIndex + 1}/${testChannels.length}: ${candidateChannel.name}`);

      const isAvailable = await checkStreamAvailability(candidateChannel);

      if (isAvailable) {
        console.log(`[Auto-Test] Found reachable stream at index ${nextIndex}, moving to Phase 2 (video verification)`);
        channelFound = true;
        break;
      } else {
        console.log(`[Auto-Test] Skipping unavailable stream, checking next...`);
        nextIndex++;
        testedCount++;
      }
    }

    if (!channelFound) {
      console.log('[Auto-Test] No more reachable streams found, stopping');
      setAutoTesting(false);
      autoTestingRef.current = false;
      isAdvancingRef.current = false;
      setAutoTestStatus(`Checked ${testedCount} streams - none available`);
      return;
    }

    // PHASE 2: Verify with video player
    currentTestIndexRef.current = nextIndex;
    setCurrentTestIndex(nextIndex);
    setAutoTestPhase('verifying');

    console.log(`[Auto-Test Phase 2] Loading video for channel ${nextIndex + 1} of ${testChannels.length}`);

    const nextChannel = testChannels[nextIndex];
    setAutoTestChannel({
      id: nextChannel.id,
      sourceId: nextChannel.sourceId,
      name: nextChannel.name,
      logo: nextChannel.logo,
      url: nextChannel.url
    });
    setAutoTestStatus(`Verifying: ${nextChannel.name}`);

    setTimeout(() => {
      isAdvancingRef.current = false;
    }, 500);

    // Set timeout for video verification (15 seconds instead of 60)
    autoTestTimerRef.current = setTimeout(() => {
      console.log('[Auto-Test Phase 2] Video verification timeout (15s), moving to next channel...');
      if (handleNextChannelRef.current) {
        handleNextChannelRef.current();
      }
    }, 15000); // Reduced from 60s since we already know stream is reachable
  }, [setupErrorListener, checkStreamAvailability]);

  // Assign the callback to the ref so setupErrorListener can call it
  React.useEffect(() => {
    handleNextChannelRef.current = handleNextChannel;
  }, [handleNextChannel]);

  const handleStopAutoTest = React.useCallback(() => {
    console.log('[Auto-Test] Stopping auto-test');
    setAutoTesting(false);
    autoTestingRef.current = false;
    setFoundWorkingChannel(false);
    setShowAutoTestPlayer(false);
    setAutoTestStatus('');

    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }

    if (errorDebounceRef.current) {
      clearTimeout(errorDebounceRef.current);
      errorDebounceRef.current = null;
    }

    // Cancel any in-flight HEAD requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    cleanupErrorListener();
  }, [cleanupErrorListener]);

  const handleAutoTest = React.useCallback(async (startingChannel = null) => {
    if (channels.length === 0) return;

    setAutoTesting(true);
    autoTestingRef.current = true;
    setFoundWorkingChannel(false);
    channelsRef.current = channels;
    setShowAutoTestPlayer(true);
    setAutoTestPhase('checking');
    setAutoTestStatus('Starting auto-test...');

    // Find the starting index
    let startIndex = 0;
    if (startingChannel) {
      const foundIndex = channels.findIndex(ch =>
        ch.id === startingChannel.id && ch.sourceId === startingChannel.sourceId
      );
      if (foundIndex !== -1) {
        startIndex = foundIndex;
        console.log(`[Auto-Test] Starting from channel ${startIndex + 1}: ${startingChannel.name}`);
      }
    }

    setCurrentTestIndex(startIndex - 1); // Set to -1 so handleNextChannel starts at startIndex
    currentTestIndexRef.current = startIndex - 1;

    setupErrorListener();

    // Start the two-phase testing process
    handleNextChannel();
  }, [channels, setupErrorListener, handleNextChannel]);

  // Cleanup auto-test on unmount
  React.useEffect(() => {
    return () => {
      if (autoTestTimerRef.current) {
        clearTimeout(autoTestTimerRef.current);
      }
      if (errorDebounceRef.current) {
        clearTimeout(errorDebounceRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      cleanupErrorListener();
    };
  }, [cleanupErrorListener]);

  if (!sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="max-w-md rounded-2xl border border-amber-400/30 bg-amber-500/10 p-6 shadow-xl shadow-amber-900/30">
          <div className="mb-2 flex items-center">
            <svg className="mr-2 h-6 w-6 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3 className="text-lg font-semibold text-amber-200">No Session</h3>
          </div>
          <p className="text-sm text-amber-100/80">Please load channel data first from the configuration page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-5rem)] bg-slate-950/95 text-slate-100">
      {/* Left Sidebar - Categories */}
      <CategorySidebar
        categories={categories}
        selectedCategories={selectedCategories}
        onToggle={toggleCategory}
        onClearAll={clearCategoryFilters}
        loading={loading}
      />

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header with search and stats */}
        <div className="relative z-50 border-b border-slate-800 bg-slate-900/80 px-6 py-4 backdrop-blur">
          {/* Error display */}
          {error && (
            <div className="mb-4 flex items-start rounded-xl border border-red-500/40 bg-red-500/10 p-3">
              <svg className="mt-0.5 mr-2 h-5 w-5 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-red-200">Error loading channels</h4>
                <p className="mt-1 text-sm text-red-100/80">{error}</p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-slate-100">Channels</h2>
                  {availableSources.length > 0 && (
                    <div className="relative" ref={sourceMenuRef}>
                      <button
                        onClick={() => setShowSourceMenu(!showSourceMenu)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/20 px-2.5 py-1 text-xs font-medium text-blue-100 hover:bg-blue-500/30 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                        </svg>
                        {sourceFilter ? (sourceFilter.nickname || sourceFilter.name) : 'All Sources'}
                        <svg className={`w-3.5 h-3.5 transition-transform ${showSourceMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>

                      {/* Source Dropdown Menu */}
                      {showSourceMenu && (
                        <div className="absolute left-0 mt-2 w-64 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl shadow-slate-950/30 z-[9999]">
                          <button
                            onClick={() => {
                              onSourceChange(null);
                              setShowSourceMenu(false);
                            }}
                            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-800 ${
                              !sourceFilter ? 'bg-blue-500/20 text-blue-100' : 'text-slate-300'
                            }`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                            <div>
                              <div className="font-medium">All Sources</div>
                              <div className="text-xs text-slate-500">Show channels from all IPTV sources</div>
                            </div>
                          </button>

                          <div className="border-t border-slate-800">
                            {availableSources.map((source) => (
                              <button
                                key={source.id}
                                onClick={() => {
                                  onSourceChange(source);
                                  setShowSourceMenu(false);
                                }}
                                className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-800 ${
                                  sourceFilter?.id === source.id ? 'bg-blue-500/20 text-blue-100' : 'text-slate-300'
                                }`}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                </svg>
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">{source.nickname || source.name}</div>
                                  {source.url && (
                                    <div className="text-xs text-slate-500 truncate">{source.url}</div>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-slate-400">
                  {loading && filteredCount === 0 ? (
                    'Loading channels...'
                  ) : (
                    <>
                      Showing <span className="font-medium text-slate-100">{filteredCount.toLocaleString()}</span> of{' '}
                      <span className="font-medium text-slate-100">{totalChannels.toLocaleString()}</span> channels
                      {selectedCategories.size > 0 && (
                        <span className="ml-1 text-blue-400">
                          ({selectedCategories.size} {selectedCategories.size === 1 ? 'category' : 'categories'} selected)
                        </span>
                      )}
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* View Toggle, Auto-Find, and Search */}
            <div className="flex items-center gap-3">
              {/* Auto-Find Button */}
              <button
                onClick={handleAutoTest}
                disabled={channels.length === 0 || autoTesting}
                className={`flex items-center justify-center rounded-lg border p-2 transition-colors ${
                  autoTesting
                    ? 'border-purple-600 bg-purple-600 text-white cursor-not-allowed'
                    : 'border-blue-600 bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed'
                }`}
                title={autoTesting ? 'Auto-testing channels...' : 'Auto-find working channel'}
              >
                <svg
                  className={`w-5 h-5 ${autoTesting ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </button>

              {/* View Mode Toggle */}
              <div className="flex items-center rounded-lg border border-slate-800/80 bg-slate-900/70 p-1">
                <button
                  onClick={() => handleViewModeChange('grid')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Grid view"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                  Grid
                </button>
                <button
                  onClick={() => handleViewModeChange('table')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    viewMode === 'table'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Table view"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                  Table
                </button>
              </div>

              {/* Search box */}
              <div className="relative w-80">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <svg className="h-5 w-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <input
                  type="text"
                  placeholder="Search channels..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="block w-full rounded-lg border border-slate-800/80 bg-slate-900/70 py-2 pl-10 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                />
                {searchTerm && (
                  <button
                    onClick={() => setSearchTerm('')}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 transition-colors hover:text-slate-200"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Channel Display Area */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'grid' ? (
            <div className="h-full overflow-auto px-6 py-4">
              <ChannelGrid
                channels={channels}
                loading={loading}
                hasMore={hasMore}
                onLoadMore={loadMore}
                ChannelCard={(props) => {
                  const channelKey = `${props.channel.sourceId}-${props.channel.id}`;
                  const autoTestKey = showAutoTestPlayer && autoTestChannel ? `${autoTestChannel.sourceId}-${autoTestChannel.id}` : null;
                  return (
                    <ChannelCard
                      {...props}
                      onClick={() => onChannelSelect && onChannelSelect(props.channel)}
                      isSelected={selectedChannel?.id === props.channel.id}
                      isMatched={matchedChannels[props.channel.id] || matchedChannels[props.channel.tvgId]}
                      isAutoTesting={autoTestKey === channelKey}
                    />
                  );
                }}
              />
            </div>
          ) : (
            <div className="h-full px-6 py-4">
              <ChannelTable
                channels={channels}
                loading={loading}
                hasMore={hasMore}
                onLoadMore={loadMore}
                onChannelClick={onChannelSelect}
                selectedChannel={selectedChannel}
                matchedChannels={matchedChannels}
                onPreview={handlePipPreview}
                onAutoTest={handleAutoTest}
                autoTestChannelKey={showAutoTestPlayer && autoTestChannel ? `${autoTestChannel.sourceId}-${autoTestChannel.id}` : null}
                isAutoTesting={autoTesting}
              />
            </div>
          )}
        </div>
      </div>

      {/* PiP Player for Preview */}
      {pipChannel && !autoTesting && (
        <PiPPlayer
          channel={pipChannel}
          sessionId={sessionId}
          onClose={handleClosePip}
        />
      )}

      {/* PiP Player for Auto-Test */}
      {showAutoTestPlayer && autoTestChannel && (
        <AutoTestPiPPlayer
          channel={autoTestChannel}
          sessionId={sessionId}
          currentIndex={currentTestIndex}
          totalChannels={channelsRef.current.length}
          onSkip={handleNextChannel}
          onStop={handleStopAutoTest}
          isActive={autoTesting}
          foundWorking={foundWorkingChannel}
        />
      )}
    </div>
  );
};

// Auto-Test PiP Player Component - memoized to prevent unnecessary re-renders
const AutoTestPiPPlayer = React.memo(({ channel, sessionId, currentIndex, totalChannels, onSkip, onStop, isActive, foundWorking = false }) => {
  const [isMinimized, setIsMinimized] = React.useState(false);
  const [videoQuality, setVideoQuality] = React.useState(null);
  const [debouncedChannel, setDebouncedChannel] = React.useState(null);
  const debounceTimerRef = React.useRef(null);

  // Debounce channel changes to prevent rapid stream switching
  React.useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Small delay to let React StrictMode double-mount settle
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedChannel(channel);
    }, 100);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [channel?.id, channel?.sourceId]);

  // Reset quality when channel changes
  React.useEffect(() => {
    setVideoQuality(null);
  }, [debouncedChannel?.id]);

  const handleAddToMultiview = async () => {
    const success = await addToMultiview(channel);

    if (success) {
      window.dispatchEvent(new Event('multiviewUpdate'));
      showToast(`Added "${channel.name}" to Multi-View`, 'success');
    } else {
      showToast('Failed to add to Multi-View', 'error');
    }
  };

  if (!channel || !debouncedChannel) return null;

  return (
    <div
      className={`fixed z-[9999] transition-all duration-300 ${
        isMinimized
          ? 'bottom-4 right-4 w-16 h-16'
          : 'bottom-4 right-4 w-[480px] h-[320px]'
      }`}
      style={{
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
      }}
    >
      <div className="relative w-full h-full rounded-xl overflow-hidden border-2 border-purple-600 bg-slate-950 flex flex-col">
        {/* Header */}
        {!isMinimized && (
          <div className="flex-shrink-0 z-50 bg-slate-950 px-3 py-2 border-b border-purple-600/40">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {channel.logo && (
                  <img
                    src={channel.logo}
                    alt={channel.name}
                    className="w-6 h-6 object-contain flex-shrink-0 rounded"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-slate-200 truncate">
                      {channel.name}
                    </div>
                    <VideoQualityBadge quality={videoQuality} size="sm" />
                  </div>
                  <div className={`text-xs ${isActive ? 'text-purple-400' : foundWorking ? 'text-green-400' : 'text-slate-400'}`}>
                    {isActive ? `Testing ${currentIndex + 1} of ${totalChannels}` : foundWorking ? '✓ Working channel' : 'Reached end'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {/* Add to Multiview button */}
                <button
                  onClick={handleAddToMultiview}
                  className="p-1 rounded hover:bg-purple-500/20 text-slate-400 hover:text-purple-400 transition-colors"
                  title="Add to Multi-View"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                {/* Skip/Next button - always visible */}
                <button
                  onClick={onSkip}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  }`}
                  title={isActive ? "Skip to next channel" : "Continue testing next channel"}
                >
                  {isActive ? 'Skip' : 'Next'}
                </button>
                {/* Stop/Close button */}
                <button
                  onClick={onStop}
                  className="px-2 py-1 rounded text-xs font-medium bg-red-900/50 hover:bg-red-900 text-red-300 transition-colors"
                  title={isActive ? "Stop auto-testing" : "Close player"}
                >
                  {isActive ? 'Stop' : 'Close'}
                </button>
                {/* Minimize button */}
                <button
                  onClick={() => setIsMinimized(!isMinimized)}
                  className="p-1 rounded hover:bg-slate-800/60 text-slate-400 hover:text-slate-200 transition-colors"
                  title="Minimize"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Minimized view */}
        {isMinimized && (
          <button
            onClick={() => setIsMinimized(false)}
            className="w-full h-full flex flex-col items-center justify-center bg-purple-900/20 hover:bg-purple-900/30 transition-colors border-2 border-purple-600 rounded-xl"
            title="Expand auto-test player"
          >
            {channel.logo ? (
              <img
                src={channel.logo}
                alt={channel.name}
                className="w-8 h-8 object-contain mb-1"
              />
            ) : (
              <svg className="w-6 h-6 text-purple-400 mb-1 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className="text-xs text-purple-400">{currentIndex + 1}/{totalChannels}</span>
          </button>
        )}

        {/* Video player */}
        {!isMinimized && (
          <div className="flex-1 bg-black overflow-hidden relative pip-player-container">
            <style>{`
              .pip-player-container video {
                width: 100% !important;
                height: 100% !important;
                object-fit: contain !important;
              }
              .pip-player-container > div {
                width: 100% !important;
                height: 100% !important;
              }
            `}</style>
            <div className="absolute inset-0">
              <IPTVPlayer
                key={`autotest-${debouncedChannel.sourceId}-${debouncedChannel.id}`}
                sessionId={sessionId}
                selectedChannel={debouncedChannel}
                playbackMethod="mpegts-player"
                matchedChannels={{}}
                theatreMode={true}
                onQualityDetected={setVideoQuality}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default ChannelsView;
