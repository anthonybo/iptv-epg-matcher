import React, { useState, useEffect, useContext } from 'react';
import { SessionContext } from './App';

// Simple direct categories component
const SimpleCategories = () => {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  
  // Try to get session ID from context
  const sessionContext = useContext(SessionContext);
  const contextSessionId = sessionContext?.sessionId;

  // Get session ID from all possible locations
  const getSessionId = () => {
    // First try context
    if (contextSessionId) {
      console.log('Using session ID from context:', contextSessionId);
      return contextSessionId;
    }

    // Try different localStorage keys
    const keys = ['sessionId', 'currentSession', 'session', 'iptv-session-id'];
    for (const key of keys) {
      const savedSession = localStorage.getItem(key);
      if (savedSession) {
        console.log(`Retrieved session ID from localStorage[${key}]:`, savedSession);
        return savedSession;
      }
    }
    
    // As a last resort, check for any key that might contain 'session'
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.toLowerCase().includes('session')) {
        const value = localStorage.getItem(key);
        console.log(`Found potential session ID in localStorage[${key}]:`, value);
        return value;
      }
    }
    
    console.warn('No session ID found in any storage location');
    return null;
  };

  // Add a direct manual fetch function
  const manualFetch = async (sid) => {
    if (!sid) {
      alert('No session ID provided');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      console.log(`Manual fetch - Using session ID: ${sid}`);
      const response = await fetch(`/api/channels/${sid}/categories`);
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const text = await response.text();
      console.log('Manual fetch - Raw response:', text.substring(0, 200));
      
      try {
        const data = JSON.parse(text);
        console.log('Manual fetch - Parsed data:', data);
        
        if (Array.isArray(data)) {
          setCategories(data);
          setLoading(false);
          return data;
        } else {
          console.error('Manual fetch - Response is not an array:', data);
          setError('Invalid data format - not an array');
        }
      } catch (parseError) {
        console.error('Manual fetch - Parse error:', parseError);
        setError(`JSON parse error: ${parseError.message}`);
      }
    } catch (fetchError) {
      console.error('Manual fetch - Network error:', fetchError);
      setError(`Network error: ${fetchError.message}`);
    } finally {
      setLoading(false);
    }
    
    return null;
  };

  useEffect(() => {
    const fetchCategories = async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        setError('No session ID found in any storage location');
        setLoading(false);
        return;
      }

      try {
        // Direct fetch to the API
        console.log(`Fetching categories for session: ${sessionId}`);
        const response = await fetch(`/api/channels/${sessionId}/categories`);
        console.log('Response status:', response.status);
        
        if (!response.ok) {
          throw new Error(`Error fetching categories: ${response.status}`);
        }
        
        // Get text first for debugging
        const text = await response.text();
        console.log('Raw response text (first 200 chars):', text.substring(0, 200));
        
        // Parse JSON
        const data = JSON.parse(text);
        console.log('Parsed categories data:', data);
        console.log('Categories count:', Array.isArray(data) ? data.length : 'not an array');
        
        // Set categories state
        if (Array.isArray(data)) {
          setCategories(data);
        } else {
          console.error('Categories response is not an array:', data);
          setError('Invalid categories format');
        }
      } catch (err) {
        console.error('Error fetching categories:', err);
        setError(`Failed to load categories: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchCategories();
  }, [contextSessionId]);

  if (loading) {
    return <div>Loading categories...</div>;
  }

  // Add session ID input for testing
  const SessionIdInput = () => {
    const [inputSessionId, setInputSessionId] = useState('');
    
    return (
      <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc', borderRadius: '5px' }}>
        <h3>Test with Custom Session ID</h3>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input 
            type="text" 
            value={inputSessionId} 
            onChange={(e) => setInputSessionId(e.target.value)}
            placeholder="Enter session ID to test" 
            style={{ flex: '1', padding: '8px' }}
          />
          <button 
            onClick={() => manualFetch(inputSessionId)}
            style={{ padding: '8px 15px', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '4px' }}
          >
            Fetch
          </button>
        </div>
      </div>
    );
  };

  if (error) {
    return (
      <div>
        <SessionIdInput />
        <div style={{ color: 'red', marginBottom: '20px' }}>Error: {error}</div>
        <button 
          onClick={() => window.location.href = '/'}
          style={{ padding: '10px', backgroundColor: '#f44336', color: 'white', border: 'none', borderRadius: '4px' }}
        >
          Go to Home
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <SessionIdInput />
      <h2>Categories ({categories.length})</h2>
      
      {categories.length > 0 ? (
        <div>
          <select 
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            style={{ width: '100%', padding: '10px', marginBottom: '20px' }}
          >
            <option value="all">All Categories</option>
            {categories.map((category, index) => {
              const name = typeof category === 'string' ? category : (category.name || 'Unknown');
              const count = typeof category === 'object' && category.count ? ` (${category.count})` : '';
              return (
                <option key={index} value={name}>
                  {name}{count}
                </option>
              );
            })}
          </select>
          
          <h3>Categories List:</h3>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', 
            gap: '10px' 
          }}>
            {categories.map((category, index) => {
              const name = typeof category === 'string' ? category : (category.name || 'Unknown');
              const count = typeof category === 'object' && category.count ? category.count : '?';
              
              return (
                <div key={index} style={{ 
                  padding: '10px', 
                  border: '1px solid #ccc', 
                  borderRadius: '5px',
                  backgroundColor: selectedCategory === name ? '#e6f7ff' : '#f5f5f5'
                }}>
                  <div><strong>{name}</strong></div>
                  <div>{count} channels</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ color: 'red', fontWeight: 'bold' }}>
          No categories found!
        </div>
      )}
      
      <div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#f0f0f0', borderRadius: '5px' }}>
        <h3>Debug Info</h3>
        <p><strong>Current Session ID:</strong> {getSessionId() || 'None'}</p>
        <p><strong>Categories Count:</strong> {categories.length}</p>
        <p><strong>Categories Data Type:</strong> {typeof categories}</p>
        <p><strong>Is Array:</strong> {String(Array.isArray(categories))}</p>
        <p><strong>Selected Category:</strong> {selectedCategory}</p>
        
        {categories.length > 0 && (
          <>
            <p><strong>First Category Type:</strong> {typeof categories[0]}</p>
            <p><strong>First Category Data:</strong> {JSON.stringify(categories[0])}</p>
            <button 
              onClick={() => console.log('Categories data:', categories)}
              style={{ padding: '5px 10px', marginRight: '10px' }}
            >
              Log Categories
            </button>
            <button 
              onClick={() => alert(JSON.stringify(categories.slice(0, 10), null, 2))}
              style={{ padding: '5px 10px' }}
            >
              Show First 10
            </button>
          </>
        )}
        
        <div style={{ marginTop: '20px' }}>
          <button
            onClick={() => window.location.href = '/'}
            style={{ padding: '8px 15px', marginRight: '10px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}
          >
            Home
          </button>
          <button
            onClick={() => window.location.href = '/channels'}
            style={{ padding: '8px 15px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}
          >
            Channels
          </button>
        </div>
      </div>
    </div>
  );
};

export default SimpleCategories; 