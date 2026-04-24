import { useEffect, useState } from 'react';

// Token is read from storage the same way every other multi-view call
// reads it — kept inline in the hook so callers don't need to pass it.
function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

/**
 * Owns the blacklist slice for the multi-view page.
 *
 * - loads `/api/live-events/blacklist` on mount
 * - exposes add/remove that stay in sync with the local `blacklistedChannels`
 *   array (so the UI doesn't need a refetch round-trip on every change)
 * - owns the `showBlacklistModal` toggle consumed by <BlacklistModal>
 */
export function useBlacklist() {
  const [blacklistedChannels, setBlacklistedChannels] = useState([]);
  const [loadingBlacklist, setLoadingBlacklist] = useState(true);
  const [showBlacklistModal, setShowBlacklistModal] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const token = getToken();
        if (!token) {
          if (!cancelled) setLoadingBlacklist(false);
          return;
        }

        const response = await fetch('/api/live-events/blacklist', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await response.json();
        if (!cancelled && data.success) {
          setBlacklistedChannels(data.blacklist.map((item) => item.channel_name));
        }
      } catch (error) {
        console.error('Failed to load blacklist:', error);
      } finally {
        if (!cancelled) setLoadingBlacklist(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const addToBlacklist = async (channelName) => {
    if (blacklistedChannels.includes(channelName)) return;

    try {
      const token = getToken();
      const response = await fetch('/api/live-events/blacklist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ channelName })
      });

      const data = await response.json();
      if (data.success) {
        setBlacklistedChannels((prev) => [...prev, channelName]);
      }
    } catch (error) {
      console.error('Failed to blacklist channel:', error);
    }
  };

  const removeFromBlacklist = async (channelName) => {
    try {
      const token = getToken();
      const response = await fetch(
        `/api/live-events/blacklist/${encodeURIComponent(channelName)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      const data = await response.json();
      if (data.success) {
        setBlacklistedChannels((prev) => prev.filter((name) => name !== channelName));
      }
    } catch (error) {
      console.error('Failed to remove from blacklist:', error);
    }
  };

  return {
    blacklistedChannels,
    loadingBlacklist,
    showBlacklistModal,
    setShowBlacklistModal,
    addToBlacklist,
    removeFromBlacklist
  };
}
