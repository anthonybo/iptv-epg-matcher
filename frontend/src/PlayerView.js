import React, { useState, useEffect } from 'react';
import IPTVPlayer from './IPTVPlayer';
import EPGMatcher from './EPGMatcher';
import FeedSelector from './components/FeedSelector/FeedSelector';
import VideoQualityBadge from './components/VideoQualityBadge';
import { addToMultiview } from './utils/multiviewManager';
import { showToast } from './components/Toast';

/**
 * PlayerView component that combines the video player and EPG matcher
 *
 * @param {Object} props Component properties
 * @param {string} props.sessionId Current session ID
 * @param {Object} props.selectedChannel Currently selected channel
 * @param {Function} props.onEpgMatch Callback when EPG is matched
 * @param {Object} props.matchedChannels Object mapping channel IDs to matched EPG IDs
 * @param {Array} props.availableSources Array of available IPTV sources
 * @param {Function} props.onBackToChannels Callback to return to channels view
 * @param {Function} props.onToggleTheatre Callback to toggle theatre mode
 * @param {boolean} props.isTheatreMode Flag indicating if theatre mode is active
 * @returns {JSX.Element} Player view UI
 */
const PlayerView = ({
  sessionId,
  selectedChannel,
  onEpgMatch,
  matchedChannels = {},
  availableSources = [],
  onBackToChannels,
  onToggleTheatre,
  isTheatreMode = false
}) => {
  const [playerType, setPlayerType] = useState('mpegts-player');
  const [currentChannel, setCurrentChannel] = useState(selectedChannel);
  const [currentFeedUrl, setCurrentFeedUrl] = useState(selectedChannel?.url);
  const [selectedFeed, setSelectedFeed] = useState(null);
  const [sourceName, setSourceName] = useState(null);
  const [videoQuality, setVideoQuality] = useState(null);
  // Bumped whenever IPTVPlayer declares the stream dead (after the
  // recovery state machine exhausts soft + full retries). Used as
  // the IPTVPlayer's React key so a fresh remount happens — same
  // pattern multi-view uses via _refreshKey. Without this hook,
  // single-view freezes had no escape and the user was left
  // staring at a frozen frame.
  const [playerRefreshKey, setPlayerRefreshKey] = useState(0);
  const handleStreamDead = (reason) => {
    console.warn(`[player] stream declared dead (${reason || 'no reason'}) — auto-refreshing`);
    setPlayerRefreshKey((k) => k + 1);
  };

  const playerButtonClasses = (type) => [
    'inline-flex items-center justify-center rounded-xl border p-2.5 transition',
    playerType === type
      ? 'border-blue-500 bg-blue-600 text-white shadow-lg shadow-blue-900/40'
      : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100'
  ].join(' ');

  useEffect(() => {
    if (selectedChannel) {
      setCurrentChannel(selectedChannel);
      setCurrentFeedUrl(selectedChannel.url);
      setSelectedFeed(null); // Reset feed selection when channel changes
      setVideoQuality(null); // Reset quality when channel changes

      // Set source name from channel data (comes from backend now)
      console.log('[PlayerView] Channel changed:', {
        channelName: selectedChannel.name,
        sourceId: selectedChannel.sourceId,
        sourceName: selectedChannel.sourceName
      });

      if (selectedChannel.sourceName) {
        // Use source name from the channel data (includes the actual IPTV source name)
        console.log('[PlayerView] Using source name from channel:', selectedChannel.sourceName);
        setSourceName(selectedChannel.sourceName);
      } else if (selectedChannel.sourceId) {
        // Fallback to sourceId if no source name provided
        const fallbackName = `Source ${selectedChannel.sourceId}`;
        console.log('[PlayerView] No sourceName in channel, using fallback:', fallbackName);
        setSourceName(fallbackName);
      } else {
        console.log('[PlayerView] No source information available');
        setSourceName(null);
      }

      if (sessionId) {
        console.log('[PlayerView] Ensuring EPG session is initialized for channel', selectedChannel.name);
        fetch('/api/epg/init', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sessionId })
        })
          .then((response) => {
            if (response.ok) {
              console.log('[PlayerView] EPG session initialized successfully');
              return fetch(`/api/epg/${sessionId}/sources?_t=${Date.now()}`);
            }
            throw new Error('Failed to initialize EPG session');
          })
          .then((response) => response.json())
          .then((data) => {
            if (data && data.sources) {
              console.log('[PlayerView] Loaded EPG sources:', data.sources);
              window.dispatchEvent(new CustomEvent('epgSourcesUpdated', { detail: data.sources }));
            }
          })
          .catch((error) => {
            console.error('[PlayerView] Error initializing EPG:', error);
          });
      }
    }
  }, [selectedChannel, sessionId, availableSources]);

  // Handle feed selection
  const handleFeedSelect = (feed) => {
    console.log('[PlayerView] Feed selected:', feed);
    setSelectedFeed(feed);
    setCurrentFeedUrl(feed.url);

    // Update source name from the selected feed
    const displayName = feed.source.nickname || feed.source.name;
    console.log('[PlayerView] Updating source name to:', displayName);
    setSourceName(displayName);

    // Update currentChannel with new URL for the player
    setCurrentChannel(prev => ({
      ...prev,
      url: feed.url,
      source: feed.source,
      sourceId: feed.source.id
    }));
  };

  const handleAddToMultiview = async () => {
    if (!currentChannel) return;

    const success = await addToMultiview(currentChannel);

    if (success) {
      // Trigger custom event to update multiview page if it's open
      window.dispatchEvent(new Event('multiviewUpdate'));

      // Show toast notification
      showToast(`Added "${currentChannel.name}" to Multi-View`, 'success');
    } else {
      showToast('Failed to add to Multi-View', 'error');
    }
  };

  console.log('[PlayerView] Rendering with sourceName:', sourceName);

  return (
    <div className="space-y-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {onBackToChannels && (
            <button
              onClick={onBackToChannels}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
              title="Back to Channels"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              Back to Channels
            </button>
          )}
          <div>
            <h2 className="text-3xl font-semibold text-slate-100">Video Preview</h2>
            <p className="text-sm text-slate-400">Preview live streams and match them with accurate EPG entries.</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-full border border-slate-800/70 bg-slate-900/70 px-4 py-2 text-xs flex-wrap">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400"></span>
            {currentChannel ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-400">Now playing:</span>
                <span className="font-medium text-slate-100">{currentChannel.name}</span>
                <span className="text-slate-600">•</span>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/20 px-2.5 py-1 text-blue-200 border-2 border-blue-500/40 font-semibold text-sm">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  <span>{sourceName || 'Unknown Source'}</span>
                </span>
                <VideoQualityBadge quality={videoQuality} showSeparator={true} />
              </div>
            ) : (
              <span className="text-slate-400">No channel selected</span>
            )}
          </div>
          {currentChannel && (
            <FeedSelector
              channel={currentChannel}
              onFeedSelect={handleFeedSelect}
              currentFeedUrl={currentFeedUrl}
              autoFallbackEnabled={true}
            />
          )}
        </div>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex w-full flex-col gap-4 lg:basis-7/12">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-800/70 bg-slate-900/60 p-4 shadow-inner shadow-slate-950/20">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPlayerType('mpegts-player')}
                className={playerButtonClasses('mpegts-player')}
                title="TS Player"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7"></polygon>
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPlayerType('hls-player')}
                className={playerButtonClasses('hls-player')}
                title="HLS Player"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <path d="M2 15s2-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2"></path>
                  <path d="M2 19s2-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2"></path>
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPlayerType('hls-stream')}
                className={playerButtonClasses('hls-stream')}
                title="HLS Stream (iOS-friendly, ffmpeg-remuxed)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="14" height="12" rx="2" ry="2"></rect>
                  <polygon points="22 8 16 12 22 16 22 8"></polygon>
                  <circle cx="9" cy="12" r="2"></circle>
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPlayerType('test-video')}
                className={playerButtonClasses('test-video')}
                title="Test Video"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                  <line x1="7" y1="2" x2="7" y2="22"></line>
                  <line x1="17" y1="2" x2="17" y2="22"></line>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <line x1="2" y1="7" x2="7" y2="7"></line>
                  <line x1="2" y1="17" x2="7" y2="17"></line>
                  <line x1="17" y1="17" x2="22" y2="17"></line>
                  <line x1="17" y1="7" x2="22" y2="7"></line>
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPlayerType('vlc-link')}
                className={playerButtonClasses('vlc-link')}
                title="VLC Link"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </button>

              {onToggleTheatre && (
                <button
                  type="button"
                  onClick={onToggleTheatre}
                  className="inline-flex items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/20 p-2.5 text-emerald-100 transition hover:bg-emerald-500/30"
                  title="Theatre Mode"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                    <polyline points="17 2 12 7 7 2"></polyline>
                  </svg>
                </button>
              )}

              {currentChannel && (
                <button
                  type="button"
                  onClick={handleAddToMultiview}
                  className="inline-flex items-center justify-center rounded-xl border border-purple-500/40 bg-purple-500/20 p-2.5 text-purple-100 transition hover:bg-purple-500/30"
                  title="Add to Multi-View"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800/70 bg-slate-900/70 p-4 shadow-2xl shadow-slate-950/40">
            {selectedChannel && sessionId ? (
              <IPTVPlayer
                key={`${selectedChannel.id || selectedChannel.tvgId}-${playerRefreshKey}`}
                sessionId={sessionId}
                selectedChannel={selectedChannel}
                playbackMethod={playerType}
                matchedChannels={matchedChannels}
                onQualityDetected={setVideoQuality}
                onStreamDead={handleStreamDead}
                // Opt single-view into the resilient backend proxy
                // — same pipeline multi-view uses. Without this, the
                // browser connects directly to the upstream URL
                // (e.g. lordstreams.live), and every upstream pipe
                // drop forces the legacy frontend recovery loop (6
                // retries + 3 fresh starts ≈ 90s of trying the same
                // dead URL) before notifyStreamDead can fire and
                // remount the player. With it, the backend's ~30s
                // retry budget handles reconnects transparently so
                // the player never sees the drop.
                useResilientProxy={true}
              />
            ) : (
              <div className="flex h-96 flex-col items-center justify-center gap-4 rounded-2xl border border-slate-800 bg-slate-950 text-slate-500">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                </svg>
                <p className="text-sm">Select a channel to explore playback options.</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex w-full flex-col gap-4 lg:basis-5/12">
          <div className="rounded-3xl border border-slate-800/70 bg-slate-900/70 p-4 shadow-2xl shadow-slate-950/40">
            <EPGMatcher
              sessionId={sessionId}
              selectedChannel={selectedChannel}
              onEpgMatch={onEpgMatch}
              matchedChannels={matchedChannels}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlayerView;
