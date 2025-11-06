import React, { useState, useCallback } from 'react';
import IPTVPlayer from './IPTVPlayer';
import EPGMatcher from './EPGMatcher';

/**
 * TheatreView - Immersive viewing experience with large player and compact EPG
 *
 * @param {Object} props Component properties
 * @param {string} props.sessionId Current session ID
 * @param {Object} props.selectedChannel Currently selected channel
 * @param {Object} props.matchedChannels Object mapping channel IDs to matched EPG IDs
 * @param {Function} props.onEpgMatch Callback when EPG is matched
 * @param {Function} props.onExitTheatre Callback to exit theatre mode
 * @returns {JSX.Element} Theatre view UI
 */
const TheatreView = ({
  sessionId,
  selectedChannel,
  matchedChannels = {},
  onEpgMatch,
  onExitTheatre
}) => {
  const [playerType, setPlayerType] = useState('mpegts-player');
  const [showChannelInfo, setShowChannelInfo] = useState(false);
  const [showEpgInfo, setShowEpgInfo] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showGuide, setShowGuide] = useState(true);

  const playerButtonClasses = (type) => [
    'inline-flex items-center gap-2 rounded-lg border px-2 py-1 text-xs font-semibold transition',
    playerType === type
      ? 'border-blue-500 bg-blue-600 text-white shadow-lg shadow-blue-900/40'
      : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100'
  ].join(' ');

  const iconButtonClasses = (active = false) => [
    'inline-flex items-center justify-center rounded-lg border p-2 transition',
    active
      ? 'border-blue-500 bg-blue-600 text-white'
      : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100'
  ].join(' ');

  return (
    <div className="fixed inset-0 z-50 flex h-screen bg-black">
      {/* Large Video Player - Left Side */}
      <div className={`flex h-full flex-col transition-all duration-300 ${showGuide ? 'w-4/5' : 'w-full'}`}>
        {/* Player Controls Bar */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-2">
          <div className="flex items-center gap-3">
            <button
              onClick={onExitTheatre}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
              title="Exit theatre mode"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Exit Theatre
            </button>

            {selectedChannel && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-400">Now Playing:</span>
                <span className="font-semibold text-slate-100">{selectedChannel.name}</span>
              </div>
            )}
          </div>

          {/* Player Type Selector and Control Icons */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Player:</span>
              <button
                onClick={() => setPlayerType('mpegts-player')}
                className={playerButtonClasses('mpegts-player')}
              >
                MPEG-TS
              </button>
              <button
                onClick={() => setPlayerType('simple-player')}
                className={playerButtonClasses('simple-player')}
              >
                Simple
              </button>
              <button
                onClick={() => setPlayerType('hls-player')}
                className={playerButtonClasses('hls-player')}
              >
                HLS
              </button>
            </div>

            {/* Divider */}
            <div className="h-6 w-px bg-slate-700"></div>

            {/* Player Control Icons */}
            <div className="flex items-center gap-2">
              {/* Channel Info Toggle */}
              <button
                onClick={() => setShowChannelInfo(!showChannelInfo)}
                className={iconButtonClasses(showChannelInfo)}
                title={showChannelInfo ? "Hide channel info" : "Show channel info"}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
              </button>

              {/* EPG Info Toggle */}
              <button
                onClick={() => setShowEpgInfo(!showEpgInfo)}
                className={iconButtonClasses(showEpgInfo)}
                title={showEpgInfo ? "Hide guide information" : "Show guide information"}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
              </button>

              {/* Debug Toggle */}
              <button
                onClick={() => setShowDebug(!showDebug)}
                className={iconButtonClasses(showDebug)}
                title={showDebug ? "Hide debug panel" : "Show debug panel"}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                </svg>
              </button>

              {/* Divider */}
              <div className="h-6 w-px bg-slate-700"></div>

              {/* Guide Toggle */}
              <button
                onClick={() => setShowGuide(!showGuide)}
                className={iconButtonClasses(showGuide)}
                title={showGuide ? "Hide guide" : "Show guide"}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Video Player */}
        <div className="flex-1 bg-black" style={{ minHeight: 0 }}>
          {selectedChannel ? (
            <div style={{ height: '100%', width: '100%' }}>
              <IPTVPlayer
                sessionId={sessionId}
                selectedChannel={selectedChannel}
                playbackMethod={playerType}
                matchedChannels={matchedChannels}
                theatreMode={true}
                showChannelInfo={showChannelInfo}
                showEpgInfo={showEpgInfo}
                showDebug={showDebug}
              />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <svg
                className="h-16 w-16 text-slate-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              <p className="text-slate-400">Select a channel to start watching</p>
            </div>
          )}
        </div>
      </div>

      {/* EPG Matcher - Right Side (20%) */}
      {showGuide && (
        <div className="h-full w-1/5 overflow-y-auto border-l border-slate-800 bg-slate-950 transition-all duration-300">
          <EPGMatcher
            sessionId={sessionId}
            selectedChannel={selectedChannel}
            onEpgMatch={onEpgMatch}
            matchedChannels={matchedChannels}
            compactMode={true}
          />
        </div>
      )}
    </div>
  );
};

export default TheatreView;
