import React, { useState, useEffect, useRef } from 'react';
import apiClient from './utils/apiClient';

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
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const gridRef = useRef(null);

  // Fetch matched channels with their EPG data
  useEffect(() => {
    const fetchMatchedChannels = async () => {
      if (!sessionId) {
        setError('No session ID available');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const response = await apiClient.get(`/epg/${sessionId}/matched-channels`);
        setMatchedChannels(response.data.channels || []);
      } catch (err) {
        console.error('Error fetching matched channels:', err);
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchMatchedChannels();
  }, [sessionId]);

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute

    return () => clearInterval(timer);
  }, []);

  // Scroll to current time on mount
  useEffect(() => {
    if (gridRef.current && matchedChannels.length > 0) {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const minutesSinceMidnight = (now - startOfDay) / (1000 * 60);
      const pixelsPerMinute = 4; // 240px per hour = 4px per minute
      const scrollPosition = minutesSinceMidnight * pixelsPerMinute - 200; // Offset to center current time

      gridRef.current.scrollLeft = Math.max(0, scrollPosition);
    }
  }, [matchedChannels]);

  // Filter channels by search term (search channel names, program titles, and descriptions)
  const filteredChannels = matchedChannels.filter(channel => {
    const search = searchTerm.toLowerCase();

    // Search in channel name
    if (channel.name.toLowerCase().includes(search)) {
      return true;
    }

    // Search in program titles and descriptions
    if (channel.programs && channel.programs.length > 0) {
      return channel.programs.some(program =>
        (program.title && program.title.toLowerCase().includes(search)) ||
        (program.description && program.description.toLowerCase().includes(search))
      );
    }

    return false;
  });

  // Handle channel click
  const handleChannelClick = (channel) => {
    setSelectedChannel(channel);
    if (onChannelSelect) {
      onChannelSelect(channel);
    }
  };

  // Generate time slots for the grid (24 hours)
  const generateTimeSlots = () => {
    const slots = [];
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    for (let hour = 0; hour < 24; hour++) {
      const time = new Date(startOfDay);
      time.setHours(hour);
      slots.push(time);
    }
    return slots;
  };

  // Format time for display
  const formatTime = (date) => {
    if (!date) return '';
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  // Calculate position and width for a program block
  const getProgramPosition = (program) => {
    if (!program.start || !program.stop) return { left: 0, width: 0, display: 'none' };

    try {
      const start = new Date(program.start);
      const stop = new Date(program.stop);

      // Check if dates are valid
      if (isNaN(start.getTime()) || isNaN(stop.getTime())) {
        console.warn('Invalid program time:', program);
        return { left: 0, width: 0, display: 'none' };
      }

      // Check if program is on the current day
      const now = new Date();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(now);
      endOfToday.setHours(23, 59, 59, 999);

      // Skip programs that don't overlap with today
      if (stop < startOfToday || start > endOfToday) {
        return { left: 0, width: 0, display: 'none' };
      }

      const startOfDay = new Date(start);
      startOfDay.setHours(0, 0, 0, 0);

      const minutesSinceStart = (start - startOfDay) / (1000 * 60);
      const durationMinutes = (stop - start) / (1000 * 60);

      // Skip programs with invalid duration
      if (durationMinutes <= 0 || durationMinutes > 24 * 60) {
        console.warn('Invalid program duration:', program, durationMinutes);
        return { left: 0, width: 0, display: 'none' };
      }

      const pixelsPerMinute = 4; // 240px per hour = 4px per minute
      const left = minutesSinceStart * pixelsPerMinute;
      const width = durationMinutes * pixelsPerMinute;

      return { left, width, display: 'block' };
    } catch (error) {
      console.error('Error calculating program position:', error, program);
      return { left: 0, width: 0, display: 'none' };
    }
  };

  // Check if a program is currently airing
  const isCurrentProgram = (program) => {
    if (!program.start || !program.stop) return false;
    const now = currentTime;
    const start = new Date(program.start);
    const stop = new Date(program.stop);
    return now >= start && now < stop;
  };

  // Get current time indicator position
  const getCurrentTimePosition = () => {
    const now = currentTime;
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const minutesSinceMidnight = (now - startOfDay) / (1000 * 60);
    const pixelsPerMinute = 4;
    return minutesSinceMidnight * pixelsPerMinute;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-gray-600">Loading your TV Guide...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
          <div className="flex items-center mb-2">
            <svg className="w-6 h-6 text-red-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-lg font-semibold text-red-800">Error Loading Guide</h3>
          </div>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (matchedChannels.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 max-w-md text-center">
          <svg className="w-16 h-16 text-yellow-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h3 className="text-lg font-semibold text-yellow-800 mb-2">No EPG Matches Yet</h3>
          <p className="text-sm text-yellow-700 mb-4">
            You haven't matched any channels with EPG data yet. Go to the Player tab to match channels with their program guides.
          </p>
        </div>
      </div>
    );
  }

  const timeSlots = generateTimeSlots();
  const currentTimePos = getCurrentTimePosition();

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
          <div className="w-48 flex-shrink-0 bg-gray-800 border-r border-gray-700 overflow-y-auto">
            {/* Time header spacer */}
            <div className="h-12 bg-gray-900 border-b border-gray-700 flex items-center px-3">
              <span className="text-xs font-semibold text-gray-400">CHANNELS</span>
            </div>

            {/* Channel list */}
            {filteredChannels.map((channel, index) => (
              <div
                key={index}
                className="h-20 border-b border-gray-700 flex items-center px-3 cursor-pointer hover:bg-gray-700 transition-colors"
                onClick={() => handleChannelClick(channel)}
              >
                <div className="flex items-center gap-2 w-full">
                  {channel.logo && (
                    <img
                      src={channel.logo}
                      alt={channel.name}
                      className="w-8 h-8 rounded object-contain bg-gray-900 p-1"
                      onError={(e) => e.target.style.display = 'none'}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-white truncate">{channel.name}</h3>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Program Grid (Scrollable) */}
          <div className="flex-1 overflow-auto" ref={gridRef}>
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
                      {formatTime(time)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Current time indicator */}
              <div
                className="absolute top-12 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
                style={{ left: `${currentTimePos}px` }}
              >
                <div className="absolute -top-12 -left-2 w-4 h-4 bg-red-500 rounded-full"></div>
              </div>

              {/* Program rows */}
              {filteredChannels.map((channel, channelIndex) => (
                <div
                  key={channelIndex}
                  className="h-20 border-b border-gray-700 relative overflow-hidden"
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
                  {channel.programs && channel.programs.map((program, programIndex) => {
                    const position = getProgramPosition(program);
                    const isCurrent = isCurrentProgram(program);

                    if (position.display === 'none') return null;

                    return (
                      <div
                        key={programIndex}
                        className={`absolute top-1 bottom-1 rounded px-2 py-1 overflow-hidden cursor-pointer transition-all hover:z-10 hover:shadow-lg ${
                          isCurrent
                            ? 'bg-blue-600 border-2 border-blue-400'
                            : 'bg-gray-700 border border-gray-600 hover:bg-gray-600'
                        }`}
                        style={{
                          left: `${position.left}px`,
                          width: `${Math.max(position.width - 4, 60)}px`,
                        }}
                        title={`${program.title} (${formatTime(program.start)} - ${formatTime(program.stop)})`}
                      >
                        <div className="text-xs font-semibold text-white truncate">
                          {program.title}
                        </div>
                        <div className="text-xs text-gray-300 truncate">
                          {formatTime(program.start)} - {formatTime(program.stop)}
                        </div>
                        {program.description && position.width > 200 && (
                          <div className="text-xs text-gray-400 truncate mt-0.5">
                            {program.description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GuideView;
