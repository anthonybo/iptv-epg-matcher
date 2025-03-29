import React, { useEffect, useRef, useState } from 'react';

/**
 * Enhanced VideoPlayer component that handles various streaming formats
 * and provides better error handling and fallback mechanisms
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} VideoPlayer component
 */
const VideoPlayer = ({ sessionId, selectedChannel }) => {
  // Refs for video element, HLS instance and container
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const containerRef = useRef(null);
  
  // Component state
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [streamUrl, setStreamUrl] = useState('');
  const [fallbackMode, setFallbackMode] = useState(false);
  const [logMessages, setLogMessages] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  
  // Unique ID for preventing React key warnings
  const logId = useRef(0);
  
  // Enhanced logging function
  const log = (level, message, data = null) => {
    const timestamp = new Date().toISOString();
    const prefix = level.toUpperCase();
    const logMessage = `[${prefix}] ${message}`;
    
    // Console logging with colors
    let consoleStyle = '';
    switch (level) {
      case 'info': consoleStyle = 'color: #2196F3'; break;
      case 'success': consoleStyle = 'color: #4CAF50'; break;
      case 'warn': consoleStyle = 'color: #FFC107'; break;
      case 'error': consoleStyle = 'color: #F44336'; break;
      case 'debug': consoleStyle = 'color: #9C27B0'; break;
      default: consoleStyle = 'color: #333';
    }
    
    console.log(`%c${logMessage}`, consoleStyle, data || '');
    
    // Add to component state for UI display
    setLogMessages(prev => [
      ...prev, 
      { 
        id: `log_${timestamp}_${logId.current++}`,
        level, 
        message, 
        data: data ? JSON.stringify(data) : null,
        timestamp
      }
    ].slice(-50)); // Keep only last 50 logs
  };

  // Initial component setup
  useEffect(() => {
    log('info', 'VideoPlayer component mounting');
    
    // Clean up on unmount
    return () => {
      log('info', 'VideoPlayer component unmounting');
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch (e) {
          console.error('Error destroying HLS instance:', e);
        }
        hlsRef.current = null;
      }
    };
  }, []);

  // Load HLS.js dynamically
  useEffect(() => {
    if (window.Hls) {
      log('info', 'HLS.js already loaded');
      return;
    }
    
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.10/dist/hls.min.js'; // Using specific version
    script.async = true;
    script.onload = () => {
      log('success', 'HLS.js loaded successfully');
      if (window.Hls && window.Hls.isSupported()) {
        log('info', 'HLS.js is supported in this browser');
      } else {
        log('warn', 'HLS.js is not supported in this browser');
      }
    };
    script.onerror = () => {
      log('error', 'Failed to load HLS.js');
      setError('Failed to load video player library');
    };
    
    document.head.appendChild(script);
    
    return () => {
      // Clean up script if component unmounts during loading
      if (document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, []);

  // Configure direct playback (used as fallback)
  const setupDirectPlayback = (url) => {
    if (!videoRef.current) return;
    
    log('info', 'Setting up direct playback', { url });
    setFallbackMode(true);
    
    const video = videoRef.current;
    video.src = url;
    video.load();
    
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          log('success', 'Direct playback started');
          setLoading(false);
          setPlaying(true);
          setError(null);
        })
        .catch(err => {
          log('error', 'Direct playback failed', { error: err.message });
          setError('Autoplay prevented. Click play button to start.');
          setLoading(false);
        });
    }
  };

  // Update stream when channel changes
  useEffect(() => {
    if (!sessionId || !selectedChannel) {
      log('warn', 'No channel or session available');
      setStreamUrl('');
      return;
    }

    // Reset state
    setError(null);
    setLoading(true);
    setPlaying(false);
    setFallbackMode(false);
    
    log('info', 'Channel selected for playback', { 
      name: selectedChannel.name, 
      id: selectedChannel.tvgId,
      group: selectedChannel.groupTitle
    });

    // Strategy 1: Try direct TS URL first (more reliable)
    const directTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
    log('info', 'Using direct TS URL for playback', { url: directTsUrl });
    setStreamUrl(directTsUrl);
    
    // If we have a direct URL from the channel, keep it as a backup
    const backupUrl = selectedChannel.url || '';
    
    // Clean up previous HLS instance if it exists
    if (hlsRef.current) {
      log('debug', 'Destroying previous HLS instance');
      try {
        hlsRef.current.destroy();
      } catch (e) {
        console.error('Error destroying HLS instance:', e);
      }
      hlsRef.current = null;
    }
    
    // Clear video source
    if (videoRef.current) {
      videoRef.current.src = '';
      videoRef.current.load();
    }
    
    // Setup direct playback - simpler and more reliable approach
    if (videoRef.current) {
      setupDirectPlayback(directTsUrl);
    }
  }, [sessionId, selectedChannel]);

  // Set up video element event handlers
  useEffect(() => {
    if (!videoRef.current) return;
    
    const video = videoRef.current;
    
    const onWaiting = () => {
      log('info', 'Video buffering');
      setLoading(true);
    };
    
    const onPlaying = () => {
      log('success', 'Video playing');
      setLoading(false);
      setPlaying(true);
    };
    
    const onPause = () => {
      log('info', 'Video paused');
      setPlaying(false);
    };
    
    const onEnded = () => {
      log('info', 'Video playback ended');
      setPlaying(false);
    };
    
    const onError = () => {
      const videoError = video.error;
      log('error', 'Video element error', { 
        code: videoError?.code, 
        message: videoError?.message 
      });
      
      // If we're in direct mode and encounter an error, try the original channel URL
      if (fallbackMode && selectedChannel && selectedChannel.url) {
        log('info', 'Trying original channel URL as fallback', { url: selectedChannel.url });
        setupDirectPlayback(selectedChannel.url);
      } else {
        setError(`Playback error: ${videoError?.message || 'Unknown error'}`);
        setLoading(false);
      }
    };
    
    // Add event listeners
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    
    // Clean up on unmount
    return () => {
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
    };
  }, [fallbackMode, selectedChannel]);

  // Manual play button handler
  const handlePlay = () => {
    if (!videoRef.current) return;
    
    log('info', 'Manual play button clicked');
    const video = videoRef.current;
    
    video.play()
      .then(() => {
        log('success', 'Playback started via play button');
        setPlaying(true);
        setError(null);
      })
      .catch(err => {
        log('error', 'Manual play failed', { error: err.message });
        setError(`Cannot play video: ${err.message}`);
      });
  };

  return (
    <div
      ref={containerRef}
      className="video-player"
      style={{
        position: 'relative',
        width: '100%',
        height: '400px',
        backgroundColor: '#000',
        borderRadius: '4px',
        overflow: 'hidden'
      }}
    >
      {/* Toggle logs button */}
      <button
        onClick={() => setShowLogs(!showLogs)}
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          zIndex: 20,
          background: '#333',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          padding: '5px 10px',
          cursor: 'pointer',
          fontSize: '12px'
        }}
      >
        {showLogs ? 'Hide Logs' : 'Show Logs'}
      </button>
      
      {/* Logs display */}
      {showLogs && (
        <div
          style={{
            position: 'absolute',
            top: '40px',
            right: '10px',
            bottom: '10px',
            width: '50%',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            zIndex: 15,
            padding: '10px',
            overflow: 'auto',
            fontSize: '12px',
            fontFamily: 'monospace',
            borderRadius: '4px'
          }}
        >
          <button
            onClick={() => setLogMessages([])}
            style={{
              background: '#F44336',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              padding: '3px 8px',
              cursor: 'pointer',
              fontSize: '10px',
              marginBottom: '10px'
            }}
          >
            Clear Logs
          </button>
          
          {logMessages.map(log => (
            <div
              key={log.id}
              style={{
                padding: '2px 5px',
                margin: '2px 0',
                backgroundColor: 
                  log.level === 'error' ? 'rgba(244, 67, 54, 0.3)' :
                  log.level === 'warn' ? 'rgba(255, 193, 7, 0.3)' :
                  log.level === 'success' ? 'rgba(76, 175, 80, 0.3)' :
                  log.level === 'info' ? 'rgba(33, 150, 243, 0.3)' :
                  'rgba(156, 39, 176, 0.3)',
                borderRadius: '2px'
              }}
            >
              <span style={{ opacity: 0.7, fontSize: '0.8em' }}>
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              {' '}{log.message}
              {log.data && (
                <div style={{ fontSize: '10px', color: '#aaa', marginTop: '2px', wordBreak: 'break-all' }}>
                  {log.data}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Error message */}
      {error && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            left: '10px',
            right: showLogs ? '52%' : '10px',
            zIndex: 10,
            padding: '10px',
            backgroundColor: 'rgba(244, 67, 54, 0.8)',
            color: 'white',
            borderRadius: '4px',
            textAlign: 'center'
          }}
        >
          {error}
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 9,
            padding: '10px 20px',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            borderRadius: '4px'
          }}
        >
          Loading...
        </div>
      )}

      {/* Play button */}
      {!playing && !loading && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 10
          }}
        >
          <button
            onClick={handlePlay}
            style={{
              padding: '15px',
              width: '60px',
              height: '60px',
              backgroundColor: 'rgba(33, 150, 243, 0.8)',
              color: 'white',
              border: 'none',
              borderRadius: '50%',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5,3 19,12 5,21" fill="white" />
            </svg>
          </button>
        </div>
      )}

      {/* Video element */}
      <video
        ref={videoRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain'
        }}
        controls
        playsInline
      ></video>

      {/* Channel info */}
      {selectedChannel && (
        <div
          style={{
            position: 'absolute',
            bottom: '10px',
            left: '10px',
            right: showLogs ? '52%' : '10px',
            padding: '5px 10px',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            fontSize: '14px',
            borderRadius: '4px',
            zIndex: 8
          }}
        >
          {selectedChannel.name} - {selectedChannel.groupTitle}
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;