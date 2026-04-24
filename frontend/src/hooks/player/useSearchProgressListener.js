import { useEffect } from 'react';

/**
 * Listen for live find-alternative / random-working-stream progress
 * that useFindAlternative dispatches on the window, and stream the
 * "Tested N of M" status into the already-visible error modal.
 *
 * We key updates to this specific stream with `streamKey` so a player
 * in slot 1 doesn't hijack messages meant for slot 3. We only update
 * the error text if the modal is already showing — we never pop one up
 * just because a search kicked off (that's the caller's job).
 */
export default function useSearchProgressListener({
  channelSourceId,
  channelId,
  channelRefreshKey,
  setError
}) {
  useEffect(() => {
    const myKey = `${channelSourceId}_${channelId}_${channelRefreshKey || ''}`;
    const handler = (event) => {
      const detail = event?.detail;
      if (!detail || detail.streamKey !== myKey) return;
      setError((prev) => {
        if (prev == null) return prev;
        return detail.message || prev;
      });
    };
    window.addEventListener('iptv:searchProgress', handler);
    return () => window.removeEventListener('iptv:searchProgress', handler);
  }, [channelId, channelSourceId, channelRefreshKey, setError]);
}
