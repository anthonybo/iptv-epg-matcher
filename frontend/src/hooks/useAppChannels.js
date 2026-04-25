import { useEffect, useCallback } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../utils/apiClient';
import SessionManager from '../utils/sessionManager';
import iptvSourcesService from '../services/iptvSourcesService';
import { API_BASE_URL } from '../config';

const resolveApiBase = () => {
  if (API_BASE_URL) {
    return API_BASE_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:5001`;
  }

  return '';
};

export function useAppChannels() {
  const {
    sessionId,
    setSessionId,
    channels,
    setChannels,
    totalChannels,
    setTotalChannels,
    categories,
    setCategories,
    hiddenCategories,
    setHiddenCategories,
    selectedCategory,
    setSelectedCategory,
    selectedChannel,
    setSelectedChannel,
    selectedSourceFilter,
    setSelectedSourceFilter,
    userSources,
    setUserSources,
    loadingSources,
    setLoadingSources,
    isLoading,
    setIsLoading,
    loadingError,
    setLoadingError,
    status,
    setStatus,
    statusType,
    setStatusType,
    epgSources,
    setEpgSources,
    activeTab,
    setActiveTab,
    totalMatches,
    setTotalMatches,
  } = useAppContext();

  const { isAuthenticated: authIsAuthenticated, loading: authLoading } = useAuth();

  // Compute channel count from various sources
  const computeChannelCount = useCallback(() => {
    const numeric = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : 0;
    };

    const fromTotal = numeric(totalChannels);
    const fromChannels = Array.isArray(channels) ? numeric(channels.length) : 0;
    const fromCategories = Array.isArray(categories)
      ? categories.reduce((sum, cat) => sum + numeric(cat?.count ?? cat?.channelCount ?? 0), 0)
      : 0;

    const result = fromTotal || fromChannels || fromCategories || 0;
    console.log('[useChannels] computeChannelCount', { fromTotal, fromChannels, fromCategories, result });
    return result;
  }, [totalChannels, channels, categories]);

  // Fetch categories from API
  const fetchCategoriesFromApi = useCallback(async (sid) => {
    try {
      console.log(`[useChannels] Fetching categories for session: ${sid}`);
      const response = await apiClient.get(`/channels/${sid}/categories`);

      const responseType = typeof response.data;
      const isArray = Array.isArray(response.data);

      console.log(`[useChannels] Categories response details:`, {
        type: responseType,
        isArray,
        length: isArray ? response.data.length : 'not an array',
      });

      if (Array.isArray(response.data)) {
        console.log(`[useChannels] Setting ${response.data.length} categories from array`);
        setCategories(response.data);
        const derivedTotal = response.data.reduce(
          (sum, cat) => sum + Number(cat?.count ?? cat?.channelCount ?? 0),
          0
        );
        if (derivedTotal > 0 && derivedTotal !== totalChannels) {
          console.log('[useChannels] Derived total channel count from categories:', derivedTotal);
          setTotalChannels(derivedTotal);
        }
        return response.data;
      } else if (response.data && typeof response.data === 'object') {
        if (Array.isArray(response.data.categories)) {
          console.log(`[useChannels] Setting ${response.data.categories.length} categories from object property`);
          setCategories(response.data.categories);
          const derivedTotal = response.data.categories.reduce(
            (sum, cat) => sum + Number(cat?.count ?? cat?.channelCount ?? 0),
            0
          );
          if (derivedTotal > 0 && derivedTotal !== totalChannels) {
            console.log('[useChannels] Derived total channel count from categories object:', derivedTotal);
            setTotalChannels(derivedTotal);
          }
          return response.data.categories;
        } else {
          console.warn(`[useChannels] Response object doesn't contain categories array:`, response.data);
          setCategories([]);
          return [];
        }
      } else {
        console.warn(`[useChannels] Invalid categories response format:`, response.data);
        setCategories([]);
        return [];
      }
    } catch (error) {
      console.error(`[useChannels] Error fetching categories:`, error);
      setCategories([]);
      return [];
    }
  }, [setCategories, totalChannels, setTotalChannels]);

  // Handle loading channels from server or file
  const handleLoad = useCallback(async (data, force = false, sessionIdParam = null, category = selectedCategory) => {
    setIsLoading(true);
    setLoadingError(null);

    try {
      if (data && typeof data === 'object') {
        const prefetchCount = Number(
          data.totalChannels ?? data.channelCount ?? (Array.isArray(data.channels) ? data.channels.length : undefined)
        );
        if (Number.isFinite(prefetchCount) && prefetchCount > 0) {
          setTotalChannels(prefetchCount);
          setStatus(`${prefetchCount} channels loaded with ${epgSources.length || (data.sources?.length ?? 0)} EPG ${((epgSources.length || (data.sources?.length ?? 0)) === 1) ? 'source' : 'sources'} available`);
          setStatusType('success');
        }
      }

      let sid;
      if (sessionIdParam) {
        sid = sessionIdParam;
      } else {
        sid = await SessionManager.init();
        if (!sid) {
          throw new Error('Failed to initialize session. Please try again.');
        }
      }

      console.log(`[useChannels] Set up session: ${sid}`);
      setSessionId(sid);

      const baseUrl = resolveApiBase();

      try {
        console.log('[useChannels] Explicitly initializing EPG session');
        const epgInitResponse = await fetch(`${baseUrl}/api/epg/init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sessionId: sid })
        });

        if (epgInitResponse.ok) {
          console.log('[useChannels] Successfully initialized EPG session');
        } else {
          console.warn('[useChannels] Failed to initialize EPG session:', epgInitResponse.status);
        }
      } catch (epgInitError) {
        console.error('[useChannels] Error initializing EPG session:', epgInitError);
      }

      let fetchedSources = [];

      try {
        console.log(`[useChannels] Fetching EPG sources for session: ${sid}`);
        const epgResponse = await fetch(`${baseUrl}/api/epg/${sid}/sources`);

        if (!epgResponse.ok) {
          console.warn(`[useChannels] EPG sources request failed: ${epgResponse.status} ${epgResponse.statusText}`);

          if (epgResponse.status === 404) {
            try {
              console.log('[useChannels] Creating test EPG source after 404');
              await fetch(`${baseUrl}/api/epg/${sid}/sources`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  name: 'Test EPG Source',
                  url: 'https://example.com/epg.xml',
                  type: 'xmltv'
                })
              });
            } catch (createError) {
              console.error('[useChannels] Error creating test source:', createError);
            }
          }

          return;
        }

        const epgData = await epgResponse.json();
        fetchedSources = Array.isArray(epgData.sources) ? epgData.sources : [];
        setEpgSources(fetchedSources);
        console.log(`[useChannels] Successfully loaded ${fetchedSources.length} EPG sources`);
      } catch (e) {
        console.log('[useChannels] Error loading EPG sources:', e);
      }

      let resolvedChannelCount = 0;

      if (!data || !data.channels) {
        console.log(`[useChannels] Fetching channels for session: ${sid}`);
        const response = await apiClient.get(`/channels/${sid}`);
        console.log(`[useChannels] Received ${response.data.channels?.length || 0} channels (total reported: ${response.data.totalChannels})`);
        const reportedTotal = Number(response.data.totalChannels ?? response.data.channelCount);
        resolvedChannelCount = Number.isFinite(reportedTotal) && reportedTotal > 0
          ? reportedTotal
          : response.data.channels?.length || 0;
        console.log('[useChannels] Resolved channel count after fetch:', resolvedChannelCount);
        setChannels(response.data.channels || []);
        setTotalChannels(resolvedChannelCount);
      } else {
        console.log(`[useChannels] Using provided channel data: ${data.channels?.length || 0} channels`);
        const providedTotal = Number(data.totalChannels ?? data.channelCount);
        resolvedChannelCount = Number.isFinite(providedTotal) && providedTotal > 0
          ? providedTotal
          : data.channels?.length || 0;
        console.log('[useChannels] Resolved channel count from provided data:', resolvedChannelCount);
        setChannels(data.channels || []);
        setTotalChannels(resolvedChannelCount);
      }

      if (!data || !data.categories) {
        console.log(`[useChannels] Fetching categories for session: ${sid}`);
        await fetchCategoriesFromApi(sid);
      } else {
        console.log(`[useChannels] Using provided categories: ${data.categories?.length || 0} categories`);
        if (Array.isArray(data.categories)) {
          setCategories(data.categories);
        } else {
          console.warn(`[useChannels] Provided categories in unexpected format:`, data.categories);
          setCategories([]);
        }
      }

      const finalChannelCount = resolvedChannelCount || computeChannelCount();

      if (fetchedSources.length > 0) {
        setStatus(`${finalChannelCount} channels loaded with ${fetchedSources.length} EPG ${fetchedSources.length === 1 ? 'source' : 'sources'} available`);
      } else {
        setStatus(`${finalChannelCount} channels loaded successfully`);
      }
      setStatusType('success');

      console.log(`[useChannels] Re-saving session ID for safety: ${sid}`);
      SessionManager.saveSessionId(sid);

      if (authIsAuthenticated) {
        try {
          const sources = await iptvSourcesService.getUserSources();
          setUserSources(sources);
          console.log('[useChannels] Reloaded user sources after successful load:', sources.length);
        } catch (err) {
          console.error('[useChannels] Error reloading sources after load:', err);
        }
      }

      setActiveTab('channels');
    } catch (error) {
      console.error('[useChannels] Error loading channels:', error);

      if (error.response && error.response.status === 404) {
        console.error('[useChannels] Session not found (404), clearing session');
        SessionManager.clearSession();

        setStatus('Your session has expired. Please reload your data.');
        setStatusType('error');

        setActiveTab('configure');
      } else {
        setStatus(`Error loading channels: ${error.message}`);
        setStatusType('error');
      }
    } finally {
      setIsLoading(false);
    }
  }, [selectedCategory, setIsLoading, setLoadingError, setTotalChannels, setStatus, setStatusType, setSessionId, setEpgSources, setChannels, setCategories, computeChannelCount, authIsAuthenticated, setUserSources, setActiveTab, epgSources.length, fetchCategoriesFromApi]);

  // Handle channel selection
  const handleChannelSelect = useCallback((channel) => {
    console.log('[useChannels] handleChannelSelect called with:', channel);
    setSelectedChannel(channel);
    setActiveTab('player');
  }, [setSelectedChannel, setActiveTab]);

  // Load more channels
  const loadMoreChannels = useCallback(async (category = selectedCategory) => {
    if (isLoading) return;

    const currentSessionId = SessionManager.getSessionId();

    if (!currentSessionId) {
      setStatus('No active session. Please load channels first.');
      setStatusType('error');
      return;
    }

    setIsLoading(true);
    setStatus('Loading more channels...');
    setStatusType('info');

    try {
      const pageSize = 1000;
      const currentPage = Math.floor(channels.length / pageSize) + 1;

      let url = `/channels/${currentSessionId}?page=${currentPage}&limit=${pageSize}`;
      if (category) {
        url += `&category=${encodeURIComponent(category)}`;
      }

      const response = await apiClient.get(url);
      setChannels(prev => [...prev, ...response.data.channels]);
      setStatus(`Loaded ${channels.length + response.data.channels.length} of ${response.data.totalChannels} channels`);
      setStatusType('success');
    } catch (error) {
      setStatus(`Error loading more channels: ${error.message}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
    }
  }, [selectedCategory, isLoading, channels.length, setIsLoading, setStatus, setStatusType, setChannels]);

  // Handle category visibility change
  const handleCategoryVisibilityChange = useCallback((updatedHiddenCategories) => {
    const newlyVisibleCategories = hiddenCategories.filter(category =>
      !updatedHiddenCategories.includes(category)
    );

    console.log('Category visibility update:', {
      hiddenBefore: hiddenCategories.length,
      hiddenAfter: updatedHiddenCategories.length,
      newlyVisibleCategories
    });

    setHiddenCategories(updatedHiddenCategories);

    if (newlyVisibleCategories.length === 1 && !selectedCategory) {
      console.log('Auto-selecting newly visible category:', newlyVisibleCategories[0]);
      setSelectedCategory(newlyVisibleCategories[0]);
      handleCategorySelect(newlyVisibleCategories[0]);
      return;
    }

    if (selectedCategory && updatedHiddenCategories.includes(selectedCategory)) {
      setSelectedCategory(null);
      handleCategorySelect(null);
    }

    console.log('Category visibility changed:', {
      updatedHiddenCategories,
      selectedCategory,
      channelCount: channels.length
    });
  }, [hiddenCategories, selectedCategory, channels.length, setHiddenCategories, setSelectedCategory]);

  // Select a specific category to view
  const handleCategorySelect = useCallback(async (category) => {
    if (category === selectedCategory) {
      setSelectedCategory(null);
      setChannels([]);
      setIsLoading(true);

      try {
        const currentSessionId = SessionManager.getSessionId();

        if (!currentSessionId) {
          throw new Error('No active session. Please load channels first.');
        }

        const response = await apiClient.get(`/channels/${currentSessionId}?page=1&limit=1000`);
        setChannels(response.data.channels);
        setTotalChannels(response.data.totalChannels);
        setStatus(`Loaded ${response.data.channels.length} of ${response.data.totalChannels} channels`);
        setStatusType('success');

        await fetchCategoriesFromApi(currentSessionId);
      } catch (error) {
        setStatus(`Error loading channels: ${error.message}`);
        setStatusType('error');
      } finally {
        setIsLoading(false);
      }

      return;
    }

    setSelectedCategory(category);
    setChannels([]);
    setStatus(`Loading channels for category: ${category}...`);
    setStatusType('info');
    setIsLoading(true);

    try {
      const currentSessionId = SessionManager.getSessionId();

      if (!currentSessionId) {
        throw new Error('No active session. Please load channels first.');
      }

      const response = await apiClient.get(`/channels/${currentSessionId}?page=1&limit=1000&category=${encodeURIComponent(category)}`);
      setChannels(response.data.channels);
      setTotalChannels(response.data.totalChannels);
      setStatus(`Loaded ${response.data.channels.length} of ${response.data.totalChannels} channels in ${category}`);
      setStatusType('success');

      await fetchCategoriesFromApi(currentSessionId);
    } catch (error) {
      setStatus(`Error loading channels for ${category}: ${error.message}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
    }
  }, [selectedCategory, setSelectedCategory, setChannels, setStatus, setStatusType, setIsLoading, setTotalChannels, fetchCategoriesFromApi]);

  // Load user sources if authenticated
  useEffect(() => {
    const loadUserSources = async () => {
      if (authLoading) {
        return;
      }

      if (!authIsAuthenticated) {
        return;
      }

      setLoadingSources(true);

      try {
        const sources = await iptvSourcesService.getUserSources();
        setUserSources(sources);
        console.log('[useChannels] Loaded user sources:', sources.length);
      } catch (err) {
        console.error('Error loading user sources:', err);
      } finally {
        setLoadingSources(false);
      }
    };

    loadUserSources();
  }, [authLoading, authIsAuthenticated, setLoadingSources, setUserSources]);

  // Load total matches count
  useEffect(() => {
    const loadTotalMatches = async () => {
      if (authLoading || !authIsAuthenticated) {
        return;
      }

      try {
        const response = await apiClient.get('/epg/matched-channels');
        if (response.data && response.data.count !== undefined) {
          setTotalMatches(response.data.count);
        }
      } catch (err) {
        console.error('Error loading total matches count:', err);
      }
    };

    loadTotalMatches();
  }, [authLoading, authIsAuthenticated, setTotalMatches]);

  // Listen for SSE messages for channel count updates
  useEffect(() => {
    const handleSseMessage = (event) => {
      if (!event?.detail?.data) {
        return;
      }

      const payload = event.detail.data;
      const channelCount = Number(
        payload.totalChannels ??
        payload.channelCount ??
        (Array.isArray(payload.channels) ? payload.channels.length : undefined)
      );

      if (Number.isFinite(channelCount) && channelCount > 0) {
        console.log('[useChannels] SSE update provided channel count:', channelCount);
        setTotalChannels(channelCount);
      }
    };

    window.addEventListener('sseMessage', handleSseMessage);
    return () => window.removeEventListener('sseMessage', handleSseMessage);
  }, [setTotalChannels]);

  // Keep status text aligned with loaded channel/EPG counts
  useEffect(() => {
    console.log('[useChannels] Status sync effect triggered', {
      isLoading,
      totalChannels,
      channelsLength: channels.length,
      epgSourceCount: epgSources.length,
      currentStatus: status
    });

    if (isLoading) {
      return;
    }

    const channelCount = computeChannelCount();

    const desiredStatus = epgSources.length > 0
      ? `${channelCount} channels loaded with ${epgSources.length} EPG ${epgSources.length === 1 ? 'source' : 'sources'} available`
      : `${channelCount} channels loaded successfully`;

    if (status !== desiredStatus) {
      console.log('[useChannels] Updating status banner:', desiredStatus);
      setStatus(desiredStatus);
      setStatusType('success');
    }
  }, [isLoading, totalChannels, channels, categories, epgSources.length, status, computeChannelCount, setStatus, setStatusType]);

  return {
    channels,
    totalChannels,
    categories,
    hiddenCategories,
    selectedCategory,
    selectedChannel,
    selectedSourceFilter,
    userSources,
    loadingSources,
    handleLoad,
    handleChannelSelect,
    loadMoreChannels,
    handleCategoryVisibilityChange,
    handleCategorySelect,
    fetchCategoriesFromApi,
    setSelectedSourceFilter,
  };
}
