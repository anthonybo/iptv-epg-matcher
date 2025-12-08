import React, { useEffect, useRef, useState, memo, useCallback, useMemo } from 'react';
import { addAuthToStreamUrl } from './utils/streamAuth';
import { detectVideoQuality } from './utils/videoQuality';
import { useCast } from './hooks/useCast';
import CastButton from './components/CastButton';
import apiClient from './utils/apiClient';

/**
 * Enhanced IPTVPlayer - Browser-compatible player for IPTV streams
 * With improved UI and toggleable info overlays for channel info and EPG data
 *
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @param {string} props.playbackMethod Which playback method to use
 * @param {Object} props.matchedChannels Object mapping channel IDs to matched EPG IDs
 * @param {Function} props.onQualityDetected Callback when video quality is detected
 * @returns {JSX.Element} IPTVPlayer component
 */
const IPTVPlayer = ({
  sessionId,
  selectedChannel,
  playbackMethod = 'mpegts-player',
  matchedChannels = {},
  theatreMode = false,
  showChannelInfo: externalShowChannelInfo,
  showEpgInfo: externalShowEpgInfo,
  showDebug: externalShowDebug,
  onQualityDetected,
  muted = false,
  useResilientProxy = null, // null = auto (true in theatre mode, false otherwise)
  skipRecovery = false, // When true, skip retry logic (for auto-test mode)
  onStreamPlaying = null, // Callback when stream starts playing successfully
  onStreamError = null // Callback when stream fails (after skipRecovery or exhausted retries)
}) => {
  // Determine if we should use the resilient proxy
  // Auto mode: use resilient proxy in theatre mode (multi-view) by default
  // The resilient proxy handles retry/reconnect at the backend level, eliminating
  // the need for complex frontend recovery logic that can cause network flooding
  const shouldUseResilientProxy = useResilientProxy !== null
    ? useResilientProxy
    : theatreMode; // Default to resilient proxy in multi-view
  // Helper to get channel ID from either 'id' or 'tvgId' field
  // CRITICAL: Use 'id' first (IPTV channel ID like xtream_1111) not 'tvgId' (EPG hint like AnimalPlanet.us)
  const getChannelId = () => {
    return selectedChannel?.id || selectedChannel?.tvgId;
  };

  // Helper to get group title from either 'groupTitle' or 'group.title' field
  const getGroupTitle = () => selectedChannel?.groupTitle || selectedChannel?.group?.title || '';

  // State - use external state in theatre mode, internal state otherwise
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState(null); // Separate state for recovery messages
  const [logs, setLogs] = useState([]);
  const [internalShowDebug, setInternalShowDebug] = useState(false);
  const [internalShowChannelInfo, setInternalShowChannelInfo] = useState(false);
  const [internalShowEpgInfo, setInternalShowEpgInfo] = useState(false);
  const [epgData, setEpgData] = useState(null);
  const [videoQuality, setVideoQuality] = useState(null);

  // Use external state in theatre mode, internal state otherwise
  const showDebug = theatreMode && externalShowDebug !== undefined ? externalShowDebug : internalShowDebug;
  const showChannelInfo = theatreMode && externalShowChannelInfo !== undefined ? externalShowChannelInfo : internalShowChannelInfo;
  const showEpgInfo = theatreMode && externalShowEpgInfo !== undefined ? externalShowEpgInfo : internalShowEpgInfo;

  // Google Cast
  const { isCastAvailable, isCasting, castMedia, stopCasting } = useCast();

  // Refs
  const containerRef = useRef(null);
  const playerInstanceRef = useRef(null);
  const logIdRef = useRef(0);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef(null);
  const stallTimerRef = useRef(null);
  const lastPlayingTimeRef = useRef(0);
  const currentChannelIdRef = useRef(null);
  const healthCheckIntervalRef = useRef(null);
  const lastKnownCurrentTimeRef = useRef(0);
  const videoElementRef = useRef(null);
  const isInitializingRef = useRef(false); // Prevent race conditions from rapid re-renders
  const freshStartCountRef = useRef(0); // Track complete reinitialization attempts
  const lastErrorTimeRef = useRef(0); // Track when last error occurred
  const isRecoveringRef = useRef(false); // Prevent multiple simultaneous recovery attempts
  const recoveryTimeoutRef = useRef(null); // Timeout to detect if recovery attempt failed

  // Global recovery rate limiter (shared across all instances)
  // Uses a queue-based approach to prevent stack overflow in multi-view
  if (typeof window.iptvRecoveryQueue === 'undefined') {
    window.iptvRecoveryQueue = {
      lastRecoveryTime: 0,
      activeRecoveries: 0, // Track concurrent recoveries
      maxConcurrentRecoveries: 2, // Only allow 2 streams to recover at once
      pendingRecoveries: [], // Queue for pending recoveries to prevent stack overflow
      maxPendingRecoveries: 10, // Hard limit to prevent memory issues
      globalRecoveryCount: 0, // Track total recoveries across all streams
      globalRecoveryWindowStart: 0, // When the current window started
      globalPaused: false // Emergency stop if too many global recoveries
    };
  }

  // Check and update global recovery limits (shared across all player instances)
  const checkGlobalRecoveryLimits = () => {
    const queue = window.iptvRecoveryQueue;
    const now = Date.now();
    const GLOBAL_WINDOW_MS = 30000; // 30 second window
    const MAX_GLOBAL_RECOVERIES = 16; // Max 16 recoveries across ALL streams in 30s

    // Reset window if expired
    if (now - queue.globalRecoveryWindowStart > GLOBAL_WINDOW_MS) {
      queue.globalRecoveryCount = 0;
      queue.globalRecoveryWindowStart = now;
      queue.globalPaused = false;
    }

    queue.globalRecoveryCount++;

    // If we've exceeded the global limit, pause all recoveries
    if (queue.globalRecoveryCount > MAX_GLOBAL_RECOVERIES) {
      queue.globalPaused = true;
      log('error', `Global recovery limit exceeded (${queue.globalRecoveryCount} in 30s) - pausing all recoveries`);
      return false; // Don't allow this recovery
    }

    return true; // Allow recovery
  };

  // Track total recovery attempts for this instance to prevent infinite loops
  const totalRecoveryAttemptsRef = useRef(0);
  // Fewer total attempts in theatre mode - with 4 streams, 10 each = 40 total connections max
  const MAX_TOTAL_RECOVERY_ATTEMPTS = theatreMode ? 10 : 20;

  // Track recovery timestamps to detect chronically unstable streams
  // If too many recoveries happen in a short window, stop trying
  const recoveryTimestampsRef = useRef([]); // Array of timestamps when recoveries occurred
  // More aggressive limits in theatre mode to prevent 4 streams from overwhelming the network
  const RECOVERY_WINDOW_MS = theatreMode ? 30000 : 60000; // 30s window in theatre, 60s single
  const MAX_RECOVERIES_IN_WINDOW = theatreMode ? 4 : 6; // Fewer attempts in theatre mode
  const streamUnstableRef = useRef(false); // Flag to mark stream as unstable
  
  // Enhanced logging function - optimized for multi-view performance
  const log = (level, message, data = null) => {
    // CRITICAL: Always log "Video playing" message even in theatre mode
    // This is needed for auto-test functionality to detect working channels
    const isCriticalMessage = message === 'Video playing';

    // In theatre mode (multi-view), skip most logging to prevent performance issues
    // But always emit critical messages that other components depend on
    if (theatreMode && !isCriticalMessage) {
      return;
    }

    // Log critical messages to console in ALL modes (needed for auto-test detection)
    // Log other messages only in development
    if (isCriticalMessage || process.env.NODE_ENV === 'development') {
      console.log(`[${level.toUpperCase()}] ${message}`, data || '');
    }

    // Skip state updates in theatre mode (no debug panel shown)
    if (theatreMode) {
      return;
    }

    const timestamp = new Date().toISOString();
    setLogs(prev => [
      ...prev,
      {
        id: `log_${timestamp}_${logIdRef.current++}`,
        level,
        message,
        data: data ? JSON.stringify(data) : null,
        timestamp
      }
    ].slice(-20));
  };

  // Track video element changes to sync muted state
  const [videoElementKey, setVideoElementKey] = useState(0);

  // Update video element muted state when muted prop changes OR video element changes
  useEffect(() => {
    if (videoElementRef.current) {
      videoElementRef.current.muted = muted;
    }
  }, [muted, videoElementKey]);

  // Initialize component
  useEffect(() => {
    // Always log mount/unmount to console for debugging, even in theatre mode
    console.log(`[IPTVPlayer] MOUNTING: ${selectedChannel?.name} (${selectedChannel?.id})`);
    log('info', 'IPTVPlayer component mounting');

    // Load required scripts
    loadScripts();

    // Overlays are hidden by default - user can toggle them with the icons

    return () => {
      console.log(`[IPTVPlayer] UNMOUNTING: ${selectedChannel?.name} (${selectedChannel?.id})`);
      log('info', 'IPTVPlayer component unmounting');
      cleanupPlayer();
    };
  }, []);

  // Try to load EPG data when channel changes
  // Skip in theatre mode (multi-view) since EPG overlay is not shown
  useEffect(() => {
    if (theatreMode) return; // Skip EPG fetch in multi-view for performance

    const channelId = getChannelId();
    if (sessionId && selectedChannel && channelId) {
      // IMPORTANT: Pass the IPTV channel ID, NOT the EPG ID!
      // The backend expects the IPTV channel ID and will look up the match in PostgreSQL
      fetchEpgData(channelId);
    }
  }, [sessionId, selectedChannel, theatreMode]);

  // Listen for EPG match updates and refresh data immediately
  // Skip in theatre mode (multi-view) for performance
  useEffect(() => {
    if (theatreMode) return; // Skip EPG listener in multi-view

    const handleEpgMatchUpdate = (event) => {
      const { iptvChannelId, epgChannelId } = event.detail || {};
      const currentChannelId = getChannelId();

      log('info', 'Received epgMatchUpdated event', {
        iptvChannelId,
        epgChannelId,
        currentChannelId,
        isCurrentChannel: iptvChannelId === currentChannelId
      });

      // If this match is for the currently displayed channel, refresh EPG data immediately
      // IMPORTANT: The backend endpoint expects the IPTV channel ID, NOT the EPG ID!
      if (iptvChannelId === currentChannelId) {
        log('info', 'Refreshing EPG data for current channel after match using IPTV channel ID');

        // Fetch EPG data by passing the IPTV channel ID
        // The backend will look up the match and return the EPG programs
        if (!sessionId || !iptvChannelId) return;

        apiClient.get(`/epg/${sessionId}?channelId=${encodeURIComponent(iptvChannelId)}`)
          .then(response => {
            log('info', 'EPG data refreshed after match', {
              hasCurrentProgram: !!response.data.currentProgram,
              programCount: response.data.programs?.length || 0
            });
            setEpgData(response.data);
          })
          .catch(error => {
            log('error', 'Failed to refresh EPG data after match', { error: error.message });
          });
      }
    };

    window.addEventListener('epgMatchUpdated', handleEpgMatchUpdate);

    return () => {
      window.removeEventListener('epgMatchUpdated', handleEpgMatchUpdate);
    };
  }, [sessionId, selectedChannel, theatreMode]);
  
  // Fetch EPG data for the current channel using IPTV channel ID
  // IMPORTANT: This function expects the IPTV channel ID (e.g., 'stalker_066baa94_45447'),
  // NOT the EPG channel ID. The backend will look up the match.
  const fetchEpgData = async (iptvChannelId) => {
    if (!sessionId || !iptvChannelId) return;

    try {
      // If iptvChannelId is an object, extract the actual ID with multiple fallbacks
      let channelIdStr;

      if (typeof iptvChannelId === 'object') {
        // Use multiple fallbacks for finding the ID
        channelIdStr = iptvChannelId.id || iptvChannelId.epgId || '';

        // If we still don't have an ID but have an object, use a string representation as last resort
        if (!channelIdStr) {
          try {
            channelIdStr = JSON.stringify(iptvChannelId);
            log('warn', `Had to use JSON representation of iptvChannelId: ${channelIdStr}`);
          } catch (err) {
            log('error', 'Failed to stringify iptvChannelId object', { error: err.message });
            return;
          }
        }
      } else {
        // Convert to string if it's a primitive value
        channelIdStr = String(iptvChannelId);
      }

      if (!channelIdStr) {
        log('error', 'Invalid IPTV channel ID: empty after extraction', { originalId: iptvChannelId });
        return;
      }

      log('info', `Fetching EPG data for IPTV channel ID: ${channelIdStr}`);

      const response = await apiClient.get(`/epg/${sessionId}?channelId=${encodeURIComponent(channelIdStr)}`);

      if (response.data) {
        log('info', 'EPG data received', {
          hasCurrentProgram: !!response.data.currentProgram,
          programCount: response.data.programs?.length || 0,
          sourceKey: response.data.sourceKey || 'unknown'
        });
        setEpgData(response.data);
      } else {
        log('error', 'No EPG data returned');
        setEpgData(null);
      }
    } catch (error) {
      log('error', 'Failed to load EPG data', { error: error.message });
      setEpgData(null);
    }
  };
  
  // Load necessary scripts
  const loadScripts = () => {
    // Load Clappr player
    if (!window.Clappr) {
      const clapprScript = document.createElement('script');
      clapprScript.src = 'https://cdn.jsdelivr.net/npm/clappr@latest/dist/clappr.min.js';
      clapprScript.async = true;
      clapprScript.onload = () => {
        log('info', 'Clappr loaded');
        
        // Load HLS plugin after Clappr is loaded
        const hlsScript = document.createElement('script');
        hlsScript.src = 'https://cdn.jsdelivr.net/npm/clappr-level-selector-plugin@latest/dist/level-selector.min.js';
        hlsScript.async = true;
        hlsScript.onload = () => {
          log('info', 'Level selector plugin loaded');
        };
        document.head.appendChild(hlsScript);
      };
      document.head.appendChild(clapprScript);
    }
    
    // Load mpegts.js first since it's now our default player
    if (!window.mpegts) {
      const mpegtsScript = document.createElement('script');
      mpegtsScript.src = 'https://cdn.jsdelivr.net/npm/mpegts.js@latest';
      mpegtsScript.async = true;
      mpegtsScript.onload = () => {
        log('info', 'mpegts.js loaded');
        // Re-initialize if a channel is already selected
        if (selectedChannel && sessionId) {
          initializePlayer();
        }
      };
      document.head.appendChild(mpegtsScript);
    }
  };

  // Extract stable identifiers from selectedChannel to use as dependencies
  // This prevents the player from reinitializing when the channel object reference changes
  // but the actual channel data (id, sourceId, refreshKey) stays the same
  const channelId = selectedChannel?.id;
  const channelSourceId = selectedChannel?.sourceId;
  const channelRefreshKey = selectedChannel?._refreshKey;

  // Apply playback method when channel or method changes
  useEffect(() => {
    if (!sessionId || !selectedChannel) {
      cleanupPlayer();
      return;
    }

    log('info', 'Channel selected', {
      name: selectedChannel.name,
      id: getChannelId()
    });

    setError(null);
    setLoading(true);

    // Wait a brief moment for scripts to load if needed
    setTimeout(() => {
      initializePlayer();
    }, 100);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId, channelSourceId, channelRefreshKey, playbackMethod]);

  // Clean up player instance
  const cleanupPlayer = () => {
    // Clear any pending retry timers
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    // Clear recovery timeout
    if (recoveryTimeoutRef.current) {
      clearTimeout(recoveryTimeoutRef.current);
      recoveryTimeoutRef.current = null;
    }

    // Clear stall detection timer
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }

    // Clear health check interval
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }

    // Clear any pending recoveries from the global queue for this instance
    // This prevents orphaned recovery attempts when channel changes
    if (theatreMode && window.iptvRecoveryQueue?.pendingRecoveries?.length > 0) {
      // Clear all pending - we're destroying the player anyway
      window.iptvRecoveryQueue.pendingRecoveries.forEach(timer => clearTimeout(timer));
      window.iptvRecoveryQueue.pendingRecoveries = [];
    }

    // Reset timing refs to prevent false stall detection on new stream
    // These will be set properly when new stream starts playing
    lastPlayingTimeRef.current = Date.now(); // Reset to now so stall detection doesn't fire immediately
    lastKnownCurrentTimeRef.current = 0;

    // DON'T reset isRecoveringRef here - let recovery logic manage it
    // Otherwise we get into infinite recovery loops

    // CRITICAL: Immediately stop video element before destroying player
    // This prevents video decoder from continuing to run
    if (videoElementRef.current) {
      try {
        videoElementRef.current.pause();
        videoElementRef.current.src = '';
        videoElementRef.current.load(); // Force video element to release resources
      } catch (e) {
        // Ignore errors during emergency cleanup
      }
    }

    if (playerInstanceRef.current) {
      log('info', 'Destroying player instance');
      try {
        // CRITICAL: mpegts.js official cleanup sequence from documentation
        // Must call pause() → unload() → detachMediaElement() → destroy() in this order

        // Step 1: Pause (stops playback immediately)
        if (typeof playerInstanceRef.current.pause === 'function') {
          try {
            playerInstanceRef.current.pause();
          } catch (e) {
            // Ignore pause errors
          }
        }

        // Step 2: Unload (releases media source)
        if (typeof playerInstanceRef.current.unload === 'function') {
          log('info', 'Unloading mpegts player');
          playerInstanceRef.current.unload();
        }

        // Step 3: Detach media element
        if (typeof playerInstanceRef.current.detachMediaElement === 'function') {
          log('info', 'Detaching media element from mpegts player');
          playerInstanceRef.current.detachMediaElement();
        }

        // Step 4: Destroy player instance
        playerInstanceRef.current.destroy();
        log('info', 'Player destroyed successfully');
      } catch (e) {
        log('error', 'Error destroying player', { error: e.message });
      }
      playerInstanceRef.current = null;
    }

    // CRITICAL: Remove video element from DOM to prevent accumulation
    if (videoElementRef.current && videoElementRef.current.parentNode) {
      log('info', 'Removing video element from DOM');
      videoElementRef.current.parentNode.removeChild(videoElementRef.current);
    }
    videoElementRef.current = null;
  };

  // Helper to properly clear recovery state (decrements global counter in theatre mode)
  // Pass decrementActive=true when a recovery that incremented activeRecoveries is ending
  const clearRecoveryState = (decrementActive = false) => {
    if (theatreMode && (isRecoveringRef.current || decrementActive)) {
      // Decrement global counter if we're in theatre mode
      if (window.iptvRecoveryQueue.activeRecoveries > 0) {
        window.iptvRecoveryQueue.activeRecoveries--;
      }
    }
    isRecoveringRef.current = false;
  };

  // Check if stream is chronically unstable (too many recoveries in a short window)
  // Returns true if we should stop trying to recover
  const isStreamChronicallyUnstable = () => {
    const now = Date.now();

    // Clean up old timestamps outside the window
    recoveryTimestampsRef.current = recoveryTimestampsRef.current.filter(
      ts => now - ts < RECOVERY_WINDOW_MS
    );

    // Add current recovery timestamp
    recoveryTimestampsRef.current.push(now);

    // Check if we've exceeded the limit
    if (recoveryTimestampsRef.current.length > MAX_RECOVERIES_IN_WINDOW) {
      log('error', `Stream is chronically unstable: ${recoveryTimestampsRef.current.length} recoveries in ${RECOVERY_WINDOW_MS / 1000}s`);
      streamUnstableRef.current = true;
      return true;
    }

    return false;
  };

  // Unified recovery mechanism with progressive backoff
  const attemptRecovery = (errorContext = '') => {
    // Skip recovery entirely in auto-test mode - we want to fail fast and move to next channel
    if (skipRecovery) {
      log('info', 'Skip recovery enabled (auto-test mode) - not retrying');
      setError('Stream failed');
      // Notify parent that stream failed (for auto-test mode to advance)
      if (onStreamError) {
        onStreamError();
      }
      return;
    }

    // FIRST: Check global pause (emergency stop across all streams)
    if (theatreMode && window.iptvRecoveryQueue.globalPaused) {
      log('info', 'Global recovery paused - too many failures across all streams');
      setError('Multiple streams failing. Please wait or refresh the page.');
      return;
    }

    // Check if stream has been marked as chronically unstable
    if (streamUnstableRef.current) {
      log('info', 'Stream marked as unstable, not attempting recovery');
      return;
    }

    // Check if this recovery would exceed the frequency limit
    if (isStreamChronicallyUnstable()) {
      setError('Stream is unstable. Try "Find Alternative" or refresh the page.');
      isRecoveringRef.current = false;
      return;
    }

    // Check global recovery limits (only in theatre mode)
    if (theatreMode && !checkGlobalRecoveryLimits()) {
      setError('Too many stream failures. Please wait or refresh the page.');
      isRecoveringRef.current = false;
      return;
    }

    // CRITICAL: Hard limit on total recovery attempts to prevent infinite loops
    totalRecoveryAttemptsRef.current++;
    if (totalRecoveryAttemptsRef.current > MAX_TOTAL_RECOVERY_ATTEMPTS) {
      log('error', `Maximum total recovery attempts (${MAX_TOTAL_RECOVERY_ATTEMPTS}) exceeded - giving up`);
      setError('Stream unavailable after multiple recovery attempts. Please refresh the page.');
      isRecoveringRef.current = false;
      return;
    }

    // Prevent multiple simultaneous recovery attempts
    if (isRecoveringRef.current) {
      log('info', 'Recovery already in progress, skipping duplicate attempt');
      return;
    }

    // Don't recover if channel has changed
    if (getChannelId() !== currentChannelIdRef.current) {
      log('info', 'Channel changed, skipping recovery');
      return;
    }

    const now = Date.now();
    const timeSinceLastError = now - lastErrorTimeRef.current;

    // Reset retry count if it's been a while since last error (successful recovery)
    if (timeSinceLastError > 30000) {
      retryCountRef.current = 0;
      freshStartCountRef.current = 0;
      totalRecoveryAttemptsRef.current = 0; // Also reset total attempts after sustained success
      softRecoveryCountRef.current = 0; // Reset soft recovery counter after sustained success
      // Clear recovery timestamps - stream has been stable for 30s
      recoveryTimestampsRef.current = [];
      streamUnstableRef.current = false; // Clear unstable flag
      log('info', 'Resetting retry counters after successful playback period');
    }

    // Set recovery flag IMMEDIATELY to prevent duplicate attempts
    isRecoveringRef.current = true;
    lastErrorTimeRef.current = now;

    // In theatre mode (multi-view), use queue-based rate limiting to prevent:
    // 1. Stack overflow from recursive calls when multiple streams fail
    // 2. CPU/network overload from too many concurrent recoveries
    // 3. Kernel buffer exhaustion from connection churn
    if (theatreMode) {
      const queue = window.iptvRecoveryQueue;
      const timeSinceLastGlobalRecovery = now - queue.lastRecoveryTime;

      // Strict rate limiting: minimum 500ms between recovery attempts (increased from 200ms)
      // This dramatically reduces connection churn that causes kernel buffer leaks
      if (timeSinceLastGlobalRecovery < 500 || queue.activeRecoveries >= queue.maxConcurrentRecoveries) {
        // Check pending queue limit to prevent memory exhaustion
        if (queue.pendingRecoveries.length >= queue.maxPendingRecoveries) {
          log('warn', 'Too many pending recoveries, dropping this attempt');
          isRecoveringRef.current = false;
          return;
        }
        // Queue this recovery instead of recursive call to prevent stack overflow
        const delayMs = Math.max(500 - timeSinceLastGlobalRecovery, 0) + Math.random() * 500;
        isRecoveringRef.current = false;
        // Use setTimeout with a bound function instead of recursive call
        const recoveryTimer = setTimeout(() => {
          // Remove from pending queue
          const idx = queue.pendingRecoveries.indexOf(recoveryTimer);
          if (idx > -1) queue.pendingRecoveries.splice(idx, 1);
          // Retry recovery (not recursive - fresh call from setTimeout)
          attemptRecovery(errorContext);
        }, delayMs);
        queue.pendingRecoveries.push(recoveryTimer);
        return;
      }
      queue.lastRecoveryTime = now;
      queue.activeRecoveries++;
    }

    const MAX_RETRIES = 6; // More retry attempts with progressive backoff
    const MAX_FRESH_STARTS = 3; // Complete reinitialization attempts
    const retryCount = retryCountRef.current;

    if (retryCount < MAX_RETRIES) {
      // UPDATED: Slower recovery in multi-view to reduce connection churn and kernel buffer leaks
      // Multi-view: 1s, 2s, 3s, 5s, 8s, 10s (total: ~29s) - much slower to prevent system overload
      // Single view: 500ms, 1s, 2s, 3s, 5s, 8s (total: ~19.5s) - normal recovery
      const delays = theatreMode
        ? [1000, 2000, 3000, 5000, 8000, 10000]
        : [500, 1000, 2000, 3000, 5000, 8000];
      const retryDelay = delays[Math.min(retryCount, delays.length - 1)];

      retryCountRef.current++;
      const attemptNum = retryCount + 1;

      setRecoveryStatus(`Reconnecting (${attemptNum}/${MAX_RETRIES})...`);
      setLoading(false); // Don't show loading spinner during recovery

      retryTimerRef.current = setTimeout(() => {
        // Double-check channel hasn't changed during the delay
        if (getChannelId() !== currentChannelIdRef.current) {
          clearRecoveryState();
          setRecoveryStatus(null);
          return;
        }

        cleanupPlayer();

        // Reinitialize based on playback method
        // DON'T clear isRecoveringRef here - let 'playing' event clear it when stream actually starts
        // BUT set a safety timeout in case player never starts (errors before 'playing' event)

        // Clear any existing recovery timeout first
        if (recoveryTimeoutRef.current) {
          clearTimeout(recoveryTimeoutRef.current);
        }

        // Set a safety timeout - if player doesn't start, schedule next retry
        // Use longer timeout in theatre mode, shorter for single view
        const recoveryTimeout = theatreMode ? 15000 : 10000;
        recoveryTimeoutRef.current = setTimeout(() => {
          if (isRecoveringRef.current) {
            log('warn', 'Recovery timeout - player did not start within timeout');
            clearRecoveryState();
            // Only trigger next attempt if we haven't exhausted retries
            // The totalRecoveryAttemptsRef check in attemptRecovery will also guard this
            if (retryCountRef.current < MAX_RETRIES || freshStartCountRef.current < MAX_FRESH_STARTS) {
              attemptRecovery('Recovery timeout - player did not start');
            } else {
              log('error', 'Recovery timeout and all retries exhausted');
              setError('Stream unavailable. Please try another channel or refresh the page.');
            }
          }
        }, recoveryTimeout);

        switch (playbackMethod) {
          case 'mpegts-player':
            initializeMpegtsPlayer();
            break;
          case 'hls-player':
            initializeClapprPlayer();
            break;
          case 'vlc-link':
            initializeVlcLink();
            break;
          case 'test-video':
            initializeTestVideo();
            break;
          default:
            log('error', 'Unknown playback method during recovery', { method: playbackMethod });
            clearTimeout(recoveryTimeoutRef.current);
            recoveryTimeoutRef.current = null;
            clearRecoveryState(); // Clear on error
        }
      }, retryDelay);
    } else if (freshStartCountRef.current < MAX_FRESH_STARTS) {
      // Max retries exceeded - attempt a complete fresh start
      freshStartCountRef.current++;
      const freshStartNum = freshStartCountRef.current;

      log('info', `Max retries exceeded. Attempting fresh start (${freshStartNum}/${MAX_FRESH_STARTS})...`);
      setRecoveryStatus(`Fresh restart (${freshStartNum}/${MAX_FRESH_STARTS})...`);
      setLoading(false); // Don't show loading spinner during recovery

      // Reset retry counter for the fresh start
      retryCountRef.current = 0;

      // Wait longer before fresh start
      const freshStartDelay = 5000;

      retryTimerRef.current = setTimeout(() => {
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed during fresh start delay, aborting');
          clearRecoveryState();
          setRecoveryStatus(null);
          return;
        }

        log('info', `Executing fresh start ${freshStartNum}`);
        setRecoveryStatus(`Fresh restart (${freshStartNum}/${MAX_FRESH_STARTS})...`);

        // Complete cleanup including refs
        cleanupPlayer();
        isInitializingRef.current = false;

        // Reinitialize from scratch based on playback method
        // DON'T clear isRecoveringRef here - let 'playing' event clear it when stream actually starts
        // BUT set a safety timeout in case player never starts

        // Clear any existing recovery timeout first
        if (recoveryTimeoutRef.current) {
          clearTimeout(recoveryTimeoutRef.current);
        }

        // Set a safety timeout - if player doesn't start after fresh start, try again
        // Use longer timeout in theatre mode
        const freshStartTimeout = theatreMode ? 20000 : 15000;
        recoveryTimeoutRef.current = setTimeout(() => {
          if (isRecoveringRef.current) {
            log('warn', 'Fresh start timeout - player did not start');
            clearRecoveryState();
            // Only trigger another fresh start if we haven't exhausted them
            if (freshStartCountRef.current < MAX_FRESH_STARTS) {
              attemptRecovery('Fresh start timeout - player did not start');
            } else {
              log('error', 'Fresh start timeout and all fresh starts exhausted');
              setError('Stream unavailable. Please try another channel or refresh the page.');
            }
          }
        }, freshStartTimeout);

        switch (playbackMethod) {
          case 'mpegts-player':
            initializeMpegtsPlayer();
            break;
          case 'hls-player':
            initializeClapprPlayer();
            break;
          case 'vlc-link':
            initializeVlcLink();
            break;
          case 'test-video':
            initializeTestVideo();
            break;
          default:
            log('error', 'Unknown playback method during fresh start', { method: playbackMethod });
            clearTimeout(recoveryTimeoutRef.current);
            recoveryTimeoutRef.current = null;
            clearRecoveryState(); // Clear on error
        }
      }, freshStartDelay);
    } else {
      // All recovery attempts exhausted
      log('error', `Stream failed after ${MAX_RETRIES} retries and ${MAX_FRESH_STARTS} fresh starts`);
      setError('Stream unavailable. Please try another channel or refresh the page.');
      clearRecoveryState(true); // Decrement activeRecoveries since we're done
    }
  };

  // Soft recovery - try unload()/load() without destroying the player
  // This is much faster and uses fewer resources than full recreation
  // Use this for recoverable errors like temporary network issues or stream restarts
  const softRecoveryCountRef = useRef(0);
  const MAX_SOFT_RECOVERIES = 3;

  const attemptSoftRecovery = (errorContext = '') => {
    // Skip soft recovery in auto-test mode - fail fast and let parent handle it
    if (skipRecovery) {
      log('info', 'Skip recovery enabled (auto-test mode) - not attempting soft recovery');
      setError('Stream failed');
      if (onStreamError) {
        onStreamError();
      }
      return;
    }

    // FIRST: Check global pause (emergency stop across all streams)
    if (theatreMode && window.iptvRecoveryQueue.globalPaused) {
      log('info', 'Global recovery paused - too many failures across all streams');
      setError('Multiple streams failing. Please wait or refresh the page.');
      return;
    }

    // Check if stream has been marked as chronically unstable
    if (streamUnstableRef.current) {
      log('info', 'Stream marked as unstable, not attempting soft recovery');
      return;
    }

    // Check if this recovery would exceed the frequency limit
    if (isStreamChronicallyUnstable()) {
      setError('Stream is unstable. Try "Find Alternative" or refresh the page.');
      isRecoveringRef.current = false;
      return;
    }

    // Check global recovery limits (only in theatre mode)
    if (theatreMode && !checkGlobalRecoveryLimits()) {
      setError('Too many stream failures. Please wait or refresh the page.');
      isRecoveringRef.current = false;
      return;
    }

    // Check if we have a player instance to work with
    if (!playerInstanceRef.current) {
      log('info', 'No player instance for soft recovery, falling back to full recovery');
      attemptRecovery(errorContext);
      return;
    }

    // Don't soft recover if channel has changed
    if (getChannelId() !== currentChannelIdRef.current) {
      log('info', 'Channel changed, skipping soft recovery');
      return;
    }

    // Prevent multiple simultaneous recovery attempts
    if (isRecoveringRef.current) {
      log('info', 'Recovery already in progress, skipping soft recovery');
      return;
    }

    // Check soft recovery limit
    softRecoveryCountRef.current++;
    if (softRecoveryCountRef.current > MAX_SOFT_RECOVERIES) {
      log('info', `Soft recovery limit (${MAX_SOFT_RECOVERIES}) reached, falling back to full recovery`);
      softRecoveryCountRef.current = 0; // Reset for next time
      attemptRecovery(errorContext);
      return;
    }

    log('info', `Attempting soft recovery (${softRecoveryCountRef.current}/${MAX_SOFT_RECOVERIES}): ${errorContext}`);
    isRecoveringRef.current = true;
    setRecoveryStatus(`Reconnecting (soft ${softRecoveryCountRef.current}/${MAX_SOFT_RECOVERIES})...`);

    // Rate limiting for multi-view
    if (theatreMode) {
      const queue = window.iptvRecoveryQueue;
      const now = Date.now();
      const timeSinceLastGlobalRecovery = now - queue.lastRecoveryTime;

      if (timeSinceLastGlobalRecovery < 500 || queue.activeRecoveries >= queue.maxConcurrentRecoveries) {
        // Queue this recovery
        if (queue.pendingRecoveries.length >= queue.maxPendingRecoveries) {
          log('warn', 'Too many pending recoveries, dropping soft recovery attempt');
          isRecoveringRef.current = false;
          return;
        }
        const delayMs = Math.max(500 - timeSinceLastGlobalRecovery, 0) + Math.random() * 500;
        isRecoveringRef.current = false;
        const recoveryTimer = setTimeout(() => {
          const idx = queue.pendingRecoveries.indexOf(recoveryTimer);
          if (idx > -1) queue.pendingRecoveries.splice(idx, 1);
          attemptSoftRecovery(errorContext);
        }, delayMs);
        queue.pendingRecoveries.push(recoveryTimer);
        return;
      }
      queue.lastRecoveryTime = now;
      queue.activeRecoveries++;
    }

    try {
      const player = playerInstanceRef.current;

      // Step 1: Unload current stream (releases network connection and buffers)
      log('info', 'Soft recovery: unloading stream');
      player.unload();

      // Step 2: Brief delay to let resources clean up
      const reloadDelay = theatreMode ? 1000 : 500;

      setTimeout(() => {
        // Double-check channel hasn't changed during the delay
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed during soft recovery, aborting');
          clearRecoveryState();
          setRecoveryStatus(null);
          return;
        }

        // Check if player still exists
        if (!playerInstanceRef.current) {
          log('info', 'Player destroyed during soft recovery, falling back to full recovery');
          clearRecoveryState();
          attemptRecovery(errorContext);
          return;
        }

        // Step 3: Reload the stream
        log('info', 'Soft recovery: reloading stream');
        player.load();

        // Try to play
        player.play().catch(e => {
          // Autoplay blocked is normal, user can click to play
        });

        // Set a timeout to check if soft recovery worked
        const softRecoveryTimeout = theatreMode ? 10000 : 8000;
        const timeoutId = setTimeout(() => {
          if (isRecoveringRef.current) {
            log('warn', 'Soft recovery timeout - stream did not start');
            clearRecoveryState();
            // Soft recovery failed, try again or fall back to full recovery
            if (softRecoveryCountRef.current < MAX_SOFT_RECOVERIES) {
              attemptSoftRecovery('Soft recovery timeout');
            } else {
              softRecoveryCountRef.current = 0;
              attemptRecovery('Soft recovery failed');
            }
          }
        }, softRecoveryTimeout);

        // Store timeout ref so it can be cleared on success
        recoveryTimeoutRef.current = timeoutId;

      }, reloadDelay);

    } catch (e) {
      log('error', 'Soft recovery failed with exception', { error: e.message });
      clearRecoveryState();
      softRecoveryCountRef.current = 0;
      attemptRecovery(errorContext + ' (soft recovery exception)');
    }
  };

  // Start proactive health check to detect frozen video
  const startHealthCheck = () => {
    // When using resilient proxy, the backend handles reconnection automatically
    // We still run health checks to detect client-side issues, but don't trigger recovery
    // The backend will keep the stream alive; frontend just displays what it receives

    // Clear any existing health check
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }

    // Health checks in multi-view should be very infrequent to reduce CPU overhead
    // Theatre mode: 10 seconds (6 streams × 10s interval = manageable)
    // Single view: 3 seconds (more responsive for single stream)
    const checkInterval = theatreMode ? 10000 : 3000;
    // Freeze threshold: allow time for buffering before triggering recovery
    // Theatre mode: 2 checks (20s) - give streams time to recover
    // Single view: 3 checks (9s) - more responsive
    const freezeThreshold = theatreMode ? checkInterval * 2 : checkInterval * 3;

    // Check periodically if video is progressing
    healthCheckIntervalRef.current = setInterval(() => {
      const videoEl = videoElementRef.current;

      if (!videoEl) {
        return;
      }

      // Don't check if video is paused
      if (videoEl.paused) {
        return;
      }

      // For live streams, being in 'ended' state is a problem
      if (videoEl.ended) {
        log('error', 'Video in ended state - live stream should never end', { useResilientProxy: shouldUseResilientProxy });
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;

        // When using resilient proxy, don't trigger frontend recovery - backend handles it
        // Just show the error if the stream completely ended
        if (shouldUseResilientProxy) {
          setError('Stream ended. Try "Find Alternative" or refresh.');
          return;
        }

        // Try soft recovery first - stream ended naturally, might just need reload
        attemptSoftRecovery('Stream ended (health check)');
        return;
      }

      // Don't check if channel has changed
      if (getChannelId() !== currentChannelIdRef.current) {
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;
        return;
      }

      const currentTime = videoEl.currentTime;
      const lastKnownTime = lastKnownCurrentTimeRef.current;

      // Check if video has progressed at all
      // CRITICAL FIX: Also check if we've been stuck at 0 for too long (stream never started)
      if (currentTime === lastKnownTime) {
        const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

        if (timeSinceLastPlaying >= freezeThreshold) {
          log('error', `Video frozen detected - no progress for ${timeSinceLastPlaying}ms at currentTime ${currentTime}s`, { useResilientProxy: shouldUseResilientProxy });
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;

          // When using resilient proxy, backend handles reconnection
          // Only show error if frozen for a very long time (backend should have reconnected by now)
          if (shouldUseResilientProxy) {
            // With resilient proxy, allow more time - backend might be reconnecting
            // Only show error after 30+ seconds frozen (backend retries take time)
            if (timeSinceLastPlaying >= 30000) {
              setError('Stream frozen. Backend retries may have failed. Try "Find Alternative" or refresh.');
            } else {
              // Otherwise, just wait - backend is likely reconnecting
              log('info', 'Stream frozen but using resilient proxy - waiting for backend reconnect');
              // Restart health check to continue monitoring
              startHealthCheck();
            }
            return;
          }

          // Try soft recovery first - frozen stream might just need a reload
          attemptSoftRecovery('Stream frozen');
        }
      } else {
        // Video is progressing normally - update last known time
        lastKnownCurrentTimeRef.current = currentTime;
        lastPlayingTimeRef.current = Date.now();
      }
    }, checkInterval);

    log('info', `Health check started (interval: ${checkInterval}ms, freeze threshold: ${freezeThreshold}ms, resilientProxy: ${shouldUseResilientProxy})`);
  };

  // Initialize the appropriate player
  const initializePlayer = () => {
    const newChannelId = getChannelId();

    // CRITICAL: Prevent race conditions from rapid re-renders
    // BUT allow initialization if the channel has changed (legitimate user action)
    if (isInitializingRef.current && newChannelId === currentChannelIdRef.current) {
      log('warn', 'Player initialization already in progress for same channel, skipping duplicate call');
      return;
    }

    isInitializingRef.current = true;
    log('info', 'Starting player initialization', { channelId: newChannelId });

    cleanupPlayer();
    // Reset all recovery counters when changing channels
    retryCountRef.current = 0;
    freshStartCountRef.current = 0;
    lastErrorTimeRef.current = 0;
    totalRecoveryAttemptsRef.current = 0; // Reset total attempts for new channel
    softRecoveryCountRef.current = 0; // Reset soft recovery counter for new channel
    recoveryTimestampsRef.current = []; // Clear recovery history for new channel
    streamUnstableRef.current = false; // Clear unstable flag for new channel
    currentChannelIdRef.current = newChannelId; // Track current channel

    if (!containerRef.current) {
      log('error', 'Player container not available');
      isInitializingRef.current = false;
      return;
    }

    setLoading(true);
    setError(null);

    switch (playbackMethod) {
      case 'hls-player':
        initializeClapprPlayer();
        break;
      case 'mpegts-player':
        initializeMpegtsPlayer();
        break;
      case 'vlc-link':
        initializeVlcLink();
        break;
      case 'test-video':
        initializeTestVideo();
        break;
      default:
        log('error', 'Unknown playback method', { method: playbackMethod });
        setError('Unknown playback method');
        setLoading(false);
        isInitializingRef.current = false;
    }
  };

  // Initialize Clappr player
  const initializeClapprPlayer = () => {
    if (!window.Clappr) {
      log('warn', 'Clappr not loaded yet');
      setError('Player library not loaded yet. Please wait a moment and try again.');
      setLoading(false);
      return;
    }
    
    // Get URL from the backend proxy
    let baseUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}`;
    // Add sourceId if available to ensure we only search in the correct IPTV source
    if (selectedChannel?.sourceId) {
      baseUrl += `?source_id=${selectedChannel.sourceId}`;
    }
    const proxyHlsUrl = addAuthToStreamUrl(baseUrl);

    log('info', 'Initializing Clappr player', { url: proxyHlsUrl });
    
    try {
      // Create new player container
      while (containerRef.current.firstChild) {
        containerRef.current.removeChild(containerRef.current.firstChild);
      }
      
      const playerEl = document.createElement('div');
      playerEl.id = 'player-wrapper';
      playerEl.style.width = '100%';
      playerEl.style.height = '100%';
      containerRef.current.appendChild(playerEl);
      
      // Initialize player
      playerInstanceRef.current = new window.Clappr.Player({
        source: proxyHlsUrl,
        parentId: '#player-wrapper',
        width: '100%',
        height: '100%',
        autoPlay: true,
        hideMediaControl: theatreMode, // Hide controls in theatre mode
        disableVideoTagContextMenu: theatreMode,
        hlsjsConfig: {
          // Enable worker thread for demuxing (offload from main thread)
          enableWorker: true,
          // Disable low latency mode - prioritize smooth playback over minimal delay
          lowLatencyMode: false,
          debug: false,
          // MULTI-VIEW: Absolute minimum buffer to reduce memory usage
          // 6 streams × 5MB = 30MB total
          maxBufferLength: theatreMode ? 5 : 30,         // 5s multi-view, 30s single
          maxMaxBufferLength: theatreMode ? 10 : 60,     // Hard cap: 10s multi-view, 60s single
          maxBufferSize: theatreMode ? 5 * 1000 * 1000 : 60 * 1000 * 1000, // 5MB multi-view, 60MB single
          maxBufferHole: 0.5,                            // Max gap to jump over
          // Back buffer cleanup - very aggressive in multi-view
          backBufferLength: theatreMode ? 5 : 90,        // Keep only 5s multi-view, 90s single
          // Live stream settings - stay close to live edge
          liveSyncDurationCount: theatreMode ? 1 : 3,    // 1 segment behind in multi-view
          liveMaxLatencyDurationCount: theatreMode ? 3 : 10, // Aggressive catch-up
          // Reduce fragment loading pressure
          startFragPrefetch: false,                      // Don't prefetch on start
          testBandwidth: false,                          // Skip bandwidth test
          xhrSetup: (xhr) => {
            // No custom headers to avoid CORS issues
          }
        },
        playback: {
          playInline: true
        }
      });
      
      // Store video element reference when player is ready
      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_READY, () => {
        try {
          const videoEl = playerInstanceRef.current.core.activePlayback.el;
          if (videoEl) {
            videoElementRef.current = videoEl;
            // Trigger muted state sync for the new video element
            setVideoElementKey(prev => prev + 1);
          }
        } catch (err) {
          log('warn', 'Could not get video element for Clappr player', err);
        }
      });

      // Helper function to detect and report quality for Clappr
      const detectQualityClappr = (eventType = 'check') => {
        try {
          const videoEl = videoElementRef.current;
          if (!videoEl) {
            return;
          }

          const qualityInfo = detectVideoQuality(videoEl.videoWidth, videoEl.videoHeight);

          if (qualityInfo) {
            log('info', `Video quality detected (${eventType}): ${qualityInfo.resolution} (${qualityInfo.width}x${qualityInfo.height})`);
            setVideoQuality(qualityInfo);
            if (onQualityDetected) {
              onQualityDetected(qualityInfo);
            }
          }
        } catch (err) {
          log('warn', 'Could not detect video quality for Clappr player', err);
        }
      };

      // Event listeners
      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_PLAY, () => {
        log('info', 'Playback started');
        setLoading(false);
        setError(null);
        setRecoveryStatus(null); // Clear recovery status on initial playback

        // Cancel recovery timeout if it exists
        if (recoveryTimeoutRef.current) {
          clearTimeout(recoveryTimeoutRef.current);
          recoveryTimeoutRef.current = null;
        }

        // DON'T reset retry counters here - only reset after sustained playback
        // The attemptRecovery function already handles this (resets after 30s of no errors)
        // Resetting here causes infinite loops because stream might stall immediately after 'playing'

        lastPlayingTimeRef.current = Date.now();
        clearRecoveryState(); // Allow new recovery if needed

        // CRITICAL: Reset initialization lock when player successfully starts
        isInitializingRef.current = false;

        // Clear stall timer when playing resumes
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }

        // Detect initial video quality
        detectQualityClappr('playing');

        // Listen for resolution changes (adaptive bitrate streams)
        // Skip in theatre mode - initial detection is enough
        if (!theatreMode) {
          const videoEl = videoElementRef.current;
          if (videoEl) {
            videoEl.addEventListener('resize', () => {
              detectQualityClappr('resize');
            });
          }
        }
      });

      // Throttled timeupdate for Clappr
      let lastClapprTimeUpdate = 0;
      const clapprTimeUpdateThrottle = theatreMode ? 1000 : 250;

      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_TIMEUPDATE, () => {
        const now = Date.now();
        if (now - lastClapprTimeUpdate < clapprTimeUpdateThrottle) return;
        lastClapprTimeUpdate = now;

        // Update last playing time when video is progressing
        lastPlayingTimeRef.current = now;

        // Clear stall timer on normal playback
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
      });

      // Stall detection for Clappr
      const handleClapprStall = (eventType) => {
        log('warn', `Clappr ${eventType} - checking for stall`);

        // Clear any existing stall timer
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
        }

        // Increased stall timeout in theatre mode to reduce connection churn
        // This prevents aggressive reconnection that can cause kernel buffer leaks
        const stallTimeout = theatreMode ? 15000 : 10000;

        // Set a timer to detect if we're stuck
        stallTimerRef.current = setTimeout(() => {
          // Don't recover if channel has changed
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, ignoring stall');
            return;
          }

          const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

          if (timeSinceLastPlaying > 5000) { // Stalled for more than 5 seconds
            log('error', `Clappr stalled for ${timeSinceLastPlaying}ms`);
            attemptRecovery('Stream stalled');
          }
        }, stallTimeout);
      };

      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_BUFFERING, () => handleClapprStall('buffering'));
      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_BUFFERFULL, () => {
        // Clear stall timer when buffer is full
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
      });

      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_ERROR, (error) => {
        log('error', 'Clappr player error', { error });
        setLoading(false);

        // CRITICAL: Reset initialization lock on error
        isInitializingRef.current = false;

        // Don't retry if channel has changed (e.g., during auto-test)
        if (getChannelId() !== currentChannelIdRef.current) {
          log('info', 'Channel changed, skipping retry');
          return;
        }

        attemptRecovery('Player error');
      });
      
    } catch (e) {
      log('error', 'Error initializing player', { error: e.message });
      setError(`Error initializing player: ${e.message}`);
      setLoading(false);
    }
  };

  // Initialize MPEGTS.js player
  const initializeMpegtsPlayer = () => {
    // Load mpegts.js if not present
    if (!window.mpegts) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mpegts.js@latest';
      script.async = true;
      script.onload = () => {
        log('info', 'mpegts.js loaded');
        initializeMpegtsPlayerInstance();
      };
      script.onerror = () => {
        log('error', 'Failed to load mpegts.js');
        setError('Failed to load video player library');
        setLoading(false);
      };
      document.head.appendChild(script);
    } else {
      initializeMpegtsPlayerInstance();
    }
  };

  // Validate the stream URL
  const validateStreamUrl = (url) => {
    // Make sure the URL is properly formed
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      log('error', 'Invalid stream URL', { url });
      return false;
    }
    
    // Check if the sessionId is valid 
    if (url.includes('/api/stream/') && !sessionId) {
      log('error', 'Missing session ID in stream URL', { url });
      return false;
    }
    
    // Check if channel ID is properly encoded
    if (selectedChannel && url.includes(getChannelId()) && !url.includes(encodeURIComponent(getChannelId()))) {
      log('warn', 'Channel ID not properly encoded in URL');
      return encodeURI(url);
    }
    
    return url;
  };
  
  // Initialize mpegts.js player instance
  const initializeMpegtsPlayerInstance = () => {
    if (!window.mpegts) {
      log('error', 'mpegts.js not available');
      setError('Player library not available');
      setLoading(false);
      return;
    }
    
    log('info', 'Initializing mpegts.js player', { useResilientProxy: shouldUseResilientProxy });

    // Get URL for TS stream
    // Use resilient proxy in multi-view mode - it handles retry/reconnect at backend level
    // This eliminates the need for frontend recovery logic that can cause network flooding
    let baseTsUrl;
    if (shouldUseResilientProxy) {
      // Resilient endpoint - handles automatic reconnection at the proxy level
      // The backend will keep the HTTP connection alive and silently reconnect to source if it fails
      baseTsUrl = `http://localhost:5001/api/stream/resilient/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
      log('info', 'Using resilient stream proxy (backend-level retry)');
    } else {
      // Standard endpoint - frontend handles recovery
      baseTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
    }
    // Add sourceId if available to ensure we only search in the correct IPTV source
    if (selectedChannel?.sourceId) {
      baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
    }
    // Add cache buster to force fresh stream request on every retry (only for non-resilient)
    if (!shouldUseResilientProxy) {
      baseTsUrl += `&_t=${Date.now()}`;
    }
    let proxyTsUrl = addAuthToStreamUrl(baseTsUrl);

    // Validate the URL before using it
    proxyTsUrl = validateStreamUrl(proxyTsUrl);
    if (!proxyTsUrl) {
      setError('Invalid stream URL. Please try another channel.');
      setLoading(false);
      return;
    }
    
    try {
      // Create new player container
      while (containerRef.current.firstChild) {
        containerRef.current.removeChild(containerRef.current.firstChild);
      }
      
      const videoEl = document.createElement('video');
      videoEl.id = 'mpegts-video';
      videoEl.style.width = '100%';
      videoEl.style.height = '100%';
      videoEl.controls = !theatreMode; // Hide controls in theatre mode
      videoEl.muted = muted; // Use the prop value
      containerRef.current.appendChild(videoEl);

      // Store video element reference for health checks
      videoElementRef.current = videoEl;
      // Trigger muted state sync for the new video element
      setVideoElementKey(prev => prev + 1);

      if (window.mpegts.getFeatureList().mseLivePlayback) {
        // CRITICAL: Disable mpegts.js internal logging in multi-view mode
        // mpegts.js generates THOUSANDS of log messages per second which causes
        // massive CPU overhead when running multiple streams simultaneously
        if (theatreMode && window.mpegts.LoggingControl) {
          window.mpegts.LoggingControl.enableAll = false;
          window.mpegts.LoggingControl.enableDebug = false;
          window.mpegts.LoggingControl.enableVerbose = false;
          window.mpegts.LoggingControl.enableInfo = false;
          window.mpegts.LoggingControl.enableWarn = false;
          window.mpegts.LoggingControl.enableError = false;
        }

        // MULTI-VIEW vs SINGLE-VIEW optimization strategy:
        // - Multi-view (theatreMode): ABSOLUTE MINIMUM resources - no buffers, no workers
        // - Single-view: Quality focused - buffers and workers enabled
        //
        // Per mpegts.js docs, for minimal resource usage:
        // enableWorker: false, enableStashBuffer: false, aggressive latency chasing

        const player = window.mpegts.createPlayer({
          type: 'mse',
          url: proxyTsUrl,
          isLive: true,

          // STASH BUFFER: DISABLED in multi-view per mpegts.js minimal config
          // This is the biggest memory saver - no intermediate buffering
          enableStashBuffer: !theatreMode,
          stashInitialSize: theatreMode ? 32 * 1024 : 384 * 1024, // 32KB if somehow used, 384KB single

          // WORKER THREADS: DISABLED in multi-view
          // Workers add CPU overhead and memory for each stream
          enableWorker: !theatreMode,

          // BUFFER LATENCY: Very aggressive in multi-view
          // Keep minimal data in buffer to reduce memory pressure
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: theatreMode ? 1.5 : 3.0, // 1.5s multi-view (per docs)
          liveBufferLatencyMinRemain: theatreMode ? 0.3 : 1.5,  // 0.3s multi-view (minimal)

          // BUFFER SIZE: Tiny for multi-view
          // 2MB per stream × 6 streams = 12MB total
          maxBufferSize: theatreMode ? 2 * 1024 * 1024 : 64 * 1024 * 1024, // 2MB multi-view, 64MB single

          // AUTO-CLEANUP: Maximum aggression in multi-view
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: theatreMode ? 10 : 300,  // 10s multi-view
          autoCleanupMinBackwardDuration: theatreMode ? 5 : 180,   // 5s multi-view

          // LAZY LOAD: Disabled for live streams
          lazyLoad: false,
          lazyLoadMaxDuration: 3 * 60,
          lazyLoadRecoverDuration: 30,

          // LIVE SYNC: Aggressive catch-up in multi-view
          liveSync: true,
          liveSyncMaxLatency: theatreMode ? 2.0 : 4.0,   // 2s max in multi-view
          liveSyncTargetLatency: theatreMode ? 1.0 : 2.0, // 1s target in multi-view
          liveSyncPlaybackRate: theatreMode ? 1.15 : 1.05 // 15% speedup to catch up faster
        });
        
        player.attachMediaElement(videoEl);

        // Add error event listener before loading
        player.on(window.mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
          log('error', 'mpegts player error', { errorType, errorDetail, errorInfo, useResilientProxy: shouldUseResilientProxy });
          setLoading(false);

          // CRITICAL: Reset initialization lock on error
          isInitializingRef.current = false;

          // Don't retry if channel has changed (e.g., during auto-test)
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, skipping retry');
            return;
          }

          // Check for stack overflow / fatal internal errors - don't retry these
          const errorMsg = errorInfo?.msg || errorInfo?.message || '';
          if (errorMsg.includes('Maximum call stack size exceeded') ||
              errorMsg.includes('stack') ||
              errorDetail === 'Exception') {
            log('error', 'Fatal internal error - not attempting recovery', { errorMsg });
            setError('Stream data is corrupted. Try "Find Alternative" or another channel.');
            streamUnstableRef.current = true; // Mark as unstable to prevent any recovery
            return;
          }

          // Determine error context for better logging
          let errorContext = 'Stream error';
          if (errorType === window.mpegts.ErrorTypes.NETWORK_ERROR) {
            if (errorDetail === window.mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID) {
              const statusCode = errorInfo?.code || 'unknown';
              errorContext = `Network error (HTTP ${statusCode})`;
            } else {
              errorContext = `Network error (${errorDetail})`;
            }
          } else if (errorType === window.mpegts.ErrorTypes.MEDIA_ERROR) {
            errorContext = `Media error (${errorDetail})`;
          }

          // When using resilient proxy, the backend handles retry/reconnect automatically
          // The frontend only sees an error when the backend has exhausted all retries
          // In this case, just show the error - don't attempt frontend-level recovery
          if (shouldUseResilientProxy) {
            log('info', 'Using resilient proxy - backend retry exhausted, showing error');
            setError(`${errorContext}. Backend retries exhausted. Try "Find Alternative" or refresh.`);
            return;
          }

          // Standard mode: use frontend recovery logic
          attemptRecovery(errorContext);
        });

        // Handle LOADING_COMPLETE event - for live streams this means the stream ended
        // This is a natural stream ending (server closed connection) vs an error
        player.on(window.mpegts.Events.LOADING_COMPLETE, () => {
          log('warn', 'Stream loading complete (server closed connection)', { useResilientProxy: shouldUseResilientProxy });

          // Don't recover if channel has changed
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, ignoring loading complete');
            return;
          }

          // When using resilient proxy, loading complete means the backend gave up after all retries
          // Don't attempt frontend recovery - just show the error
          if (shouldUseResilientProxy) {
            log('info', 'Using resilient proxy - backend connection closed, showing error');
            setError('Stream ended. Backend retries exhausted. Try "Find Alternative" or refresh.');
            return;
          }

          // For live streams, loading complete means the stream ended - attempt recovery
          // Use soft recovery first (unload/load) before full recreation
          attemptSoftRecovery('Stream ended (loading complete)');
        });

        player.load();

        // Helper function to detect and report quality
        const detectQualityMpegts = (eventType = 'check') => {
          const qualityInfo = detectVideoQuality(videoEl.videoWidth, videoEl.videoHeight);

          if (qualityInfo) {
            log('info', `Video quality detected (${eventType}): ${qualityInfo.resolution} (${qualityInfo.width}x${qualityInfo.height})`);
            setVideoQuality(qualityInfo);
            if (onQualityDetected) {
              onQualityDetected(qualityInfo);
            }
          }
        };

        videoEl.addEventListener('playing', () => {
          log('info', 'Video playing');
          setLoading(false);
          setError(null);
          setRecoveryStatus(null); // Clear recovery status on initial playback

          // Cancel recovery timeout if it exists
          if (recoveryTimeoutRef.current) {
            clearTimeout(recoveryTimeoutRef.current);
            recoveryTimeoutRef.current = null;
          }

          // DON'T reset retry counters here - only reset after sustained playback
          // The attemptRecovery function already handles this (resets after 30s of no errors)
          // Resetting here causes infinite loops because stream might stall immediately after 'playing'

          // DON'T reset soft recovery counter either - it should only reset after sustained playback
          // Resetting here causes infinite recovery loops for streams that play briefly then die
          // The counter will reset naturally when lastErrorTimeRef exceeds 30s in attemptRecovery

          lastPlayingTimeRef.current = Date.now();
          lastKnownCurrentTimeRef.current = videoEl.currentTime;
          clearRecoveryState(); // Allow new recovery if needed

          // CRITICAL: Reset initialization lock when player successfully starts
          isInitializingRef.current = false;

          // Notify parent that stream is playing (for auto-test mode)
          if (onStreamPlaying) {
            onStreamPlaying();
          }

          // Clear stall timer when playing resumes
          if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
            stallTimerRef.current = null;
          }

          // Detect initial video quality
          detectQualityMpegts('playing');

          // Start proactive health check
          startHealthCheck();
        });

        // Listen for resolution changes (adaptive bitrate streams)
        // Skip in theatre mode - initial detection is enough, saves event processing
        if (!theatreMode) {
          videoEl.addEventListener('resize', () => {
            detectQualityMpegts('resize');
          });
        }

        // Throttled timeupdate handler - fires ~4x/sec per video, too frequent for multi-view
        let lastTimeUpdate = 0;
        const timeUpdateThrottle = theatreMode ? 1000 : 250; // 1s in multi-view, 250ms single

        videoEl.addEventListener('timeupdate', () => {
          const now = Date.now();
          if (now - lastTimeUpdate < timeUpdateThrottle) return;
          lastTimeUpdate = now;

          // Update last playing time when video is progressing
          lastPlayingTimeRef.current = now;

          // Clear stall timer on normal playback
          if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
            stallTimerRef.current = null;
          }
        });

        // Stall detection - when video stops buffering/loading
        const handleStall = (eventType) => {
          log('warn', `Video ${eventType} - checking for stall`);

          // Clear any existing stall timer
          if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
          }

          // Increased stall timeout in theatre mode to reduce connection churn
          // This prevents aggressive reconnection that can cause kernel buffer leaks
          const stallTimeout = theatreMode ? 15000 : 10000;

          // Set a timer to detect if we're stuck
          stallTimerRef.current = setTimeout(() => {
            // Don't recover if channel has changed
            if (getChannelId() !== currentChannelIdRef.current) {
              log('info', 'Channel changed, ignoring stall');
              return;
            }

            const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

            if (timeSinceLastPlaying > 5000) { // Stalled for more than 5 seconds
              log('error', `Video stalled for ${timeSinceLastPlaying}ms`);
              // Try soft recovery first - stall might be temporary buffering issue
              attemptSoftRecovery('Stream stalled');
            }
          }, stallTimeout);
        };

        videoEl.addEventListener('waiting', () => handleStall('waiting'));
        videoEl.addEventListener('stalled', () => handleStall('stalled'));

        videoEl.addEventListener('error', () => {
          log('error', 'Video error', { error: videoEl.error });
          setLoading(false);
          isInitializingRef.current = false;

          // Don't recover if channel has changed
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, skipping recovery on video error');
            return;
          }

          attemptRecovery('Video element error');
        });

        // Handle unexpected stream end for live streams
        videoEl.addEventListener('ended', () => {
          log('warn', 'Live stream ended unexpectedly');

          // Don't recover if channel has changed
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, ignoring stream end');
            return;
          }

          // Try soft recovery first - stream ended naturally, might just need reload
          attemptSoftRecovery('Stream ended (video element)');
        });

        player.play().catch(e => {
          // Autoplay prevented is normal browser behavior - don't log it
        });

        playerInstanceRef.current = player;
      } else {
        log('error', 'MSE not supported in this browser');
        setError('Your browser does not support the required video playback features. Try using VLC instead.');
        setLoading(false);
      }
    } catch (e) {
      log('error', 'Error initializing mpegts.js player', { error: e.message });
      setError(`Error initializing player: ${e.message}`);
      setLoading(false);
    }
  };

  // Initialize VLC link page
  const initializeVlcLink = () => {
    log('info', 'Initializing VLC link page');

    let baseTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
    // Add sourceId if available to ensure we only search in the correct IPTV source
    if (selectedChannel?.sourceId) {
      baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
    }
    const proxyTsUrl = addAuthToStreamUrl(baseTsUrl);
    
    // Create new player container
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }
    
    // Create simple VLC link UI
    const linkContainer = document.createElement('div');
    linkContainer.style.width = '100%';
    linkContainer.style.height = '100%';
    linkContainer.style.display = 'flex';
    linkContainer.style.flexDirection = 'column';
    linkContainer.style.alignItems = 'center';
    linkContainer.style.justifyContent = 'center';
    linkContainer.style.color = 'white';
    linkContainer.style.padding = '20px';
    linkContainer.style.boxSizing = 'border-box';
    linkContainer.style.textAlign = 'center';
    
    const title = document.createElement('h3');
    title.textContent = 'Stream Link for External Player';
    title.style.marginBottom = '10px';
    
    const description = document.createElement('p');
    description.textContent = 'This stream may not play in the browser. Copy this URL and paste it into VLC Media Player or another external player.';
    description.style.marginBottom = '20px';
    description.style.maxWidth = '500px';
    
    const urlBox = document.createElement('div');
    urlBox.textContent = proxyTsUrl;
    urlBox.style.padding = '10px';
    urlBox.style.background = '#333';
    urlBox.style.borderRadius = '4px';
    urlBox.style.marginBottom = '15px';
    urlBox.style.wordBreak = 'break-all';
    urlBox.style.maxWidth = '90%';
    
    const copyButton = document.createElement('button');
    copyButton.textContent = 'Copy URL';
    copyButton.style.padding = '8px 16px';
    copyButton.style.backgroundColor = '#4CAF50';
    copyButton.style.color = 'white';
    copyButton.style.border = 'none';
    copyButton.style.borderRadius = '4px';
    copyButton.style.cursor = 'pointer';
    copyButton.onclick = () => {
      navigator.clipboard.writeText(proxyTsUrl)
        .then(() => {
          copyButton.textContent = 'Copied!';
          setTimeout(() => {
            copyButton.textContent = 'Copy URL';
          }, 2000);
        })
        .catch(err => {
          console.error('Copy failed:', err);
          copyButton.textContent = 'Copy Failed';
        });
    };
    
    // Assemble the UI
    linkContainer.appendChild(title);
    linkContainer.appendChild(description);
    linkContainer.appendChild(urlBox);
    linkContainer.appendChild(copyButton);
    containerRef.current.appendChild(linkContainer);
    
    setLoading(false);
  };

  // Initialize test video player with a known good source
  const initializeTestVideo = () => {
    log('info', 'Initializing test video');
    
    // Known reliable test stream (Big Buck Bunny)
    const testUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    
    // Create new player container
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }
    
    const videoEl = document.createElement('video');
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.controls = !theatreMode; // Hide controls in theatre mode
    videoEl.muted = muted; // Set muted state
    videoEl.src = testUrl;
    containerRef.current.appendChild(videoEl);
    
    videoEl.addEventListener('playing', () => {
      log('info', 'Test video playing');
      setLoading(false);
      setError(null);
    });
    
    videoEl.addEventListener('error', () => {
      log('error', 'Test video error', { error: videoEl.error });
      setError('Error playing test video.');
      setLoading(false);
    });
    
    videoEl.play().catch(e => {
      // Autoplay prevented is normal browser behavior - don't log it
    });
  };

  // Toggle debug panel
  const toggleDebug = () => {
    setInternalShowDebug(prev => !prev);
  };

  // Toggle channel info overlay
  const toggleChannelInfo = () => {
    setInternalShowChannelInfo(prev => !prev);
  };

  // Toggle EPG info overlay
  const toggleEpgInfo = () => {
    setInternalShowEpgInfo(prev => !prev);
  };

  // Handle Cast button click
  const handleCast = async () => {
    if (isCasting) {
      stopCasting();
    } else {
      try {
        // Fetch the server's network IP address
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
        const networkInfoUrl = `${apiUrl}/network-info`;

        log('info', 'Fetching network info for casting', { networkInfoUrl });

        const response = await fetch(networkInfoUrl);
        const networkInfo = await response.json();

        log('info', 'Network info received', networkInfo);

        // Use HLS transcoded stream for Chromecast compatibility
        const serverIP = networkInfo.primaryAddress;
        const port = apiUrl.match(/:(\d+)/)?.[1] || '5001';
        const castApiUrl = `http://${serverIP}:${port}/api`;
        let streamUrl = `${castApiUrl}/stream/${sessionId}/${getChannelId()}/hls.m3u8`;
        // Add sourceId if available to ensure we only search in the correct IPTV source
        if (selectedChannel?.sourceId) {
          streamUrl += `?source_id=${selectedChannel.sourceId}`;
        }
        const channelName = selectedChannel?.name || 'IPTV Stream';
        const logoUrl = selectedChannel?.logo || selectedChannel?.tvgLogo;

        log('info', 'Starting cast with HLS transcoded stream', { streamUrl, channelName, serverIP });
        castMedia(streamUrl, channelName, logoUrl);
      } catch (error) {
        const errorMsg = `Failed to get network info for casting: ${error.message}`;
        log('error', errorMsg);
        alert(errorMsg);
      }
    }
  };

  // Format time for display
