import React, { useState, useEffect, useRef } from 'react';
import ReactPlayer from 'react-player';

/**
 * ReactPlayerComponent - Uses ReactPlayer to handle various stream formats
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId The current session ID
 * @param {Object} props.selectedChannel The selected channel object
 * @returns {JSX.Element} ReactPlayerComponent
 */
const ReactPlayerComponent = ({ sessionId, selectedChannel }) => {
  const [streamUrl, setStreamUrl] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef(null);

  // Log component lifecycle
  useEffect(() => {
    console.log('[INFO] ReactPlayerComponent mounting');
    return () => {
      console.log('[INFO] ReactPlayerComponent unmounting');
    };
  }, []);

  // Update stream URL when channel changes
  useEffect(() => {
    if (!sessionId || !selectedChannel) {
      setStreamUrl('');
      return;
    }

    setLoading(true);
    setError(null);
    
    // Try to use direct URL from the channel if possible
    if (selectedChannel.url && selectedChannel.url.startsWith('http')) {
      console.log('[INFO] Using direct stream URL from channel:', selectedChannel.url);
      setStreamUrl(selectedChannel.url);
    } else {
      // Fall back to the proxy stream URL
      const proxyUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(selectedChannel.tvgId)}?format=ts`;
      console.log('[INFO] Using proxy stream URL:', proxyUrl);
      setStreamUrl(proxyUrl);
    }
  }, [sessionId, selectedChannel]);

  const handlePlay = () => {
    console.log('[INFO] Play button clicked');
    setPlaying(true);
  };

  const handlePause = () => {
    console.log('[INFO] Video paused');
    setPlaying(false);
  };

  const handleError = (err) => {
    console.error('[ERROR] ReactPlayer error:', err);
    setError('Failed to play stream. Trying direct URL...');
    setLoading(false);
    
    // If using proxy URL, try direct URL
    if (streamUrl.includes('localhost') && selectedChannel && selectedChannel.url) {
      console.log('[INFO] Falling back to direct URL:', selectedChannel.url);
      setStreamUrl(selectedChannel.url);
    }
  };

  const handleReady = () => {
    console.log('[INFO] ReactPlayer ready');
    setLoading(false);
    setError(null);
  };

  const handleBuffer = () => {
    console.log('[INFO] ReactPlayer buffering');
    setLoading(true);
  };

  const handleBufferEnd = () => {
    console.log('[INFO] ReactPlayer buffering ended');
    setLoading(false);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '400px' }}>
      {/* Error message */}
      {error && (
        <div style={{ 
          position: 'absolute', 
          top: '10px', 
          left: '10px', 
          right: '10px',
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

      {/* Manual play button */}
      {!playing && streamUrl && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          zIndex: 10
        }}>
          <button 
            onClick={handlePlay}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Play Video
          </button>
        </div>
      )}

      {/* ReactPlayer */}
      {streamUrl && (
        <div style={{ width: '100%', height: '100%', background: '#000' }}>
          <ReactPlayer
            ref={playerRef}
            url={streamUrl}
            width="100%"
            height="100%"
            playing={playing}
            controls={true}
            onPlay={handlePlay}
            onPause={handlePause}
            onError={handleError}
            onReady={handleReady}
            onBuffer={handleBuffer}
            onBufferEnd={handleBufferEnd}
            config={{
              file: {
                forceVideo: true,
                attributes: {
                  controlsList: 'nodownload'
                }
              }
            }}
          />
        </div>
      )}

      {/* Channel info */}
      {selectedChannel && (
        <div style={{ 
          position: 'absolute', 
          bottom: '10px', 
          left: '10px', 
          right: '10px',
          zIndex: 5,
          padding: '5px 10px', 
          background: 'rgba(0, 0, 0, 0.7)', 
          color: 'white',
          borderRadius: '4px',
          fontSize: '12px'
        }}>
          {selectedChannel.name} - {selectedChannel.groupTitle}
        </div>
      )}
    </div>
  );
};

export default ReactPlayerComponent;