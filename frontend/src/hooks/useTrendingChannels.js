import { useEffect, useState, useRef, useCallback } from 'react';
import apiClient from '../utils/apiClient';

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls /api/trending/live for the current ranked list of "what's being
 * watched right now" globally — composite of YouTube concurrent viewers,
 * Twitch restream viewer counts, Reddit comment velocity, and Bluesky
 * mention rate. The backend refreshes its own snapshot every 60s; we
 * poll every 30s so the UI sees fresh data shortly after each refresh.
 *
 * Active state: starts polling immediately and continues until the
 * caller flips `enabled` to false (typical pattern: only poll while a
 * modal/drawer that needs the data is open). The first response lands
 * within ~200ms; subsequent pollings replace the snapshot.
 */
export function useTrendingChannels({ enabled = true, region = null, category = null, limit = 25 } = {}) {
  const [snapshot, setSnapshot] = useState({
    channels: [],
    generatedAt: null,
    sourcesActive: [],
    sourcesEnabled: [],
    stale: false,
    loading: true,
    error: null,
  });
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  const fetchOnce = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const params = { limit };
      if (region) params.region = region;
      if (category) params.category = category;
      const resp = await apiClient.get('/trending/live', {
        params,
        signal: controller.signal,
      });
      setSnapshot({
        channels: resp.data?.channels || [],
        generatedAt: resp.data?.generatedAt || null,
        sourcesActive: resp.data?.sourcesActive || [],
        sourcesEnabled: resp.data?.sourcesEnabled || [],
        stale: !!resp.data?.stale,
        loading: false,
        error: null,
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      setSnapshot((s) => ({ ...s, loading: false, error: e.message || 'Trending fetch failed' }));
    }
  }, [region, category, limit]);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    fetchOnce();
    timerRef.current = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (abortRef.current) abortRef.current.abort();
    };
  }, [enabled, fetchOnce]);

  return { ...snapshot, refresh: fetchOnce };
}

export default useTrendingChannels;
