// App.js - Enhanced version with modern UI and modular components
import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Import modular components
import Sidebar from './Sidebar';
import StatusDisplay from './StatusDisplay';
import Configuration from './Configuration';
import CategoryManager from './CategoryManager';
import ChannelList from './ChannelList';
import PlayerView from './PlayerView';
import ResultView from './ResultView';

/**
 * Main application component with modernized UI and modular architecture
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

  // Save matched channels to local storage
  const saveMatchedChannels = (matches) => {
    localStorage.setItem('matchedChannels', JSON.stringify(matches));
  };

  // Handle loading channels from server or file
  const handleLoad = async (formData, force = false) => {
    setIsLoading(true);
    setLoadingError(null);
    setStatus('Loading channels...');
    setStatusType('info');
    
    try {
      const response = await axios.post('http://localhost:5001/api/load', formData);
      setSessionId(response.data.sessionId);
      setChannels(response.data.channels || []);
      setTotalChannels(response.data.totalChannels || 0);
      setCategories(response.data.categories || []);
      setEpgSources(response.data.epgSources || []);
      setStatus(response.data.message || 'Channels loaded successfully');
      setStatusType('success');
      
      // Switch to channels tab
      setActiveTab('channels');
    } catch (error) {
      const errorMessage = error.response?.data?.error || error.message;
      setLoadingError(`Error: ${errorMessage}`);
      setStatus(`Failed to load channels: ${errorMessage}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
    }
  };

  // Load more channels (pagination)
  const loadMoreChannels = async (category = selectedCategory) => {
    if (!sessionId || isLoading) return;
    setIsLoading(true);
    setStatus('Loading more channels...');
    setStatusType('info');
    
    try {
      // Calculate the current page based on loaded channels and pageSize
      const pageSize = 1000;
      const currentPage = Math.floor(channels.length / pageSize) + 1;
      
      const response = await axios.get(`http://localhost:5001/api/channels/${sessionId}?page=${currentPage}&limit=${pageSize}${category ? `&category=${encodeURIComponent(category)}` : ''}`);
      setChannels(prev => [...prev, ...response.data.channels]);
      setStatus(`Loaded ${channels.length + response.data.channels.length} of ${response.data.totalChannels} channels`);
      setStatusType('success');
    } catch (error) {
      setStatus(`Error loading more channels: ${error.message}`);
      setStatusType('error');
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
        const response = await axios.get(`http://localhost:5001/api/channels/${sessionId}?page=1&limit=1000`);
        setChannels(response.data.channels);
        setTotalChannels(response.data.totalChannels);
        setStatus(`Loaded ${response.data.channels.length} of ${response.data.totalChannels} channels`);
        setStatusType('success');
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
      const response = await axios.get(`http://localhost:5001/api/channels/${sessionId}?page=1&limit=1000&category=${encodeURIComponent(category)}`);
      setChannels(response.data.channels);
      setTotalChannels(response.data.totalChannels);
      setStatus(`Loaded ${response.data.channels.length} of ${response.data.totalChannels} channels in ${category}`);
      setStatusType('success');
    } catch (error) {
      setStatus(`Error loading channels for ${category}: ${error.message}`);
      setStatusType('error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle EPG matching
  const handleEpgMatch = (channelId, epgId) => {
    const updatedMatches = {
      ...matchedChannels,
      [channelId]: epgId
    };
    setMatchedChannels(updatedMatches);
    saveMatchedChannels(updatedMatches);
    setStatus(`Matched channel ${channelId} with EPG ID ${epgId}`);
    setStatusType('success');
    
    // Update the matched channels in the session
    if (sessionId) {
      try {
        // Send the match to the server to update the session
        axios.post(`http://localhost:5001/api/epg/${sessionId}/match`, {
          channelId: channelId,
          epgId: epgId
        }).catch(error => {
          console.error('Failed to update matched channels in session', error);
        });
      } catch (error) {
        console.error('Error updating matched channels in session', error);
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
      const response = await axios.post('http://localhost:5001/api/generate', { 
        sessionId, 
        matchedChannels 
      });
      setResult(response.data);
      setStatus('Generated new XTREAM credentials!');
      setStatusType('success');
      
      // Switch to result tab
      setActiveTab('result');
    } catch (error) {
      setStatus(`Error: ${error.response?.data || error.message}`);
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
      case 'channels':
        return (
          <div style={{ padding: '20px' }}>
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
                <CategoryManager 
                  categories={categories}
                  onCategorySelect={handleCategorySelect}
                  onVisibilityChange={handleCategoryVisibilityChange}
                  hiddenCategories={hiddenCategories}
                  selectedCategory={selectedCategory}
                  sessionId={sessionId}
                />
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
      case 'configure':
      default:
        return (
          <Configuration 
            onLoad={handleLoad}
            isLoading={isLoading}
            error={loadingError}
          />
        );
    }
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
          {/* Will be used for user actions in future */}
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
    </div>
  );
}

export default App;