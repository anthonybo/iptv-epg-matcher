import React, { useState } from 'react';

/**
 * Component for loading EPG data from sources
 * Provides a prominent button and helpful messaging
 */
const EpgDataLoader = ({ sessionId, onSuccess, maxSources = 5 }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  
  const loadEpgData = async () => {
    if (!sessionId) {
      setError("No session ID available");
      return;
    }
    
    setLoading(true);
    setError(null);
    setSuccess(false);
    
    try {
      console.log('Manually loading EPG channel data from sources...');
      
      // First ensure the EPG session is initialized
      const initResponse = await fetch('/api/epg/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      
      if (!initResponse.ok) {
        throw new Error(`Failed to initialize EPG session: ${initResponse.status}`);
      }
      
      // Now load the EPG data
      const loadResponse = await fetch(`/api/epg/${sessionId}/load-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loadAll: true, maxSources })
      });
      
      if (!loadResponse.ok) {
        throw new Error(`Failed to load EPG data: ${loadResponse.status}`);
      }
      
      const result = await loadResponse.json();
      console.log('EPG data load result:', result);
      
      setSuccess(true);
      
      if (onSuccess && typeof onSuccess === 'function') {
        onSuccess(result);
      }
    } catch (err) {
      console.error('Error loading EPG data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div style={{
      margin: '20px 0',
      padding: '15px',
      backgroundColor: success ? '#e8f5e9' : '#e3f2fd',
      borderRadius: '8px',
      border: `1px solid ${success ? '#a5d6a7' : '#90caf9'}`,
      textAlign: 'center'
    }}>
      <h4 style={{ margin: '0 0 10px 0', color: success ? '#2e7d32' : '#1565c0' }}>
        {success ? 'EPG Data Loaded Successfully' : 'EPG Data Required'}
      </h4>
      
      {!success && (
        <p style={{ margin: '0 0 15px 0' }}>
          Your EPG sources are registered but have 0 channels loaded. You need to load EPG data before you can search or match channels.
        </p>
      )}
      
      {success && (
        <p style={{ margin: '0 0 15px 0', color: '#2e7d32' }}>
          EPG data has been loaded successfully. You can now search for channels and match them with your playlist.
        </p>
      )}
      
      <button
        onClick={loadEpgData}
        disabled={loading}
        style={{
          padding: '10px 20px',
          backgroundColor: success ? '#43a047' : '#1976d2',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: loading ? 'not-allowed' : 'pointer',
          fontSize: '16px',
          fontWeight: 'bold'
        }}
      >
        {loading ? 'Loading EPG Data...' : success ? 'Reload EPG Data' : 'Load EPG Data Now'}
      </button>
      
      {error && (
        <div style={{ 
          color: 'white', 
          marginTop: '10px',
          backgroundColor: '#f44336',
          padding: '8px',
          borderRadius: '4px',
          textAlign: 'left'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}
      
      <p style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
        This will download and parse up to {maxSources} EPG sources (may take a few minutes)
      </p>
    </div>
  );
};

export default EpgDataLoader; 