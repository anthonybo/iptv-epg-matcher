import React, { useState } from 'react';

/**
 * ChannelTableRow - Table row for a single channel with actions
 * @param {object} channel - Channel object
 * @param {number} index - Row index/number
 * @param {boolean} isSelected - Whether this row is selected
 * @param {boolean} isActive - Whether this channel is currently active
 * @param {boolean} isMatched - Whether this channel is matched with EPG
 * @param {Function} onToggle - Callback when toggle is clicked
 * @param {Function} onClick - Callback when row is clicked
 * @param {Function} onEdit - Callback when edit button is clicked
 * @param {Function} onDelete - Callback when delete button is clicked
 * @param {Function} onPlay - Callback when play button is clicked
 */
const ChannelTableRow = ({
  channel,
  index,
  isSelected,
  isActive,
  isMatched,
  onToggle,
  onClick,
  onEdit,
  onDelete,
  onPlay
}) => {
  const [imageError, setImageError] = useState(false);

  // Clean up channel name
  const cleanChannelName = (name) => {
    if (!name) return 'Unnamed Channel';
    let cleaned = name.replace(/#EXTINF:[^,]*,/, '');
    cleaned = cleaned.replace(/tvg-[a-z]+="[^"]*"/g, '');
    cleaned = cleaned.replace(/group-title="[^"]*"/g, '');
    return cleaned.trim() || 'Unnamed Channel';
  };

  const displayName = cleanChannelName(channel.name);
  const hasHD = displayName.toUpperCase().includes('HD');
  const logoUrl = channel.logo || channel.tvgLogo;

  return (
    <tr
      className={`group border-b border-slate-800/50 transition-colors ${
        isActive
          ? 'bg-blue-500/10'
          : 'bg-slate-900/40 hover:bg-slate-800/60'
      }`}
    >

      {/* Checkbox/Toggle */}
      <td className="w-12 px-2 py-3">
        <div className="flex items-center justify-center">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle && onToggle(channel);
            }}
            className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-950"
            style={{
              backgroundColor: isSelected ? '#3b82f6' : '#475569'
            }}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isSelected ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </td>

      {/* Row Number */}
      <td className="w-16 px-4 py-3 text-center text-sm text-slate-400 font-medium">
        {index}
      </td>

      {/* Channel Logo & Name */}
      <td className="px-4 py-3">
        <div
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => onClick && onClick(channel)}
        >
          {/* Logo */}
          <div className="w-12 h-12 flex-shrink-0 flex items-center justify-center">
            {logoUrl && !imageError ? (
              <img
                src={logoUrl}
                alt={channel.name}
                className="w-full h-full object-contain"
                onError={() => setImageError(true)}
              />
            ) : (
              <span className="text-slate-600 text-xs font-bold">
                {displayName[0].toUpperCase()}
              </span>
            )}
          </div>

          {/* Name & Badges */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-medium truncate ${
                isActive ? 'text-blue-200' : 'text-slate-200'
              }`}>
                {displayName}
              </span>
              {hasHD && (
                <span className="flex-shrink-0 text-[10px] font-bold text-slate-400 bg-slate-800/60 px-1.5 py-0.5 rounded">
                  HD
                </span>
              )}
              {isMatched && (
                <span className="flex-shrink-0 text-green-400" title="Matched with EPG">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              )}
            </div>
            {/* IPTV Source badge */}
            {channel.sourceName && (
              <div className="mt-1">
                <span className="inline-flex items-center gap-1 text-[11px] text-blue-300 bg-blue-900/30 px-1.5 py-0.5 rounded border border-blue-700/30">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  {channel.sourceName}
                </span>
              </div>
            )}
          </div>
        </div>
      </td>

      {/* Group/Category */}
      <td className="px-4 py-3">
        <span className="text-sm text-slate-300">
          {channel.groupTitle || 'No Category'}
        </span>
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          {/* Edit */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit && onEdit(channel);
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
            title="Edit channel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>

          {/* Delete */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete && onDelete(channel);
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Delete channel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          {/* Play */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay && onPlay(channel);
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-green-400 hover:bg-green-500/10 transition-colors"
            title="Play channel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
};

export default ChannelTableRow;
