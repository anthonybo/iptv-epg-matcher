import React, { useState, useEffect, useCallback } from 'react';
import { fetchChannels, loadAllChannelsProgressively, fetchCategories } from '../../services/ApiService';
import { getCurrentSession } from '../../services/ApiService';
import './ChannelList.css';
import { getSessionId } from '../../utils/sessionManager';

// Add global styles to ensure debug panel visibility
const GlobalDebugStyles = () => {
  return (
    <style dangerouslySetInnerHTML={{
      __html: `
        /* Force visibility for debug elements */
        .super-debug-panel {
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          position: relative !important;
          z-index: 999999 !important;
          pointer-events: auto !important;
        }
        
        /* Ensure the debug panel is at the top of the document */
        .channel-list-container {
          position: relative !important;
        }
        
        /* Force display of the app container */
        #root, .App, main, .channel-list-container {
          overflow: visible !important;
          max-height: none !important;
          display: block !important;
        }
        
        /* Absolute positioned warning - can't be hidden */
        .absolute-debug-warning {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          z-index: 9999999 !important;
          background-color: red !important;
          color: white !important;
          font-size: 18px !important;
          font-weight: bold !important;
          padding: 10px !important;
          text-align: center !important;
          border-bottom: 4px solid black !important;
          box-shadow: 0 0 20px #000 !important;
        }
      `
    }} />
  );
};

// Function to generate categories from loaded channels
const generateCategoriesFromLoadedChannels = (channels) => {
  if (!channels || channels.length === 0) {
    console.log('[ERROR] generateCategoriesFromLoadedChannels - No channels provided');
    return [];
  }
  
  console.log(`[INFO] generateCategoriesFromLoadedChannels - Generating from ${channels.length} channels`);
  const categoryCounts = channels.reduce((acc, ch) => {
    const groupTitle = ch.groupTitle || 'Uncategorized';
    acc[groupTitle] = (acc[groupTitle] || 0) + 1;
    return acc;
  }, {});
  
  const generatedCategories = Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
    
  console.log(`[SUCCESS] generateCategoriesFromLoadedChannels - Generated ${generatedCategories.length} categories`);
  return generatedCategories;
};

