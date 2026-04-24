import React from 'react';

/**
 * Centered "Loading..." spinner shown while the player is starting
 * a stream (between selection and the first 'playing' event).
 */
export default function PlayerLoadingOverlay({ visible }) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        padding: '15px 25px',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        color: 'white',
        borderRadius: '8px',
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}
    >
      <div
        className="loading-spinner"
        style={{
          display: 'inline-block',
          width: '20px',
          height: '20px',
          border: '3px solid rgba(255,255,255,0.3)',
          borderRadius: '50%',
          borderTopColor: 'white',
          animation: 'spin 1s linear infinite'
        }}
      />
      <span>Loading...</span>
    </div>
  );
}
