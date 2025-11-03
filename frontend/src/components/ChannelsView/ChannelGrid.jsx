import React from 'react';

/**
 * Skeleton loader for channel cards
 */
const ChannelCardSkeleton = () => (
  <div className="animate-pulse overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-900/80">
    <div className="h-16 bg-slate-800/80"></div>
    <div className="space-y-2 p-3">
      <div className="h-4 w-3/4 rounded bg-slate-800/70"></div>
      <div className="h-3 w-1/2 rounded bg-slate-800/60"></div>
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
          className="mb-4 h-16 w-16 text-slate-600"
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
        <h3 className="mb-2 text-lg font-semibold text-slate-200">
          No channels found
        </h3>
        <p className="text-sm text-slate-500">
          Try adjusting your filters or search term
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Channel grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {channels.map((channel, index) => (
          <ChannelCard
            key={channel.sourceId ? `${channel.sourceId}-${channel.id}` : (channel.id || channel.uuid || `channel-${index}`)}
            channel={channel}
          />
        ))}
      </div>

      {/* Load more button */}
      {hasMore && (
        <div className="flex justify-center pt-6">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className={`
              rounded-xl px-6 py-3 text-sm font-semibold text-white transition-all duration-200
              ${loading
                ? 'cursor-not-allowed bg-slate-600/60'
                : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-900/40 active:scale-95'
              }
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-950
            `}
          >
            {loading ? (
              <span className="flex items-center">
                <svg
                  className="-ml-1 mr-3 h-5 w-5 animate-spin text-white"
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
