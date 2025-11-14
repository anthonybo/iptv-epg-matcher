import React, { useState, useEffect } from 'react';
import IPTVPlayer from '../../IPTVPlayer';
import VideoQualityBadge from '../VideoQualityBadge';
import { addToMultiview } from '../../utils/multiviewManager';
import { showToast } from '../Toast';

/**
 * PiPPlayer - Picture-in-Picture video player for channel preview
 * Shows a small floating player in the bottom-right corner
 *
 * @param {Object} channel - Channel to preview
 * @param {string} sessionId - Session ID for stream URL
 * @param {Function} onClose - Callback when player is closed
 */
const PiPPlayer = ({ channel, sessionId, onClose }) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [videoQuality, setVideoQuality] = useState(null);

  // Reset quality when channel changes
  useEffect(() => {
    setVideoQuality(null);
  }, [channel?.id]);

  const handleAddToMultiview = () => {
    addToMultiview(channel);
    window.dispatchEvent(new Event('multiviewUpdate'));
    showToast(`Added "${channel.name}" to Multi-View`, 'success');
  };

  if (!channel) return null;

  return (
    <div
      className={`fixed z-[9999] transition-all duration-300 ${
        isMinimized
          ? 'bottom-4 right-4 w-16 h-16'
          : 'bottom-4 right-4 w-96 h-64'
      }`}
      style={{
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
      }}
    >
      <div className="relative w-full h-full rounded-xl overflow-hidden border-2 border-slate-700 bg-slate-950 flex flex-col">
        {/* Header */}
        {!isMinimized && (
          <div className="flex-shrink-0 z-50 bg-slate-950 px-3 py-2 flex items-center justify-between border-b border-slate-800">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {channel.logo || channel.tvgLogo ? (
                <img
                  src={channel.logo || channel.tvgLogo}
                  alt={channel.name}
                  className="w-6 h-6 object-contain flex-shrink-0"
                />
              ) : null}
              <span className="text-xs font-medium text-slate-200 truncate">
                {channel.name}
              </span>
              <VideoQualityBadge quality={videoQuality} size="sm" />
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Add to Multiview button */}
              <button
                onClick={handleAddToMultiview}
                className="p-1 rounded hover:bg-purple-500/20 text-slate-400 hover:text-purple-400 transition-colors"
                title="Add to Multi-View"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              {/* Minimize button */}
              <button
                onClick={() => setIsMinimized(!isMinimized)}
                className="p-1 rounded hover:bg-slate-800/60 text-slate-400 hover:text-slate-200 transition-colors"
                title="Minimize"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {/* Close button */}
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors"
                title="Close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Minimized view */}
        {isMinimized && (
          <button
            onClick={() => setIsMinimized(false)}
            className="w-full h-full flex items-center justify-center bg-slate-900 hover:bg-slate-800 transition-colors"
            title="Expand player"
          >
            {channel.logo || channel.tvgLogo ? (
              <img
                src={channel.logo || channel.tvgLogo}
                alt={channel.name}
                className="w-8 h-8 object-contain"
              />
            ) : (
              <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </button>
        )}

        {/* Video player */}
        {!isMinimized && (
          <div className="flex-1 bg-black overflow-hidden relative pip-player-container">
            <style>{`
              .pip-player-container video {
                width: 100% !important;
                height: 100% !important;
                object-fit: contain !important;
              }
              .pip-player-container > div {
                width: 100% !important;
                height: 100% !important;
              }
            `}</style>
            <div className="absolute inset-0">
              <IPTVPlayer
                sessionId={sessionId}
                selectedChannel={channel}
                playbackMethod="mpegts-player"
                matchedChannels={{}}
                theatreMode={true}
                onQualityDetected={setVideoQuality}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PiPPlayer;
