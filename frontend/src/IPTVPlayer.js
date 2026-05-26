import React, { useEffect, useRef, useState, memo, useCallback, useMemo } from 'react';
import { addAuthToStreamUrl } from './utils/streamAuth';
import { detectVideoQuality } from './utils/videoQuality';
import { useCast } from './hooks/useCast';
import apiClient from './utils/apiClient';

// Overlay / modal subcomponents — each takes just the props it needs,
// so IPTVPlayer itself only has to thread state in at one spot.
import PlayerErrorModal from './components/player/PlayerErrorModal';
import PlayerRecoveryBanner from './components/player/PlayerRecoveryBanner';
import PlayerLoadingOverlay from './components/player/PlayerLoadingOverlay';
import PlayerEmptyState from './components/player/PlayerEmptyState';
import PlayerDebugPanel from './components/player/PlayerDebugPanel';
import PlayerChannelInfoOverlay from './components/player/PlayerChannelInfoOverlay';
import PlayerEpgInfoOverlay from './components/player/PlayerEpgInfoOverlay';
import PlayerControls from './components/player/PlayerControls';

// Utility modules extracted from IPTVPlayer so the file stays manageable.
import { loadPlayerScripts } from './utils/player/scriptLoader';
import { ensureRecoveryQueue } from './utils/player/globalRecoveryQueue';
import { cleanupPlayer as cleanupPlayerExt } from './utils/player/cleanupPlayer';
import { formatTime } from './utils/player/formatTime';
import {
  initializeClapprPlayer as initializeClapprPlayerExt,
  initializeVlcLink as initializeVlcLinkExt,
  initializeTestVideo as initializeTestVideoExt
} from './utils/player/initAltPlayers';
import {
  initializeMpegtsPlayer as initializeMpegtsPlayerExt
} from './utils/player/initMpegts';
import {
  initializeHlsPlayer as initializeHlsPlayerExt
} from './utils/player/initHls';
import {
  initializeYoutubeHlsPlayer as initializeYoutubeHlsPlayerExt
} from './utils/player/initYoutubeHls';
import useEpgData from './hooks/player/useEpgData';
import useSearchProgressListener from './hooks/player/useSearchProgressListener';
import useHandleCast from './hooks/player/useHandleCast';
import useStreamRecovery from './hooks/player/useStreamRecovery';

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
  volume = 1, // 0..1 — per-tile audio level, applied alongside `muted`
  useResilientProxy = null, // null = auto (true in theatre mode, false otherwise)
  skipRecovery = false, // When true, skip retry logic (for auto-test mode)
  onStreamPlaying = null, // Callback when stream starts playing successfully
  onStreamError = null, // Callback when stream fails (after skipRecovery or exhausted retries)
  onStreamDead = null, // Callback when stream is dead and needs alternative (for multi-view auto-recovery)
  onVideoElement = null, // Callback(videoEl|null) — fires when the underlying <video> ref changes so external code (e.g. commercial detector) can attach Web Audio + canvas analyzers
  onCancel = null // Optional: when set, the loading overlay shows a Cancel button that calls this. Used by multi-view to let the user × a hung tile.
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
  const [videoQuality, setVideoQuality] = useState(null);

  // Use external state in theatre mode, internal state otherwise
  const showDebug = theatreMode && externalShowDebug !== undefined ? externalShowDebug : internalShowDebug;
  const showChannelInfo = theatreMode && externalShowChannelInfo !== undefined ? externalShowChannelInfo : internalShowChannelInfo;
  const showEpgInfo = theatreMode && externalShowEpgInfo !== undefined ? externalShowEpgInfo : internalShowEpgInfo;

  // Google Cast
  const { isCastAvailable, isCasting, castMedia, stopCasting } = useCast();

  // Refs shared across the player lifecycle. Recovery-specific refs
  // (retryTimerRef, recoveryTimeoutRef, isRecoveringRef, streamUnstableRef,
  // hasCalledOnStreamDeadRef, etc.) are owned by useStreamRecovery below
  // and exposed back out for cleanupPlayer / mpegts to touch.
  const containerRef = useRef(null);
  const playerInstanceRef = useRef(null);
  const logIdRef = useRef(0);
  const stallTimerRef = useRef(null);
  const lastPlayingTimeRef = useRef(0);
  const currentChannelIdRef = useRef(null);
  const healthCheckIntervalRef = useRef(null);
  const lastKnownCurrentTimeRef = useRef(0);
  const videoElementRef = useRef(null);
  const isInitializingRef = useRef(false);
  const videoListenersRef = useRef([]);

  // Lazily-created lookups that cleanupPlayer and reinitialize are
  // passed into the recovery hook through. The hook wants these, but
  // they in turn depend on refs the hook owns — we break the cycle by
  // handing over refs that are populated later in this same render.
  const cleanupPlayerRef = useRef(null);
  const reinitializeRef = useRef(null);

  // Global recovery queue lives on window and is shared across every
  // IPTVPlayer instance. Initialized once via the util module.
  ensureRecoveryQueue();
  
  // Enhanced logging function - optimized for multi-view performance
  const log = (level, message, data = null) => {
    // CRITICAL: Always log "Video playing" message even in theatre mode
    // This is needed for auto-test functionality to detect working channels
    const isCriticalMessage = message === 'Video playing';
    // Recovery diagnostics — these are low-volume (one per health-
    // check tick, only on freezes) and crucial for debugging the
    // multi-view freeze-and-recover chain. Always allow them through
    // to the console even in theatre mode so the user can see WHY a
    // stream froze and which recovery tier fired.
    const isRecoveryDiagnostic =
      typeof message === 'string' &&
      (message.startsWith('[health]') || message.startsWith('[recovery]'));

    // In theatre mode (multi-view), skip most logging to prevent performance issues
    // But always emit critical messages that other components depend on
    if (theatreMode && !isCriticalMessage && !isRecoveryDiagnostic) {
      return;
    }

    // Log critical messages to console in ALL modes (needed for auto-test detection)
    // Log other messages only in development
    if (isCriticalMessage || isRecoveryDiagnostic || process.env.NODE_ENV === 'development') {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[${level.toUpperCase()}] ${message}`, data || '');
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

  // Helper to add event listener with tracking for cleanup
  // CRITICAL: Use this instead of direct addEventListener to prevent memory leaks
  const addTrackedListener = useCallback((element, event, handler) => {
    if (!element) return;
    element.addEventListener(event, handler);
    videoListenersRef.current.push({ event, handler });
  }, []);

  // Track video element changes to sync muted state
  const [videoElementKey, setVideoElementKey] = useState(0);

  // Update video element muted state when muted prop changes OR video element changes
  useEffect(() => {
    if (videoElementRef.current) {
      videoElementRef.current.muted = muted;
    }
  }, [muted, videoElementKey]);

  // Sync the per-tile volume (0..1) onto the underlying <video> element.
  // Clamp defensively — bad inputs would throw on assignment.
  useEffect(() => {
    if (videoElementRef.current) {
      const v = Math.max(0, Math.min(1, Number(volume)));
      if (Number.isFinite(v)) videoElementRef.current.volume = v;
    }
  }, [volume, videoElementKey]);

  // Expose the current <video> element to consumers (commercial
  // detector etc.). Fires every time the player reinitializes (which
  // bumps videoElementKey), and once with null on unmount so the
  // consumer can release Web Audio + canvas resources.
  //
  // We keep onVideoElement in a ref so identity churn from the parent
  // (e.g. inline arrow callbacks) doesn't cause the effect to re-run
  // every render — that would teardown + rebuild the audio chain
  // constantly and lose audio samples.
  const onVideoElementRef = useRef(onVideoElement);
  useEffect(() => { onVideoElementRef.current = onVideoElement; }, [onVideoElement]);
  useEffect(() => {
    const cb = onVideoElementRef.current;
    if (!cb) return undefined;
    cb(videoElementRef.current || null);
    return () => onVideoElementRef.current?.(null);
  }, [videoElementKey]);

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

  // NOTE: We do NOT use global window error handlers to crash players
  // Global "Script error" events can't tell us WHICH player failed
  // Instead, we rely on per-player error handling:
  // 1. player.on(mpegts.Events.ERROR) - fires for the specific player that errored
  // 2. player.on(mpegts.Events.LOADING_COMPLETE) - fires when stream ends
  // 3. Health check (stale detection) - catches frozen/dead streams per-player

  // EPG "now playing" data for the current channel. Skipped entirely in
  // theatre mode because the multi-view UI doesn't render the overlay.
  const { epgData } = useEpgData({
    sessionId,
    channelId: getChannelId(),
    skip: theatreMode,
    log
  });


  // Lazy-load Clappr + mpegts.js from CDN. When mpegts.js lands after
  // mount and a channel is already selected, re-run initializePlayer so
  // the stream actually attaches.
  const loadScripts = () => {
    loadPlayerScripts({
      log,
      onMpegtsReady: () => {
        // YouTube tiles don't depend on mpegts.js or sessionId.
        if (selectedChannel && (sessionId || playbackMethod === 'youtube-hls')) {
          initializePlayer();
        }
      }
    });
  };

  // Extract stable identifiers from selectedChannel to use as dependencies
  // This prevents the player from reinitializing when the channel object reference changes
  // but the actual channel data (id, sourceId, refreshKey) stays the same
  const channelId = selectedChannel?.id;
  const channelSourceId = selectedChannel?.sourceId;
  const channelRefreshKey = selectedChannel?._refreshKey;

  // When useFindAlternative is searching for a replacement stream it
  // dispatches `iptv:searchProgress` on the window with live "Tested N
  // of M" updates. If our error modal is already up, stream the
  // updates into it so the user sees progress instead of a frozen
  // message.
  useSearchProgressListener({
    channelId,
    channelSourceId,
    channelRefreshKey,
    setError
  });

  // Apply playback method when channel or method changes
  useEffect(() => {
    // YouTube tiles don't need a session id — they resolve their own
    // HLS manifest via /api/youtube/channel/:id/live and play directly.
    const needsSessionId = playbackMethod !== 'youtube-hls';
    if (!selectedChannel || (needsSessionId && !sessionId)) {
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
    // CRITICAL: Track this timeout so we can clear it on cleanup/unmount
    const initTimeout = setTimeout(() => {
      initializePlayer();
    }, 100);

    // Cleanup function to prevent race conditions and memory leaks
    return () => {
      clearTimeout(initTimeout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId, channelSourceId, channelRefreshKey, playbackMethod]);

  // Recovery + health-check machinery lives in useStreamRecovery. It
  // owns every retry/backoff ref and the logic for soft/full recovery.
  // We pass cleanupPlayer and reinitialize via refs because both are
  // defined below this call — without the indirection we'd hit a
  // temporal-dead-zone error, and we can't move this call any later
  // because cleanupPlayer itself needs recovery.retryTimerRef.
  const recovery = useStreamRecovery({
    theatreMode,
    skipRecovery,
    shouldUseResilientProxy,
    playbackMethod,
    log,
    cleanupPlayer: (...args) => cleanupPlayerRef.current?.(...args),
    reinitialize: (method) => reinitializeRef.current?.(method),
    getChannelId,
    setError,
    setLoading,
    setRecoveryStatus,
    videoElementRef,
    playerInstanceRef,
    currentChannelIdRef,
    lastPlayingTimeRef,
    lastKnownCurrentTimeRef,
    healthCheckIntervalRef,
    stallTimerRef,
    isInitializingRef,
    onStreamDead,
    onStreamError
  });

  // Tear down timers, listeners, video element, and mpegts instance.
  // The real implementation lives in utils/player/cleanupPlayer so this
  // file stays navigable; we just hand it the refs it needs to touch.
  const cleanupPlayer = () => {
    cleanupPlayerExt({
      retryTimerRef: recovery.retryTimerRef,
      recoveryTimeoutRef: recovery.recoveryTimeoutRef,
      stallTimerRef,
      healthCheckIntervalRef,
      videoListenersRef,
      videoElementRef,
      playerInstanceRef,
      lastPlayingTimeRef,
      lastKnownCurrentTimeRef,
      theatreMode,
      log
    });
  };
  cleanupPlayerRef.current = cleanupPlayer;

  // Shared context passed into the extracted player initializers so
  // IPTVPlayer doesn't have to thread 25+ params per call site. Every
  // ref, state setter, and recovery callback the initializers touch is
  // funneled through this object.
  const buildPlayerCtx = () => ({
    log,
    sessionId,
    selectedChannel,
    getChannelId,
    theatreMode,
    muted,
    shouldUseResilientProxy,
    onQualityDetected,
    onStreamPlaying,
    containerRef,
    playerInstanceRef,
    videoElementRef,
    recoveryTimeoutRef: recovery.recoveryTimeoutRef,
    stallTimerRef,
    lastPlayingTimeRef,
    lastKnownCurrentTimeRef,
    currentChannelIdRef,
    isInitializingRef,
    isRecoveringRef: recovery.isRecoveringRef,
    hasCalledOnStreamDeadRef: recovery.hasCalledOnStreamDeadRef,
    streamUnstableRef: recovery.streamUnstableRef,
    // Recovery counters cleared on `playing` so a stream that briefly
    // hiccuped during startup, then played, gets a fresh budget — without
    // this, every transient blip past the first counts toward the
    // chronic-unstable cap and a healthy stream gets swapped out.
    retryCountRef: recovery.retryCountRef,
    freshStartCountRef: recovery.freshStartCountRef,
    totalRecoveryAttemptsRef: recovery.totalRecoveryAttemptsRef,
    softRecoveryCountRef: recovery.softRecoveryCountRef,
    recoveryTimestampsRef: recovery.recoveryTimestampsRef,
    setError,
    setLoading,
    setRecoveryStatus,
    setVideoQuality,
    setVideoElementKey,
    clearRecoveryState: recovery.clearRecoveryState,
    addTrackedListener,
    attemptRecovery: recovery.attemptRecovery,
    attemptSoftRecovery: recovery.attemptSoftRecovery,
    notifyStreamDead: recovery.notifyStreamDead,
    startHealthCheck: recovery.startHealthCheck
  });

  const initializeClapprPlayer = () => initializeClapprPlayerExt(buildPlayerCtx());
  const initializeVlcLink = () => initializeVlcLinkExt(buildPlayerCtx());
  const initializeTestVideo = () => initializeTestVideoExt(buildPlayerCtx());
  const initializeMpegtsPlayer = () => initializeMpegtsPlayerExt(buildPlayerCtx());
  const initializeHlsPlayer = () => initializeHlsPlayerExt(buildPlayerCtx());
  const initializeYoutubeHlsPlayer = () => initializeYoutubeHlsPlayerExt(buildPlayerCtx());

  // Single dispatch point the recovery hook calls during retry/fresh-start.
  const reinitialize = (method) => {
    switch (method) {
      case 'hls-player':
        initializeClapprPlayer();
        break;
      case 'mpegts-player':
        initializeMpegtsPlayer();
        break;
      case 'hls-stream':
        // Backend HLS remux + hls.js. iOS-friendly and self-recovering.
        initializeHlsPlayer();
        break;
      case 'youtube-hls':
        // YouTube channel — backend yt-dlp resolves a fresh HLS manifest
        // URL, hls.js plays it directly (no backend proxy).
        initializeYoutubeHlsPlayer();
        break;
      case 'vlc-link':
        initializeVlcLink();
        break;
      case 'test-video':
        initializeTestVideo();
        break;
      default:
        log('error', 'Unknown playback method during recovery', { method });
    }
  };
  reinitializeRef.current = reinitialize;

  // Initialize / switch to the appropriate player.
  const initializePlayer = () => {
    const newChannelId = getChannelId();

    // Race-condition guard: allow only one concurrent init per channel,
    // but do let a legitimate channel change kick off a new init.
    if (isInitializingRef.current && newChannelId === currentChannelIdRef.current) {
      log('warn', 'Player initialization already in progress for same channel, skipping duplicate call');
      return;
    }

    isInitializingRef.current = true;
    log('info', 'Starting player initialization', { channelId: newChannelId });

    cleanupPlayer();

    // New channel = clean slate for every recovery counter.
    recovery.retryCountRef.current = 0;
    recovery.freshStartCountRef.current = 0;
    recovery.lastErrorTimeRef.current = 0;
    recovery.totalRecoveryAttemptsRef.current = 0;
    recovery.softRecoveryCountRef.current = 0;
    recovery.recoveryTimestampsRef.current = [];
    recovery.streamUnstableRef.current = false;
    recovery.hasCalledOnStreamDeadRef.current = false;
    currentChannelIdRef.current = newChannelId;

    if (!containerRef.current) {
      log('error', 'Player container not available');
      isInitializingRef.current = false;
      return;
    }

    setLoading(true);
    setError(null);
    reinitialize(playbackMethod);
    if (!['hls-player', 'mpegts-player', 'hls-stream', 'youtube-hls', 'vlc-link', 'test-video'].includes(playbackMethod)) {
      setError('Unknown playback method');
      setLoading(false);
      isInitializingRef.current = false;
    }
  };

  // Toggle debug panel
  const toggleDebug = () => setInternalShowDebug((prev) => !prev);
  const toggleChannelInfo = () => setInternalShowChannelInfo((prev) => !prev);
  const toggleEpgInfo = () => setInternalShowEpgInfo((prev) => !prev);

  // Chromecast handler lives in its own hook; it needs network-info
  // from the backend (Chromecast can't reach localhost).
  const handleCast = useHandleCast({
    sessionId,
    selectedChannel,
    getChannelId,
    castMedia,
    stopCasting,
    isCasting,
    log
  });

  // Render control buttons only in normal mode (not in theatre mode)
  // The control pills (channel info / EPG / debug / cast) live in
  // <PlayerControls>. Hidden in theatre mode — multi-view renders its
  // own scoped controls at the slot level.

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
      <PlayerControls
        theatreMode={theatreMode}
        showChannelInfo={showChannelInfo}
        showEpgInfo={showEpgInfo}
        showDebug={showDebug}
        selectedChannel={selectedChannel}
        isMatched={!!matchedChannels[getChannelId()]}
        onToggleChannelInfo={toggleChannelInfo}
        onToggleEpgInfo={toggleEpgInfo}
        onToggleDebug={toggleDebug}
        isCastAvailable={isCastAvailable}
        isCasting={isCasting}
        onCast={handleCast}
      />

      <PlayerDebugPanel
        visible={showDebug}
        playbackMethod={playbackMethod}
        selectedChannel={selectedChannel}
        channelId={getChannelId()}
        groupTitle={getGroupTitle()}
        matchedEpgId={matchedChannels[getChannelId()]}
        logs={logs}
      />
      
      <PlayerRecoveryBanner recoveryStatus={recoveryStatus} />

      <PlayerLoadingOverlay
        visible={loading}
        status={recoveryStatus || (loading ? 'Connecting…' : null)}
        onCancel={onCancel}
      />

      <PlayerEmptyState visible={!selectedChannel} />
      
      {/* Player container */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#000'
        }}
      />

      <PlayerErrorModal error={error} onDismiss={() => setError(null)} />

      <PlayerChannelInfoOverlay
        visible={showChannelInfo}
        selectedChannel={selectedChannel}
        groupTitle={getGroupTitle()}
        showDebug={showDebug}
      />
      
      <PlayerEpgInfoOverlay
        visible={showEpgInfo}
        selectedChannel={selectedChannel}
        epgData={epgData}
        matchedEpgId={matchedChannels[getChannelId()]}
        showDebug={showDebug}
        formatTime={formatTime}
      />
      
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
    prevProps.muted === nextProps.muted &&
    prevProps.volume === nextProps.volume
  );
});
