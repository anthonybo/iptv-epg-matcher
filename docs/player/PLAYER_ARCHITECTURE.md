# IPTV Guru - Video Player Implementation Analysis

## Overview
The application uses a sophisticated multi-player approach with **mpegts.js as the primary player** for MPEG-TS streams, supported by fallback mechanisms for different stream formats and browser compatibility.

---

## 1. Primary Video Player: IPTVPlayer (mpegts.js)
**File:** `/frontend/src/IPTVPlayer.js`

### Player Library
- **Default:** mpegts.js (for MPEG-TS/TS streams)
- **Fallback:** Clappr (HLS streams)
- **Alternative:** VLC link output, test video option

### Initialization
```javascript
// Dynamic script loading (CDN)
https://cdn.jsdelivr.net/npm/mpegts.js@latest
https://cdn.jsdelivr.net/npm/clappr@latest/dist/clappr.min.js

// Player modes
const playbackMethod = 'mpegts-player' // Default
// Also supports: 'hls-player', 'vlc-link', 'test-video'
```

### Configuration
**mpegts.js Player:**
```javascript
{
  type: 'mse',                          // MediaSource Extension
  url: proxyTsUrl,                      // Backend proxy stream
  isLive: true,                         // Live stream mode
  enableStashBuffer: false,             // Disable stash buffering
  liveBufferLatencyChasing: true,       // Chase latency in live mode
  maxBufferSize: 32 * 1024 * 1024,     // 32MB max buffer
  autoCleanupSourceBuffer: true         // Auto cleanup
}
```

---

## 2. Error Handling & Recovery Mechanisms

### A. Automatic Stream Error Retry (mpegts.js)
**Location:** Lines 583-636

```javascript
player.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
  // MAX_RETRIES: 3 attempts
  // Exponential backoff: 1s, 2s, 4s (max 8s)
  // Retry delay = Math.min(1000 * Math.pow(2, retryCount), 8000)
  
  // Error types handled:
  // - NETWORK_ERROR (HTTP 404, timeout, DNS failures)
  // - MEDIA_ERROR (corrupted stream, format issues)
  // - Other playback errors
})
```

### B. Stall Detection (Frozen Stream Recovery)
**Location:** Lines 666-704

Detects when video playback stops unexpectedly:

```javascript
// Triggers on:
videoEl.addEventListener('waiting')  // Video waiting for data
videoEl.addEventListener('stalled')  // Video stalled

// Detection logic:
// 1. Set 12-second timeout when stall detected
// 2. Check if lastPlayingTimeRef > 10 seconds ago
// 3. If stalled, attempt recovery (max 3 attempts)
// 4. Exponential backoff between recovery attempts

// Recovery: Re-initialize the entire player
```

### C. Clappr Player (HLS Fallback)
**Location:** Lines 388-425

Similar stall detection for HLS:
```javascript
playerInstanceRef.current.on(Clappr.Events.PLAYER_BUFFERING)
playerInstanceRef.current.on(Clappr.Events.PLAYER_BUFFERFULL)

// 12-second stall detection timer
// Up to 3 recovery attempts with exponential backoff
```

---

## 3. Stream Error Types & User Messages

### mpegts.js Error Handling
```javascript
if (errorType === ErrorTypes.NETWORK_ERROR) {
  if (errorDetail === ErrorDetails.NETWORK_STATUS_CODE_INVALID) {
    // HTTP error (404, 403, 407, etc.)
    setError(`Channel not found or unavailable (HTTP ${code}). Try selecting a different channel.`)
  } else {
    setError(`Network error loading stream: ${errorDetail}. Check your connection and try again.`)
  }
}
else if (errorType === ErrorTypes.MEDIA_ERROR) {
  setError(`Media error: The stream format is not supported or the stream is corrupted. Try another channel.`)
}
else {
  setError(`Stream playback error. Try another channel or player method.`)
}
```

### User-Facing Error Messages
- **"Stream error - retrying (1/3)..."** - During retry attempts
- **"Stream stalled - recovering (1/3)..."** - During stall recovery
- **"Stream appears to be frozen..."** - After max retries exceeded
- **"Channel not found or unavailable (HTTP XXX)..."** - Channel/network issues
- **"Network error loading stream..."** - Connection problems

---

## 4. Alternative Player Components

### SimplePlayer (VideoJS-based)
**File:** `/frontend/src/SimplePlayer.js`
- Uses VideoJS for unified interface
- Supports proxy, direct, and HLS modes
- Manual retry button and mode switching
- No automatic stall recovery

### HLSPlayer (HLS.js)
**File:** `/frontend/src/HLSPlayer.js`
- Dedicated HLS playback
- Basic error handling (network/media errors)
- Attempts recovery on fatal errors
- No stall detection

### ProxyStreamPlayer (HTML5 Video)
**File:** `/frontend/src/ProxyStreamPlayer.js`
- Simple native HTML5 video element
- Minimal error handling
- Direct fallback mechanism only

### UniversalPlayer
**File:** `/frontend/src/UniversalPlayer.js`
- Tests multiple methods: iframe → HLS → native → VideoJS
- Fallback chain on each failure
- No automatic stall detection
- Manual method switching

---

## 5. Current Recovery Flow (IPTVPlayer with mpegts.js)

