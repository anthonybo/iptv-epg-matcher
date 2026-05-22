import { useCallback, useState } from 'react';
import { showToast } from '../../components/Toast';
import { addToMultiview, removeFromMultiview, updateMutedState } from '../../utils/multiviewManager';
import { getBlacklistedChannelIds } from '../../utils/streamBlacklist';

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

/**
 * Owns the cross-page channel-picker slice for multi-view.
 *
 * Two entry points share one modal:
 *   openForQuery(query)     — header search disambiguation. Fetches
 *                             candidates by free-form query, lets the
 *                             user pick one to ADD to the grid.
 *   openForStream(stream)   — per-tile "alternate sources" button.
 *                             Pre-fills the query with the stream's
 *                             current name and SWAPS the picked channel
 *                             into that slot (preserves espnEventId,
 *                             searchQuery, mute state — same identity
 *                             carry-over swapStream does in
 *                             useFindAlternative.js).
 *
 * State:
 *   isOpen, title, subtitle, loading, error, candidates,
 *   currentChannelId, currentSourceId
 *
 * Exposes:
 *   openForQuery, openForStream, close, onPick (bound), and the modal
 *   state object (spread into <ChannelPickerModal {...state} />).
 */
export function useChannelPicker({
  streams,
  setStreams,
  setStreamQualities,
  mutedStreams
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [title, setTitle] = useState('Pick a channel');
  const [subtitle, setSubtitle] = useState('');
  // Mode: 'add' (picker → addToMultiview) or 'swap' (picker → swap a
  // specific tile). Determines what onPick does.
  const [mode, setMode] = useState('add');
  // Stream context for swap mode — captured at open time so a later
  // grid mutation doesn't break the swap target.
  const [swapTarget, setSwapTarget] = useState(null);
  // Current playing identifiers so the modal can mark the active row
  // with a "Now playing" badge.
  const [currentChannelId, setCurrentChannelId] = useState(null);
  const [currentSourceId, setCurrentSourceId] = useState(null);
  // The query string that produced the current `candidates`. The
  // modal reads this to label the active-query chip and detect
  // "input has diverged → invite re-search" state.
  const [currentQuery, setCurrentQuery] = useState(null);

  const close = useCallback(() => {
    setIsOpen(false);
    // Defer state reset by a frame so the close animation (if any)
    // doesn't see the candidates flicker.
    setTimeout(() => {
      setLoading(false);
      setError(null);
      setCandidates([]);
      setSwapTarget(null);
      setCurrentChannelId(null);
      setCurrentSourceId(null);
      setCurrentQuery(null);
    }, 50);
  }, []);

  // Shared candidate fetch. Returns { ok, candidates, error }.
  const fetchCandidates = useCallback(async (query, opts = {}) => {
    const token = getToken();
    if (!token) {
      return { ok: false, error: 'Authentication required' };
    }

    const excludeSourceIds = Array.isArray(opts.excludeSourceIds) ? opts.excludeSourceIds : [];
    const excludeChannelIds = Array.isArray(opts.excludeChannelIds) ? opts.excludeChannelIds : [];

    try {
      const response = await fetch('/api/live-events/channel-candidates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          query,
          excludeSourceIds,
          excludeChannelIds,
          // 100 is high enough that the user sees every distinct
          // (name, host, account) combination for popular channels
          // like Reelz. The picker has a filter input so a long
          // list isn't a UX problem; an artificially short list is.
          limit: 100
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.success !== true) {
        return {
          ok: false,
          error: data?.error || `Lookup failed (${response.status})`
        };
      }
      return {
        ok: true,
        candidates: data.candidates || [],
        timedOut: data.timedOut === true
      };
    } catch (e) {
      console.error('[Channel Picker] fetch failed', e);
      return { ok: false, error: 'Network error' };
    }
  }, []);

  /**
   * Open the picker with no query — used by the rail's "Open picker"
   * icon. Lands on the Favorites tab when there are saved favorites
   * (per the modal's default-tab heuristic) and otherwise shows the
   * generic empty Results state. No fetch, no toast.
   */
  const openEmpty = useCallback(() => {
    setMode('add');
    setSwapTarget(null);
    setCurrentChannelId(null);
    setCurrentSourceId(null);
    setTitle('Pick a channel');
    setSubtitle('Browse favorites or type to search');
    setCandidates([]);
    setCurrentQuery(null);
    setError(null);
    setLoading(false);
    setIsOpen(true);
  }, []);

  /**
   * Header search → "show me everything called 'reelz', let me pick".
   * Excludes channels already in the grid so the picker only shows
   * options that would actually add a new tile (avoids the
   * confusing "I picked 'US: Reelz HD' but it just no-op'd because
   * that's already what I have").
   */
  const openForQuery = useCallback(async (query) => {
    const q = String(query || '').trim();
    if (q.length < 2) {
      showToast('Enter at least 2 characters to search', 'error');
      return;
    }

    setMode('add');
    setSwapTarget(null);
    setCurrentChannelId(null);
    setCurrentSourceId(null);
    setTitle('Pick a channel to add');
    setSubtitle(`Matches for "${q}"`);
    setCandidates([]);
    setCurrentQuery(q);
    setError(null);
    setLoading(true);
    setIsOpen(true);

    // Exclude both current grid channels (no point offering tiles
    // already on screen) and blacklisted dead channels (no point
    // offering known-broken sources).
    const excludeChannelIds = Array.from(new Set([
      ...streams.map((s) => s.id).filter(Boolean),
      ...getBlacklistedChannelIds()
    ]));
    const result = await fetchCandidates(q, { excludeChannelIds });

    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    setCandidates(result.candidates);
    setLoading(false);
    // Only surface an error banner when the query genuinely failed
    // (timed out, network error, etc). For a clean empty result we
    // leave `error` null so the modal renders the gentler
    // EmptyState — the rose "Couldn't load candidates" card was
    // misleading when the SQL ran fine but happened to return zero
    // rows (e.g. typo, very obscure name).
    if (result.timedOut) {
      setError(
        `Search took longer than expected for "${q}". Try a more specific query.`
      );
    }
  }, [streams, fetchCandidates]);

  /**
   * Per-tile "Alternate sources" button → list other channels with
   * the same/similar name across the user's other sources, plus the
   * dead-channel blacklist excluded so the picker never offers a
   * known-broken option.
   */
  const openForStream = useCallback(async (stream) => {
    if (!stream) return;
    // Prefer the search query (the user's intent — "reelz") over the
    // current channel name ("US: REELZ FHD") so the picker also
    // surfaces variants without the source's prefix decoration.
    const q = String(stream.searchQuery || stream.espnEventName || stream.name || '').trim();
    if (q.length < 2) {
      showToast('No search context for this stream', 'error');
      return;
    }

    setMode('swap');
    setSwapTarget(stream);
    setCurrentChannelId(stream.id || null);
    setCurrentSourceId(stream.sourceId || null);
    setTitle('Switch source');
    setSubtitle(`Showing channels matching "${q}"`);
    setCandidates([]);
    setCurrentQuery(q);
    setError(null);
    setLoading(true);
    setIsOpen(true);

    // Exclude channels currently in the grid OTHER THAN this one (we
    // want the user to be able to re-select the current channel as a
    // refresh, but not see other tiles in the picker), plus dead
    // channels from the session blacklist.
    const excludeChannelIds = [
      ...streams
        .filter((s) => !(s.id === stream.id && s.sourceId === stream.sourceId))
        .map((s) => s.id)
        .filter(Boolean),
      ...getBlacklistedChannelIds()
    ];
    // Dedupe — current id may appear in both lists.
    const uniqExcludeChannelIds = Array.from(new Set(excludeChannelIds));

    const result = await fetchCandidates(q, { excludeChannelIds: uniqExcludeChannelIds });

    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    setCandidates(result.candidates);
    setLoading(false);
    if (result.timedOut) {
      setError(
        `Search took longer than expected for "${q}". Try a more specific query.`
      );
    }
  }, [streams, fetchCandidates]);

  // Bound onPick — branches on mode set at open time. Returns true on
  // success so the modal can auto-close.
  const onPick = useCallback(async (channel) => {
    if (mode === 'add') {
      // Carry the user-supplied query forward as searchQuery so the
      // future find-alternative loop (when this stream eventually
      // dies) keeps searching for the same brand instead of
      // re-extracting one from the channel's noisy name.
      const enriched = {
        ...channel,
        searchQuery: channel.searchQuery || (subtitle.match(/"(.+)"/) || [])[1] || channel.name
      };
      const ok = await addToMultiview(enriched);
      if (ok) {
        window.dispatchEvent(new Event('multiviewUpdate'));
        showToast(`Added "${channel.name}" to Multi-View`, 'success');
        return true;
      }
      showToast('Failed to add channel', 'error');
      return false;
    }

    // mode === 'swap' — replace swapTarget with the picked channel,
    // preserving identity (espnEventId, searchQuery) and mute state so
    // the existing find-alternative chain stays anchored. Mirrors the
    // logic in useFindAlternative.swapStream so behaviour stays
    // identical whether the swap was automatic or user-driven.
    const target = swapTarget;
    if (!target) {
      showToast('Lost track of the slot to swap', 'error');
      return false;
    }
    // Picking the current channel = no-op; just close. Useful when the
    // user opened the picker by mistake.
    if (channel.id === target.id && channel.sourceId === target.sourceId) {
      return true;
    }

    const targetKey = `${target.sourceId}_${target.id}_${target._refreshKey || ''}`;
    const wasMuted = mutedStreams ? mutedStreams.has(targetKey) : true;

    const removed = await removeFromMultiview(target.id, target.sourceId);
    if (removed) {
      setStreams((prev) =>
        prev.filter((s) => !(s.id === target.id && s.sourceId === target.sourceId))
      );
      const oldKey = `${target.sourceId}_${target.id}`;
      setStreamQualities((prev) => {
        const { [oldKey]: _omit, ...rest } = prev;
        return rest;
      });
    }

    const enriched = {
      ...channel,
      espnEventId:   channel.espnEventId   ?? target.espnEventId   ?? null,
      espnEventName: channel.espnEventName ?? target.espnEventName ?? null,
      searchQuery:   channel.searchQuery   ?? target.searchQuery   ?? null
    };
    const added = await addToMultiview(enriched);
    if (!added) {
      showToast('Failed to add replacement channel', 'error');
      return false;
    }

    if (enriched.id && enriched.sourceId) {
      try {
        await updateMutedState(enriched.id, enriched.sourceId, wasMuted);
      } catch (e) {
        console.warn('[Channel Picker] mute carry-over failed', e);
      }
    }

    window.dispatchEvent(new Event('multiviewUpdate'));
    showToast(`Switched to "${channel.name}"`, 'success');
    return true;
  }, [mode, swapTarget, subtitle, mutedStreams, setStreams, setStreamQualities]);

  return {
    // Bind into <ChannelPickerModal {...pickerState} />.
    pickerState: {
      isOpen,
      onClose: close,
      title,
      subtitle,
      loading,
      error,
      candidates,
      onPick,
      currentQuery,
      currentChannelId,
      currentSourceId
    },
    openForQuery,
    openForStream,
    openEmpty,
    closePicker: close
  };
}
