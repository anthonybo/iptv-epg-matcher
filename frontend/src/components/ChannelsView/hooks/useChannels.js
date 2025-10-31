import { useState, useEffect, useMemo } from 'react';
import { API_BASE_URL } from '../../../config';

/**
 * Custom hook for managing channel data, categories, and filtering
 * @param {string} sessionId - The session ID for fetching channels
 * @returns {object} Channel data, categories, loading states, and filter functions
 */
export const useChannels = (sessionId) => {
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
        const response = await fetch(`${API_BASE_URL}/api/channels/${sessionId}/categories`);

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
  }, [sessionId]);

  // Fetch channels
  useEffect(() => {
    if (!sessionId) return;

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

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Failed to fetch channels: ${response.status}`);
        }

        const data = await response.json();

        if (data.channels) {
          setChannels(prev => page === 1 ? data.channels : [...prev, ...data.channels]);
          setHasMore(data.channels.length === limit);
        }
      } catch (err) {
        console.error('Error fetching channels:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchChannels();
  }, [sessionId, page, selectedCategories]);

  // Filter channels based on selected categories and search term
  const filteredChannels = useMemo(() => {
    return channels.filter(channel => {
      // Category filter
      const categoryMatch = selectedCategories.size === 0 ||
        (channel.groupTitle && selectedCategories.has(channel.groupTitle));

      // Search filter
      const searchMatch = !searchTerm ||
        (channel.name && channel.name.toLowerCase().includes(searchTerm.toLowerCase()));

      return categoryMatch && searchMatch;
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
