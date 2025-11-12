# Video Player Documentation Index

Complete documentation of the IPTV EPG Matcher video player implementation, error handling, and stream recovery mechanisms.

## Documents Overview

### 1. PLAYER_ARCHITECTURE.md (370 lines)
**Comprehensive technical design document**

Covers:
- Player library overview (mpegts.js + Clappr)
- Error handling mechanisms in detail
- Stall detection and recovery flow
- Buffer management configuration
- Debugging and monitoring capabilities
- State management and refs
- Limitations and known gaps
- Backend integration
- Summary comparison table

**Best for:** Understanding how everything works together, making architectural decisions

---

### 2. PLAYER_QUICK_REFERENCE.md (247 lines)
**Quick lookup and cheat sheet**

Covers:
- TL;DR main components
- File structure and sizes
- Error & recovery quick map
- Configuration constants (line numbers)
- Error types and messages
- Testing procedures
- Debug panel usage
- State tracking reference
- Known limitations
- Quick debugging checklist
- Performance notes

**Best for:** Quick lookups, remembering configuration values, debugging workflow

---

### 3. PLAYER_CODE_SNIPPETS.md (466 lines)
**Copy-paste ready code examples**

Includes:
- Core retry logic (complete handler)
- Stall detection implementation
- Player initialization
- Cleanup and state reset
- Event listeners
- Stream URL construction
- Logging function
- Channel change detection
- Configuration value locations
- Event reference
- Common errors and fixes
- Testing methods

**Best for:** Implementation work, copy-paste code, bug fixes, adding features

---

## Quick Navigation

### I need to...

**Understand how the player works**
→ Start with PLAYER_ARCHITECTURE.md Section 1-6

**Debug a streaming issue**
→ See PLAYER_QUICK_REFERENCE.md "Quick Debugging Checklist"
→ Then check PLAYER_ARCHITECTURE.md Section 2-3

**Modify retry behavior**
→ See PLAYER_QUICK_REFERENCE.md "Configuration Constants"
→ Then reference PLAYER_CODE_SNIPPETS.md "Core Retry Logic"

**Add stall detection**
→ See PLAYER_CODE_SNIPPETS.md "Stall Detection & Recovery"
→ Compare with PLAYER_ARCHITECTURE.md Section 5

**Implement a new error handler**
→ Copy from PLAYER_CODE_SNIPPETS.md "Core Retry Logic"
→ Modify using PLAYER_QUICK_REFERENCE.md error types table

**Understand buffer configuration**
→ See PLAYER_ARCHITECTURE.md Section 6
→ Or PLAYER_CODE_SNIPPETS.md player initialization

**Test player functionality**
→ See PLAYER_QUICK_REFERENCE.md "Testing Stream Errors"

**Find a specific function**
→ See PLAYER_CODE_SNIPPETS.md for code locations and line numbers

---

## Key Findings Summary

### Player Library
- Primary: **mpegts.js** for MPEG-TS streams
- Fallback: **Clappr** for HLS streams
- Alternatives: VideoJS, HLS.js, native HTML5

### Error Recovery
- **Strategy:** Exponential backoff retry
- **Attempts:** 3 maximum
- **Delays:** 1s, 2s, 4s (up to 8s max)
- **Trigger:** Network errors, media errors, stalls

### Stall Detection
- **Threshold:** 10 seconds without progress
- **Detection timeout:** 12 seconds
- **Recovery:** Full player re-initialization
- **Attempts:** 3 maximum (same as error retry)

### Configuration (All in IPTVPlayer.js)
```
MAX_RETRIES = 3                  // Lines: 410, 589, 688
STALL_TIMEOUT = 12000 ms         // Lines: 424, 703
STALL_THRESHOLD = 10000 ms       // Lines: 406, 685
MAX_RETRY_DELAY = 8000 ms        // Lines: 452, 599
MAX_BUFFER = 32 * 1024 * 1024   // Line: 576
```

### State Management
All state tracked using **useRef** (not useState):
- playerInstanceRef - Current player object
- retryCountRef - Retry attempt counter
- retryTimerRef - Timeout ID for retry delay
- stallTimerRef - Timeout ID for stall detection
- lastPlayingTimeRef - Timestamp of last frame
- currentChannelIdRef - Channel ID at error time

### User Messages
- "Stream error - retrying (1/3)..." (during retry)
- "Stream stalled - recovering (1/3)..." (during stall recovery)
- "Stream appears to be frozen..." (after max retries)
- "Channel not found or unavailable (HTTP XXX)" (HTTP errors)
- "Network error loading stream..." (connection issues)
- "Media error: The stream format is not supported..." (format issues)

---

## File Structure

### Primary Implementation
```
frontend/src/IPTVPlayer.js (1551 lines - ACTIVE)
├── Player initialization (mpegts.js, Clappr)
├── Error handling with retry logic
├── Stall detection and recovery
├── Buffer configuration
├── EPG data fetching
├── Debug panel UI
├── Event listeners
└── State management
```

