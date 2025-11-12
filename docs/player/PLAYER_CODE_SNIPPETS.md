# Video Player Code Snippets & References

## Core Retry Logic (mpegts.js Error Handler)

**Location:** IPTVPlayer.js lines 583-636

```javascript
player.on(window.mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
  log('error', 'mpegts player error', { errorType, errorDetail, errorInfo });
  setLoading(false);

  const MAX_RETRIES = 3;
  const retryCount = retryCountRef.current;
  const errorChannelId = getChannelId();

  // Don't retry if channel has changed
  if (errorChannelId !== currentChannelIdRef.current) {
    log('info', 'Channel changed, skipping retry');
    return;
  }

  if (retryCount < MAX_RETRIES) {
    // Exponential backoff: 1s, 2s, 4s (max 8s)
    const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 8000);
    retryCountRef.current++;

    log('info', `Stream error - attempting recovery (${retryCount + 1}/${MAX_RETRIES}) in ${retryDelay/1000}s...`);
    setError(`Stream error - retrying (${retryCount + 1}/${MAX_RETRIES})...`);

    retryTimerRef.current = setTimeout(() => {
      // Double-check channel hasn't changed during delay
      if (getChannelId() !== currentChannelIdRef.current) {
        log('info', 'Channel changed during retry delay, aborting');
        return;
      }
      log('info', 'Retrying stream...');
      cleanupPlayer();
      initializeMpegtsPlayer();
    }, retryDelay);
    return;
  }

  // Handle specific error types
  if (errorType === window.mpegts.ErrorTypes.NETWORK_ERROR) {
    if (errorDetail === window.mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID) {
      const statusCode = errorInfo?.code || 'unknown';
      const message = errorInfo?.msg || 'Unknown error';
      setError(`Channel not found or unavailable (HTTP ${statusCode}: ${message}). Try selecting a different channel.`);
    } else {
      setError(`Network error loading stream: ${errorDetail}. Check your connection and try again.`);
    }
  } else if (errorType === window.mpegts.ErrorTypes.MEDIA_ERROR) {
    setError(`Media error: The stream format is not supported or the stream is corrupted. Try another channel.`);
  } else {
    setError(`Stream playback error. Try another channel or player method.`);
  }
});
```

---

## Stall Detection & Recovery

**Location:** IPTVPlayer.js lines 666-704

```javascript
const handleStall = (eventType) => {
  log('warn', `Video ${eventType} - checking for stall`);
  const stallChannelId = getChannelId();

  // Clear any existing stall timer
  if (stallTimerRef.current) {
    clearTimeout(stallTimerRef.current);
  }

  // Set a timer to detect if we're stuck
  stallTimerRef.current = setTimeout(() => {
    // Don't recover if channel has changed
    if (getChannelId() !== currentChannelIdRef.current) {
      log('info', 'Channel changed, ignoring stall');
      return;
    }

    const timeSinceLastPlaying = Date.now() - lastPlayingTimeRef.current;

    if (timeSinceLastPlaying > 10000) { // Stalled for more than 10 seconds
      log('error', `Video stalled for ${timeSinceLastPlaying}ms - attempting recovery`);

      const MAX_RETRIES = 3;
      const retryCount = retryCountRef.current;

      if (retryCount < MAX_RETRIES) {
        retryCountRef.current++;
        log('info', `Recovering from stall (${retryCount + 1}/${MAX_RETRIES})...`);
        setError(`Stream stalled - recovering (${retryCount + 1}/${MAX_RETRIES})...`);

        cleanupPlayer();
        initializeMpegtsPlayer();
      } else {
        log('error', `Stream stalled after ${MAX_RETRIES} recovery attempts`);
        setError('Stream appears to be frozen. Try selecting another channel or refresh the page.');
      }
    }
  }, 12000); // Check after 12 seconds of waiting/stalling
};

videoEl.addEventListener('waiting', () => handleStall('waiting'));
videoEl.addEventListener('stalled', () => handleStall('stalled'));
```

---

## Player Initialization

**Location:** IPTVPlayer.js lines 529-578

