import React from 'react';
import { useChannels } from './hooks/useChannels';
import CategorySidebar from './CategorySidebar';
import ChannelGrid from './ChannelGrid';
import ChannelCard from './ChannelCard';
import ChannelTable from './ChannelTable';

/**
 * ChannelsView - Main view for browsing and filtering channels
 * @param {string} sessionId - Session ID for fetching channel data
 * @param {Function} onChannelSelect - Callback when a channel is clicked
 * @param {object} selectedChannel - Currently selected channel
 * @param {object} matchedChannels - Matched channel data
 * @param {object} sourceFilter - IPTV source to filter by (optional)
 * @param {array} availableSources - List of available IPTV sources
 * @param {Function} onSourceChange - Callback when source selection changes
 */
const ChannelsView = ({ sessionId, onChannelSelect, selectedChannel, matchedChannels = {}, sourceFilter = null, availableSources = [], onSourceChange }) => {
  const [showSourceMenu, setShowSourceMenu] = React.useState(false);
  const [viewMode, setViewMode] = React.useState(() => {
    // Load view preference from localStorage
    return localStorage.getItem('channelsViewMode') || 'table';
  });
  const sourceMenuRef = React.useRef(null);

  // Save view mode preference to localStorage
  const handleViewModeChange = (mode) => {
    setViewMode(mode);
    localStorage.setItem('channelsViewMode', mode);
  };

  // Close dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(event.target)) {
        setShowSourceMenu(false);
      }
    };

    if (showSourceMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSourceMenu]);

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
  } = useChannels(sessionId, sourceFilter?.id);

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
        <div className="relative z-50 border-b border-slate-800 bg-slate-900/80 px-6 py-4 backdrop-blur">
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
            <div className="flex items-center gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-slate-100">Channels</h2>
                  {availableSources.length > 0 && (
                    <div className="relative" ref={sourceMenuRef}>
                      <button
                        onClick={() => setShowSourceMenu(!showSourceMenu)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/20 px-2.5 py-1 text-xs font-medium text-blue-100 hover:bg-blue-500/30 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                        </svg>
                        {sourceFilter ? (sourceFilter.nickname || sourceFilter.name) : 'All Sources'}
                        <svg className={`w-3.5 h-3.5 transition-transform ${showSourceMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>

                      {/* Source Dropdown Menu */}
                      {showSourceMenu && (
                        <div className="absolute left-0 mt-2 w-64 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl shadow-slate-950/30 z-[9999]">
                          <button
                            onClick={() => {
                              onSourceChange(null);
                              setShowSourceMenu(false);
                            }}
                            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-800 ${
                              !sourceFilter ? 'bg-blue-500/20 text-blue-100' : 'text-slate-300'
                            }`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                            <div>
                              <div className="font-medium">All Sources</div>
                              <div className="text-xs text-slate-500">Show channels from all IPTV sources</div>
                            </div>
                          </button>

                          <div className="border-t border-slate-800">
                            {availableSources.map((source) => (
                              <button
                                key={source.id}
                                onClick={() => {
                                  onSourceChange(source);
                                  setShowSourceMenu(false);
                                }}
                                className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-800 ${
                                  sourceFilter?.id === source.id ? 'bg-blue-500/20 text-blue-100' : 'text-slate-300'
                                }`}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                </svg>
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">{source.nickname || source.name}</div>
                                  {source.url && (
                                    <div className="text-xs text-slate-500 truncate">{source.url}</div>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
            </div>

            {/* View Toggle and Search */}
            <div className="flex items-center gap-3">
              {/* View Mode Toggle */}
              <div className="flex items-center rounded-lg border border-slate-800/80 bg-slate-900/70 p-1">
                <button
                  onClick={() => handleViewModeChange('grid')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Grid view"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                  Grid
                </button>
                <button
                  onClick={() => handleViewModeChange('table')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    viewMode === 'table'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Table view"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                  Table
                </button>
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
        </div>

        {/* Channel Display Area */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'grid' ? (
            <div className="h-full overflow-auto px-6 py-4">
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
          ) : (
            <div className="h-full px-6 py-4">
              <ChannelTable
                channels={channels}
                loading={loading}
                hasMore={hasMore}
                onLoadMore={loadMore}
                onChannelClick={onChannelSelect}
                selectedChannel={selectedChannel}
                matchedChannels={matchedChannels}
                onEdit={(channel) => {
                  console.log('Edit channel:', channel);
                  // TODO: Implement edit functionality
                }}
                onDelete={(channel) => {
                  console.log('Delete channel:', channel);
                  // TODO: Implement delete functionality
                }}
                onPlay={(channel) => {
                  console.log('Play channel:', channel);
                  // TODO: Implement play functionality
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChannelsView;
