import React, { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config';

const SessionDebugger = () => {
  const [sessionInfo, setSessionInfo] = useState({
    fromProps: null,
    fromLocalStorage: null,
    fromSessionManager: null,
    fromWindow: null,
    fromAPI: null
  });
  const [categoriesCount, setCategoriesCount] = useState(0);
  const [apiResponse, setApiResponse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Collection of session ID from multiple sources
    const getSessions = async () => {
      try {
        // 1. From localStorage directly
        const fromLocalStorage = localStorage.getItem('currentSessionId') || 
                                 localStorage.getItem('sessionId');
        
        // 2. From window.sessionManager if it exists
        const fromWindow = window.sessionManager?.getCurrentSession?.() || null;
        
        // 3. From the SessionManager module if imported properly
        let fromSessionManager = null;
        try {
          // Dynamic import to avoid circular dependencies
          const SessionManagerModule = await import('../utils/sessionManager');
          fromSessionManager = SessionManagerModule.default.getSessionId();
          console.log('[DEBUG] Session from SessionManager:', fromSessionManager);
        } catch (e) {
          console.error('[DEBUG] Error getting session from SessionManager:', e);
        }

        setSessionInfo({
          fromProps: null, // Will be updated if passed as prop
          fromLocalStorage,
          fromSessionManager,
          fromWindow
        });

        // If we have a session ID from any source, try to fetch categories
        const activeSessionId = fromSessionManager || fromLocalStorage || fromWindow;
        
        if (activeSessionId) {
          try {
            console.log(`[DEBUG] Attempting to fetch categories with session: ${activeSessionId}`);
            const response = await fetch(`${API_BASE_URL}/api/channels/${activeSessionId}/categories`);
            console.log(`[DEBUG] Categories API response status: ${response.status}`);
            
            // Get the raw text
            const text = await response.text();
            setApiResponse(text);
            
            try {
              // Parse the data
              const data = JSON.parse(text);
              console.log('[DEBUG] Categories data:', data);
              
              if (Array.isArray(data)) {
                setCategoriesCount(data.length);
                console.log(`[DEBUG] Found ${data.length} categories`);
              } else {
                console.warn('[DEBUG] API response is not an array:', data);
              }
            } catch (parseError) {
              console.error('[DEBUG] Failed to parse categories response:', parseError);
              setError(`JSON parse error: ${parseError.message}`);
            }
          } catch (fetchError) {
            console.error('[DEBUG] Error fetching categories:', fetchError);
            setError(`API fetch error: ${fetchError.message}`);
          }
        } else {
          console.warn('[DEBUG] No session ID found in any source');
        }
        
        setLoading(false);
      } catch (e) {
        console.error('[DEBUG] Error in session debug component:', e);
        setError(`General error: ${e.message}`);
        setLoading(false);
      }
    };

    getSessions();

    // Poll every 5 seconds to check for session changes
    const interval = setInterval(getSessions, 5000);
    
    return () => clearInterval(interval);
  }, []);

  const triggerManualRefresh = async () => {
    setLoading(true);
    
    try {
      // Attempt to get the most reliable session ID
      const sessionId = sessionInfo.fromSessionManager || 
                       sessionInfo.fromLocalStorage || 
                       sessionInfo.fromWindow;
                       
      if (sessionId) {
        // Log the attempt
        console.log(`[DEBUG] Manual refresh with session ID: ${sessionId}`);
        
        // Force browser to reload cached script files
        const timestamp = new Date().getTime();
        const response = await fetch(`${API_BASE_URL}/api/channels/${sessionId}/categories?_t=${timestamp}`);
        const text = await response.text();
        setApiResponse(text);
        
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            setCategoriesCount(data.length);
            console.log(`[DEBUG] Refreshed: Found ${data.length} categories`);
          }
        } catch (e) {
          console.error('[DEBUG] Parse error on refresh:', e);
        }
      } else {
        console.error('[DEBUG] Cannot refresh - no session ID available');
        setError('No session ID available for refresh');
      }
    } catch (e) {
      console.error('[DEBUG] Error during manual refresh:', e);
      setError(`Refresh error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ 
      border: '3px solid red', 
      borderRadius: '8px',
      padding: '15px',
      margin: '20px 0',
      backgroundColor: '#fff0f0',
      fontFamily: 'monospace',
      fontSize: '13px',
      maxWidth: '800px'
    }}>
      <h2 style={{ margin: '0 0 15px 0', color: '#d32f2f' }}>
        🚨 Session Debugger 🚨
      </h2>
      
      <div style={{ marginBottom: '15px' }}>
        <strong>Status:</strong> {loading ? 
          '⏳ Loading...' : 
          error ? 
            `❌ Error: ${error}` : 
            categoriesCount > 0 ? 
              `✅ Found ${categoriesCount} categories` : 
              '⚠️ No categories found'
        }
      </div>
      
      <table style={{ 
        width: '100%', 
        borderCollapse: 'collapse',
        marginBottom: '15px',
        backgroundColor: 'white'
      }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '8px', border: '1px solid #ddd', backgroundColor: '#f5f5f5' }}>Source</th>
            <th style={{ textAlign: 'left', padding: '8px', border: '1px solid #ddd', backgroundColor: '#f5f5f5' }}>Session ID</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: '8px', border: '1px solid #ddd' }}>localStorage</td>
            <td style={{ padding: '8px', border: '1px solid #ddd', fontWeight: sessionInfo.fromLocalStorage ? 'bold' : 'normal' }}>
              {sessionInfo.fromLocalStorage || 'Not found'}
            </td>
          </tr>
          <tr>
            <td style={{ padding: '8px', border: '1px solid #ddd' }}>SessionManager</td>
            <td style={{ padding: '8px', border: '1px solid #ddd', fontWeight: sessionInfo.fromSessionManager ? 'bold' : 'normal' }}>
              {sessionInfo.fromSessionManager || 'Not found'}
            </td>
          </tr>
          <tr>
            <td style={{ padding: '8px', border: '1px solid #ddd' }}>Window global</td>
            <td style={{ padding: '8px', border: '1px solid #ddd', fontWeight: sessionInfo.fromWindow ? 'bold' : 'normal' }}>
              {sessionInfo.fromWindow || 'Not found'}
            </td>
          </tr>
        </tbody>
      </table>
      
      <div style={{ marginBottom: '15px' }}>
        <h3 style={{ margin: '5px 0', fontSize: '15px' }}>API Response Preview:</h3>
        <pre style={{ 
          maxHeight: '150px',
          overflow: 'auto',
          backgroundColor: '#f8f8f8',
          padding: '10px',
          border: '1px solid #ddd',
          borderRadius: '4px',
          fontSize: '12px',
          whiteSpace: 'pre-wrap'
        }}>
          {apiResponse ? (apiResponse.length > 500 ? apiResponse.substr(0, 500) + '...' : apiResponse) : 'No data'}
        </pre>
      </div>
      
      <div>
        <button 
          onClick={triggerManualRefresh}
          disabled={loading}
          style={{
            backgroundColor: '#2196f3',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '4px',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1
          }}
        >
          {loading ? '⏳ Refreshing...' : '🔄 Refresh Now'}
        </button>
        
        <button 
          onClick={() => {
            // Clear localStorage values related to sessions
            localStorage.removeItem('currentSessionId');
            localStorage.removeItem('sessionId');
            console.log('[DEBUG] Session cleared from localStorage');
            
            // Reload the page to reset everything
            window.location.reload();
          }}
          style={{
            backgroundColor: '#f44336',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '4px',
            cursor: 'pointer',
            marginLeft: '10px'
          }}
        >
          🗑️ Clear Session & Reload
        </button>
      </div>
      
      <div style={{ 
        marginTop: '15px', 
        padding: '10px', 
        backgroundColor: '#fffde7', 
        border: '1px solid #fff59d',
        borderRadius: '4px',
        fontSize: '12px'
      }}>
        <strong>Troubleshooting:</strong>
        <ul style={{ margin: '5px 0 0 0', paddingLeft: '20px' }}>
          <li>Check browser console for detailed logs</li>
          <li>Verify localStorage has a valid session ID</li>
          <li>Make sure the backend server is running</li>
          <li>Try clearing your browser cache</li>
        </ul>
      </div>
    </div>
  );
};

export default SessionDebugger; 