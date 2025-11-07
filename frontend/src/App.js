// App.js - Enhanced version with modern UI, modular components, and improved session management
import React, { useState, useEffect } from 'react';
// Import our custom apiClient instead of axios directly
import apiClient from './utils/apiClient';
import SessionManager from './utils/sessionManager';
import { API_BASE_URL } from './config';
// Import modular components
import Sidebar from './Sidebar';
import Configuration from './Configuration';
import CategoryManager from './CategoryManager';
import ChannelList from './ChannelList';
import ChannelsView from './components/ChannelsView';
import PlayerView from './PlayerView';
import ResultView from './ResultView';
import GuideView from './GuideView';
import TheatreView from './TheatreView';
import IPTVEditor from './IPTVEditor';
import SessionDebugger from './components/SessionDebugger';
import EpgSourcesSummary from './components/Epg/EpgSourcesSummary';
import MyIPTVs from './pages/MyIPTVs/MyIPTVs';
import iptvSourcesService from './services/iptvSourcesService';
import { useAuth } from './contexts/AuthContext';
import { UserBadge } from './components/AuthWrapper';

const resolveApiBase = () => {
  if (API_BASE_URL) {
    return API_BASE_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:5001`;
  }

  return 'http://localhost:5001';
};

/**
 * Main application component with modernized UI and modular architecture
 * Enhanced with robust session management
 * 
 * @returns {JSX.Element} App component
 */
function App() {
  // Get auth context
  const { user, isAuthenticated: authIsAuthenticated, loading: authLoading } = useAuth();

  // App state
  const [status, setStatus] = useState('');
  const [channels, setChannels] = useState([]);
  const [totalChannels, setTotalChannels] = useState(0);
  const [categories, setCategories] = useState([]);
  const [hiddenCategories, setHiddenCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [epgSources, setEpgSources] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [matchedChannels, setMatchedChannels] = useState({});
  const [totalMatches, setTotalMatches] = useState(0); // Total matches including duplicates (for IPTV Editor)
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState(null);
  const [activeTab, setActiveTab] = useState('myiptvs'); // 'myiptvs', 'channels', 'player', 'guide', 'editor', or 'publish'
  const [showSidebar, setShowSidebar] = useState(true);
  const [sessionDebuggerOpen, setSessionDebuggerOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusType, setStatusType] = useState('info'); // 'info', 'success', 'error', 'warning'
  const [showEmergencyCategories, setShowEmergencyCategories] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [userSources, setUserSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedSourceFilter, setSelectedSourceFilter] = useState(null);
  const [showServerStatus, setShowServerStatus] = useState(false);
  const [isTheatreMode, setIsTheatreMode] = useState(false);

  // Global background loading state (shared across all pages)
  const [backgroundLoadings, setBackgroundLoadings] = useState(new Map());
  const [showLoadingPicker, setShowLoadingPicker] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Check for saved session and validate it on mount
  useEffect(() => {
    // Setup session listener to respond to session updates
    SessionManager.setupSessionListener();
    
    // Only try to validate or create a session once during app initialization
    const initSession = async () => {
      try {
        // Check for existing session
        const existingSessionId = SessionManager.getSessionId();
        
        if (existingSessionId) {
          console.log(`Found saved session, validating: ${existingSessionId}`);
          
          // Check if the session is valid on the backend
          const isValid = await SessionManager.validateSession(existingSessionId);
          
          if (isValid) {
            console.log(`Session ${existingSessionId} is valid, using it`);
            setSessionId(existingSessionId);
          } else {
            console.log(`Session ${existingSessionId} is invalid, creating new one`);
            // Create a new session via the init method
            const newSessionId = await SessionManager.init();
            if (newSessionId) {
              setSessionId(newSessionId);
            } else {
              console.error('Failed to create a new session');
            }
          }
        } else {
          console.log('No existing session found, creating a new one');
          // Create a new session
          const newSessionId = await SessionManager.init();
          if (newSessionId) {
            setSessionId(newSessionId);
          } else {
            console.error('Failed to create a new session');
          }
        }
        
        // Set initialization flag regardless of outcome to prevent retries
        setInitialized(true);
      } catch (error) {
        console.error('Error during session initialization:', error);
        setInitialized(true); // Still mark as initialized to prevent loops
      }
    };

    // Only run initialization once
    if (!initialized) {
      initSession();
    }
  }, [initialized]); // Only depend on initialized state

  // Fetch matched channels from backend
  const fetchMatchedChannels = async (sid) => {
    try {
      console.log(`[App] Fetching matched channels for session: ${sid}`);
      const response = await apiClient.get(`/epg/${sid}/matched-channels`);

      if (response.data && Array.isArray(response.data.channels)) {
        // Transform array of matched channels into a map for easy lookup
        const matchesMap = response.data.channels.reduce((acc, channel) => {
          // Use both the channel ID and tvgId as keys, storing the EPG channel ID as the value
          if (channel.id && channel.epgId) {
            acc[channel.id] = channel.epgId;
          }
          if (channel.tvgId && channel.tvgId !== channel.id && channel.epgId) {
            acc[channel.tvgId] = channel.epgId;
          }
          return acc;
        }, {});

        console.log(`[App] Loaded ${response.data.channels.length} matched channels`);
        setMatchedChannels(matchesMap);
        saveMatchedChannels(matchesMap);
        return matchesMap;
      }
    } catch (error) {
      console.error('[App] Error fetching matched channels:', error);
      // Fall back to localStorage on error
      const savedMatches = JSON.parse(localStorage.getItem('matchedChannels') || '{}');
      setMatchedChannels(savedMatches);
    }
  };

  // Load saved matched channels on mount
  useEffect(() => {
    // Load any previously matched channels from localStorage initially
    const savedMatches = JSON.parse(localStorage.getItem('matchedChannels') || '{}');
    setMatchedChannels(savedMatches);
  }, []);

  // Load user sources if authenticated (wait for auth to be ready)
  useEffect(() => {
    const loadUserSources = async () => {
      // Wait for auth to finish loading
      if (authLoading) {
        return;
      }

      // Only load if user is authenticated
      if (!authIsAuthenticated) {
        return;
      }

      setLoadingSources(true);

      try {
        const sources = await iptvSourcesService.getUserSources();
        setUserSources(sources);
        console.log('[App] Loaded user sources:', sources.length);
      } catch (err) {
        console.error('Error loading user sources:', err);
      } finally {
        setLoadingSources(false);
      }
    };

    loadUserSources();
  }, [authLoading, authIsAuthenticated]);

  // Load total matches count for IPTV Editor tab
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
  }, [authLoading, authIsAuthenticated]);

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
        console.log('[App] SSE update provided channel count:', channelCount);
        setTotalChannels(channelCount);
      }
    };

    window.addEventListener('sseMessage', handleSseMessage);
    return () => window.removeEventListener('sseMessage', handleSseMessage);
  }, []);

  const computeChannelCount = () => {
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
    console.log('[App] computeChannelCount', { fromTotal, fromChannels, fromCategories, result });
    return result;
  };

  // Keep status text aligned with loaded channel/EPG counts once loading completes
  useEffect(() => {
    console.log('[App] Status sync effect triggered', {
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
      console.log('[App] Updating status banner:', desiredStatus);
      setStatus(desiredStatus);
      setStatusType('success');
    }
  }, [isLoading, totalChannels, channels, categories, epgSources.length, status]);

  // Update active tab based on app state, but only in specific conditions
  useEffect(() => {
    // Only redirect to myiptvs if we have NO session and NO data at all
    // Don't redirect if we have categories (which means we have a valid session with data)
    // Don't redirect if we're on the publish or editor tab
    // Don't redirect if we're currently loading
    if (!sessionId && channels.length === 0 && categories.length === 0 && !isLoading && activeTab !== 'publish' && activeTab !== 'editor' && activeTab !== 'myiptvs') {
      setActiveTab('myiptvs');
    }
  }, [sessionId, channels.length, categories.length, isLoading, activeTab]);
  
  // Listen for new EPG sources and update status
  useEffect(() => {
    const updateEpgSourcesStatus = () => {
      if (sessionId) {
        // Ensure we're using the same session ID for both channels and EPG
        const effectiveSessionId = sessionId;
        console.log('[App] Updating EPG sources using session ID:', effectiveSessionId);
        
        // Use the correct API endpoint format with /api prefix
        const resolveApiBase = () => {
          if (API_BASE_URL) {
            return API_BASE_URL;
          }

          if (typeof window !== 'undefined') {
            return `${window.location.protocol}//${window.location.hostname}:5001`;
          }

          return 'http://localhost:5001';
        };

        const baseUrl = resolveApiBase();

        fetch(`${baseUrl}/api/epg/${effectiveSessionId}/sources?_t=${Date.now()}`)
          .then(response => {
            if (!response.ok) {
              console.error('Error fetching EPG sources:', response.status, response.statusText);
              return null;
            }
            return response.json();
          })
          .then(data => {
            if (data && data.sources) {
              console.log('[App] Updating EPG sources:', data.sources);
              setEpgSources(data.sources);
              
              // Update status with EPG source info
              if (data.sources.length > 0) {
                const reportedCount = Number(
                  data.totalChannels ??
                  data.channelCount ??
                  (Array.isArray(data.channels) ? data.channels.length : undefined)
                );

                if (Number.isFinite(reportedCount) && reportedCount > 0 && reportedCount !== totalChannels) {
                  setTotalChannels(reportedCount);
                }

                const channelCount = reportedCount > 0 ? reportedCount : computeChannelCount();
                const message = `${channelCount} channels loaded with ${data.sources.length} EPG ${data.sources.length === 1 ? 'source' : 'sources'} available`;
                setStatus(message);
                setStatusType('success');
              }
            }
          })
          .catch(error => console.error('Error updating EPG sources:', error));
      }
    };
    
    // Listen for EPG source updates
    const handleEpgSourcesUpdated = (event) => {
      console.log('[App] EPG sources updated event received:', event.detail);
      // Update the app's state with the new EPG sources
      if (event.detail) {
        setEpgSources(event.detail);
      } else {
        updateEpgSourcesStatus();
      }
    };
    
    window.addEventListener('epgSourcesUpdated', handleEpgSourcesUpdated);
    
    // Load sources once on component mount, but don't poll repeatedly
    updateEpgSourcesStatus();
    
    // No polling interval - removed to prevent excessive refreshes
    
    return () => {
      window.removeEventListener('epgSourcesUpdated', handleEpgSourcesUpdated);
    };
  }, [sessionId, totalChannels]);

  // Save matched channels to local storage
  const saveMatchedChannels = (matches) => {
    localStorage.setItem('matchedChannels', JSON.stringify(matches));
  };

  // Handle loading channels from server or file
  const handleLoad = async (data, force = false, sessionId = null, category = selectedCategory) => {
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

      // Initialize or get existing session
      let sid;
      if (sessionId) {
        sid = sessionId;
      } else {
        sid = await SessionManager.init();
        if (!sid) {
          throw new Error('Failed to initialize session. Please try again.');
        }
      }
      
      console.log(`[App] Set up session: ${sid}`);
      setSessionId(sid);

      const baseUrl = resolveApiBase();

      try {
        console.log('[App] Explicitly initializing EPG session');
        const epgInitResponse = await fetch(`${baseUrl}/api/epg/init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sessionId: sid })
        });
        
        if (epgInitResponse.ok) {
          console.log('[App] Successfully initialized EPG session');
        } else {
          console.warn('[App] Failed to initialize EPG session:', epgInitResponse.status);
        }
      } catch (epgInitError) {
        console.error('[App] Error initializing EPG session:', epgInitError);
      }

      // Get EPG sources
      let fetchedSources = [];

      try {
        console.log(`[App] Fetching EPG sources for session: ${sid}`);
        const epgResponse = await fetch(`${baseUrl}/api/epg/${sid}/sources`);
        
        if (!epgResponse.ok) {
          console.warn(`[App] EPG sources request failed: ${epgResponse.status} ${epgResponse.statusText}`);
          
          // Try to create a test source if we got a 404
          if (epgResponse.status === 404) {
            try {
              console.log('[App] Creating test EPG source after 404');
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
              console.error('[App] Error creating test source:', createError);
            }
          }
          
          return;
        }
        
        const epgData = await epgResponse.json();
        fetchedSources = Array.isArray(epgData.sources) ? epgData.sources : [];
        setEpgSources(fetchedSources);
        console.log(`[App] Successfully loaded ${fetchedSources.length} EPG sources`);
      } catch (e) {
        console.log('[App] Error loading EPG sources:', e);
      }

      // Fetch channels data if not provided
      let resolvedChannelCount = 0;

      if (!data || !data.channels) {
        console.log(`[App] Fetching channels for session: ${sid}`);
        const response = await apiClient.get(`/channels/${sid}`);
        console.log(`[App] Received ${response.data.channels?.length || 0} channels (total reported: ${response.data.totalChannels})`);
        const reportedTotal = Number(response.data.totalChannels ?? response.data.channelCount);
        resolvedChannelCount = Number.isFinite(reportedTotal) && reportedTotal > 0
          ? reportedTotal
          : response.data.channels?.length || 0;
        console.log('[App] Resolved channel count after fetch:', resolvedChannelCount);
        setChannels(response.data.channels || []);
        setTotalChannels(resolvedChannelCount);
      } else {
        // Use the provided data
        console.log(`[App] Using provided channel data: ${data.channels?.length || 0} channels`);
        const providedTotal = Number(data.totalChannels ?? data.channelCount);
        resolvedChannelCount = Number.isFinite(providedTotal) && providedTotal > 0
          ? providedTotal
          : data.channels?.length || 0;
        console.log('[App] Resolved channel count from provided data:', resolvedChannelCount);
        setChannels(data.channels || []);
        setTotalChannels(resolvedChannelCount);
      }

      // Fetch categories if not provided
      if (!data || !data.categories) {
        console.log(`[App] Fetching categories for session: ${sid}`);
        await fetchCategoriesFromApi(sid);
      } else {
        console.log(`[App] Using provided categories: ${data.categories?.length || 0} categories`);
        // If categories are already provided, process them through the same logic
        if (Array.isArray(data.categories)) {
          setCategories(data.categories);
        } else {
          console.warn(`[App] Provided categories in unexpected format:`, data.categories);
          setCategories([]);
        }
      }

      // Set status with EPG count info if available
      const finalChannelCount = resolvedChannelCount || computeChannelCount();

      if (fetchedSources.length > 0) {
        setStatus(`${finalChannelCount} channels loaded with ${fetchedSources.length} EPG ${fetchedSources.length === 1 ? 'source' : 'sources'} available`);
      } else {
        setStatus(`${finalChannelCount} channels loaded successfully`);
      }
      setStatusType('success');

      // Double-check that the session is saved
      console.log(`[App] Re-saving session ID for safety: ${sid}`);
      SessionManager.saveSessionId(sid);

      // Reload user sources if authenticated (to reflect newly loaded source)
      if (authIsAuthenticated) {
        try {
          const sources = await iptvSourcesService.getUserSources();
          setUserSources(sources);
          console.log('[App] Reloaded user sources after successful load:', sources.length);
        } catch (err) {
          console.error('[App] Error reloading sources after load:', err);
        }
      }

      // Switch to channels tab
      setActiveTab('channels');
    } catch (error) {
      console.error('[App] Error loading channels:', error);
      
      // Check if this is a 404 error (session not found)
      if (error.response && error.response.status === 404) {
        // Session not found, clear localStorage
        console.error('[App] Session not found (404), clearing session');
        SessionManager.clearSession();
        
        // Show appropriate error message
        setStatus('Your session has expired. Please reload your data.');
        setStatusType('error');
        
        // Reset to configuration tab
        setActiveTab('configure');
      } else {
        setStatus(`Error loading channels: ${error.message}`);
        setStatusType('error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Handle channel selection
  const handleChannelSelect = (channel) => {
    console.log('[App] handleChannelSelect called with:', channel);
    console.log('[App] Channel ID:', channel?.id);
    console.log('[App] Channel URL:', channel?.url);
    setSelectedChannel(channel);
    // Switch to player tab
    setActiveTab('player');
  };

  const loadMoreChannels = async (category = selectedCategory) => {
    if (isLoading) return;
    
    // Get the current session ID from SessionManager
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
      // Calculate the current page based on loaded channels and pageSize
      const pageSize = 1000;
      const currentPage = Math.floor(channels.length / pageSize) + 1;

      // Build URL with properly defined variables
      let url = `/channels/${currentSessionId}?page=${currentPage}&limit=${pageSize}`;
      if (category) {
        url += `&category=${encodeURIComponent(category)}`;
      }

      const response = await apiClient.get(url);
      setChannels(prev => [...prev, ...response.data.channels]);
      setStatus(`Loaded ${channels.length + response.data.channels.length} of ${response.data.totalChannels} channels`);
      setStatusType('success');
    } catch (error) {
      // The apiClient interceptor will handle session errors
      setStatus(`Error loading more channels: ${error.message}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle category visibility change
  const handleCategoryVisibilityChange = (updatedHiddenCategories) => {
    // Find any categories that were just made visible (were in hiddenCategories but not in updatedHiddenCategories)
    const newlyVisibleCategories = hiddenCategories.filter(category =>
      !updatedHiddenCategories.includes(category)
    );

    console.log('Category visibility update:', {
      hiddenBefore: hiddenCategories.length,
      hiddenAfter: updatedHiddenCategories.length,
      newlyVisibleCategories
    });

    // Update hidden categories
    setHiddenCategories(updatedHiddenCategories);

    // Special case: If ONE category was just made visible (after hiding all)
    // AND no category is currently selected, automatically select this newly visible category
    if (newlyVisibleCategories.length === 1 && !selectedCategory) {
      console.log('Auto-selecting newly visible category:', newlyVisibleCategories[0]);
      setSelectedCategory(newlyVisibleCategories[0]);

      // Force reload of channels for this category
      handleCategorySelect(newlyVisibleCategories[0]);
      return; // Skip the rest of this function
    }

    // If a specific category is currently selected and it's being hidden,
    // we need to reset the selection to show all channels
    if (selectedCategory && updatedHiddenCategories.includes(selectedCategory)) {
      setSelectedCategory(null);
      // Reload all channels
      handleCategorySelect(null);
    }

    // Debug info
    console.log('Category visibility changed:', {
      updatedHiddenCategories,
      selectedCategory,
      channelCount: channels.length
    });
  };

  // Select a specific category to view
  const handleCategorySelect = async (category) => {
    if (category === selectedCategory) {
      // If clicking the same category, unselect it
      setSelectedCategory(null);

      // Reload all channels
      setChannels([]);
      setIsLoading(true);

      try {
        // Get current session ID from the SessionManager
        const currentSessionId = SessionManager.getSessionId();
        
        if (!currentSessionId) {
          throw new Error('No active session. Please load channels first.');
        }
        
        // Load channels
        const response = await apiClient.get(`/channels/${currentSessionId}?page=1&limit=1000`);
        setChannels(response.data.channels);
        setTotalChannels(response.data.totalChannels);
        setStatus(`Loaded ${response.data.channels.length} of ${response.data.totalChannels} channels`);
        setStatusType('success');
        
        // Refresh categories too
        await fetchCategoriesFromApi(currentSessionId);
      } catch (error) {
        // The apiClient interceptor will handle session errors
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
      // Get current session ID from the SessionManager
      const currentSessionId = SessionManager.getSessionId();
      
      if (!currentSessionId) {
        throw new Error('No active session. Please load channels first.');
      }
      
      // Load channels for the selected category
      const response = await apiClient.get(`/channels/${currentSessionId}?page=1&limit=1000&category=${encodeURIComponent(category)}`);
      setChannels(response.data.channels);
      setTotalChannels(response.data.totalChannels);
      setStatus(`Loaded ${response.data.channels.length} of ${response.data.totalChannels} channels in ${category}`);
      setStatusType('success');
      
      // Refresh categories too
      await fetchCategoriesFromApi(currentSessionId);
    } catch (error) {
      // The apiClient interceptor will handle session errors
      setStatus(`Error loading channels for ${category}: ${error.message}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle EPG matching
  const handleEpgMatch = (channelId, epgId) => {
    if (!epgId || !channelId) {
      console.warn('Missing required parameters for matching:', { channelId, epgId });
      return;
    }

    console.log('App.js: handleEpgMatch called with:', { channelId, epgId });

    // Create a more readable message for the user
    let displayName = '';
    if (typeof epgId === 'object') {
      displayName = epgId.epgName || epgId.name || epgId.epgId || epgId.id || '';
      // Include source name if available
      if (epgId.sourceName) {
        displayName += ` (${epgId.sourceName})`;
      }
    } else {
      displayName = String(epgId);
    }

    // Update local matched channels state
    const updatedMatches = {
      ...matchedChannels,
      [channelId]: epgId
    };
    setMatchedChannels(updatedMatches);
    saveMatchedChannels(updatedMatches);

    // Show success status
    setStatus(`Matched channel to ${displayName}`);
    setStatusType('success');

    // Update the matched channels in the session
    if (sessionId) {
      try {
        // Format the EPG channel data correctly for the API
        let epgChannel = {};
        
        if (typeof epgId === 'object') {
          epgChannel = {
            id: epgId.epgId || epgId.id || '',
            name: epgId.epgName || epgId.name || '',
            icon: epgId.epgIcon || epgId.icon || null,
            source_name: epgId.sourceName || epgId.source_name || 'Unknown',
            source_id: epgId.sourceId || epgId.source_id || ''
          };
        } else {
          // If it's just a string (epgId), set that as the id and name
          epgChannel = {
            id: String(epgId),
            name: String(epgId),
            icon: null,
            source_name: 'Unknown',
            source_id: ''
          };
        }
        
        // Find the M3U channel in the loaded channels
        const matchedChannel = channels.find(c => c.tvgId === channelId || c.id === channelId);
        
        if (!matchedChannel) {
          console.warn('Could not find matched channel in loaded channels:', channelId);
        }
        
        // Format the M3U channel data with all required properties
        const m3uChannel = {
          id: channelId,
          name: matchedChannel ? matchedChannel.name : channelId,
          logo: matchedChannel ? (matchedChannel.logo || matchedChannel.tvgLogo) : null,
          url: matchedChannel ? matchedChannel.url : null,
          group: matchedChannel ? matchedChannel.groupTitle : ''
        };
        
        console.log('Matching in App.js:', { 
          epgChannel, 
          m3uChannel,
          originalEpgId: epgId,
          channelId
        });
        
        // Send the match to the server to update the session
        apiClient.post(`/epg/${sessionId}/match`, {
          epgChannel,
          m3uChannel
        }).then(response => {
          console.log('Match saved to session:', response.data);
        }).catch(error => {
          console.error('Failed to update matched channels in session', error.response || error);
          const errorDetails = error.response?.data?.error || error.message;
          console.error('Match error details:', {
            error: errorDetails,
            requestData: { epgChannel, m3uChannel },
            responseData: error.response?.data
          });
          setStatus(`Warning: Match saved locally but not on server: ${errorDetails}`);
          setStatusType('warning');
        });
      } catch (error) {
        console.error('Error updating matched channels in session', error);
        setStatus(`Error: ${error.message}`);
        setStatusType('error');
      }
    }
  };

  // Generate new XTREAM credentials
  const handleGenerate = async () => {
    setIsLoading(true);
    setIsGenerating(true);
    setStatus('Generating new XTREAM credentials...');
    setStatusType('info');

    try {
      await apiClient.post('/generate', {
        sessionId,
        matchedChannels
      });
      setStatus('Generated new XTREAM credentials!');
      setStatusType('success');

      // Switch to publish tab (PublishView will load credentials from DB)
      setActiveTab('publish');
    } catch (error) {
      // The apiClient interceptor will handle session errors
      setStatus(`Error: ${error.response?.data?.error || error.message}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
      setIsGenerating(false);
    }
  };

  // Copy text to clipboard
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        setStatus('Copied to clipboard');
        setStatusType('success');

        // Reset status after 3 seconds
        setTimeout(() => {
          setStatus('');
        }, 3000);
      })
      .catch(err => {
        setStatus(`Failed to copy: ${err.message}`);
        setStatusType('error');
      });
  };

  // Reset the application state
  const handleReset = () => {
    // Clear session data
    SessionManager.clearSession();

    // Keep credentials but reset everything else
    setChannels([]);
    setTotalChannels(0);
    setCategories([]);
    setHiddenCategories([]);
    setSelectedCategory(null);
    setEpgSources([]);
    setSessionId(null);
    setSelectedChannel(null);
    setResult(null);
    setLoadingError(null);
    setActiveTab('configure');
    setStatus('Application reset. Ready to load new channels.');
    setStatusType('info');
  };

  // Handle EPG sources update after refresh
  const handleEpgSourcesUpdated = (updatedSources) => {
    console.log('[App] EPG sources updated:', updatedSources);
    setEpgSources(updatedSources);
    setStatus(`${updatedSources.length} EPG sources refreshed successfully`);
    setStatusType('success');
  };

  // Toggle sidebar visibility
  const toggleSidebar = () => {
    setShowSidebar(prev => !prev);
  };

  // Render the active tab content
  const renderActiveTabContent = () => {
    switch (activeTab) {
      case 'channels':
        return (
          <ChannelsView
            sessionId={sessionId}
            onChannelSelect={handleChannelSelect}
            selectedChannel={selectedChannel}
            matchedChannels={matchedChannels}
            sourceFilter={selectedSourceFilter}
            availableSources={userSources}
            onSourceChange={(source) => setSelectedSourceFilter(source)}
          />
        );
      case 'guide':
        return (
          <GuideView
            sessionId={sessionId}
            onChannelSelect={handleChannelSelect}
          />
        );
      case 'epg':
        return (
          <div className="space-y-6 px-6 py-8">
            <header className="space-y-2">
              <h2 className="text-3xl font-semibold text-slate-100">EPG Sources</h2>
              <p className="max-w-3xl text-sm text-slate-400">
                Review default sources from the backend and add provider-specific feeds without leaving this view.
                These sources populate guide data across the rest of the app.
              </p>
            </header>

            <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/40">
              <EpgSourcesSummary sources={epgSources} onSourcesUpdated={handleEpgSourcesUpdated} />
            </div>

            <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/40">
              <Configuration
                onLoad={handleLoad}
                error={loadingError}
                allowedTabs={['epg']}
                showFooter={false}
                showSummaryButton={false}
                heading="Add Or Refresh EPG Sources"
                description="Submit XMLTV or gzipped URLs to import or refresh guide data for this session."
              />
            </div>
          </div>
        );
      case 'player':
        // Don't render PlayerView when in theatre mode to avoid duplicate IPTVPlayer instances
        if (isTheatreMode) {
          return null;
        }
        return (
          <PlayerView
            sessionId={sessionId}
            selectedChannel={selectedChannel}
            onEpgMatch={handleEpgMatch}
            matchedChannels={matchedChannels}
            availableSources={userSources}
            onBackToChannels={() => setActiveTab('channels')}
            onToggleTheatre={() => setIsTheatreMode(!isTheatreMode)}
            isTheatreMode={isTheatreMode}
          />
        );
      case 'editor':
        return (
          <IPTVEditor
            sessionId={sessionId}
            matchedChannels={matchedChannels}
            onUpdateMatches={setMatchedChannels}
            onNavigateToPlayer={(channel) => {
              // Navigate to Player tab with the channel loaded for editing EPG match
              setSelectedChannel({
                id: channel.iptv_channel_id,
                name: channel.name || channel.iptv_channel_name,
                logo: channel.logo,
                url: channel.url
              });
              setActiveTab('player');
            }}
          />
        );
      case 'publish':
        return (
          <ResultView
            onCopyToClipboard={copyToClipboard}
            onBackToPlayer={() => setActiveTab('player')}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            matchedChannelsCount={Object.keys(matchedChannels).length}
          />
        );
      case 'myiptvs':
        return (
          <div className="px-6 py-8">
            <MyIPTVs
              onLoad={async (data) => {
                await handleLoad(data);
                // Stay on My IPTVs page after loading (handleLoad switches to 'channels')
                setActiveTab('myiptvs');
              }}
              loadingError={loadingError}
              onSourcesUpdated={async () => {
                // Reload sources after any changes
                try {
                  const sources = await iptvSourcesService.getUserSources();
                  setUserSources(sources);
                } catch (err) {
                  console.error('Error reloading sources:', err);
                }
              }}
              onViewChannels={(source) => {
                // Set the source filter and navigate to channels view
                setSelectedSourceFilter(source);
                setActiveTab('channels');
              }}
              backgroundLoadings={backgroundLoadings}
              setBackgroundLoadings={setBackgroundLoadings}
              showLoadingPicker={showLoadingPicker}
              setShowLoadingPicker={setShowLoadingPicker}
              showAddModal={showAddModal}
              setShowAddModal={setShowAddModal}
            />
          </div>
        );
      default:
        // Redirect to myiptvs as the default page
        setActiveTab('myiptvs');
        return null;
    }
  };

  // Ensure apiClient utility handles categories response correctly
  const fetchCategoriesFromApi = async (sid) => {
    try {
      console.log(`[App.fetchCategories] Fetching categories for session: ${sid}`);
      const response = await apiClient.get(`/channels/${sid}/categories`);
      
      // Detailed examination of the response
      const responseType = typeof response.data;
      const isArray = Array.isArray(response.data);
      const objectKeys = !isArray && responseType === 'object' ? Object.keys(response.data) : [];
      const sampleData = isArray ? response.data.slice(0, 3) : 
                        (responseType === 'object' ? JSON.stringify(response.data).substring(0, 100) : response.data);
      
      console.log(`[App.fetchCategories] Categories response details:`, {
        type: responseType,
        isArray,
        length: isArray ? response.data.length : 'not an array',
        keys: objectKeys,
        sample: sampleData
      });
      
      // Handle different response formats
      if (Array.isArray(response.data)) {
        // Additional validation - check first item to see structure
        if (response.data.length > 0) {
          const firstItem = response.data[0];
          console.log(`[App.fetchCategories] First category item structure:`, {
            type: typeof firstItem,
            keys: typeof firstItem === 'object' ? Object.keys(firstItem) : 'not an object',
            value: firstItem
          });
        }
        
        console.log(`[App.fetchCategories] Setting ${response.data.length} categories from array`);
        setCategories(response.data);
        const derivedTotal = response.data.reduce(
          (sum, cat) => sum + Number(cat?.count ?? cat?.channelCount ?? 0),
          0
        );
        if (derivedTotal > 0 && derivedTotal !== totalChannels) {
          console.log('[App.fetchCategories] Derived total channel count from categories:', derivedTotal);
          setTotalChannels(derivedTotal);
        }
        return response.data;
      } else if (response.data && typeof response.data === 'object') {
        if (Array.isArray(response.data.categories)) {
          console.log(`[App.fetchCategories] Setting ${response.data.categories.length} categories from object property`);
          setCategories(response.data.categories);
          const derivedTotal = response.data.categories.reduce(
            (sum, cat) => sum + Number(cat?.count ?? cat?.channelCount ?? 0),
            0
          );
          if (derivedTotal > 0 && derivedTotal !== totalChannels) {
            console.log('[App.fetchCategories] Derived total channel count from categories object:', derivedTotal);
            setTotalChannels(derivedTotal);
          }
          return response.data.categories;
        } else {
          console.warn(`[App.fetchCategories] Response object doesn't contain categories array:`, response.data);
          setCategories([]);
          return [];
        }
      } else {
        console.warn(`[App.fetchCategories] Invalid categories response format:`, response.data);
        setCategories([]);
        return [];
      }
    } catch (error) {
      console.error(`[App.fetchCategories] Error fetching categories:`, error);
      setCategories([]);
      return [];
    }
  };

  // Component for directly retrieving categories when they're not getting passed properly
  const CategoryManagerWithFallback = (props) => {
    const [directCategories, setDirectCategories] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [fetchAttempted, setFetchAttempted] = useState(false);
    
    // Use a side effect to load categories directly from the API if needed
    useEffect(() => {
      const loadDirectCategories = async () => {
        if (props.sessionId) {
          // Always attempt to fetch categories directly
          console.log(`[FALLBACK] Fetching categories directly with session: ${props.sessionId}`);
          setIsLoading(true);
          try {
            // Use the same URL format as the SessionDebugger that's working
            const response = await fetch(`/api/channels/${props.sessionId}/categories`);
            if (response.ok) {
              const text = await response.text();
              console.log(`[FALLBACK] Raw response: ${text.substring(0, 100)}...`);
              
              try {
                const data = JSON.parse(text);
                console.log(`[FALLBACK] Successfully parsed ${Array.isArray(data) ? data.length : 0} categories`);
                if (Array.isArray(data) && data.length > 0) {
                  setDirectCategories(data);
                  console.log(`[FALLBACK] ✅ Set ${data.length} categories directly from API`);
                } else {
                  console.warn(`[FALLBACK] API returned ${Array.isArray(data) ? 'empty array' : 'non-array'}:`, data);
                }
              } catch (parseError) {
                console.error(`[FALLBACK] Failed to parse categories JSON:`, parseError);
              }
            } else {
              console.warn(`[FALLBACK] API response not OK: ${response.status} ${response.statusText}`);
            }
          } catch (error) {
            console.error('[FALLBACK] Error fetching categories directly:', error);
          } finally {
            setIsLoading(false);
            setFetchAttempted(true);
          }
        }
      };
      
      loadDirectCategories();
    }, [props.sessionId]);
    
    // Check if we should use the fallback
    const effectiveCategories = props.categories?.length > 0 
      ? props.categories 
      : directCategories;
      
    console.log(`[FALLBACK] Using ${effectiveCategories.length} categories (${props.categories?.length || 0} from props, ${directCategories.length} direct)`);
    
    // Show a loading state while we're fetching categories
    if (isLoading && !fetchAttempted && !effectiveCategories.length) {
      return (
        <div className="px-6 py-8 text-center text-slate-300">
          <div className="inline-flex items-center gap-3 rounded-full border border-slate-800/80 bg-slate-900/70 px-5 py-2 text-sm">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-blue-400"></span>
            Loading categories directly...
          </div>
        </div>
      );
    }
    
    return (
      <CategoryManager
        {...props}
        categories={effectiveCategories}
      />
    );
  };

  // Ensure categories and matched channels are loaded when switching tabs
  useEffect(() => {
    // Use a timestamp cache to prevent repeated fetches
    const now = Date.now();
    const lastCategoryFetch = window.lastCategoryFetchTime || 0;
    const lastMatchesFetch = window.lastMatchesFetchTime || 0;
    const CACHE_LIFETIME = 60000; // 1 minute

    const loadDataIfNeeded = async () => {
      if (activeTab === 'channels' && sessionId) {
        // Load categories if needed
        if (categories.length === 0) {
          if (now - lastCategoryFetch > CACHE_LIFETIME) {
            console.log(`[App] Loading categories for session: ${sessionId} (cache expired)`);
            window.lastCategoryFetchTime = now;
            await fetchCategoriesFromApi(sessionId);
          } else {
            console.log(`[App] Using cached categories (fetched ${(now - lastCategoryFetch)/1000}s ago)`);
          }
        }

        // Always refresh matched channels when switching to channels view
        // This ensures we have the latest match status
        if (now - lastMatchesFetch > 5000) { // Refresh if more than 5 seconds since last fetch
          console.log(`[App] Refreshing matched channels for session: ${sessionId}`);
          window.lastMatchesFetchTime = now;
          await fetchMatchedChannels(sessionId);
        }
      }

      // Also refresh matched channels when switching to guide view
      if (activeTab === 'guide' && sessionId) {
        if (now - lastMatchesFetch > 5000) { // Refresh if more than 5 seconds since last fetch
          console.log(`[App] Refreshing matched channels for Guide view`);
          window.lastMatchesFetchTime = now;
          await fetchMatchedChannels(sessionId);
        }
      }
    };

    loadDataIfNeeded();
  }, [activeTab, categories.length, sessionId]);

  // Server Status Modal component
  const ServerStatusModal = ({ isOpen, onClose }) => {
    const [isChecking, setIsChecking] = useState(false);
    const [statusData, setStatusData] = useState(null);
    const [isReloadingEpg, setIsReloadingEpg] = useState(false);

    // Load status when modal opens
    React.useEffect(() => {
      if (isOpen && !statusData) {
        checkServerStatus();
      }
    }, [isOpen]);

    const forceReloadEpg = async () => {
      if (window.confirm('Force reload EPG sources from the server configuration? This will add all configured EPG sources to your session.')) {
        setIsReloadingEpg(true);
        try {
          const sessionId = SessionManager.getSessionId();
          if (!sessionId) {
            alert('Error: No session ID available');
            return;
          }

          const baseUrl = resolveApiBase();
          const initResponse = await fetch(`${baseUrl}/api/epg/init`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sessionId })
          });

          if (!initResponse.ok) {
            throw new Error(`Failed to initialize EPG: ${initResponse.status}`);
          }

          await fetch(`${baseUrl}/api/epg/${sessionId}/sources?_t=${Date.now()}`);
          alert('Successfully triggered EPG source reload.');
          const event = new CustomEvent('epgSourcesUpdated', { detail: null });
          window.dispatchEvent(event);
        } catch (error) {
          console.error('[EPG Reload] Error:', error);
          alert(`Error reloading EPG sources: ${error.message}`);
        } finally {
          setIsReloadingEpg(false);
        }
      }
    };

    const checkServerStatus = async () => {
      setIsChecking(true);
      try {
        const baseUrl = resolveApiBase();
        const response = await fetch(`${baseUrl}/api/status`);
        if (response.ok) {
          const data = await response.json();
          setStatusData(data);
        } else {
          console.error('Failed to fetch server status:', response.status);
        }
      } catch (error) {
        console.error('Error checking server status:', error);
      } finally {
        setIsChecking(false);
      }
    };

    const triggerCleanup = async () => {
      if (window.confirm('Are you sure you want to trigger server cleanup?')) {
        setIsChecking(true);
        try {
          const baseUrl = resolveApiBase();
          const response = await fetch(`${baseUrl}/api/status/cleanup`, { method: 'POST' });
          if (response.ok) {
            const result = await response.json();
            alert(`Cleanup complete. Removed ${result.sessionsDiff} sessions.`);
            checkServerStatus();
          }
        } catch (error) {
          console.error('Error triggering cleanup:', error);
        } finally {
          setIsChecking(false);
        }
      }
    };

    const formatMemory = (memoryObj) => {
      if (!memoryObj) return 'N/A';
      return Object.entries(memoryObj)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
    };

    if (!isOpen) return null;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full">
          {/* Modal Header */}
          <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-xl font-semibold text-slate-100">Server Status</h3>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Modal Content */}
          <div className="p-6">
            {isChecking && !statusData ? (
              <div className="flex items-center justify-center py-12">
                <div className="text-center">
                  <div className="inline-block w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-3"></div>
                  <p className="text-sm text-slate-400">Checking server status...</p>
                </div>
              </div>
            ) : statusData ? (
              <div className="space-y-4">
                <dl className="space-y-3 text-slate-300">
                  <div className="flex justify-between border-b border-slate-800 pb-2">
                    <dt className="font-medium text-slate-400">Uptime</dt>
                    <dd className="text-slate-100">{Math.floor(statusData.uptime / 60)} minutes</dd>
                  </div>
                  <div className="flex justify-between border-b border-slate-800 pb-2">
                    <dt className="font-medium text-slate-400">Memory</dt>
                    <dd className="text-right text-slate-100 text-sm">{formatMemory(statusData.memory)}</dd>
                  </div>
                  <div className="flex justify-between border-b border-slate-800 pb-2">
                    <dt className="font-medium text-slate-400">Sessions</dt>
                    <dd className="text-slate-100">{statusData.sessions.count}</dd>
                  </div>
                  {statusData.sessions.oldest && (
                    <div className="flex justify-between border-b border-slate-800 pb-2">
                      <dt className="font-medium text-slate-400">Oldest Session</dt>
                      <dd className="text-slate-100">{new Date(statusData.sessions.oldest.lastAccessed).toLocaleTimeString()}</dd>
                    </div>
                  )}
                </dl>

                <div className="flex gap-2 pt-4">
                  <button
                    type="button"
                    onClick={triggerCleanup}
                    disabled={isChecking}
                    className="flex-1 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isChecking ? 'Working…' : 'Cleanup Sessions'}
                  </button>
                  <button
                    type="button"
                    onClick={forceReloadEpg}
                    disabled={isReloadingEpg}
                    className="flex-1 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isReloadingEpg ? 'Loading…' : 'Force Reload EPG'}
                  </button>
                </div>

                <div className="text-xs text-slate-500 text-center pt-2">
                  Last checked: {new Date(statusData.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">
                Failed to load server status
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="bg-slate-800 px-6 py-4 border-t border-slate-700 flex gap-3 justify-end">
            <button
              onClick={checkServerStatus}
              disabled={isChecking}
              className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-60"
            >
              {isChecking ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 font-sans text-slate-100">
      {/* Theatre Mode Overlay */}
      {isTheatreMode && (
        <TheatreView
          sessionId={sessionId}
          selectedChannel={selectedChannel}
          matchedChannels={matchedChannels}
          onEpgMatch={handleEpgMatch}
          onExitTheatre={() => setIsTheatreMode(false)}
        />
      )}

      <header className="flex items-center justify-between gap-4 border-b border-slate-800 bg-slate-900/80 px-6 py-4 shadow-lg shadow-slate-950/20">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSidebar}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950"
            aria-label="Toggle sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          {sessionId && (
            <div className="hidden items-center rounded-full border border-blue-400/40 bg-blue-500/15 px-3 py-1 text-[11px] font-semibold text-blue-200 sm:inline-flex">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mr-2 h-3.5 w-3.5"
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
{typeof sessionId === 'string' ? sessionId : 'Loading...'}
            </div>
          )}
        </div>

        <div className="flex flex-1 items-center justify-center px-4">
          <h1 className="text-lg font-semibold text-blue-300 sm:text-xl">IPTV EPG Matcher</h1>
        </div>

        <div className="flex items-center gap-3">
          {sessionId && activeTab === 'channels' && (
            <button
              type="button"
              onClick={async () => {
                console.log('[App] Manually reloading categories');
                await fetchCategoriesFromApi(sessionId);
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6"></path>
                <path d="M1 20v-6h6"></path>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
                <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
              Reload Categories ({categories.length})
            </button>
          )}

          {authIsAuthenticated && user && (
            <UserBadge
              user={user}
              onOpenSessionDebugger={() => setSessionDebuggerOpen(true)}
              onOpenServerStatus={() => setShowServerStatus(true)}
            />
          )}
        </div>
      </header>

      <div className="flex flex-1">
        <Sidebar
          showSidebar={showSidebar}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          handleReset={handleReset}
          totalChannels={totalChannels}
          categoryCount={categories.length}
          matchedChannelCount={Object.keys(matchedChannels).length}
          totalMatchesCount={totalMatches}
          epgSourceCount={epgSources.length}
          userSourcesCount={userSources.length}
        />

        <main className="flex-1 overflow-y-auto bg-slate-950">
          {renderActiveTabContent()}
        </main>
      </div>

      {/* Global Background Loading Badge - visible across all pages */}
      {backgroundLoadings.size > 0 && (
        <div
          className="fixed bottom-6 right-6 z-50 cursor-pointer group"
          onClick={() => {
            if (backgroundLoadings.size === 1) {
              // Only one load - navigate to MyIPTVs and open modal
              setActiveTab('myiptvs');
              setShowAddModal(true);
            } else {
              // Multiple loads - show picker
              setShowLoadingPicker(true);
            }
          }}
          title={`${backgroundLoadings.size} source${backgroundLoadings.size > 1 ? 's' : ''} loading - click to view`}
        >
          {/* Badge with pulsing animation */}
          <div className="relative">
            {/* Pulsing background */}
            <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-75"></div>

            {/* Main badge - icon with optional count */}
            <div className="relative bg-gradient-to-br from-blue-500 to-blue-600 rounded-full p-3 shadow-lg border border-blue-400/30 transition-all duration-200 group-hover:scale-110 group-hover:shadow-xl">
              {/* Spinning loader icon */}
              <svg className="w-6 h-6 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>

              {/* Count badge for multiple loads */}
              {backgroundLoadings.size > 1 && (
                <div className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center border-2 border-slate-900">
                  {backgroundLoadings.size}
                </div>
              )}

              {/* Tooltip on hover */}
              <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-72">
                <div className="bg-slate-800 text-white text-xs rounded-lg shadow-xl p-3 border border-slate-600 max-h-64 overflow-y-auto">
                  <div className="font-semibold mb-2">
                    {backgroundLoadings.size === 1 ? 'Background Loading' : `${backgroundLoadings.size} Sources Loading`}
                  </div>

                  {/* List all loading sources */}
                  <div className="space-y-2">
                    {Array.from(backgroundLoadings.values()).map((loading) => (
                      <div key={loading.sessionId} className="border-t border-slate-700 pt-2 first:border-t-0 first:pt-0">
                        <div className="font-medium text-blue-300 mb-0.5">{loading.sourceName}</div>
                        <div className="text-slate-300 text-[11px]">{loading.status || 'Processing...'}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-2 text-slate-400 text-[10px] border-t border-slate-700 pt-2">
                    {backgroundLoadings.size === 1 ? 'Click to view details' : 'Click to select which source to view'}
                  </div>
                  {/* Arrow */}
                  <div className="absolute top-full right-6 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-slate-800"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading Picker Modal - shows when multiple loads and badge clicked */}
      {showLoadingPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full">
            {/* Header */}
            <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-100">Background Loads ({backgroundLoadings.size})</h3>
              <button
                onClick={() => setShowLoadingPicker(false)}
                className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* List of loading sources */}
            <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
              {Array.from(backgroundLoadings.values()).map((loading) => (
                <div
                  key={loading.sessionId}
                  className="bg-slate-800 rounded-lg p-4 border border-slate-700 hover:border-slate-600 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {/* Spinning icon */}
                    <svg className="w-5 h-5 text-blue-400 animate-spin flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>

                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-100 mb-1">{loading.sourceName}</div>
                      <div className="text-sm text-slate-400 break-words">{loading.status || 'Processing...'}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="bg-slate-800 px-6 py-3 border-t border-slate-700 text-xs text-slate-400">
              These sources are loading in the background. Close this modal to continue working.
            </div>
          </div>
        </div>
      )}

      <SessionDebugger
        isOpen={sessionDebuggerOpen}
        onClose={() => setSessionDebuggerOpen(false)}
      />

      {/* Server Status Modal */}
      {showServerStatus && (
        <ServerStatusModal
          isOpen={showServerStatus}
          onClose={() => setShowServerStatus(false)}
        />
      )}
    </div>
  );
}

export default App;
