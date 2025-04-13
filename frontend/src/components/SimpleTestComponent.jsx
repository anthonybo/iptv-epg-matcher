import React, { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config';

const SimpleTestComponent = ({ sessionId }) => {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rawResponse, setRawResponse] = useState(null);

  useEffect(() => {
    const fetchCategories = async () => {
      if (!sessionId) {
        setError('No session ID provided');
        setLoading(false);
        return;
      }

      console.log(`[SimpleTest] Fetching categories for session: ${sessionId}`);
      try {
        // Use the fetch API directly for simpler debugging
        const response = await fetch(`${API_BASE_URL}/api/channels/${sessionId}/categories`);
        console.log(`[SimpleTest] Response status: ${response.status}`);
        
        // Get the raw text first to inspect
        const text = await response.text();
        setRawResponse(text);
        console.log(`[SimpleTest] Raw response: ${text.substring(0, 200)}...`);
        
        // Parse the JSON
        try {
          const data = JSON.parse(text);
          console.log('[SimpleTest] Parsed data:', data);
          setCategories(data);
        } catch (parseError) {
          console.error('[SimpleTest] JSON parse error:', parseError);
          setError(`Failed to parse JSON: ${parseError.message}`);
        }
      } catch (fetchError) {
        console.error('[SimpleTest] Fetch error:', fetchError);
        setError(`Failed to fetch: ${fetchError.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchCategories();
  }, [sessionId]);

  // Helper function to format category data for display
  const formatCategory = (cat) => {
    if (typeof cat === 'string') return { name: cat, count: 0 };
    if (typeof cat === 'object') {
      return {
        name: cat.name || cat.category || cat.title || JSON.stringify(cat),
        count: cat.count || cat.channelCount || 0
      };
    }
    return { name: String(cat), count: 0 };
  };

  return (
    <div style={{ 
      border: '3px solid #ff6600', 
      borderRadius: '10px', 
      padding: '20px',
      margin: '20px 0',
      backgroundColor: '#fff4e6' 
    }}>
      <h2>🔍 Simple Categories Test</h2>
      <p><strong>Session ID:</strong> {sessionId || 'Not provided'}</p>
      
      {loading ? (
        <div>Loading categories...</div>
      ) : error ? (
        <div style={{ color: 'red' }}>{error}</div>
      ) : (
        <div>
          <h3>Categories Data ({Array.isArray(categories) ? categories.length : 'not an array'})</h3>
          
          {Array.isArray(categories) && categories.length > 0 ? (
            <ul style={{ maxHeight: '200px', overflow: 'auto', backgroundColor: 'white', padding: '10px' }}>
              {categories.slice(0, 20).map((cat, index) => {
                const formatted = formatCategory(cat);
                return (
                  <li key={index}>
                    {formatted.name} ({formatted.count})
                  </li>
                );
              })}
              {categories.length > 20 && <li>...and {categories.length - 20} more</li>}
            </ul>
          ) : (
            <p>No categories found</p>
          )}
          
          <div style={{ marginTop: '20px' }}>
            <h4>Raw API Response:</h4>
            <pre style={{ 
              maxHeight: '150px', 
              overflow: 'auto', 
              backgroundColor: '#f5f5f5', 
              padding: '10px',
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}>
              {rawResponse ? rawResponse.substring(0, 500) + (rawResponse.length > 500 ? '...' : '') : 'No response'}
            </pre>
          </div>
          
          <div style={{ marginTop: '20px' }}>
            <button 
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 15px',
                backgroundColor: '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                marginRight: '10px'
              }}
            >
              Reload Page
            </button>
            <button 
              onClick={() => {
                localStorage.removeItem('sessionId');
                window.location.reload();
              }}
              style={{
                padding: '10px 15px',
                backgroundColor: '#f44336',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Clear Session & Reload
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SimpleTestComponent; 