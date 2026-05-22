import React, { useState } from 'react';
import ChannelTableRow from './ChannelTableRow';

/**
 * ChannelTable — polished media-table for browsing channels.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Bulk-action bar  (select-all + selection-context chips) │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Sortable header  (Channel · Group · Actions)            │
 *   │  ChannelTableRow × N                                     │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Load-more footer (when hasMore)                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * State logic (selectedChannels, sort, toggleAll, etc.) is
 * preserved from the previous version; only the rendered chrome
 * has been redesigned to match the rest of the app.
 */

// Skeleton row for the initial-load shimmer. Matches the new 4-column
// layout (we dropped the row-number column).
const TableRowSkeleton = () => (
  <tr className="border-b border-slate-800/40">
    <td className="pl-3 pr-2 py-3">
      <div className="w-4 h-4 rounded-sm bg-slate-900/70 animate-pulse" />
    </td>
    <td className="px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-md bg-slate-900/70 border border-slate-800/60 animate-pulse" />
        <div className="flex-1 space-y-2 min-w-0">
          <div className="h-3 w-44 rounded bg-slate-900/70 animate-pulse" />
          <div className="h-2.5 w-28 rounded bg-slate-900/50 animate-pulse" />
        </div>
      </div>
    </td>
    <td className="px-3 py-3">
      <div className="h-6 w-32 rounded-md bg-slate-900/70 border border-slate-800/60 animate-pulse" />
    </td>
    <td className="px-3 py-3">
      <div className="flex items-center justify-end gap-1.5">
        <div className="w-8 h-8 rounded-md bg-slate-900/70 animate-pulse" />
        <div className="h-8 w-20 rounded-md bg-slate-900/70 animate-pulse" />
        <div className="h-8 w-16 rounded-md bg-slate-900/70 animate-pulse" />
      </div>
    </td>
  </tr>
);

