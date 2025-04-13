import React, { useState, useEffect } from 'react';
import Dropzone from 'react-dropzone';
import axios from 'axios';
import LoadingProgress from './LoadingProgress';
import SessionManager from './utils/sessionManager';
import { API_BASE_URL } from './config';
import { registerSession } from './services/SSEService';

/**
 * Configuration component that handles IPTV and EPG configuration
 */
const Configuration = ({ 
  onLoad, 
  error 
}) => {
  // Local state for loading
  const [isLoading, setIsLoading] = useState(false);
  const [m3uFile, setM3uFile] = useState(null);
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [status, setStatus] = useState('');
  const [processingSessionId, setProcessingSessionId] = useState(null);
  
  // Xtream credentials
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');
  
  // Load any saved credentials
  useEffect(() => {
    // Try new format first
    let storedUsername = localStorage.getItem('xtreamUsername');
    let storedPassword = localStorage.getItem('xtreamPassword');
    let storedServer = localStorage.getItem('xtreamServer');
    
    // If new format not found, check old format and migrate if needed
    if (!storedUsername && !storedPassword && !storedServer) {
      try {
        const oldCredentials = JSON.parse(localStorage.getItem('xtreamCredentials') || '{}');
        if (oldCredentials.server || oldCredentials.username || oldCredentials.password) {
          console.log('Migrating from old credential format to new format');
          
          // Set from old format
          storedUsername = oldCredentials.username || '';
          storedPassword = oldCredentials.password || '';
          storedServer = oldCredentials.server || '';
          
          // Migrate to new format
          localStorage.setItem('xtreamUsername', storedUsername);
          localStorage.setItem('xtreamPassword', storedPassword);
          localStorage.setItem('xtreamServer', storedServer);
          
          // Clean up old format
          localStorage.removeItem('xtreamCredentials');
        }
      } catch (error) {
        console.error('Error parsing old credentials format:', error);
      }
    }
    
    // Set state with whatever was found
    if (storedUsername) setXtreamUsername(storedUsername);
    if (storedPassword) setXtreamPassword(storedPassword);
    if (storedServer) setXtreamServer(storedServer);
  }, []);

  // Save credentials to localStorage
  const saveCredentials = () => {
    try {
      // Save each credential separately for better compatibility
      localStorage.setItem('xtreamUsername', xtreamUsername);
      localStorage.setItem('xtreamPassword', xtreamPassword);
      localStorage.setItem('xtreamServer', xtreamServer);
      console.log('Xtream credentials saved to localStorage');
    } catch (error) {
      console.error('Error saving credentials:', error);
    }
  };

  // Handle loading channels with streaming progress
  const handleLoad = async () => {
    try {
      // Validate inputs - at least one source must be provided
      if (!m3uFile && !m3uUrl && (!xtreamUsername || !xtreamPassword || !xtreamServer)) {
        alert('Please provide an M3U file, M3U URL, or Xtream credentials');
        return;
      }
      
      if (xtreamUsername && xtreamPassword && xtreamServer) {
        saveCredentials();
      }
      
      // Get and ensure we have a valid session ID
      const sessionId = await SessionManager.init();
      if (!sessionId) {
        throw new Error('Failed to create or validate session');
      }
      
      console.log(`[Configuration] Using session ID for load: ${sessionId}`);
      setIsLoading(true);
      setStatus('Initializing...');
      
      // Pre-register the session before starting the load process
      try {
        await registerSession(sessionId);
      } catch (err) {
        console.warn('Failed to register session before load, continuing anyway:', err);
      }
      
      // Create form data object with sessionId included
      const formData = new FormData();
      formData.append('sessionId', sessionId);
      
      // Add file if uploaded
      if (m3uFile) {
        formData.append('m3uFile', m3uFile);
      }
      
      // Add URLs if provided
      if (m3uUrl) {
        formData.append('m3uUrl', m3uUrl);
      }
      
      if (epgUrl) {
        formData.append('epgUrl', epgUrl);
      }
      
      // Add Xtream credentials if provided
      if (xtreamUsername && xtreamPassword && xtreamServer) {
        formData.append('xtreamUsername', xtreamUsername);
        formData.append('xtreamPassword', xtreamPassword);
        formData.append('xtreamServer', xtreamServer);
      }
      
      setStatus('Sending request to server...');
      
      // Send the request with the proper Content-Type
      const response = await axios.post(`${API_BASE_URL}/api/load`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      
      console.log('[Configuration] Load response:', response.data);
      
      if (response.data.success) {
        setStatus('Processing started on server');
        setProcessingSessionId(sessionId);
      } else {
        setIsLoading(false);
        setStatus(`Error: ${response.data.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error loading channels:', error);
      setIsLoading(false);
      setStatus(`Error: ${error.response?.data?.error || error.message}`);
    }
  };
  
  // Handle process complete callback from LoadingProgress
  const handleProcessComplete = (data) => {
    console.log('[Configuration] Process complete callback received');
    setIsLoading(false);
    setStatus('Processing complete');
    if (onLoad) {
      onLoad(data);
    }
  };
  
  // Handle channels available callback from LoadingProgress
  const handleChannelsAvailable = (data) => {
    console.log('[Configuration] Channels available callback received');
    setStatus(`${data?.channelCount || 0} channels loaded`);
    if (onLoad) {
      onLoad(data);
    }
  };
  
  // Handle EPG source available callback from LoadingProgress
  const handleEpgSourceAvailable = (data) => {
    console.log('[Configuration] EPG source available callback received');
    setStatus(`EPG source loaded: ${data?.url || 'Unknown'}`);
  };

  // Handle closing summary view
  const handleSummaryClose = () => {
    setStatus('');
    if (onLoad) {
      onLoad(null);
    }
  };

  // Load EPG summary information
  const loadEpgSummary = async () => {
    try {
      setStatus('Loading EPG summary...');
      const response = await axios.get(`${API_BASE_URL}/api/epg-summary`);
      if (onLoad) {
        onLoad(response.data);
      }
      setStatus('EPG summary loaded');
    } catch (error) {
      console.error('Error loading EPG summary:', error);
      setStatus(`Error loading EPG summary: ${error.message}`);
    }
  };

  // Add a summary component
  const EpgSummary = ({ summary }) => {
    if (!summary) return <div className="loading">Loading summary...</div>;
    
    return (
      <div className="epg-summary">
        <h3>EPG Data Summary</h3>
        <div className="summary-stats">
          <div className="stat-item">
            <div className="stat-value">{summary.totalSources}</div>
            <div className="stat-label">Sources</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{summary.totalChannels.toLocaleString()}</div>
            <div className="stat-label">Channels</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{summary.totalPrograms.toLocaleString()}</div>
            <div className="stat-label">Programs</div>
          </div>
        </div>
        
        <div className="averages">
          <div>
            <strong>Avg. Channels per Source:</strong> {summary.averageChannelsPerSource}
          </div>
          <div>
            <strong>Avg. Programs per Channel:</strong> {summary.averageProgramsPerChannel}
          </div>
        </div>
        
        <h4>Source Details</h4>
        <div className="source-list">
          {summary.sources.map((source, index) => (
            <div key={index} className="source-item">
              <div className="source-name">{source.name}</div>
              <div className="source-url">{source.url}</div>
              <div className="source-counts">
                <span>{source.channelCount.toLocaleString()} channels</span>
                <span>{source.programCount.toLocaleString()} programs</span>
              </div>
              <div className="source-updated">
                Last updated: {new Date(source.lastUpdated).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
        
        <button className="close-summary" onClick={handleSummaryClose}>
          Close Summary
        </button>
      </div>
    );
  };

  return (
    <div className="configuration-container">
      {error && (
        <div className="error-banner" style={{
          background: '#ffebee',
          color: '#c62828',
          padding: '10px 15px',
          borderRadius: '4px',
          marginBottom: '20px',
          border: '1px solid #ffcdd2'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}
      
      {isLoading && processingSessionId ? (
        <LoadingProgress 
          sessionId={processingSessionId}
          onComplete={handleProcessComplete}
          onChannelsAvailable={handleChannelsAvailable}
          onEpgSourceAvailable={handleEpgSourceAvailable}
        />
      ) : (
        <div className="config-form-container">
          <h2>Configuration</h2>
          {status && (
            <div className="status-message" style={{
              padding: '10px',
              marginBottom: '15px',
              backgroundColor: '#e3f2fd',
              borderRadius: '4px',
              color: '#0d47a1'
            }}>
              {status}
            </div>
          )}
          
          <div className="config-sections" style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '20px',
            marginTop: '20px'
          }}>
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
                  <Dropzone onDrop={acceptedFiles => {
                    // Store EPG file info but handle together with M3U in the load function
                    console.log('EPG file selected:', acceptedFiles[0]?.name);
                    // Note: Our backend currently only processes M3U files, not EPG files
                    // This is a placeholder for future functionality
                  }}>
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
                              EPG file upload coming soon
                            </p>
                          </div>
                        </div>
                      </section>
                    )}
                  </Dropzone>
                </div>
              </div>
            </div>
          </div>
          
          {/* Buttons row */}
          <div style={{ width: '100%', marginTop: '25px' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px'
            }}>
              <button 
                onClick={handleLoad} 
                disabled={isLoading}
                style={{
                  padding: '10px 16px',
                  backgroundColor: isLoading ? '#e0e0e0' : '#1a73e8',
                  color: isLoading ? '#999' : 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '14px',
                  fontWeight: '500'
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
                {isLoading ? 'Loading...' : 'Load Channels'}
              </button>
            </div>
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
              <li>Explore channels while EPG data loads in the background</li>
              <li>Match channels with EPG data sources</li>
              <li>Generate new Xtream credentials once you've made matches</li>
            </ol>
          </div>
          
          <div style={{ 
            marginTop: '20px', 
            display: 'flex', 
            gap: '10px', 
            justifyContent: 'center' 
          }}>
            <button
              className="summary-button"
              onClick={loadEpgSummary}
            >
              EPG Summary
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Configuration;
