import { useState, useEffect, useMemo } from 'react';
import { API_BASE_URL } from '../../../config';
import apiClient from '../../../utils/apiClient';

/**
 * Custom hook for managing channel data, categories, and filtering
 * @param {string} sessionId - The session ID for fetching channels
 * @param {number} sourceId - Optional IPTV source ID to filter channels
 * @returns {object} Channel data, categories, loading states, and filter functions
 */
export const useChannels = (sessionId, sourceId = null) => {
  const [channels, setChannels] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategories, setSelectedCategories] = useState(new Set());
  // Initialize search term from sessionStorage to preserve across navigation
  const [searchTerm, setSearchTerm] = useState(() => {
    try {
      return sessionStorage.getItem('channelsSearchTerm') || '';
    } catch {
      return '';
    }
  });
  // Debounced mirror of `searchTerm`. The text input binds to `searchTerm`
  // so typing stays instant, but the expensive work (clearing the list +
  // re-fetching from the backend over the full channel set) keys off
  // `debouncedSearchTerm`, which only settles ~300ms after the last
  // keystroke. Without this, every character triggered a list reset +
  // network fetch + full re-render, freezing the input mid-type.
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(searchTerm);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);
  const [loading, setLoading] = useState(true);
  // `categoriesLoading` is distinct from `loading` so the category
  // sidebar can show "Loading…" while its own fetch is in flight,
  // independently of the channels-list fetch. Previously the sidebar
  // re-used the channels `loading` flag, which flipped to false as
  // soon as the (much faster) channels fetch returned — at which
  // point the sidebar's empty-state path rendered "No categories
  // available" even though the categories fetch was still pending.
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // Per-page row count. Previously 1000, which meant the initial
  // render dumped 1000 rich rows (logo image, badges, three action
  // buttons each) into the DOM in one go — heavy enough to block
  // the main thread and make clicks feel laggy on lower-end
  // machines or during concurrent backend load. 200 is enough to
  // fill ~3 viewport heights; infinite-scroll fetches more as the
  // user reaches the bottom.
  const limit = 200;

  // Fetch categories
  useEffect(() => {
    if (!sessionId) return;

    const abortController = new AbortController();
    let isSubscribed = true;

    const fetchCategories = async () => {
      setCategoriesLoading(true);
      try {
        let url = `/channels/${sessionId}/categories`;
        if (sourceId) {
          url += `?source_id=${sourceId}`;
        }
        const response = await apiClient.get(url, { signal: abortController.signal });
        if (!isSubscribed) return;

        const data = response.data;

        if (Array.isArray(data)) {
          // Normalize category format
          const normalized = data.map(cat => {
            if (typeof cat === 'string') {
              return { name: cat, count: 0 };
            }
            return {
              name: cat.name || cat.category || cat.title || 'Unknown',
              count: cat.count || cat.channelCount || 0
            };
          });
          setCategories(normalized);
        }
      } catch (err) {
        // Ignore aborted requests (expected when sourceId changes
        // mid-flight).
        if (err.name === 'AbortError' || err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
          return;
        }
        console.error('Error fetching categories:', err);
        if (isSubscribed) setError(err.message);
      } finally {
        if (isSubscribed) setCategoriesLoading(false);
      }
    };

    fetchCategories();
    return () => {
      isSubscribed = false;
      abortController.abort();
    };
  }, [sessionId, sourceId]);

  // Save search term to sessionStorage whenever it changes
  useEffect(() => {
    try {
      if (searchTerm) {
        sessionStorage.setItem('channelsSearchTerm', searchTerm);
      } else {
        sessionStorage.removeItem('channelsSearchTerm');
      }
    } catch (error) {
      console.error('[useChannels] Error saving search term to sessionStorage:', error);
    }
  }, [searchTerm]);

  // Clear search term when sourceId changes (different IPTV source = different channels)
  useEffect(() => {
    if (sourceId) {
      setSearchTerm('');
      try {
        sessionStorage.removeItem('channelsSearchTerm');
      } catch (error) {
        console.error('[useChannels] Error clearing search term from sessionStorage:', error);
      }
    }
  }, [sourceId]);

  // Reset page and channels when sourceId or the (debounced) search changes
  useEffect(() => {
    setPage(1);
    setChannels([]);
  }, [sourceId, debouncedSearchTerm]);

  // Fetch channels
  useEffect(() => {
    if (!sessionId) return;

    // Create an AbortController to cancel stale requests
    const abortController = new AbortController();
    let isSubscribed = true;

    const fetchChannels = async () => {
      setLoading(true);

      try {
        // Build URL with category filter if selected
        let url = `/channels/${sessionId}?page=${page}&limit=${limit}`;

        // If exactly one category is selected, use backend filtering
        if (selectedCategories.size === 1) {
          const category = Array.from(selectedCategories)[0];
          url += `&category=${encodeURIComponent(category)}`;
        }

        // Add source filter if provided
        if (sourceId) {
          url += `&source_id=${sourceId}`;
          console.log('[useChannels] Fetching with source filter:', sourceId, 'URL:', url);
        }

        // Add search filter if provided
        if (debouncedSearchTerm) {
          url += `&search=${encodeURIComponent(debouncedSearchTerm)}`;
          console.log('[useChannels] Fetching with search term:', debouncedSearchTerm);
        }

        const response = await apiClient.get(url, { signal: abortController.signal });

        const data = response.data;

        // Only update state if this request wasn't cancelled
        if (isSubscribed && data.channels) {
          console.log('[useChannels] Received', data.channels.length, 'channels. First channel:', data.channels[0]?.name);
          setChannels(prev => {
            if (page === 1) {
              console.log('[useChannels] Replacing channels (page 1)');
              return data.channels;
            }
            console.log('[useChannels] Appending channels (page', page, ')');

            // Deduplicate channels by composite key (sourceId + id) to prevent duplicate key warnings
            const existingKeys = new Set(prev.map(ch => ch.sourceId ? `${ch.sourceId}-${ch.id}` : (ch.id || ch.uuid)));
            const newChannels = data.channels.filter(ch => {
              const key = ch.sourceId ? `${ch.sourceId}-${ch.id}` : (ch.id || ch.uuid);
              return !existingKeys.has(key);
            });

            return [...prev, ...newChannels];
          });
          setHasMore(data.channels.length === limit);
        }
      } catch (err) {
        // Don't log errors for canceled/aborted requests (expected during search)
        if (err.name === 'AbortError' || err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
          // Silently ignore - this is expected when requests are canceled
          return;
        }

        console.error('Error fetching channels:', err);
        if (isSubscribed) {
          setError(err.message);
        }
      } finally {
        if (isSubscribed) {
          setLoading(false);
        }
      }
    };

    fetchChannels();

    // Cleanup function to abort request if component unmounts or deps change
    return () => {
      isSubscribed = false;
      abortController.abort();
    };
  }, [sessionId, page, selectedCategories, sourceId, debouncedSearchTerm]);

  // Filter channels based on selected categories (search is handled on backend)
  const filteredChannels = useMemo(() => {
    // If search is active, return all channels (already filtered by backend)
    if (debouncedSearchTerm) {
      return channels;
    }

    // Otherwise filter by selected categories
    const filtered = channels.filter(channel => {
      const categoryMatch = selectedCategories.size === 0 ||
        (channel.groupTitle && selectedCategories.has(channel.groupTitle));
      return categoryMatch;
    });

    // Deduplicate by composite key as a final safety layer
    const seen = new Set();
    return filtered.filter(channel => {
      const key = channel.sourceId ? `${channel.sourceId}-${channel.id}` : (channel.id || channel.uuid);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [channels, selectedCategories, debouncedSearchTerm]);

  // Toggle category selection
  const toggleCategory = (categoryName) => {
    setSelectedCategories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(categoryName)) {
        newSet.delete(categoryName);
      } else {
        newSet.add(categoryName);
      }
      return newSet;
    });
    // Reset to page 1 when category selection changes
    setPage(1);
    setChannels([]);
  };

  // Clear all category filters
  const clearCategoryFilters = () => {
    setSelectedCategories(new Set());
    // Reset to page 1 when clearing filters
    setPage(1);
    setChannels([]);
  };

  // Load more channels
  const loadMore = () => {
    if (!loading && hasMore) {
      setPage(prev => prev + 1);
    }
  };

  return {
    channels: filteredChannels,
    allChannels: channels,
    categories,
    selectedCategories,
    searchTerm,
    loading,
    categoriesLoading,
    error,
    hasMore,
    setSearchTerm,
    toggleCategory,
    clearCategoryFilters,
    loadMore,
    totalChannels: channels.length,
    filteredCount: filteredChannels.length
  };
};