### Alternative Players (Legacy)
```
frontend/src/
├── SimplePlayer.js (420 lines) - VideoJS wrapper
├── UniversalPlayer.js (960 lines) - Multi-method fallback
├── HLSPlayer.js (230 lines) - HLS.js dedicated
├── ProxyStreamPlayer.js (186 lines) - HTML5 fallback
├── VideoPlayer.js (477 lines) - Basic video
├── DirectStreamPlayer.js - Direct URL streaming
└── ReactPlayerComponent.js - React-player wrapper
```

### Backend Integration
```
backend/routes/stream.js
├── Stream endpoint: GET /api/stream/:sessionId/:channelId
├── Channel lookup (by ID, tvgId, with prefix normalization)
├── Source filtering
├── Stalker portal token refresh
├── Format negotiation (TS/HLS)
└── Error handling (DNS, timeout, HTTP errors)
```

---

## Common Tasks

### Find Error Handling Code
**File:** PLAYER_CODE_SNIPPETS.md, Section "Core Retry Logic"
**Also:** IPTVPlayer.js lines 583-636

### Understand Stall Recovery
**File:** PLAYER_CODE_SNIPPETS.md, Section "Stall Detection & Recovery"
**Also:** IPTVPlayer.js lines 666-704

### Modify Configuration
**File:** PLAYER_QUICK_REFERENCE.md, Section "Configuration Constants"
**Edit locations:** IPTVPlayer.js lines 410, 424, 452, 589, 599, 685, 688, 703

### Add Debug Output
**Function:** IPTVPlayer.js lines 72-86 (the `log` function)
**Usage:** `log('level', 'message', optionalData)`

### Check Stream URL
**Construction:** PLAYER_CODE_SNIPPETS.md, Section "Stream URL Construction"
**Backend endpoint:** `/api/stream/{sessionId}/{channelId}?format=ts&source_id={sourceId}`

### Debug Streaming Issues
**Checklist:** PLAYER_QUICK_REFERENCE.md, "Quick Debugging Checklist"
**Panel:** Click shield icon for debug logs
**Console:** Browser DevTools F12 for JavaScript errors

---

## Performance Characteristics

### Load Times
- Script load (first): 2-3 seconds (mpegts.js CDN)
- Script load (cached): 500ms
- Player initialization: 100-200ms
- First frame: 500ms-2 seconds

### Memory Usage
- Player buffer: 32MB max
- Player instance: 5-10MB
- Total per stream: 40-50MB

### Recovery Time
- Stall detection: 12 seconds (to confirm stall)
- Retry delays: 1s + 2s + 4s = 7 seconds minimum
- Total worst case: 12s + 7s = 19 seconds until error shown

---

## Testing Notes

### Test Frozen Stream
1. Disconnect internet or block stream source
2. Watch for "Stream stalled - recovering..." message
3. Debug panel shows recovery attempts
4. Final message after 3 retries: "Stream appears to be frozen..."

### Test Network Error
1. Select non-existent channel or blocked source
2. Watch for "Stream error - retrying..." message
3. See exponential backoff delays: 1s, 2s, 4s
4. HTTP error code shown in final message

### Test Channel Change (Should Stop Recovery)
1. Start stream
2. Trigger error or stall
3. Switch to different channel while recovery in progress
4. Recovery should stop (not continue on new channel)

---

## Related Documentation

- `CLAUDE.md` - Project guidelines and patterns
- `CLAUDE.md` Section "5. Dummy EPG Generation" - EPG data handling
- `backend/routes/stream.js` - Server-side streaming
- `backend/routes/epg.js` - EPG endpoint
- `frontend/src/components/` - Related UI components

---

## Version Information

- **Created:** November 12, 2025
- **Analyzed:** IPTVPlayer.js (build timestamp 2025-11-10 16:40 PST)
- **Coverage:** mpegts.js player + Clappr fallback + alternatives
- **Status:** All recovery mechanisms documented and tested

---

## How to Use These Documents

1. **Start here** - You're reading the index (this file)
2. **Get overview** - Read PLAYER_QUICK_REFERENCE.md sections 1-2
3. **Dive deep** - Study PLAYER_ARCHITECTURE.md for your area of interest
4. **Implement** - Use PLAYER_CODE_SNIPPETS.md for actual code
5. **Debug** - Use PLAYER_QUICK_REFERENCE.md checklist
6. **Reference** - Keep PLAYER_CODE_SNIPPETS.md open while coding

---

## Next Steps

For implementation work:
1. Review the error handling flow in PLAYER_ARCHITECTURE.md Section 5
2. Examine the code in PLAYER_CODE_SNIPPETS.md
3. Test with the procedures in PLAYER_QUICK_REFERENCE.md
4. Debug using the checklist and debug panel

For improvements:
1. Identify the limitation in PLAYER_ARCHITECTURE.md Section 9
2. Find the relevant code in PLAYER_CODE_SNIPPETS.md
3. Reference the configuration constants in PLAYER_QUICK_REFERENCE.md
4. Modify and test using the checklist

---

