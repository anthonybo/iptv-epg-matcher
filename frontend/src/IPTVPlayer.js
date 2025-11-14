import React, { useEffect, useRef, useState } from 'react';
import { addAuthToStreamUrl } from './utils/streamAuth';
import { useCast } from './hooks/useCast';
import CastButton from './components/CastButton';

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
  onQualityDetected
}) => {
  // Helper to get channel ID from either 'id' or 'tvgId' field
  // CRITICAL: Use 'id' first (IPTV channel ID like xtream_1111) not 'tvgId' (EPG hint like AnimalPlanet.us)
  // BUILD TIMESTAMP: 2025-11-10 16:40 PST
  const getChannelId = () => {
    const channelId = selectedChannel?.id || selectedChannel?.tvgId;
    console.log('[IPTVPlayer v16:40] getChannelId called:', {
      id: selectedChannel?.id,
      tvgId: selectedChannel?.tvgId,
      returning: channelId,
      fullChannel: selectedChannel
    });
    return channelId;
  };

  // Helper to get group title from either 'groupTitle' or 'group.title' field
  const getGroupTitle = () => selectedChannel?.groupTitle || selectedChannel?.group?.title || '';

  // State - use external state in theatre mode, internal state otherwise
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
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
  
  // Enhanced logging function
  const log = (level, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${level.toUpperCase()}] ${message}`, data || '');
    
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

  // Initialize component
  useEffect(() => {
    log('info', 'IPTVPlayer component mounting');
    console.log('[IPTVPlayer] Theatre mode prop:', theatreMode);

    // Load required scripts
    loadScripts();

    // Overlays are hidden by default - user can toggle them with the icons

    return () => {
      log('info', 'IPTVPlayer component unmounting');
      cleanupPlayer();
    };
  }, []);

  // Debug theatre mode changes
  useEffect(() => {
    console.log('[IPTVPlayer] Theatre mode changed:', theatreMode);
  }, [theatreMode]);

  // Try to load EPG data when channel changes
  useEffect(() => {
    const channelId = getChannelId();
    if (sessionId && selectedChannel && channelId) {
      // Only fetch EPG data if the channel has a matched EPG ID
      if (matchedChannels[channelId]) {
        const epgId = matchedChannels[channelId];
        log('info', 'Fetching EPG data for matched channel', {
          channelId: channelId,
          matchedEpgId: epgId
        });

        // Use the EPG ID for fetching program data
        fetchEpgData(epgId);
      } else {
        // Clear EPG data when there's no match
        setEpgData(null);
        log('info', 'No EPG match for channel, clearing EPG data', {
          channelId: channelId
        });
      }
    }
  }, [sessionId, selectedChannel, matchedChannels]);
  
  // Fetch EPG data for the current channel using proper ID
  const fetchEpgData = async (epgId) => {
    if (!sessionId || !epgId) return;

    console.log('[IPTVPlayer] fetchEpgData called with:', epgId);

    try {
      // If epgId is an object, extract the actual ID with multiple fallbacks
      let channelIdStr;
      
      if (typeof epgId === 'object') {
        // Use multiple fallbacks for finding the ID
        channelIdStr = epgId.epgId || epgId.id || '';
        
        // If we still don't have an ID but have an object, use a string representation as last resort
        if (!channelIdStr) {
          try {
            channelIdStr = JSON.stringify(epgId);
            log('warn', `Had to use JSON representation of epgId: ${channelIdStr}`);
          } catch (err) {
            log('error', 'Failed to stringify epgId object', { error: err.message });
            return;
          }
        }
      } else {
        // Convert to string if it's a primitive value
        channelIdStr = String(epgId);
      }
      
      if (!channelIdStr) {
        log('error', 'Invalid EPG ID: empty after extraction', { originalEpgId: epgId });
        return;
      }
      
      log('info', `Fetching EPG data for ID: ${channelIdStr}`);
      
      const response = await fetch(`http://localhost:5001/api/epg/${sessionId}?channelId=${encodeURIComponent(channelIdStr)}`);
      
      if (response.ok) {
        const data = await response.json();
        log('info', 'EPG data received', { 
          hasCurrentProgram: !!data.currentProgram,
          programCount: data.programs?.length || 0,
          sourceKey: data.sourceKey || 'unknown'
        });
        setEpgData(data);
      } else {
        const errorText = await response.text();
        log('error', `Failed to load EPG data: ${response.status} ${response.statusText}`, { responseText: errorText });
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
  }, [sessionId, selectedChannel, playbackMethod]);

  // Clean up player instance
  const cleanupPlayer = () => {
    // Clear any pending retry timers
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
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

    if (playerInstanceRef.current) {
      log('info', 'Destroying player instance');
      try {
        playerInstanceRef.current.destroy();
      } catch (e) {
        log('error', 'Error destroying player', { error: e.message });
      }
      playerInstanceRef.current = null;
    }

    videoElementRef.current = null;
  };

  // Start proactive health check to detect frozen video
  const startHealthCheck = () => {
    // Clear any existing health check
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }

    // Check every 5 seconds if video is progressing
    healthCheckIntervalRef.current = setInterval(() => {
      const videoEl = videoElementRef.current;

      if (!videoEl) {
        return;
      }

      // Don't check if video is paused
      if (videoEl.paused) {
        return;
      }

      // For live streams, being in 'ended' state is a problem - trigger recovery
      if (videoEl.ended) {
        log('error', 'Video in ended state - live stream should never end');

        const MAX_RETRIES = 3;
        const retryCount = retryCountRef.current;

        if (retryCount < MAX_RETRIES) {
          retryCountRef.current++;
          log('info', `Recovering from ended state (${retryCount + 1}/${MAX_RETRIES})...`);
          setError(`Stream ended - reconnecting (${retryCount + 1}/${MAX_RETRIES})...`);

          // Clear interval before cleanup
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;

          // Trigger recovery based on playback method
          cleanupPlayer();
          if (playbackMethod === 'mpegts-player') {
            initializeMpegtsPlayer();
          } else if (playbackMethod === 'hls-player') {
            initializeClapprPlayer();
          }
        } else {
          log('error', `Stream ended after ${MAX_RETRIES} recovery attempts`);
          setError('Stream disconnected and cannot be recovered. Try another channel or refresh the page.');
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;
        }
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
      if (currentTime === lastKnownTime && lastKnownTime > 0) {
        // Video hasn't progressed - it's frozen
        const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

        if (timeSinceLastPlaying > 10000) { // Frozen for more than 10 seconds
          log('error', `Video frozen detected - no progress for ${timeSinceLastPlaying}ms at currentTime ${currentTime}s`);

          const MAX_RETRIES = 3;
          const retryCount = retryCountRef.current;

          if (retryCount < MAX_RETRIES) {
            retryCountRef.current++;
            log('info', `Recovering from freeze (${retryCount + 1}/${MAX_RETRIES})...`);
            setError(`Stream frozen - recovering (${retryCount + 1}/${MAX_RETRIES})...`);

            // Clear interval before cleanup
            clearInterval(healthCheckIntervalRef.current);
            healthCheckIntervalRef.current = null;

            // Trigger recovery based on playback method
            cleanupPlayer();
            if (playbackMethod === 'mpegts-player') {
              initializeMpegtsPlayer();
            } else if (playbackMethod === 'hls-player') {
              initializeClapprPlayer();
            }
          } else {
            log('error', `Stream frozen after ${MAX_RETRIES} recovery attempts`);
            setError('Stream is frozen and cannot be recovered. Try another channel or refresh the page.');
            clearInterval(healthCheckIntervalRef.current);
            healthCheckIntervalRef.current = null;
          }
        }
      } else {
        // Video is progressing normally - update last known time
        lastKnownCurrentTimeRef.current = currentTime;
        lastPlayingTimeRef.current = Date.now();
      }
    }, 5000); // Check every 5 seconds

    log('info', 'Health check started');
  };

  // Initialize the appropriate player
  const initializePlayer = () => {
    cleanupPlayer();
    retryCountRef.current = 0; // Reset retry count when changing channels
    currentChannelIdRef.current = getChannelId(); // Track current channel

    if (!containerRef.current) {
      log('error', 'Player container not available');
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
          enableWorker: true,
          lowLatencyMode: true,
          debug: false,
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
          }
        } catch (err) {
          log('warn', 'Could not get video element for Clappr player', err);
        }
      });

      // Event listeners
      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_PLAY, () => {
        log('info', 'Playback started');
        setLoading(false);
        setError(null);
        retryCountRef.current = 0; // Reset retry count on successful playback
        lastPlayingTimeRef.current = Date.now();

        // Clear stall timer when playing resumes
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }

        // Detect video quality - must do this on 'play' event for HLS streams
        try {
          const videoEl = videoElementRef.current;
          if (videoEl) {
            const height = videoEl.videoHeight;
            const width = videoEl.videoWidth;
            let quality = null;

            if (height >= 2160) {
              quality = '4K';
            } else if (height >= 1440) {
              quality = '2K';
            } else if (height >= 1080) {
              quality = '1080p';
            } else if (height >= 720) {
              quality = '720p';
            } else if (height >= 480) {
              quality = '480p';
            } else if (height > 0) {
              quality = `${height}p`;
            }

            if (quality) {
              const qualityInfo = { resolution: quality, width, height };
              log('info', `Video quality detected: ${quality} (${width}x${height})`);
              setVideoQuality(qualityInfo);
              if (onQualityDetected) {
                onQualityDetected(qualityInfo);
              }
            }
          }
        } catch (err) {
          log('warn', 'Could not detect video quality for Clappr player', err);
        }
      });

      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_TIMEUPDATE, () => {
        // Update last playing time when video is progressing
        lastPlayingTimeRef.current = Date.now();

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

        // Set a timer to detect if we're stuck
        stallTimerRef.current = setTimeout(() => {
          // Don't recover if channel has changed
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, ignoring stall');
            return;
          }

          const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

          if (timeSinceLastPlaying > 10000) { // Stalled for more than 10 seconds
            log('error', `Clappr stalled for ${timeSinceLastPlaying}ms - attempting recovery`);

            const MAX_RETRIES = 3;
            const retryCount = retryCountRef.current;

            if (retryCount < MAX_RETRIES) {
              retryCountRef.current++;
              log('info', `Recovering from stall (${retryCount + 1}/${MAX_RETRIES})...`);
              setError(`Stream stalled - recovering (${retryCount + 1}/${MAX_RETRIES})...`);

              cleanupPlayer();
              initializeClapprPlayer();
            } else {
              log('error', `Stream stalled after ${MAX_RETRIES} recovery attempts`);
              setError('Stream appears to be frozen. Try selecting another channel or refresh the page.');
            }
          }
        }, 12000); // Check after 12 seconds of waiting/stalling
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
        log('error', 'Player error', { error });
        setLoading(false);

        // Attempt auto-recovery with exponential backoff
        const MAX_RETRIES = 3;
        const retryCount = retryCountRef.current;
        const errorChannelId = getChannelId();

        // Don't retry if channel has changed (e.g., during auto-test)
        if (errorChannelId !== currentChannelIdRef.current) {
          log('info', 'Channel changed, skipping retry');
          return;
        }

        if (retryCount < MAX_RETRIES) {
          const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 8000); // Max 8 seconds
          retryCountRef.current++;

          log('info', `Stream error - attempting recovery (${retryCount + 1}/${MAX_RETRIES}) in ${retryDelay/1000}s...`);
          setError(`Stream error - retrying (${retryCount + 1}/${MAX_RETRIES})...`);

          retryTimerRef.current = setTimeout(() => {
            // Double-check channel hasn't changed during the delay
            if (getChannelId() !== currentChannelIdRef.current) {
              log('info', 'Channel changed during retry delay, aborting');
              return;
            }
            log('info', 'Retrying stream...');
            cleanupPlayer();
            initializeClapprPlayer();
          }, retryDelay);
          return;
        }

        // Max retries exceeded - show error
        log('error', `Stream failed after ${MAX_RETRIES} retry attempts`);
        setError('Error playing stream. Try another method.');
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
    
    log('info', 'Initializing mpegts.js player');

    // Get URL for TS stream
    let baseTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
    // Add sourceId if available to ensure we only search in the correct IPTV source
    if (selectedChannel?.sourceId) {
      baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
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
      containerRef.current.appendChild(videoEl);

      // Store video element reference for health checks
      videoElementRef.current = videoEl;

      if (window.mpegts.getFeatureList().mseLivePlayback) {
        const player = window.mpegts.createPlayer({
          type: 'mse',
          url: proxyTsUrl,
          isLive: true,
          enableStashBuffer: false,
          // Buffer management - increased for better handling
          liveBufferLatencyChasing: true,
          maxBufferSize: 64 * 1024 * 1024, // 64MB - increased from 32MB
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackBufferSize: 32 * 1024 * 1024, // Clean up old buffer
          // Retry on error
          enableWorker: false, // Disable worker to avoid threading issues
          lazyLoad: false,
          lazyLoadMaxDuration: 3 * 60, // 3 minutes
          lazyLoadRecoverDuration: 30 // 30 seconds
        });
        
        player.attachMediaElement(videoEl);

        // Add error event listener before loading
        player.on(window.mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
          log('error', 'mpegts player error', { errorType, errorDetail, errorInfo });
          setLoading(false);

          // Attempt auto-recovery with exponential backoff
          const MAX_RETRIES = 3;
          const retryCount = retryCountRef.current;
          const errorChannelId = getChannelId();

          // Don't retry if channel has changed (e.g., during auto-test)
          if (errorChannelId !== currentChannelIdRef.current) {
            log('info', 'Channel changed, skipping retry');
            return;
          }

          if (retryCount < MAX_RETRIES) {
            const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 8000); // Max 8 seconds
            retryCountRef.current++;

            log('info', `Stream error - attempting recovery (${retryCount + 1}/${MAX_RETRIES}) in ${retryDelay/1000}s...`);
            setError(`Stream error - retrying (${retryCount + 1}/${MAX_RETRIES})...`);

            retryTimerRef.current = setTimeout(() => {
              // Double-check channel hasn't changed during the delay
              if (getChannelId() !== currentChannelIdRef.current) {
                log('info', 'Channel changed during retry delay, aborting');
                return;
              }
              log('info', 'Retrying stream...');
              cleanupPlayer();
              initializeMpegtsPlayer();
            }, retryDelay);
            return;
          }

          // Max retries exceeded - show error
          log('error', `Stream failed after ${MAX_RETRIES} retry attempts`);

          // Handle specific error types
          if (errorType === window.mpegts.ErrorTypes.NETWORK_ERROR) {
            if (errorDetail === window.mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID) {
              // HTTP error (like 404)
              const statusCode = errorInfo?.code || 'unknown';
              const message = errorInfo?.msg || 'Unknown error';
              setError(`Channel not found or unavailable (HTTP ${statusCode}: ${message}). Try selecting a different channel or checking your IPTV source.`);
            } else {
              setError(`Network error loading stream: ${errorDetail}. Check your connection and try again.`);
            }
          } else if (errorType === window.mpegts.ErrorTypes.MEDIA_ERROR) {
            setError(`Media error: The stream format is not supported or the stream is corrupted. Try another channel.`);
          } else {
            setError(`Stream playback error. Try another channel or player method.`);
          }
        });

        player.load();

        videoEl.addEventListener('playing', () => {
          log('info', 'Video playing');
          setLoading(false);
          setError(null);
          retryCountRef.current = 0; // Reset retry count on successful playback
          lastPlayingTimeRef.current = Date.now();
          lastKnownCurrentTimeRef.current = videoEl.currentTime;

          // Clear stall timer when playing resumes
          if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
            stallTimerRef.current = null;
          }

          // Detect video quality - must do this on 'playing' event for HLS/MPEG-TS streams
          const height = videoEl.videoHeight;
          const width = videoEl.videoWidth;
          let quality = null;

          if (height >= 2160) {
            quality = '4K';
          } else if (height >= 1440) {
            quality = '2K';
          } else if (height >= 1080) {
            quality = '1080p';
          } else if (height >= 720) {
            quality = '720p';
          } else if (height >= 480) {
            quality = '480p';
          } else if (height > 0) {
            quality = `${height}p`;
          }

          if (quality) {
            const qualityInfo = { resolution: quality, width, height };
            log('info', `Video quality detected: ${quality} (${width}x${height})`);
            setVideoQuality(qualityInfo);
            if (onQualityDetected) {
              onQualityDetected(qualityInfo);
            }
          }

          // Start proactive health check
          startHealthCheck();
        });

        videoEl.addEventListener('timeupdate', () => {
          // Update last playing time when video is progressing
          lastPlayingTimeRef.current = Date.now();

          // Clear stall timer on normal playback
          if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
            stallTimerRef.current = null;
          }
        });

        // Stall detection - when video stops buffering/loading
        const handleStall = (eventType) => {
          log('warn', `Video ${eventType} - checking for stall`);
          const stallChannelId = getChannelId();

          // Clear any existing stall timer
          if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
          }

          // Set a timer to detect if we're stuck
          stallTimerRef.current = setTimeout(() => {
            // Don't recover if channel has changed
            if (getChannelId() !== currentChannelIdRef.current) {
              log('info', 'Channel changed, ignoring stall');
              return;
            }

            const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

            if (timeSinceLastPlaying > 10000) { // Stalled for more than 10 seconds
              log('error', `Video stalled for ${timeSinceLastPlaying}ms - attempting recovery`);

              const MAX_RETRIES = 3;
              const retryCount = retryCountRef.current;

              if (retryCount < MAX_RETRIES) {
                retryCountRef.current++;
                log('info', `Recovering from stall (${retryCount + 1}/${MAX_RETRIES})...`);
                setError(`Stream stalled - recovering (${retryCount + 1}/${MAX_RETRIES})...`);

                cleanupPlayer();
                initializeMpegtsPlayer();
              } else {
                log('error', `Stream stalled after ${MAX_RETRIES} recovery attempts`);
                setError('Stream appears to be frozen. Try selecting another channel or refresh the page.');
              }
            }
          }, 12000); // Check after 12 seconds of waiting/stalling
        };

        videoEl.addEventListener('waiting', () => handleStall('waiting'));
        videoEl.addEventListener('stalled', () => handleStall('stalled'));

        videoEl.addEventListener('error', () => {
          log('error', 'Video error', { error: videoEl.error });
          setError('Error playing video. Try another method or channel.');
          setLoading(false);
        });

        // Handle unexpected stream end for live streams
        videoEl.addEventListener('ended', () => {
          log('warn', 'Live stream ended unexpectedly - attempting recovery');

          // Don't recover if channel has changed
          if (getChannelId() !== currentChannelIdRef.current) {
            log('info', 'Channel changed, ignoring stream end');
            return;
          }

          const MAX_RETRIES = 3;
          const retryCount = retryCountRef.current;

          if (retryCount < MAX_RETRIES) {
            retryCountRef.current++;
            log('info', `Recovering from stream end (${retryCount + 1}/${MAX_RETRIES})...`);
            setError(`Stream ended - reconnecting (${retryCount + 1}/${MAX_RETRIES})...`);

            // Wait a moment before retrying
            setTimeout(() => {
              if (getChannelId() !== currentChannelIdRef.current) {
                log('info', 'Channel changed during retry delay, aborting');
                return;
              }
              cleanupPlayer();
              initializeMpegtsPlayer();
            }, 2000);
          } else {
            log('error', `Stream ended after ${MAX_RETRIES} recovery attempts`);
            setError('Stream disconnected and cannot be recovered. Try another channel or refresh the page.');
          }
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
    console.log('[IPTVPlayer] renderControlButtons called, theatreMode:', theatreMode, 'typeof:', typeof theatreMode);

    if (theatreMode === true || theatreMode === 'true') {
      console.log('[IPTVPlayer] Skipping button render - in theatre mode');
      return null;
    }

    console.log('[IPTVPlayer] Rendering control buttons - not in theatre mode');
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
      
      {/* Error message */}
      {error && (
        <div style={{
          position: 'absolute',
          top: '50px',
          left: '10px',
          right: showDebug ? '270px' : '10px',
          padding: '10px 15px',
          backgroundColor: 'rgba(220, 53, 69, 0.85)',
          color: 'white',
          borderRadius: '8px',
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          backdropFilter: 'blur(5px)'
        }}>
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="18" 
            height="18" 
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
          <span>{error}</span>
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

      {/* Error notification overlay */}
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

export default IPTVPlayer;