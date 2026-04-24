import React from 'react';

/**
 * EPG "now playing" overlay. Only renders when:
 *   - the user has toggled it on (showEpgInfo)
 *   - the channel is EPG-matched (matchedEpgId present)
 *   - we have a current program from the EPG service
 *
 * `formatTime` is passed from the parent so both this component and
 * the parent render identical time strings.
 */
export default function PlayerEpgInfoOverlay({
  visible,
  selectedChannel,
  epgData,
  matchedEpgId,
  showDebug,
  formatTime
}) {
  if (!visible || !selectedChannel || !epgData || !epgData.currentProgram || !matchedEpgId) {
    return null;
  }
  const { currentProgram } = epgData;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: '80px',
        left: '15px',
        right: showDebug ? '270px' : '15px',
        padding: '15px',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        borderRadius: '8px',
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        backdropFilter: 'blur(5px)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
        border: '1px solid rgba(255, 255, 255, 0.15)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div
          style={{
            fontWeight: '600',
            fontSize: '18px',
            color: 'white',
            marginBottom: '3px',
            textShadow: '0 1px 3px rgba(0,0,0,0.9)'
          }}
        >
          {currentProgram.title}
        </div>
        <div
          style={{
            fontSize: '13px',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            backgroundColor: 'rgba(255, 255, 255, 0.15)',
            padding: '4px 8px',
            borderRadius: '4px',
            marginLeft: '8px',
            fontWeight: '500'
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          {formatTime(currentProgram.start)} - {formatTime(currentProgram.stop)}
        </div>
      </div>

      {currentProgram.desc && (
        <div
          style={{
            fontSize: '14px',
            color: 'rgba(255, 255, 255, 0.95)',
            lineHeight: '1.5',
            textShadow: '0 1px 2px rgba(0,0,0,0.8)',
            backgroundColor: 'rgba(0, 0, 0, 0.25)',
            padding: '8px 10px',
            borderRadius: '6px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}
        >
          {currentProgram.desc}
        </div>
      )}
    </div>
  );
}
