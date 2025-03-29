import React, { useEffect, useRef, useState } from 'react';

/**
 * UniversalPlayer - A comprehensive player that tries multiple approaches to play IPTV streams
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} UniversalPlayer component
 */
const UniversalPlayer = ({ sessionId, selectedChannel }) => {
  // Component state
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [playbackMethod, setPlaybackMethod] = useState('iframe'); // 'iframe', 'hls', 'native', 'videojs'
  const [streamUrl, setStreamUrl] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState([]);
  const [userInteracted, setUserInteracted] = useState(false);

  // Refs
  const videoRef = useRef(null);
  const iframeRef = useRef(null);
  const hlsInstanceRef = useRef(null);
  const videojsPlayerRef = useRef(null);
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
    ].slice(-50)); // Keep only last 50 logs
  };

  // Load required scripts
  useEffect(() => {
    log('info', 'UniversalPlayer component mounting');
    
    // Load HLS.js if not already loaded
    if (!window.Hls) {
      const hlsScript = document.createElement('script');
      hlsScript.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
      hlsScript.async = true;
      hlsScript.onload = () => log('info', 'HLS.js loaded successfully');
      hlsScript.onerror = () => log('error', 'Failed to load HLS.js');
      document.head.appendChild(hlsScript);
    }
    
    // Load Video.js if not already loaded
    if (!window.videojs) {
      // Load CSS
      const videojsCss = document.createElement('link');
      videojsCss.rel = 'stylesheet';
      videojsCss.href = 'https://vjs.zencdn.net/7.20.3/video-js.css';
      document.head.appendChild(videojsCss);
      
      // Load Video.js script
      const videojsScript = document.createElement('script');
      videojsScript.src = 'https://vjs.zencdn.net/7.20.3/video.min.js';
      videojsScript.async = true;
      videojsScript.onload = () => {
        log('info', 'Video.js loaded successfully');
        
        // Load HTTP Streaming extension
        const httpStreamingScript = document.createElement('script');
        httpStreamingScript.src = 'https://cdn.jsdelivr.net/npm/@videojs/http-streaming@2.16.0/dist/videojs-http-streaming.min.js';
        httpStreamingScript.async = true;
        httpStreamingScript.onload = () => log('info', 'Video.js HTTP Streaming loaded');
        document.head.appendChild(httpStreamingScript);
      };
      videojsScript.onerror = () => log('error', 'Failed to load Video.js');
      document.head.appendChild(videojsScript);
    }
    
    return () => {
      log('info', 'UniversalPlayer component unmounting');
      
      // Clean up resources
      cleanupPlayback();
    };
  }, []);

  // Clean up any playback resources
  const cleanupPlayback = () => {
    // Clean up HLS instance
    if (hlsInstanceRef.current) {
      hlsInstanceRef.current.destroy();
      hlsInstanceRef.current = null;
    }
    
    // Clean up Video.js player
    if (videojsPlayerRef.current) {
      videojsPlayerRef.current.dispose();
      videojsPlayerRef.current = null;
    }
    
    // Reset video element
    if (videoRef.current) {
      videoRef.current.src = '';
      videoRef.current.load();
    }
  };

  // Handle channel change
  useEffect(() => {
    if (!sessionId || !selectedChannel) {
      setStreamUrl('');
      setError(null);
      return;
    }

    // Reset state
    setError(null);
    setLoading(true);
    setUserInteracted(false);
    
    // Clean up previous playback
    cleanupPlayback();
    
    log('info', 'Channel selected', {
      name: selectedChannel.name,
      id: selectedChannel.tvgId,
      group: selectedChannel.groupTitle
    });

    // Determine the stream URLs for different methods
    const directUrl = selectedChannel.url || '';
    const proxyTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
    const proxyHlsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}`;
    
    // Start with iframe method (most compatible)
    setPlaybackMethod('iframe');
    
    // Use iFrame for playing the video
    if (playbackMethod === 'iframe') {
      log('info', 'Using iframe method', { url: proxyTsUrl });
      setStreamUrl(proxyTsUrl);
    }
  }, [sessionId, selectedChannel]);

  // Configure iframe when streamUrl changes
  useEffect(() => {
    if (playbackMethod !== 'iframe' || !streamUrl || !iframeRef.current) return;
    
    try {
      const iframe = iframeRef.current;
      const html = getPlayerHtml(streamUrl);
      
      iframe.onload = () => {
        log('info', 'Iframe loaded');
        setLoading(false);
      };
      
      // Use srcdoc for better security and reliability
      iframe.srcdoc = html;
    } catch (err) {
      log('error', 'Error setting up iframe', { error: err.message });
      setError(`Error setting up player: ${err.message}`);
      setLoading(false);
      
      // Try fallback method
      if (selectedChannel) {
        fallbackToNextMethod();
      }
    }
  }, [streamUrl, playbackMethod]);

  // Fallback to the next playback method if current one fails
  const fallbackToNextMethod = () => {
    cleanupPlayback();
    
    if (playbackMethod === 'iframe') {
      // Try HLS method next
      log('info', 'Fallback from iframe to HLS');
      setPlaybackMethod('hls');
      
      // Use HLS URL through the proxy
      const proxyHlsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}`;
      setStreamUrl(proxyHlsUrl);
      setupHlsPlayback(proxyHlsUrl);
    } 
    else if (playbackMethod === 'hls') {
      // Try native method next
      log('info', 'Fallback from HLS to native');
      setPlaybackMethod('native');
      
      // Try direct URL if available, otherwise use proxy TS URL
      const directUrl = selectedChannel.url || '';
      const proxyTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
      const nativeUrl = directUrl || proxyTsUrl;
      
      setStreamUrl(nativeUrl);
      setupNativePlayback(nativeUrl);
    }
    else if (playbackMethod === 'native') {
      // Try Video.js as last resort
      log('info', 'Fallback from native to Video.js');
      setPlaybackMethod('videojs');
      
      // Try proxy TS URL with Video.js
      const proxyTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
      setStreamUrl(proxyTsUrl);
      setupVideoJSPlayback(proxyTsUrl);
    }
    else {
      // We've tried all methods, show error
      log('error', 'All playback methods failed');
      setError('Could not play this channel with any available method. Click manually to try again.');
      setLoading(false);
    }
  };

  // Setup HLS.js playback
  const setupHlsPlayback = (url) => {
    if (!window.Hls || !window.Hls.isSupported() || !videoRef.current) {
      log('warn', 'HLS.js not supported or not loaded');
      fallbackToNextMethod();
      return;
    }
    
    log('info', 'Setting up HLS.js playback', { url });
    setLoading(true);
    
    try {
      const hls = new window.Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: true,
        xhrSetup: (xhr) => {
          // Add custom headers that may help with IPTV streams
          xhr.setRequestHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          xhr.setRequestHeader('Referer', window.location.origin);
        }
      });
      
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
        log('info', 'HLS: Media attached');
        hls.loadSource(url);
      });
      
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        log('info', 'HLS: Manifest parsed');
        videoRef.current.play()
          .then(() => {
            log('info', 'HLS: Playback started');
            setLoading(false);
            setError(null);
          })
          .catch(err => {
            log('warn', 'HLS: Autoplay prevented', { error: err.message });
            setError('Click to play the video');
            setLoading(false);
          });
      });
      
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        log('error', 'HLS error', data);
        if (data.fatal) {
          hls.destroy();
          hlsInstanceRef.current = null;
          fallbackToNextMethod();
        }
      });
      
      hls.attachMedia(videoRef.current);
      hlsInstanceRef.current = hls;
    } catch (err) {
      log('error', 'Error setting up HLS.js', { error: err.message });
      fallbackToNextMethod();
    }
  };

  // Setup native HTML5 video playback
  const setupNativePlayback = (url) => {
    if (!videoRef.current) return;
    
    log('info', 'Setting up native playback', { url });
    setLoading(true);
    
    try {
      const video = videoRef.current;
      video.src = url;
      video.load();
      
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            log('info', 'Native: Playback started');
            setLoading(false);
            setError(null);
          })
          .catch(err => {
            log('warn', 'Native: Autoplay prevented', { error: err.message });
            setError('Click to play the video');
            setLoading(false);
          });
      }
      
      video.onerror = () => {
        log('error', 'Native: Video error', { 
          code: video.error?.code, 
          message: video.error?.message 
        });
        fallbackToNextMethod();
      };
    } catch (err) {
      log('error', 'Error setting up native playback', { error: err.message });
      fallbackToNextMethod();
    }
  };

  // Setup Video.js playback
  const setupVideoJSPlayback = (url) => {
    if (!window.videojs || !videoRef.current) {
      log('warn', 'Video.js not loaded');
      setError('Could not initialize video player');
      setLoading(false);
      return;
    }
    
    log('info', 'Setting up Video.js playback', { url });
    setLoading(true);
    
    try {
      // Clean up any existing instance
      if (videojsPlayerRef.current) {
        videojsPlayerRef.current.dispose();
      }
      
      // Initialize Video.js player
      videojsPlayerRef.current = window.videojs(videoRef.current, {
        autoplay: true,
        controls: true,
        responsive: true,
        fluid: true,
        sources: [{
          src: url,
          type: url.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp2t'
        }],
        html5: {
          vhs: {
            overrideNative: true,
            limitRenditionByPlayerDimensions: false,
            handleManifestRedirects: true
          },
          nativeAudioTracks: false,
          nativeVideoTracks: false
        }
      });
      
      videojsPlayerRef.current.on('error', () => {
        const error = videojsPlayerRef.current.error();
        log('error', 'Video.js error', { 
          code: error.code, 
          message: error.message 
        });
        
        // Display error and stop loading
        setError(`Playback error: ${error.message}`);
        setLoading(false);
      });
      
      videojsPlayerRef.current.on('ready', () => {
        log('info', 'Video.js ready');
        
        videojsPlayerRef.current.play()
          .then(() => {
            log('info', 'Video.js: Playback started');
            setLoading(false);
            setError(null);
          })
          .catch(err => {
            log('warn', 'Video.js: Autoplay prevented', { error: err.message });
            setError('Click to play the video');
            setLoading(false);
          });
      });
    } catch (err) {
      log('error', 'Error setting up Video.js', { error: err.message });
      setError(`Could not initialize player: ${err.message}`);
      setLoading(false);
    }
  };

  // Generate standalone HTML for iframe player
  const getPlayerHtml = (url) => {
    const isHls = url.includes('.m3u8');
    const playerId = `player_${Math.random().toString(36).substring(2, 9)}`;
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Stream Player</title>
        <style>
          body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #000;
          }
          .player-container {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
          }
          video {
            max-width: 100%;
            max-height: 100%;
            width: 100%;
            height: 100%;
          }
          .error {
            color: red;
            text-align: center;
            padding: 20px;
          }
          .loading {
            color: white;
            text-align: center;
            padding: 20px;
          }
          .play-button {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            border: none;
            background: rgba(0,0,0,0.7);
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            cursor: pointer;
            font-size: 16px;
            z-index: 10;
          }
        </style>
        ${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>' : ''}
      </head>
      <body>
        <div class="player-container" id="container_${playerId}">
          <video id="video_${playerId}" controls playsinline></video>
          <button class="play-button" id="play_button_${playerId}">Play Video</button>
        </div>
        
        <script>
          (function() {
            const videoEl = document.getElementById('video_${playerId}');
            const containerEl = document.getElementById('container_${playerId}');
            const playButtonEl = document.getElementById('play_button_${playerId}');
            
            // Hide play button initially
            playButtonEl.style.display = 'none';
            
            // Function to start playback
            function startPlayback() {
              playButtonEl.style.display = 'none';
              
              ${isHls ? `
                // Use HLS.js for m3u8 streams
                if (Hls.isSupported()) {
                  const hls = new Hls({
                    debug: false,
                    enableWorker: true,
                    lowLatencyMode: true,
                    xhrSetup: function(xhr) {
                      xhr.setRequestHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                      xhr.setRequestHeader('Referer', document.location.origin);
                    }
                  });
                  hls.loadSource('${url}');
                  hls.attachMedia(videoEl);
                  hls.on(Hls.Events.MEDIA_ATTACHED, function() {
                    videoEl.play().catch(function(error) {
                      console.error('Play failed:', error);
                      playButtonEl.style.display = 'block';
                    });
                  });
                  hls.on(Hls.Events.ERROR, function(event, data) {
                    console.error('HLS error:', data);
                    if (data.fatal) {
                      fallbackToDirectPlay();
                    }
                  });
                } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
                  // Native HLS support (Safari)
                  videoEl.src = '${url}';
                  videoEl.addEventListener('canplay', function() {
                    videoEl.play().catch(function(error) {
                      console.error('Play failed:', error);
                      playButtonEl.style.display = 'block';
                    });
                  });
                  videoEl.addEventListener('error', function() {
                    fallbackToDirectPlay();
                  });
                } else {
                  fallbackToDirectPlay();
                }
              ` : `
                // Direct play for non-HLS streams
                videoEl.src = '${url}';
                videoEl.addEventListener('canplay', function() {
                  videoEl.play().catch(function(error) {
                    console.error('Play failed:', error);
                    playButtonEl.style.display = 'block';
                  });
                });
              `}
            }
            
            // Fallback to direct source
            function fallbackToDirectPlay() {
              const newVideo = document.createElement('video');
              newVideo.id = 'video_${playerId}_fallback';
              newVideo.controls = true;
              newVideo.autoplay = true;
              newVideo.playsInline = true;
              newVideo.src = '${url}';
              
              containerEl.innerHTML = '';
              containerEl.appendChild(newVideo);
              
              // Add play button back
              const newPlayButton = document.createElement('button');
              newPlayButton.className = 'play-button';
              newPlayButton.textContent = 'Play Video';
              newPlayButton.style.display = 'block';
              newPlayButton.onclick = function() {
                newVideo.play().catch(function(error) {
                  console.error('Play failed:', error);
                });
              };
              containerEl.appendChild(newPlayButton);
            }
            
            // Error handling
            videoEl.addEventListener('error', function() {
              console.error('Video error:', videoEl.error);
              containerEl.innerHTML = '<div class="error">Error playing stream. Try another channel or player type.</div>';
            });
            
            // Play button event handler
            playButtonEl.addEventListener('click', function() {
              startPlayback();
            });
            
            // Try to start playback automatically
            startPlayback();
          })();
        </script>
      </body>
      </html>
    `;
  };

  // Manual play button handler
  const handlePlay = () => {
    setUserInteracted(true);
    
    if (playbackMethod === 'iframe' && iframeRef.current) {
      // Try to communicate with iframe to play
      try {
        iframeRef.current.contentWindow.postMessage('play', '*');
      } catch (err) {
        log('error', 'Error sending play message to iframe', { error: err.message });
      }
    }
    else if (videoRef.current) {
      // Try to play the video element
      videoRef.current.play()
        .then(() => {
          log('info', 'Playback started via play button');
          setError(null);
        })
        .catch(err => {
          log('error', 'Play failed on manual attempt', { error: err.message });
          setError(`Cannot play video: ${err.message}`);
        });
    }
  };

  // Toggle debug panel
  const toggleDebug = () => {
    setShowDebug(prev => !prev);
  };

  // Try another playback method
  const tryAnotherMethod = () => {
    fallbackToNextMethod();
  };

  return (
    <div style={{ 
      position: 'relative', 
      width: '100%', 
      height: '400px',
      backgroundColor: '#000',
      borderRadius: '8px',
      overflow: 'hidden'
    }}>
      {/* Debug toggle button */}
      <button
        onClick={toggleDebug}
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          zIndex: 100,
          background: '#333',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          padding: '5px 10px',
          fontSize: '12px',
          opacity: 0.7,
          cursor: 'pointer'
        }}
      >
        {showDebug ? 'Hide Debug' : 'Debug'}
      </button>

      {/* Debug panel */}
      {showDebug && (
        <div style={{
          position: 'absolute',
          top: '40px',
          right: '10px',
          bottom: '10px',
          width: '300px',
          background: 'rgba(0, 0, 0, 0.8)',
          color: 'white',
          zIndex: 100,
          padding: '10px',
          overflowY: 'auto',
          fontSize: '10px',
          fontFamily: 'monospace',
          borderRadius: '4px'
        }}>
          <div style={{ marginBottom: '10px' }}>
            <strong>Player Method:</strong> {playbackMethod}
          </div>
          
          <div style={{ marginBottom: '10px' }}>
            <strong>Stream URL:</strong> 
            <div style={{ wordBreak: 'break-all', fontSize: '8px' }}>{streamUrl}</div>
          </div>
          
          <div>
            <strong>Logs:</strong>
            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {logs.map(log => (
                <div
                  key={log.id}
                  style={{
                    padding: '2px 5px',
                    margin: '2px 0',
                    backgroundColor: 
                      log.level === 'error' ? 'rgba(255, 0, 0, 0.3)' :
                      log.level === 'warn' ? 'rgba(255, 255, 0, 0.3)' :
                      log.level === 'info' ? 'rgba(0, 0, 255, 0.3)' :
                      'rgba(255, 255, 255, 0.1)',
                    borderRadius: '2px',
                    fontSize: '8px'
                  }}
                >
                  {log.message}
                  {log.data && <div style={{ color: '#aaa' }}>{log.data}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Player methods */}
      <div style={{
        position: 'absolute',
        top: '10px',
        left: '10px',
        zIndex: 90,
        display: 'flex',
        gap: '5px'
      }}>
        <button
          onClick={() => {
            setPlaybackMethod('iframe');
            cleanupPlayback();
            setStreamUrl(`http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`);
          }}
          style={{
            background: playbackMethod === 'iframe' ? '#4CAF50' : '#333',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 10px',
            fontSize: '12px',
            cursor: 'pointer'
          }}
        >
          iFrame
        </button>
        
        <button
          onClick={() => {
            setPlaybackMethod('hls');
            cleanupPlayback();
            const url = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}`;
            setStreamUrl(url);
            setupHlsPlayback(url);
          }}
          style={{
            background: playbackMethod === 'hls' ? '#4CAF50' : '#333',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 10px',
            fontSize: '12px',
            cursor: 'pointer'
          }}
        >
          HLS
        </button>
        
        <button
          onClick={() => {
            setPlaybackMethod('native');
            cleanupPlayback();
            const url = selectedChannel.url || `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
            setStreamUrl(url);
            setupNativePlayback(url);
          }}
          style={{
            background: playbackMethod === 'native' ? '#4CAF50' : '#333',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 10px',
            fontSize: '12px',
            cursor: 'pointer'
          }}
        >
          Native
        </button>
        
        <button
          onClick={() => {
            setPlaybackMethod('videojs');
            cleanupPlayback();
            const url = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
            setStreamUrl(url);
            setupVideoJSPlayback(url);
          }}
          style={{
            background: playbackMethod === 'videojs' ? '#4CAF50' : '#333',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 10px',
            fontSize: '12px',
            cursor: 'pointer'
          }}
        >
          VideoJS
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div style={{ 
          position: 'absolute',
          top: '50px', 
          left: '10px', 
          right: showDebug ? '320px' : '10px',
          zIndex: 80,
          padding: '10px', 
          background: 'rgba(255, 0, 0, 0.7)', 
          color: 'white',
          borderRadius: '4px',
          textAlign: 'center'
        }}>
          {error}
          
          <div style={{ marginTop: '10px' }}>
            <button
              onClick={handlePlay}
              style={{
                padding: '5px 15px',
                background: '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                marginRight: '10px'
              }}
            >
              Try Play
            </button>
            
            <button
              onClick={tryAnotherMethod}
              style={{
                padding: '5px 15px',
                background: '#2196F3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Try Another Method
            </button>
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div style={{ 
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 70,
          padding: '10px 20px',
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          borderRadius: '4px'
        }}>
          Loading...
        </div>
      )}

      {/* Channel selection message */}
      {!selectedChannel && (
        <div style={{ 
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#aaa',
          textAlign: 'center'
        }}>
          Select a channel to play
        </div>
      )}

      {/* Player elements */}
      {playbackMethod === 'iframe' ? (
        <iframe
          ref={iframeRef}
          title="Stream Player"
          style={{ 
            width: '100%',
            height: '100%',
            border: 'none',
            backgroundColor: '#000'
          }}
          allowFullScreen
          allow="autoplay; encrypted-media; picture-in-picture"
          sandbox="allow-scripts"
        ></iframe>
      ) : (
        <>
          {playbackMethod === 'videojs' ? (
            <div data-vjs-player style={{ width: '100%', height: '100%' }}>
              <video
                ref={videoRef}
                className="video-js vjs-big-play-centered"
                playsInline
                controls
                style={{ width: '100%', height: '100%' }}
              ></video>
            </div>
          ) : (
            <video
              ref={videoRef}
              controls
              playsInline
              style={{ 
                width: '100%',
                height: '100%',
                backgroundColor: '#000'
              }}
            ></video>
          )}
          
          {/* Play button overlay for non-iframe methods */}
          {error && !userInteracted && (
            <div 
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 75
              }}
            >
              <button
                onClick={handlePlay}
                style={{
                  padding: '15px',
                  backgroundColor: 'rgba(0, 0, 0, 0.7)',
                  border: 'none',
                  borderRadius: '50%',
                  width: '60px',
                  height: '60px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer'
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <polygon points="5,3 19,12 5,21" fill="white" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}

      {/* Channel info bar */}
      {selectedChannel && (
        <div style={{ 
          position: 'absolute',
          bottom: '10px',
          left: '10px',
          right: showDebug ? '320px' : '10px',
          padding: '10px',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          borderRadius: '4px',
          fontSize: '14px',
          zIndex: 60
        }}>
          <div style={{ fontWeight: 'bold' }}>{selectedChannel.name}</div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>{selectedChannel.groupTitle}</div>
        </div>
      )}
    </div>
  );
};

export default UniversalPlayer;