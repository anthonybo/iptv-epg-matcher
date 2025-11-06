import { useState, useEffect, useCallback } from 'react';

/**
 * Custom hook for Google Cast functionality
 * Manages Cast connection state and provides methods to cast media
 */
export const useCast = () => {
  const [isCastAvailable, setIsCastAvailable] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  const [castSession, setCastSession] = useState(null);

  // Initialize Cast API
  useEffect(() => {
    console.log('[useCast] Starting Cast initialization');

    const initializeCast = () => {
      console.log('[useCast] Checking for Cast SDK...', {
        hasChrome: !!window.chrome,
        hasCast: !!(window.chrome && window.chrome.cast)
      });

      if (!window.chrome || !window.chrome.cast) {
        console.log('[useCast] Cast SDK not loaded yet, retrying in 1s...');
        setTimeout(initializeCast, 1000);
        return;
      }

      console.log('[useCast] Cast SDK detected, setting up callback');

      window['__onGCastApiAvailable'] = (isAvailable) => {
        console.log('[useCast] __onGCastApiAvailable called:', isAvailable);

        if (isAvailable) {
          const cast = window.chrome.cast;
          const sessionRequest = new cast.SessionRequest(cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID);
          const apiConfig = new cast.ApiConfig(
            sessionRequest,
            sessionListener,
            receiverListener
          );

          console.log('[useCast] Initializing Cast API...');
          cast.initialize(apiConfig, onInitSuccess, onInitError);
        } else {
          console.log('[useCast] Cast API not available');
        }
      };

      // Session listener
      const sessionListener = (session) => {
        console.log('[useCast] Session started:', session);
        setCastSession(session);
        setIsCasting(true);
      };

      // Receiver listener
      const receiverListener = (availability) => {
        console.log('[useCast] Receiver availability changed:', availability);
        setIsCastAvailable(availability === 'available');
      };

      // Success callback
      const onInitSuccess = () => {
        console.log('[useCast] Cast API initialized successfully');
      };

      // Error callback
      const onInitError = (error) => {
        console.error('[useCast] Cast API initialization error:', error);
      };

      // Trigger the callback if Cast is already loaded
      if (window.chrome.cast.isAvailable) {
        console.log('[useCast] Cast already available, triggering callback');
        window['__onGCastApiAvailable'](true);
      }
    };

    // Start initialization
    initializeCast();
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