```javascript
const initializeMpegtsPlayerInstance = () => {
  if (!window.mpegts) {
    log('error', 'mpegts.js not available');
    setError('Player library not available');
    setLoading(false);
    return;
  }
  
  log('info', 'Initializing mpegts.js player');

  // Get URL for TS stream
  let baseTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;
  if (selectedChannel?.sourceId) {
    baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
  }
  let proxyTsUrl = addAuthToStreamUrl(baseTsUrl);

  // Validate the URL before using it
  proxyTsUrl = validateStreamUrl(proxyTsUrl);
  if (!proxyTsUrl) {
    setError('Invalid stream URL. Please try another channel.');
    setLoading(false);
    return;
  }
  
  try {
    // Create new player container
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }
    
    const videoEl = document.createElement('video');
    videoEl.id = 'mpegts-video';
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.controls = !theatreMode;
    containerRef.current.appendChild(videoEl);
    
    if (window.mpegts.getFeatureList().mseLivePlayback) {
      const player = window.mpegts.createPlayer({
        type: 'mse',
        url: proxyTsUrl,
        isLive: true,
        enableStashBuffer: false,
        liveBufferLatencyChasing: true,
        maxBufferSize: 32 * 1024 * 1024,
        autoCleanupSourceBuffer: true
      });
      
      player.attachMediaElement(videoEl);
      player.load();
      player.play();
      
      playerInstanceRef.current = player;
    } else {
      log('error', 'MSE not supported in this browser');
      setError('Your browser does not support the required video playback features.');
      setLoading(false);
    }
  } catch (e) {
    log('error', 'Error initializing mpegts.js player', { error: e.message });
    setError(`Error initializing player: ${e.message}`);
    setLoading(false);
  }
};
```

---

## Cleanup & State Reset

**Location:** IPTVPlayer.js lines 250-272

```javascript
const cleanupPlayer = () => {
  // Clear any pending retry timers
  if (retryTimerRef.current) {
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }

  // Clear stall detection timer
  if (stallTimerRef.current) {
    clearTimeout(stallTimerRef.current);
    stallTimerRef.current = null;
  }

  if (playerInstanceRef.current) {
    log('info', 'Destroying player instance');
    try {
      playerInstanceRef.current.destroy();
    } catch (e) {
      log('error', 'Error destroying player', { error: e.message });
    }
    playerInstanceRef.current = null;
  }
};
```

---

## Playing Event Listener

**Location:** IPTVPlayer.js lines 640-663

```javascript
videoEl.addEventListener('playing', () => {
  log('info', 'Video playing');
  setLoading(false);
  setError(null);
  retryCountRef.current = 0; // Reset retry count on successful playback
  lastPlayingTimeRef.current = Date.now();

  // Clear stall timer when playing resumes
  if (stallTimerRef.current) {
    clearTimeout(stallTimerRef.current);
    stallTimerRef.current = null;
  }
});

videoEl.addEventListener('timeupdate', () => {
  // Update last playing time when video is progressing
  lastPlayingTimeRef.current = Date.now();

  // Clear stall timer on normal playback
  if (stallTimerRef.current) {
    clearTimeout(stallTimerRef.current);
    stallTimerRef.current = null;
  }
});
```

---

## Stream URL Construction

**Location:** IPTVPlayer.js lines 539-554

```javascript
// Primary stream request (MPEG-TS format)
let baseTsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}?format=ts`;

// Add sourceId if available
if (selectedChannel?.sourceId) {
  baseTsUrl += `&source_id=${selectedChannel.sourceId}`;
}

// Add authentication
let proxyTsUrl = addAuthToStreamUrl(baseTsUrl);

// Validate URL
proxyTsUrl = validateStreamUrl(proxyTsUrl);

// For HLS/Clappr (alternative)
let baseHlsUrl = `http://localhost:5001/api/stream/${sessionId}/${encodeURIComponent(getChannelId())}`;
if (selectedChannel?.sourceId) {
  baseHlsUrl += `?source_id=${selectedChannel.sourceId}`;
}
const proxyHlsUrl = addAuthToStreamUrl(baseHlsUrl);
```

---

## Enhanced Logging Function

**Location:** IPTVPlayer.js lines 72-86

```javascript
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
  ].slice(-20)); // Keep only last 20 logs
};

