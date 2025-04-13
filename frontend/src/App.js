// App.js - Enhanced version with modern UI, modular components, and improved session management
import React, { useState, useEffect } from 'react';
// Import our custom apiClient instead of axios directly
import apiClient from './utils/apiClient';
import SessionManager from './utils/sessionManager';

// Import modular components
import Sidebar from './Sidebar';
import StatusDisplay from './StatusDisplay';
import Configuration from './Configuration';
import CategoryManager from './CategoryManager';
import ChannelList from './ChannelList';
import PlayerView from './PlayerView';
import ResultView from './ResultView';
import SessionDebugger from './components/SessionDebugger';
import DirectEpgSourcesLoader from './DirectEpgSourcesLoader';

/**
 * Main application component with modernized UI and modular architecture
 * Enhanced with robust session management
 * 
 * @returns {JSX.Element} App component
 */
function App() {
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
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState(null);
  const [activeTab, setActiveTab] = useState('configure'); // 'configure', 'channels', 'player', or 'result'
  const [showSidebar, setShowSidebar] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusType, setStatusType] = useState('info'); // 'info', 'success', 'error', 'warning'
  const [showEmergencyCategories, setShowEmergencyCategories] = useState(true);
  const [initialized, setInitialized] = useState(false);

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

  // Load saved matched channels on mount
  useEffect(() => {
    // Load any previously matched channels
    const savedMatches = JSON.parse(localStorage.getItem('matchedChannels') || '{}');
    setMatchedChannels(savedMatches);
  }, []);

  // Update active tab based on app state, but only in specific conditions
  useEffect(() => {
    // Only change to configure tab if we're loading for the first time
    if (channels.length === 0 && categories.length === 0 && !isLoading) {
      setActiveTab('configure');
    } else if (result) {
      setActiveTab('result');
    }
  }, [channels.length, categories.length, result, isLoading]);
  
  // Listen for new EPG sources and update status
  useEffect(() => {
    const updateEpgSourcesStatus = () => {
      if (sessionId) {
        // Ensure we're using the same session ID for both channels and EPG
        const effectiveSessionId = sessionId;
        console.log('[App] Updating EPG sources using session ID:', effectiveSessionId);
        
        // Use the correct API endpoint format with /api prefix
        fetch(`/api/epg/${effectiveSessionId}/sources?_t=${Date.now()}`)
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
                const message = `${totalChannels} channels loaded with ${data.sources.length} EPG ${data.sources.length === 1 ? 'source' : 'sources'} available`;
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

      // Ensure we always create an EPG session with the same session ID
      try {
        console.log('[App] Explicitly initializing EPG session');
        const epgInitResponse = await fetch('/api/epg/init', {
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
      try {
        console.log(`[App] Fetching EPG sources for session: ${sid}`);
        // Use the correct API endpoint format
        const epgResponse = await fetch(`/api/epg/${sid}/sources`);
        
        if (!epgResponse.ok) {
          console.warn(`[App] EPG sources request failed: ${epgResponse.status} ${epgResponse.statusText}`);
          
          // Try to create a test source if we got a 404
          if (epgResponse.status === 404) {
            try {
              console.log('[App] Creating test EPG source after 404');
              await fetch(`/api/epg/${sid}/sources`, {
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
        setEpgSources(epgData.sources || []);
        console.log(`[App] Successfully loaded ${epgData.sources?.length || 0} EPG sources`);
      } catch (e) {
        console.log('[App] Error loading EPG sources:', e);
      }

      // Fetch channels data if not provided
      if (!data || !data.channels) {
        console.log(`[App] Fetching channels for session: ${sid}`);
        const response = await apiClient.get(`/channels/${sid}`);
        console.log(`[App] Received ${response.data.channels?.length || 0} channels`);
        setChannels(response.data.channels || []);
        setTotalChannels(response.data.totalChannels || 0);
      } else {
        // Use the provided data
        console.log(`[App] Using provided channel data: ${data.channels?.length || 0} channels`);
        setChannels(data.channels || []);
        setTotalChannels(data.totalChannels || data.channels?.length || 0);
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
      if (epgSources.length > 0) {
        setStatus(`${totalChannels} channels loaded with ${epgSources.length} EPG ${epgSources.length === 1 ? 'source' : 'sources'} available`);
      } else {
        setStatus(`${totalChannels} channels loaded successfully`);
      }
      setStatusType('success');

      // Double-check that the session is saved
      console.log(`[App] Re-saving session ID for safety: ${sid}`);
      SessionManager.saveSessionId(sid);

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
      const response = await apiClient.post('/generate', {
        sessionId,
        matchedChannels
      });
      setResult(response.data);
      setStatus('Generated new XTREAM credentials!');
      setStatusType('success');

      // Switch to result tab
      setActiveTab('result');
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

  // Toggle sidebar visibility
  const toggleSidebar = () => {
    setShowSidebar(prev => !prev);
  };

  // Render the active tab content
  const renderActiveTabContent = () => {
    switch (activeTab) {
      case 'configure':
        return (
          <div style={{ padding: '20px' }}>
            <SessionDebugger />
            <Configuration 
              onLoad={handleLoad} 
              isLoading={isLoading} 
              error={loadingError}
              sessionId={sessionId}
            />
          </div>
        );
      case 'channels':
        return (
          <div style={{ padding: '20px' }}>
            <SessionDebugger />
            
            {/* Add emergency category display for debugging */}
            <button
              onClick={() => {
                console.log('[DEBUG] Session information:', {
                  appSessionId: sessionId,
                  sessionManagerId: SessionManager.getSessionId(),
                  categoriesLength: categories?.length || 0,
                  categoriesType: typeof categories
                });
                setShowEmergencyCategories(!showEmergencyCategories);
              }}
              style={{
                backgroundColor: '#ff9800',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 12px',
                margin: '10px 0',
                cursor: 'pointer'
              }}
            >
              {showEmergencyCategories ? 'Hide' : 'Show'} Emergency Category Display
            </button>
            
            {showEmergencyCategories && <EmergencyCategoryDisplay />}

            {/* Direct EPG Sources Loader */}
            <DirectEpgSourcesLoader />
            
            {/* Debug log for categories */}
            {console.log('[App.renderActiveTabContent] Categories being passed to CategoryManager:', {
              count: categories?.length || 0, 
              isEmpty: categories?.length === 0,
              isArray: Array.isArray(categories),
              sample: categories?.slice(0, 3),
              type: typeof categories
            })}
            <h2 style={{
              marginTop: 0,
              color: '#333',
              fontWeight: '500',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <span>Channels</span>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <div style={{
                  fontSize: '14px',
                  color: '#666',
                  backgroundColor: '#f5f5f5',
                  padding: '5px 10px',
                  borderRadius: '30px'
                }}>
                  {channels.filter(ch => !hiddenCategories.includes(ch.groupTitle)).length} of {totalChannels} channels
                </div>

                {selectedCategory && (
                  <button
                    onClick={() => { setSelectedCategory(null); handleCategorySelect(null); }}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#f5f5f5',
                      color: '#333',
                      border: '1px solid #ddd',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '14px'
                    }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                      <polyline points="9 22 9 12 15 12 15 22"></polyline>
                    </svg>
                    Show All
                  </button>
                )}
              </div>
            </h2>

            <div style={{ display: 'flex', gap: '20px' }}>
              {/* Categories */}
              <div style={{ width: '250px' }}>
                {showEmergencyCategories ? (
                  <DirectCategoryManager
                    onCategorySelect={handleCategorySelect}
                    onVisibilityChange={handleCategoryVisibilityChange}
                    hiddenCategories={hiddenCategories}
                    selectedCategory={selectedCategory}
                    sessionId={sessionId || SessionManager.getSessionId()}
                  />
                ) : (
                  <CategoryManagerWithFallback
                    categories={categories || []}
                    onCategorySelect={handleCategorySelect}
                    onVisibilityChange={handleCategoryVisibilityChange}
                    hiddenCategories={hiddenCategories}
                    selectedCategory={selectedCategory}
                    sessionId={sessionId || SessionManager.getSessionId()}
                  />
                )}
              </div>
              
              {/* Channel list */}
              <ChannelList 
                channels={channels} 
                totalChannels={totalChannels}
                onChannelSelect={handleChannelSelect}
                selectedChannel={selectedChannel}
                matchedChannels={matchedChannels}
                hiddenCategories={hiddenCategories}
                selectedCategory={selectedCategory}
                sessionId={sessionId}
                isLoading={isLoading}
                loadMoreChannels={loadMoreChannels}
              />
            </div>
          </div>
        );
      case 'player':
        return (
          <PlayerView
            sessionId={sessionId}
            selectedChannel={selectedChannel}
            onEpgMatch={handleEpgMatch}
            matchedChannels={matchedChannels}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
          />
        );
      case 'result':
        return (
          <ResultView
            result={result}
            onCopyToClipboard={copyToClipboard}
            onBackToPlayer={() => setActiveTab('player')}
          />
        );
      default:
        return (
          <div className="tab-content">
            <SessionDebugger />
            <Configuration 
              onLoad={handleLoad} 
              isLoading={isLoading} 
              error={loadingError}
              sessionId={sessionId}
            />
          </div>
        );
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
        return response.data;
      } else if (response.data && typeof response.data === 'object') {
        if (Array.isArray(response.data.categories)) {
          console.log(`[App.fetchCategories] Setting ${response.data.categories.length} categories from object property`);
          setCategories(response.data.categories);
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
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <div style={{ margin: '20px 0' }}>
            <span style={{
              display: 'inline-block',
              width: '20px',
              height: '20px',
              border: '3px solid #f3f3f3',
              borderTop: '3px solid #3498db',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              marginRight: '10px'
            }}></span>
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

  // Ensure categories are loaded when switching to channels tab
  useEffect(() => {
    // Use a timestamp cache to prevent repeated fetches
    const now = Date.now();
    const lastCategoryFetch = window.lastCategoryFetchTime || 0;
    const CACHE_LIFETIME = 60000; // 1 minute
    
    const loadCategoriesIfNeeded = async () => {
      if (activeTab === 'channels' && categories.length === 0 && sessionId) {
        // Only fetch if it's been more than CACHE_LIFETIME since last fetch
        if (now - lastCategoryFetch > CACHE_LIFETIME) {
          console.log(`[App] Loading categories for session: ${sessionId} (cache expired)`);
          window.lastCategoryFetchTime = now;
          await fetchCategoriesFromApi(sessionId);
        } else {
          console.log(`[App] Using cached categories (fetched ${(now - lastCategoryFetch)/1000}s ago)`);
        }
      }
    };
    
    loadCategoriesIfNeeded();
  }, [activeTab, categories.length, sessionId]);

  // Emergency component that directly shows categories
  const EmergencyCategoryDisplay = () => {
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const sessionId = SessionManager.getSessionId();
    
    useEffect(() => {
      const loadCategories = async () => {
        // Ensure we have a valid session ID
        const effectiveSessionId = sessionId;
        
        if (!effectiveSessionId) {
          setError('No session ID available');
          setLoading(false);
          return;
        }
        
        // Check if we should use cached categories
        const now = Date.now();
        const lastEmergencyCategoryFetch = window.lastEmergencyCategoryFetchTime || 0;
        const CACHE_LIFETIME = 60000; // 1 minute
        
        if (now - lastEmergencyCategoryFetch < CACHE_LIFETIME) {
          console.log(`[EMERGENCY] Using cached emergency categories (fetched ${(now - lastEmergencyCategoryFetch)/1000}s ago)`);
          setLoading(false);
          return;
        }
        
        try {
          console.log('[EMERGENCY] Attempting to fetch categories with session ID:', effectiveSessionId);
          window.lastEmergencyCategoryFetchTime = now;
          const response = await fetch(`/api/channels/${effectiveSessionId}/categories`);
          
          if (!response.ok) {
            setError(`API error: ${response.status} ${response.statusText}`);
            setLoading(false);
            return;
          }
          
          const text = await response.text();
          console.log('[EMERGENCY] Raw response:', text.substring(0, 100) + '...');
          
          try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
              console.log(`[EMERGENCY] ✅ Parsed ${data.length} categories`);
              setCategories(data);
            } else {
              console.error('[EMERGENCY] Response is not an array:', data);
              setError('API response is not an array');
            }
          } catch (parseError) {
            console.error('[EMERGENCY] JSON parse error:', parseError);
            setError(`JSON parse error: ${parseError.message}`);
          }
        } catch (fetchError) {
          console.error('[EMERGENCY] Fetch error:', fetchError);
          setError(`Fetch error: ${fetchError.message}`);
        } finally {
          setLoading(false);
        }
      };
      
      loadCategories();
    }, [sessionId]);
    
    if (loading) {
      return <div>Loading categories directly...</div>;
    }
    
    if (error) {
      return (
        <div style={{ color: 'red', padding: '10px' }}>
          <div>{error}</div>
          <button 
            onClick={() => window.location.reload()}
            style={{
              marginTop: '10px',
              padding: '8px 16px',
              backgroundColor: '#f44336',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }
    
    return (
      <div style={{ 
        border: '3px solid #4caf50', 
        borderRadius: '8px', 
        padding: '15px',
        margin: '15px 0',
        backgroundColor: '#f1f8e9'
      }}>
        <h3 style={{ margin: '0 0 10px 0', color: '#2e7d32' }}>
          📋 Emergency Category Display ({categories.length})
        </h3>
        
        <div style={{ 
          maxHeight: '300px', 
          overflowY: 'auto',
          border: '1px solid #c5e1a5',
          borderRadius: '4px',
          backgroundColor: 'white' 
        }}>
          {categories.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', padding: '10px' }}>
              {categories.slice(0, 100).map((cat, index) => (
                <div 
                  key={`${cat.name}-${index}`}
                  style={{
                    margin: '4px',
                    padding: '6px 12px',
                    backgroundColor: '#f5f5f5',
                    borderRadius: '30px',
                    fontSize: '13px',
                    border: '1px solid #e0e0e0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  <span>{cat.name}</span>
                  <span style={{ 
                    backgroundColor: '#e8f5e9', 
                    color: '#2e7d32',
                    padding: '2px 6px',
                    borderRadius: '20px',
                    fontSize: '11px',
                    minWidth: '20px',
                    textAlign: 'center'
                  }}>
                    {cat.count}
                  </span>
                </div>
              ))}
              {categories.length > 100 && (
                <div style={{ 
                  margin: '4px', 
                  padding: '6px 12px',
                  backgroundColor: '#fffde7',
                  border: '1px solid #fff59d',
                  borderRadius: '30px',
                  fontSize: '13px'
                }}>
                  ...and {categories.length - 100} more
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
              No categories available
            </div>
          )}
        </div>
      </div>
    );
  };

  // DirectCategoryManager - Completely bypasses the original components
  const DirectCategoryManager = (props) => {
    const { onCategorySelect, onVisibilityChange, hiddenCategories, selectedCategory, sessionId: propsSessionId } = props;
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [categoryFilter, setCategoryFilter] = useState('');
    
    // Load categories directly from API
    useEffect(() => {
      const loadCategories = async () => {
        // Get session ID from props or from SessionManager as fallback
        const effectiveSessionId = propsSessionId || SessionManager.getSessionId();
        
        if (!effectiveSessionId) {
          setError('No session ID available');
          setLoading(false);
          return;
        }
        
        // Check if we should use cached categories
        const now = Date.now();
        const lastDirectCategoryFetch = window.lastDirectCategoryFetchTime || 0;
        const CACHE_LIFETIME = 60000; // 1 minute
        
        // Skip fetching if we recently fetched and already have categories
        if (categories.length > 0 && now - lastDirectCategoryFetch < CACHE_LIFETIME) {
          console.log(`[DIRECT] Using cached categories (fetched ${(now - lastDirectCategoryFetch)/1000}s ago)`);
          setLoading(false);
          return;
        }
        
        try {
          console.log('[DIRECT] Loading categories for session:', effectiveSessionId);
          window.lastDirectCategoryFetchTime = now;
          const response = await fetch(`/api/channels/${effectiveSessionId}/categories`);
          
          if (!response.ok) {
            setError(`API error: ${response.status} ${response.statusText}`);
            setLoading(false);
            return;
          }
          
          const text = await response.text();
          try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
              console.log(`[DIRECT] ✅ Loaded ${data.length} categories`);
              
              // Format categories to ensure consistent structure
              const formatted = data.map(cat => {
                if (typeof cat === 'string') return { name: cat, count: 0 };
                return {
                  name: cat.name || cat.category || cat.title || cat.groupTitle || 'Unknown',
                  count: parseInt(cat.count) || 0
                };
              });
              
              // Sort alphabetically
              formatted.sort((a, b) => a.name.localeCompare(b.name));
              setCategories(formatted);
            } else {
              console.error('[DIRECT] Response is not an array:', data);
              setError('API response is not an array');
            }
          } catch (parseError) {
            console.error('[DIRECT] JSON parse error:', parseError);
            setError(`JSON parse error: ${parseError.message}`);
          }
        } catch (fetchError) {
          console.error('[DIRECT] Fetch error:', fetchError);
          setError(`Fetch error: ${fetchError.message}`);
        } finally {
          setLoading(false);
        }
      };
      
      loadCategories();
    }, [propsSessionId]);
    
    // Filter categories based on search
    const filteredCategories = categoryFilter
      ? categories.filter(cat => 
          cat.name.toLowerCase().includes(categoryFilter.toLowerCase())
        )
      : categories;
    
    // Toggle category visibility
    const toggleCategory = (category) => {
      const updatedHiddenCategories = hiddenCategories.includes(category)
        ? hiddenCategories.filter(c => c !== category)
        : [...hiddenCategories, category];
      
      onVisibilityChange(updatedHiddenCategories);
    };
    
    // Hide all categories
    const hideAllCategories = () => {
      const allCategoryNames = categories.map(cat => cat.name);
      onVisibilityChange(allCategoryNames);
    };
    
    // Show all categories
    const showAllCategories = () => {
      onVisibilityChange([]);
      onCategorySelect(null);
    };
    
    if (loading) {
      return (
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <div style={{ margin: '20px 0' }}>
            <span style={{
              display: 'inline-block',
              width: '20px',
              height: '20px',
              border: '3px solid #f3f3f3',
              borderTop: '3px solid #3498db',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              marginRight: '10px'
            }}></span>
            Loading categories...
          </div>
        </div>
      );
    }
    
    if (error) {
      return (
        <div style={{ padding: '20px', color: 'red' }}>
          <div>Error: {error}</div>
          <button 
            onClick={() => window.location.reload()}
            style={{
              marginTop: '10px',
              padding: '8px 16px',
              backgroundColor: '#f44336',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }
    
    return (
      <div>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '10px'
        }}>
          <h3 style={{ 
            margin: 0, 
            fontSize: '16px', 
            color: '#444',
            fontWeight: '500'
          }}>
            Categories ({categories.length})
          </h3>
          
          <div style={{ display: 'flex', gap: '5px' }}>
            <button 
              onClick={hideAllCategories} 
              style={{ 
                padding: '4px 8px', 
                fontSize: '12px',
                background: 'transparent',
                border: '1px solid #ddd',
                borderRadius: '4px',
                cursor: 'pointer',
                color: '#666'
              }}
            >
              Hide All
            </button>
            <button 
              onClick={showAllCategories} 
              style={{ 
                padding: '4px 8px', 
                fontSize: '12px',
                background: 'transparent',
                border: '1px solid #ddd',
                borderRadius: '4px',
                cursor: 'pointer',
                color: '#666'
              }}
            >
              Show All
            </button>
          </div>
        </div>
        
        {/* Category filter input */}
        <div style={{ marginBottom: '10px', position: 'relative' }}>
          <svg 
            style={{ 
              position: 'absolute', 
              left: '8px', 
              top: '50%', 
              transform: 'translateY(-50%)',
              color: '#666' 
            }} 
            xmlns="http://www.w3.org/2000/svg" 
            width="14" 
            height="14" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            placeholder="Filter categories..."
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            style={{ 
              width: '100%',
              padding: '8px 10px 8px 30px',
              borderRadius: '6px',
              border: '1px solid #ddd',
              fontSize: '13px'
            }}
          />
          {categoryFilter && (
            <button
              onClick={() => setCategoryFilter('')}
              style={{
                position: 'absolute',
                right: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px',
                color: '#999'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>
        
        <div style={{ 
          maxHeight: 'calc(100vh - 240px)', 
          overflowY: 'auto', 
          border: '1px solid #eee', 
          borderRadius: '8px',
          padding: '5px',
          backgroundColor: 'white'
        }}>
          {filteredCategories.length > 0 ? (
            filteredCategories.map((cat, index) => (
              <div 
                key={`${cat.name}-${index}`} 
                style={{ 
                  margin: '2px 0',
                  borderRadius: '4px',
                  overflow: 'hidden'
                }}
              >
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center',
                  backgroundColor: selectedCategory === cat.name ? '#f0f7ff' : 'transparent',
                  padding: '8px 10px',
                  borderRadius: '4px',
                  transition: 'background-color 0.2s ease'
                }}>
                  <input
                    type="checkbox"
                    id={`direct-category-${index}`}
                    checked={!hiddenCategories.includes(cat.name)}
                    onChange={() => toggleCategory(cat.name)}
                    style={{ 
                      marginRight: '8px',
                      accentColor: '#1a73e8'
                    }}
                  />
                  <label 
                    htmlFor={`direct-category-${index}`}
                    onClick={() => onCategorySelect(cat.name)} 
                    style={{ 
                      cursor: 'pointer', 
                      flex: 1,
                      fontSize: '14px',
                      color: selectedCategory === cat.name ? '#1a73e8' : '#444',
                      fontWeight: selectedCategory === cat.name ? '500' : 'normal',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <span style={{ 
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {cat.name}
                    </span>
                    <span style={{ 
                      backgroundColor: '#f1f1f1',
                      borderRadius: '30px',
                      padding: '2px 8px',
                      fontSize: '12px',
                      color: '#666',
                      minWidth: '30px',
                      textAlign: 'center'
                    }}>
                      {cat.count}
                    </span>
                  </label>
                </div>
              </div>
            ))
          ) : (
            <div style={{ 
              padding: '20px', 
              textAlign: 'center', 
              color: '#888',
              fontSize: '14px'
            }}>
              {categoryFilter ? "No categories match your filter" : "No categories available"}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Server Status Button component
  const ServerStatusButton = () => {
    const [isChecking, setIsChecking] = useState(false);
    const [statusData, setStatusData] = useState(null);
    const [showDetails, setShowDetails] = useState(false);
    const [isReloadingEpg, setIsReloadingEpg] = useState(false);
    
    // Force a reload of EPG sources using the init endpoint
    const forceReloadEpg = async () => {
      if (window.confirm('Force reload EPG sources from the server configuration? This will add all configured EPG sources to your session.')) {
        setIsReloadingEpg(true);
        try {
          // Get the session ID
          const sessionId = SessionManager.getSessionId();
          if (!sessionId) {
            alert('Error: No session ID available');
            return;
          }
          
          // First initialize the EPG session
          const initResponse = await fetch('/api/epg/init', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sessionId })
          });
          
          if (!initResponse.ok) {
            throw new Error(`Failed to initialize EPG: ${initResponse.status}`);
          }
          
          const initData = await initResponse.json();
          console.log('[EPG Reload] Init result:', initData);
          
          // Refresh EPG sources
          const epgResponse = await fetch(`/api/epg/${sessionId}/sources?_t=${Date.now()}`);
          if (!epgResponse.ok) {
            throw new Error(`Failed to get EPG sources: ${epgResponse.status}`);
          }
          
          const epgData = await epgResponse.json();
          console.log('[EPG Reload] Sources result:', epgData);
          
          // Show success message
          alert(`Successfully loaded ${epgData.sources.length} EPG sources!`);
          
          // Trigger a custom event to notify the DirectEpgSourcesLoader component
          const event = new CustomEvent('epgSourcesUpdated', { detail: epgData.sources });
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
        const response = await fetch('/api/status');
        if (response.ok) {
          const data = await response.json();
          setStatusData(data);
          console.log('[Server Status]', data);
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
          const response = await fetch('/api/status/cleanup', {
            method: 'POST'
          });
          
          if (response.ok) {
            const result = await response.json();
            console.log('[Server Cleanup] Result:', result);
            alert(`Cleanup complete. Removed ${result.sessionsDiff} sessions.`);
            
            // Refresh status data
            checkServerStatus();
          }
        } catch (error) {
          console.error('Error triggering cleanup:', error);
        } finally {
          setIsChecking(false);
        }
      }
    };
    
    // Format memory usage for display
    const formatMemory = (memoryObj) => {
      if (!memoryObj) return 'N/A';
      return Object.entries(memoryObj).map(([key, value]) => 
        `${key}: ${value}`
      ).join(', ');
    };
    
    return (
      <div style={{
        position: 'fixed',
        bottom: '10px',
        right: '10px',
        zIndex: 1000
      }}>
        {statusData && showDetails && (
          <div style={{
            position: 'absolute',
            bottom: '40px',
            right: '0',
            backgroundColor: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            padding: '10px',
            width: '300px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            fontSize: '12px'
          }}>
            <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>
              Server Status
              <button 
                onClick={() => setShowDetails(false)}
                style={{
                  float: 'right',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontSize: '14px'
                }}
              >
                ×
              </button>
            </div>
            <div>Uptime: {Math.floor(statusData.uptime / 60)} minutes</div>
            <div>Memory: {formatMemory(statusData.memory)}</div>
            <div>Sessions: {statusData.sessions.count}</div>
            {statusData.sessions.oldest && (
              <div>Oldest: {new Date(statusData.sessions.oldest.lastAccessed).toLocaleTimeString()}</div>
            )}
            
            <div style={{ display: 'flex', gap: '5px', marginTop: '8px' }}>
              <button
                onClick={triggerCleanup}
                disabled={isChecking}
                style={{
                  flex: '1',
                  padding: '4px 8px',
                  fontSize: '12px',
                  backgroundColor: '#f8d7da',
                  color: '#721c24',
                  border: '1px solid #f5c6cb',
                  borderRadius: '4px',
                  cursor: isChecking ? 'wait' : 'pointer'
                }}
              >
                {isChecking ? 'Working...' : 'Cleanup Sessions'}
              </button>
              
              <button
                onClick={forceReloadEpg}
                disabled={isReloadingEpg}
                style={{
                  flex: '1',
                  padding: '4px 8px',
                  fontSize: '12px',
                  backgroundColor: '#d1ecf1',
                  color: '#0c5460',
                  border: '1px solid #bee5eb',
                  borderRadius: '4px',
                  cursor: isReloadingEpg ? 'wait' : 'pointer'
                }}
              >
                {isReloadingEpg ? 'Loading...' : 'Force Reload EPG'}
              </button>
            </div>
            
            <div style={{ fontSize: '10px', marginTop: '5px', color: '#666' }}>
              Last checked: {new Date(statusData.timestamp).toLocaleTimeString()}
            </div>
          </div>
        )}
        
        <button
          onClick={() => {
            if (statusData && !showDetails) {
              setShowDetails(true);
            } else {
              checkServerStatus();
              setShowDetails(true);
            }
          }}
          disabled={isChecking}
          style={{
            padding: '8px 12px',
            backgroundColor: isChecking ? '#6c757d' : '#17a2b8',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isChecking ? 'wait' : 'pointer',
            fontSize: '12px',
            opacity: 0.8
          }}
        >
          {isChecking ? 'Checking...' : (statusData ? 'Status ●' : 'Status')}
        </button>
      </div>
    );
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif',
      color: '#333',
      backgroundColor: '#f5f7fa'
    }}>
      {/* Header */}
      <header style={{
        backgroundColor: 'white',
        borderBottom: '1px solid #eee',
        padding: '10px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '20px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <button
            onClick={toggleSidebar}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#666',
              cursor: 'pointer',
              padding: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          {sessionId && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#e3f2fd',
              padding: '4px 10px',
              borderRadius: '30px',
              fontSize: '12px',
              color: '#1565c0'
            }}>
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
                style={{ marginRight: '5px' }}
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              Session: {sessionId.substring(0, 8)}
            </div>
          )}
        </div>

        <div style={{ flex: 1, textAlign: 'center' }}>
          <h1 style={{
            fontSize: '18px',
            margin: 0,
            color: '#1a73e8',
            fontWeight: '500'
          }}>
            IPTV EPG Matcher
          </h1>
        </div>

        <div>
          {sessionId && activeTab === 'channels' && (
            <button
              onClick={async () => {
                console.log('[App] Manually reloading categories');
                await fetchCategoriesFromApi(sessionId);
              }}
              style={{
                backgroundColor: '#f1f8e9',
                color: '#388e3c',
                border: '1px solid #c5e1a5',
                borderRadius: '4px',
                padding: '8px 12px',
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
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
        </div>
      </header>

      {/* Main content */}
      <div style={{
        display: 'flex',
        flex: 1,
        position: 'relative'
      }}>
        {/* Sidebar */}
        <Sidebar
          showSidebar={showSidebar}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          handleReset={handleReset}
          totalChannels={totalChannels}
          categoryCount={categories.length}
          matchedChannelCount={Object.keys(matchedChannels).length}
          epgSourceCount={epgSources.length}
        />

        {/* Main content area */}
        <main style={{
          flex: 1,
          overflowY: 'auto',
          maxHeight: 'calc(100vh - 60px)'
        }}>
          {/* Status message */}
          {status && (
            <StatusDisplay
              message={status}
              type={statusType}
            />
          )}

          {/* Tab content */}
          {renderActiveTabContent()}
        </main>
      </div>

      {/* CSS Animation */}
      <style dangerouslySetInnerHTML={{
        __html: `
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `
      }} />

      {/* Server status button */}
      <ServerStatusButton />
    </div>
  );
}

export default App;