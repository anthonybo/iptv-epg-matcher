import React, { useState, useEffect } from 'react';
import IPTVPlayer from './IPTVPlayer';
import VideoQualityBadge from './components/VideoQualityBadge';
import ConfirmModal from './components/ConfirmModal';
import { useAppContext } from './contexts/AppContext';
import {
  getMultiviewStreams,
  removeFromMultiview,
  clearMultiview,
  calculateLayout
} from './utils/multiviewManager';

/**
 * MultiViewPage - Display multiple streams in an auto-layout grid
 * Streams persist in localStorage and can be added from any player
 */
const MultiViewPage = ({ sessionId }) => {
  const { isTheatreMode, setIsTheatreMode } = useAppContext();
  const [streams, setStreams] = useState([]);
  const [layout, setLayout] = useState({ columns: 1, rows: 1 });
  const [streamQualities, setStreamQualities] = useState({});
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [mutedStreams, setMutedStreams] = useState(new Set()); // Track which streams are muted

  // Load streams from localStorage on mount
  useEffect(() => {
    loadStreams();

    // Listen for storage events (when streams are added from other tabs/windows)
    const handleStorageChange = (e) => {
      if (e.key === 'multiview_streams') {
        loadStreams();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    // Also listen for custom event when streams are added in same tab
    const handleMultiviewUpdate = () => {
      loadStreams();
    };

    window.addEventListener('multiviewUpdate', handleMultiviewUpdate);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('multiviewUpdate', handleMultiviewUpdate);
    };
  }, []);

  // Update layout when streams change
  useEffect(() => {
    const newLayout = calculateLayout(streams.length);
    setLayout(newLayout);
  }, [streams.length]);

  const loadStreams = () => {
    const loaded = getMultiviewStreams();
    setStreams(loaded);

    // Mute all streams by default
    const streamKeys = loaded.map(s => `${s.sourceId}_${s.id}`);
    setMutedStreams(new Set(streamKeys));
  };

  const toggleMute = (streamKey) => {
    setMutedStreams(prev => {
      const newSet = new Set(prev);
      if (newSet.has(streamKey)) {
        newSet.delete(streamKey);
      } else {
        newSet.add(streamKey);
      }
      return newSet;
    });
  };

  const handleRemoveStream = (id, sourceId) => {
    removeFromMultiview(id, sourceId);
    // Update state directly instead of reloading from localStorage
    // This prevents other streams from stopping and restarting
    setStreams(prevStreams => prevStreams.filter(
      stream => !(stream.id === id && stream.sourceId === sourceId)
    ));
    // Also remove quality data for the removed stream
    const streamKey = `${sourceId}_${id}`;
    setStreamQualities(prev => {
      const { [streamKey]: removed, ...rest } = prev;
      return rest;
    });
  };

  const handleClearAll = () => {
    clearMultiview();
    loadStreams();
    setStreamQualities({});
  };

  const handleQualityDetected = (streamId, quality) => {
    setStreamQualities(prev => ({
      ...prev,
      [streamId]: quality
    }));
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950">
      {/* Header */}
      {!isTheatreMode && (
        <div className="flex-shrink-0 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-slate-100">Multi-View</h1>
              <p className="text-sm text-slate-400 mt-1">
                {streams.length === 0
                  ? 'Add streams using the + button on any player'
                  : `Viewing ${streams.length} stream${streams.length !== 1 ? 's' : ''} in ${layout.columns}×${layout.rows} grid`
                }
              </p>
            </div>
            <div className="flex items-center gap-3">
              {streams.length > 0 && (
                <>
                  <button
                    onClick={() => setIsTheatreMode(true)}
                    className="inline-flex items-center gap-2 rounded-xl border border-purple-700 bg-purple-900/20 px-4 py-2 text-sm font-semibold text-purple-300 transition hover:bg-purple-900/40"
                    title="Theatre Mode"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                    </svg>
                    Theatre Mode
                  </button>
                  <button
                    onClick={() => setShowClearConfirm(true)}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-700 bg-red-900/20 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-900/40"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Clear All
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Exit Theatre Mode Button */}
      {isTheatreMode && (
        <button
          onClick={() => setIsTheatreMode(false)}
          className="fixed top-4 right-4 z-50 flex items-center justify-center w-10 h-10 rounded-lg border border-slate-700 bg-slate-900/90 backdrop-blur-sm text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 shadow-2xl"
          title="Exit Theatre Mode"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Grid Container */}
      <div className={`flex-1 overflow-auto ${isTheatreMode ? 'p-0' : 'p-4'}`}>
        {streams.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mb-4 inline-flex h-24 w-24 items-center justify-center rounded-full bg-slate-800/50">
                <svg className="h-12 w-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h.01M15 10h.01M9.5 15.5c1.5 1 3.5 1 5 0" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-slate-300 mb-2">No Streams Yet</h3>
              <p className="text-slate-500 max-w-md mx-auto">
                Add streams to multiview by clicking the <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-sm font-mono">+</span> button on any player.
              </p>
              <p className="text-slate-600 text-sm mt-2">
                Your streams will persist even after leaving this page.
              </p>
            </div>
          </div>
        ) : (
          <div
            className={`grid h-full ${isTheatreMode ? 'gap-0' : 'gap-3'}`}
            style={{
              gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
              gridTemplateRows: `repeat(${layout.rows}, 1fr)`
            }}
          >
            {streams.map((stream) => {
              const streamKey = `${stream.sourceId}_${stream.id}`;
              return (
                <div
                  key={streamKey}
                  className={`relative overflow-hidden ${
                    isTheatreMode
                      ? 'bg-black'
                      : 'rounded-xl border border-slate-800/70 bg-slate-900/70 shadow-2xl shadow-slate-950/40'
                  }`}
                >
                  {/* Stream Header */}
                  {!isTheatreMode && (
                    <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-slate-950/90 to-transparent px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {stream.logo && (
                            <img
                              src={stream.logo}
                              alt={stream.name}
                              className="w-5 h-5 object-contain rounded flex-shrink-0"
                            />
                          )}
                          <span className="text-xs font-medium text-slate-200 truncate">
                            {stream.name}
                          </span>
                          {stream.sourceName && (
                            <span
                              className="inline-flex items-center gap-1 rounded-md bg-blue-500/20 px-1.5 py-0.5 text-blue-200 border border-blue-500/40 text-[10px] font-semibold flex-shrink-0"
                              title={`IPTV Source: ${stream.sourceName}`}
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                              </svg>
                              <span className="truncate max-w-[80px]">{stream.sourceName}</span>
                            </span>
                          )}
                          <VideoQualityBadge quality={streamQualities[streamKey]} size="sm" />
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {/* Mute/Unmute Button */}
                          <button
                            onClick={() => toggleMute(streamKey)}
                            className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-slate-200 transition-colors"
                            title={mutedStreams.has(streamKey) ? 'Unmute' : 'Mute'}
                          >
                            {mutedStreams.has(streamKey) ? (
                              // Muted icon
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                              </svg>
                            ) : (
                              // Unmuted icon
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                              </svg>
                            )}
                          </button>
                          {/* Remove Button */}
                          <button
                            onClick={() => handleRemoveStream(stream.id, stream.sourceId)}
                            className="p-1 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors"
                            title="Remove from multiview"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Video Player */}
                  <div className="h-full w-full">
                    <IPTVPlayer
                      sessionId={sessionId}
                      selectedChannel={stream}
                      playbackMethod="mpegts-player"
                      matchedChannels={{}}
                      theatreMode={true}
                      muted={mutedStreams.has(streamKey)}
                      onQualityDetected={(quality) => handleQualityDetected(streamKey, quality)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Clear All Confirmation Modal */}
      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleClearAll}
        title="Clear All Streams"
        message={`Are you sure you want to remove all ${streams.length} stream${streams.length !== 1 ? 's' : ''} from Multi-View?`}
        confirmText="Clear All"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
};

export default MultiViewPage;
