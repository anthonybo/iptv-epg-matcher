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

  const handleSearchChannel = async (e) => {
    e.preventDefault();

    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      showToast('Enter at least 2 characters to search', 'error');
      return;
    }

    setIsSearching(true);

    try {
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map((s) => s.sourceId).filter((id) => id)
        : [];
      const currentChannelIds = streams.map((s) => s.id).filter((id) => id);

      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        setIsSearching(false);
        return;
      }

      const response = await fetch('/api/live-events/search-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          query: searchQuery.trim(),
          excludeSourceIds: currentSourceIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality
        })
      });
      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${data.channel.name}" to Multi-View`, 'success');
          setSearchQuery('');
          setShowSearchInput(false);
        } else {
          showToast('Failed to add channel to Multi-View', 'error');
        }
      } else {
        showToast(data.message || 'No working channel found', 'error');
      }
    } catch (error) {
      console.error('[Search] Error:', error);
      showToast('Search failed', 'error');
    } finally {
      setIsSearching(false);
    }
  };

  return {
    showSearchInput,
    setShowSearchInput,
    searchQuery,
    setSearchQuery,
    isSearching,
    handleSearchChannel
  };
}
