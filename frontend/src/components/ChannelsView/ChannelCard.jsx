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
      className={`w-full text-left bg-white rounded-lg shadow-sm hover:shadow-lg transition-all duration-200 border-2 overflow-hidden group ${
        isSelected
          ? 'border-blue-500 ring-2 ring-blue-200'
          : 'border-gray-200 hover:border-blue-300'
      }`}
    >
      {/* Logo/Placeholder */}
      <div className="relative h-16 bg-gray-100">
        {channel.tvgLogo && !imageError ? (
          <img
            src={channel.tvgLogo}
            alt={channel.name}
            className="w-full h-full object-contain p-2"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className={`w-full h-full flex items-center justify-center ${placeholderColor} text-white text-2xl font-bold`}>
            {firstLetter}
          </div>
        )}

        {/* Match indicator badge */}
        {isMatched && (
          <div className="absolute top-1 right-1 bg-green-500 rounded-full p-1">
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </div>

      {/* Channel info */}
      <div className="p-3">
        {/* Channel name */}
        <h3 className={`text-sm font-semibold truncate transition-colors ${
          isSelected ? 'text-blue-700' : 'text-gray-900 group-hover:text-blue-600'
        }`}>
          {displayName}
        </h3>

        {/* Category */}
        <p className="text-xs text-gray-500 truncate mt-1">
          {channel.groupTitle || 'No Category'}
        </p>
      </div>
    </button>
  );
};

export default ChannelCard;
