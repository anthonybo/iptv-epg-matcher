import React, { useState, useEffect } from 'react';
import Dropzone from 'react-dropzone';
import axios from 'axios';

/**
 * Configuration component for managing channel sources and loading data
 * 
 * @param {Object} props Component properties
 * @param {Function} props.onLoad Callback when data is loaded
 * @param {boolean} props.isLoading Loading state flag
 * @param {string} props.error Error message, if any
 * @returns {JSX.Element} Configuration UI
 */
const Configuration = ({ onLoad, isLoading, error }) => {
  // State for input files and URLs
  const [m3uFile, setM3uFile] = useState(null);
  const [epgFile, setEpgFile] = useState(null);
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  
  // Xtream credentials
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');
  
  // Load saved credentials on mount
  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem('xtreamCredentials') || '{}');
    setXtreamServer(saved.server || '');
    setXtreamUsername(saved.username || '');
    setXtreamPassword(saved.password || '');
  }, []);

  // Save credentials to local storage
  const saveCredentials = () => {
    localStorage.setItem('xtreamCredentials', JSON.stringify({
      server: xtreamServer,
      username: xtreamUsername,
      password: xtreamPassword,
    }));
  };

  // Handle loading channels
  const handleLoad = async (force = false) => {
    // Validate inputs - at least one source must be provided
    if (!m3uFile && !m3uUrl && (!xtreamUsername || !xtreamPassword || !xtreamServer)) {
      return alert('Please provide either an M3U file, M3U URL, or complete Xtream credentials');
    }
    
    saveCredentials();
    
    const formData = new FormData();
    if (m3uFile) formData.append('m3u', m3uFile);
    if (epgFile) formData.append('epg', epgFile);
    formData.append('m3uUrl', m3uUrl);
    formData.append('epgUrl', epgUrl);
    formData.append('xtreamUsername', xtreamUsername);
    formData.append('xtreamPassword', xtreamPassword);
    formData.append('xtreamServer', xtreamServer);
    if (force) formData.append('forceUpdate', 'true');
    
    // Call the parent callback
    onLoad(formData, force);
  };

  return (
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
        <button 
          onClick={() => handleLoad(false)} 
          disabled={isLoading}
          style={{
            padding: '10px 16px',
            backgroundColor: isLoading ? '#bbdefb' : '#1a73e8',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '14px'
          }}
        >
          {isLoading ? (
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
          )}
          {isLoading ? 'Loading...' : 'Load Channels'}
        </button>
        
        <button 
          onClick={() => handleLoad(true)} 
          disabled={isLoading}
          style={{
            padding: '10px 16px',
            backgroundColor: isLoading ? '#e0e0e0' : '#f5f5f5',
            color: isLoading ? '#999' : '#333',
            border: '1px solid #ddd',
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
            <path d="M21 2v6h-6"></path>
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
            <path d="M3 12a9 9 0 0 0 15 6.7L21 16"></path>
            <path d="M21 22v-6h-6"></path>
          </svg>
          Force Update
        </button>
      </div>
      
      {error && (
        <div style={{
          marginTop: '15px',
          padding: '12px 15px',
          backgroundColor: '#ffebee',
          borderRadius: '6px',
          color: '#c62828',
          border: '1px solid #ffcdd2'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}
      
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
};

export default Configuration;