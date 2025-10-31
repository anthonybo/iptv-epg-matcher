import React from 'react';
import { useChannels } from './hooks/useChannels';
import CategorySidebar from './CategorySidebar';
import ChannelGrid from './ChannelGrid';
import ChannelCard from './ChannelCard';

/**
 * ChannelsView - Main view for browsing and filtering channels
 * @param {string} sessionId - Session ID for fetching channel data
 * @param {Function} onChannelSelect - Callback when a channel is clicked
 * @param {object} selectedChannel - Currently selected channel
 * @param {object} matchedChannels - Matched channel data
 */
const ChannelsView = ({ sessionId, onChannelSelect, selectedChannel, matchedChannels = {} }) => {
  const {
    channels,
    categories,
    selectedCategories,
    searchTerm,
    loading,
    error,
    hasMore,
    setSearchTerm,
    toggleCategory,
    clearCategoryFilters,
    loadMore,
    totalChannels,
    filteredCount
  } = useChannels(sessionId);

  if (!sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="max-w-md rounded-2xl border border-amber-400/30 bg-amber-500/10 p-6 shadow-xl shadow-amber-900/30">
          <div className="mb-2 flex items-center">
            <svg className="mr-2 h-6 w-6 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3 className="text-lg font-semibold text-amber-200">No Session</h3>
          </div>
          <p className="text-sm text-amber-100/80">Please load channel data first from the configuration page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-5rem)] bg-slate-950/95 text-slate-100">
      {/* Left Sidebar - Categories */}
      <CategorySidebar
        categories={categories}
        selectedCategories={selectedCategories}
        onToggle={toggleCategory}
        onClearAll={clearCategoryFilters}
        loading={loading}
      />

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header with search and stats */}
        <div className="border-b border-slate-800 bg-slate-900/80 px-6 py-4 backdrop-blur">
          {/* Error display */}
          {error && (
            <div className="mb-4 flex items-start rounded-xl border border-red-500/40 bg-red-500/10 p-3">
              <svg className="mt-0.5 mr-2 h-5 w-5 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-red-200">Error loading channels</h4>
                <p className="mt-1 text-sm text-red-100/80">{error}</p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Channels</h2>
              <p className="mt-0.5 text-sm text-slate-400">
                {loading && filteredCount === 0 ? (
                  'Loading channels...'
                ) : (
                  <>
                    Showing <span className="font-medium text-slate-100">{filteredCount.toLocaleString()}</span> of{' '}
                    <span className="font-medium text-slate-100">{totalChannels.toLocaleString()}</span> channels
                    {selectedCategories.size > 0 && (
                      <span className="ml-1 text-blue-400">
                        ({selectedCategories.size} {selectedCategories.size === 1 ? 'category' : 'categories'} selected)
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>

            {/* Search box */}
            <div className="relative w-80">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <svg className="h-5 w-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search channels..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="block w-full rounded-lg border border-slate-800/80 bg-slate-900/70 py-2 pl-10 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 transition-colors hover:text-slate-200"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Channel Grid Area */}
        <div className="flex-1 overflow-auto px-6 py-4">
          <ChannelGrid
            channels={channels}
            loading={loading}
            hasMore={hasMore}
            onLoadMore={loadMore}
            ChannelCard={(props) => (
              <ChannelCard
                {...props}
                onClick={() => onChannelSelect && onChannelSelect(props.channel)}
                isSelected={selectedChannel?.id === props.channel.id}
                isMatched={matchedChannels[props.channel.id] || matchedChannels[props.channel.tvgId]}
              />
            )}
          />
        </div>
      </div>
    </div>
  );
};

export default ChannelsView;
