import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../utils/apiClient';

/**
 * useYouTubeFavorites — wraps /api/youtube/favorites and the bulk
 * live-status probe so the multi-view YouTube picker can render a
 * row per saved channel with LIVE / OFFLINE dots without each row
 * firing its own probe.
 *
 * The hook fetches favorites on mount, exposes add/remove/rename,
 * and probes live status when explicitly asked. The probe is opt-in
 * (not auto-fired) because each probe spawns a yt-dlp child process
 * and we don't want to fan out 30 of those on every page load.
 */
export default function useYouTubeFavorites({ enabled = true } = {}) {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [liveStatusById, setLiveStatusById] = useState({});  // channelId -> isLive
  const [statusLoading, setStatusLoading] = useState(false);
  // React 18 StrictMode double-mounts components in dev: mount →
  // cleanup → mount again. Old code only set mountedRef.current=false
  // in the cleanup and never restored it to true on the re-mount,
  // which left every in-flight fetch's `setFavorites` permanently
  // gated off. We set true on each mount and false on cleanup so the
  // current instance always accepts its own responses.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      // Bypass HTTP cache. In React StrictMode the hook double-mounts;
      // the second fetch can come back as a 304 whose body isn't
      // surfaced by axios in all environments, which used to result in
      // `setFavorites([])` and wiping the populated state from the first
      // mount. Forcing fresh JSON avoids the race entirely.
      const r = await apiClient.get('/youtube/favorites', {
        headers: { 'Cache-Control': 'no-cache' },
        params: { _ts: Date.now() }
      });
      if (!mountedRef.current) return;
      // Only update state when we actually got an array — never wipe
      // existing state on a malformed/empty response.
      if (Array.isArray(r.data?.favorites)) {
        setFavorites(r.data.favorites);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.response?.data?.error || e.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const isFavorite = useCallback(
    (channelId) => favorites.some((f) => f.channelId === channelId),
    [favorites]
  );

  const addFavorite = useCallback(async (channel) => {
    const payload = {
      channelId: channel.channelId,
      name: channel.name,
      handle: channel.handle,
      avatarUrl: channel.avatarUrl,
      channelUrl: channel.channelUrl
    };
    try {
      const r = await apiClient.post('/youtube/favorites', payload);
      const fav = r.data?.favorite;
      if (!fav) return null;
      setFavorites((prev) => {
        if (prev.some((f) => f.channelId === fav.channelId)) {
          return prev.map((f) => (f.channelId === fav.channelId ? fav : f));
        }
        return [fav, ...prev];
      });
      return fav;
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      return null;
    }
  }, []);

  const removeFavorite = useCallback(async (id) => {
    const prev = favorites;
    setFavorites((p) => p.filter((f) => f.id !== id));
    try {
      await apiClient.delete(`/youtube/favorites/${id}`);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setFavorites(prev);  // rollback
    }
  }, [favorites]);

  const renameFavorite = useCallback(async (id, customName) => {
    const prev = favorites;
    setFavorites((p) => p.map((f) => (f.id === id ? { ...f, customName } : f)));
    try {
      await apiClient.patch(`/youtube/favorites/${id}`, { customName });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setFavorites(prev);
    }
  }, [favorites]);

  /**
   * Probe live status for the currently-loaded favorites. Each probe
   * is bounded by the backend's cache TTL so calling this repeatedly
   * is safe.
   */
  const probeLiveStatuses = useCallback(async () => {
    if (favorites.length === 0) return;
    setStatusLoading(true);
    try {
      const channelIds = favorites.map((f) => f.channelId);
      const r = await apiClient.post('/youtube/favorites/check-live', { channelIds });
      if (!mountedRef.current) return;
      const next = {};
      for (const s of r.data?.statuses || []) {
        next[s.channelId] = !!s.isLive;
      }
      setLiveStatusById((prev) => ({ ...prev, ...next }));
    } catch (e) {
      // non-fatal: just don't update statuses
    } finally {
      if (mountedRef.current) setStatusLoading(false);
    }
  }, [favorites]);

  return {
    favorites,
    loading,
    error,
    isFavorite,
    addFavorite,
    removeFavorite,
    renameFavorite,
    refresh,
    liveStatusById,
    statusLoading,
    probeLiveStatuses
  };
}
