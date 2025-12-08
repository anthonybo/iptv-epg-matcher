import React, { useState, useEffect, useCallback, useMemo } from 'react';
import apiClient from './utils/apiClient';
import IPTVPlayer from './IPTVPlayer';
import VideoQualityBadge from './components/VideoQualityBadge';
import { addToMultiview, getMultiviewStreams } from './utils/multiviewManager';
import { showToast } from './components/Toast';
import LiveScoresTicker from './components/LiveScoresTicker';
import EventCard from './components/EventCard';

/**
 * LiveEventsView - Displays all live sports events for today
 */
const LiveEventsView = ({ onNavigateToPlayer, sessionId }) => {
  const [liveEvents, setLiveEvents] = useState([]);
  const [upcomingEvents, setUpcomingEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [matchingChannels, setMatchingChannels] = useState([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [showSidePanel, setShowSidePanel] = useState(false);
  const [pipChannel, setPipChannel] = useState(null);
  const [showPipPlayer, setShowPipPlayer] = useState(false);
  const [pipVideoQuality, setPipVideoQuality] = useState(null);
  const [autoTesting, setAutoTesting] = useState(false);
  const [currentTestIndex, setCurrentTestIndex] = useState(0);
  const autoTestTimerRef = React.useRef(null);
  const autoTestingRef = React.useRef(false);
  const currentTestIndexRef = React.useRef(0);
  const matchingChannelsRef = React.useRef([]);
  const isAdvancingRef = React.useRef(false);
  const [selectedSports, setSelectedSports] = useState(new Set());
  const [selectedLeagues, setSelectedLeagues] = useState(new Set());
  const [multiviewUpdateTrigger, setMultiviewUpdateTrigger] = useState(0);
  const [multiviewStreams, setMultiviewStreams] = useState([]);
  const [liveScores, setLiveScores] = useState({}); // Map of event_id -> score data

  // Get unique sports and leagues with counts
  const getAvailableSports = () => {
    const allEvents = [...liveEvents, ...upcomingEvents];
    const sportsMap = new Map();
    allEvents.forEach(event => {
      const sport = event.sport_type;
      sportsMap.set(sport, (sportsMap.get(sport) || 0) + 1);
    });
    return Array.from(sportsMap.entries()).map(([sport, count]) => ({ sport, count }));
  };

  const getAvailableLeagues = () => {
    const allEvents = [...liveEvents, ...upcomingEvents];
    const leaguesMap = new Map();
    allEvents.forEach(event => {
      const league = event.league_name;
      leaguesMap.set(league, (leaguesMap.get(league) || 0) + 1);
    });
    return Array.from(leaguesMap.entries()).map(([league, count]) => ({ league, count }));
  };

  // Toggle filter functions
  const toggleSportFilter = (sport) => {
    const newSelected = new Set(selectedSports);
    if (newSelected.has(sport)) {
      newSelected.delete(sport);
    } else {
      newSelected.add(sport);
    }
    setSelectedSports(newSelected);
  };

  const toggleLeagueFilter = (league) => {
    const newSelected = new Set(selectedLeagues);
    if (newSelected.has(league)) {
      newSelected.delete(league);
    } else {
      newSelected.add(league);
    }
    setSelectedLeagues(newSelected);
  };

  const clearAllFilters = () => {
    setSelectedSports(new Set());
    setSelectedLeagues(new Set());
  };

  // Filter events based on selected filters
  const filterEvents = (events) => {
    if (selectedSports.size === 0 && selectedLeagues.size === 0) {
      return events;
    }

    return events.filter(event => {
      const sportMatch = selectedSports.size === 0 || selectedSports.has(event.sport_type);
      const leagueMatch = selectedLeagues.size === 0 || selectedLeagues.has(event.league_name);
      return sportMatch && leagueMatch;
    });
  };

  const filteredLiveEvents = filterEvents(liveEvents);
  const filteredUpcomingEvents = filterEvents(upcomingEvents);

  const fetchLiveEvents = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch currently live events
      const currentResponse = await apiClient.get('/live-events/current');
      setLiveEvents(currentResponse.data.events || []);

      // Fetch upcoming events (next 24 hours)
      const upcomingResponse = await apiClient.get('/live-events/upcoming?hours=24');
      setUpcomingEvents(upcomingResponse.data.events || []);

      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching live events:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      setError(null);

      // Trigger backend refresh from ESPN API
      const response = await apiClient.post('/live-events/refresh');

      if (response.data.success) {
        console.log(`Refreshed: ${response.data.totalFetched} events fetched, ${response.data.totalStored} stored`);
        // Re-fetch the events to display updated data
        await fetchLiveEvents();
      }
    } catch (err) {
      console.error('Error refreshing live events:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleEventClick = async (event) => {
    try {
      setSelectedEvent(event);
      setShowSidePanel(true);
      setLoadingChannels(true);
      setMatchingChannels([]);

      // Fetch matching channels
      const response = await apiClient.get(`/live-events/${event.event_id}/channels`);

      if (response.data.success) {
        const channels = response.data.channels || [];
        setMatchingChannels(channels);
        matchingChannelsRef.current = channels;
        console.log(`Found ${response.data.count} matching channels for ${event.event_name}`);
        console.log('Search terms:', response.data.searchTerms);
      }
    } catch (err) {
      console.error('Error fetching matching channels:', err);
    } finally {
      setLoadingChannels(false);
    }
  };

  const handleCloseSidePanel = () => {
    setShowSidePanel(false);
    setSelectedEvent(null);
    setMatchingChannels([]);
  };

  const handlePlayChannel = (channel) => {
    console.log('Play channel:', channel);
    if (onNavigateToPlayer) {
      onNavigateToPlayer(channel);
    }
  };

  const handlePlayPip = (channel) => {
    console.log('Play PiP:', channel);
    setPipChannel({
      id: channel.id,
      name: channel.name,
      logo: channel.logo,
      url: channel.url,
      sourceId: channel.source_id,
      sourceType: channel.source_type,
      sourceUrl: channel.source_url,
      sourceUsername: channel.source_username,
      sourcePassword: channel.source_password,
      sourceMac: channel.source_mac,
      sourceName: channel.source_name,
      // Include ESPN event data for reliable matching
      espnEventId: selectedEvent?.event_id,
      espnEventName: selectedEvent?.event_name
    });
    setPipVideoQuality(null); // Reset quality when changing channels
    setShowPipPlayer(true);
  };

  const handleClosePip = () => {
    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }
    setShowPipPlayer(false);
    setPipChannel(null);
    setPipVideoQuality(null); // Reset quality
    setAutoTesting(false);
    autoTestingRef.current = false;
    isAdvancingRef.current = false;
  };

  const handleAutoTest = (startingChannel = null) => {
    if (matchingChannels.length === 0) return;

    setAutoTesting(true);
    autoTestingRef.current = true;
    matchingChannelsRef.current = matchingChannels;
    setShowPipPlayer(true);

    // Find starting index
    let startIndex = 0;
    if (startingChannel) {
      startIndex = matchingChannels.findIndex(
        ch => ch.id === startingChannel.id && ch.source_id === startingChannel.source_id
      );
      if (startIndex === -1) startIndex = 0;
      console.log(`[Auto-Test] Starting from channel ${startIndex + 1}: ${startingChannel.name}`);
    } else {
      console.log('[Auto-Test] Starting from first channel');
    }

    setCurrentTestIndex(startIndex);
    currentTestIndexRef.current = startIndex;

    // Start with selected channel
    const firstChannel = matchingChannels[startIndex];
    setPipChannel({
      id: firstChannel.id,
      name: firstChannel.name,
      logo: firstChannel.logo,
      url: firstChannel.url,
      sourceId: firstChannel.source_id,
      sourceType: firstChannel.source_type,
      sourceUrl: firstChannel.source_url,
      sourceUsername: firstChannel.source_username,
      sourcePassword: firstChannel.source_password,
      sourceMac: firstChannel.source_mac,
      sourceName: firstChannel.source_name,
      // Include ESPN event data for reliable matching
      espnEventId: selectedEvent?.event_id,
      espnEventName: selectedEvent?.event_name
    });
    setPipVideoQuality(null); // Reset quality when starting auto-test

    // Set reasonable timeout (15 seconds) for auto-test mode
    // Streams should start playing within a few seconds if they're working
    // This timeout is a fallback for streams that hang without errors
    autoTestTimerRef.current = setTimeout(() => {
      console.log('[Auto-Test] Timeout reached (15s), moving to next channel...');
      handleNextChannel();
    }, 15000);
  };

  const handleNextChannel = () => {
    // Prevent multiple simultaneous calls
    if (isAdvancingRef.current) {
      console.log('[Auto-Test] Already advancing, ignoring duplicate call');
      return;
    }

    isAdvancingRef.current = true;

    // Clear existing timer
    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }

    // Use refs to get current values
    const channels = matchingChannelsRef.current;
    const currentIndex = currentTestIndexRef.current;

    console.log(`[Auto-Test] Current index: ${currentIndex}, Total channels: ${channels.length}`);

    if (!autoTestingRef.current || currentIndex >= channels.length - 1) {
      console.log('[Auto-Test] Stopping - reached end of channels or auto-test was stopped');
      setAutoTesting(false);
      autoTestingRef.current = false;
      isAdvancingRef.current = false;
      return;
    }

    const nextIndex = currentIndex + 1;
    currentTestIndexRef.current = nextIndex;
    setCurrentTestIndex(nextIndex);

    console.log(`[Auto-Test] Moving to channel ${nextIndex + 1} of ${channels.length}`);

    const nextChannel = channels[nextIndex];
    setPipChannel({
      id: nextChannel.id,
      name: nextChannel.name,
      logo: nextChannel.logo,
      url: nextChannel.url,
      sourceId: nextChannel.source_id,
      sourceType: nextChannel.source_type,
      sourceUrl: nextChannel.source_url,
      sourceUsername: nextChannel.source_username,
      sourcePassword: nextChannel.source_password,
      sourceMac: nextChannel.source_mac,
      sourceName: nextChannel.source_name,
      // Include ESPN event data for reliable matching
      espnEventId: selectedEvent?.event_id,
      espnEventName: selectedEvent?.event_name
    });
    setPipVideoQuality(null); // Reset quality when advancing to next channel

    // Reset advancing flag after a short delay
    setTimeout(() => {
      isAdvancingRef.current = false;
    }, 500);

    // Set reasonable timeout (15 seconds) - only advances on error or timeout
    autoTestTimerRef.current = setTimeout(() => {
      console.log('[Auto-Test] Timeout reached (15s), moving to next channel...');
      handleNextChannel();
    }, 15000);
  };

  const handleStopAutoTest = () => {
    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }
    setAutoTesting(false);
    autoTestingRef.current = false;
    isAdvancingRef.current = false;
  };

  const handleAddToMultiview = async () => {
    if (!pipChannel) return;

    const success = await addToMultiview(pipChannel);

    if (success) {
      window.dispatchEvent(new Event('multiviewUpdate'));
      showToast(`Added "${pipChannel.name}" to Multi-View`, 'success');
    } else {
      showToast('Failed to add to Multi-View', 'error');
    }
  };

  // Check if ANY stream from the same source is in multiview
  const isInMultiview = React.useMemo(() => {
    if (!pipChannel) return false;
    // Check if any stream from the same source (by sourceId) is in multiview
    return multiviewStreams.some(
      stream => stream.sourceId === pipChannel.sourceId
    );
  }, [pipChannel, multiviewStreams]);

  // Callback when stream successfully starts playing - stop auto-test
  const handleStreamPlaying = React.useCallback(() => {
    if (!autoTestingRef.current) return;

    console.log('[Auto-Test] ✓ Working stream found! Stopping auto-test.');

    // Clear the timeout - we found a working stream!
    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }

    // Stop auto-testing but keep the stream playing
    setAutoTesting(false);
    autoTestingRef.current = false;
    isAdvancingRef.current = false;
  }, []);

  // Callback when stream fails - advance to next channel
  const handleStreamError = React.useCallback(() => {
    if (!autoTestingRef.current || isAdvancingRef.current) return;

    console.log('[Auto-Test] Stream error, moving to next channel...');
    handleNextChannel();
  }, []);

  useEffect(() => {
    fetchLiveEvents();

    // Cleanup on unmount
    return () => {
      if (autoTestTimerRef.current) {
        clearTimeout(autoTestTimerRef.current);
      }
    };
  }, []);

  // Load multiview streams on mount and when updated
  useEffect(() => {
    let ignore = false;

    const loadMultiviewStreams = async () => {
      try {
        const streams = await getMultiviewStreams();
        if (!ignore) {
          setMultiviewStreams(streams);
        }
      } catch (error) {
        if (!ignore) {
          console.error('Failed to load multiview streams:', error);
          // Fail silently for multiview status (non-critical feature)
          setMultiviewStreams([]);
        }
      }
    };

    loadMultiviewStreams();

    return () => {
      ignore = true;
    };
  }, [multiviewUpdateTrigger]);

  // Listen for multiview updates to refresh badge colors
  useEffect(() => {
    const handleMultiviewUpdate = () => {
      setMultiviewUpdateTrigger(prev => prev + 1);
    };

    window.addEventListener('multiviewUpdate', handleMultiviewUpdate);

    return () => {
      window.removeEventListener('multiviewUpdate', handleMultiviewUpdate);
      window.removeEventListener('storage', handleMultiviewUpdate);
    };
  }, []);

  // Fetch live scores on mount only (ticker handles polling)
  useEffect(() => {
    let ignore = false;

    const fetchLiveScores = async () => {
      try {
        const response = await apiClient.get('/live-scores/all');
        if (!ignore && response.data.success && response.data.scores) {
          const scoresMap = {};
          response.data.scores.forEach(score => {
            scoresMap[score.event_id] = score;
          });
          setLiveScores(scoresMap);
        }
      } catch (err) {
        if (!ignore) {
          console.error('Error fetching live scores:', err);
        }
      }
    };

    fetchLiveScores();

    return () => {
      ignore = true;
    };
  }, []);

  // Check if event has any channels in multiview - memoized for stable reference
  const isEventInMultiview = useCallback((eventId) => {
    return multiviewStreams.some(stream => stream.espnEventId === eventId);
  }, [multiviewStreams]);

  // Create a Set of multiview event IDs for O(1) lookup
  const multiviewEventIds = useMemo(() => {
    return new Set(multiviewStreams.map(stream => stream.espnEventId).filter(Boolean));
  }, [multiviewStreams]);

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-r-transparent"></div>
          <p className="text-slate-400">Loading live events...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 px-6 py-8">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div className="space-y-2">
          <h2 className="text-3xl font-semibold text-slate-100">Live Events</h2>
          <p className="max-w-3xl text-sm text-slate-400">
            View all live and upcoming sports events for today. Data sourced from ESPN API.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-xl bg-blue-500/20 px-4 py-2.5 text-sm font-medium text-blue-300 transition-all hover:bg-blue-500/30 disabled:opacity-50"
        >
          <svg
            className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.2" />
          </svg>
          {refreshing ? 'Refreshing...' : 'Refresh Events'}
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {lastRefresh && (
        <div className="text-sm text-slate-500">
          Last updated: {lastRefresh.toLocaleTimeString()}
        </div>
      )}

      {/* Filters */}
      {(liveEvents.length > 0 || upcomingEvents.length > 0) && (
        <div className="space-y-4">
          {/* Sport Filters */}
          {getAvailableSports().length > 1 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-slate-400">Filter by Sport</h4>
                {(selectedSports.size > 0 || selectedLeagues.size > 0) && (
                  <button
                    onClick={clearAllFilters}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {getAvailableSports().map(({ sport, count }) => (
                  <button
                    key={sport}
                    onClick={() => toggleSportFilter(sport)}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition-all ${
                      selectedSports.has(sport)
                        ? 'bg-blue-500/20 text-blue-300 ring-2 ring-blue-500/50'
                        : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {sport} ({count})
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* League Filters */}
          {getAvailableLeagues().length > 1 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-slate-400">Filter by League</h4>
              <div className="flex flex-wrap gap-2">
                {getAvailableLeagues().map(({ league, count }) => (
                  <button
                    key={league}
                    onClick={() => toggleLeagueFilter(league)}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition-all ${
                      selectedLeagues.has(league)
                        ? 'bg-emerald-500/20 text-emerald-300 ring-2 ring-emerald-500/50'
                        : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {league} ({count})
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Currently Live Events */}
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-xl font-semibold text-slate-200">
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-400"></span>
          Currently Live
          <span className="ml-2 rounded-full bg-slate-800 px-2.5 py-0.5 text-sm font-medium text-slate-300">
            {filteredLiveEvents.length}
          </span>
          {(selectedSports.size > 0 || selectedLeagues.size > 0) && filteredLiveEvents.length !== liveEvents.length && (
            <span className="text-xs text-slate-500">
              (filtered from {liveEvents.length})
            </span>
          )}
        </h3>

        {filteredLiveEvents.length === 0 ? (
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-8 text-center">
            <p className="text-slate-400">
              {liveEvents.length === 0 ? 'No events currently live' : 'No events match the selected filters'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredLiveEvents.map((event) => (
              <EventCard
                key={event.event_id}
                event={event}
                isLive={true}
                score={liveScores[event.event_id]}
                inMultiview={multiviewEventIds.has(event.event_id)}
                onClick={() => handleEventClick(event)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Upcoming Events */}
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-xl font-semibold text-slate-200">
          <svg className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          Upcoming (Next 24 Hours)
          <span className="ml-2 rounded-full bg-slate-800 px-2.5 py-0.5 text-sm font-medium text-slate-300">
            {filteredUpcomingEvents.length}
          </span>
          {(selectedSports.size > 0 || selectedLeagues.size > 0) && filteredUpcomingEvents.length !== upcomingEvents.length && (
            <span className="text-xs text-slate-500">
              (filtered from {upcomingEvents.length})
            </span>
          )}
        </h3>

        {filteredUpcomingEvents.length === 0 ? (
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-8 text-center">
            <p className="text-slate-400">
              {upcomingEvents.length === 0 ? 'No upcoming events in the next 24 hours' : 'No events match the selected filters'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredUpcomingEvents.map((event) => (
              <EventCard
                key={event.event_id}
                event={event}
                isLive={false}
                score={liveScores[event.event_id]}
                inMultiview={multiviewEventIds.has(event.event_id)}
                onClick={() => handleEventClick(event)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Side Panel for Matching Channels */}
      {showSidePanel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={handleCloseSidePanel}
          />

          {/* Side Panel */}
          <div className="fixed right-0 top-0 bottom-0 w-[700px] bg-slate-900 border-l border-slate-800 shadow-2xl z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 p-4">
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-slate-100">
                  Available Channels
                  {matchingChannels.length > 0 && (
                    <span className="ml-2 rounded-full bg-slate-800 px-2.5 py-0.5 text-sm font-medium text-slate-300">
                      {matchingChannels.length}
                    </span>
                  )}
                </h3>
                {selectedEvent && (
                  <p className="mt-1 text-sm text-slate-400 line-clamp-2">
                    {selectedEvent.event_name}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 ml-2">
                {matchingChannels.length > 0 && (
                  <button
                    onClick={handleAutoTest}
                    disabled={autoTesting}
                    className="rounded-lg p-2 text-purple-400 transition-colors hover:bg-purple-500/20 disabled:opacity-50"
                    title={autoTesting ? 'Auto-Testing...' : 'Auto-Test All Channels'}
                  >
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M10 8l6 4-6 4V8z" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={handleCloseSidePanel}
                  className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                  title="Close"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {loadingChannels ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-r-transparent"></div>
                    <p className="text-slate-400">Searching for channels...</p>
                  </div>
                </div>
              ) : matchingChannels.length === 0 ? (
                <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-8 text-center">
                  <svg className="mx-auto mb-3 h-12 w-12 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M16 16s-1.5-2-4-2-4 2-4 2M9 9h.01M15 9h.01" />
                  </svg>
                  <p className="text-slate-400">No matching channels found</p>
                  <p className="mt-2 text-xs text-slate-500">
                    Try adding more IPTV sources or check your channel names
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {matchingChannels.map((channel, index) => (
                    <div
                      key={`${channel.source_id}_${channel.id}_${index}`}
                      className={`rounded-xl border p-3 transition-all ${
                        pipChannel?.id === channel.id && pipChannel?.sourceId === channel.source_id
                          ? 'border-purple-500 bg-purple-500/10 ring-2 ring-purple-500/20'
                          : 'border-slate-800/70 bg-slate-950/40'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {channel.logo ? (
                          <img
                            src={channel.logo}
                            alt={channel.name}
                            className="h-10 w-10 rounded-lg object-cover"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800">
                            <svg className="h-5 w-5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="2" y="3" width="20" height="14" rx="2" />
                              <line x1="8" y1="21" x2="16" y2="21" />
                              <line x1="12" y1="17" x2="12" y2="21" />
                            </svg>
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-slate-200 break-words">
                              {channel.name}
                            </p>
                            {channel.source_name && (
                              <span
                                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 border text-[10px] font-semibold flex-shrink-0 ${
                                  multiviewStreams.some(stream => stream.sourceId === channel.source_id)
                                    ? 'bg-red-500/20 text-red-200 border-red-500/40'
                                    : 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                                }`}
                                title={`IPTV Source: ${channel.source_name}${
                                  multiviewStreams.some(stream => stream.sourceId === channel.source_id)
                                    ? ' (Active in Multi-View)'
                                    : ''
                                }`}
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                </svg>
                                <span className="truncate max-w-[80px]">{channel.source_name}</span>
                              </span>
                            )}
                          </div>
                          {channel.category && (
                            <p className="text-xs text-slate-500 break-words">
                              {channel.category}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Auto-test from here */}
                          <button
                            onClick={() => handleAutoTest(channel)}
                            disabled={autoTesting}
                            className={`rounded-lg p-2 transition-colors ${
                              autoTesting
                                ? 'text-slate-600 cursor-not-allowed'
                                : 'text-slate-400 hover:bg-slate-800 hover:text-purple-400'
                            }`}
                            title={autoTesting ? 'Auto-test in progress' : 'Auto-test from here'}
                          >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                            </svg>
                          </button>

                          <button
                            onClick={() => handlePlayPip(channel)}
                            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-purple-400"
                            title="Play in Picture-in-Picture"
                          >
                            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="2" y="3" width="20" height="14" rx="2" />
                              <rect x="13" y="12" width="7" height="6" rx="1" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handlePlayChannel(channel)}
                            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-blue-400"
                            title="Open in Full Player"
                          >
                            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <polygon points="10 8 16 12 10 16 10 8" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* PiP Player */}
      {showPipPlayer && pipChannel && (
        <div className="fixed bottom-4 right-4 z-50 w-[500px] rounded-xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-slate-200">
                  {pipChannel.name}
                </p>
                {pipChannel.sourceName && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 border text-[10px] font-semibold flex-shrink-0 ${
                      isInMultiview
                        ? 'bg-red-500/20 text-red-200 border-red-500/40'
                        : 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                    }`}
                    title={`IPTV Source: ${pipChannel.sourceName}${isInMultiview ? ' (Active in Multi-View)' : ''}`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    <span className="truncate max-w-[80px]">{pipChannel.sourceName}</span>
                  </span>
                )}
                <VideoQualityBadge quality={pipVideoQuality} size="sm" />
              </div>
              {autoTesting && (
                <p className="text-xs text-purple-400">
                  Testing {currentTestIndex + 1} of {matchingChannels.length}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {autoTesting && (
                <>
                  <button
                    onClick={handleNextChannel}
                    className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                    title="Skip to next channel"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="5 4 15 12 5 20 5 4" />
                      <line x1="19" y1="5" x2="19" y2="19" />
                    </svg>
                  </button>
                  <button
                    onClick={handleStopAutoTest}
                    className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-red-400"
                    title="Stop auto-testing"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="6" y="6" width="12" height="12" />
                    </svg>
                  </button>
                </>
              )}
              <button
                onClick={handleAddToMultiview}
                className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-purple-400"
                title="Add to Multi-View"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              <button
                onClick={handleClosePip}
                className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="rounded-lg" style={{ minHeight: '300px' }}>
            <IPTVPlayer
              sessionId={sessionId}
              selectedChannel={pipChannel}
              playbackMethod="mpegts-player"
              matchedChannels={{}}
              theatreMode={false}
              onQualityDetected={setPipVideoQuality}
              skipRecovery={autoTesting}
              onStreamPlaying={handleStreamPlaying}
              onStreamError={handleStreamError}
            />
          </div>
        </div>
      )}

      {/* Live Scores Ticker */}
      <LiveScoresTicker position="bottom" updateInterval={60000} />
    </div>
  );
};

export default LiveEventsView;
