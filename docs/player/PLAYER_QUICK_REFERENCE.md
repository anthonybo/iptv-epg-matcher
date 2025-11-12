# Video Player Quick Reference

## TL;DR - Main Components

### Primary Player
- **File:** `frontend/src/IPTVPlayer.js`
- **Library:** mpegts.js (MPEG-TS) + Clappr fallback (HLS)
- **Default Mode:** `mpegts-player`

### Key Files
```
frontend/src/
├── IPTVPlayer.js           # Main player (1550 lines, actively used)
├── SimplePlayer.js         # VideoJS-based alternative
├── HLSPlayer.js           # HLS.js dedicated player
├── ProxyStreamPlayer.js    # Native HTML5 fallback
├── UniversalPlayer.js      # Multi-method fallback chain
├── DirectStreamPlayer.js   # Direct streaming
├── VideoPlayer.js          # Basic video element player
└── ReactPlayerComponent.js # React-player wrapper
```

---

## Error & Recovery Quick Map

### Automatic Retry Logic
```
Error Detected
    ↓
Check if channel changed? → If yes: Stop
    ↓
Retry Count < 3?
    ↓
Delay: 1s, 2s, 4s (exponential backoff)
    ↓
Re-initialize player
    ↓
Check if channel changed? → If yes: Stop
    ↓
All retries exhausted? → Show error
```

### Stall Detection
- Triggered: Video not progressing for >10 seconds
- Detection: 12-second timeout on waiting/stalled events
- Recovery: Same as error retry (3 attempts)

---

## Configuration Constants (in IPTVPlayer.js)

```javascript
MAX_RETRIES = 3                    // Line ~410, 589, 688
STALL_TIMEOUT = 12000 ms           // Line 424, 703
STALL_THRESHOLD = 10000 ms         // Line 406, 685
MAX_RETRY_DELAY = 8000 ms          // Lines 452, 599
```

---

## Error Types & Messages

### mpegts.js Errors
| Type | Detail | User Message |
|------|--------|---|
| NETWORK_ERROR | INVALID_STATUS_CODE | "Channel not found or unavailable (HTTP XXX)" |
| NETWORK_ERROR | Other | "Network error loading stream: Check connection" |
| MEDIA_ERROR | Any | "Media error: Format not supported or corrupted" |
| Other | Any | "Stream playback error. Try another method" |

### During Recovery
- `"Stream error - retrying (1/3)..."` (Error path)
- `"Stream stalled - recovering (1/3)..."` (Stall path)
- `"Stream appears to be frozen..."` (Final failure)

---

## Testing Stream Errors

### Test Frozen Stream
1. Turn off provider/internet
2. Observe: "Stream stalled - recovering..." message
3. After 3 retries: "Stream appears to be frozen..."
4. Check debug panel for retry attempts

### Test Network Error
1. Use invalid channel ID
2. Backend returns 404
3. mpegts.js triggers error event
4. Automatic retry with exponential backoff

### Test Provider 407 (Proxy Auth Required)
1. Stalker portal without fresh token
2. 407 error from provider
3. Treated as fatal (no retry)
4. User sees: "Channel not found or unavailable (HTTP 407)"

---

## Debug Panel Usage

### Access
- Click shield icon (top-right when theatre mode OFF)
- Shows last 20 log entries
- Real-time updates

### What to Look For
```
[info] Initializing mpegts.js player
[info] Video playing
[warn] Video stalled
[error] mpegts player error: {errorType, errorDetail}
[info] Recovering from stall (1/3)...
[error] Stream stalled after 3 recovery attempts
```

---

## State Tracking (useRef - Important!)

```javascript
playerInstanceRef      // mpegts.js or Clappr instance
retryCountRef          // Current retry attempt (0-3)
retryTimerRef          // Timeout ID for delayed retry
stallTimerRef          // Timeout ID for stall detection
lastPlayingTimeRef     // Timestamp of last video frame
currentChannelIdRef    // Channel ID when error occurred
```

These are refs, not state, so updates don't trigger re-renders.

---

## Buffer Management

### Current Settings
```javascript
maxBufferSize: 32 * 1024 * 1024         // 32 MB cap
autoCleanupSourceBuffer: true            // Auto-cleanup enabled
enableStashBuffer: false                 // No stash buffering
liveBufferLatencyChasing: true          // Latency chasing enabled
```

### Effect
- Good for low-bandwidth / older devices
- Low latency for live streams
- Automatic memory management

---

## Integration Points

### Frontend to Backend
```
Stream request:
GET /api/stream/{sessionId}/{channelId}
  ?format=ts
  &source_id={sourceId}

EPG request:
GET /api/epg/{sessionId}
  ?channelId={epgId}

Network info (casting):
GET /api/network-info
```

### Authentication
- JWT token in `Authorization` header (via authMiddleware)
- Session ID in URL path
- User ID from auth context

---

## Known Limitations

### Hard Constraints
- No adaptive bitrate (mpegts.js limitation)
- No automatic format detection
- 12-second stall detection delay (may be too long)
- Mobile/Android support limited (MSE constraints)

### Recovery Gaps
- No token refresh (auth expiration)
- No rate-limiting backoff (407/429 errors)
- No DNS failover
- No manifest refresh for HLS

---

## Quick Debugging Checklist

When stream won't play:
1. [ ] Check debug panel - what's the actual error?
2. [ ] Is channel ID correct? (Check "Channel ID" in debug)
3. [ ] Check stream URL - does it start with `/api/stream/`?
4. [ ] Is backend alive? Test `/api/health`
5. [ ] Check browser console for JavaScript errors
6. [ ] Try a different channel - is it provider-wide?
7. [ ] Try a different playback method (Settings)
8. [ ] Check if auth token expired (401 in logs)

---

## File Sizes (Reference)

```
IPTVPlayer.js      1,551 lines  (main player)
SimplePlayer.js      420 lines  (alt player)
UniversalPlayer.js   960 lines  (fallback chain)
HLSPlayer.js        230 lines  (HLS only)
ProxyStreamPlayer.js 186 lines  (simple fallback)
VideoPlayer.js      477 lines  (basic video)
```

IPTVPlayer.js is the active, maintained player. Others are legacy/alternatives.

---

## Performance Notes

### Startup Time
- First load: ~2-3s (mpegts.js CDN download)
- Subsequent: ~500ms (cached)
- Player init: ~100-200ms
- First frame: ~500ms-2s (depends on provider)

### Memory Usage
- mpegts.js: ~32MB max (configurable)
- Player instance: ~5-10MB
- Total per stream: ~40-50MB

### Recovery Overhead
- Stall detection: 12 seconds
- Total recovery time for 3 retries: ~7 seconds minimum (1+2+4)
- Re-init latency: ~200-500ms per attempt

---

## Related Documentation

- See `PLAYER_ARCHITECTURE.md` for detailed design
- See `CLAUDE.md` section "5. Dummy EPG Generation" for EPG data
- See `backend/routes/stream.js` for server-side proxy
- See `backend/routes/epg.js` for EPG endpoint

