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
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 max-w-md">
          <div className="flex items-center mb-2">
            <svg className="w-6 h-6 text-yellow-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3 className="text-lg font-semibold text-yellow-800">No Session</h3>
          </div>
          <p className="text-sm text-yellow-700">Please load channel data first from the Configuration tab.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-gray-50">
      {/* Left Sidebar - Categories */}
      <CategorySidebar
        categories={categories}
        selectedCategories={selectedCategories}
        onToggle={toggleCategory}
        onClearAll={clearCategoryFilters}
        loading={loading}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header with search and stats */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          {/* Error display */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 flex items-start">
              <svg className="w-5 h-5 text-red-500 mt-0.5 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-red-800">Error loading channels</h4>
                <p className="text-sm text-red-700 mt-1">{error}</p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Channels</h2>
              <p className="text-sm text-gray-600 mt-0.5">
                {loading && filteredCount === 0 ? (
                  'Loading channels...'
                ) : (
                  <>
                    Showing <span className="font-medium text-gray-900">{filteredCount.toLocaleString()}</span> of{' '}
                    <span className="font-medium text-gray-900">{totalChannels.toLocaleString()}</span> channels
                    {selectedCategories.size > 0 && (
                      <span className="text-blue-600 ml-1">
                        ({selectedCategories.size} {selectedCategories.size === 1 ? 'category' : 'categories'} selected)
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>

            {/* Search box */}
            <div className="relative w-80">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search channels..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
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
