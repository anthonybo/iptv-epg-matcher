import React, { useState } from 'react';
import ChannelTableRow from './ChannelTableRow';

/**
 * Skeleton loader for table rows
 */
const TableRowSkeleton = () => (
  <tr className="border-b border-slate-800/50 bg-slate-900/40">
    <td className="px-2 py-3"><div className="h-5 w-9 bg-slate-800/70 rounded-full animate-pulse mx-auto"></div></td>
    <td className="px-4 py-3"><div className="h-4 w-8 bg-slate-800/70 rounded animate-pulse mx-auto"></div></td>
    <td className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 bg-slate-800/70 rounded-lg animate-pulse"></div>
        <div className="flex-1 space-y-2">
          <div className="h-4 w-32 bg-slate-800/70 rounded animate-pulse"></div>
          <div className="h-3 w-20 bg-slate-800/70 rounded animate-pulse"></div>
        </div>
      </div>
    </td>
    <td className="px-4 py-3"><div className="h-4 w-24 bg-slate-800/70 rounded animate-pulse"></div></td>
    <td className="px-4 py-3">
      <div className="flex items-center justify-end gap-1.5">
        <div className="h-7 w-7 bg-slate-800/70 rounded-lg animate-pulse"></div>
        <div className="h-7 w-7 bg-slate-800/70 rounded-lg animate-pulse"></div>
        <div className="h-7 w-7 bg-slate-800/70 rounded-lg animate-pulse"></div>
      </div>
    </td>
  </tr>
);

/**
 * ChannelTable - Table view for displaying channels with bulk actions
 * @param {Array} channels - Array of channel objects to display
 * @param {boolean} loading - Loading state
 * @param {boolean} hasMore - Whether more channels can be loaded
 * @param {Function} onLoadMore - Callback to load more channels
 * @param {Function} onChannelClick - Callback when a channel is clicked
 * @param {object} selectedChannel - Currently selected/active channel
 * @param {object} matchedChannels - Matched channel data
 * @param {Function} onPreview - Callback when preview button is clicked
 * @param {string} autoTestChannelKey - Composite key (sourceId-id) of channel currently being auto-tested
 */