// Usage:
log('info', 'Player initialized');
log('error', 'Stream error', { errorType, errorDetail });
log('warn', 'Stall detected', { timeSinceLastFrame: 10500 });
```

---

## Channel Change Detection

**Location:** IPTVPlayer.js lines 228-247

```javascript
useEffect(() => {
  if (!sessionId || !selectedChannel) {
    cleanupPlayer();
    return;
  }

  log('info', 'Channel selected', {
    name: selectedChannel.name,
    id: getChannelId()
  });
  
  setError(null);
  setLoading(true);
  
  // Wait a brief moment for scripts to load if needed
  setTimeout(() => {
    initializePlayer();
  }, 100);
}, [sessionId, selectedChannel, playbackMethod]);
```

---

## Checking Against Config Constants

### Finding Configuration Values
```javascript
// MAX_RETRIES: 3
// Line 410, 589, 688

// STALL_TIMEOUT: 12000 ms
// Line 424, 703

// STALL_THRESHOLD: 10000 ms  
// Line 406, 685

// MAX_RETRY_DELAY: 8000 ms
// Lines 452, 599
```

### Modifying Configuration
To change retry behavior:
1. Search for `const MAX_RETRIES = 3`
2. Search for `Math.min(1000 * Math.pow(2, retryCount), 8000)`
3. Search for `12000` (stall timeout)
4. Search for `10000` (stall threshold)

---

## Event Listeners Reference

```javascript
// mpegts.js Events
player.on(window.mpegts.Events.ERROR, handler)      // Error occurred
player.on(window.mpegts.Events.LOADING_COMPLETE, handler)  // Loaded

// HTML5 Video Events
videoEl.addEventListener('playing', handler)        // Playback started
videoEl.addEventListener('pause', handler)          // Paused
videoEl.addEventListener('ended', handler)          // Finished
videoEl.addEventListener('timeupdate', handler)     // Time updated
videoEl.addEventListener('waiting', handler)        // Buffering
videoEl.addEventListener('stalled', handler)        // Stalled
videoEl.addEventListener('error', handler)          // Error

// Clappr Events
playerInstanceRef.current.on(Clappr.Events.PLAYER_PLAY, handler)
playerInstanceRef.current.on(Clappr.Events.PLAYER_BUFFERING, handler)
playerInstanceRef.current.on(Clappr.Events.PLAYER_BUFFERFULL, handler)
playerInstanceRef.current.on(Clappr.Events.PLAYER_TIMEUPDATE, handler)
playerInstanceRef.current.on(Clappr.Events.PLAYER_ERROR, handler)
```

---

## Ref Variables Quick Reference

```javascript
const playerInstanceRef = useRef(null);        // The actual player object
const retryCountRef = useRef(0);               // Current retry attempt
const retryTimerRef = useRef(null);            // Timeout ID for delay
const stallTimerRef = useRef(null);            // Timeout ID for detection
const lastPlayingTimeRef = useRef(0);          // ms timestamp of last frame
const currentChannelIdRef = useRef(null);      // Channel ID at error time

// Important: These are useRef, NOT useState
// They persist across renders but don't trigger re-renders
// Use for tracking state that shouldn't cause render updates
```

---

## Common Errors & Fixes

### "mpegts.js not available"
```javascript
// Verify script loaded:
if (!window.mpegts) {
  log('error', 'mpegts.js not available');
  return;
}

// Check in browser console:
console.log(window.mpegts); // Should be object, not undefined
```

### Stall detection not triggering
```javascript
// Ensure listeners are attached:
videoEl.addEventListener('waiting', () => handleStall('waiting'));
videoEl.addEventListener('stalled', () => handleStall('stalled'));

// Verify lastPlayingTimeRef is updating:
log('debug', 'Last playing time', { 
  lastPlaying: lastPlayingTimeRef.current,
  now: Date.now(),
  diff: Date.now() - lastPlayingTimeRef.current
});
```

### Retry loop not stopping
```javascript
// Add channel change check:
if (getChannelId() !== currentChannelIdRef.current) {
  log('info', 'Channel changed, aborting retry');
  return;
}

// Verify retryCountRef is incrementing:
log('debug', 'Retry attempt', { count: retryCountRef.current });
```

---

## Testing Playback Methods

```javascript
// Force mpegts.js
playbackMethod = 'mpegts-player'

// Force HLS/Clappr
playbackMethod = 'hls-player'

// Force VLC link
playbackMethod = 'vlc-link'

// Force test video
playbackMethod = 'test-video'
```

---

