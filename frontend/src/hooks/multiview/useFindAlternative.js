import { useRef, useState } from 'react';
import { showToast } from '../../components/Toast';
import { addToMultiview, removeFromMultiview } from '../../utils/multiviewManager';

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

function streamKeyOf(stream) {
  return `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
}

async function parseJsonSafely(response) {
  // A nodemon restart or dev-proxy timeout can return an empty body with a
  // 5xx, which turns `response.json()` into a confusing
  // `SyntaxError: Unexpected end of JSON input`. Always read text first.
  const rawText = await response.text();
  try {
    return { data: rawText ? JSON.parse(rawText) : {}, rawText };
  } catch {
    return { data: null, rawText };
  }
}

// Push a live progress line out to any listening IPTVPlayer via a window
// event. Using an event (rather than prop-drilling state through 4
// components) keeps the existing hook/grid/cell/player interface stable
// and lets the player swap its own error-modal text without a re-render
// of the grid on every tick.
function emitSearchProgress(streamKey, message) {
  window.dispatchEvent(
    new CustomEvent('iptv:searchProgress', { detail: { streamKey, message } })
  );
}

// Stream the NDJSON body of a search-channel / random-working-stream
// request and invoke `onMessage` for each JSON object the backend emits.
// Returns the final `done` / `error` message (the terminal record in the
// stream), or null if the body wasn't readable.
async function consumeNdjson(response, onMessage) {
  if (!response.body || !response.body.getReader) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.warn('[Find Alternative] Bad NDJSON line:', trimmed);
      return;
    }
    if (msg.type === 'done' || msg.type === 'error') terminal = msg;
    onMessage(msg);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  }
  if (buffer.trim()) handleLine(buffer);

  return terminal;
}

/**
 * Owns the "find alternative" slice for the multi-view page.
 *
 * Two handlers are returned:
 *   - handleFindAlternative(stream, isAutomatic) — search for another
 *     channel carrying the *same* event (same game, different provider).
 *   - handleFindDifferentGame(stream) — swap a dead stream for a
 *     channel on a *different* live event entirely (via
 *     /random-working-stream).
 *
 * State owned here:
 *   - findingAlternativeFor: `Set<streamKey>` — one slot can be searching
 *     while others search in parallel. UI spinner state uses this.
 *   - exhaustedSearchesRef: `Set<lowercaseQuery>` — remembers which
 *     queries already returned nothing so the next attempt for the same
 *     query resets searchOffset=0 instead of paging past the end.
 *   - autoFindRateLimitRef: global rate-limit counters for automatic
 *     (onStreamDead) calls so a provider outage that kills N slots at
 *     once doesn't silence the whole grid for minutes.
 */
export function useFindAlternative({
  streams,
  setStreams,
  setStreamQualities,
  autoFillSettings
}) {
  const [findingAlternativeFor, setFindingAlternativeFor] = useState(() => new Set());

  // Track exhausted searches — when a search exhausts, reset offset to 0
  // on next attempt.
  const exhaustedSearchesRef = useRef(new Set());

  // Auto-find alternative rate limiting to prevent network exhaustion.
  // Tuned to survive a provider outage across a 4-slot grid: the old
  // 3/min + 2-minute pause silenced the whole grid for 2 minutes whenever
  // more than three streams died close together.
  const autoFindRateLimitRef = useRef({
    lastAutoFind: 0,
    autoFindCount: 0,
    windowStart: 0,
    cooldownMs: 3000, // 3 seconds between auto-finds (global)
    maxAutoFinds: 10, // Up to 10 auto-finds per minute
    windowMs: 60000, // 1 minute window
    pauseMs: 30000, // If the window cap is hit, pause auto-finds for 30s
    isPaused: false // Emergency pause
  });

  const markSearching = (key) => {
    setFindingAlternativeFor((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const unmarkSearching = (key) => {
    setFindingAlternativeFor((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  // Returns true when the automatic (onStreamDead) call should proceed.
  const shouldAllowAutomaticFind = () => {
    const rateLimit = autoFindRateLimitRef.current;
    const now = Date.now();

    if (rateLimit.isPaused) {
      console.log('[Find Alternative] Auto-find paused due to too many failures');
      return false;
    }

    if (now - rateLimit.lastAutoFind < rateLimit.cooldownMs) {
      const remaining = Math.round(
        (rateLimit.cooldownMs - (now - rateLimit.lastAutoFind)) / 1000
      );
      console.log(`[Find Alternative] Rate limited - cooldown (${remaining}s remaining)`);
      return false;
    }

    // Reset the rolling window.
    if (now - rateLimit.windowStart > rateLimit.windowMs) {
      rateLimit.windowStart = now;
      rateLimit.autoFindCount = 0;
    }

    if (rateLimit.autoFindCount >= rateLimit.maxAutoFinds) {
      console.log(
        `[Find Alternative] Rate limited - max ${rateLimit.maxAutoFinds} auto-finds per minute reached`
      );
      rateLimit.isPaused = true;
      setTimeout(() => {
        rateLimit.isPaused = false;
        rateLimit.autoFindCount = 0;
        console.log('[Find Alternative] Auto-find unpaused');
      }, rateLimit.pauseMs);
      return false;
    }

    rateLimit.lastAutoFind = now;
    rateLimit.autoFindCount++;
    console.log(
      `[Find Alternative] Auto-find triggered (${rateLimit.autoFindCount}/${rateLimit.maxAutoFinds} this window)`
    );
    return true;
  };

  // Build the search query + starting offset for handleFindAlternative.
  // Priority: stream.searchQuery > stream.espnEventName > cleaned channel name.
  const buildSearchForStream = (stream) => {
    let searchName = stream.searchQuery || stream.espnEventName;
    let searchOffset = stream.searchOffset || 0;

    if (!searchName) {
      // Extract a cleaner search term from the channel name — strip the
      // provider prefix, quality markers, and parentheticals.
      searchName = stream.name
        .replace(/^[^|]+\|\s*/gi, '') // "Peacock Live | ", "SLING| "
        .replace(/^[A-Z]{2,}\s+TEAM\s*[\|:]?\s*/gi, '') // "NHL TEAM| "
        .replace(/\s*(ᴿᴬᵂ|ᴴᴰ|ᶠᴴᴰ|HD|FHD|SD|4K|UHD)\s*/gi, '')
        .replace(/\s*ALTERNATE\s*/gi, '')
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (searchName.length < 3) searchName = stream.name;
      // Start from beginning when no stored offset.
      searchOffset = 0;
    }

    const searchKey = searchName.toLowerCase();
    if (exhaustedSearchesRef.current.has(searchKey)) {
      console.log(
        `[Find Alternative] Previous search for "${searchName}" was exhausted, resetting to offset 0`
      );
      searchOffset = 0;
      exhaustedSearchesRef.current.delete(searchKey);
    }

    return { searchName, searchOffset, searchKey };
  };

  // Swap a dead stream for a fresh channel in local state + backend.
  // Shared by both handlers below so replacement behaviour stays in sync.
  const swapStream = async (deadStream, newChannel) => {
    const removeSuccess = await removeFromMultiview(deadStream.id, deadStream.sourceId);
    if (removeSuccess) {
      setStreams((prevStreams) =>
        prevStreams.filter(
          (s) => !(s.id === deadStream.id && s.sourceId === deadStream.sourceId)
        )
      );
      const oldKey = `${deadStream.sourceId}_${deadStream.id}`;
      setStreamQualities((prev) => {
        const { [oldKey]: _removed, ...rest } = prev;
        return rest;
      });
    }
    return addToMultiview(newChannel);
  };

  const handleFindAlternative = async (stream, isAutomatic = false) => {
    const streamKey = streamKeyOf(stream);

    // Rate limit automatic (onStreamDead) calls — manual clicks skip this.
    // When rate-limited, still escalate to find-different-game so the
    // user doesn't silently get stuck on a dead stream for 2 minutes;
    // the different-game endpoint is one request (not a ffprobe loop)
    // so it doesn't worsen network pressure.
    if (isAutomatic && !shouldAllowAutomaticFind()) {
      emitSearchProgress(
        streamKey,
        'Auto-recovery paused (too many recent failures) — switching to a different live game...'
      );
      await handleFindDifferentGame(stream);
      return;
    }

    // Only block if THIS stream is already being searched for; other slots
    // searching in parallel is fine and actually desirable.
    if (findingAlternativeFor.has(streamKey)) {
      console.log(
        `[Find Alternative] Already finding alternative for ${stream.name}, skipping duplicate request`
      );
      return;
    }

    // Track whether the current player was actually replaced with a new
    // channel. If not (AND the call was automatic) we escalate to
    // find-different-game after the search-channel lock is released.
    // The value starts `false` and only flips `true` when the swap
    // completes successfully — errors, terminal failures, and
    // NDJSON-read-returned-null all leave it `false`.
    let replaced = false;

    markSearching(streamKey);

    try {
      // Exclude the failing source + every other source in the grid so the
      // replacement respects the one-stream-per-account rule (Stalker in
      // particular only allows one concurrent connection per account).
      let excludeSourceIds = [];
      if (stream.sourceId) excludeSourceIds.push(stream.sourceId);
      const otherSourceIds = streams
        .filter((s) => s.id !== stream.id || s.sourceId !== stream.sourceId)
        .map((s) => s.sourceId)
        .filter((id) => id && !excludeSourceIds.includes(id));
      excludeSourceIds = [...excludeSourceIds, ...otherSourceIds];

      const excludeChannelIds = stream.id ? [stream.id] : [];

      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
      } else {
        const { searchName, searchOffset, searchKey } = buildSearchForStream(stream);

        console.log(
          `[Find Alternative] Stream data: searchQuery="${stream.searchQuery}", espnEventName="${stream.espnEventName}", name="${stream.name}"`
        );
        console.log(`[Find Alternative] Searching for "${searchName}" starting at offset ${searchOffset}`);

        emitSearchProgress(streamKey, `Searching for "${searchName}"...`);

        const response = await fetch('/api/live-events/search-channel', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            Accept: 'application/x-ndjson'
          },
          body: JSON.stringify({
            query: searchName,
            excludeSourceIds,
            excludeChannelIds,
            // Exclude by current channel name too so find-alternative
            // won't just return "MLS TEAM | LAFC" from a different
            // source when that's exactly what's already in the slot.
            excludeChannelNames: stream.name ? [stream.name] : [],
            minQuality: autoFillSettings.minQuality,
            searchOffset,
            // If we know the event id, the backend can look up sport /
            // league and apply the cross-sport scoring penalty that
            // pushes e.g. AHL channels below minScore for MLS searches.
            espnEventId: stream.espnEventId || null
          })
        });

        if (!response.body || !response.body.getReader) {
          // Buffered fallback for environments without stream.getReader.
          const { data, rawText } = await parseJsonSafely(response);
          if (!data) {
            console.warn('[Find Alternative] Non-JSON response:', response.status, rawText.slice(0, 200));
            showToast(
              response.status >= 500
                ? 'Server error while searching — backend may be restarting'
                : `Search failed (${response.status || 'network error'})`,
              'error'
            );
          } else {
            const terminal = data.type ? data : {
              type: 'done',
              success: data.success,
              channel: data.channel,
              error: data.error,
              message: data.message
            };
            replaced = await handleSearchTerminal(stream, terminal, searchKey, searchName);
          }
        } else {
          const terminal = await consumeNdjson(response, (msg) => {
            if (msg.type !== 'progress') return;
            // Phase-aware progress so the UI feels alive during slow DB
            // queries, zero-filter batches, and ffprobe chunks alike.
            let label;
            if (msg.phase === 'tested') {
              label = `Tested ${msg.tested}${msg.matched ? ` of ${msg.matched}` : ''} — "${searchName}"`;
            } else if (msg.phase === 'fetched') {
              label = `Scanning batch ${msg.batch || '?'} (${msg.matched} candidates so far)...`;
            } else if (msg.phase === 'querying') {
              label = `Searching batch ${msg.batch || '?'} for "${searchName}"...`;
            } else {
              label = `Searching "${searchName}"...`;
            }
            emitSearchProgress(streamKey, label);
          });

          if (!terminal) {
            showToast('Search ended unexpectedly', 'error');
            emitSearchProgress(streamKey, 'Search ended unexpectedly — trying a different game...');
          } else if (terminal.type === 'error') {
            const msg = terminal.error || 'Search failed';
            showToast(msg, 'error');
            emitSearchProgress(streamKey, isAutomatic ? `${msg} — trying a different game...` : msg);
          } else {
            replaced = await handleSearchTerminal(stream, terminal, searchKey, searchName);
          }
        }
      }
    } catch (error) {
      console.error('[Find Alternative] Error:', error);
      showToast('Failed to find alternative', 'error');
      emitSearchProgress(streamKey, 'Failed to find alternative — trying a different game...');
    } finally {
      unmarkSearching(streamKey);
    }

    // Escalate — but only on automatic triggers and only when the
    // same-game search did not produce a working replacement. The
    // previous version of this block had `return` statements inside
    // the try that caused early function exit after `finally`, so
    // this escalation never actually ran when the stream was
    // `Search ended unexpectedly` or `type === 'error'`. That's why
    // the modal would freeze on "trying a different game..." and no
    // different game ever arrived.
    if (!replaced && isAutomatic) {
      emitSearchProgress(
        streamKey,
        'No stream for this game — switching to a different live game...'
      );
      await handleFindDifferentGame(stream);
    }
  };

  // Handle the terminal `done` record from search-channel. Pulled out so
  // the streaming and buffered paths can share it. Returns `true` iff
  // the current player was successfully replaced with a new channel —
  // the caller uses this to decide whether to escalate to
  // handleFindDifferentGame.
  const handleSearchTerminal = async (stream, terminal, searchKey, searchName) => {
    const streamKey = streamKeyOf(stream);
    if (terminal.success && terminal.channel) {
      exhaustedSearchesRef.current.delete(searchKey);
      // swapStream will unmount the current player, so the error modal
      // disappears with the component — no need to emit a terminal
      // message for the success path.
      const success = await swapStream(stream, terminal.channel);
      if (success) {
        window.dispatchEvent(new Event('multiviewUpdate'));
        const qualityText = terminal.channel.quality ? ` (${terminal.channel.quality}p)` : '';
        showToast(`Replaced with "${terminal.channel.name}"${qualityText}`, 'success');
        return true;
      }
      showToast('Failed to add replacement channel', 'error');
      emitSearchProgress(streamKey, 'Found a replacement but could not add it — try again');
      return false;
    }

    exhaustedSearchesRef.current.add(searchKey);
    console.log(
      `[Find Alternative] Search exhausted for "${searchName}", will reset offset on next attempt`
    );
    const failMsg = terminal.message || terminal.error || 'No alternative channel found';
    // Emit the terminal message so the error modal updates from the
    // last "Tested N of M..." progress tick to the real outcome.
    // Otherwise the modal appears stuck at whatever the last progress
    // line happened to be.
    emitSearchProgress(streamKey, failMsg);
    showToast(failMsg, 'error');
    return false;
  };

  // Replace a dead stream with a channel for a *different* live event (not
  // just another channel for the same game). Hits the random-working-stream
  // backend endpoint, excluding the current event plus everything already
  // in the grid so we never duplicate slots.
  const handleFindDifferentGame = async (stream) => {
    const streamKey = streamKeyOf(stream);

    if (findingAlternativeFor.has(streamKey)) {
      console.log(`[Find Different Game] Already searching for ${stream.name}, skipping`);
      return;
    }

    markSearching(streamKey);
    emitSearchProgress(streamKey, 'Looking for a different live game...');

    try {
      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        return;
      }

      // Exclude every event + source currently on the grid so the
      // replacement is genuinely new content.
      const excludeEventIds = streams.map((s) => s.espnEventId).filter(Boolean);
      const excludeSourceIds = streams.map((s) => s.sourceId).filter(Boolean);

      const response = await fetch('/api/live-events/random-working-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ excludeEventIds, excludeSourceIds })
      });

      const { data } = await parseJsonSafely(response);
      if (!data) {
        const msg =
          response.status >= 500
            ? 'Server error while searching — backend may be restarting'
            : `Search failed (${response.status || 'network error'})`;
        showToast(msg, 'error');
        emitSearchProgress(streamKey, msg);
        return;
      }

      if (!response.ok || !data.success || !data.channel) {
        const msg = data?.message || data?.error || 'No other live games available';
        showToast(msg, 'error');
        emitSearchProgress(streamKey, msg);
        return;
      }

      // swapStream unmounts the current player so the error modal
      // disappears with it — no need to update the progress on success.
      const success = await swapStream(stream, data.channel);
      if (success) {
        window.dispatchEvent(new Event('multiviewUpdate'));
        const eventLabel = data.event?.name ? ` — ${data.event.name}` : '';
        showToast(`Replaced with "${data.channel.name}"${eventLabel}`, 'success');
      } else {
        showToast('Failed to add replacement channel', 'error');
        emitSearchProgress(streamKey, 'Found a game but could not add it — try again');
      }
    } catch (error) {
      console.error('[Find Different Game] Error:', error);
      showToast('Failed to find a different game', 'error');
      emitSearchProgress(streamKey, 'Failed to find a different game — try again');
    } finally {
      unmarkSearching(streamKey);
    }
  };

  return {
    findingAlternativeFor,
    handleFindAlternative,
    handleFindDifferentGame
  };
}
