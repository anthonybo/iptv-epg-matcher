import React, { useState, useEffect, useRef } from 'react';
import iptvSourcesService from '../../services/iptvSourcesService';

/**
 * FeedSelector Component
 * Displays alternate feeds for a channel and allows manual selection
 *
 * @param {Object} props
 * @param {Object} props.channel - Current channel object
 * @param {Function} props.onFeedSelect - Callback when a feed is selected
 * @param {string} props.currentFeedUrl - Currently playing feed URL
 * @param {boolean} props.autoFallbackEnabled - Whether automatic fallback is enabled
 */
const FeedSelector = ({ channel, onFeedSelect, currentFeedUrl, autoFallbackEnabled = true }) => {
  const [feeds, setFeeds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState(null);
  const dropdownRef = useRef(null);

  // Load alternate feeds when channel changes
  useEffect(() => {
    if (!channel) {
      setFeeds([]);
      return;
    }

    const loadFeeds = async () => {
      try {
        setLoading(true);
        setError(null);
        const alternateFeeds = await iptvSourcesService.getAlternateFeeds(
          channel.name,
          channel.epgChannelId || channel.tvg?.id
        );
        setFeeds(alternateFeeds);
      } catch (err) {
        console.error('Error loading alternate feeds:', err);
        setError('Failed to load alternate feeds');
      } finally {
        setLoading(false);
      }
    };

    loadFeeds();
  }, [channel]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Don't show if no feeds available
  if (!channel || feeds.length <= 1) {
    return null;
  }

  // Find current feed
  const currentFeed = feeds.find(f => f.url === currentFeedUrl);
  const currentPriority = currentFeed?.source?.priority || null;

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      {/* Feed selector button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-800/90 border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700 hover:border-slate-600 hover:text-slate-100 transition-all shadow-lg"
        title="Select alternate feed"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span className="hidden sm:inline">
          {currentFeed ? (
            <>
              <span className="text-blue-400">Source {currentPriority}</span>
              <span className="text-slate-500 mx-1">·</span>
              {currentFeed.source.nickname}
            </>
          ) : (
            'Select Feed'
          )}
        </span>
        <span className="inline sm:hidden">Feeds</span>
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold">
          {feeds.length}
        </span>
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/50">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-slate-100">Available Feeds</h3>
              {autoFallbackEnabled && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-300 text-xs">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Auto-fallback
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Ordered by priority · Select to switch feed
            </p>
          </div>

          {/* Feed list */}
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="px-4 py-8 text-center">
                <div className="inline-block w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mb-2"></div>
                <p className="text-sm text-slate-400">Loading feeds...</p>
              </div>
            ) : error ? (
              <div className="px-4 py-6 text-center">
                <svg className="w-8 h-8 mx-auto text-red-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-red-200">{error}</p>
              </div>
            ) : feeds.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-sm text-slate-400">No alternate feeds available</p>
              </div>
            ) : (
              feeds.map((feed, index) => {
                const isActive = feed.url === currentFeedUrl;
                const isPrimary = index === 0;

                return (
                  <button
                    key={feed.id}
                    onClick={() => {
                      onFeedSelect(feed);
                      setIsOpen(false);
                    }}
                    className={`w-full text-left px-4 py-3 transition-colors border-b border-slate-800 last:border-b-0 ${
                      isActive
                        ? 'bg-blue-500/10 hover:bg-blue-500/15'
                        : 'hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Source name and priority */}
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                            isPrimary
                              ? 'bg-blue-500/20 text-blue-300'
                              : 'bg-slate-700 text-slate-400'
                          }`}>
                            {feed.source.priority}
                          </span>
                          <span className="text-sm font-medium text-slate-100 truncate">
                            {feed.source.nickname}
                          </span>
                          {isPrimary && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs font-medium">
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                              </svg>
                              Primary
                            </span>
                          )}
                        </div>

                        {/* Channel name */}
                        <p className="text-xs text-slate-400 truncate">
                          {feed.name}
                        </p>

                        {/* Source type */}
                        <p className="text-xs text-slate-500 mt-0.5">
                          Type: {feed.source.type || 'unknown'}
                        </p>
                      </div>

                      {/* Active indicator */}
                      {isActive && (
                        <div className="flex-shrink-0">
                          <svg className="w-5 h-5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer info */}
          {!loading && !error && feeds.length > 0 && autoFallbackEnabled && (
            <div className="px-4 py-3 border-t border-slate-700 bg-slate-800/30">
              <p className="text-xs text-slate-400 leading-relaxed">
                <svg className="w-3 h-3 inline-block mr-1 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Automatic fallback is enabled. If a stream fails, the next priority feed will be tried automatically.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FeedSelector;
