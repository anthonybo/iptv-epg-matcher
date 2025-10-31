import React, { useState, useEffect } from 'react';
import SessionManager from './utils/sessionManager';
import EpgRefreshModal from './components/EpgRefreshModal';

/**
 * Component to directly load and display EPG sources
 * This component handles its own state and API calls
 */
const DirectEpgSourcesLoader = ({ hideSourceList = false }) => {
  const [epgSources, setEpgSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creatingTest, setCreatingTest] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const sessionId = SessionManager.getSessionId();
  
  // Function to create a test EPG source
  const createTestEpgSource = async () => {
    if (!sessionId) {
      setError('No session ID available');
      return;
    }
    
    setCreatingTest(true);
    try {
      console.log('[DIRECT EPG] Creating test EPG source for session:', sessionId);
      
      // First attempt to create an EPG session if it doesn't exist
      const initResponse = await fetch('/api/epg/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId })
      });
      
      if (!initResponse.ok) {
        console.warn('[DIRECT EPG] Failed to initialize EPG session:', initResponse.status);
      } else {
        console.log('[DIRECT EPG] Successfully initialized EPG session');
      }
      
      // Now add a test source
      const sourceResponse = await fetch(`/api/epg/${sessionId}/sources`, {
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
      
      if (!sourceResponse.ok) {
        throw new Error(`Failed to create test EPG source: ${sourceResponse.status} ${sourceResponse.statusText}`);
      }
      
      // Reload sources after creating test source
      await reloadEpgSources();
      
    } catch (error) {
      console.error('[DIRECT EPG] Error creating test source:', error);
      setError(`Error creating test source: ${error.message}`);
    } finally {
      setCreatingTest(false);
    }
  };

  // Function to reload EPG sources from the database (just refreshes the UI)
  const reloadEpgSources = async () => {
    setLoading(true);
    setError(null);

    if (!sessionId) {
      setError('No session ID available');
      setLoading(false);
      return;
    }

    try {
      console.log('[DIRECT EPG] Manually reloading EPG sources for session:', sessionId);
      const response = await fetch(`/api/epg/${sessionId}/sources?_t=${Date.now()}`);

      if (!response.ok) {
        setError(`API error: ${response.status} ${response.statusText}`);
        setLoading(false);
        return;
      }

      const text = await response.text();
      console.log('[DIRECT EPG] Raw response:', text.substring(0, 100) + '...');

      try {
        const data = JSON.parse(text);
        console.log('[DIRECT EPG] Parsed response:', data);

        // Check if this is a new session message
        if (data.message === 'New session created, please create sources') {
          console.log('[DIRECT EPG] Server created a new session, creating test source');
          await createTestEpgSource();
          return;
        }

        if (data && data.sources) {
          console.log(`[DIRECT EPG] ✅ Found ${data.sources.length} EPG sources`);
          setEpgSources(data.sources);

          // Send event to notify app of EPG sources update
          const event = new CustomEvent('epgSourcesUpdated', { detail: data.sources });
          window.dispatchEvent(event);

          // If no sources exist, auto-create one
          if (data.sources.length === 0) {
            console.log('[DIRECT EPG] No sources found, auto-creating a test source');
            await createTestEpgSource();
          }
        } else {
          console.warn('[DIRECT EPG] Response does not contain sources array:', data);
          setEpgSources([]);
        }
      } catch (parseError) {
        console.error('[DIRECT EPG] JSON parse error:', parseError);
        setError(`JSON parse error: ${parseError.message}`);
      }
    } catch (fetchError) {
      console.error('[DIRECT EPG] Fetch error:', fetchError);
      setError(`Fetch error: ${fetchError.message}`);
    } finally {
      setLoading(false);
    }
  };

  // New function to refresh EPG data from remote sources
  const [refreshing, setRefreshing] = useState(false);
  const [showRefreshModal, setShowRefreshModal] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({
    status: 'starting',
    sources: [],
    currentSource: 0,
    totalSources: 0,
    error: null
  });

  const refreshEpgData = async () => {
    setRefreshing(true);
    setShowRefreshModal(true);
    setError(null);

    // Initialize progress with current sources as pending
    const initialSources = epgSources.map(source => ({
      id: source.id,
      name: source.name || 'Unknown',
      url: source.url,
      status: 'pending',
      channels: null,
      programs: null,
      error: null
    }));

    setRefreshProgress({
      status: 'starting',
      sources: initialSources,
      currentSource: 0,
      totalSources: initialSources.length,
      error: null
    });

    try {
      console.log('[DIRECT EPG] Triggering EPG data refresh from remote sources');

      // Call the EPG parse endpoint to download fresh data
      const response = await fetch('/api/epg/parse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ force: true })
      });

      if (!response.ok) {
        throw new Error(`Failed to trigger EPG refresh: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      console.log('[DIRECT EPG] Refresh triggered:', result);

      // Update status to refreshing
      setRefreshProgress(prev => ({
        ...prev,
        status: 'refreshing'
      }));

      // Poll for updates every 10 seconds for up to 5 minutes
      let pollCount = 0;
      const maxPolls = 30; // 5 minutes
      const pollInterval = setInterval(async () => {
        pollCount++;

        try {
          // Update status to polling
          setRefreshProgress(prev => ({
            ...prev,
            status: 'polling'
          }));

          await reloadEpgSources();

          // Check if timestamps have been updated (stop polling if so)
          if (epgSources.length > 0) {
            const latestUpdate = new Date(epgSources[0].last_updated || epgSources[0].lastUpdated);
            const now = new Date();
            const diffMinutes = (now - latestUpdate) / (1000 * 60);

            // If any source was updated in the last 2 minutes, consider refresh complete
            if (diffMinutes < 2) {
              console.log('[DIRECT EPG] EPG sources have been updated');
              clearInterval(pollInterval);

              // Update all sources to complete
              const updatedSources = epgSources.map(source => ({
                id: source.id,
                name: source.name || 'Unknown',
                url: source.url,
                status: 'complete',
                channels: source.channel_count || source.channelCount,
                programs: source.program_count || source.programCount,
                error: null
              }));

              setRefreshProgress({
                status: 'complete',
                sources: updatedSources,
                currentSource: updatedSources.length,
                totalSources: updatedSources.length,
                error: null
              });

              setRefreshing(false);
            }
          }

          // Stop polling after max attempts
          if (pollCount >= maxPolls) {
            clearInterval(pollInterval);
            setRefreshProgress(prev => ({
              ...prev,
              status: 'complete',
              error: 'Refresh timed out. Sources may still be updating in the background.'
            }));
            setRefreshing(false);
            console.log('[DIRECT EPG] Stopped polling for updates');
          }
        } catch (err) {
          console.error('[DIRECT EPG] Error polling for updates:', err);
        }
      }, 10000);

    } catch (error) {
      console.error('[DIRECT EPG] Error refreshing EPG data:', error);
      setError(`Error refreshing EPG data: ${error.message}`);
      setRefreshProgress(prev => ({
        ...prev,
        status: 'complete',
        error: `Failed to refresh EPG data: ${error.message}`
      }));
      setRefreshing(false);
    }
  };

  const closeRefreshModal = () => {
    setShowRefreshModal(false);
    setRefreshProgress({
      status: 'starting',
      sources: [],
      currentSource: 0,
      totalSources: 0,
      error: null
    });
  };
  
  // New function to force-load EPG data from sources
  const forceLoadEpgData = async () => {
    setLoadingData(true);
    setError(null);
    
    if (!sessionId) {
      setError('No session ID available');
      setLoadingData(false);
      return;
    }
    
    try {
      console.log('[DIRECT EPG] Force loading EPG channel data from sources for session:', sessionId);
      // First, make sure we have an EPG session
      const initResponse = await fetch('/api/epg/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId })
      });
      
      if (!initResponse.ok) {
        throw new Error(`Failed to initialize EPG session: ${initResponse.status} ${initResponse.statusText}`);
      }
      
      // Now, request the server to load channel data from all sources
      const loadResponse = await fetch(`/api/epg/${sessionId}/load-data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          loadAll: true,
          maxSources: 2  // Limit to 2 sources to prevent overwhelming the server
        })
      });
      
      if (!loadResponse.ok) {
        throw new Error(`Failed to load EPG data: ${loadResponse.status} ${loadResponse.statusText}`);
      }
      
      const loadResult = await loadResponse.json();
      console.log('[DIRECT EPG] Load result:', loadResult);
      
      // Display success message
      if (loadResult.sourcesLoaded > 0) {
        alert(`Successfully loaded channel data from ${loadResult.sourcesLoaded} EPG sources! Found ${loadResult.totalChannels} channels.`);
      } else {
        alert('No EPG sources were loaded. This may be due to network issues or the sources may be temporarily unavailable.');
      }
      
      // Reload the sources to get updated counts
      await reloadEpgSources();
      
    } catch (error) {
      console.error('[DIRECT EPG] Error loading EPG data:', error);
      setError(`Error loading EPG data: ${error.message}`);
      alert(`Failed to load EPG data: ${error.message}. The backend may be missing required dependencies.`);
    } finally {
      setLoadingData(false);
    }
  };
  
  // Load EPG sources when component mounts
  useEffect(() => {
    const loadEpgSources = async () => {
      if (!sessionId) {
        setError('No session ID available');
        setLoading(false);
        return;
      }
      
      try {
        console.log('[DIRECT EPG] Loading EPG sources for session:', sessionId);
        const response = await fetch(`/api/epg/${sessionId}/sources`);
        
        if (!response.ok) {
          setError(`API error: ${response.status} ${response.statusText}`);
          setLoading(false);
          return;
        }
        
        const text = await response.text();
        console.log('[DIRECT EPG] Raw response:', text.substring(0, 100) + '...');
        
        try {
          const data = JSON.parse(text);
          console.log('[DIRECT EPG] Parsed response:', data);
          
          if (data && data.sources) {
            console.log(`[DIRECT EPG] ✅ Found ${data.sources.length} EPG sources`);
            setEpgSources(data.sources);
            
            // Send event to notify app of EPG sources update
            const event = new CustomEvent('epgSourcesUpdated', { detail: data.sources });
            window.dispatchEvent(event);
          } else {
            console.warn('[DIRECT EPG] Response does not contain sources array:', data);
            setEpgSources([]);
          }
        } catch (parseError) {
          console.error('[DIRECT EPG] JSON parse error:', parseError);
          setError(`JSON parse error: ${parseError.message}`);
        }
      } catch (fetchError) {
        console.error('[DIRECT EPG] Fetch error:', fetchError);
        setError(`Fetch error: ${fetchError.message}`);
      } finally {
        setLoading(false);
      }
    };
    
    // Load once on mount
    loadEpgSources();
    
    // No polling interval - removed to prevent excessive refreshes
    
    // No cleanup needed since we don't set up an interval
  }, [sessionId]);
  
  if (loading) {
    return (
      <div style={{ 
        padding: '15px',
        textAlign: 'center',
        border: '1px solid #e0e0e0',
        borderRadius: '4px',
        backgroundColor: '#fafafa',
        margin: '10px 0'
      }}>
        <div style={{ margin: '10px 0' }}>
          <span style={{
            display: 'inline-block',
            width: '18px',
            height: '18px',
            border: '3px solid #f3f3f3',
            borderTop: '3px solid #3498db',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginRight: '10px'
          }}></span>
          Loading EPG sources...
        </div>
      </div>
    );
  }
  
  // Create header with refresh button
  const header = (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'space-between', 
      alignItems: 'center',
      marginBottom: '10px'
    }}>
      <h3 style={{ 
        margin: 0, 
        fontSize: '16px', 
        color: error ? '#d32f2f' : epgSources.length === 0 ? '#f57f17' : '#2e7d32',
        fontWeight: '500'
      }}>
        📊 EPG Sources ({epgSources.length})
      </h3>
      
      <div style={{ display: 'flex', gap: '5px' }}>
        <button
          onClick={refreshEpgData}
          disabled={refreshing}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            backgroundColor: refreshing ? '#f5f5f5' : '#e8f5e9',
            color: refreshing ? '#666' : '#2e7d32',
            border: refreshing ? '1px solid #ddd' : '1px solid #c8e6c9',
            borderRadius: '4px',
            cursor: refreshing ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            opacity: refreshing ? 0.7 : 1
          }}
          title="Download fresh EPG data from remote sources"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
            <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
        
        <button 
          onClick={forceLoadEpgData} 
          disabled={loadingData}
          style={{ 
            padding: '4px 8px', 
            fontSize: '12px',
            backgroundColor: '#e3f2fd',
            color: '#1565c0',
            border: '1px solid #bbdefb',
            borderRadius: '4px',
            cursor: loadingData ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {loadingData && (
            <span style={{
              position: 'absolute',
              top: 0,
              left: 0,
              height: '100%',
              width: '100%',
              backgroundColor: 'rgba(0,0,0,0.05)'
            }}></span>
          )}
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          {loadingData ? 'Loading...' : 'Load EPG Data'}
        </button>
        
        <button 
          onClick={createTestEpgSource}
          disabled={creatingTest}
          style={{ 
            padding: '4px 8px', 
            fontSize: '12px',
            backgroundColor: '#bbdefb',
            color: '#1565c0',
            border: '1px solid #90caf9',
            borderRadius: '4px',
            cursor: creatingTest ? 'wait' : 'pointer',
            opacity: creatingTest ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}
        >
          {creatingTest ? 'Creating...' : 'Create Test Source'}
        </button>
      </div>
    </div>
  );
  
  if (error) {
    return (
      <div style={{ 
        border: '1px solid #ffcdd2', 
        borderRadius: '4px', 
        padding: '10px',
        margin: '10px 0',
        backgroundColor: '#ffebee'
      }}>
        {header}
        <div style={{ color: '#d32f2f', marginBottom: '10px' }}>EPG Error: {error}</div>
        
        <button 
          onClick={createTestEpgSource}
          disabled={creatingTest}
          style={{ 
            padding: '8px 16px', 
            backgroundColor: '#2196f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: creatingTest ? 'wait' : 'pointer',
            opacity: creatingTest ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            marginTop: '10px'
          }}
        >
          {creatingTest ? 'Creating Test EPG Source...' : 'Create Test EPG Source'}
        </button>
      </div>
    );
  }
  
  if (epgSources.length === 0) {
    return (
      <div style={{ 
        border: '1px solid #fff9c4', 
        borderRadius: '4px', 
        padding: '10px',
        margin: '10px 0',
        backgroundColor: '#fffde7'
      }}>
        {header}
        <div style={{ color: '#f57f17', marginBottom: '10px' }}>No EPG sources found. EPG features will be limited.</div>
        
        <button 
          onClick={createTestEpgSource}
          disabled={creatingTest}
          style={{ 
            padding: '8px 16px', 
            backgroundColor: '#2196f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: creatingTest ? 'wait' : 'pointer',
            opacity: creatingTest ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            marginTop: '10px'
          }}
        >
          {creatingTest ? 'Creating Test EPG Source...' : 'Create Test EPG Source'}
        </button>
      </div>
    );
  }
  
  return (
    <>
      <EpgRefreshModal
        isOpen={showRefreshModal}
        onClose={closeRefreshModal}
        progress={refreshProgress}
      />
      <div style={{
        border: '1px solid #c8e6c9',
        borderRadius: '4px',
        padding: '10px',
        margin: '10px 0',
        backgroundColor: '#e8f5e9'
      }}>
        {header}
        {hideSourceList ? (
          <div style={{ fontSize: '13px', color: '#4b5563', marginTop: '8px' }}>
            Manage your EPG sources with the actions above. Use the summary panel to review current sources.
          </div>
        ) : (
          <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
            {epgSources.map((source, index) => (
              <div key={index} style={{
                padding: '6px 10px',
                backgroundColor: 'white',
                borderRadius: '4px',
                marginBottom: '5px',
                border: '1px solid #e0e0e0',
                fontSize: '14px'
              }}>
                <strong>{source.name || 'Unnamed Source'}</strong>
                {source.url && (
                  <div style={{
                    fontSize: '12px',
                    color: '#666',
                    marginTop: '4px',
                    wordBreak: 'break-all'
                  }}>
                    {source.url}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

export default DirectEpgSourcesLoader; 
