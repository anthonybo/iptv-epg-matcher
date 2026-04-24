import React from 'react';

/**
 * Dev-facing overlay that shows the current playback method,
 * selected channel metadata, and the rolling log buffer from
 * IPTVPlayer's logger. Toggled by the debug-pill control in the
 * header (or programmatically via the showDebug prop).
 */
export default function PlayerDebugPanel({
  visible,
  playbackMethod,
  selectedChannel,
  channelId,
  groupTitle,
  matchedEpgId,
  logs
}) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '50px',
        right: '10px',
        bottom: '10px',
        width: '250px',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: 'white',
        padding: '12px',
        zIndex: 45,
        overflowY: 'auto',
        fontSize: '11px',
        fontFamily: 'monospace',
        borderRadius: '8px',
        backdropFilter: 'blur(5px)'
      }}
    >
      <div style={{ marginBottom: '10px', borderBottom: '1px solid rgba(255, 255, 255, 0.2)', paddingBottom: '8px' }}>
        <strong>Method:</strong> {playbackMethod}
      </div>

      {selectedChannel && (
        <div
          style={{
            marginBottom: '10px',
            fontSize: '10px',
            wordBreak: 'break-all',
            background: 'rgba(255, 255, 255, 0.1)',
            padding: '8px',
            borderRadius: '4px'
          }}
        >
          <div style={{ marginBottom: '5px' }}>
            <strong>Channel:</strong> {selectedChannel.name}
          </div>
          <div style={{ marginBottom: '5px' }}>
            <strong>Channel ID:</strong> {channelId}
          </div>
          <div style={{ marginBottom: '5px' }}>
            <strong>Group:</strong> {groupTitle}
          </div>
          {matchedEpgId && (
            <div style={{ marginBottom: '5px', color: '#81c784' }}>
              <strong>Matched EPG ID:</strong> {matchedEpgId}
            </div>
          )}
          <div>
            <strong>URL:</strong> {selectedChannel.url || 'N/A'}
          </div>
        </div>
      )}

      <div style={{ marginBottom: '5px' }}>
        <strong>Logs:</strong>
      </div>

      <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
        {logs.map((log) => (
          <div
            key={log.id}
            style={{
              padding: '4px 6px',
              margin: '3px 0',
              backgroundColor:
                log.level === 'error'
                  ? 'rgba(255, 0, 0, 0.3)'
                  : log.level === 'warn'
                  ? 'rgba(255, 255, 0, 0.2)'
                  : log.level === 'info'
                  ? 'rgba(0, 0, 255, 0.2)'
                  : 'rgba(255, 255, 255, 0.1)',
              borderRadius: '4px',
              fontSize: '9px'
            }}
          >
            {log.message}
            {log.data && (
              <div style={{ color: '#aaa', fontSize: '8px', wordBreak: 'break-all', marginTop: '2px' }}>
                {log.data}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