```
Channel Selected
        ↓
Load mpegts.js (CDN)
        ↓
Initialize Player
        ↓
PLAYING STATE
        ↓
┌─────────────────────────────────────────────────────────┐
│ Error/Stall Detected                                    │
└─────────────────────────────────────────────────────────┘
        ↓
Check: Channel Changed? → Yes → Abandon Recovery
        ↓ No
Check: Retry Count < 3?
        ↓ Yes (1st-3rd retry)
┌─────────────────────────────────────┐
│ Exponential Backoff Delay           │
│ 1st retry: 1 second                 │
│ 2nd retry: 2 seconds                │
│ 3rd retry: 4 seconds                │
└─────────────────────────────────────┘
        ↓
Check: Channel Still Same?
        ↓ Yes
Re-initialize Player
        ↓ (Return to PLAYING STATE)
        
        ↓ No (Max retries exceeded)
Show Error: "Stream appears to be frozen..."
Stop Retry Loop
```

---

## 6. Buffer Management Configuration

### mpegts.js Buffer Settings
```javascript
maxBufferSize: 32 * 1024 * 1024    // 32 MB cap
autoCleanupSourceBuffer: true       // Auto-cleanup enabled
enableStashBuffer: false            // No stash buffer
liveBufferLatencyChasing: true      // Chase latency for live streams
```

### What These Settings Do:
- **maxBufferSize (32MB):** Prevents excessive memory usage, good for older devices
- **autoCleanupSourceBuffer:** Automatically removes old video data from memory
- **enableStashBuffer: false:** Reduces latency by not buffering ahead
- **liveBufferLatencyChasing:** Adjusts playback speed to match live stream

---

## 7. Debugging & Monitoring

### Built-in Debug Panel (IPTVPlayer)
- Toggle with debug icon (shield icon)
- Shows real-time logs (last 20 events)
- Displays:
  - Current playback method
  - Channel information
  - Matched EPG ID
  - Stream URL
  - All player events and errors

### Log Categories
```javascript
log('info', 'message')    // Info events
log('warn', 'message')    // Warnings
log('error', 'message')   // Errors
// Each log includes timestamp and optional data
```

### Key Debug Points
```javascript
// Player initialization
'[IPTVPlayer v16:40] getChannelId called'
'Initializing mpegts.js player'

// Playback events
'Video playing'
'Video waiting'
'Video stalled'

// Errors
'mpegts player error: {errorType, errorDetail, errorInfo}'
'Clappr stalled for XXXms - attempting recovery'

// Recovery
'Recovering from stall (1/3)...'
'Retrying stream...'
```

---

## 8. State Management

### Key Refs (Persisted Across Renders)
```javascript
playerInstanceRef        // Current player instance
retryCountRef           // Tracks retry attempts
retryTimerRef           // Timeout ID for delayed retry
stallTimerRef           // Timeout ID for stall detection
lastPlayingTimeRef      // Timestamp of last successful frame
currentChannelIdRef     // Current channel ID (for change detection)
```

### Key State Variables
```javascript
error           // Error message to display
loading         // Show loading spinner
logs            // Array of log messages
showDebug       // Debug panel visibility
epgData         // Current program data
```

---

## 9. Limitations & Gaps

### No Automatic Recovery For:
1. **Network Disconnection** - Only detected via NETWORK_ERROR event
2. **Provider Rate Limiting (407/429 errors)** - Treated as fatal
3. **Session Expiration** - No token refresh mechanism
4. **Source/Portal Auth Expiration** - No credential refresh
5. **M3U8 Manifest Failures** - Not handled in mpegts.js

### Known Issues:
1. **Stall Detection Tuning:**
   - 12-second detection delay may be too long for critical viewers
   - `lastPlayingTimeRef` only updated on playing/timeupdate events
   
2. **Stream Format Mismatch:**
   - No automatic format detection or conversion
   - Requires manual playback method selection
   
3. **Memory Leaks:**
   - Large buffer size (32MB) could accumulate if stall recovery loops
   - No explicit cleanup of failed instances before retry

4. **Android/Mobile:**
   - mpegts.js not optimized for mobile
   - No adaptive bitrate (ABR) like HLS
   - Limited mobile browser MSE support

---

## 10. Backend Stream Proxy

### Stream Endpoint
**Route:** `GET /api/stream/:sessionId/:channelId`

**Features:**
- Channel lookup by ID or tvgId
- Source ID filtering (per IPTV source)
- Stalker portal refresh (fresh token handling)
- Format negotiation (TS/M3U8)
- HEAD request support (availability check)

**Error Handling:**
```javascript
// DNS errors → ENOTFOUND
// Timeout → ETIMEDOUT  
// Connection refused → ECONNREFUSED
// HTTP errors → statusCode
```

**Stalker Portal Support:**
- Automatically requests fresh stream token
- Handles empty stream ID issues
- Uses correct authentication headers (MAC, User-Agent)
- Replaces localhost with actual server address

---

## 11. Integration Points

### Frontend → Backend
```javascript
// Get stream URL
`/api/stream/${sessionId}/${channelId}?format=ts&source_id=${sourceId}`

// Fetch EPG data
`/api/epg/${sessionId}?channelId=${epgId}`

// Get network info (for casting)
`/api/network-info`
```

### Authentication
- JWT token via `authMiddleware`
- Session ID in URL
- User ID from authenticated context

---

## Summary Table

| Aspect | Implementation | Status |
|--------|---|---|
| Primary Player | mpegts.js | Active |
| Error Retry | Exponential backoff (3x) | Active |
| Stall Detection | 12s timeout | Active |
| Stall Recovery | Player re-init (3x) | Active |
| Network Recovery | Auto-retry | Active |
| Adaptive Bitrate | None (mpegts.js limitation) | Missing |
| Format Detection | Manual | Manual |
| Mobile Optimization | Limited | Basic |
| Buffer Cleanup | Auto | 32MB max |
| Casting Support | Chromecast (HLS) | Active |
| Debug Panel | Built-in | Active |

---

