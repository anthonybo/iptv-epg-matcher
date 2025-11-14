import React from 'react';

/**
 * VideoQualityBadge - Reusable component for displaying video quality/resolution
 *
 * @param {Object} props
 * @param {Object} props.quality - Quality info object with { resolution: string, width: number, height: number }
 * @param {string} props.className - Optional additional CSS classes
 * @param {boolean} props.showSeparator - Whether to show a separator bullet before the badge (default: false)
 * @param {string} props.size - Size variant: 'sm', 'md', or 'lg' (default: 'md')
 * @returns {JSX.Element|null}
 */
const VideoQualityBadge = ({
  quality,
  className = '',
  showSeparator = false,
  size = 'md'
}) => {
  if (!quality || !quality.resolution) {
    return null;
  }

  // Size variants
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-2.5 py-1 text-sm gap-1.5',
    lg: 'px-3 py-1.5 text-base gap-2'
  };

  const iconSizes = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5'
  };

  const badgeClasses = `
    inline-flex items-center rounded-md
    bg-emerald-500/20 text-emerald-200
    border-2 border-emerald-500/40
    font-semibold ${sizeClasses[size]} ${className}
  `.trim();

  return (
    <>
      {showSeparator && (
        <span className="text-slate-600">•</span>
      )}
      <span className={badgeClasses} title={`${quality.width}x${quality.height}`}>
        <svg
          className={iconSizes[size]}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
          />
        </svg>
        <span>{quality.resolution}</span>
      </span>
    </>
  );
};

export default VideoQualityBadge;
