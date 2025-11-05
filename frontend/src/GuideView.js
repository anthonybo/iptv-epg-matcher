import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import apiClient from './utils/apiClient';
import './GuideView.css';

const HOURS_IN_DAY = 24;
const MINUTES_IN_HOUR = 60;
const HOUR_COLUMN_WIDTH = 240;
const PIXELS_PER_MINUTE = HOUR_COLUMN_WIDTH / MINUTES_IN_HOUR;
const MIN_PROGRAM_WIDTH = 120;
const PROGRAM_HORIZONTAL_GAP = 4;
const LABEL_SAFE_PADDING = 16;

const formatDisplayTime = (value) => {
  if (!value) return '';

  try {
    const date = typeof value === 'string' ? new Date(value) : value;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    console.warn('[GuideView] Failed to format time', value, error);
    return '';
  }
};

const buildTimeSlots = (referenceDate = new Date()) => {
  const startOfDay = new Date(referenceDate);
  startOfDay.setHours(0, 0, 0, 0);

  return Array.from({ length: HOURS_IN_DAY }, (_, hour) => {
    const slot = new Date(startOfDay);
    slot.setHours(hour);
    return slot;
  });
};

const filterChannels = (channels, rawTerm) => {
  const term = rawTerm.trim().toLowerCase();

  if (!term) {
    return channels;
  }

  return channels.filter((channel) => {
    if (!channel) return false;

    if (channel.name && channel.name.toLowerCase().includes(term)) {
      return true;
    }

    if (Array.isArray(channel.programs)) {
      return channel.programs.some((program) => {
        if (!program) return false;
        return (
          (program.title && program.title.toLowerCase().includes(term)) ||
          (program.description && program.description.toLowerCase().includes(term))
        );
      });
    }

    return false;
  });
};

const getProgramMetrics = (program, viewDate) => {
  if (!program?.start || !program?.stop) {
    return null;
  }

  const start = new Date(program.start);
  const stop = new Date(program.stop);

  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
    return null;
  }

  const viewStart = new Date(viewDate);
  viewStart.setHours(0, 0, 0, 0);
  const viewEnd = new Date(viewStart);
  viewEnd.setDate(viewEnd.getDate() + 1);

  if (stop <= viewStart || start >= viewEnd) {
    return null;
  }

  const clampedStart = start < viewStart ? viewStart : start;
  const clampedStop = stop > viewEnd ? viewEnd : stop;
  const minutesSinceStart = (clampedStart - viewStart) / 60000;
  const durationMinutes = (clampedStop - clampedStart) / 60000;

  if (durationMinutes <= 0 || durationMinutes > HOURS_IN_DAY * MINUTES_IN_HOUR) {
    return null;
  }

  return {
    left: minutesSinceStart * PIXELS_PER_MINUTE,
    width: Math.max(durationMinutes * PIXELS_PER_MINUTE, MIN_PROGRAM_WIDTH),
    durationMinutes,
  };
};

const isProgramCurrent = (program, now) => {
  if (!program?.start || !program?.stop) {
    return false;
  }

  const start = new Date(program.start);
  const stop = new Date(program.stop);

  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
    return false;
  }

  return now >= start && now < stop;
};

