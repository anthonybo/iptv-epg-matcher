// App.js - Enhanced version with modern UI
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import Dropzone from 'react-dropzone';
import EPGMatcher from './EPGMatcher'; // Use the enhanced version
import IPTVPlayer from './IPTVPlayer'; // Use the enhanced version

/**
 * Main application component with modernized UI
 * 
 * @returns {JSX.Element} App component
 */
function App() {
  // State for input files and URLs
  const [m3uFile, setM3uFile] = useState(null);
  const [epgFile, setEpgFile] = useState(null);
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  
  // Xtream credentials
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');
  
  // App state
  const [status, setStatus] = useState('');
  const [channels, setChannels] = useState([]);
  const [totalChannels, setTotalChannels] = useState(0);
  const [categories, setCategories] = useState([]);
  const [hiddenCategories, setHiddenCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [epgSources, setEpgSources] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [matchedChannels, setMatchedChannels] = useState({});
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [loadingError, setLoadingError] = useState(null);
  const [playerType, setPlayerType] = useState('iptv'); // Default to IPTV player
  const [activeTab, setActiveTab] = useState('configure'); // 'configure', 'channels', 'player', or 'result'
  const [showSidebar, setShowSidebar] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusType, setStatusType] = useState('info'); // 'info', 'success', 'error', 'warning'
  
  // Load saved XTREAM credentials on mount
  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem('xtreamCredentials') || '{}');
    setXtreamServer(saved.server || '');
    setXtreamUsername(saved.username || '');
    setXtreamPassword(saved.password || '');
    
    // Also load any previously matched channels
    const savedMatches = JSON.parse(localStorage.getItem('matchedChannels') || '{}');
    setMatchedChannels(savedMatches);
  }, []);

  // Update active tab based on app state
  useEffect(() => {
    if (channels.length === 0) {
      setActiveTab('configure');
    } else if (result) {
      setActiveTab('result');
    }
  }, [channels, result]);

  // Save credentials to local storage
  const saveCredentials = () => {
    localStorage.setItem('xtreamCredentials', JSON.stringify({
      server: xtreamServer,
      username: xtreamUsername,
      password: xtreamPassword,
    }));
  };
  
  // Save matched channels to local storage
  const saveMatchedChannels = (matches) => {
    localStorage.setItem('matchedChannels', JSON.stringify(matches));
  };

  // Handle loading channels from server or file
  const handleLoad = async (force = false) => {
    setIsLoading(true);
    setLoadingError(null);
    setStatus('Loading channels...');
    setStatusType('info');
    
    // Validate inputs
    if (!m3uFile && !m3uUrl && (!xtreamUsername || !xtreamPassword || !xtreamServer)) {
      setLoadingError('Please provide either an M3U file, M3U URL, or complete Xtream credentials');
      setIsLoading(false);
      setStatusType('error');
      return;
    }
    
    const formData = new FormData();
    if (m3uFile) formData.append('m3u', m3uFile);
    if (epgFile) formData.append('epg', epgFile);
    formData.append('m3uUrl', m3uUrl);
    formData.append('epgUrl', epgUrl);
    formData.append('xtreamUsername', xtreamUsername);
    formData.append('xtreamPassword', xtreamPassword);
    formData.append('xtreamServer', xtreamServer);
    if (force) formData.append('forceUpdate', 'true');

    try {
      const response = await axios.post('http://localhost:5001/api/load', formData);
      setSessionId(response.data.sessionId);
      setChannels(response.data.channels || []);
      setTotalChannels(response.data.totalChannels || 0);
      setCategories(response.data.categories || []);
      setEpgSources(response.data.epgSources || []);
      setStatus(response.data.message || 'Channels loaded successfully');
      setStatusType('success');
      setPage(1);
      saveCredentials();
      
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
      const response = await axios.get(`http://localhost:5001/api/channels/${sessionId}?page=${page + 1}&limit=1000${category ? `&category=${encodeURIComponent(category)}` : ''}`);
      setChannels(prev => [...prev, ...response.data.channels]);
      setPage(response.data.page);
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

  // Toggle category visibility
  const toggleCategory = (category) => {
    setHiddenCategories(prev => 
      prev.includes(category) ? prev.filter(c => c !== category) : [...prev, category]
    );
  };

  // Hide all categories
  const unselectAllCategories = () => {
    setHiddenCategories(categories.map(cat => cat.name));
  };

  // Select a specific category to view
  const selectCategory = async (category) => {
    setSelectedCategory(category);
    setPage(1);
    setChannels([]);
    setStatus(`Loading channels for category: ${category}...`);
    setStatusType('info');
    setIsLoading(true);
    
    try {
      const response = await axios.get(`http://localhost:5001/api/channels/${sessionId}?page=1&limit=1000&category=${encodeURIComponent(category)}`);
      setChannels(response.data.channels);
      setTotalChannels(response.data.totalChannels);
      setPage(response.data.page);
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
  };

  // Filter channels based on search and category visibility
  const filteredChannels = channels.filter(ch => 
    ch.name.toLowerCase().includes(search.toLowerCase()) && 
    !hiddenCategories.includes(ch.groupTitle)
  );

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
    setM3uFile(null);
    setEpgFile(null);
    setM3uUrl('');
    setEpgUrl('');
    setChannels([]);
    setTotalChannels(0);
    setCategories([]);
    setHiddenCategories([]);
    setSelectedCategory(null);
    setEpgSources([]);
    setSessionId(null);
    setSearch('');
    setSelectedChannel(null);
    setResult(null);
    setPage(1);
    setLoadingError(null);
    setActiveTab('configure');
    setStatus('Application reset. Ready to load new channels.');
    setStatusType('info');
  };

  // Toggle sidebar visibility
  const toggleSidebar = () => {
    setShowSidebar(prev => !prev);
  };

  // Format status message
  const getStatusStyle = () => {
    const baseStyle = {
      padding: '12px 15px',
      borderRadius: '8px',
      animation: 'fadeIn 0.3s ease',
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    };
    
    switch (statusType) {
      case 'success':
        return {
          ...baseStyle,
          backgroundColor: '#e8f5e9',
          border: '1px solid #c8e6c9',
          color: '#2e7d32'
        };
      case 'error':
        return {
          ...baseStyle,
          backgroundColor: '#ffebee',
          border: '1px solid #ffcdd2',
          color: '#c62828'
        };
      case 'warning':
        return {
          ...baseStyle,
          backgroundColor: '#fff8e1',
          border: '1px solid #ffecb3',
          color: '#f57f17'
        };
      case 'info':
      default:
        return {
          ...baseStyle,
          backgroundColor: '#e3f2fd',
          border: '1px solid #bbdefb',
          color: '#1565c0'
        };
    }
  };

  // Get status icon
  const getStatusIcon = () => {
    switch (statusType) {
      case 'success':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
        );
      case 'error':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        );
      case 'warning':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        );
      case 'info':
      default:
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        );
    }
  };

  // TabButton component for navigation
  const TabButton = ({ id, label, icon, isActive, onClick }) => (
    <button
      onClick={() => onClick(id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 15px',
        backgroundColor: isActive ? '#1a73e8' : 'transparent',
        color: isActive ? 'white' : '#444',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: isActive ? '500' : 'normal',
        transition: 'all 0.2s ease',
        fontSize: '14px',
        textAlign: 'left',
        width: '100%'
      }}
    >
      {icon}
      {label}
    </button>
  );

  // Button component for consistent styling
  const Button = ({ onClick, disabled, variant = 'primary', icon, children, style }) => {
    const getVariantStyle = () => {
      switch (variant) {
        case 'secondary':
          return {
            backgroundColor: disabled ? '#e0e0e0' : '#f5f5f5',
            color: disabled ? '#999' : '#333',
            border: '1px solid #ddd',
            ':hover': {
              backgroundColor: '#e0e0e0'
            }
          };
        case 'success':
          return {
            backgroundColor: disabled ? '#a5d6a7' : '#4caf50',
            color: 'white',
            ':hover': {
              backgroundColor: '#43a047'
            }
          };
        case 'danger':
          return {
            backgroundColor: disabled ? '#ef9a9a' : '#f44336',
            color: 'white',
            ':hover': {
              backgroundColor: '#e53935'
            }
          };
        case 'primary':
        default:
          return {
            backgroundColor: disabled ? '#bbdefb' : '#1a73e8',
            color: 'white',
            ':hover': {
              backgroundColor: '#1565c0'
            }
          };
      }
    };

    return (
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '10px 16px',
          borderRadius: '6px',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: '500',
          transition: 'all 0.2s ease',
          fontSize: '14px',
          ...getVariantStyle(),
          ...style
        }}
      >
        {icon}
        {children}
      </button>
    );
  };

  // Sidebar content
  const renderSidebar = () => (
    <div style={{ 
      width: '250px', 
      backgroundColor: '#f9f9f9',
      borderRight: '1px solid #eee',
      overflowY: 'auto',
      display: showSidebar ? 'flex' : 'none',
      flexDirection: 'column',
      transition: 'all 0.3s ease'
    }}>
      {/* App name and logo */}
      <div style={{ 
        padding: '20px', 
        borderBottom: '1px solid #eee',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
          <polyline points="17 2 12 7 7 2"></polyline>
        </svg>
        <div style={{ fontWeight: 'bold', color: '#333', fontSize: '18px' }}>IPTV EPG Matcher</div>
      </div>

      {/* Navigation */}
      <nav style={{ padding: '15px' }}>
        <div style={{ marginBottom: '15px', fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Navigation
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <TabButton 
            id="configure" 
            label="Configuration" 
            isActive={activeTab === 'configure'} 
            onClick={setActiveTab}
            icon={
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            }
          />
          
          <TabButton 
            id="channels" 
            label={`Channels${totalChannels ? ` (${totalChannels})` : ''}`}
            isActive={activeTab === 'channels'} 
            onClick={setActiveTab}
            icon={
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
            }
          />
          
          <TabButton 
            id="player" 
            label="Player"
            isActive={activeTab === 'player'} 
            onClick={setActiveTab}
            icon={
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polygon points="10 8 16 12 10 16 10 8"></polygon>
              </svg>
            }
          />
          
          <TabButton 
            id="result" 
            label="Result"
            isActive={activeTab === 'result'} 
            onClick={setActiveTab}
            icon={
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            }
          />
        </div>
      </nav>

      {/* Stats section */}
      {channels.length > 0 && (
        <div style={{ 
          padding: '15px', 
          marginTop: 'auto',
          borderTop: '1px solid #eee'
        }}>
          <div style={{ marginBottom: '10px', fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Statistics
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span>Total Channels:</span>
              <span style={{ fontWeight: '500' }}>{totalChannels}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span>Categories:</span>
              <span style={{ fontWeight: '500' }}>{categories.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span>EPG Matches:</span>
              <span style={{ fontWeight: '500' }}>{Object.keys(matchedChannels).length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span>EPG Sources:</span>
              <span style={{ fontWeight: '500' }}>{epgSources.length}</span>
            </div>
          </div>
          
          <div style={{ marginTop: '15px' }}>
            <Button 
              variant="secondary" 
              onClick={handleReset}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38"></path>
                </svg>
              }
              style={{ width: '100%' }}
            >
              Reset Application
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  // Configuration tab content
  const renderConfigureTab = () => (
    <div style={{ padding: '20px' }}>
      <h2 style={{ marginTop: 0, color: '#333', fontWeight: '500' }}>Configuration</h2>
      
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        {/* XTREAM Config */}
        <div style={{ flex: '1', minWidth: '300px' }}>
          <h3 style={{ color: '#444', fontWeight: '500', fontSize: '18px' }}>XTREAM Login</h3>
          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
            border: '1px solid #eee'
          }}>
            <div style={{ position: 'relative', marginBottom: '15px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                Server URL
              </label>
              <input 
                type="text" 
                placeholder="http://example.com:8080" 
                value={xtreamServer} 
                onChange={e => setXtreamServer(e.target.value)} 
                style={{ 
                  display: 'block', 
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ddd',
                  fontSize: '14px'
                }} 
              />
            </div>
            
            <div style={{ position: 'relative', marginBottom: '15px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                Username
              </label>
              <input 
                type="text" 
                placeholder="Username" 
                value={xtreamUsername} 
                onChange={e => setXtreamUsername(e.target.value)} 
                style={{ 
                  display: 'block', 
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ddd',
                  fontSize: '14px'
                }} 
              />
            </div>
            
            <div style={{ position: 'relative', marginBottom: '15px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                Password
              </label>
              <input 
                type="password" 
                placeholder="Password" 
                value={xtreamPassword} 
                onChange={e => setXtreamPassword(e.target.value)} 
                style={{ 
                  display: 'block', 
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ddd',
                  fontSize: '14px'
                }} 
              />
            </div>
          </div>
        </div>
        
        {/* M3U Source */}
        <div style={{ flex: '1', minWidth: '300px' }}>
          <h3 style={{ color: '#444', fontWeight: '500', fontSize: '18px' }}>M3U Source (Optional)</h3>
          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
            border: '1px solid #eee'
          }}>
            <div style={{ position: 'relative', marginBottom: '15px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                M3U URL
              </label>
              <input 
                type="text" 
                placeholder="https://example.com/playlist.m3u" 
                value={m3uUrl} 
                onChange={e => setM3uUrl(e.target.value)} 
                style={{ 
                  display: 'block', 
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ddd',
                  fontSize: '14px'
                }} 
              />
            </div>
            
            <div style={{ marginTop: '20px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                Or upload M3U file
              </label>
              <Dropzone onDrop={acceptedFiles => setM3uFile(acceptedFiles[0])}>
                {({ getRootProps, getInputProps }) => (
                  <section>
                    <div {...getRootProps()} style={{ 
                      border: '2px dashed #ddd', 
                      padding: '20px', 
                      marginTop: '5px',
                      borderRadius: '6px',
                      textAlign: 'center',
                      cursor: 'pointer',
                      backgroundColor: '#f9f9f9',
                      transition: 'all 0.2s ease'
                    }}
                    onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f1f1f1'}
                    onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#f9f9f9'}
                    >
                      <input {...getInputProps()} />
                      {m3uFile ? (
                        <div>
                          <div style={{ 
                            marginBottom: '5px', 
                            fontWeight: '500',
                            color: '#1a73e8'
                          }}>
                            Selected: {m3uFile.name}
                          </div>
                          <div style={{ fontSize: '12px', color: '#666' }}>
                            Click or drop file to replace
                          </div>
                        </div>
                      ) : (
                        <div>
                          <svg 
                            xmlns="http://www.w3.org/2000/svg" 
                            width="24" 
                            height="24" 
                            viewBox="0 0 24 24" 
                            fill="none" 
                            stroke="#777" 
                            strokeWidth="2" 
                            strokeLinecap="round" 
                            strokeLinejoin="round"
                            style={{ marginBottom: '10px' }}
                          >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="17 8 12 3 7 8"></polyline>
                            <line x1="12" y1="3" x2="12" y2="15"></line>
                          </svg>
                          <p style={{ margin: 0, color: '#555' }}>
                            Drop M3U file here or click to browse
                          </p>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </Dropzone>
            </div>
          </div>
        </div>
        
        {/* EPG Source */}
        <div style={{ flex: '1', minWidth: '300px' }}>
          <h3 style={{ color: '#444', fontWeight: '500', fontSize: '18px' }}>EPG Source (Optional)</h3>
          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
            border: '1px solid #eee'
          }}>
            <div style={{ position: 'relative', marginBottom: '15px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                EPG URL
              </label>
              <input 
                type="text" 
                placeholder="https://example.com/epg.xml" 
                value={epgUrl} 
                onChange={e => setEpgUrl(e.target.value)} 
                style={{ 
                  display: 'block', 
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: '1px solid #ddd',
                  fontSize: '14px'
                }} 
              />
            </div>
            
            <div style={{ marginTop: '20px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontSize: '14px', 
                color: '#555',
                fontWeight: '500'
              }}>
                Or upload EPG file
              </label>
              <Dropzone onDrop={acceptedFiles => setEpgFile(acceptedFiles[0])}>
                {({ getRootProps, getInputProps }) => (
                  <section>
                    <div {...getRootProps()} style={{ 
                      border: '2px dashed #ddd', 
                      padding: '20px', 
                      marginTop: '5px',
                      borderRadius: '6px',
                      textAlign: 'center',
                      cursor: 'pointer',
                      backgroundColor: '#f9f9f9',
                      transition: 'all 0.2s ease'
                    }}
                    onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f1f1f1'}
                    onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#f9f9f9'}
                    >
                      <input {...getInputProps()} />
                      {epgFile ? (
                        <div>
                          <div style={{ 
                            marginBottom: '5px', 
                            fontWeight: '500',
                            color: '#1a73e8'
                          }}>
                            Selected: {epgFile.name}
                          </div>
                          <div style={{ fontSize: '12px', color: '#666' }}>
                            Click or drop file to replace
                          </div>
                        </div>
                      ) : (
                        <div>
                          <svg 
                            xmlns="http://www.w3.org/2000/svg" 
                            width="24" 
                            height="24" 
                            viewBox="0 0 24 24" 
                            fill="none" 
                            stroke="#777" 
                            strokeWidth="2" 
                            strokeLinecap="round" 
                            strokeLinejoin="round"
                            style={{ marginBottom: '10px' }}
                          >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="17 8 12 3 7 8"></polyline>
                            <line x1="12" y1="3" x2="12" y2="15"></line>
                          </svg>
                          <p style={{ margin: 0, color: '#555' }}>
                            Drop EPG file here or click to browse
                          </p>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </Dropzone>
            </div>
          </div>
        </div>
      </div>
      
      <div style={{ 
        marginTop: '20px', 
        display: 'flex', 
        gap: '10px', 
        justifyContent: 'center' 
      }}>
        <Button 
          onClick={() => handleLoad(false)} 
          disabled={isLoading}
          icon={
            isLoading ? (
              <div className="loading-spinner" style={{
                display: 'inline-block',
                width: '16px',
                height: '16px',
                border: '2px solid rgba(255,255,255,0.3)',
                borderRadius: '50%',
                borderTopColor: 'white',
                animation: 'spin 1s linear infinite'
              }}></div>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
            )
          }
        >
          {isLoading ? 'Loading...' : 'Load Channels'}
        </Button>
        
        <Button 
          onClick={() => handleLoad(true)} 
          disabled={isLoading}
          variant="secondary"
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"></path>
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
              <path d="M3 12a9 9 0 0 0 15 6.7L21 16"></path>
              <path d="M21 22v-6h-6"></path>
            </svg>
          }
        >
          Force Update
        </Button>
      </div>
      
      <div style={{ 
        marginTop: '30px', 
        backgroundColor: '#fffde7',
        padding: '15px',
        borderRadius: '8px',
        border: '1px solid #fff9c4'
      }}>
        <h3 style={{ 
          margin: '0 0 10px 0', 
          color: '#f57c00',
          fontWeight: '500',
          fontSize: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          Getting Started
        </h3>
        
        <ol style={{ 
          margin: '0', 
          paddingLeft: '25px',
          fontSize: '14px',
          color: '#555',
          lineHeight: '1.5'
        }}>
          <li>Enter your Xtream credentials or provide an M3U URL/file</li>
          <li>Click "Load Channels" to fetch your channels</li>
          <li>Browse channels and select one to play</li>
          <li>Match channels with EPG data sources</li>
          <li>Generate new Xtream credentials once you've made matches</li>
        </ol>
      </div>
    </div>
  );

  // Channels tab content
  const renderChannelsTab = () => (
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
            {filteredChannels.length} of {totalChannels} channels
          </div>
          
          {selectedCategory && (
            <Button
              variant="secondary"
              onClick={() => { setSelectedCategory(null); handleLoad(false); }}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                  <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
              }
              style={{ padding: '6px 12px' }}
            >
              Show All
            </Button>
          )}
        </div>
      </h2>
      
      <div style={{ display: 'flex', gap: '20px' }}>
        {/* Categories */}
        <div style={{ width: '250px' }}>
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
              Categories
            </h3>
            
            <button 
              onClick={unselectAllCategories} 
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
          </div>
          
          <div style={{ 
            maxHeight: 'calc(100vh - 240px)', 
            overflowY: 'auto', 
            border: '1px solid #eee', 
            borderRadius: '8px',
            padding: '5px',
            backgroundColor: 'white'
          }}>
            {categories.map(cat => (
              <div 
                key={cat.name} 
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
                    id={`category-${cat.name}`}
                    checked={!hiddenCategories.includes(cat.name)}
                    onChange={() => toggleCategory(cat.name)}
                    style={{ 
                      marginRight: '8px',
                      accentColor: '#1a73e8'
                    }}
                  />
                  <label 
                    htmlFor={`category-${cat.name}`}
                    onClick={() => selectCategory(cat.name)} 
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
            ))}
          </div>
        </div>
        
        {/* Channel list */}
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: '15px' }}>
            <div style={{ position: 'relative' }}>
              <svg 
                style={{ 
                  position: 'absolute', 
                  left: '12px', 
                  top: '50%', 
                  transform: 'translateY(-50%)',
                  color: '#666' 
                }} 
                xmlns="http://www.w3.org/2000/svg" 
                width="18" 
                height="18" 
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
                placeholder="Search channels by name..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ 
                  width: '100%',
                  padding: '10px 12px 10px 40px',
                  borderRadius: '6px',
                  border: '1px solid #ddd',
                  fontSize: '14px'
                }}
              />
            </div>
          </div>
          
          <div style={{ 
            height: 'calc(100vh - 230px)', 
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column' 
          }}>
            <div style={{ 
              flex: 1, 
              overflowY: 'auto',
              border: '1px solid #eee',
              borderRadius: '8px',
              backgroundColor: 'white'
            }}>
              {filteredChannels.length > 0 ? (
                filteredChannels.map((ch, index) => (
                  <div
                    key={ch.tvgId}
                    onClick={() => handleChannelSelect(ch)}
                    style={{
                      padding: '12px 15px',
                      cursor: 'pointer',
                      background: selectedChannel?.tvgId === ch.tvgId ? '#e3f2fd' : index % 2 === 0 ? 'white' : '#f9f9f9',
                      borderLeft: selectedChannel?.tvgId === ch.tvgId ? '4px solid #1a73e8' : '4px solid transparent',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      borderBottom: index < filteredChannels.length - 1 ? '1px solid #f0f0f0' : 'none',
                      transition: 'all 0.2s ease'
                    }}
                    onMouseOver={(e) => {
                      if (selectedChannel?.tvgId !== ch.tvgId) {
                        e.currentTarget.style.backgroundColor = '#f5f5f5';
                      }
                    }}
                    onMouseOut={(e) => {
                      if (selectedChannel?.tvgId !== ch.tvgId) {
                        e.currentTarget.style.backgroundColor = index % 2 === 0 ? 'white' : '#f9f9f9';
                      }
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ 
                        fontWeight: selectedChannel?.tvgId === ch.tvgId ? '500' : 'normal',
                        color: selectedChannel?.tvgId === ch.tvgId ? '#1a73e8' : '#333',
                        marginBottom: '3px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        {ch.name}
                      </div>
                      <div style={{ 
                        fontSize: '12px', 
                        color: '#666',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap'
                      }}>
                        <span style={{
                          backgroundColor: '#f1f1f1',
                          padding: '2px 8px',
                          borderRadius: '30px',
                          fontSize: '11px'
                        }}>
                          {ch.groupTitle}
                        </span>
                        
                        {matchedChannels[ch.tvgId] && (
                          <span style={{
                            backgroundColor: '#e8f5e9',
                            color: '#2e7d32',
                            padding: '2px 8px',
                            borderRadius: '30px',
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '3px'
                          }}>
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                              <polyline points="22 4 12 14.01 9 11.01"></polyline>
                            </svg>
                            EPG Matched
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleChannelSelect(ch);
                      }}
                      style={{
                        backgroundColor: 'transparent',
                        border: 'none',
                        padding: '6px',
                        borderRadius: '50%',
                        cursor: 'pointer',
                        color: '#888',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s ease'
                      }}
                      onMouseOver={(e) => {
                        e.currentTarget.style.backgroundColor = '#f0f0f0';
                        e.currentTarget.style.color = '#1a73e8';
                      }}
                      onMouseOut={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = '#888';
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polygon points="10 8 16 12 10 16 10 8"></polygon>
                      </svg>
                    </button>
                  </div>
                ))
              ) : (
                <div style={{ 
                  padding: '30px', 
                  textAlign: 'center', 
                  color: '#666' 
                }}>
                  No channels match your filters
                </div>
              )}
            </div>
            
            {channels.length < totalChannels && (
              <div style={{ marginTop: '15px', textAlign: 'center' }}>
                <Button 
                  onClick={() => loadMoreChannels()} 
                  disabled={isLoading}
                  variant="secondary"
                  icon={isLoading ? (
                    <div className="loading-spinner" style={{
                      display: 'inline-block',
                      width: '16px',
                      height: '16px',
                      border: '2px solid rgba(0,0,0,0.3)',
                      borderRadius: '50%',
                      borderTopColor: '#555',
                      animation: 'spin 1s linear infinite'
                    }}></div>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10"></polyline>
                      <polyline points="23 20 23 14 17 14"></polyline>
                      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
                    </svg>
                  )}
                >
                  {isLoading ? 'Loading...' : 'Load More Channels'}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // Player tab content
  const renderPlayerTab = () => (
    <div style={{ padding: '20px' }}>
      <h2 style={{ marginTop: 0, color: '#333', fontWeight: '500' }}>
        Video Preview
      </h2>
      
      <div style={{ 
        display: 'flex',
        gap: '20px',
        flexWrap: 'wrap'
      }}>
        <div style={{ flex: '1.5', minWidth: '500px' }}>
          {/* Player Type Selection */}
          <div style={{ 
            marginBottom: '15px', 
            padding: '10px',
            backgroundColor: '#f9f9f9',
            borderRadius: '8px',
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <button
              onClick={() => setPlayerType('iptv')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'iptv' ? '#1a73e8' : 'transparent',
                color: playerType === 'iptv' ? 'white' : '#444',
                border: playerType === 'iptv' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'iptv' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                <polyline points="17 2 12 7 7 2"></polyline>
              </svg>
              IPTV Player
            </button>
            
            <button
              onClick={() => setPlayerType('mpegts-player')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'mpegts-player' ? '#1a73e8' : 'transparent',
                color: playerType === 'mpegts-player' ? 'white' : '#444',
                border: playerType === 'mpegts-player' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'mpegts-player' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
              TS Player
            </button>
            
            <button
              onClick={() => setPlayerType('hls-player')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'hls-player' ? '#1a73e8' : 'transparent',
                color: playerType === 'hls-player' ? 'white' : '#444',
                border: playerType === 'hls-player' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'hls-player' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <path d="M2 15s2-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2"></path>
                <path d="M2 19s2-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2"></path>
              </svg>
              HLS Player
            </button>
            
            <button
              onClick={() => setPlayerType('vlc-link')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'vlc-link' ? '#1a73e8' : 'transparent',
                color: playerType === 'vlc-link' ? 'white' : '#444',
                border: playerType === 'vlc-link' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'vlc-link' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
              VLC Link
            </button>
          </div>
          
          {/* Video Player */}
          {selectedChannel && sessionId ? (
            <IPTVPlayer sessionId={sessionId} selectedChannel={selectedChannel} />
          ) : (
            <div style={{ 
              height: '400px', 
              display: 'flex', 
              flexDirection: 'column',
              alignItems: 'center', 
              justifyContent: 'center',
              backgroundColor: '#000',
              borderRadius: '8px',
              color: '#aaa'
            }}>
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="48" 
                height="48" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="1" 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                style={{ marginBottom: '15px' }}
              >
                <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                <polyline points="17 2 12 7 7 2"></polyline>
              </svg>
              <p style={{ margin: 0 }}>Select a channel to play</p>
            </div>
          )}
          
          <div style={{ 
            marginTop: '20px', 
            display: 'flex', 
            justifyContent: 'center' 
          }}>
            <Button 
              onClick={() => {
                if (selectedChannel) {
                  setActiveTab('channels');
                }
              }}
              variant={selectedChannel ? 'secondary' : 'primary'}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
              }
            >
              {selectedChannel ? 'Select Another Channel' : 'Select a Channel'}
            </Button>
          </div>
        </div>
        
        {/* EPG Matcher */}
        <div style={{ flex: '1', minWidth: '400px' }}>
          <EPGMatcher 
            sessionId={sessionId}
            selectedChannel={selectedChannel}
            onEpgMatch={handleEpgMatch}
            matchedChannels={matchedChannels}
          />
          
          {/* Generate Button */}
          <div style={{ marginTop: '20px', textAlign: 'center' }}>
            <Button 
              onClick={handleGenerate} 
              disabled={isLoading || isGenerating || Object.keys(matchedChannels).length === 0}
              variant="success"
              icon={isGenerating ? (
                <div className="loading-spinner" style={{
                  display: 'inline-block',
                  width: '16px',
                  height: '16px',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderRadius: '50%',
                  borderTopColor: 'white',
                  animation: 'spin 1s linear infinite'
                }}></div>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              )}
              style={{ 
                padding: '12px 20px', 
                fontSize: '16px'
              }}
            >
              {isGenerating ? 'Generating...' : 'Generate New XTREAM Credentials'}
            </Button>
            
            {Object.keys(matchedChannels).length === 0 && (
              <p style={{ 
                color: '#f44336', 
                marginTop: '10px',
                fontSize: '14px'
              }}>
                You need to match at least one channel with EPG data
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // Result tab content
  const renderResultTab = () => (
    <div style={{ padding: '20px' }}>
      <h2 style={{ 
        marginTop: 0, 
        color: '#333', 
        fontWeight: '500',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        New XTREAM Credentials
      </h2>
      
      {result ? (
        <>
          <div style={{ 
            backgroundColor: 'white',
            padding: '25px',
            borderRadius: '8px',
            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.05)',
            border: '1px solid #eee'
          }}>
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'auto 1fr auto', 
              gap: '15px',
              alignItems: 'center'
            }}>
              <div style={{ 
                fontWeight: '500', 
                fontSize: '14px', 
                color: '#444'
              }}>Server URL:</div>
              <div style={{ 
                padding: '12px',
                backgroundColor: '#f5f5f5',
                borderRadius: '6px',
                overflowX: 'auto',
                fontSize: '14px',
                color: '#333',
                border: '1px solid #eee'
              }}>{result.xtreamUrl}</div>
              <Button 
                onClick={() => copyToClipboard(result.xtreamUrl)}
                variant="secondary"
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                }
                style={{ padding: '8px 12px' }}
              >
                Copy
              </Button>
              
              <div style={{ 
                fontWeight: '500', 
                fontSize: '14px', 
                color: '#444'
              }}>EPG URL:</div>
              <div style={{ 
                padding: '12px',
                backgroundColor: '#f5f5f5',
                borderRadius: '6px',
                overflowX: 'auto',
                fontSize: '14px',
                color: '#333',
                border: '1px solid #eee'
              }}>{result.xtreamEpgUrl}</div>
              <Button 
                onClick={() => copyToClipboard(result.xtreamEpgUrl)}
                variant="secondary"
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                }
                style={{ padding: '8px 12px' }}
              >
                Copy
              </Button>
              
              <div style={{ 
                fontWeight: '500', 
                fontSize: '14px', 
                color: '#444'
              }}>Username:</div>
              <div style={{ 
                padding: '12px',
                backgroundColor: '#f5f5f5',
                borderRadius: '6px',
                fontSize: '14px',
                color: '#333',
                border: '1px solid #eee'
              }}>{result.username}</div>
              <Button 
                onClick={() => copyToClipboard(result.username)}
                variant="secondary"
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                }
                style={{ padding: '8px 12px' }}
              >
                Copy
              </Button>
              
              <div style={{ 
                fontWeight: '500', 
                fontSize: '14px', 
                color: '#444'
              }}>Password:</div>
              <div style={{ 
                padding: '12px',
                backgroundColor: '#f5f5f5',
                borderRadius: '6px',
                fontSize: '14px',
                color: '#333',
                border: '1px solid #eee'
              }}>{result.password}</div>
              <Button 
                onClick={() => copyToClipboard(result.password)}
                variant="secondary"
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                }
                style={{ padding: '8px 12px' }}
              >
                Copy
              </Button>
            </div>
            
            <div style={{ 
              marginTop: '30px', 
              textAlign: 'center',
              display: 'flex',
              justifyContent: 'center',
              gap: '15px',
              flexWrap: 'wrap'
            }}>
              <Button 
                onClick={() => window.location.href = result.downloadUrl} 
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                }
              >
                Download EPG File
              </Button>
              
              <Button 
                onClick={() => setActiveTab('player')}
                variant="secondary"
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polygon points="10 8 16 12 10 16 10 8"></polygon>
                  </svg>
                }
              >
                Back to Player
              </Button>
            </div>
          </div>
          
          <div style={{ 
            marginTop: '25px',
            backgroundColor: '#e8f5e9',
            padding: '15px',
            borderRadius: '8px',
            border: '1px solid #c8e6c9',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px'
          }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ minWidth: '20px', marginTop: '3px' }}>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <div>
              <p style={{ 
                margin: '0 0 8px 0', 
                fontWeight: '500',
                color: '#2e7d32'
              }}>
                Success! Your new XTREAM credentials have been generated.
              </p>
              <p style={{ margin: '0', color: '#444' }}>
                You can now use these credentials in your IPTV player app. The updated playlist includes all your channels with matched EPG data. Copy the Server URL, Username, and Password to your IPTV player, or download the EPG file for standalone usage.
              </p>
              <p style={{ margin: '10px 0 0 0', color: '#444' }}>
                <strong>Note:</strong> These credentials will work as long as the backend service is running. To save this configuration permanently, use the download option.
              </p>
            </div>
          </div>
        </>
      ) : (
        <div style={{ 
          padding: '40px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
          textAlign: 'center',
          color: '#666'
        }}>
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="64" 
            height="64" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1" 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            style={{ marginBottom: '20px', opacity: 0.5 }}
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <h3 style={{ 
            margin: '0 0 15px 0',
            color: '#444',
            fontWeight: '500'
          }}>
            No Results Yet
          </h3>
          <p style={{ margin: '0 0 20px 0' }}>
            Match channels with EPG data and generate credentials to see results here.
          </p>
          <Button 
            onClick={() => setActiveTab('player')}
            icon={
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polygon points="10 8 16 12 10 16 10 8"></polygon>
              </svg>
            }
          >
            Go to Player & Matcher
          </Button>
        </div>
      )}
    </div>
  );

  // Render the active tab content
  const renderActiveTabContent = () => {
    switch (activeTab) {
      case 'channels':
        return renderChannelsTab();
      case 'player':
        return renderPlayerTab();
      case 'result':
        return renderResultTab();
      case 'configure':
      default:
        return renderConfigureTab();
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
              Session: {sessionId.substring(0, 8)}...
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
        {renderSidebar()}
        
        {/* Main content area */}
        <main style={{ 
          flex: 1,
          overflowY: 'auto',
          maxHeight: 'calc(100vh - 60px)'
        }}>
          {/* Status message */}
          {status && (
            <div style={getStatusStyle()}>
              {getStatusIcon()}
              <span>{status}</span>
            </div>
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