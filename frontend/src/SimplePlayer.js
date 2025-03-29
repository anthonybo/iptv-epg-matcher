import React, { useEffect, useRef, useState } from 'react';

/**
 * SimplePlayer - Enhanced with VideoJS for better IPTV stream compatibility
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} SimplePlayer component
 */
const SimplePlayer = ({ sessionId, selectedChannel }) => {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [streamMode, setStreamMode] = useState('proxy'); // 'proxy', 'direct', or 'hls'
  const [isVideoJSReady, setIsVideoJSReady] = useState(false);

  // Logger function
  const log = (level, message, data = null) => {
    const prefix = level.toUpperCase();
    console.log(`[${prefix}] ${message}`, data || '');
  };

  // Load VideoJS on component mount
  useEffect(() => {
    log('INFO', 'SimplePlayer component mounting');
    
    // Only load scripts if they haven't been loaded already
    if (window.videojs) {
      log('INFO', 'VideoJS already loaded');
      setIsVideoJSReady(true);
      return;
    }
    
    // Load CSS
    const loadCSS = () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://vjs.zencdn.net/7.20.3/video-js.css';
      document.head.appendChild(link);
      return link;
    };
    
    // Load script helper
    const loadScript = (src, callback) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = callback;
      document.head.appendChild(script);
      return script;
    };
    
    // Load the CSS
    const css = loadCSS();
    
    // Load VideoJS
    const vjsScript = loadScript('https://vjs.zencdn.net/7.20.3/video.min.js', () => {
      log('INFO', 'VideoJS loaded');
      
      // Load HTTP Streaming extension for HLS support
      const httpStreamingScript = loadScript('https://cdn.jsdelivr.net/npm/@videojs/http-streaming@2.16.0/dist/videojs-http-streaming.min.js', () => {
        log('INFO', 'VideoJS HTTP Streaming loaded');
        setIsVideoJSReady(true);
      });
    });
    
    return () => {
      log('INFO', 'SimplePlayer component unmounting');
      
      // Clean up VideoJS
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, []);

  // Initialize the VideoJS player when it's ready and we have a video element
  useEffect(() => {
    // Only initialize if VideoJS is loaded and we have a video element
    if (!isVideoJSReady || !videoRef.current || playerRef.current) {
      return;
    }
    
    try {
      // Initialize player with optimal settings for IPTV streams
      playerRef.current = window.videojs(videoRef.current, {
        autoplay: true,
        controls: true,
        fluid: true,
        liveui: true,
        responsive: true,
        preload: 'auto',
        html5: {
          vhs: {
            overrideNative: true,
            limitRenditionByPlayerDimensions: false,
            useBandwidthFromLocalStorage: true,
            handleManifestRedirects: true
          },
          nativeAudioTracks: false,
          nativeVideoTracks: false
        }
      });
      
      // Player ready event
      playerRef.current.ready(() => {
        log('INFO', 'VideoJS player ready');
        
        // Set up event handlers
        playerRef.current.on('error', (e) => {
          const error = playerRef.current.error();
          log('ERROR', 'VideoJS player error', { 
            code: error?.code, 
            message: error?.message 
          });
          
          setError(`Playback error: ${error?.message || 'Unknown error'}`);
          setLoading(false);
          
          // Try fallback if appropriate
          if (streamMode === 'proxy' && selectedChannel?.url) {
            log('INFO', 'Trying direct URL as fallback', { url: selectedChannel.url });
            setStreamMode('direct');
          }
        });
        
        playerRef.current.on('playing', () => {
          log('INFO', 'VideoJS playing');
          setLoading(false);
          setError(null);
        });
        
        playerRef.current.on('waiting', () => {
          log('INFO', 'VideoJS waiting for data');
          setLoading(true);
        });
        
        // Load the channel if available
        if (selectedChannel && sessionId) {
          loadChannel();
        }
      });
    } catch (e) {
      log('ERROR', 'Failed to initialize VideoJS', e);
      setError(`Player initialization failed: ${e.message}`);
    }
  }, [isVideoJSReady, videoRef.current]);

  // Handle channel change or stream mode change
  useEffect(() => {
    if (!playerRef.current || !selectedChannel || !sessionId || !isVideoJSReady) {
      return;
    }
    
    loadChannel();
  }, [selectedChannel, sessionId, streamMode, isVideoJSReady]);

  // Function to load selected channel
  const loadChannel = () => {
    if (!playerRef.current || !selectedChannel || !sessionId) {
      return;
    }
    
    setLoading(true);
    setError(null);
    
    log('INFO', 'Loading channel', { 
      name: selectedChannel.name, 
      id: selectedChannel.tvgId,
      mode: streamMode
    });
    
    try {
      let streamUrl;
      
      // Choose URL based on mode
      if (streamMode === 'direct' && selectedChannel.url) {
        // Use direct channel URL from provider
        streamUrl = selectedChannel.url;
        log('INFO', 'Using direct channel URL', { url: streamUrl });
      } else if (streamMode === 'hls') {
        // Use HLS format from proxy
        streamUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}`;
        log('INFO', 'Using HLS proxy URL', { url: streamUrl });
      } else {
        // Use TS format from proxy (default)
        streamUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
        log('INFO', 'Using TS proxy URL', { url: streamUrl });
      }
      
      // Set the source and play
      playerRef.current.src({
        src: streamUrl,
        type: streamMode === 'hls' ? 'application/x-mpegURL' : 'video/mp2t'
      });
      
      playerRef.current.play()
        .catch(err => {
          log('WARN', 'Autoplay prevented', { error: err.message });
          setError('Click to play');
          setLoading(false);
        });
    } catch (e) {
      log('ERROR', 'Error setting video source', e);
      setError(`Error starting playback: ${e.message}`);
      setLoading(false);
    }
  };

  // Toggle stream mode
  const toggleStreamMode = () => {
    if (streamMode === 'proxy') {
      setStreamMode('direct');
    } else if (streamMode === 'direct') {
      setStreamMode('hls');
    } else {
      setStreamMode('proxy');
    }
  };

  // Retry playback
  const handleRetry = () => {
    if (!playerRef.current) return;
    
    setLoading(true);
    setError(null);
    
    try {
      playerRef.current.play()
        .catch(err => {
          log('ERROR', 'Play failed on retry', { error: err.message });
          setError(`Cannot play video: ${err.message}`);
          setLoading(false);
        });
    } catch (e) {
      log('ERROR', 'Error on retry', e);
      setError(`Retry failed: ${e.message}`);
      setLoading(false);
    }
  };

  return (
    <div 
      ref={containerRef}
      style={{ 
        position: 'relative', 
        width: '100%', 
        height: '400px', 
        backgroundColor: '#000',
        borderRadius: '4px',
        overflow: 'hidden'
      }}
    >
      {/* Mode indicator */}
      <div style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        zIndex: 10,
        padding: '5px 10px',
        backgroundColor: 'rgba(0,0,0,0.7)',
        color: streamMode === 'proxy' ? '#2196F3' : 
               streamMode === 'direct' ? '#4CAF50' : '#FF9800',
        borderRadius: '4px',
        fontSize: '14px',
        cursor: 'pointer'
      }} onClick={toggleStreamMode}>
        {streamMode === 'proxy' ? 'Proxy Stream' : 
         streamMode === 'direct' ? 'Direct Stream' : 'HLS Stream'}
      </div>

      {/* Error message */}
      {error && (
        <div style={{ 
          position: 'absolute', 
          top: '10px', 
          left: '10px', 
          right: '70px',
          zIndex: 10,
          padding: '10px', 
          background: 'rgba(255, 0, 0, 0.7)', 
          color: 'white',
          borderRadius: '4px',
          textAlign: 'center'
        }}>
          {error}
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          zIndex: 5,
          padding: '10px 20px', 
          background: 'rgba(0, 0, 0, 0.7)', 
          color: 'white',
          borderRadius: '4px'
        }}>
          Loading...
        </div>
      )}

      {/* Retry button - shown on error */}
      {error && (
        <div style={{
          position: 'absolute',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10
        }}>
          <button
            onClick={handleRetry}
            style={{
              padding: '8px 16px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '10px'
            }}
          >
            Retry
          </button>
          <button
            onClick={toggleStreamMode}
            style={{
              padding: '8px 16px',
              backgroundColor: '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Try {streamMode === 'proxy' ? 'Direct' : 
                 streamMode === 'direct' ? 'HLS' : 'Proxy'}
          </button>
        </div>
      )}

      {/* No channel message */}
      {!selectedChannel && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#999',
          textAlign: 'center'
        }}>
          Select a channel to play
        </div>
      )}

      {/* VideoJS player */}
      <div data-vjs-player style={{ width: '100%', height: '100%' }}>
        <video
          ref={videoRef}
          className="video-js vjs-big-play-centered vjs-fluid"
          playsInline
        ></video>
      </div>

      {/* Channel info bar */}
      {selectedChannel && (
        <div style={{ 
          position: 'absolute', 
          bottom: '60px', 
          left: '10px', 
          right: '10px',
          padding: '5px 10px', 
          background: 'rgba(0, 0, 0, 0.7)', 
          color: 'white',
          borderRadius: '4px',
          fontSize: '14px',
          zIndex: 4
        }}>
          {selectedChannel.name} - {selectedChannel.groupTitle}
        </div>
      )}
    </div>
  );
};

export default SimplePlayer;