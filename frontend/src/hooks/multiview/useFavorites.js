import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * useFavorites — owns the per-user channel-favorites slice.
 *
 * Identity model: a favorite is keyed by (sourceId, channelId). Same
 * channel name from a different source/account is a separate favorite —
 * that's the whole point. The hook exposes:
 *
 *   favorites             — server-ordered list (by position)
 *   loading, error
 *   isFavorite(srcId, chId)  → boolean   (O(1))
 *   findFavorite(srcId, chId) → favorite | null
 *   toggleFavorite(channel)  → adds or removes; optimistic
 *   removeFavorite(id)
 *   reorder(idsInNewOrder)
 *   bumpPlayed(id)
 *   reload()
 *
 * Optimism strategy: add/remove flip local state immediately and roll
 * back on server error, so the UI never feels laggy when the user is
 * triaging a long list. Reorder also flips locally and sends the full
 * order to the server in a single PATCH.
 */

const getAuthToken = () =>
  localStorage.getItem('auth_token') ||
  sessionStorage.getItem('token') ||
  localStorage.getItem('token');

const authHeaders = () => {
  const token = getAuthToken();
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
};

const keyOf = (sourceId, channelId) => `${sourceId}::${channelId}`;

export function useFavorites({ enabled = true } = {}) {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // The set of currently-favorited keys is derived but cached so callers
  // can do isFavorite() in render without paying a per-row scan.
  const keySet = useMemo(
    () => new Set(favorites.map((f) => keyOf(f.sourceId, f.channelId))),
    [favorites]
  );
  // Pending optimistic ops keyed by channel — used to debounce rapid
  // double-clicks on the heart and to suppress visual flicker.
  const pendingRef = useRef(new Set());

  const reload = useCallback(async () => {
    if (!getAuthToken()) {
      setFavorites([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/favorites', { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setFavorites(data.favorites || []);
    } catch (e) {
      console.error('[useFavorites] load failed', e);
      setError(e.message || 'Failed to load favorites');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  const isFavorite = useCallback(
    (sourceId, channelId) => keySet.has(keyOf(sourceId, channelId)),
    [keySet]
  );

  const findFavorite = useCallback(
    (sourceId, channelId) =>
      favorites.find(
        (f) => f.sourceId === sourceId && f.channelId === channelId
      ) || null,
    [favorites]
  );

  // Add — POSTs and merges the server-emitted row (which carries the
  // joined source metadata) so the new chip renders with the auto-label
  // immediately. Returns { ok, error } so the caller can surface the
  // real server error (e.g. "table does not exist") in a toast.
  const addFavorite = useCallback(async (channel) => {
    const sourceId = channel.sourceId ?? channel.source_id;
    const channelId = channel.id ?? channel.channelId ?? channel.channel_id;
    if (!sourceId || !channelId || !channel.name) {
      return { ok: false, error: 'Missing sourceId/channelId/name' };
    }

    const key = keyOf(sourceId, channelId);
    if (pendingRef.current.has(key)) return { ok: false, error: 'In-flight' };
    pendingRef.current.add(key);

    // Optimistic placeholder. Source meta will be replaced when the
    // server response lands. The temp id is negative so it never
    // collides with a real serial PK.
    const tempFav = {
      id: -Date.now(),
      sourceId,
      channelId,
      name: channel.name,
      logo: channel.logo || channel.tvgLogo || null,
      url: channel.url || null,
      position: favorites.length,
      sourceType: channel.sourceType || channel.source_type || null,
      sourceUrl: channel.sourceUrl || channel.source_url || null,
      sourceUsername: channel.sourceUsername || channel.source_username || null,
      sourceMac: channel.sourceMac || channel.source_mac || null,
      sourceName: channel.sourceName || channel.source_name || null,
      _optimistic: true
    };
    setFavorites((prev) => [...prev, tempFav]);

    try {
      const res = await fetch('/api/favorites', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          sourceId,
          channelId,
          name: channel.name,
          logo: channel.logo || channel.tvgLogo || null,
          url: channel.url || null
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data.favorite) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      // Swap the optimistic row for the real one.
      setFavorites((prev) =>
        prev.map((f) => (f.id === tempFav.id ? data.favorite : f))
      );
      return { ok: true };
    } catch (e) {
      console.error('[useFavorites] add failed', e);
      // Rollback.
      setFavorites((prev) => prev.filter((f) => f.id !== tempFav.id));
      const msg = e.message || 'Failed to add favorite';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      pendingRef.current.delete(key);
    }
  }, [favorites.length]);

  const removeFavorite = useCallback(async (favoriteId) => {
    if (!favoriteId) return { ok: false, error: 'Missing favoriteId' };
    const prev = favorites;
    setFavorites((p) => p.filter((f) => f.id !== favoriteId));
    try {
      const res = await fetch(`/api/favorites/${favoriteId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      return { ok: true };
    } catch (e) {
      console.error('[useFavorites] remove failed', e);
      setFavorites(prev);
      const msg = e.message || 'Failed to remove favorite';
      setError(msg);
      return { ok: false, error: msg };
    }
  }, [favorites]);

  // Single entry-point used by heart buttons: figures out whether to add
  // or remove based on current state.
  const toggleFavorite = useCallback(async (channel) => {
    const sourceId = channel.sourceId ?? channel.source_id;
    const channelId = channel.id ?? channel.channelId ?? channel.channel_id;
    if (!sourceId || !channelId) {
      return { ok: false, error: 'Missing sourceId/channelId' };
    }

    const existing = findFavorite(sourceId, channelId);
    if (existing) {
      return removeFavorite(existing.id);
    }
    return addFavorite(channel);
  }, [findFavorite, addFavorite, removeFavorite]);

  const reorder = useCallback(async (idsInNewOrder) => {
    if (!Array.isArray(idsInNewOrder) || idsInNewOrder.length === 0) return false;
    const prev = favorites;
    // Reorder locally first.
    const byId = new Map(favorites.map((f) => [f.id, f]));
    const reordered = idsInNewOrder
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((f, i) => ({ ...f, position: i }));
    // Append any favorites not present in the new order at the end (defensive).
    const seen = new Set(idsInNewOrder);
    favorites.forEach((f) => {
      if (!seen.has(f.id)) reordered.push({ ...f, position: reordered.length });
    });
    setFavorites(reordered);

    try {
      const res = await fetch('/api/favorites/reorder', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ order: idsInNewOrder })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      return true;
    } catch (e) {
      console.error('[useFavorites] reorder failed', e);
      setFavorites(prev);
      setError(e.message || 'Failed to reorder favorites');
      return false;
    }
  }, [favorites]);

  // Fire-and-forget — we don't optimistically update play counters in
  // local state, the next reload will pick them up. This is the
  // "telemetry-ish" path so a failed POST shouldn't surface to the user.
  const bumpPlayed = useCallback(async (favoriteId) => {
    if (!favoriteId) return;
    try {
      await fetch(`/api/favorites/${favoriteId}/played`, {
        method: 'POST',
        headers: authHeaders()
      });
    } catch (e) {
      console.warn('[useFavorites] bumpPlayed failed silently', e);
    }
  }, []);

  return {
    favorites,
    loading,
    error,
    isFavorite,
    findFavorite,
    toggleFavorite,
    addFavorite,
    removeFavorite,
    reorder,
    bumpPlayed,
    reload
  };
}
