import React from 'react';

/**
 * StatusDisplay component for showing status messages
 * 
 * @param {Object} props Component properties
 * @param {string} props.message The message to display
 * @param {string} props.type Message type ('info', 'success', 'error', 'warning')
 * @returns {JSX.Element} Status message display
 */
const StatusDisplay = ({ message, type = 'info' }) => {
  if (!message) return null;
  
  // Format status message
  const getStatusStyle = () => {
    const baseStyle = {
      padding: '12px 15px',
      borderRadius: '8px',
      animation: 'fadeIn 0.3s ease',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      marginBottom: '15px'
    };
    
    switch (type) {
      case 'success':
        return {
          ...baseStyle,
          backgroundColor: '#e8f5e9',
          border: '1px solid #c8e6c9',
          color: '#2e7d32'
        };
      case 'error':
        return {
          ...baseStyle,
          backgroundColor: '#ffebee',
          border: '1px solid #ffcdd2',
          color: '#c62828'
        };
      case 'warning':
        return {
          ...baseStyle,
          backgroundColor: '#fff8e1',
          border: '1px solid #ffecb3',
          color: '#f57f17'
        };
      case 'info':
      default:
        return {
          ...baseStyle,
          backgroundColor: '#e3f2fd',
          border: '1px solid #bbdefb',
          color: '#1565c0'
        };
    }
  };

  // Get status icon
  const getStatusIcon = () => {
    switch (type) {
      case 'success':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
        );
      case 'error':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        );
      case 'warning':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        );
      case 'info':
      default:
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        );
    }
  };

  return (
    <div style={getStatusStyle()}>
      {getStatusIcon()}
      <span>{message}</span>
    </div>
  );
};

export default StatusDisplay;