// Mono-caps sort header button with a small chevron that reveals on
// hover (inactive columns) or flips direction (active column).
const SortButton = ({ active, direction, onClick, children }) => (
  <button
    onClick={onClick}
    className={`group/sort inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.22em] transition ${
      active ? 'text-cyan-200' : 'text-slate-500 hover:text-slate-300'
    }`}
  >
    {children}
    {active ? (
      <span className="inline-flex items-center justify-center w-3 h-3 text-cyan-300">
        <svg
          className={`w-3 h-3 transition-transform ${direction === 'desc' ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2.8} viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </span>
    ) : (
      <span className="opacity-0 group-hover/sort:opacity-40 transition w-3 h-3 inline-flex items-center justify-center">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
        </svg>
      </span>
    )}
  </button>
);

const ChannelTable = ({
  channels,
  loading,
  hasMore,
  onLoadMore,
  onChannelClick,
  selectedChannel,
  matchedChannels = {},
  onPreview,
  autoTestChannelKey = null,
  onAutoTest,
  isAutoTesting = false
}) => {
  const [selectedChannels, setSelectedChannels] = useState(new Set());
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');

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

  const toggleAll = () => {
    if (selectedChannels.size === channels.length) {
      setSelectedChannels(new Set());
    } else {
      const allKeys = channels.map((ch) => `${ch.sourceId}-${ch.id}`);
      setSelectedChannels(new Set(allKeys));
    }
  };

  const clearSelection = () => {
    setSelectedChannels(new Set());
  };

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sortedChannels = [...channels].sort((a, b) => {
    if (!sortColumn) return 0;
    let aVal = a[sortColumn] || '';
    let bVal = b[sortColumn] || '';
    if (sortColumn === 'name') {
      aVal = String(aVal).toLowerCase();
      bVal = String(bVal).toLowerCase();
    }
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  const allSelected = selectedChannels.size === channels.length && channels.length > 0;
  const someSelected = selectedChannels.size > 0 && selectedChannels.size < channels.length;

  // Shared shell so the loading, empty, and populated states all use
  // the same chrome — no layout jitter when channels appear or filters
  // empty the list.
  const renderShell = (bodyChildren) => (
    <div className="flex flex-col h-full bg-slate-950/60 rounded-xl border border-slate-800/80 overflow-hidden">
      {/* ── Bulk-action bar ───────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-slate-800/60 bg-slate-900/40 px-4 py-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Select-all checkbox + label */}
          <button
            onClick={toggleAll}
            disabled={channels.length === 0}
            className="group inline-flex items-center gap-2 h-8 pl-1.5 pr-3 rounded-md border border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900 transition disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Select all channels"
          >
            <span
              className={`flex items-center justify-center w-4 h-4 rounded-sm border transition ${
                allSelected
                  ? 'border-cyan-500/60 bg-cyan-500 shadow-[0_0_8px_-2px_rgba(34,211,238,0.6)]'
                  : someSelected
                  ? 'border-cyan-500/60 bg-cyan-500/[0.15]'
                  : 'border-slate-700 bg-slate-900/40 group-hover:border-slate-500'
              }`}
            >
              {allSelected && (
                <svg className="w-3 h-3 text-slate-950" fill="none" stroke="currentColor" strokeWidth={3.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {someSelected && !allSelected && (
                <span className="w-1.5 h-[2px] bg-cyan-400" />
              )}
            </span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-300">
              {allSelected ? 'All' : someSelected ? 'Some' : 'Select all'}
            </span>
          </button>

          <span className="w-px h-5 bg-slate-800 mx-1" />

          {selectedChannels.size > 0 ? (
            <>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] tabular-nums">
                <span className="text-cyan-200 font-bold">{selectedChannels.size}</span>
                <span className="ml-1 text-slate-500">selected</span>
              </span>

              <button
                onClick={clearSelection}
                className="inline-flex items-center h-8 px-3 rounded-md border border-slate-800 bg-slate-900/40 hover:border-rose-500/40 hover:bg-rose-500/[0.06] hover:text-rose-200 text-slate-400 font-mono text-[10px] font-bold uppercase tracking-[0.18em] transition"
                title="Remove selected channels"
              >
                Remove
              </button>
              <button
                className="inline-flex items-center h-8 px-3 rounded-md border border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:text-slate-100 text-slate-400 font-mono text-[10px] font-bold uppercase tracking-[0.18em] transition"
                title="Assign selected channels"
              >
                Assign
              </button>
              <button
                className="inline-flex items-center h-8 px-3 rounded-md border border-slate-800 bg-slate-900/40 hover:border-violet-500/40 hover:bg-violet-500/[0.06] hover:text-violet-200 text-slate-400 font-mono text-[10px] font-bold uppercase tracking-[0.18em] transition"
                title="Auto-match selected channels with EPG"
              >
                Auto-match
              </button>
            </>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
              Bulk actions appear when channels are selected
            </span>
          )}

          <div className="flex-1" />

          <button
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-800 bg-slate-900/40 hover:border-cyan-500/40 hover:bg-cyan-500/[0.06] hover:text-cyan-200 text-slate-300 font-mono text-[10px] font-bold uppercase tracking-[0.18em] transition"
            title="Add a channel manually"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            Add channel
          </button>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-slate-950/95 border-b border-slate-800/60 backdrop-blur-sm">
            <tr>
              <th className="w-12 pl-3 pr-2 py-3 text-left" />
              <th className="px-3 py-3 text-left">
                <SortButton
                  active={sortColumn === 'name'}
                  direction={sortDirection}
                  onClick={() => handleSort('name')}
                >
                  Channel
                </SortButton>
              </th>
              <th className="px-3 py-3 text-left">
                <SortButton
                  active={sortColumn === 'groupTitle'}
                  direction={sortDirection}
                  onClick={() => handleSort('groupTitle')}
                >
                  Group
                </SortButton>
              </th>
              <th className="px-3 py-3 text-right">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">
                  Actions
                </span>
              </th>
            </tr>
          </thead>
          <tbody>{bodyChildren}</tbody>
        </table>
      </div>

      {/* ── Load-more footer ──────────────────────────────────── */}
      {hasMore && (
        <div className="flex-shrink-0 border-t border-slate-800/60 bg-slate-900/40 px-4 py-3 flex items-center justify-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className={`inline-flex items-center justify-center gap-2 h-9 px-4 rounded-md border font-mono text-[11px] font-bold uppercase tracking-[0.18em] transition ${
              loading
                ? 'border-cyan-500/40 bg-cyan-500/[0.08] text-cyan-200 cursor-wait'
                : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:text-cyan-200 hover:border-cyan-500/40 hover:bg-cyan-500/[0.06]'
            }`}
          >
            {loading ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                Loading
              </>
            ) : (
              <>
                <span>Load more channels</span>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );

  // Initial-load skeleton
  if (loading && channels.length === 0) {
    return renderShell(
      Array.from({ length: 15 }).map((_, i) => <TableRowSkeleton key={i} />)
    );
  }

  // Empty state — slate vocabulary, no big sad-face icon.
  if (!loading && channels.length === 0) {
    return renderShell(
      <tr>
        <td colSpan={4} className="px-6 py-20">
          <div className="max-w-md mx-auto text-center space-y-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-600">
              Channels
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-bold text-slate-200">No channels match these filters</h3>
              <p className="text-[12.5px] text-slate-500 leading-relaxed">
                Try clearing a category filter, changing the source, or adjusting your search.
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-slate-800 bg-slate-900/40 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              0 matches
            </div>
          </div>
        </td>
      </tr>
    );
  }

  // Populated table
  return renderShell(
    sortedChannels.map((channel, idx) => {
      const key = `${channel.sourceId}-${channel.id}`;
      const isChannelAutoTesting = autoTestChannelKey === key;
      return (
        <ChannelTableRow
          key={key}
          channel={channel}
          index={idx + 1}
          isSelected={selectedChannels.has(key)}
          isActive={selectedChannel?.id === channel.id}
          isMatched={matchedChannels[channel.id] || matchedChannels[channel.tvgId]}
          isAutoTesting={isChannelAutoTesting}
          autoTestDisabled={isAutoTesting}
          onToggle={toggleChannel}
          onClick={onChannelClick}
          onPreview={onPreview}
          onAutoTest={onAutoTest}
        />
      );
    })
  );
};

export default ChannelTable;
