import React, { useState, useEffect, useMemo } from 'react';
import { Card, Container, Row, Col, Form, Button, Badge, Spinner, Alert } from 'react-bootstrap';
import axios from 'axios';
import { API_BASE_URL } from '../config';
import ChannelCard from './ChannelCard';
import ChannelFilters from './ChannelFilters';

// Direct test component to debug categories
const CategoryDebugger = ({ sessionId }) => {
  const [rawCategories, setRawCategories] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;
    
    console.log('🔍 CategoryDebugger - Fetching categories directly for session:', sessionId);
    
    const fetchData = async () => {
      try {
        // Direct fetch avoiding any service or helper
        const response = await fetch(`${API_BASE_URL}/api/channels/${sessionId}/categories`);
        console.log('🔍 CategoryDebugger - Response status:', response.status);
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // Get the raw text first to inspect
        const text = await response.text();
        console.log('🔍 CategoryDebugger - Raw response (first 200 chars):', text.substring(0, 200));
        
        try {
          // Parse the JSON
          const data = JSON.parse(text);
          console.log('🔍 CategoryDebugger - Parsed data:', data);
          console.log('🔍 CategoryDebugger - Data type:', typeof data);
          console.log('🔍 CategoryDebugger - Is array:', Array.isArray(data));
          
          if (Array.isArray(data) && data.length > 0) {
            console.log('🔍 CategoryDebugger - First item type:', typeof data[0]);
            console.log('🔍 CategoryDebugger - First item sample:', data[0]);
          }
          
          setRawCategories(data);
        } catch (parseError) {
          console.error('🔍 CategoryDebugger - JSON parse error:', parseError);
          setError(`Failed to parse JSON: ${parseError.message}`);
        }
      } catch (fetchError) {
        console.error('🔍 CategoryDebugger - Fetch error:', fetchError);
        setError(`Failed to fetch categories: ${fetchError.message}`);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [sessionId]);
  
  if (loading) {
    return <div style={{ margin: '20px', padding: '20px', border: '2px solid blue' }}>Loading categories...</div>;
  }
  
  if (error) {
    return <div style={{ margin: '20px', padding: '20px', border: '2px solid red' }}>{error}</div>;
  }
  
  // Directly display raw category data to diagnose issues
  return (
    <div style={{ margin: '20px', padding: '20px', border: '2px solid green', backgroundColor: '#f0fff0' }}>
      <h3>🔍 Category Debugger</h3>
      {rawCategories ? (
        <div>
          <p><strong>Raw data type:</strong> {typeof rawCategories}</p>
          <p><strong>Is array:</strong> {String(Array.isArray(rawCategories))}</p>
          <p><strong>Length:</strong> {Array.isArray(rawCategories) ? rawCategories.length : 'N/A'}</p>
          
          {Array.isArray(rawCategories) && (
            <div>
              <h4>First 10 categories:</h4>
              <ul style={{ maxHeight: '200px', overflow: 'auto', backgroundColor: 'white', padding: '10px' }}>
                {rawCategories.slice(0, 10).map((cat, index) => (
                  <li key={index}>
                    {typeof cat === 'string' ? (
                      cat
                    ) : typeof cat === 'object' ? (
                      `${cat.name || 'Unknown'} (${cat.count || 0})`
                    ) : (
                      JSON.stringify(cat)
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          
          <div style={{ marginTop: '10px' }}>
            <h4>Formatted Categories:</h4>
            <select style={{ width: '100%', padding: '8px' }}>
              <option value="">-- All Categories --</option>
              {Array.isArray(rawCategories) && rawCategories.map((cat, index) => {
                const name = typeof cat === 'string' ? cat : (cat?.name || 'Unknown');
                const count = typeof cat === 'object' ? (cat?.count || 0) : 0;
                return (
                  <option key={index} value={name}>
                    {name} ({count})
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      ) : (
        <p>No categories found!</p>
      )}
    </div>
  );
};

const ChannelsView = ({ sessionId }) => {
  console.log('⚠️ ChannelsView RENDER - Session ID:', sessionId);

  const [channels, setChannels] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const limit = 1000; // Number of channels per page

  // Fetch categories first
  useEffect(() => {
    if (!sessionId) {
      console.log('⚠️ ChannelsView - No session ID provided');
      return;
    }
    
    console.log('⚠️ ChannelsView - Starting to fetch categories and channels for session:', sessionId);
    setLoading(true);
    
    // Direct fetch to avoid any service layer issues
    fetch(`${API_BASE_URL}/api/channels/${sessionId}/categories`)
      .then(response => {
        console.log('⚠️ ChannelsView - Categories response status:', response.status);
        
        if (!response.ok) {
          throw new Error(`Categories API error: ${response.status}`);
        }
        
        // Get raw text first for better debugging
        return response.text();
      })
      .then(text => {
        console.log('⚠️ ChannelsView - Raw categories text:', text.substring(0, 200));
        
        try {
          const data = JSON.parse(text);
          console.log('⚠️ ChannelsView - Parsed categories:', data);
          console.log('⚠️ ChannelsView - Categories data type:', typeof data);
          console.log('⚠️ ChannelsView - Is array:', Array.isArray(data));
          
          if (Array.isArray(data)) {
            if (data.length > 0) {
              console.log('⚠️ ChannelsView - First few categories:', data.slice(0, 3));
              console.log('⚠️ ChannelsView - First item type:', typeof data[0]);
            }
            
            // Format the categories
            const formattedCategories = data.map(cat => {
              if (typeof cat === 'string') {
                return { name: cat, count: 0 };
              } else if (typeof cat === 'object') {
                return {
                  name: cat.name || cat.category || cat.title || 'Unknown',
                  count: cat.count || cat.channelCount || 0
                };
              }
              return { name: String(cat), count: 0 };
            });
            
            console.log('⚠️ ChannelsView - Formatted categories:', formattedCategories.slice(0, 3));
            console.log(`⚠️ ChannelsView - Setting ${formattedCategories.length} categories`);
            setCategories(formattedCategories);
          } else {
            console.error('⚠️ ChannelsView - Categories is not an array:', data);
            setError('Invalid categories format received from server');
          }
        } catch (parseError) {
          console.error('⚠️ ChannelsView - JSON parse error:', parseError);
          setError(`Failed to parse categories: ${parseError.message}`);
        }
      })
      .catch(err => {
        console.error('⚠️ ChannelsView - Error fetching categories:', err);
        setError(`Failed to load categories: ${err.message}`);
      })
      .finally(() => {
        // Now fetch channels
        console.log('⚠️ ChannelsView - Fetching channels next');
        fetchChannels(1);
      });
  }, [sessionId]);

  // Add debugging for render
  useEffect(() => {
    console.log('⚠️ ChannelsView - Categories state updated:', {
      count: categories.length,
      sample: categories.slice(0, 3),
      isArray: Array.isArray(categories)
    });
  }, [categories]);

  // Add debug output for selectedCategory
  useEffect(() => {
    console.log('⚠️ ChannelsView - Selected category changed:', selectedCategory);
  }, [selectedCategory]);

  const fetchChannels = (pageNum) => {
    console.log(`⚠️ ChannelsView - Fetching channels page ${pageNum} for session ${sessionId}`);
    setLoading(true);
    
    const url = `${API_BASE_URL}/api/channels/${sessionId}?page=${pageNum}&limit=${limit}${selectedCategory !== 'all' ? `&category=${selectedCategory}` : ''}`;
    console.log('⚠️ ChannelsView - Channels fetch URL:', url);
    
    // Direct fetch for debugging
    fetch(url)
      .then(response => {
        console.log('⚠️ ChannelsView - Channels response status:', response.status);
        
        if (!response.ok) {
          throw new Error(`Channels API error: ${response.status}`);
        }
        
        return response.json();
      })
      .then(data => {
        console.log('⚠️ ChannelsView - Channels data received:', {
          total: data.totalChannels,
          received: data.channels?.length || 0,
          hasCategories: !!data.categories,
          categoriesCount: data.categories?.length || 0
        });
        
        if (data.channels) {
          setChannels(prevChannels => (pageNum === 1 ? data.channels : [...prevChannels, ...data.channels]));
          setHasMore(data.channels.length === limit);
        }
        
        // If we also got categories in the response, use them
        if (data.categories && Array.isArray(data.categories) && data.categories.length > 0 && categories.length === 0) {
          console.log('⚠️ ChannelsView - Got categories from channels response:', data.categories.slice(0, 3));
          setCategories(data.categories);
        }
      })
      .catch(err => {
        console.error('⚠️ ChannelsView - Error fetching channels:', err);
        setError(`Failed to load channels: ${err.message}`);
      })
      .finally(() => {
        setLoading(false);
        setPage(pageNum);
      });
  };

  const handleCategoryChange = (category) => {
    console.log('⚠️ ChannelsView - Category changed to:', category);
    setSelectedCategory(category);
    // Reset to page 1 when changing filters
    setPage(1);
    fetchChannels(1);
  };

  const filteredChannels = useMemo(() => {
    console.log('⚠️ ChannelsView - Filtering channels:', {
      total: channels.length,
      category: selectedCategory,
      searchTerm: searchTerm
    });
    
    return channels.filter(channel => {
      // Filter by category
      const categoryMatch = selectedCategory === 'all' || 
                           (channel.groupTitle && channel.groupTitle.toLowerCase() === selectedCategory.toLowerCase());
      
      // Filter by search term
      const searchMatch = !searchTerm || 
                          (channel.name && channel.name.toLowerCase().includes(searchTerm.toLowerCase()));
      
      return categoryMatch && searchMatch;
    });
  }, [channels, selectedCategory, searchTerm]);

  console.log('⚠️ ChannelsView - Render info:', {
    channelsCount: channels.length,
    filteredCount: filteredChannels.length,
    categoriesCount: categories.length,
    selectedCategory,
    loading
  });

  return (
    <Container fluid className="my-4">
      {/* Add the direct category debugger at the top */}
      <CategoryDebugger sessionId={sessionId} />
      
      {error && <Alert variant="danger">{error}</Alert>}
      
      {/* Debug categories list */}
      <div style={{
        margin: '20px 0',
        padding: '15px',
        border: '2px solid purple',
        borderRadius: '5px',
        backgroundColor: '#f8f0ff'
      }}>
        <h3>Categories Debug Info ({categories.length})</h3>
        <p><strong>Using sessionId:</strong> {sessionId}</p>
        <p><strong>Categories state:</strong> {JSON.stringify(categories.slice(0, 3))}</p>
        <div style={{ marginTop: '10px' }}>
          <button 
            onClick={() => console.log('All categories:', categories)}
            style={{
              padding: '5px 10px',
              backgroundColor: 'purple',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              marginRight: '10px'
            }}
          >
            Log All Categories
          </button>
          <button 
            onClick={() => {
              // Manually fetch categories
              fetch(`${API_BASE_URL}/api/channels/${sessionId}/categories`)
                .then(response => response.text())
                .then(text => {
                  console.log('Manual categories fetch:', text);
                  try {
                    const data = JSON.parse(text);
                    setCategories(data);
                    alert(`Manually fetched ${data.length} categories`);
                  } catch (err) {
                    alert(`Error parsing categories: ${err.message}`);
                  }
                })
                .catch(err => alert(`Error fetching: ${err.message}`));
            }}
            style={{
              padding: '5px 10px',
              backgroundColor: 'green',
              color: 'white',
              border: 'none',
              borderRadius: '3px'
            }}
          >
            Force Fetch Categories
          </button>
        </div>
      </div>
      
      <Row>
        <Col md={3}>
          <Card>
            <Card.Body>
              <Card.Title>Filters</Card.Title>
              <Form.Group>
                <Form.Label>Categories</Form.Label>
                <Form.Select 
                  value={selectedCategory}
                  onChange={(e) => handleCategoryChange(e.target.value)}
                >
                  <option value="all">All Categories</option>
                  {categories.map((category, index) => {
                    // Handle any possible category format
                    const name = typeof category === 'string' 
                      ? category 
                      : category.name || category.title || category.category || 
                        (typeof category === 'object' ? JSON.stringify(category) : String(category));
                    
                    const count = typeof category === 'object' && category.count !== undefined 
                      ? category.count 
                      : '';
                    
                    const displayText = count ? `${name} (${count})` : name;
                    
                    return (
                      <option key={`cat-${index}-${name}`} value={name}>
                        {displayText}
                      </option>
                    );
                  })}
                </Form.Select>
              </Form.Group>
              <Form.Group className="mt-3">
                <Form.Label>Search</Form.Label>
                <Form.Control
                  type="text"
                  placeholder="Search channels"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </Form.Group>
            </Card.Body>
          </Card>
        </Col>
        <Col md={9}>
          <Card>
            <Card.Body>
              <Card.Title>
                Channels
                {selectedCategory !== 'all' && (
                  <Badge bg="primary" className="ms-2">{selectedCategory}</Badge>
                )}
              </Card.Title>
              <Card.Subtitle className="mb-3 text-muted">
                Showing {filteredChannels.length} channels
              </Card.Subtitle>
              
              {loading && channels.length === 0 ? (
                <div className="text-center my-4">
                  <Spinner animation="border" />
                  <p className="mt-2">Loading channels...</p>
                </div>
              ) : (
                <>
                  <Row>
                    {filteredChannels.map(channel => (
                      <Col key={channel.id} xs={12} sm={6} md={4} lg={3} className="mb-3">
                        <ChannelCard channel={channel} />
                      </Col>
                    ))}
                  </Row>
                  
                  {filteredChannels.length === 0 && !loading && (
                    <Alert variant="info">
                      No channels found with the current filters.
                    </Alert>
                  )}
                  
                  {hasMore && (
                    <div className="text-center mt-3">
                      <Button 
                        variant="primary" 
                        onClick={() => fetchChannels(page + 1)}
                        disabled={loading}
                      >
                        {loading ? (
                          <>
                            <Spinner
                              as="span"
                              animation="border"
                              size="sm"
                              role="status"
                              aria-hidden="true"
                              className="me-2"
                            />
                            Loading...
                          </>
                        ) : (
                          'Load More'
                        )}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default ChannelsView;