import React, { useState } from 'react';
import IPTVPlayer from './IPTVPlayer';
import EPGMatcher from './EPGMatcher';

/**
 * PlayerView component that combines the video player and EPG matcher
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId Current session ID
 * @param {Object} props.selectedChannel Currently selected channel
 * @param {Function} props.onEpgMatch Callback when EPG is matched
 * @param {Object} props.matchedChannels Object mapping channel IDs to matched EPG IDs
 * @param {Function} props.onGenerate Callback to generate credentials
 * @param {boolean} props.isGenerating Flag indicating if generation is in progress
 * @returns {JSX.Element} Player view UI
 */
const PlayerView = ({ 
  sessionId,
  selectedChannel,
  onEpgMatch,
  matchedChannels = {},
  onGenerate,
  isGenerating = false
}) => {
  // State
  const [playerType, setPlayerType] = useState('mpegts-player'); // Default to TS player
  
  return (
    <div style={{ padding: '20px' }}>
      <h2 style={{ marginTop: 0, color: '#333', fontWeight: '500' }}>
        Video Preview
      </h2>
      
      <div style={{ 
        display: 'flex',
        gap: '20px',
        flexWrap: 'wrap'
      }}>
        <div style={{ flex: '1.5', minWidth: '500px' }}>
          {/* Player Type Selection */}
          <div style={{ 
            marginBottom: '15px', 
            padding: '10px',
            backgroundColor: '#f9f9f9',
            borderRadius: '8px',
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <button
              onClick={() => setPlayerType('mpegts-player')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'mpegts-player' ? '#1a73e8' : 'transparent',
                color: playerType === 'mpegts-player' ? 'white' : '#444',
                border: playerType === 'mpegts-player' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'mpegts-player' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
              TS Player
            </button>
            
            <button
              onClick={() => setPlayerType('hls-player')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'hls-player' ? '#1a73e8' : 'transparent',
                color: playerType === 'hls-player' ? 'white' : '#444',
                border: playerType === 'hls-player' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'hls-player' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <path d="M2 15s2-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2"></path>
                <path d="M2 19s2-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2"></path>
              </svg>
              HLS Player
            </button>
            
            <button
              onClick={() => setPlayerType('test-video')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'test-video' ? '#1a73e8' : 'transparent',
                color: playerType === 'test-video' ? 'white' : '#444',
                border: playerType === 'test-video' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'test-video' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                <line x1="7" y1="2" x2="7" y2="22"></line>
                <line x1="17" y1="2" x2="17" y2="22"></line>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <line x1="2" y1="7" x2="7" y2="7"></line>
                <line x1="2" y1="17" x2="7" y2="17"></line>
                <line x1="17" y1="17" x2="22" y2="17"></line>
                <line x1="17" y1="7" x2="22" y2="7"></line>
              </svg>
              Test Video
            </button>
            
            <button
              onClick={() => setPlayerType('vlc-link')}
              style={{
                padding: '8px 12px',
                backgroundColor: playerType === 'vlc-link' ? '#1a73e8' : 'transparent',
                color: playerType === 'vlc-link' ? 'white' : '#444',
                border: playerType === 'vlc-link' ? 'none' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: playerType === 'vlc-link' ? '500' : 'normal',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
              VLC Link
            </button>
          </div>
          
          {/* Video Player - Now passing matchedChannels prop */}
          {selectedChannel && sessionId ? (
            <IPTVPlayer 
              sessionId={sessionId} 
              selectedChannel={selectedChannel} 
              playbackMethod={playerType}
              matchedChannels={matchedChannels} // Pass the matched channels
            />
          ) : (
            <div style={{ 
              height: '400px', 
              display: 'flex', 
              flexDirection: 'column',
              alignItems: 'center', 
              justifyContent: 'center',
              backgroundColor: '#000',
              borderRadius: '8px',
              color: '#aaa'
            }}>
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
                style={{ marginBottom: '15px' }}
              >
                <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                <polyline points="17 2 12 7 7 2"></polyline>
              </svg>
              <p style={{ margin: 0 }}>Select a channel to play</p>
            </div>
          )}
        </div>
        
        {/* EPG Matcher */}
        <div style={{ flex: '1', minWidth: '400px' }}>
          <EPGMatcher 
            sessionId={sessionId}
            selectedChannel={selectedChannel}
            onEpgMatch={onEpgMatch}
            matchedChannels={matchedChannels}
          />
          
          {/* Generate Button */}
          <div style={{ marginTop: '20px', textAlign: 'center' }}>
            <button 
              onClick={onGenerate} 
              disabled={isGenerating || Object.keys(matchedChannels).length === 0}
              style={{
                padding: '12px 20px',
                backgroundColor: isGenerating || Object.keys(matchedChannels).length === 0 ? '#e0e0e0' : '#0b8043',
                color: isGenerating || Object.keys(matchedChannels).length === 0 ? '#999' : 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: isGenerating || Object.keys(matchedChannels).length === 0 ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                fontSize: '16px',
                fontWeight: '500',
                margin: '0 auto'
              }}
            >
              {isGenerating ? (
                <div className="loading-spinner" style={{
                  display: 'inline-block',
                  width: '16px',
                  height: '16px',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderRadius: '50%',
                  borderTopColor: 'white',
                  animation: 'spin 1s linear infinite'
                }}></div>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              )}
              {isGenerating ? 'Generating...' : 'Generate New XTREAM Credentials'}
            </button>
            
            {Object.keys(matchedChannels).length === 0 && (
              <p style={{ 
                color: '#f44336', 
                marginTop: '10px',
                fontSize: '14px'
              }}>
                You need to match at least one channel with EPG data
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlayerView;