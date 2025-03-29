import React from 'react';

/**
 * ResultView component for displaying generated credentials
 * 
 * @param {Object} props Component properties
 * @param {Object} props.result The generated result containing credentials
 * @param {Function} props.onCopyToClipboard Callback when copying text to clipboard
 * @param {Function} props.onBackToPlayer Callback to go back to player
 * @returns {JSX.Element} Result view UI
 */
const ResultView = ({ result, onCopyToClipboard, onBackToPlayer }) => {
  if (!result) {
    return (
      <div style={{ padding: '20px' }}>
        <h2 style={{ 
          marginTop: 0, 
          color: '#333', 
          fontWeight: '500',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          XTREAM Credentials
        </h2>
        
        <div style={{ 
          padding: '40px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
          textAlign: 'center',
          color: '#666'
        }}>
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="64" 
            height="64" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1" 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            style={{ marginBottom: '20px', opacity: 0.5 }}
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <h3 style={{ 
            margin: '0 0 15px 0',
            color: '#444',
            fontWeight: '500'
          }}>
            No Results Yet
          </h3>
          <p style={{ margin: '0 0 20px 0' }}>
            Match channels with EPG data and generate credentials to see results here.
          </p>
          <button 
            onClick={onBackToPlayer}
            style={{
              padding: '10px 16px',
              backgroundColor: '#1a73e8',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              fontSize: '14px',
              fontWeight: '500',
              margin: '0 auto'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polygon points="10 8 16 12 10 16 10 8"></polygon>
            </svg>
            Go to Player & Matcher
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <h2 style={{ 
        marginTop: 0, 
        color: '#333', 
        fontWeight: '500',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        New XTREAM Credentials
      </h2>
      
      <div style={{ 
        backgroundColor: 'white',
        padding: '25px',
        borderRadius: '8px',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.05)',
        border: '1px solid #eee'
      }}>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'auto 1fr auto', 
          gap: '15px',
          alignItems: 'center'
        }}>
          <div style={{ 
            fontWeight: '500', 
            fontSize: '14px', 
            color: '#444'
          }}>Server URL:</div>
          <div style={{ 
            padding: '12px',
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            overflowX: 'auto',
            fontSize: '14px',
            color: '#333',
            border: '1px solid #eee'
          }}>{result.xtreamUrl}</div>
          <button 
            onClick={() => onCopyToClipboard(result.xtreamUrl)}
            style={{
              padding: '8px 12px',
              backgroundColor: '#f5f5f5',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
          
          <div style={{ 
            fontWeight: '500', 
            fontSize: '14px', 
            color: '#444'
          }}>EPG URL:</div>
          <div style={{ 
            padding: '12px',
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            overflowX: 'auto',
            fontSize: '14px',
            color: '#333',
            border: '1px solid #eee'
          }}>{result.xtreamEpgUrl}</div>
          <button 
            onClick={() => onCopyToClipboard(result.xtreamEpgUrl)}
            style={{
              padding: '8px 12px',
              backgroundColor: '#f5f5f5',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
          
          <div style={{ 
            fontWeight: '500', 
            fontSize: '14px', 
            color: '#444'
          }}>Username:</div>
          <div style={{ 
            padding: '12px',
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            fontSize: '14px',
            color: '#333',
            border: '1px solid #eee'
          }}>{result.username}</div>
          <button 
            onClick={() => onCopyToClipboard(result.username)}
            style={{
              padding: '8px 12px',
              backgroundColor: '#f5f5f5',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
          
          <div style={{ 
            fontWeight: '500', 
            fontSize: '14px', 
            color: '#444'
          }}>Password:</div>
          <div style={{ 
            padding: '12px',
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            fontSize: '14px',
            color: '#333',
            border: '1px solid #eee'
          }}>{result.password}</div>
          <button 
            onClick={() => onCopyToClipboard(result.password)}
            style={{
              padding: '8px 12px',
              backgroundColor: '#f5f5f5',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
        </div>
        
        <div style={{ 
          marginTop: '30px', 
          textAlign: 'center',
          display: 'flex',
          justifyContent: 'center',
          gap: '15px',
          flexWrap: 'wrap'
        }}>
          <a 
            href={result.downloadUrl} 
            style={{
              padding: '10px 16px',
              backgroundColor: '#1a73e8',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '14px',
              fontWeight: '500'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download EPG File
          </a>
          
          <button 
            onClick={onBackToPlayer}
            style={{
              padding: '10px 16px',
              backgroundColor: '#f5f5f5',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '14px',
              fontWeight: '500'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polygon points="10 8 16 12 10 16 10 8"></polygon>
            </svg>
            Back to Player
          </button>
        </div>
      </div>
      
      <div style={{ 
        marginTop: '25px',
        backgroundColor: '#e8f5e9',
        padding: '15px',
        borderRadius: '8px',
        border: '1px solid #c8e6c9',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px'
      }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ minWidth: '20px', marginTop: '3px' }}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <div>
          <p style={{ 
            margin: '0 0 8px 0', 
            fontWeight: '500',
            color: '#2e7d32'
          }}>
            Success! Your new XTREAM credentials have been generated.
          </p>
          <p style={{ margin: '0', color: '#444' }}>
            You can now use these credentials in your IPTV player app. The updated playlist includes all your channels with matched EPG data. Copy the Server URL, Username, and Password to your IPTV player, or download the EPG file for standalone usage.
          </p>
          <p style={{ margin: '10px 0 0 0', color: '#444' }}>
            <strong>Note:</strong> These credentials will work as long as the backend service is running. To save this configuration permanently, use the download option.
          </p>
        </div>
      </div>
    </div>
  );
};

export default ResultView;