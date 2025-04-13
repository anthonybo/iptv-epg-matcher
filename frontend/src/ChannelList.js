import React, { useState, useEffect } from 'react';
import axios from 'axios';

/**
 * ChannelList component for displaying and filtering channels
 * 
 * @param {Object} props Component properties
 * @param {Array} props.channels List of channels to display
 * @param {number} props.totalChannels Total number of channels available
 * @param {Function} props.onChannelSelect Callback when channel is selected
 * @param {Object} props.selectedChannel Currently selected channel
 * @param {Object} props.matchedChannels Object mapping channel IDs to matched EPG IDs
 * @param {Array} props.hiddenCategories List of category names that are hidden
 * @param {string} props.selectedCategory Currently selected category name
 * @param {string} props.sessionId Current session ID
 * @param {boolean} props.isLoading Loading state flag
 * @param {Function} props.loadMoreChannels Callback to load more channels
 * @returns {JSX.Element} Channel list UI
 */
const ChannelList = ({ 
  channels = [],
  totalChannels = 0,
  onChannelSelect,
  selectedChannel,
  matchedChannels = {},
  hiddenCategories = [],
  selectedCategory,
  sessionId,
  isLoading = false,
  loadMoreChannels
}) => {
  // Local state
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  
  // Filter channels based on search and visibility
  const filteredChannels = channels.filter(ch => {
    const matchesSearch = ch.name.toLowerCase().includes(search.toLowerCase());
    const isVisible = !hiddenCategories.includes(ch.groupTitle);
    
    // Debug logging for all channels to diagnose our filtering issue
    // console.log(`Channel filtering for "${ch.name}":`, {
    //   category: ch.groupTitle,
    //   matchesSearch,
    //   isVisible,
    //   isHidden: hiddenCategories.includes(ch.groupTitle),
    //   hiddenCategoriesCount: hiddenCategories.length
    // });
    
    return matchesSearch && isVisible;
  });

  // Add a debugging message when no channels are found
  React.useEffect(() => {
    if (channels.length > 0 && filteredChannels.length === 0) {
      console.log('No channels match filters:', {
        totalChannels: channels.length,
        hiddenCategories,
        availableCategories: [...new Set(channels.map(ch => ch.groupTitle))],
        visibleCategories: [...new Set(channels.map(ch => ch.groupTitle))].filter(cat => !hiddenCategories.includes(cat)),
        searchTerm: search
      });
    }
  }, [channels, filteredChannels, hiddenCategories, search]);

  return (
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
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{
                position: 'absolute',
                right: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px',
                color: '#999'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
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
                onClick={() => onChannelSelect(ch)}
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
                    onChannelSelect(ch);
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
            <button 
              onClick={() => loadMoreChannels()} 
              disabled={isLoading}
              style={{
                padding: '8px 16px',
                backgroundColor: isLoading ? '#e0e0e0' : '#f5f5f5',
                color: isLoading ? '#999' : '#333',
                border: '1px solid #ddd',
                borderRadius: '6px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                fontSize: '14px',
                fontWeight: '500',
                margin: '0 auto'
              }}
            >
              {isLoading ? (
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
              {isLoading ? 'Loading...' : 'Load More Channels'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChannelList;