import React, { useState } from 'react';

/**
 * ChannelCard - Displays a single channel with logo/placeholder and info
 * @param {object} channel - Channel object with name, tvgLogo, groupTitle
 * @param {Function} onClick - Callback when card is clicked
 * @param {boolean} isSelected - Whether this channel is currently selected
 * @param {boolean} isMatched - Whether this channel is matched with EPG
 */
const ChannelCard = ({ channel, onClick, isSelected, isMatched }) => {
  const [imageError, setImageError] = useState(false);

  // Clean up channel name - remove M3U metadata if present
  const cleanChannelName = (name) => {
    if (!name) return 'Unnamed Channel';
    // Remove M3U #EXTINF metadata if it exists in the name
    let cleaned = name.replace(/#EXTINF:[^,]*,/, '');
    // Remove tvg- attributes that might be in the name
    cleaned = cleaned.replace(/tvg-[a-z]+="[^"]*"/g, '');
    // Remove group-title attributes
    cleaned = cleaned.replace(/group-title="[^"]*"/g, '');
    return cleaned.trim() || 'Unnamed Channel';
  };

  // Generate a consistent color based on channel name
  const getPlaceholderColor = (name) => {
    const colors = [
      'bg-blue-500',
      'bg-red-500',
      'bg-green-500',
      'bg-yellow-500',
      'bg-purple-500',
      'bg-teal-500',
      'bg-pink-500',
      'bg-indigo-500'
    ];
    const charCode = (name && name.length > 0) ? name.charCodeAt(0) : 0;
    return colors[charCode % colors.length];
  };

  const displayName = cleanChannelName(channel.name);
  const firstLetter = displayName[0].toUpperCase();
  const placeholderColor = getPlaceholderColor(displayName);

  return (
    <button
      onClick={onClick}
      className={`group w-full overflow-hidden rounded-2xl border transition-all duration-200 text-left shadow-lg shadow-slate-950/20 ${
        isSelected
          ? 'border-blue-500/70 ring-2 ring-blue-400/60'
          : 'border-slate-800/80 hover:-translate-y-0.5 hover:border-blue-500/40'
      } bg-slate-900/80`}
    >
      {/* Logo/Placeholder */}
      <div className="relative h-16 bg-slate-900/90">
        {channel.tvgLogo && !imageError ? (
          <img
            src={channel.tvgLogo}
            alt={channel.name}
            className="w-full h-full object-contain p-2"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className={`flex h-full w-full items-center justify-center text-2xl font-bold text-white ${placeholderColor}`}>
            {firstLetter}
          </div>
        )}

        {/* Match indicator badge */}
        {isMatched && (
          <div className="absolute right-1 top-1 rounded-full bg-green-500 p-1 shadow shadow-green-900/40">
            <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </div>

      {/* Channel info */}
      <div className="p-3">
        {/* Channel name */}
        <h3
          className={`truncate text-sm font-semibold transition-colors ${
            isSelected ? 'text-blue-200' : 'text-slate-100 group-hover:text-blue-200'
          }`}
        >
          {displayName}
        </h3>

        {/* Category */}
        <p className="mt-1 truncate text-xs text-slate-400">
          {channel.groupTitle || 'No Category'}
        </p>
      </div>
    </button>
  );
};

export default ChannelCard;
