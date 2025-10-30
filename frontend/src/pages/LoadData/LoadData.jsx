import React, { useState, useRef, useEffect } from 'react';
import { loadChannelsAndEpg } from '../../services/api';
import { setupSSE } from '../../services/SSEService';
import { getSessionId } from '../../services/sessionService';
import { useNavigate } from 'react-router-dom';
import './LoadData.css';

const LoadData = () => {
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [processingStage, setProcessingStage] = useState('starting');
  const [currentSessionId, setCurrentSessionId] = useState(getSessionId());
  const [activeTab, setActiveTab] = useState('xtream');
  
  const eventSourceRef = useRef(null);
  const navigate = useNavigate();

  // Listen for SSE completion event
  useEffect(() => {
    const handleCompletion = (event) => {
      console.log('SSE Complete event received', event.detail);
      if (event.detail && event.detail.sessionId) {
        // Update UI with session ID
        setCurrentSessionId(event.detail.sessionId);
        
        // Navigate to channels after a delay
        setTimeout(() => {
          const finalSessionId = getSessionId();
          console.log(`Navigating to channels with final session ID: ${finalSessionId}`);
          if (finalSessionId) {
            navigate('/channels');
          } else {
            console.error('No session available for navigation after completion');
          }
        }, 800);
      }
    };
    
    window.addEventListener('sseComplete', handleCompletion);
    return () => window.removeEventListener('sseComplete', handleCompletion);
  }, [navigate]);

  // Listen for session change events
  useEffect(() => {
    const handleSessionChange = (event) => {
      console.log('Session change event received', event.detail);
      setCurrentSessionId(event.detail.sessionId);
    };
    
    window.addEventListener('sessionChange', handleSessionChange);
    return () => window.removeEventListener('sessionChange', handleSessionChange);
  }, []);

  const handleSubmit = async (e, submissionType = 'xtream') => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProgress(0);
    setProcessingStage(submissionType === 'epg' ? 'loading_epg' : 'starting');
    
    try {
      // Close any existing SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      
      console.log('Starting load process with form data', {
        xtreamUsername, xtreamPassword, xtreamServer
      });
      
      // Load data and get session ID
      const result = await loadChannelsAndEpg({
        m3uUrl,
        epgUrl,
        xtreamUsername,
        xtreamPassword,
        xtreamServer,
        forceUpdate: false
      });
      
      const { sessionId } = result;
      console.log(`Load request completed with session ID: ${sessionId}`);
      
      if (!sessionId) {
        throw new Error('No session ID returned from server');
      }
      
      // Update UI with new session ID
      setCurrentSessionId(sessionId);
      
      // Set up SSE connection for progress updates
      eventSourceRef.current = setupSSE(sessionId);
      
      // Listen for progress updates
      const handleMessage = (event) => {
        if (event.detail && event.detail.data) {
          const data = event.detail.data;
          if (data.progress !== undefined) {
            setProgress(data.progress);
          }
          if (data.stage) {
            setProcessingStage(data.stage);
          }
        }
      };
      
      window.addEventListener('sseMessage', handleMessage);
      
      // Cleanup function to remove event listeners
      return () => {
        window.removeEventListener('sseMessage', handleMessage);
      };
      
    } catch (error) {
      console.error('Error loading data:', error);
      setError(`Error: ${error.message || 'Unknown error occurred'}`);
      setLoading(false);
    }
  };

  const handleXtreamSubmit = (e) => handleSubmit(e, 'xtream');
  const handleEpgSubmit = (e) => handleSubmit(e, 'epg');

  return (
    <div className="load-container">
      <h2 className="page-title">Load IPTV Data</h2>
      <p className="page-subtitle">
        Connect to your provider, then manage EPG sources separately for a cleaner setup.
      </p>

      <div className="tab-header">
        <button
          type="button"
          className={`tab-button ${activeTab === 'xtream' ? 'active' : ''}`}
          onClick={() => setActiveTab('xtream')}
          disabled={loading && activeTab !== 'xtream'}
        >
          Xtream Login
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === 'epg' ? 'active' : ''}`}
          onClick={() => setActiveTab('epg')}
          disabled={loading && activeTab !== 'epg'}
        >
          EPG Sources
        </button>
      </div>

      {activeTab === 'xtream' && (
        <form onSubmit={handleXtreamSubmit} className="tab-panel">
          <div className="form-grid">
            <div className="form-field">
              <label>Xtream Username</label>
              <input
                type="text"
                value={xtreamUsername}
                onChange={(e) => setXtreamUsername(e.target.value)}
                placeholder="Enter Xtream username"
                disabled={loading}
              />
            </div>
            <div className="form-field">
              <label>Xtream Password</label>
              <input
                type="password"
                value={xtreamPassword}
                onChange={(e) => setXtreamPassword(e.target.value)}
                placeholder="Enter Xtream password"
                disabled={loading}
              />
            </div>
            <div className="form-field">
              <label>Xtream Server URL</label>
              <input
                type="text"
                value={xtreamServer}
                onChange={(e) => setXtreamServer(e.target.value)}
                placeholder="http://example.com:25461"
                disabled={loading}
              />
            </div>
          </div>

          <div className="section-divider">
            <span>Playlist Options</span>
          </div>

          <div className="form-grid">
            <div className="form-field full-width">
              <label>M3U URL (Optional)</label>
              <input
                type="text"
                value={m3uUrl}
                onChange={(e) => setM3uUrl(e.target.value)}
                placeholder="Enter playlist URL if provided by your provider"
                disabled={loading}
              />
              <div className="field-help">
                Include your provider&apos;s M3U URL if you prefer to load channels from a playlist.
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" disabled={loading} className="primary-button">
              {loading ? 'Processing...' : 'Load Xtream Data'}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'epg' && (
        <form onSubmit={handleEpgSubmit} className="tab-panel">
          <div className="form-grid">
            <div className="form-field full-width">
              <label>EPG URL</label>
              <input
                type="text"
                value={epgUrl}
                onChange={(e) => setEpgUrl(e.target.value)}
                placeholder="Enter XMLTV or gzipped EPG URL"
                disabled={loading}
              />
              <div className="field-help">
                Manage your guide data independently. You can come back here any time to refresh it.
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" disabled={loading} className="primary-button">
              {loading ? 'Processing...' : 'Load EPG Sources'}
            </button>
          </div>
        </form>
      )}
      
      {loading && (
        <div className="progress-container">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
          <div className="progress-text">
            {processingStage} - {progress}%
          </div>
        </div>
      )}
      
      {error && <div className="error-message">{error}</div>}
      
      <div className="session-debug">
        <strong>Current session ID:</strong> {currentSessionId || 'None'}
      </div>
    </div>
  );
};

export default LoadData;
