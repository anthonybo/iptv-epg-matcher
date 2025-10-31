import React, { useState, useEffect } from 'react';

/**
 * ChannelList component for displaying and filtering channels
 */
const ChannelList = ({
  channels = [],
  totalChannels = 0,
  onChannelSelect,
  selectedChannel,
  matchedChannels = {},
  hiddenCategories = [],
  selectedCategory,
  sessionId,
  isLoading = false,
  loadMoreChannels
}) => {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const filteredChannels = channels.filter((ch) => {
    const matchesSearch = ch.name.toLowerCase().includes(search.toLowerCase());
    const isVisible = !hiddenCategories.includes(ch.groupTitle);
    return matchesSearch && isVisible;
  });

  useEffect(() => {
    if (channels.length > 0 && filteredChannels.length === 0) {
      console.log('No channels match filters:', {
        totalChannels: channels.length,
        hiddenCategories,
        searchTerm: search
      });
    }
  }, [channels, filteredChannels, hiddenCategories, search]);

  const handleLoadMore = () => {
    if (loadMoreChannels) {
      const nextPage = page + 1;
      setPage(nextPage);
      loadMoreChannels(nextPage);
    }
  };

  const hasMore = channels.length < totalChannels;

  return (
    <section className="flex h-full flex-col rounded-3xl border border-slate-800/80 bg-slate-950/80">
      <header className="border-b border-slate-800/80 px-5 py-4">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search channels by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-slate-800/80 bg-slate-900/70 py-2.5 pl-9 pr-12 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
          <span className="rounded-full bg-slate-900/70 px-2 py-0.5">{filteredChannels.length} showing</span>
          <span className="rounded-full bg-slate-900/70 px-2 py-0.5">{totalChannels} total</span>
        </div>
      </header>

      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {isLoading && channels.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              <span className="inline-flex items-center gap-3 rounded-full border border-slate-800/80 bg-slate-900/70 px-4 py-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-blue-400"></span>
                Loading channels...
              </span>
            </div>
          ) : filteredChannels.length > 0 ? (
            <ul className="space-y-2">
              {filteredChannels.map((ch, index) => {
                const isActive = selectedChannel?.tvgId === ch.tvgId;
                const isMatched = Boolean(matchedChannels[ch.tvgId]);

                return (
                  <li key={ch.tvgId}>
                    <button
                      type="button"
                      onClick={() => onChannelSelect(ch)}
                      className={`flex w-full items-center justify-between gap-4 rounded-2xl border px-4 py-3 text-left transition ${
                        isActive
                          ? 'border-blue-500 bg-blue-500/10 text-blue-100 shadow-lg shadow-blue-900/40'
                          : index % 2 === 0
                          ? 'border-slate-800 bg-slate-900 hover:border-blue-500/40 hover:bg-slate-800'
                          : 'border-slate-800 bg-slate-950 hover:border-blue-500/40 hover:bg-slate-800'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm font-semibold ${isActive ? 'text-blue-100' : 'text-slate-200'}`}>
                          {ch.name}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          <span className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
                            {ch.groupTitle || 'Uncategorized'}
                          </span>
                          {isMatched && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6L9 17l-5-5"></path>
                              </svg>
                              Matched
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="whitespace-nowrap text-xs text-slate-400">{ch.tvgId || 'No ID'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex h-full items-center justify-center rounded-2xl border border-slate-800/80 bg-slate-900/70 text-sm text-slate-400">
              {search ? 'No channels match your search.' : 'No channels available.'}
            </div>
          )}
        </div>

        {hasMore && (
          <div className="border-t border-slate-800/80 px-5 py-4">
            <button
              type="button"
              onClick={handleLoadMore}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              Load more channels
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

export default ChannelList;
