import { useState } from 'react';
import { showToast } from '../../components/Toast';
import { addToMultiview } from '../../utils/multiviewManager';

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

// /api/live-events/search-channel streams NDJSON — one JSON object per
// line, with a final `{type:'done',...}` record carrying the match.
// Read the stream line-by-line and return the terminal record.
async function consumeSearchNdjson(response) {
  if (!response.body || !response.body.getReader) {
    // Environments without streaming — fall back to a single parse of
    // whatever the body is. The terminal record is a complete JSON
    // object so this still works for buffered responses.
    const text = await response.text();
    const lastLine = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!lastLine) return null;
    try {
      return JSON.parse(lastLine);
    } catch {
      return null;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = null;

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.type === 'done' || msg.type === 'error') terminal = msg;
    } catch {
      // Ignore a malformed line — progress records are best-effort.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      consumeLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) consumeLine(buffer);
  return terminal;
}

/**
 * Owns the header search-box slice (the "search by channel name" input
 * next to the Sport dropdown). Separate from useStreamFinder because the
 * behaviour is different: this one takes a user-supplied query string
 * rather than picking a random matching channel, and it has its own
 * collapse/expand UI state.
 */
export function useStreamSearch({ streams, autoFillSettings }) {
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  /**
   * Run the search-channel pipeline against an arbitrary query string —
   * the form-submit handler and the Trending modal both go through this.
   * Returns true on a successful add, false otherwise.
   */
  const runSearch = async (rawQuery, opts = {}) => {
    const query = String(rawQuery || '').trim();
    if (query.length < 2) {
      showToast('Enter at least 2 characters to search', 'error');
      return false;
    }

    setIsSearching(true);
    if (opts.signal) {
      console.log(`[Search] runSearch starting with cancel signal (query="${query}", aborted=${opts.signal.aborted})`);
      opts.signal.addEventListener('abort', () => {
        console.log(`[Search] AbortSignal fired for query="${query}"`);
      }, { once: true });
    } else {
      console.log(`[Search] runSearch starting WITHOUT cancel signal (query="${query}")`);
    }

    try {
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map((s) => s.sourceId).filter((id) => id)
        : [];
      const currentChannelIds = streams.map((s) => s.id).filter((id) => id);

      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        return false;
      }

      const response = await fetch('/api/live-events/search-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/x-ndjson'
        },
        body: JSON.stringify({
          query,
          excludeSourceIds: currentSourceIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality,
          mode: opts.mode || 'event',
          // Optional alias expansion (Coverage modal's row Test
          // button passes the row's full alias list). Backend OR's
          // these into the SQL filter and the brand-mode scoring
          // accepts a word-boundary match on ANY of them — so one
          // click finds any channel from the broadcaster family
          // even when the user's catalog uses a different alias
          // name than the canonical primary.
          aliases: Array.isArray(opts.aliases) ? opts.aliases : undefined
        }),
        // Plumb the caller's AbortController through so the modal's
        // Cancel button can stop a slow ffprobe loop. Backend
        // search-channel listens for req 'close' (clientGone) and
        // breaks out of the batch + chunk loops within a tick.
        signal: opts.signal
      });
      const terminal = await consumeSearchNdjson(response);

      if (terminal?.success && terminal.channel) {
        const success = await addToMultiview(terminal.channel);
        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${terminal.channel.name}" to Multi-View`, 'success');
          return true;
        }
        showToast('Failed to add channel to Multi-View', 'error');
        return false;
      }
      showToast(terminal?.message || terminal?.error || 'No working channel found', 'error');
      return false;
    } catch (error) {
      // AbortError = user clicked Cancel; that's not a real failure
      // and we don't want a confusing red toast for an intentional
      // user action. The "Search cancelled" toast is friendlier and
      // the per-row spinner clears via the finally block below.
      if (error?.name === 'AbortError') {
        showToast('Search cancelled', 'info');
        return false;
      }
      console.error('[Search] Error:', error);
      showToast('Search failed', 'error');
      return false;
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearchChannel = async (e) => {
    e.preventDefault();
    const ok = await runSearch(searchQuery);
    if (ok) {
      setSearchQuery('');
      setShowSearchInput(false);
    }
  };

  // Programmatic search — used by Trending modal etc. Doesn't touch the
  // input UI state, just runs the pipeline.
  const searchByName = async (name, opts = {}) => runSearch(name, opts);

  return {
    showSearchInput,
    setShowSearchInput,
    searchQuery,
    setSearchQuery,
    isSearching,
    handleSearchChannel,
    searchByName
  };
}