const ChannelList = ({ page = 1, limit = 500, filter }) => {
  const [channels, setChannels] = useState([]);
  const [totalChannels, setTotalChannels] = useState(0);
  const [loadedChannels, setLoadedChannels] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [categories, setCategories] = useState([]);
  const [sessionId, setSessionId] = useState(getCurrentSession());
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [isProgressiveLoading, setIsProgressiveLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  
  // Handle progress updates for progressive loading
  const handleProgressUpdate = useCallback((loaded, total) => {
    const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0;
    setLoadedChannels(loaded);
    setTotalChannels(total || loaded); // Ensure totalChannels is always set
    setLoadingProgress(percentage);
    
    // Update channels array with currently loaded channels
    // This allows showing channels while more are being loaded
    if (!loading) {
      setLoading(false);
    }
  }, [loading]);
  
  // Load channels progressively from the API
  const loadChannelsProgressively = useCallback(async () => {
    console.log('[TRACE] loadChannelsProgressively - Starting');
    setLoading(true);
    setIsProgressiveLoading(true);
    setError(null);
    
    try {
      // Get the current session ID
      const currentSessionId = getCurrentSession();
      setSessionId(currentSessionId);
      
      if (!currentSessionId) {
        console.error('[ERROR] loadChannelsProgressively - No session ID available for channel loading');
        setError('No active session. Please load channels first.');
        setLoading(false);
        setIsProgressiveLoading(false);
        return;
      }
      
      console.log(`[INFO] loadChannelsProgressively - Using session ID: ${currentSessionId}`);
      
      // First, load categories for quick display
      try {
        console.log('[DEBUG] loadChannelsProgressively - Fetching categories first');
        const categoriesResult = await fetchCategories();
        console.log('[DEBUG] loadChannelsProgressively - Categories result:', categoriesResult);
        
        if (categoriesResult && Array.isArray(categoriesResult) && categoriesResult.length > 0) {
          console.log(`[SUCCESS] loadChannelsProgressively - Received ${categoriesResult.length} categories from API`);
          console.log('[DEBUG] loadChannelsProgressively - Categories sample:', categoriesResult.slice(0, 5));
          setCategories(categoriesResult);
        } else {
          console.warn('[WARN] loadChannelsProgressively - No valid categories received from API, will generate from channels');
          // Categories will be generated after channels are loaded
        }
      } catch (catError) {
        console.warn('[WARN] loadChannelsProgressively - Error loading categories:', catError);
      }
      
      // Start progressive loading with progress callback
      console.log('[DEBUG] loadChannelsProgressively - Starting progressive channel loading');
      const result = await loadAllChannelsProgressively(
        handleProgressUpdate,
        limit,
        20 // Max 20 chunks to prevent loading too many
      );
      
      console.log('[DEBUG] loadChannelsProgressively - Initial channel load result:', {
        channelsCount: result.channels?.length || 0,
        totalChannels: result.pagination?.totalChannels || result.totalChannels || result.channels?.length || 0,
        hasCategories: !!result.categories,
        categoriesCount: result.categories?.length || 0
      });
      
      // Update state with initial result
      setChannels(result.channels || []);
      
      // Set totalChannels
      const totalCh = result.pagination?.totalChannels || result.totalChannels || result.channels?.length || 0;
      setTotalChannels(totalCh);
      console.log(`[INFO] loadChannelsProgressively - Total channels: ${totalCh}`);
      
      // Set categories if not already set
      if (categories.length === 0) {
        if (result.categories && Array.isArray(result.categories) && result.categories.length > 0) {
          console.log(`[SUCCESS] loadChannelsProgressively - Using ${result.categories.length} categories from channels response`);
          setCategories(result.categories);
        } else if (result.channels && result.channels.length > 0) {
          // Generate categories from channels
          console.log('[INFO] loadChannelsProgressively - Generating categories from loaded channels');
          const generatedCategories = generateCategoriesFromLoadedChannels(result.channels);
          if (generatedCategories.length > 0) {
            console.log(`[SUCCESS] loadChannelsProgressively - Generated ${generatedCategories.length} categories`);
            setCategories(generatedCategories);
          }
        }
      }
      
      setLoading(false);
      console.log('[TRACE] loadChannelsProgressively - Initial load complete, progressive loading continues in background');
    } catch (err) {
      console.error('[ERROR] loadChannelsProgressively - Error loading channels:', err);
      setError(`Error loading channels: ${err.message || 'Unknown error'}`);
      setLoading(false);
      setIsProgressiveLoading(false);
    }
  }, [limit, handleProgressUpdate, categories.length]);
  
  // Function to fetch categories directly from the API without using the service
  const fetchCategoriesDirect = async () => {
    console.log('[ChannelList.fetchCategoriesDirect] Starting direct category fetch');
    const sid = sessionId || getSessionId();
    
    if (!sid) {
      console.error('[ERROR] ChannelList.fetchCategoriesDirect: No session ID available for fetching categories');
      return null;
    }
    
    try {
      console.log(`[ChannelList.fetchCategoriesDirect] Fetching categories for session ${sid}`);
      // Use absolute URL with API_BASE_URL
      const fullUrl = `/api/channels/${sid}/categories`;
      console.log(`[ChannelList.fetchCategoriesDirect] Full URL: ${fullUrl}`);
      
      const response = await fetch(fullUrl);
      console.log(`[ChannelList.fetchCategoriesDirect] Response status: ${response.status}`);
      
      if (!response.ok) {
        console.error(`[ERROR] ChannelList.fetchCategoriesDirect: Failed to fetch categories - Status: ${response.status}`);
        return null;
      }
      
      // Log the raw response
      const responseText = await response.text();
      console.log(`[ChannelList.fetchCategoriesDirect] Raw API response (first 200 chars): ${responseText.substring(0, 200)}...`);
      
      let data;
      try {
        data = JSON.parse(responseText);
        console.log(`[ChannelList.fetchCategoriesDirect] Parsed data:`, data);
      } catch (parseError) {
        console.error('[ERROR] ChannelList.fetchCategoriesDirect: Failed to parse API response', parseError);
        return null;
      }
      
      // Log detailed information about the response structure
      console.log(`[ChannelList.fetchCategoriesDirect] Response structure:`, {
        keys: Object.keys(data),
        hasCategories: !!data.categories,
        categoriesLength: data.categories ? data.categories.length : 0,
        isArray: Array.isArray(data),
        arrayLength: Array.isArray(data) ? data.length : 0,
        firstItem: Array.isArray(data) && data.length > 0 ? data[0] : null,
        firstItemType: Array.isArray(data) && data.length > 0 ? typeof data[0] : null
      });
      
      // Now extract the categories - try multiple paths
      let categories = null;
      
      if (data.categories && Array.isArray(data.categories)) {
        console.log(`[ChannelList.fetchCategoriesDirect] Found ${data.categories.length} categories in data.categories`);
        categories = data.categories;
      } else if (data.result && data.result.categories && Array.isArray(data.result.categories)) {
        console.log(`[ChannelList.fetchCategoriesDirect] Found ${data.result.categories.length} categories in data.result.categories`);
        categories = data.result.categories;
      } else if (Array.isArray(data)) {
        console.log(`[ChannelList.fetchCategoriesDirect] Response is an array with ${data.length} items`);
        categories = data;
      } else {
        console.warn('[WARN] ChannelList.fetchCategoriesDirect: Could not find valid categories in the API response');
        return null;
      }
      
      if (categories && categories.length > 0) {
        console.log(`[SUCCESS] ChannelList.fetchCategoriesDirect: Successfully fetched ${categories.length} categories`);
        if (categories.length > 0) {
          console.log(`[ChannelList.fetchCategoriesDirect] First category:`, categories[0]);
          console.log(`[ChannelList.fetchCategoriesDirect] First category type:`, typeof categories[0]);
          
          // Format categories if needed
          if (typeof categories[0] === 'string') {
            console.log('[ChannelList.fetchCategoriesDirect] Converting string categories to objects');
            categories = categories.map(cat => ({ name: cat, count: 0 }));
          } else if (typeof categories[0] === 'object') {
            // Make sure each category has name and count properties
            categories = categories.map(cat => ({
              name: cat.name || cat.category || cat.title || JSON.stringify(cat),
              count: cat.count || cat.channelCount || 0
            }));
          }
          
          console.log(`[ChannelList.fetchCategoriesDirect] Final formatted categories (${categories.length})`, categories.slice(0, 3));
        }
        return categories;
      } else {
        console.warn('[WARN] ChannelList.fetchCategoriesDirect: Categories array is empty');
        return [];
      }
    } catch (error) {
      console.error('[ERROR] ChannelList.fetchCategoriesDirect: Error fetching categories directly:', error);
      return null;
    } finally {
      console.log('[ChannelList.fetchCategoriesDirect] Finished direct category fetch');
    }
  };

  // Manually force refresh categories
  const forceRefreshCategories = async () => {
    console.log('[TRACE] ChannelList.forceRefreshCategories: Starting category refresh');
    try {
      // 1. First try direct API fetch
      console.log('[DEBUG] ChannelList.forceRefreshCategories: Attempting direct API fetch for categories');
      const directCategories = await fetchCategoriesDirect();
      
      if (directCategories && directCategories.length > 0) {
        console.log(`[SUCCESS] ChannelList.forceRefreshCategories: Direct API fetch successful, got ${directCategories.length} categories`);
        console.log(`[DEBUG] ChannelList.forceRefreshCategories: First few categories:`, directCategories.slice(0, 3));
        setCategories(directCategories);
        return true;
      }
      
      // 2. Try using the service with force refresh
      console.log('[DEBUG] ChannelList.forceRefreshCategories: Direct fetch failed, trying through service');
      const serviceCategories = await fetchCategories(true); // force refresh
      
      if (serviceCategories && serviceCategories.length > 0) {
        console.log(`[SUCCESS] ChannelList.forceRefreshCategories: Service fetch successful, got ${serviceCategories.length} categories`);
        console.log(`[DEBUG] ChannelList.forceRefreshCategories: First few categories:`, serviceCategories.slice(0, 3));
        setCategories(serviceCategories);
        return true;
      }
      
      // 3. Generate from loaded channels if we have them
      if (channels && channels.length > 0) {
        console.log('[INFO] ChannelList.forceRefreshCategories: API methods failed, generating from loaded channels');
        const categoryCounts = channels.reduce((acc, ch) => {
          const groupTitle = ch.groupTitle || 'Uncategorized';
          acc[groupTitle] = (acc[groupTitle] || 0) + 1;
          return acc;
        }, {});
        
        const generatedCategories = Object.entries(categoryCounts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name));
        
        if (generatedCategories.length > 0) {
          console.log(`[SUCCESS] ChannelList.forceRefreshCategories: Generated ${generatedCategories.length} categories from loaded channels`);
          setCategories(generatedCategories);
          return true;
        }
      }
      
      console.warn('[WARN] ChannelList.forceRefreshCategories: All methods to refresh categories failed');
      return false;
    } catch (error) {
      console.error('[ERROR] ChannelList.forceRefreshCategories: Failed to refresh categories:', error);
      return false;
    } finally {
      console.log('[TRACE] ChannelList.forceRefreshCategories: Completed category refresh attempt');
    }
  };
  
  // Load filtered channels by category
  const loadChannelsByCategory = useCallback(async (category) => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await fetchChannels(1, 1000, category);
      setChannels(result.channels || []);
      // Fix: Get totalChannels from pagination object or directly from result
      setTotalChannels(result.pagination?.totalChannels || result.totalChannels || result.channels?.length || 0);
      setLoadedChannels(result.channels?.length || 0);
      setLoading(false);
    } catch (err) {
      console.error(`Error loading channels for category ${category}:`, err);
      setError(`Failed to load channels for category: ${err.message || 'Unknown error'}`);
      setLoading(false);
    }
  }, []);
  
  // Handle category selection
  const handleCategoryChange = useCallback((category) => {
    console.log('[DEBUG] handleCategoryChange - Selected category:', category);
    
    // Extract actual category value depending on format
    let categoryValue = category;
    if (typeof category === 'object' && category !== null) {
      categoryValue = category.name || category.title || category.category || String(category);
      console.log('[DEBUG] handleCategoryChange - Extracted name from object:', categoryValue);
    }
    
    setSelectedCategory(categoryValue);
    console.log('[DEBUG] handleCategoryChange - Setting category to:', categoryValue);
    
    if (categoryValue) {
      console.log('[DEBUG] handleCategoryChange - Loading channels for category:', categoryValue);
      loadChannelsByCategory(categoryValue);
    } else {
      console.log('[DEBUG] handleCategoryChange - Loading all channels (no category filter)');
      loadChannelsProgressively();
    }
  }, [loadChannelsByCategory, loadChannelsProgressively]);
  
  // Load channels from the API (traditional method, single request)
  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Get the current session ID
      const currentSessionId = getCurrentSession();
      setSessionId(currentSessionId);
      
      if (!currentSessionId) {
        console.error('No session ID available for channel loading');
        setError('No active session. Please load channels first.');
        setLoading(false);
        return;
      }
      
      console.log(`Loading channels with session ID: ${currentSessionId}`);
      
      // Fetch channels using the API service
      const result = await fetchChannels(page, limit, filter);
      
      console.log(`Received ${result.channels?.length || 0} channels`);
      setChannels(result.channels || []);
      
      // Fix: Get totalChannels from pagination object or directly from result
      setTotalChannels(result.pagination?.totalChannels || result.totalChannels || 0);
      setLoadedChannels(result.loadedChannels || result.channels?.length || 0);
      
      // Also update categories if available
      if (result.categories) {
        setCategories(result.categories);
      }
    } catch (err) {
      console.error('Error loading channels:', err);
      setError(`Error loading channels: ${err.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  }, [page, limit, filter]);
  
  // Listen for session change events
  useEffect(() => {
    const handleSessionChange = (event) => {
      console.log('Session change event detected in ChannelList', event.detail);
      
      if (event.detail && event.detail.sessionId) {
        setSessionId(event.detail.sessionId);
        // Reload channels with new session ID
        loadChannelsProgressively();
      }
    };
    
    window.addEventListener('sessionChange', handleSessionChange);
    return () => window.removeEventListener('sessionChange', handleSessionChange);
  }, [loadChannelsProgressively]);
  
  // Load channels on component mount and when dependencies change
  useEffect(() => {
    console.log('[useEffect] ChannelList - Loading channels progressively');
    // Use progressive loading for initial load
    loadChannelsProgressively();
    
    // Log whenever categories change
    return () => {
      console.log('[cleanup] ChannelList - Dependencies changed');
    };
  }, [loadChannelsProgressively]);
  
  // Add a separate effect to monitor categories changes
  useEffect(() => {
    console.log('[useEffect] ChannelList - Categories updated:', {
      count: categories.length,
      sample: categories.slice(0, 3),
      empty: categories.length === 0
    });
  }, [categories]);
  
  // Render loading state
  if (loading && channels.length === 0) {
    return (
      <div className="loading-container">
        <div className="loading">Loading channels...</div>
        {loadingProgress > 0 && (
          <div className="loading-progress">
            <div className="progress-bar">
              <div 
                className="progress-bar-fill" 
                style={{ width: `${loadingProgress}%` }}
              ></div>
            </div>
            <div className="progress-text">
              {loadedChannels} of {totalChannels || loadedChannels || '?'} channels loaded ({loadingProgress}%)
            </div>
          </div>
        )}
      </div>
    );
  }
  
  // Render error state
  if (error) {
    return (
      <div className="error-container">
        <div className="error">{error}</div>
        <div className="session-info">
          Current session ID: {sessionId || 'None'}
        </div>
      </div>
    );
  }
  
  // Render no channels state
  if (channels.length === 0) {
    return (
      <div className="no-channels-container">
        <div className="no-channels">No channels found. Please load channels first.</div>
        <div className="session-info">
          Current session ID: {sessionId || 'None'}
        </div>
      </div>
    );
  }
  
  // Render channels with progressive loading indicator and category filter
  return (
    <div className="channel-list-container">
      {/* Include the global debug styles */}
      <GlobalDebugStyles />
      
      {/* Absolute positioned warning message */}
      <div className="absolute-debug-warning">
        ⚠️ DEBUGGING MODE ACTIVE: {categories.length} CATEGORIES, {channels.length} CHANNELS ⚠️ 
        {categories.length === 0 && <span style={{ color: 'yellow' }}> NO CATEGORIES FOUND!</span>}
      </div>
      
      {/* SUPER CRITICAL DEBUG PANEL - ALWAYS VISIBLE - NEVER CAN BE HIDDEN */}
      <div className="super-debug-panel" style={{ 
        marginTop: '50px', /* Make space for the absolute warning */
        padding: '15px', 
        margin: '15px 0', 
        border: '4px solid red', 
        backgroundColor: '#ffeeee',
        display: 'block !important', 
        position: 'sticky',
        top: '50px', /* Position below the absolute warning */
        left: '0',
        right: '0', 
        zIndex: 99999,
        fontSize: '16px',
        boxShadow: '0 0 20px #ff0000',
        textAlign: 'left',
        color: 'black'
      }}>
        <h2 style={{ color: 'red', margin: '0 0 10px 0', fontWeight: 'bold', fontSize: '24px' }}>⚠️ EMERGENCY DEBUG INFO ⚠️</h2>
        <p style={{ margin: '5px 0', fontSize: '18px' }}><strong>Session ID:</strong> {sessionId || 'MISSING'}</p>
        <p style={{ margin: '5px 0', fontSize: '18px' }}><strong>Categories:</strong> {categories.length} (should be 1160)</p>
        <p style={{ margin: '5px 0', fontSize: '18px' }}><strong>Channels:</strong> {channels.length} of {totalChannels}</p>
        
        {/* Direct raw API fetch component */}
        <div style={{ 
          marginTop: '15px', 
          padding: '10px', 
          border: '2px solid blue', 
          backgroundColor: '#eeeeff' 
        }}>
          <h3 style={{ color: 'blue', margin: '0 0 10px 0' }}>Direct Category Test</h3>
          <button 
            style={{ 
              padding: '5px 10px', 
              backgroundColor: '#0066cc', 
              color: 'white',
              border: 'none',
              marginBottom: '10px',
              cursor: 'pointer'
            }}
            onClick={async () => {
              try {
                const sid = sessionId || getSessionId();
                if (!sid) {
                  alert('No session ID found');
                  return;
                }
                
                // Show pending state
                document.getElementById('directCategories').innerHTML = 'Fetching...';
                
                // Direct API call with fetch
                const response = await fetch(`/api/channels/${sid}/categories`);
                if (!response.ok) {
                  throw new Error(`API error: ${response.status}`);
                }
                
                // Get raw text for inspection
                const text = await response.text();
                console.log('Direct fetch raw response:', text.substring(0, 200));
                
                // Parse JSON
                const data = JSON.parse(text);
                console.log('Direct fetch parsed data:', data);
                
                // Format for display
                let html = `<div><strong>Raw data type:</strong> ${typeof data}</div>`;
                html += `<div><strong>Is array:</strong> ${Array.isArray(data)}</div>`;
                
                if (Array.isArray(data)) {
                  html += `<div><strong>Length:</strong> ${data.length}</div>`;
                  
                  if (data.length > 0) {
                    html += `<div><strong>First item type:</strong> ${typeof data[0]}</div>`;
                    html += `<div><strong>First item:</strong> ${JSON.stringify(data[0])}</div>`;
                    
                    // Display first 10 items
                    html += '<h4>First 10 categories:</h4>';
                    html += '<ul style="max-height: 150px; overflow: auto; background: white; padding: 10px;">';
                    
                    data.slice(0, 10).forEach((cat, i) => {
                      let displayText = '';
                      if (typeof cat === 'string') {
                        displayText = cat;
                      } else if (typeof cat === 'object') {
                        displayText = `${cat.name || 'Unknown'} (${cat.count || 0})`;
                      } else {
                        displayText = JSON.stringify(cat);
                      }
                      html += `<li>${displayText}</li>`;
                    });
                    
                    html += '</ul>';
                    
                    // Add select dropdown
                    html += '<h4>Category Dropdown Test:</h4>';
                    html += '<select style="width: 100%; padding: 5px;">';
                    html += '<option value="">-- All Categories --</option>';
                    
                    data.forEach((cat, i) => {
                      let name = '';
                      let count = '';
                      
                      if (typeof cat === 'string') {
                        name = cat;
                      } else if (typeof cat === 'object') {
                        name = cat.name || cat.title || cat.category || 'Unknown';
                        count = cat.count !== undefined ? ` (${cat.count})` : '';
                      }
                      
                      html += `<option value="${name}">${name}${count}</option>`;
                    });
                    
                    html += '</select>';
                    
                    // Update categories
                    html += '<div style="margin-top: 10px;">';
                    html += '<button id="updateCatsBtn" style="padding: 5px; background: green; color: white; border: none;">Update Categories</button>';
                    html += '</div>';
                    
                    document.getElementById('directCategories').innerHTML = html;
                    
                    // Add event listener to update button
                    setTimeout(() => {
                      const updateBtn = document.getElementById('updateCatsBtn');
                      if (updateBtn) {
                        updateBtn.addEventListener('click', () => {
                          // Process the data into the proper format
                          const formattedCategories = data.map(cat => {
                            if (typeof cat === 'string') {
                              return { name: cat, count: 0 };
                            } else if (typeof cat === 'object') {
                              return { 
                                name: cat.name || cat.title || cat.category || 'Unknown',
                                count: cat.count || 0
                              };
                            }
                            return { name: String(cat), count: 0 };
                          });
                          
                          // Update the categories state
                          setCategories(formattedCategories);
                          alert(`Updated categories state with ${formattedCategories.length} items`);
                        });
                      }
                    }, 100);
                  } else {
                    html += '<div style="color: red;">Empty array!</div>';
                  }
                } else {
                  html += '<div style="color: red;">Not an array!</div>';
                  html += `<div>Raw data: ${JSON.stringify(data)}</div>`;
                }
                
                document.getElementById('directCategories').innerHTML = html;
              } catch (error) {
                console.error('Direct fetch error:', error);
                document.getElementById('directCategories').innerHTML = 
                  `<div style="color: red;">Error: ${error.message}</div>`;
              }
            }}
          >
            Fetch Categories Directly
          </button>
          
          <div id="directCategories" style={{ 
            backgroundColor: 'white', 
            padding: '10px', 
            border: '1px solid #ccc',
            maxHeight: '300px',
            overflow: 'auto'
          }}>
            Click the button above to fetch categories directly from the API
          </div>
        </div>
        
        {categories.length > 0 ? (
          <div>
            <p style={{ margin: '5px 0', fontSize: '18px' }}><strong>Categories Sample:</strong></p>
            <ul style={{ maxHeight: '100px', overflow: 'auto', border: '1px solid #ddd', padding: '10px', backgroundColor: '#fff', marginTop: '5px', listStyleType: 'disc', listStylePosition: 'inside' }}>
              {categories.slice(0, 3).map((cat, idx) => (
                <li key={idx} style={{ margin: '5px 0', fontSize: '16px' }}>{cat.name} ({cat.count || '?'})</li>
              ))}
            </ul>
          </div>
        ) : (
          <p style={{ color: 'red', fontWeight: 'bold', fontSize: '20px', margin: '10px 0', backgroundColor: 'yellow', padding: '5px' }}>⚠️ NO CATEGORIES FOUND! ⚠️</p>
        )}
        
        <div style={{ marginTop: '15px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#4CAF50', 
              color: 'white',
              fontSize: '16px',
              fontWeight: 'bold',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer'
            }} 
            onClick={async () => {
              try {
                const direct = await fetchCategoriesDirect();
                if (direct && direct.length > 0) {
                  setCategories(direct);
                  alert(`Directly fetched ${direct.length} categories`);
                } else {
                  alert('Direct fetch failed or returned no categories');
                }
              } catch (err) {
                alert(`Error: ${err.message}`);
              }
            }}
          >
            EMERGENCY: Direct API Fetch
          </button>
          <button 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#f44336', 
              color: 'white',
              fontSize: '16px',
              fontWeight: 'bold',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer'
            }} 
            onClick={() => {
              if (channels && channels.length > 0) {
                console.log(`[DEBUG] Forcing generation of categories from ${channels.length} loaded channels`);
                const generatedCategories = generateCategoriesFromLoadedChannels(channels);
                if (generatedCategories.length > 0) {
                  console.log(`[SUCCESS] Generated ${generatedCategories.length} categories from loaded channels`);
                  setCategories(generatedCategories);
                  alert(`Generated ${generatedCategories.length} categories from ${channels.length} channels`);
                } else {
                  alert('Failed to generate categories');
                }
              } else {
                alert('No channels available to generate categories from');
              }
            }}
          >
            EMERGENCY: Generate Categories
          </button>
          <button 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#ff9800', 
              color: 'white',
              fontSize: '16px',
              fontWeight: 'bold',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer'
            }} 
            onClick={async () => {
              try {
                const sessionId = getSessionId();
                if (!sessionId) {
                  alert('No session ID available');
                  return;
                }
                
                // Directly use fetch with text parsing for debugging
                const response = await fetch(`/api/channels/${sessionId}/categories`);
                if (!response.ok) {
                  alert(`Error: ${response.status} ${response.statusText}`);
                  return;
                }
                
                // Get the raw text
                const text = await response.text();
                console.log('Raw response text:', text.substring(0, 500) + '...');
                
                let data;
                try {
                  // Manually parse JSON
                  data = JSON.parse(text);
                  console.log('Parsed data:', data);
                  
                  // Extract categories with special handling
                  let extractedCategories = [];
                  
                  if (Array.isArray(data)) {
                    extractedCategories = data;
                    console.log('Data is an array with', extractedCategories.length, 'items');
                  } else if (data.categories && Array.isArray(data.categories)) {
                    extractedCategories = data.categories;
                    console.log('Found categories array with', extractedCategories.length, 'items');
                  } else if (typeof data === 'object') {
                    console.log('Data is an object with keys:', Object.keys(data));
                    // Try to find an array property
                    for (const key of Object.keys(data)) {
                      if (Array.isArray(data[key]) && data[key].length > 0) {
                        if (data[key][0].name !== undefined && data[key][0].count !== undefined) {
                          extractedCategories = data[key];
                          console.log(`Found array in property "${key}" with ${extractedCategories.length} items`);
                          break;
                        }
                      }
                    }
                  }
                  
                  if (extractedCategories.length > 0) {
                    console.log('First extracted category:', extractedCategories[0]);
                    setCategories(extractedCategories);
                    alert(`Manually parsed ${extractedCategories.length} categories`);
                  } else {
                    alert('Could not find categories in the response');
                  }
                } catch (parseError) {
                  alert(`Parse error: ${parseError.message}`);
                  console.error('Parse error:', parseError);
                  console.log('Raw text that failed to parse:', text);
                }
              } catch (error) {
                alert(`Network error: ${error.message}`);
                console.error('Network error:', error);
              }
            }}
          >
            SUPER MANUAL PARSE
          </button>
        </div>
      </div>
      
      {/* IMPORTANT: Log the current render state to help diagnose issues */}
      {console.log('[CRITICAL DEBUG] ChannelList render:', {
        sessionId,
        categories: categories.length,
        channels: channels.length,
        categoriesEmpty: categories.length === 0,
        categoriesIsArray: Array.isArray(categories),
        categoriesSample: categories.slice(0, 1)
      })}
      
      {/* Critical warning if no categories are available */}
      {channels.length > 0 && categories.length === 0 && (
        <div style={{
          padding: '15px',
          margin: '10px 0',
          backgroundColor: '#ff000050',
          border: '2px solid red',
          color: 'black',
          fontWeight: 'bold',
          textAlign: 'center'
        }}>
          WARNING: Loaded {channels.length} channels but no categories were found! Use one of the debug buttons below to generate or fetch categories.
        </div>
      )}
      
      {console.log('[RENDER] ChannelList - Current state:', {
        categories: {
          count: categories.length,
          sample: categories.slice(0, 5),
          isArray: Array.isArray(categories)
        },
        channels: {
          count: channels.length,
          sample: channels.slice(0, 1).map(ch => ({ id: ch.id, name: ch.name, groupTitle: ch.groupTitle }))
        },
        sessionId,
        loading,
        totalChannels,
        filteredCategory
      })}
      
      {/* Debug Section - Categories Summary with forced display */}
      <div style={{ 
        padding: '10px', 
        margin: '10px 0', 
        border: '2px solid red', 
        backgroundColor: '#ffeeee',
        display: 'block', 
        position: 'relative', 
        zIndex: 1000 
      }}>
        <h3 style={{ marginTop: 0 }}>Categories Debug ({categories.length})</h3>
        
        {categories.length > 0 ? (
          <div>
            <p><strong>First 5 Categories:</strong></p>
            <ul style={{ maxHeight: '150px', overflow: 'auto' }}>
              {categories.slice(0, 5).map((cat, idx) => (
                <li key={idx}>{cat.name} ({cat.count || '?'})</li>
              ))}
            </ul>
          </div>
        ) : (
          <p style={{ color: 'red' }}>No categories found!</p>
        )}
        
        <div style={{ marginTop: '10px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button 
            style={{ padding: '5px 10px', backgroundColor: '#4CAF50', color: 'white' }} 
            onClick={() => alert('Categories: ' + JSON.stringify(categories.slice(0, 10)))}
          >
            Show Categories JSON
          </button>
          <button 
            style={{ padding: '5px 10px', backgroundColor: '#008CBA', color: 'white' }} 
            onClick={forceRefreshCategories}
          >
            Force Refresh Categories
          </button>
          <button 
            style={{ padding: '5px 10px', backgroundColor: '#f44336', color: 'white' }} 
            onClick={() => {
              if (channels && channels.length > 0) {
                console.log(`[DEBUG] Forcing generation of categories from ${channels.length} loaded channels`);
                const generatedCategories = generateCategoriesFromLoadedChannels(channels);
                if (generatedCategories.length > 0) {
                  console.log(`[SUCCESS] Generated ${generatedCategories.length} categories from loaded channels`);
                  setCategories(generatedCategories);
                  alert(`Generated ${generatedCategories.length} categories from ${channels.length} channels`);
                } else {
                  alert('Failed to generate categories');
                }
              } else {
                alert('No channels available to generate categories from');
              }
            }}
          >
            Generate From Loaded Channels
          </button>
          <button 
            style={{ padding: '5px 10px', backgroundColor: '#ff9800', color: 'white' }} 
            onClick={async () => {
              try {
                const sessionId = getSessionId();
                if (!sessionId) {
                  alert('No session ID available');
                  return;
                }
                
                // Directly use fetch with text parsing for debugging
                const response = await fetch(`/api/channels/${sessionId}/categories`);
                if (!response.ok) {
                  alert(`Error: ${response.status} ${response.statusText}`);
                  return;
                }
                
                // Get the raw text
                const text = await response.text();
                console.log('Raw response text:', text.substring(0, 500) + '...');
                
                let data;
                try {
                  // Manually parse JSON
                  data = JSON.parse(text);
                  console.log('Parsed data:', data);
                  
                  // Extract categories with special handling
                  let extractedCategories = [];
                  
                  if (Array.isArray(data)) {
                    extractedCategories = data;
                    console.log('Data is an array with', extractedCategories.length, 'items');
                  } else if (data.categories && Array.isArray(data.categories)) {
                    extractedCategories = data.categories;
                    console.log('Found categories array with', extractedCategories.length, 'items');
                  } else if (typeof data === 'object') {
                    console.log('Data is an object with keys:', Object.keys(data));
                    // Try to find an array property
                    for (const key of Object.keys(data)) {
                      if (Array.isArray(data[key]) && data[key].length > 0) {
                        if (data[key][0].name !== undefined && data[key][0].count !== undefined) {
                          extractedCategories = data[key];
                          console.log(`Found array in property "${key}" with ${extractedCategories.length} items`);
                          break;
                        }
                      }
                    }
                  }
                  
                  if (extractedCategories.length > 0) {
                    console.log('First extracted category:', extractedCategories[0]);
                    setCategories(extractedCategories);
                    alert(`Manually parsed ${extractedCategories.length} categories`);
                  } else {
                    alert('Could not find categories in the response');
                  }
                } catch (parseError) {
                  alert(`Parse error: ${parseError.message}`);
                  console.error('Parse error:', parseError);
                }
              } catch (error) {
                alert(`Network error: ${error.message}`);
                console.error('Network error:', error);
              }
            }}
          >
            SUPER MANUAL PARSE
          </button>
        </div>
      </div>

      {/* Regular filter section */}
      <div className="filter-section">
        <div className="channel-list-header">
          <h2>Channels ({loadedChannels} of {totalChannels || channels.length || loadedChannels})</h2>
          
          {/* Direct categories display with forced styles */}
          <div style={{
            margin: '10px 0', 
            padding: '10px', 
            border: '2px solid #ccc',
            borderRadius: '5px',
            backgroundColor: '#f8f8f8'
          }}>
            <h3 style={{ margin: '0 0 10px 0' }}>Categories ({categories.length})</h3>
            
            {categories.length > 0 ? (
              <div>
                <select 
                  style={{
                    width: '100%',
                    padding: '8px',
                    fontSize: '14px',
                    border: '1px solid #aaa',
                    borderRadius: '4px'
                  }}
                  value={selectedCategory || ''}
                  onChange={(e) => handleCategoryChange(e.target.value || null)}
                >
                  <option value="">All Categories ({totalChannels || channels.length})</option>
                  {categories.map((category) => (
                    <option key={category.name} value={category.name}>
                      {category.name} ({category.count})
                    </option>
                  ))}
                </select>
                
                <div style={{ marginTop: '10px', fontSize: '13px' }}>
                  First 5 categories: 
                  {categories.slice(0, 5).map((cat, i) => (
                    <span key={i} style={{ 
                      display: 'inline-block', 
                      margin: '2px 5px', 
                      padding: '2px 6px', 
                      backgroundColor: '#e0e0e0', 
                      borderRadius: '3px' 
                    }}>
                      {cat.name} ({cat.count})
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ color: 'red' }}>
                No categories available. 
                <button 
                  onClick={forceRefreshCategories}
                  style={{ 
                    marginLeft: '10px', 
                    padding: '5px 10px',
                    backgroundColor: '#f44336',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer'
                  }}
                >
                  Generate Categories
                </button>
              </div>
            )}
            
            {/* Emergency direct fetch button */}
            <button 
              onClick={async () => {
                try {
                  const direct = await fetchCategoriesDirect();
                  if (direct && direct.length > 0) {
                    setCategories(direct);
                    alert(`Successfully fetched ${direct.length} categories!`);
                  } else {
                    alert('Failed to fetch categories directly');
                  }
                } catch (err) {
                  alert(`Error: ${err.message}`);
                }
              }}
              style={{ 
                marginTop: '10px', 
                padding: '5px 10px',
                backgroundColor: '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '3px',
                cursor: 'pointer'
              }}
            >
              Force Fetch Categories
            </button>
          </div>
          
          {/* Emergency direct fetch button */}
          <button 
            onClick={async () => {
              try {
                const direct = await fetchCategoriesDirect();
                if (direct && direct.length > 0) {
                  setCategories(direct);
                  console.log('[DEBUG] Manual direct fetch successful:', direct.length, 'categories');
                } else {
                  console.error('[ERROR] Manual direct fetch failed');
                }
              } catch (err) {
                alert(`Error: ${err.message}`);
              }
            }}
            style={{ 
              marginTop: '10px', 
              padding: '5px 10px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer'
            }}
          >
            Force Fetch Categories
          </button>
        </div>
        
        {categories.length > 0 && (
          <div className="categories-filter">
            <label htmlFor="category-select">Filter by category: </label>
            <select 
              id="category-select"
              value={selectedCategory || ''}
              onChange={(e) => handleCategoryChange(e.target.value || null)}
              className="category-select"
            >
              <option value="">All Categories ({totalChannels || channels.length})</option>
              {categories.map((category) => (
                <option key={category.name} value={category.name}>
                  {category.name} ({category.count})
                </option>
              ))}
            </select>
            <span className="categories-count">({categories.length} categories)</span>
          </div>
        )}
        
        {/* Debug panel */}
        <div className="debug-panel" style={{ fontSize: '0.8rem', marginTop: '10px', padding: '5px', background: '#f5f5f5', border: '1px solid #ddd' }}>
          <details>
            <summary style={{ fontWeight: 'bold', cursor: 'pointer' }}>Debug Information</summary>
            <div><strong>Session ID:</strong> {sessionId}</div>
            <div><strong>Total Channels:</strong> {totalChannels}</div>
            <div><strong>Loaded Channels:</strong> {loadedChannels}</div>
            <div><strong>Categories Count:</strong> {categories.length}</div>
            <div><strong>Loading State:</strong> {loading ? 'Loading' : 'Completed'}</div>
            <div><strong>Progressive Loading:</strong> {isProgressiveLoading ? 'Active' : 'Inactive'}</div>
            
            <div style={{ marginTop: '5px' }}>
              <strong>Categories Sample:</strong>
              {categories.length > 0 ? (
                <ul style={{ margin: '5px 0', paddingLeft: '20px', fontSize: '0.7rem' }}>
                  {categories.slice(0, 5).map((cat, idx) => (
                    <li key={idx}>{cat.name}: {cat.count}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ color: 'red', margin: '5px 0' }}>No categories available!</p>
              )}
            </div>
            
            <div style={{ marginTop: '5px' }}>
              <strong>Categories Structure Check:</strong>
              <ul style={{ margin: '5px 0', paddingLeft: '20px', fontSize: '0.7rem' }}>
                <li>Categories is array: {Array.isArray(categories) ? 'Yes ✓' : 'No ✗'}</li>
                <li>First category has 'name': {categories[0]?.name ? `Yes (${categories[0].name}) ✓` : 'No ✗'}</li>
                <li>First category has 'count': {categories[0]?.count ? `Yes (${categories[0].count}) ✓` : 'No ✗'}</li>
                <li>Sample category: {categories[0] ? JSON.stringify(categories[0]) : 'None'}</li>
              </ul>
            </div>
            
            <div style={{ marginTop: '5px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
              <button 
                onClick={() => forceRefreshCategories()}
                style={{ padding: '3px', fontSize: '0.8rem' }}
              >
                Refresh Categories
              </button>
              
              <button
                onClick={async () => {
                  const direct = await fetchCategoriesDirect();
                  if (direct && direct.length > 0) {
                    setCategories(direct);
                    console.log('[DEBUG] Manual direct fetch successful:', direct.length, 'categories');
                  } else {
                    console.error('[ERROR] Manual direct fetch failed');
                  }
                }}
                style={{ padding: '3px', fontSize: '0.8rem' }}
              >
                Direct API Fetch
              </button>
              
              <button
                onClick={() => {
                  console.log('[DEBUG] Manual generation of categories from', channels.length, 'channels');
                  if (channels && channels.length > 0) {
                    const categoryCounts = channels.reduce((acc, ch) => {
                      const groupTitle = ch.groupTitle || 'Uncategorized';
                      acc[groupTitle] = (acc[groupTitle] || 0) + 1;
                      return acc;
                    }, {});
                    
                    const generatedCategories = Object.entries(categoryCounts)
                      .map(([name, count]) => ({ name, count }))
                      .sort((a, b) => a.name.localeCompare(b.name));
                    
                    if (generatedCategories.length > 0) {
                      console.log('[SUCCESS] Manual generation succeeded:', generatedCategories.length, 'categories');
                      setCategories(generatedCategories);
                    }
                  }
                }}
                style={{ padding: '3px', fontSize: '0.8rem' }}
              >
                Force Generate
              </button>
              
              <button
                onClick={() => loadChannelsProgressively()}
                style={{ padding: '3px', fontSize: '0.8rem' }}
              >
                Reload Channels
              </button>
              
              <button
                onClick={() => {
                  console.log('[DEBUG] Current categories:', categories);
                  console.log('[DEBUG] Channels with group titles:',
                    channels.slice(0, 10).map(ch => ({id: ch.tvgId, name: ch.name, group: ch.groupTitle}))
                  );
                  console.log('[DEBUG] Unique group titles:', 
                    [...new Set(channels.map(ch => ch.groupTitle || 'Uncategorized'))].slice(0, 20)
                  );
                  alert(`Categories debug info logged to console. Check for ${categories.length} categories and ${channels.length} channels`);
                }}
                style={{ padding: '3px', fontSize: '0.8rem', backgroundColor: '#ffe0e0' }}
              >
                Log Debug Info
              </button>
            </div>
          </details>
        </div>
        
        {isProgressiveLoading && loadingProgress < 100 && (
          <div className="loading-progress inline">
            <div className="progress-bar">
              <div 
                className="progress-bar-fill" 
                style={{ width: `${loadingProgress}%` }}
              ></div>
            </div>
            <span className="progress-text">Loading: {loadingProgress}%</span>
          </div>
        )}
      </div>
      
      <div className="channels-grid">
        {channels.map((channel) => (
          <div key={channel.tvgId || channel.id} className="channel-item">
            <div className="channel-icon">
              {channel.logo ? (
                <img src={channel.logo} alt={channel.name} />
              ) : (
                <div className="placeholder-icon">{channel.name.charAt(0)}</div>
              )}
            </div>
            <div className="channel-details">
              <div className="channel-name">{channel.name}</div>
              <div className="channel-group">{channel.groupTitle}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ChannelList;