const ProgramBlock = React.memo(({ program, metrics, isCurrent, scrollLeft }) => {
  if (!metrics) {
    return null;
  }

  const width = Math.max(metrics.width - PROGRAM_HORIZONTAL_GAP, MIN_PROGRAM_WIDTH);
  const showStickyTitle = width > 220;
  const showDescription = Boolean(program.description) && width > 260;
  const hiddenLeft = Math.max(0, scrollLeft - metrics.left);
  const labelRef = useRef(null);
  const [labelWidth, setLabelWidth] = useState(0);

  useLayoutEffect(() => {
    if (!showStickyTitle || !labelRef.current) {
      return undefined;
    }

    const updateWidth = () => {
      setLabelWidth(labelRef.current.scrollWidth || labelRef.current.offsetWidth);
    };

    updateWidth();

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        updateWidth();
      });
      observer.observe(labelRef.current);
      return () => observer.disconnect();
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    return undefined;
  }, [program.title, showStickyTitle]);

  const maxLabelWidth = Math.max(0, width - LABEL_SAFE_PADDING);
  const availableTravel = Math.max(0, width - labelWidth - LABEL_SAFE_PADDING);
  const labelOffset = Math.min(hiddenLeft, availableTravel);
  const isLabelTruncated = showStickyTitle && labelWidth > maxLabelWidth;
  const titleClassName = showStickyTitle
    ? 'guide-program-title guide-program-title--sticky'
    : 'guide-program-title font-semibold leading-tight';
  const titleStyle = showStickyTitle
    ? {
        marginLeft: `${labelOffset}px`,
        maxWidth: `${maxLabelWidth}px`,
      }
    : undefined;
  const tooltipStyle = showStickyTitle
    ? {
        left: `${labelOffset}px`,
      }
    : undefined;

  return (
    <article
      className={`guide-program-card absolute top-1 bottom-1 flex flex-col justify-center rounded-xl border transition-all duration-150 ${
        isCurrent
          ? 'bg-blue-600/90 ring-2 ring-blue-300/70 shadow-lg shadow-blue-900/40'
          : 'bg-gray-700/90 ring-1 ring-gray-600/60 hover:bg-gray-600/90 hover:ring-gray-500/70'
      }`}
      style={{ left: `${metrics.left}px`, width: `${width}px` }}
      title={`${program.title ?? 'Unknown program'}\n${formatDisplayTime(program.start)} - ${formatDisplayTime(program.stop)}${
        program.description ? `\n${program.description}` : ''
      }`}
    >
      <div className="relative flex h-full flex-col justify-between gap-2 px-3 py-2 text-white">
        <div
          ref={labelRef}
          className={titleClassName}
          data-title={program.title ?? 'Unknown program'}
          style={titleStyle}
          title={program.title ?? 'Unknown program'}
        >
          <span className="guide-program-title-text">
            {program.title ?? 'Unknown program'}
          </span>
        </div>
        {isLabelTruncated && (
          <div className="guide-program-title-tooltip" role="tooltip" style={tooltipStyle}>
            {program.title ?? 'Unknown program'}
          </div>
        )}
        <div className="text-xs font-semibold text-gray-100 whitespace-nowrap">
          {formatDisplayTime(program.start)} - {formatDisplayTime(program.stop)}
        </div>
        {showDescription && (
          <p className="text-xs text-gray-200 leading-tight line-clamp-3">
            {program.description}
          </p>
        )}
      </div>
    </article>
  );
});

ProgramBlock.displayName = 'ProgramBlock';

/**
 * GuideView component displays all channels with matched EPG data in a traditional grid layout
 * Shows current and upcoming programs for each matched channel in a time-based grid
 *
 * @param {Object} props Component properties
 * @param {string} props.sessionId Current session ID
 * @param {Function} props.onChannelSelect Callback when a channel is selected
 * @returns {JSX.Element} Guide view UI
 */
