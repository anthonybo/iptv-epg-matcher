import React from 'react';

/**
 * Thin blue "Reconnecting (soft N/N)..." bar shown along the bottom
 * edge while the player is retrying. Controlled by the parent's
 * `recoveryStatus` state — null when no recovery is in progress.
 */
export default function PlayerRecoveryBanner({ recoveryStatus }) {
  if (!recoveryStatus) return null;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '6px 12px',
        backgroundColor: 'rgba(59, 130, 246, 0.95)',
        color: 'white',
        zIndex: 45,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        backdropFilter: 'blur(5px)',
        borderTop: '1px solid rgba(96, 165, 250, 0.3)',
        fontSize: '13px',
        fontWeight: '500'
      }}
    >
      <svg
        className="animate-spin"
        style={{ animation: 'spin 1s linear infinite', width: '14px', height: '14px' }}
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span>{recoveryStatus}</span>
    </div>
  );
}
