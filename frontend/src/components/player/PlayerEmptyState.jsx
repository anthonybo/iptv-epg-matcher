import React from 'react';

/**
 * "Select a channel to play" placeholder shown when no channel is
 * currently selected. Hidden as soon as a channel is attached.
 */
export default function PlayerEmptyState({ visible }) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        color: '#aaa',
        zIndex: 20,
        textAlign: 'center'
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.5, marginBottom: '15px' }}
      >
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
        <polyline points="17 2 12 7 7 2"></polyline>
      </svg>
      <div>Select a channel to play</div>
    </div>
  );
}
