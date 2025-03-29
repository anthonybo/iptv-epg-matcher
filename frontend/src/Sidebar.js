import React from 'react';

/**
 * Sidebar component for navigation
 * 
 * @param {Object} props Component properties
 * @param {boolean} props.showSidebar Whether the sidebar is visible
 * @param {string} props.activeTab Current active tab
 * @param {Function} props.setActiveTab Function to set the active tab
 * @param {Function} props.handleReset Function to reset the app
 * @param {number} props.totalChannels Total number of channels
 * @param {number} props.categoryCount Number of categories
 * @param {number} props.matchedChannelCount Number of matched channels
 * @param {number} props.epgSourceCount Number of EPG sources
 * @returns {JSX.Element} Sidebar UI
 */
const Sidebar = ({ 
  showSidebar, 
  activeTab, 
  setActiveTab, 
  handleReset,
  totalChannels = 0,
  categoryCount = 0,
  matchedChannelCount = 0,
  epgSourceCount = 0
}) => {
  // TabButton component for navigation
  const TabButton = ({ id, label, icon, isActive, onClick, count }) => (
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
        width: '100%',
        justifyContent: 'space-between'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {icon}
        <span>{label}</span>
      </div>
      {count !== undefined && count > 0 && (
        <span style={{
          backgroundColor: isActive ? 'rgba(255, 255, 255, 0.3)' : '#f0f0f0',
          borderRadius: '10px',
          padding: '2px 8px',
          fontSize: '12px',
          minWidth: '24px',
          textAlign: 'center'
        }}>
          {count}
        </span>
      )}
    </button>
  );

  return (
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
            label="Channels" 
            isActive={activeTab === 'channels'} 
            onClick={setActiveTab}
            count={totalChannels}
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
      {totalChannels > 0 && (
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
              <span style={{ fontWeight: '500' }}>{categoryCount}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span>EPG Matches:</span>
              <span style={{ fontWeight: '500' }}>{matchedChannelCount}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span>EPG Sources:</span>
              <span style={{ fontWeight: '500' }}>{epgSourceCount}</span>
            </div>
          </div>
          
          <div style={{ marginTop: '15px' }}>
            <button 
              onClick={handleReset}
              style={{
                padding: '8px 16px',
                backgroundColor: '#f5f5f5',
                color: '#333',
                border: '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                fontSize: '14px',
                fontWeight: '500',
                width: '100%'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38"></path>
              </svg>
              Reset Application
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Sidebar;