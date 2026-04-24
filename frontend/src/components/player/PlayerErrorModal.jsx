import React from 'react';

/**
 * Red "Stream Error" modal shown at the center of the player when
 * something's wrong (network error, corruption, find-alternative
 * status, etc.). The error text is controlled by the parent via
 * the `error` prop; the parent can replace it at runtime (we do
 * this via a window event to stream find-alternative progress).
 *
 * Renders nothing when `error` is falsy.
 */
export default function PlayerErrorModal({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 100,
        backgroundColor: 'rgba(220, 38, 38, 0.95)',
        color: 'white',
        padding: '20px 30px',
        borderRadius: '12px',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
        maxWidth: '80%',
        textAlign: 'center'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '12px' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span style={{ fontSize: '18px', fontWeight: 'bold' }}>Stream Error</span>
      </div>
      <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: '1.5' }}>{error}</p>
      <button
        onClick={onDismiss}
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.2)',
          color: 'white',
          border: 'none',
          padding: '8px 20px',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: '600',
          transition: 'background-color 0.2s'
        }}
        onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.3)')}
        onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)')}
      >
        Dismiss
      </button>
    </div>
  );
}
