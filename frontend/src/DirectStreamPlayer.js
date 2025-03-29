import React, { useEffect, useRef, useState } from 'react';

/**
 * DirectStreamPlayer - A simple approach that uses the direct stream URL
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} DirectStreamPlayer component
 */
const DirectStreamPlayer = ({ sessionId, selectedChannel }) => {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [streamUrl, setStreamUrl] = useState('');
  const iframeRef = useRef(null);
  
  // Generate a unique ID for this player instance to avoid variable conflicts
  const playerId = useRef(`player_${Math.random().toString(36).substring(2, 9)}`);

  useEffect(() => {
    console.log('[INFO] DirectStreamPlayer component mounting');
    return () => {
      console.log('[INFO] DirectStreamPlayer component unmounting');
    };
  }, []);

  // Update stream URL when channel changes
  useEffect(() => {
    if (!sessionId || !selectedChannel) {
      console.warn('[WARN] Cannot set source: missing sessionId or selectedChannel');
      setStreamUrl('');
      setError('No channel selected');
      return;
    }

    setLoading(true);
    setError(null);

    // Get the direct stream URL from the channel
    const directUrl = selectedChannel.url;
    
    console.log('[INFO] Channel selected', { 
      name: selectedChannel.name, 
      url: directUrl 
    });

    if (directUrl && directUrl.startsWith('http')) {
      setStreamUrl(directUrl);
      console.log('[INFO] Using direct stream URL:', directUrl);
    } else {
      setError('No valid stream URL found for this channel');
      setLoading(false);
    }
  }, [sessionId, selectedChannel]);

  // Create a standalone HTML page for the player
  const getPlayerHtml = (url) => {
    const isHls = url.includes('.m3u8');
    const id = playerId.current;
    
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
        </style>
        ${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>' : ''}
      </head>
      <body>
        <div class="player-container" id="container_${id}">
          <video id="video_${id}" controls autoplay playsinline></video>
        </div>
        
        <script>
          (function() {
            const videoEl = document.getElementById('video_${id}');
            const containerEl = document.getElementById('container_${id}');
            
            ${isHls ? `
              // Use HLS.js for m3u8 streams
              if (Hls.isSupported()) {
                const hls = new Hls({
                  debug: false,
                  enableWorker: true,
                  lowLatencyMode: true
                });
                hls.loadSource('${url}');
                hls.attachMedia(videoEl);
                hls.on(Hls.Events.MEDIA_ATTACHED, function() {
                  videoEl.play();
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
                  videoEl.play();
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
                videoEl.play();
              });
            `}
            
            // Fallback to direct source
            function fallbackToDirectPlay() {
              const newVideo = document.createElement('video');
              newVideo.id = 'video_${id}_fallback';
              newVideo.controls = true;
              newVideo.autoplay = true;
              newVideo.playsInline = true;
              newVideo.src = '${url}';
              
              containerEl.innerHTML = '';
              containerEl.appendChild(newVideo);
            }
            
            // Error handling
            videoEl.addEventListener('error', function() {
              console.error('Video error:', videoEl.error);
              containerEl.innerHTML = '<div class="error">Error playing stream. Try another channel or player type.</div>';
            });
          })();
        </script>
      </body>
      </html>
    `;
  };

  // Update iframe content when streamUrl changes
  useEffect(() => {
    if (!streamUrl || !iframeRef.current) return;

    try {
      const iframe = iframeRef.current;
      
      // Create and access the iframe document safely
      iframe.onload = () => {
        setLoading(false);
      };
      
      // Use srcdoc instead of document.write to avoid issues with redeclaring variables
      iframe.srcdoc = getPlayerHtml(streamUrl);
    } catch (e) {
      console.error('[ERROR] Error setting iframe content:', e);
      setError(`Error playing stream: ${e.message}`);
      setLoading(false);
    }
  }, [streamUrl]);

  return (
    <div className="direct-stream-player" style={{ position: 'relative', width: '100%', height: '400px' }}>
      {error && (
        <div className="error-message" style={{ 
          color: 'red', 
          padding: '20px', 
          textAlign: 'center',
          background: '#ffeeee',
          borderRadius: '4px'
        }}>
          {error}
        </div>
      )}
      
      {loading && (
        <div className="loading-indicator" style={{ 
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 2,
          padding: '10px 20px',
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          borderRadius: '4px'
        }}>
          Loading stream...
        </div>
      )}
      
      {!selectedChannel && !streamUrl && (
        <div style={{ 
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#555'
        }}>
          Select a channel to play
        </div>
      )}
      
      {streamUrl && (
        <iframe
          ref={iframeRef}
          title="Stream Player"
          style={{ 
            width: '100%', 
            height: '100%', 
            border: 'none',
            backgroundColor: '#000',
          }}
          allowFullScreen
          allow="autoplay; encrypted-media; picture-in-picture"
          // Use more restricted sandbox permissions for security
          sandbox="allow-scripts"
        ></iframe>
      )}
    </div>
  );
};

export default DirectStreamPlayer;