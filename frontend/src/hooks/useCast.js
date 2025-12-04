import { useState, useEffect, useCallback, useRef } from 'react';

// Global flag to track if Cast has been initialized (singleton pattern)
// This prevents multiple instances from all trying to initialize Cast
let castInitialized = false;
let castInitializing = false;
const castListeners = new Set();

/**
 * Custom hook for Google Cast functionality
 * Manages Cast connection state and provides methods to cast media
 *
 * IMPORTANT: Uses singleton pattern to prevent multiple IPTVPlayer instances
 * from all trying to initialize Cast SDK simultaneously (causes performance issues)
 */
export const useCast = () => {
  const [isCastAvailable, setIsCastAvailable] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  const [castSession, setCastSession] = useState(null);
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 5; // Stop trying after 5 attempts (5 seconds)

  // Initialize Cast API (singleton - only one instance initializes)
  useEffect(() => {
    // Register this component as a listener
    const listener = { setIsCastAvailable, setCastSession, setIsCasting };
    castListeners.add(listener);

    // If already initialized, we're done
    if (castInitialized) {
      return () => {
        castListeners.delete(listener);
      };
    }

    // If another instance is already initializing, just wait
    if (castInitializing) {
      return () => {
        castListeners.delete(listener);
      };
    }

    // This instance will handle initialization
    castInitializing = true;

    const initializeCast = () => {
      // Don't retry forever - max 5 attempts
      if (retryCountRef.current >= MAX_RETRIES) {
        castInitializing = false;
        return;
      }

      if (!window.chrome || !window.chrome.cast) {
        retryCountRef.current++;
        setTimeout(initializeCast, 1000);
        return;
      }

      window['__onGCastApiAvailable'] = (isAvailable) => {
        castInitialized = true;
        castInitializing = false;

        if (isAvailable) {
          const cast = window.chrome.cast;
          const sessionRequest = new cast.SessionRequest(cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID);
          const apiConfig = new cast.ApiConfig(
            sessionRequest,
            sessionListener,
            receiverListener
          );

          cast.initialize(apiConfig, onInitSuccess, onInitError);
        }
      };

      // Session listener - notify all instances
      const sessionListener = (session) => {
        castListeners.forEach(l => {
          l.setCastSession(session);
          l.setIsCasting(true);
        });
      };

      // Receiver listener - notify all instances
      const receiverListener = (availability) => {
        const available = availability === 'available';
        castListeners.forEach(l => {
          l.setIsCastAvailable(available);
        });
      };

      const onInitSuccess = () => {
        // Silent success
      };

      const onInitError = (error) => {
        console.error('[useCast] Cast API initialization error:', error);
        castInitializing = false;
      };

      // Trigger the callback if Cast is already loaded
      if (window.chrome.cast.isAvailable) {
        window['__onGCastApiAvailable'](true);
      }
    };

    // Start initialization
    initializeCast();

    return () => {
      castListeners.delete(listener);
    };
  }, []);

  // Cast media to Chromecast
  const castMedia = useCallback((streamUrl, title, imageUrl) => {
    if (!window.chrome || !window.chrome.cast) {
      console.error('Cast API not available');
      return;
    }

    const cast = window.chrome.cast;

    // Request session
    cast.requestSession(
      (session) => {
        console.log('Cast session obtained:', session);
        setCastSession(session);
        setIsCasting(true);

        // Create media info for HLS stream
        const mediaInfo = new cast.media.MediaInfo(streamUrl, 'application/x-mpegURL');
        mediaInfo.metadata = new cast.media.GenericMediaMetadata();
        mediaInfo.metadata.title = title || 'IPTV Stream';
        if (imageUrl) {
          mediaInfo.metadata.images = [new cast.Image(imageUrl)];
        }

        // Mark as live stream
        mediaInfo.streamType = cast.media.StreamType.LIVE;

        // Create load request
        const request = new cast.media.LoadRequest(mediaInfo);
        request.autoplay = true;

        // Load media
        session.loadMedia(
          request,
          (media) => {
            console.log('[useCast] Media loaded successfully', media);

            // Add listener for media status updates
            media.addUpdateListener((isAlive) => {
              console.log('[useCast] Media status update:', {
                isAlive,
                playerState: media.playerState,
                idleReason: media.idleReason,
                currentTime: media.currentTime,
                duration: media.media?.duration
              });

              // Log errors
              if (media.idleReason === 'ERROR') {
                console.error('[useCast] Media playback error detected');
              }
            });
          },
          (error) => {
            console.error('[useCast] Error loading media:', error);
            alert(`Cast error: ${error.description || error.code || 'Unknown error'}`);
          }
        );
      },
      (error) => {
        console.error('Error requesting cast session:', error);
      }
    );
  }, []);

  // Stop casting
  const stopCasting = useCallback(() => {
    if (castSession) {
      castSession.stop(
        () => {
          console.log('Cast session stopped');
          setCastSession(null);
          setIsCasting(false);
        },
        (error) => {
          console.error('Error stopping cast session:', error);
        }
      );
    }
  }, [castSession]);

  return {
    isCastAvailable,
    isCasting,
    castMedia,
    stopCasting
  };
};
