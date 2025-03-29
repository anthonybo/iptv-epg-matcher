import React, { useEffect, useRef, useState } from 'react';

/**
 * ProxyStreamPlayer - Uses the backend's proxy endpoint for IPTV streams
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} ProxyStreamPlayer component
 */
const ProxyStreamPlayer = ({ sessionId, selectedChannel }) => {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const videoRef = useRef(null);
  
  useEffect(() => {
    console.log('[INFO] ProxyStreamPlayer component mounting');
    return () => {
      console.log('[INFO] ProxyStreamPlayer component unmounting');
    };
  }, []);

  // Update video source when channel changes
  useEffect(() => {
    if (!sessionId || !selectedChannel || !videoRef.current) {
      console.warn('[WARN] Cannot set source: missing player, sessionId, or selectedChannel');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get channel ID
      const channelId = selectedChannel.tvgId;
      console.log('[INFO] Channel selected', { 
        name: selectedChannel.name, 
        id: channelId
      });

      // Create URL for the backend proxy endpoint
      const proxyUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(channelId)}`;
      console.log('[INFO] Using proxy stream URL:', proxyUrl);
      
      // Set the video source
      const videoEl = videoRef.current;
      videoEl.src = proxyUrl;
      
      // Start loading
      videoEl.load();
    } catch (e) {
      console.error('[ERROR] Error setting video source:', e);
      setError(`Error setting up stream: ${e.message}`);
      setLoading(false);
    }
  }, [sessionId, selectedChannel]);

  // Set up event handlers
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    
    const onLoadStart = () => {
      console.log('[INFO] Video loading started');
      setLoading(true);
    };
    
    const onCanPlay = () => {
      console.log('[INFO] Video can play');
      videoEl.play()
        .then(() => {
          console.log('[INFO] Playback started');
          setLoading(false);
        })
        .catch(err => {
          console.error('[ERROR] Play failed:', err.message);
          setError(`Playback failed: ${err.message}`);
          setLoading(false);
        });
    };
    
    const onError = () => {
      const err = videoEl.error;
      console.error('[ERROR] Video error:', err);
      
      let errorMessage = 'Unknown error playing stream';
      if (err) {
        switch (err.code) {
          case 1:
            errorMessage = 'Stream aborted';
            break;
          case 2:
            errorMessage = 'Network error while loading stream';
            break;
          case 3:
            errorMessage = 'Stream decoding failed';
            break;
          case 4:
            errorMessage = 'Stream format not supported';
            break;
          default:
            errorMessage = `Error code ${err.code}: ${err.message}`;
        }
      }
      
      setError(errorMessage);
      setLoading(false);
    };
    
    const onEnded = () => {
      console.log('[INFO] Video playback ended');
    };
    
    // Add event listeners
    videoEl.addEventListener('loadstart', onLoadStart);
    videoEl.addEventListener('canplay', onCanPlay);
    videoEl.addEventListener('error', onError);
    videoEl.addEventListener('ended', onEnded);
    
    // Clean up
    return () => {
      videoEl.removeEventListener('loadstart', onLoadStart);
      videoEl.removeEventListener('canplay', onCanPlay);
      videoEl.removeEventListener('error', onError);
      videoEl.removeEventListener('ended', onEnded);
      
      // Stop playback
      videoEl.pause();
      videoEl.src = '';
      videoEl.load();
    };
  }, []);

  return (
    <div className="proxy-stream-player" style={{ position: 'relative', width: '100%', height: '400px' }}>
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

export default ProxyStreamPlayer;