import React from 'react';

/**
 * Semi-transparent channel name / group overlay along the bottom.
 * Toggled by the "info" control button. Uses a top-gradient wash
 * so the text stays readable against bright video content.
 */
export default function PlayerChannelInfoOverlay({
  visible,
  selectedChannel,
  groupTitle,
  showDebug
}) {
  if (!visible || !selectedChannel) return null;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '120px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.9))',
          pointerEvents: 'none',
          zIndex: 20
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '15px',
          left: '15px',
          right: showDebug ? '270px' : '15px',
          padding: '10px 15px',
          borderRadius: '8px',
          zIndex: 30,
          display: 'flex',
          flexDirection: 'column',
          gap: '5px'
        }}
      >
        <div
          style={{
            fontWeight: 'bold',
            fontSize: '16px',
            color: 'white',
            textShadow: '0 1px 3px rgba(0,0,0,0.8)'
          }}
        >
          {selectedChannel.name}
        </div>
        <div
          style={{
            fontSize: '13px',
            color: 'rgba(255,255,255,0.9)',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            textShadow: '0 1px 3px rgba(0,0,0,0.8)'
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
            <line x1="7" y1="7" x2="7.01" y2="7"></line>
          </svg>
          {groupTitle}
        </div>
      </div>
    </>
  );
}
