import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, Alert } from '@mui/material';
import mpegts from 'mpegts.js';
import { SESSION_ID } from '../api/apiSlice';

const VideoPlayer = ({ channel }) => {
  const videoRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const playerRef = useRef(null);

  useEffect(() => {
    // Clean up function to handle component unmount
    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!channel || !channel.tvgId) {
      setError('No channel selected');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Clean up previous player instance
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }

    if (mpegts.getFeatureList().mseLivePlayback) {
      const videoElement = videoRef.current;
      
      if (!videoElement) return;

      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
      const streamUrl = `${apiUrl}/stream/${SESSION_ID}/${channel.tvgId}?format=ts`;
      
      console.log(`Attempting to play stream from URL: ${streamUrl}`);

      // First check if the stream is available with a HEAD request
      fetch(streamUrl, { method: 'HEAD' })
        .then(response => {
          if (!response.ok) {
            throw new Error(`Stream unavailable (${response.status}): ${response.statusText}`);
          }
          return true;
        })
        .catch(err => {
          console.error('Stream availability check failed:', err);
          setError(`Cannot access stream: ${err.message}`);
          setLoading(false);
          return false;
        })
        .then(isAvailable => {
          if (!isAvailable) return;
          
          // Configure mpegts.js
          const player = mpegts.createPlayer({
            type: 'mpegts',
            url: streamUrl,
            isLive: true,
            cors: true,
            withCredentials: false,
            liveBufferLatencyChasing: true,
            liveSync: true,
            liveBufferLatencyMinRemain: 1.0, 
            lazyLoad: false,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
            },
          }, {
            enableStashBuffer: true,
            stashInitialSize: 1024 * 512,  // Increase initial stash buffer size
            liveBufferLatencyChasing: true,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: 15,
            seekType: 'range',
            reuseRedirectedURL: true,
            fixAudioTimestampGap: true,
            accurateSeek: true,
          });

          // Set up event handlers
          player.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
            console.error('Player error:', errorType, errorDetail, errorInfo);
            
            let errorMessage = 'Stream playback error';
            if (errorDetail && errorDetail.code === 500) {
              errorMessage = 'Unable to access the stream. The channel may be offline or restricted.';
            } else if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
              errorMessage = 'Network error occurred while loading the stream.';
            } else if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
              errorMessage = 'Media error occurred. The stream format may be unsupported.';
            }
            
            setError(errorMessage);
            setLoading(false);
          });

          player.on(mpegts.Events.LOADING_COMPLETE, () => {
            console.log('Stream loading complete');
            setLoading(false);
          });

          player.on(mpegts.Events.METADATA_ARRIVED, (metadata) => {
            console.log('Stream metadata arrived:', metadata);
          });

          player.on(mpegts.Events.STATISTICS_INFO, (statistics) => {
            console.log('Stream statistics:', statistics);
          });

          // Attach to video element and start playback
          player.attachMediaElement(videoElement);
          player.load();
          
          const playPromise = videoElement.play();
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                console.log('Playback started successfully');
                setLoading(false);
              })
              .catch(e => {
                console.error('Error during playback start:', e);
                setError('Playback could not start automatically. Please try clicking the video.');
                setLoading(false);
              });
          }

          playerRef.current = player;
        });
    } else {
      setError('Your browser does not support MSE live playback');
      setLoading(false);
    }

    // Cleanup function
    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [channel]);

  const handleRetry = () => {
    if (channel) {
      setLoading(true);
      setError(null);
      
      // Force reload the player
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      
      setTimeout(() => {
        const videoElement = videoRef.current;
        if (!videoElement) return;
        
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
        const streamUrl = `${apiUrl}/stream/${SESSION_ID}/${channel.tvgId}?format=ts`;
        
        const player = mpegts.createPlayer({
          type: 'mpegts',
          url: streamUrl,
          isLive: true,
          cors: true,
          withCredentials: false,
        });
        
        player.on(mpegts.Events.ERROR, () => {
          setError('Failed to play stream. The channel may be unavailable.');
          setLoading(false);
        });
        
        player.on(mpegts.Events.LOADING_COMPLETE, () => {
          setLoading(false);
        });
        
        player.attachMediaElement(videoElement);
        player.load();
        videoElement.play().catch(e => {
          console.error('Error during retry playback:', e);
        });
        
        playerRef.current = player;
      }, 1000);
    }
  };

  return (
    <Box sx={{ position: 'relative', width: '100%', backgroundColor: '#000', borderRadius: 1, overflow: 'hidden' }}>
      {loading && (
        <Box sx={{ 
          position: 'absolute', 
          top: 0, 
          left: 0, 
          right: 0, 
          bottom: 0, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          zIndex: 2,
          backgroundColor: 'rgba(0,0,0,0.7)'
        }}>
          <CircularProgress color="secondary" />
          <Typography sx={{ ml: 2, color: 'white' }}>Loading stream...</Typography>
        </Box>
      )}
      
      {error && (
        <Box sx={{ 
          position: 'absolute', 
          top: 0, 
          left: 0, 
          right: 0, 
          bottom: 0, 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center',
          zIndex: 2,
          padding: 2,
          backgroundColor: 'rgba(0,0,0,0.8)'
        }}>
          <Alert 
            severity="error" 
            sx={{ mb: 2, width: '100%', maxWidth: 500 }}
            action={
              <button onClick={handleRetry} style={{ 
                background: 'none', 
                border: '1px solid #aaa', 
                color: 'white', 
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '4px'
              }}>
                Retry
              </button>
            }
          >
            {error}
          </Alert>
          <Typography variant="caption" color="text.secondary">
            Some channels may be unavailable due to geographic restrictions or provider limitations.
          </Typography>
        </Box>
      )}
      
      <video 
        ref={videoRef}
        controls
        style={{ width: '100%', height: 'auto', minHeight: '300px', backgroundColor: '#000' }}
        onClick={() => videoRef.current?.play()}
      />
    </Box>
  );
};

export default VideoPlayer;