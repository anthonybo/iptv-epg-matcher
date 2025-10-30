import React from 'react';

/**
 * Skeleton loader for channel cards
 */
const ChannelCardSkeleton = () => (
  <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden animate-pulse">
    <div className="h-16 bg-gray-300"></div>
    <div className="p-3 space-y-2">
      <div className="h-4 bg-gray-300 rounded w-3/4"></div>
      <div className="h-3 bg-gray-200 rounded w-1/2"></div>
    </div>
  </div>
);

/**
 * ChannelGrid - Responsive grid layout for displaying channel cards
 * @param {Array} channels - Array of channel objects to display
 * @param {boolean} loading - Loading state
 * @param {boolean} hasMore - Whether more channels can be loaded
 * @param {Function} onLoadMore - Callback to load more channels
 * @param {React.Component} ChannelCard - Component to render each channel
 */
const ChannelGrid = ({
  channels,
  loading,
  hasMore,
  onLoadMore,
  ChannelCard
}) => {
  // Show skeleton loaders on initial load
  if (loading && channels.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {Array.from({ length: 20 }).map((_, index) => (
          <ChannelCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  // No channels found
  if (!loading && channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <svg
          className="w-16 h-16 text-gray-400 mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <h3 className="text-lg font-semibold text-gray-700 mb-2">
          No channels found
        </h3>
        <p className="text-gray-500 text-sm">
          Try adjusting your filters or search term
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Channel grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {channels.map((channel) => (
          <ChannelCard key={channel.id || channel.uuid} channel={channel} />
        ))}
      </div>

      {/* Load more button */}
      {hasMore && (
        <div className="flex justify-center pt-6">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className={`
              px-6 py-3 rounded-lg font-medium text-white
              transition-all duration-200
              ${loading
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg active:scale-95'
              }
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
            `}
          >
            {loading ? (
              <span className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Loading...
              </span>
            ) : (
              'Load More'
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default ChannelGrid;