// Specific part to update: the formatTime function

// Format time for display - Updated to 12-hour format with AM/PM
const formatTime = (date) => {
    if (!date) return '';
    
    try {
      const d = new Date(date);
      let hours = d.getHours();
      const minutes = d.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      
      // Convert hours to 12-hour format
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'
      
      return `${hours}:${minutes} ${ampm}`;
    } catch (e) {
      return '';
    }
  };

  // Format date for display (e.g., "Sun, 11 Sep")
  const formatDate = (date) => {
    if (!date) return '';
    
    try {
      const d = new Date(date);
      return d.toLocaleDateString('en-US', { 
        weekday: 'short', 
        day: 'numeric', 
        month: 'short' 
      });
    } catch (e) {
      return '';
    }
  };

  // Render control buttons only in normal mode (not in theatre mode)
  const renderControlButtons = () => {
    if (theatreMode === true || theatreMode === 'true') {
      return null;
    }
    return (
      <div style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        zIndex: 50,
        display: 'flex',
        gap: '8px'
      }}>
        {/* Channel info toggle */}
        <button
          onClick={toggleChannelInfo}
          title={showChannelInfo ? "Hide channel info" : "Show channel info"}
          style={{
            padding: '5px',
            width: '30px',
            height: '30px',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            color: 'white',
            border: 'none',
            borderRadius: '50%',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.2s ease'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(30, 30, 30, 0.8)'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'}
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
          >
            {showChannelInfo ? (
              // Info icon
              <>
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </>
            ) : (
              // Info icon (alternative)
              <>
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </>
            )}
          </svg>
        </button>

        {/* Toggle EPG info overlay with indicator for matched channels */}
        <button
          onClick={toggleEpgInfo}
          title={showEpgInfo ? "Hide guide information" : "Show guide information"}
          style={{
            padding: '5px',
            width: '30px',
            height: '30px',
            backgroundColor: selectedChannel && matchedChannels[getChannelId()] ? 'rgba(0, 150, 50, 0.5)' : 'rgba(0, 0, 0, 0.5)',
            color: 'white',
            border: selectedChannel && matchedChannels[getChannelId()] ? '2px solid rgba(0, 255, 100, 0.5)' : 'none',
            borderRadius: '50%',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            position: 'relative'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = selectedChannel && matchedChannels[getChannelId()] ? 'rgba(0, 180, 60, 0.8)' : 'rgba(30, 30, 30, 0.8)'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = selectedChannel && matchedChannels[getChannelId()] ? 'rgba(0, 150, 50, 0.5)' : 'rgba(0, 0, 0, 0.5)'}
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
          >
            {showEpgInfo ? (
              // Calendar icon
              <>
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </>
            ) : (
              // Calendar with slash icon (to indicate hidden)
              <>
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
                <line x1="21" y1="3" x2="3" y2="21"></line>
              </>
            )}
          </svg>
        </button>

        {/* Debug toggle */}
        <button
          onClick={toggleDebug}
          title={showDebug ? "Hide debug panel" : "Show debug panel"}
          style={{
            padding: '5px',
            width: '30px',
            height: '30px',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            color: 'white',
            border: 'none',
            borderRadius: '50%',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.2s ease'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(30, 30, 30, 0.8)'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'}
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
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          </svg>
        </button>

        {/* Google Cast button */}
        <CastButton
          isCastAvailable={isCastAvailable}
          isCasting={isCasting}
          onClick={handleCast}
        />
      </div>
    );
  };

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: theatreMode ? '100%' : '400px',
      backgroundColor: '#000',
      borderRadius: theatreMode ? '0' : '8px',
      overflow: 'hidden',
      boxShadow: theatreMode ? 'none' : '0 4px 12px rgba(0, 0, 0, 0.15)'
    }}>
      {/* Control buttons section - Only render in normal mode, not in theatre mode */}
      {renderControlButtons()}

      {/* Debug panel */}
      {showDebug && (
        <div style={{
          position: 'absolute',
          top: '50px',
          right: '10px',
          bottom: '10px',
          width: '250px',
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          color: 'white',
          padding: '12px',
          zIndex: 45,
          overflowY: 'auto',
          fontSize: '11px',
          fontFamily: 'monospace',
          borderRadius: '8px',
          backdropFilter: 'blur(5px)'
        }}>
          <div style={{ 
            marginBottom: '10px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
            paddingBottom: '8px'
          }}>
            <strong>Method:</strong> {playbackMethod}
          </div>
          
          {selectedChannel && (
            <div style={{ 
              marginBottom: '10px', 
              fontSize: '10px', 
              wordBreak: 'break-all',
              background: 'rgba(255, 255, 255, 0.1)',
              padding: '8px',
              borderRadius: '4px'
            }}>
              <div style={{ marginBottom: '5px' }}>
                <strong>Channel:</strong> {selectedChannel.name}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <strong>Channel ID:</strong> {getChannelId()}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <strong>Group:</strong> {getGroupTitle()}
              </div>
              {matchedChannels[getChannelId()] && (
                <div style={{ marginBottom: '5px', color: '#81c784' }}>
                  <strong>Matched EPG ID:</strong> {matchedChannels[getChannelId()]}
                </div>
              )}
              <div>
                <strong>URL:</strong> {selectedChannel.url || 'N/A'}
              </div>
            </div>
          )}
          
          <div style={{ marginBottom: '5px' }}>
            <strong>Logs:</strong>
          </div>
          
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {logs.map(log => (
              <div
                key={log.id}
                style={{
                  padding: '4px 6px',
                  margin: '3px 0',
                  backgroundColor: 
                    log.level === 'error' ? 'rgba(255, 0, 0, 0.3)' :
                    log.level === 'warn' ? 'rgba(255, 255, 0, 0.2)' :
                    log.level === 'info' ? 'rgba(0, 0, 255, 0.2)' :
                    'rgba(255, 255, 255, 0.1)',
                  borderRadius: '4px',
                  fontSize: '9px'
                }}
              >
                {log.message}
                {log.data && (
                  <div style={{ color: '#aaa', fontSize: '8px', wordBreak: 'break-all', marginTop: '2px' }}>
                    {log.data}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Recovery status banner - thin bar at bottom of video */}
      {recoveryStatus && (
        <div style={{
          position: 'absolute',
          bottom: '0',
          left: '0',
          right: '0',
          padding: '6px 12px',
          backgroundColor: 'rgba(59, 130, 246, 0.95)', // Blue
          color: 'white',
          zIndex: 45,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          backdropFilter: 'blur(5px)',
          borderTop: '1px solid rgba(96, 165, 250, 0.3)',
          fontSize: '13px',
          fontWeight: '500'
        }}>
          <svg
            className="animate-spin"
            style={{
              animation: 'spin 1s linear infinite',
              width: '14px',
              height: '14px'
            }}
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>{recoveryStatus}</span>
        </div>
      )}
      
      {/* Loading indicator */}
      {loading && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          padding: '15px 25px',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          borderRadius: '8px',
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <div className="loading-spinner" style={{
            display: 'inline-block',
            width: '20px',
            height: '20px',
            border: '3px solid rgba(255,255,255,0.3)',
            borderRadius: '50%',
            borderTopColor: 'white',
            animation: 'spin 1s linear infinite'
          }}></div>
          <span>Loading...</span>
        </div>
      )}
      
      {/* No channel selected message */}
      {!selectedChannel && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#aaa',
          zIndex: 20,
          textAlign: 'center'
        }}>
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="48" 
            height="48" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1" 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            style={{ opacity: 0.5, marginBottom: '15px' }}
          >
            <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
            <polyline points="17 2 12 7 7 2"></polyline>
          </svg>
          <div>Select a channel to play</div>
        </div>
      )}
      
      {/* Player container */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#000'
        }}
      />

      {/* Error notification overlay - Only show for permanent errors */}
      {error && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 100,
          backgroundColor: 'rgba(220, 38, 38, 0.95)',
          color: 'white',
          padding: '20px 30px',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
          maxWidth: '80%',
          textAlign: 'center'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            marginBottom: '12px'
          }}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span style={{
              fontSize: '18px',
              fontWeight: 'bold'
            }}>
              Stream Error
            </span>
          </div>
          <p style={{
            margin: '0 0 16px 0',
            fontSize: '14px',
            lineHeight: '1.5'
          }}>
            {error}
          </p>
          <button
            onClick={() => setError(null)}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
              color: 'white',
              border: 'none',
              padding: '8px 20px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '600',
              transition: 'background-color 0.2s'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.3)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Channel info overlay (toggleable) */}
      {selectedChannel && showChannelInfo && (
        <>
          {/* Gradient overlay for better text visibility */}
          <div style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            height: '120px',
            background: 'linear-gradient(transparent, rgba(0,0,0,0.9))',
            pointerEvents: 'none',
            zIndex: 20
          }}/>
          
          <div style={{
            position: 'absolute',
            bottom: '15px',
            left: '15px',
            right: showDebug ? '270px' : '15px',
            padding: '10px 15px',
            borderRadius: '8px',
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            gap: '5px'
          }}>
            <div style={{ 
              fontWeight: 'bold', 
              fontSize: '16px',
              color: 'white',
              textShadow: '0 1px 3px rgba(0,0,0,0.8)'
            }}>
              {selectedChannel.name}
            </div>
            
            <div style={{ 
              fontSize: '13px', 
              color: 'rgba(255,255,255,0.9)',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              textShadow: '0 1px 3px rgba(0,0,0,0.8)'
            }}>
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
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                <line x1="7" y1="7" x2="7.01" y2="7"></line>
              </svg>
              {getGroupTitle()}
            </div>
          </div>
        </>
      )}
      
      {/* EPG info overlay (toggleable) - Only shown when there's a matched EPG ID */}
      {selectedChannel && showEpgInfo && epgData && epgData.currentProgram && matchedChannels[getChannelId()] && (
        <div style={{
          position: 'absolute',
          bottom: '80px',
          left: '15px',
          right: showDebug ? '270px' : '15px',
          padding: '15px',
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          borderRadius: '8px',
          zIndex: 25,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          backdropFilter: 'blur(5px)',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
          border: '1px solid rgba(255, 255, 255, 0.15)'
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'flex-start'
          }}>
            <div style={{ 
              fontWeight: '600',
              fontSize: '18px',
              color: 'white',
              marginBottom: '3px',
              textShadow: '0 1px 3px rgba(0,0,0,0.9)'
            }}>
              {epgData.currentProgram.title}
            </div>
            
            <div style={{ 
              fontSize: '13px', 
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              backgroundColor: 'rgba(255, 255, 255, 0.15)',
              padding: '4px 8px',
              borderRadius: '4px',
              marginLeft: '8px',
              fontWeight: '500'
            }}>
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="12" 
                height="12" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              {formatTime(epgData.currentProgram.start)} - {formatTime(epgData.currentProgram.stop)}
            </div>
          </div>
          
          {epgData.currentProgram.desc && (
            <div style={{ 
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.95)',
              lineHeight: '1.5',
              textShadow: '0 1px 2px rgba(0,0,0,0.8)',
              backgroundColor: 'rgba(0, 0, 0, 0.25)',
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              {epgData.currentProgram.desc}
            </div>
          )}
          
          {/* Display upcoming programs if available */}
         
        </div>
      )}
      
      {/* CSS Animation */}
      <style dangerouslySetInnerHTML={{
        __html: `
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `
      }} />
    </div>
  );
};

// Memoize to prevent unnecessary re-renders in multi-view
// Only re-render when these specific props change
export default memo(IPTVPlayer, (prevProps, nextProps) => {
  // Return true if props are equal (should NOT re-render)
  // Return false if props are different (should re-render)
  return (
    prevProps.sessionId === nextProps.sessionId &&
    prevProps.selectedChannel?.id === nextProps.selectedChannel?.id &&
    prevProps.selectedChannel?.sourceId === nextProps.selectedChannel?.sourceId &&
    prevProps.selectedChannel?._refreshKey === nextProps.selectedChannel?._refreshKey &&
    prevProps.playbackMethod === nextProps.playbackMethod &&
    prevProps.theatreMode === nextProps.theatreMode &&
    prevProps.muted === nextProps.muted
  );
});