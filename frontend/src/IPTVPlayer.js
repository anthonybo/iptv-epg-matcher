import React, { useEffect, useRef, useState } from 'react';

/**
 * Enhanced IPTVPlayer - Browser-compatible player for IPTV streams
 * With improved UI and toggleable info overlays for channel info and EPG data
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @param {string} props.playbackMethod Which playback method to use
 * @param {Object} props.matchedChannels Object mapping channel IDs to matched EPG IDs
 * @returns {JSX.Element} IPTVPlayer component
 */
const IPTVPlayer = ({ 
  sessionId, 
  selectedChannel, 
  playbackMethod = 'mpegts-player',
  matchedChannels = {}
}) => {
  // State
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showDebug, setShowDebug] = useState(false);
  const [showChannelInfo, setShowChannelInfo] = useState(true);
  const [showEpgInfo, setShowEpgInfo] = useState(true); // New state for EPG toggle
  const [epgData, setEpgData] = useState(null);
  
  // Refs
  const containerRef = useRef(null);
  const playerInstanceRef = useRef(null);
  const logIdRef = useRef(0);
  
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
    
    // Load required scripts
    loadScripts();
    
    // Show channel info by default, but only show EPG info if there's a match
    setShowChannelInfo(true);
    setShowEpgInfo(true);
    
    return () => {
      log('info', 'IPTVPlayer component unmounting');
      cleanupPlayer();
    };
  }, []);

  // Try to load EPG data when channel changes
  useEffect(() => {
    if (sessionId && selectedChannel && selectedChannel.tvgId) {
      // Only fetch EPG data if the channel has a matched EPG ID
      if (matchedChannels[selectedChannel.tvgId]) {
        const epgId = matchedChannels[selectedChannel.tvgId];
        log('info', 'Fetching EPG data for matched channel', { 
          channelId: selectedChannel.tvgId, 
          matchedEpgId: epgId
        });
        
        fetchEpgData(epgId);
      } else {
        // Clear EPG data when there's no match
        setEpgData(null);
        log('info', 'No EPG match for channel, clearing EPG data', { 
          channelId: selectedChannel.tvgId
        });
      }
    }
  }, [sessionId, selectedChannel, matchedChannels]);
  
  // Fetch EPG data for the current channel using proper ID
  const fetchEpgData = async (epgId) => {
    if (!sessionId || !epgId) return;
    
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
      id: selectedChannel.tvgId
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
    if (playerInstanceRef.current) {
      log('info', 'Destroying player instance');
      try {
        playerInstanceRef.current.destroy();
      } catch (e) {
        log('error', 'Error destroying player', { error: e.message });
      }
      playerInstanceRef.current = null;
    }
  };

  // Initialize the appropriate player
  const initializePlayer = () => {
    cleanupPlayer();
    
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
    const proxyHlsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}`;
    
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
      
      // Event listeners
      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_PLAY, () => {
        log('info', 'Playback started');
        setLoading(false);
        setError(null);
      });
      
      playerInstanceRef.current.on(window.Clappr.Events.PLAYER_ERROR, (error) => {
        log('error', 'Player error', { error });
        setError('Error playing stream. Try another method.');
        setLoading(false);
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
    if (selectedChannel && url.includes(selectedChannel.tvgId) && !url.includes(encodeURIComponent(selectedChannel.tvgId))) {
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
    let proxyTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
    
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
      videoEl.controls = true;
      containerRef.current.appendChild(videoEl);
      
      if (window.mpegts.getFeatureList().mseLivePlayback) {
        const player = window.mpegts.createPlayer({
          type: 'mse',
          url: proxyTsUrl,
          isLive: true,
          enableStashBuffer: false,
          // Add retry options
          liveBufferLatencyChasing: true,
          maxBufferSize: 32 * 1024 * 1024, // 32MB
          autoCleanupSourceBuffer: true
        });
        
        player.attachMediaElement(videoEl);
        player.load();
        
        videoEl.addEventListener('playing', () => {
          log('info', 'Video playing');
          setLoading(false);
          setError(null);
        });
        
        videoEl.addEventListener('error', () => {
          log('error', 'Video error', { error: videoEl.error });
          setError('Error playing video. Try another method or channel.');
          setLoading(false);
        });
        
        player.play().catch(e => {
          log('warn', 'Autoplay prevented', { error: e.message });
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
    
    const proxyTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
    
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
    videoEl.controls = true;
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
      log('warn', 'Autoplay prevented', { error: e.message });
    });
  };

  // Toggle debug panel
  const toggleDebug = () => {
    setShowDebug(prev => !prev);
  };

  // Toggle channel info overlay
  const toggleChannelInfo = () => {
    setShowChannelInfo(prev => !prev);
  };
  
  // Toggle EPG info overlay
  const toggleEpgInfo = () => {
    setShowEpgInfo(prev => !prev);
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

  return (
    <div style={{ 
      position: 'relative', 
      width: '100%', 
      height: '400px',
      backgroundColor: '#000',
      borderRadius: '8px',
      overflow: 'hidden',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
    }}>
      {/* Control buttons section */}
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
            backgroundColor: selectedChannel && matchedChannels[selectedChannel.tvgId] ? 'rgba(0, 150, 50, 0.5)' : 'rgba(0, 0, 0, 0.5)',
            color: 'white',
            border: selectedChannel && matchedChannels[selectedChannel.tvgId] ? '2px solid rgba(0, 255, 100, 0.5)' : 'none',
            borderRadius: '50%',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            position: 'relative'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = selectedChannel && matchedChannels[selectedChannel.tvgId] ? 'rgba(0, 180, 60, 0.8)' : 'rgba(30, 30, 30, 0.8)'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = selectedChannel && matchedChannels[selectedChannel.tvgId] ? 'rgba(0, 150, 50, 0.5)' : 'rgba(0, 0, 0, 0.5)'}
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
      </div>
      
      {/* EPG Status notification */}
      {selectedChannel && !matchedChannels[selectedChannel.tvgId] && (
        <div style={{
          position: 'absolute',
          top: '50px',
          left: '10px',
          padding: '8px 12px',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: '#f8f8f8',
          borderRadius: '6px',
          zIndex: 35,
          fontSize: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          backdropFilter: 'blur(3px)',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          maxWidth: '300px'
        }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>Match this channel with EPG data to see program information.</span>
        </div>
      )}
      
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
                <strong>Channel ID:</strong> {selectedChannel.tvgId}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <strong>Group:</strong> {selectedChannel.groupTitle}
              </div>
              {matchedChannels[selectedChannel.tvgId] && (
                <div style={{ marginBottom: '5px', color: '#81c784' }}>
                  <strong>Matched EPG ID:</strong> {matchedChannels[selectedChannel.tvgId]}
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
              {selectedChannel.groupTitle}
            </div>
          </div>
        </>
      )}
      
      {/* EPG info overlay (toggleable) - Only shown when there's a matched EPG ID */}
      {selectedChannel && showEpgInfo && epgData && epgData.currentProgram && matchedChannels[selectedChannel.tvgId] && (
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