const GuideView = ({ sessionId, onChannelSelect }) => {
  const [matchedChannels, setMatchedChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [gridScrollLeft, setGridScrollLeft] = useState(0);
  const [channelToRemove, setChannelToRemove] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const gridRef = useRef(null);
  const autoScrolledRef = useRef(false);
  const scrollAnimationFrameRef = useRef(null);

  // Fetch matched channels with their EPG data
  useEffect(() => {
    if (!sessionId) {
      setMatchedChannels([]);
      setError('No session ID available');
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let isMounted = true;

    const fetchMatchedChannels = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await apiClient.get(`/epg/${sessionId}/matched-channels`, {
          signal: controller.signal,
        });

        if (!isMounted) {
          return;
        }

        setMatchedChannels(response.data.channels || []);
        autoScrolledRef.current = false;
      } catch (err) {
        if (controller.signal.aborted || !isMounted) {
          return;
        }

        console.error('Error fetching matched channels:', err);
        setError(err.response?.data?.error || err.message);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchMatchedChannels();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [sessionId]);

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute

    return () => clearInterval(timer);
  }, []);

  // Scroll to current time once data is available
  useLayoutEffect(() => {
    if (!gridRef.current || autoScrolledRef.current || matchedChannels.length === 0) {
      return;
    }

    const startOfDay = new Date(currentTime);
    startOfDay.setHours(0, 0, 0, 0);
    const minutesSinceMidnight = (currentTime - startOfDay) / 60000;
    const desiredScroll = minutesSinceMidnight * PIXELS_PER_MINUTE - (gridRef.current.clientWidth / 2);

    gridRef.current.scrollLeft = Math.max(0, desiredScroll);
    setGridScrollLeft(gridRef.current.scrollLeft);
    autoScrolledRef.current = true;
  }, [matchedChannels, currentTime]);

  const handleGridScroll = useCallback((event) => {
    const target = event.currentTarget.scrollLeft;

    if (scrollAnimationFrameRef.current) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
    }

    scrollAnimationFrameRef.current = requestAnimationFrame(() => {
      setGridScrollLeft(target);
    });
  }, []);

  useEffect(() => () => {
    if (scrollAnimationFrameRef.current) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
    }
  }, []);

  const filteredChannels = useMemo(
    () => filterChannels(matchedChannels, searchTerm),
    [matchedChannels, searchTerm]
  );

  // Handle channel click
  const handleChannelClick = useCallback(
    (channel) => {
      if (!channel) {
        return;
      }

      if (onChannelSelect) {
        // Transform the channel object to include sourceId and sourceName from iptvSource
        const transformedChannel = {
          ...channel,
          sourceId: channel.iptvSource?.id,
          sourceName: channel.iptvSource?.name,
          sourceType: channel.iptvSource?.type
        };
        onChannelSelect(transformedChannel);
      }
    },
    [onChannelSelect]
  );

  // Handle remove match
  const handleRemoveMatch = useCallback(
    (channel) => {
      setChannelToRemove(channel);
      setDeleteError(null);
    },
    []
  );

  // Confirm and execute removal
  const confirmRemoveMatch = useCallback(
    async () => {
      if (!channelToRemove) {
        return;
      }

      try {
        await apiClient.delete(`/epg/${sessionId}/match/${encodeURIComponent(channelToRemove.id)}`);

        // Refresh the channel list
        const response = await apiClient.get(`/epg/${sessionId}/matched-channels`);
        setMatchedChannels(response.data.channels || []);
        setChannelToRemove(null);
        setDeleteError(null);
      } catch (err) {
        console.error('Error removing match:', err);
        setDeleteError(err.response?.data?.error || 'Failed to remove channel from Guide');
      }
    },
    [sessionId, channelToRemove]
  );

  // Cancel removal
  const cancelRemoveMatch = useCallback(() => {
    setChannelToRemove(null);
    setDeleteError(null);
  }, []);

  const timeSlots = useMemo(() => buildTimeSlots(currentTime), [currentTime]);

  const currentTimePosition = useMemo(() => {
    const startOfDay = new Date(currentTime);
    startOfDay.setHours(0, 0, 0, 0);
    const minutesSinceMidnight = (currentTime - startOfDay) / 60000;
    return minutesSinceMidnight * PIXELS_PER_MINUTE;
  }, [currentTime]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-950">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-4"></div>
          <p className="text-slate-300">Loading your TV Guide...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-950">
        <div className="bg-red-950/50 border border-red-800 rounded-lg p-6 max-w-md">
          <div className="flex items-center mb-2">
            <svg className="w-6 h-6 text-red-400 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-lg font-semibold text-red-200">Error Loading Guide</h3>
          </div>
          <p className="text-sm text-red-300">{error}</p>
        </div>
      </div>
    );
  }

  if (matchedChannels.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-950">
        <div className="bg-yellow-950/50 border border-yellow-800 rounded-lg p-6 max-w-md text-center">
          <svg className="w-16 h-16 text-yellow-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h3 className="text-lg font-semibold text-yellow-200 mb-2">No EPG Matches Yet</h3>
          <p className="text-sm text-yellow-300 mb-4">
            You haven't matched any channels with EPG data yet. Go to the Player tab to match channels with their program guides.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">TV Guide</h2>
            <p className="text-sm text-gray-400 mt-0.5">
              {filteredChannels.length} {filteredChannels.length === 1 ? 'channel' : 'channels'} with EPG data
            </p>
          </div>

          {/* Search box */}
          <div className="relative w-80">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              placeholder="Search channels..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="block w-full pl-10 pr-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-gray-300"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* EPG Grid */}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full">
          {/* Channel Sidebar (Fixed) */}
          <div className="w-60 flex-shrink-0 bg-gray-800 border-r border-gray-700 overflow-y-auto">
            {/* Time header spacer */}
            <div className="h-12 bg-gray-900 border-b border-gray-700 flex items-center px-3">
              <span className="text-xs font-semibold text-gray-400">CHANNELS</span>
            </div>

            {/* Channel list */}
            {filteredChannels.map((channel, index) => (
              <div
                key={index}
                className="h-28 border-b border-gray-700 flex items-center px-3 hover:bg-gray-700 transition-colors group relative"
                title={channel.name}
              >
                <div
                  className="flex items-center gap-2 w-full cursor-pointer"
                  onClick={() => handleChannelClick(channel)}
                >
                  {channel.logo && (
                    <img
                      src={channel.logo}
                      alt={channel.name}
                      className="w-10 h-10 rounded object-contain bg-gray-900 p-1 flex-shrink-0"
                      onError={(e) => e.target.style.display = 'none'}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-white line-clamp-2">{channel.name}</h3>
                    {channel.iptvSource && (
                      <div className="mt-1">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-200 border border-blue-700/50">
                          {channel.iptvSource.name}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveMatch(channel);
                  }}
                  className="absolute right-2 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition-opacity p-1 hover:bg-red-900/20 rounded"
                  title="Remove from Guide"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Program Grid (Scrollable) */}
          <div className="flex-1 overflow-auto" ref={gridRef} onScroll={handleGridScroll}>
            <div className="relative" style={{ minWidth: `${24 * 240}px` }}>
              {/* Time header */}
              <div className="h-12 bg-gray-900 border-b border-gray-700 sticky top-0 z-10 flex">
                {timeSlots.map((time, index) => (
                  <div
                    key={index}
                    className="border-r border-gray-700"
                    style={{ width: '240px' }}
                  >
                    <div className="px-2 py-3 text-xs font-semibold text-gray-300">
                      {formatDisplayTime(time)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Current time indicator */}
              <div
                className="absolute top-0 bottom-0 z-20 pointer-events-none"
                style={{ left: `${currentTimePosition}px` }}
              >
                {/* Time label at top */}
                <div className="absolute top-2 -translate-x-1/2 px-2 py-1 bg-red-500 text-white text-xs font-bold rounded shadow-lg whitespace-nowrap">
                  {formatDisplayTime(currentTime)}
                </div>
                {/* Vertical line */}
                <div className="absolute top-12 bottom-0 w-0.5 bg-gradient-to-b from-red-500 to-red-600 shadow-lg shadow-red-500/50"></div>
              </div>

              {/* Program rows */}
              {filteredChannels.map((channel, channelIndex) => (
                <div
                  key={channelIndex}
                  className="h-28 border-b border-gray-700 relative"
                  style={{ isolation: 'isolate' }}
                >
                  {/* Hour dividers */}
                  {timeSlots.map((_, timeIndex) => (
                    <div
                      key={timeIndex}
                      className="absolute top-0 bottom-0 border-r border-gray-700"
                      style={{ left: `${timeIndex * 240}px`, width: '240px' }}
                    ></div>
                  ))}

                  {/* Programs */}
                  {Array.isArray(channel.programs) &&
                    channel.programs.map((program, programIndex) => {
                      const metrics = getProgramMetrics(program, currentTime);
                      if (!metrics) {
                        return null;
                      }

                      return (
                        <ProgramBlock
                          key={`${channel.id ?? channel.name}-${programIndex}`}
                          program={program}
                          metrics={metrics}
                          isCurrent={isProgramCurrent(program, currentTime)}
                          scrollLeft={gridScrollLeft}
                        />
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {channelToRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            {/* Header */}
            <div className="bg-slate-800 px-6 py-4 border-b border-slate-700">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                  <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-slate-100">Remove Channel from Guide?</h3>
              </div>
            </div>

            {/* Content */}
            <div className="px-6 py-5">
              <p className="text-slate-300 mb-4">
                Are you sure you want to remove <span className="font-semibold text-white">"{channelToRemove.name}"</span> from your TV Guide?
              </p>
              <p className="text-sm text-slate-400">
                This will remove the EPG match. You can always match this channel again from the Player tab.
              </p>

              {/* Error message */}
              {deleteError && (
                <div className="mt-4 bg-red-950/50 border border-red-800 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm text-red-200">{deleteError}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="bg-slate-800 px-6 py-4 flex items-center justify-end gap-3 border-t border-slate-700">
              <button
                onClick={cancelRemoveMatch}
                className="px-4 py-2 rounded-lg border border-slate-600 bg-slate-900 text-slate-300 font-medium hover:bg-slate-800 hover:text-slate-100 transition-all focus:outline-none focus:ring-2 focus:ring-slate-500"
              >
                Cancel
              </button>
              <button
                onClick={confirmRemoveMatch}
                className="px-4 py-2 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 transition-all focus:outline-none focus:ring-2 focus:ring-red-500 shadow-lg shadow-red-900/30"
              >
                Remove Channel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GuideView;
