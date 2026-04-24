import React from 'react';
import CastButton from '../CastButton';

/**
 * Top-right overlay with the four control pills: channel info,
 * EPG info, debug, and cast. Hidden in theatre mode — the multi-view
 * UI renders its own scoped controls at the slot level.
 *
 * The EPG button gets a green ring when the channel has a matched EPG
 * id so users can see at a glance whether the guide overlay has data.
 */
export default function PlayerControls({
  theatreMode,
  showChannelInfo,
  showEpgInfo,
  showDebug,
  selectedChannel,
  isMatched,
  onToggleChannelInfo,
  onToggleEpgInfo,
  onToggleDebug,
  isCastAvailable,
  isCasting,
  onCast
}) {
  if (theatreMode === true || theatreMode === 'true') return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        zIndex: 50,
        display: 'flex',
        gap: '8px'
      }}
    >
      <RoundButton
        onClick={onToggleChannelInfo}
        title={showChannelInfo ? 'Hide channel info' : 'Show channel info'}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="16" x2="12" y2="12"></line>
          <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
      </RoundButton>

      <RoundButton
        onClick={onToggleEpgInfo}
        title={showEpgInfo ? 'Hide guide information' : 'Show guide information'}
        highlighted={selectedChannel && isMatched}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
          {!showEpgInfo && <line x1="21" y1="3" x2="3" y2="21"></line>}
        </svg>
      </RoundButton>

      <RoundButton
        onClick={onToggleDebug}
        title={showDebug ? 'Hide debug panel' : 'Show debug panel'}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
      </RoundButton>

      <CastButton
        isCastAvailable={isCastAvailable}
        isCasting={isCasting}
        onClick={onCast}
      />
    </div>
  );
}

function RoundButton({ onClick, title, highlighted, children }) {
  const base = highlighted ? 'rgba(0, 150, 50, 0.5)' : 'rgba(0, 0, 0, 0.5)';
  const hover = highlighted ? 'rgba(0, 180, 60, 0.8)' : 'rgba(30, 30, 30, 0.8)';
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '5px',
        width: '30px',
        height: '30px',
        backgroundColor: base,
        color: 'white',
        border: highlighted ? '2px solid rgba(0, 255, 100, 0.5)' : 'none',
        borderRadius: '50%',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.2s ease',
        position: 'relative'
      }}
      onMouseOver={(e) => (e.currentTarget.style.backgroundColor = hover)}
      onMouseOut={(e) => (e.currentTarget.style.backgroundColor = base)}
    >
      {children}
    </button>
  );
}
