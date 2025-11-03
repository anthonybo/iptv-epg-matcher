import { useState, useEffect, useMemo } from 'react';
import { API_BASE_URL } from '../../../config';

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
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const limit = 1000;

  // Fetch categories
  useEffect(() => {
    if (!sessionId) return;

    const fetchCategories = async () => {
      try {
        let url = `${API_BASE_URL}/api/channels/${sessionId}/categories`;
        if (sourceId) {
          url += `?source_id=${sourceId}`;
        }
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Failed to fetch categories: ${response.status}`);
        }

        const data = await response.json();

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
        console.error('Error fetching categories:', err);
        setError(err.message);
      }
    };

    fetchCategories();
  }, [sessionId, sourceId]);

  // Reset page and channels when sourceId or searchTerm changes
  useEffect(() => {
    setPage(1);
    setChannels([]);
  }, [sourceId, searchTerm]);

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
        let url = `${API_BASE_URL}/api/channels/${sessionId}?page=${page}&limit=${limit}`;

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
        if (searchTerm) {
          url += `&search=${encodeURIComponent(searchTerm)}`;
          console.log('[useChannels] Fetching with search term:', searchTerm);
        }

        const response = await fetch(url, { signal: abortController.signal });

        if (!response.ok) {
          throw new Error(`Failed to fetch channels: ${response.status}`);
        }

        const data = await response.json();

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
        if (err.name === 'AbortError') {
          console.log('[useChannels] Request aborted');
        } else {
          console.error('Error fetching channels:', err);
          if (isSubscribed) {
            setError(err.message);
          }
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
  }, [sessionId, page, selectedCategories, sourceId, searchTerm]);

  // Filter channels based on selected categories (search is handled on backend)
  const filteredChannels = useMemo(() => {
    // If search is active, return all channels (already filtered by backend)
    if (searchTerm) {
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
  }, [channels, selectedCategories, searchTerm]);

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
