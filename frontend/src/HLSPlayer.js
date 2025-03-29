import React, { useEffect, useRef, useState } from 'react';

/**
 * HLSPlayer - Uses HLS.js library to play MPEG-TS streams
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} HLSPlayer component
 */
const HLSPlayer = ({ sessionId, selectedChannel }) => {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hlsInstance, setHlsInstance] = useState(null);
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  
  useEffect(() => {
    console.log('[INFO] HLSPlayer component mounting');
    
    // Load HLS.js dynamically
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
    script.async = true;
    
    script.onload = () => {
      console.log('[INFO] HLS.js loaded');
      if (window.Hls && window.Hls.isSupported()) {
        console.log('[INFO] HLS.js is supported');
      } else {
        console.warn('[WARN] HLS.js is not supported');
        setError('HLS.js is not supported in this browser. Try another player option.');
      }
    };
    
    script.onerror = () => {
      console.error('[ERROR] Failed to load HLS.js');
      setError('Failed to load HLS.js library. Try another player option.');
    };
    
    document.body.appendChild(script);
    
    return () => {
      console.log('[INFO] HLSPlayer component unmounting');
      
      // Clean up HLS instance
      if (hlsInstance) {
        hlsInstance.destroy();
      }
      
      // Remove script
      document.body.removeChild(script);
    };
  }, []);

  // Update video source when channel changes
  useEffect(() => {
    if (!sessionId || !selectedChannel || !videoRef.current || !window.Hls) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Clean up previous HLS instance
      if (hlsInstance) {
        hlsInstance.destroy();
      }

      // Get channel ID
      const channelId = selectedChannel.tvgId;
      console.log('[INFO] Channel selected', { 
        name: selectedChannel.name, 
        id: channelId
      });

      // Create URL for the backend proxy endpoint
      const proxyUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(channelId)}`;
      console.log('[INFO] Using proxy stream URL:', proxyUrl);
      
      // Create HLS instance
      const hls = new window.Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: true,
        xhrSetup: (xhr) => {
          // Add custom headers for IPTV stream request
          xhr.setRequestHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          xhr.setRequestHeader('Referer', 'http://localhost:5001/');
        }
      });
      
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
        console.log('[INFO] HLS: Media attached');
        hls.loadSource(proxyUrl);
      });
      
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        console.log('[INFO] HLS: Manifest parsed');
        videoRef.current.play()
          .then(() => {
            console.log('[INFO] Playback started');
            setLoading(false);
          })
          .catch((err) => {
            console.error('[ERROR] Play failed:', err.message);
            
            // Try again with user interaction
            if (containerRef.current) {
              containerRef.current.innerHTML = `
                <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; 
                            display: flex; align-items: center; justify-content: center; 
                            background: rgba(0,0,0,0.7); color: white; text-align: center;">
                  <div>
                    <p>Autoplay blocked. Click to play.</p>
                    <button style="padding: 10px 20px; background: #4CAF50; color: white; 
                                  border: none; border-radius: 4px; cursor: pointer;">
                      Play Video
                    </button>
                  </div>
                </div>
              `;
              
              const button = containerRef.current.querySelector('button');
              if (button) {
                button.onclick = () => {
                  videoRef.current.play()
                    .then(() => {
                      containerRef.current.innerHTML = '';
                      setLoading(false);
                    })
                    .catch(e => {
                      setError(`Playback failed: ${e.message}`);
                      setLoading(false);
                    });
                };
              }
            }
          });
      });
      
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        console.error('[ERROR] HLS error:', data);
        if (data.fatal) {
          switch(data.type) {
            case window.Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[INFO] HLS: Fatal network error... trying to recover');
              hls.startLoad();
              break;
            case window.Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[INFO] HLS: Fatal media error... trying to recover');
              hls.recoverMediaError();
              break;
            default:
              console.error('[ERROR] HLS: Fatal error, cannot recover');
              setError(`Stream error: ${data.details}`);
              setLoading(false);
              hls.destroy();
              break;
          }
        }
      });
      
      hls.attachMedia(videoRef.current);
      setHlsInstance(hls);
      
    } catch (e) {
      console.error('[ERROR] Error setting up HLS stream:', e);
      setError(`Error setting up stream: ${e.message}`);
      setLoading(false);
    }
  }, [sessionId, selectedChannel, window.Hls]);

  return (
    <div 
      ref={containerRef}
      className="hls-player" 
      style={{ position: 'relative', width: '100%', height: '400px' }}
    >
      {error && (
        <div className="error-message" style={{ 
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          color: 'red', 
          padding: '10px', 
          textAlign: 'center',
          background: '#ffeeee',
          borderRadius: '4px',
          zIndex: 10
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
          zIndex: 5,
          padding: '10px 20px',
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          borderRadius: '4px'
        }}>
          Loading stream...
        </div>
      )}
      
      <video
        ref={videoRef}
        controls
        style={{ 
          width: '100%', 
          height: '100%', 
          backgroundColor: '#000',
          objectFit: 'contain'
        }}
        playsInline
      />
    </div>
  );
};

export default HLSPlayer;