const ChannelTable = ({
  channels,
  loading,
  hasMore,
  onLoadMore,
  onChannelClick,
  selectedChannel,
  matchedChannels = {},
  onPreview,
  autoTestChannelKey = null
}) => {
  const [selectedChannels, setSelectedChannels] = useState(new Set());
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');

  // Toggle individual channel selection
  const toggleChannel = (channel) => {
    const newSelected = new Set(selectedChannels);
    const key = `${channel.sourceId}-${channel.id}`;
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedChannels(newSelected);
  };

  // Toggle all channels selection
  const toggleAll = () => {
    if (selectedChannels.size === channels.length) {
      setSelectedChannels(new Set());
    } else {
      const allKeys = channels.map(ch => `${ch.sourceId}-${ch.id}`);
      setSelectedChannels(new Set(allKeys));
    }
  };

  // Clear selection
  const clearSelection = () => {
    setSelectedChannels(new Set());
  };

  // Handle sort
  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // Sort channels
  const sortedChannels = [...channels].sort((a, b) => {
    if (!sortColumn) return 0;

    let aVal = a[sortColumn] || '';
    let bVal = b[sortColumn] || '';

    if (sortColumn === 'name') {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  // Show skeleton loaders on initial load
  if (loading && channels.length === 0) {
    return (
      <div className="flex flex-col h-full bg-slate-950/80 rounded-2xl border border-slate-800/80 overflow-hidden">
        {/* Bulk Actions Bar (disabled during loading) */}
        <div className="border-b border-slate-800/50 bg-slate-900/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-16 bg-slate-800/70 rounded-lg animate-pulse"></div>
            <div className="h-8 w-8 bg-slate-800/70 rounded-lg animate-pulse"></div>
            <div className="h-px flex-1 bg-slate-800/50"></div>
            <div className="h-8 w-20 bg-slate-800/70 rounded-lg animate-pulse"></div>
            <div className="h-8 w-20 bg-slate-800/70 rounded-lg animate-pulse"></div>
            <div className="h-8 w-24 bg-slate-800/70 rounded-lg animate-pulse"></div>
            <div className="h-8 w-16 bg-slate-800/70 rounded-lg animate-pulse"></div>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 z-10 bg-slate-900/90 backdrop-blur border-b border-slate-800/50">
              <tr>
                <th className="w-12 px-2 py-3"></th>
                <th className="w-16 px-4 py-3 text-center text-xs font-semibold text-slate-400">#</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Group</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 15 }).map((_, index) => (
                <TableRowSkeleton key={index} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // No channels found
  if (!loading && channels.length === 0) {
    return (
      <div className="flex flex-col h-full bg-slate-950/80 rounded-2xl border border-slate-800/80 overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
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
      </div>
    );
  }

  const allSelected = selectedChannels.size === channels.length && channels.length > 0;
  const someSelected = selectedChannels.size > 0 && selectedChannels.size < channels.length;

  return (
    <div className="flex flex-col h-full bg-slate-950/80 rounded-2xl border border-slate-800/80 overflow-hidden">
      {/* Bulk Actions Bar */}
      <div className="border-b border-slate-800/50 bg-slate-900/60 px-4 py-3">
        <div className="flex items-center gap-2">
          {/* Select All Dropdown */}
          <div className="relative">
            <button
              onClick={toggleAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700/80 bg-slate-800/60 text-sm font-medium text-slate-200 hover:bg-slate-700/60 transition-colors"
            >
              <div className="flex items-center justify-center w-4 h-4 rounded border border-slate-500">
                {allSelected && (
                  <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {someSelected && !allSelected && (
                  <div className="w-2 h-0.5 bg-blue-400"></div>
                )}
              </div>
              All
            </button>
          </div>

          {/* Add New */}
          <button
            className="p-1.5 rounded-lg border border-green-700/60 bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-colors"
            title="Add channel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>

          <div className="h-6 w-px bg-slate-700/80"></div>

          {/* Bulk Actions (only show when items are selected) */}
          {selectedChannels.size > 0 && (
            <>
              <span className="text-xs text-slate-400 font-medium">
                {selectedChannels.size} selected
              </span>

              <button
                onClick={clearSelection}
                className="px-3 py-1.5 rounded-lg border border-slate-700/80 bg-slate-800/60 text-sm font-medium text-slate-300 hover:bg-slate-700/60 hover:text-red-400 transition-colors"
              >
                Remove
              </button>

              <button
                className="px-3 py-1.5 rounded-lg border border-slate-700/80 bg-slate-800/60 text-sm font-medium text-slate-300 hover:bg-slate-700/60 hover:text-blue-400 transition-colors"
              >
                Assign
              </button>

              <button
                className="px-3 py-1.5 rounded-lg border border-slate-700/80 bg-slate-800/60 text-sm font-medium text-slate-300 hover:bg-slate-700/60 hover:text-purple-400 transition-colors"
              >
                Auto-Match
              </button>
            </>
          )}

          <div className="flex-1"></div>

          {/* Add button (right side) */}
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-700/60 bg-blue-900/40 text-sm font-medium text-blue-300 hover:bg-blue-900/60 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-800/50">
            <tr>
              <th className="w-12 px-2 py-3">
                <div className="flex items-center justify-center">
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                </div>
              </th>
              <th className="w-16 px-4 py-3 text-center">
                <button
                  onClick={() => handleSort('id')}
                  className="flex items-center justify-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors mx-auto"
                >
                  #
                  {sortColumn === 'id' && (
                    <svg className={`w-3 h-3 ${sortDirection === 'desc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  )}
                </button>
              </th>
              <th className="px-4 py-3 text-left">
                <button
                  onClick={() => handleSort('name')}
                  className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Name
                  {sortColumn === 'name' && (
                    <svg className={`w-3 h-3 ${sortDirection === 'desc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  )}
                </button>
              </th>
              <th className="px-4 py-3 text-left">
                <button
                  onClick={() => handleSort('groupTitle')}
                  className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Group
                  {sortColumn === 'groupTitle' && (
                    <svg className={`w-3 h-3 ${sortDirection === 'desc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  )}
                </button>
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedChannels.map((channel, index) => {
              const key = `${channel.sourceId}-${channel.id}`;
              const isAutoTesting = autoTestChannelKey === key;
              return (
                <ChannelTableRow
                  key={key}
                  channel={channel}
                  index={index + 1}
                  isSelected={selectedChannels.has(key)}
                  isActive={selectedChannel?.id === channel.id}
                  isMatched={matchedChannels[channel.id] || matchedChannels[channel.tvgId]}
                  isAutoTesting={isAutoTesting}
                  onToggle={toggleChannel}
                  onClick={onChannelClick}
                  onPreview={onPreview}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Load more button */}
      {hasMore && (
        <div className="border-t border-slate-800/50 bg-slate-900/60 px-4 py-3">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className={`
              w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-200
              ${loading
                ? 'cursor-not-allowed bg-slate-700/40 text-slate-500'
                : 'bg-blue-600/80 text-white hover:bg-blue-600 active:scale-[0.98]'
              }
            `}
          >
            {loading ? (
              <span className="flex items-center justify-center">
                <svg
                  className="-ml-1 mr-3 h-5 w-5 animate-spin text-slate-400"
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
              'Load More Channels'
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default ChannelTable;
