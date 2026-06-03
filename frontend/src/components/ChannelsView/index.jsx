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
  // Category drawer — collapsible left panel that wraps the existing
  // CategorySidebar. Default open on wide viewports (≥1280px), closed
  // on narrow ones since the main grid needs more room and selected
  // filters already surface as chips in the filter rail.
  const [categoryDrawerOpen, setCategoryDrawerOpen] = React.useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 1280
  );
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
    categoriesLoading,
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
        ? ''
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
      <div className="min-h-[calc(100vh-5rem)] bg-slate-950 flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-600">
            Channels
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-200">No active session</h2>
            <p className="text-[13px] text-slate-500 leading-relaxed">
              Load an IPTV source from the configuration page to start browsing channels.
            </p>
          </div>
          <div className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Waiting for data
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col min-h-[calc(100vh-5rem)] bg-slate-950 text-slate-100">
      {/* Atmosphere — two faint cyan radial pools bleed in from the top
          corners so the page reads as lit, not flat. Fixed + behind all
          content, non-interactive. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-70"
        style={{
          background:
            'radial-gradient(70rem 32rem at 0% -8%, rgba(34,211,238,0.06), transparent 60%), radial-gradient(60rem 28rem at 100% -6%, rgba(56,189,248,0.05), transparent 55%)',
        }}
      />
      {/* Slim error strip — sits above the hero, doesn't crowd it. */}
      {error && (
        <div className="border-b border-rose-500/30 bg-rose-500/[0.06]">
          <div className="max-w-[1600px] mx-auto px-6 py-2.5 flex items-center gap-2 font-mono text-[11.5px]">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 flex-shrink-0" />
            <span className="uppercase tracking-[0.18em] text-rose-300">Error</span>
            <span className="text-slate-700">·</span>
            <span className="text-rose-100/90 normal-case tracking-normal">{error}</span>
          </div>
        </div>
      )}

      {/* ── HERO STRIP ─────────────────────────────────────────
          Title + loaded/total mono count on the left; primary
          action cluster (Auto-Find + Grid/Table toggle) on the
          right. Wraps gracefully on narrow viewports. */}
      <div className="border-b border-slate-800/70 bg-slate-950/95 px-6 py-5">
        <div className="max-w-[1600px] mx-auto flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3">
              {/* Live signal-equalizer motif — three bars breathing at
                  offset rates. Pure CSS, pauses under reduced-motion. */}
              <span aria-hidden className="flex items-end gap-[3px] h-6 motion-reduce:hidden">
                <span className="w-[3px] rounded-full bg-cyan-400/80 animate-[chBar_1.1s_ease-in-out_infinite] [height:40%]" />
                <span className="w-[3px] rounded-full bg-cyan-400/60 animate-[chBar_1.1s_ease-in-out_infinite_0.18s] [height:90%]" />
                <span className="w-[3px] rounded-full bg-cyan-400/80 animate-[chBar_1.1s_ease-in-out_infinite_0.36s] [height:60%]" />
              </span>
              <h1
                className="text-[28px] font-extrabold text-slate-50 leading-none tracking-[-0.02em]"
                style={{ fontFamily: '"Bricolage Grotesque", system-ui, sans-serif' }}
              >
                Channels
              </h1>
            </div>
            <div className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.22em] tabular-nums text-slate-500">
              {loading && filteredCount === 0 ? (
                <span className="text-cyan-300/80 inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  Loading channels
                </span>
              ) : (
                <>
                  <span className="text-slate-200">{filteredCount.toLocaleString()}</span>
                  <span className="text-slate-700 mx-1.5">/</span>
                  <span>{totalChannels.toLocaleString()}</span>
                  <span className="ml-1.5 normal-case tracking-normal text-slate-600">channels</span>
                  {selectedCategories.size > 0 && (
                    <span className="ml-3 text-cyan-300/80 normal-case tracking-normal">
                      · {selectedCategories.size} {selectedCategories.size === 1 ? 'filter' : 'filters'} active
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Action cluster — Auto-Find + view toggle */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoTest}
              disabled={channels.length === 0 || autoTesting}
              className={`inline-flex items-center gap-2 h-9 px-3.5 rounded-md border font-mono text-[11px] font-bold uppercase tracking-[0.18em] transition ${
                autoTesting
                  ? 'border-cyan-500/50 bg-cyan-500/[0.12] text-cyan-200 cursor-wait shadow-[0_0_18px_-4px_rgba(34,211,238,0.4)]'
                  : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:text-slate-100 hover:border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-slate-300 disabled:hover:border-slate-800'
              }`}
              title={autoTesting ? 'Searching for a working stream…' : 'Test channels in order until one plays successfully'}
            >
              {autoTesting ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  <span>Testing</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.35-4.35" />
                    <polygon points="9 8 14 11 9 14" fill="currentColor" stroke="none" />
                  </svg>
                  <span>Auto-Find</span>
                </>
              )}
            </button>

            <div className="flex items-center h-9 p-0.5 rounded-md border border-slate-800 bg-slate-900/60">
              <button
                onClick={() => handleViewModeChange('grid')}
                className={`flex items-center justify-center w-8 h-7 rounded transition ${
                  viewMode === 'grid'
                    ? 'bg-cyan-500/15 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.25)]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                title="Grid view"
                aria-label="Grid view"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <rect x="4" y="4" width="6" height="6" rx="1" />
                  <rect x="14" y="4" width="6" height="6" rx="1" />
                  <rect x="4" y="14" width="6" height="6" rx="1" />
                  <rect x="14" y="14" width="6" height="6" rx="1" />
                </svg>
              </button>
              <button
                onClick={() => handleViewModeChange('table')}
                className={`flex items-center justify-center w-8 h-7 rounded transition ${
                  viewMode === 'table'
                    ? 'bg-cyan-500/15 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.25)]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                title="Table view"
                aria-label="Table view"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── FILTER RAIL ─────────────────────────────────────────
          Row 1: search + Sources dropdown + Browse-categories
          toggle. Row 2 (conditional): selected category chips with
          a Clear button. Stays slim by default, expands only when
          filters are active. */}
      <div className="border-b border-slate-800/70 bg-slate-950/80 px-6 py-3">
        <div className="max-w-[1600px] mx-auto space-y-2.5">
          {/* Row 1: search + source + browse */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[240px] max-w-lg">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search channels…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-9 pl-9 pr-9 rounded-md border border-slate-800 bg-slate-900/60 text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/40 focus:outline-none focus:shadow-[0_0_0_3px_rgba(34,211,238,0.06)] font-mono text-[12.5px]"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 hover:text-slate-200 transition"
                  title="Clear search"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path d="M6 6l12 12M6 18L18 6" />
                  </svg>
                </button>
              )}
            </div>

            {availableSources.length > 0 && (
              <div className="relative" ref={sourceMenuRef}>
                <button
                  onClick={() => setShowSourceMenu(!showSourceMenu)}
                  className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md border font-mono text-[11px] font-bold uppercase tracking-[0.16em] transition ${
                    sourceFilter
                      ? 'border-cyan-500/40 bg-cyan-500/[0.08] text-cyan-200 hover:bg-cyan-500/15'
                      : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:text-slate-100 hover:border-slate-700'
                  }`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                    <rect x="3" y="6" width="18" height="12" rx="2" />
                    <path d="M7 10h10M7 14h6" />
                  </svg>
                  <span className="text-slate-500 normal-case tracking-normal">Source:</span>
                  <span className="truncate max-w-[140px]">{sourceFilter ? (sourceFilter.nickname || sourceFilter.name) : 'All'}</span>
                  <svg className={`w-3 h-3 transition-transform ${showSourceMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showSourceMenu && (
                  <div className="absolute left-0 mt-2 w-72 rounded-md border border-slate-800 bg-slate-950/95 shadow-2xl shadow-slate-950/60 z-[9999] overflow-hidden backdrop-blur-sm">
                    <div className="px-3 py-2 border-b border-slate-800/80 font-mono text-[9.5px] uppercase tracking-[0.22em] text-slate-600">
                      Filter by source
                    </div>
                    <button
                      onClick={() => { onSourceChange(null); setShowSourceMenu(false); }}
                      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition ${
                        !sourceFilter ? 'bg-cyan-500/[0.10] text-cyan-200' : 'text-slate-300 hover:bg-slate-900/80'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${!sourceFilter ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]' : 'bg-slate-700'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold">All sources</div>
                        <div className="font-mono text-[9.5px] text-slate-600 uppercase tracking-[0.18em] mt-0.5">
                          Combine every provider
                        </div>
                      </div>
                    </button>
                    <div className="border-t border-slate-800/80 max-h-72 overflow-y-auto">
                      {availableSources.map((source) => (
                        <button
                          key={source.id}
                          onClick={() => { onSourceChange(source); setShowSourceMenu(false); }}
                          className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition ${
                            sourceFilter?.id === source.id ? 'bg-cyan-500/[0.10] text-cyan-200' : 'text-slate-300 hover:bg-slate-900/80'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sourceFilter?.id === source.id ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]' : 'bg-slate-700'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[12.5px] font-semibold truncate">{source.nickname || source.name}</div>
                            {source.url && (
                              <div className="font-mono text-[9.5px] text-slate-600 truncate normal-case tracking-normal mt-0.5">{source.url}</div>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => setCategoryDrawerOpen(!categoryDrawerOpen)}
              className={`ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md border font-mono text-[11px] font-bold uppercase tracking-[0.16em] transition ${
                categoryDrawerOpen
                  ? 'border-cyan-500/50 bg-cyan-500/[0.10] text-cyan-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:text-slate-100 hover:border-slate-700'
              }`}
              title={categoryDrawerOpen ? 'Hide categories panel' : 'Browse all categories'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
              <span>{categoryDrawerOpen ? 'Hide' : 'Browse'}</span>
              <span className="text-slate-500 normal-case tracking-normal tabular-nums">
                {categories.length.toLocaleString()}
              </span>
            </button>
          </div>

          {/* Row 2: selected category chips, only rendered when there are filters */}
          {selectedCategories.size > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-slate-600 mr-1">
                Filters
              </span>
              {Array.from(selectedCategories).slice(0, 6).map((cat) => (
                <span
                  key={cat}
                  className="inline-flex items-center h-8 pl-2.5 pr-1 rounded-md border border-cyan-500/40 bg-cyan-500/[0.08] text-cyan-100 text-[11.5px] font-semibold"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 mr-2 shadow-[0_0_6px_rgba(34,211,238,0.6)]" />
                  <span className="truncate max-w-[200px]">{cat}</span>
                  <button
                    onClick={() => toggleCategory(cat)}
                    className="ml-2 w-5 h-5 flex items-center justify-center rounded hover:bg-cyan-500/25 hover:text-cyan-50 transition"
                    title="Remove filter"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path d="M6 6l12 12M6 18L18 6" />
                    </svg>
                  </button>
                </span>
              ))}
              {selectedCategories.size > 6 && (
                <span className="inline-flex items-center h-8 px-2.5 rounded-md border border-slate-700 bg-slate-900/60 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-400 tabular-nums">
                  + {selectedCategories.size - 6} more
                </span>
              )}
              <button
                onClick={clearCategoryFilters}
                className="ml-1 inline-flex items-center h-8 px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 hover:text-rose-300 transition"
                title="Clear all category filters"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── MAIN AREA ───────────────────────────────────────────
          Category drawer (collapsible) + channel display. The
          drawer wraps the existing CategorySidebar at its native
          w-72 width; closing the drawer transitions to w-0 and the
          channel display reflows full-width. */}
      <div className="relative flex-1 flex overflow-hidden">
        <div
          className={`transition-all duration-300 ease-out overflow-hidden flex-shrink-0 ${
            categoryDrawerOpen ? 'w-72 border-r border-slate-800/70' : 'w-0'
          }`}
          aria-hidden={!categoryDrawerOpen}
        >
          <div className="w-72 h-full">
            <CategorySidebar
              categories={categories}
              selectedCategories={selectedCategories}
              onToggle={toggleCategory}
              onClearAll={clearCategoryFilters}
              loading={categoriesLoading}
            />
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
      <div className="relative w-full h-full rounded-xl overflow-hidden border border-cyan-500/40 bg-slate-950 flex flex-col shadow-[0_0_28px_-6px_rgba(34,211,238,0.35)]">
        {/* Header */}
        {!isMinimized && (
          <div className="flex-shrink-0 z-50 bg-slate-950/95 px-3 py-2 border-b border-slate-800/70 backdrop-blur-sm">
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
                  <div className={`font-mono text-[10px] uppercase tracking-[0.16em] tabular-nums inline-flex items-center gap-1.5 ${isActive ? 'text-cyan-300' : foundWorking ? 'text-emerald-300' : 'text-slate-500'}`}>
                    {isActive && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
                    {foundWorking && !isActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                    {isActive ? `Testing ${currentIndex + 1} / ${totalChannels}` : foundWorking ? 'On air' : 'Reached end'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {/* Add to Multiview button */}
                <button
                  onClick={handleAddToMultiview}
                  className="p-1 rounded hover:bg-cyan-500/15 text-slate-400 hover:text-cyan-300 transition-colors"
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
                  className={`px-2.5 py-1 rounded font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition-colors ${
                    isActive
                      ? 'bg-slate-800/80 hover:bg-slate-700 text-slate-200'
                      : 'bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/40'
                  }`}
                  title={isActive ? "Skip to next channel" : "Continue testing next channel"}
                >
                  {isActive ? 'Skip' : 'Next'}
                </button>
                {/* Stop/Close button */}
                <button
                  onClick={onStop}
                  className="px-2.5 py-1 rounded font-mono text-[10px] font-bold uppercase tracking-[0.14em] bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition-colors"
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
            className="w-full h-full flex flex-col items-center justify-center bg-cyan-500/[0.08] hover:bg-cyan-500/15 transition-colors border border-cyan-500/40 rounded-xl"
            title="Expand auto-test player"
          >
            {channel.logo ? (
              <img
                src={channel.logo}
                alt={channel.name}
                className="w-8 h-8 object-contain mb-1"
              />
            ) : (
              <svg className="w-6 h-6 text-cyan-300 mb-1 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className="font-mono text-[10px] tabular-nums text-cyan-300">{currentIndex + 1}/{totalChannels}</span>
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
