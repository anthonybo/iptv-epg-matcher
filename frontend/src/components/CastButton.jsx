import React from 'react';

/**
 * CastButton - Google Cast button component
 * @param {boolean} isCastAvailable - Whether Cast is available
 * @param {boolean} isCasting - Whether currently casting
 * @param {Function} onClick - Click handler
 * @param {string} className - Additional CSS classes
 */
const CastButton = ({ isCastAvailable, isCasting, onClick, className = '' }) => {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px',
        width: '30px',
        height: '30px',
        backgroundColor: isCasting ? 'rgba(59, 130, 246, 0.8)' : 'rgba(0, 0, 0, 0.5)',
        color: 'white',
        border: 'none',
        borderRadius: '50%',
        cursor: 'pointer',
        display: isCastAvailable ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background-color 0.2s ease'
      }}
      onMouseOver={(e) => e.currentTarget.style.backgroundColor = isCasting ? 'rgba(59, 130, 246, 1)' : 'rgba(30, 30, 30, 0.8)'}
      onMouseOut={(e) => e.currentTarget.style.backgroundColor = isCasting ? 'rgba(59, 130, 246, 0.8)' : 'rgba(0, 0, 0, 0.5)'}
      title={isCasting ? 'Stop Casting' : 'Cast to TV'}
    >
      {isCasting ? (
        // Casting active icon
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
          <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
        </svg>
      ) : (
        // Cast icon
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
          <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
        </svg>
      )}
    </button>
  );
};

export default CastButton;
