import React, { useState, useEffect } from 'react';
import apiClient from './utils/apiClient';
import IPTVPlayer from './IPTVPlayer';

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
  const [autoTesting, setAutoTesting] = useState(false);
  const [currentTestIndex, setCurrentTestIndex] = useState(0);
  const autoTestTimerRef = React.useRef(null);
  const autoTestingRef = React.useRef(false);
  const currentTestIndexRef = React.useRef(0);
  const matchingChannelsRef = React.useRef([]);
  const playerErrorListenerRef = React.useRef(null);
  const originalConsoleErrorRef = React.useRef(null);
  const errorDebounceRef = React.useRef(null);
  const isAdvancingRef = React.useRef(false);
  const [selectedSports, setSelectedSports] = useState(new Set());
  const [selectedLeagues, setSelectedLeagues] = useState(new Set());

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
      sourceMac: channel.source_mac
    });
    setShowPipPlayer(true);
  };

  const handleClosePip = () => {
    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }
    if (errorDebounceRef.current) {
      clearTimeout(errorDebounceRef.current);
      errorDebounceRef.current = null;
    }
    cleanupErrorListener();
    setShowPipPlayer(false);
    setPipChannel(null);
    setAutoTesting(false);
    autoTestingRef.current = false;
    isAdvancingRef.current = false;
  };

  const handleAutoTest = () => {
    if (matchingChannels.length === 0) return;

    setAutoTesting(true);
    autoTestingRef.current = true;
    setCurrentTestIndex(0);
    currentTestIndexRef.current = 0;
    matchingChannelsRef.current = matchingChannels;
    setShowPipPlayer(true);

    // Start with first channel
    const firstChannel = matchingChannels[0];
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
      sourceMac: firstChannel.source_mac
    });

    // Set up error listener
    setupErrorListener();

    // Set long fallback timeout (60 seconds) to prevent getting stuck on frozen streams
    // This should rarely trigger - errors should cause advancement instead
    autoTestTimerRef.current = setTimeout(() => {
      console.log('[Auto-Test] Timeout reached (60s), moving to next channel...');
      handleNextChannel();
    }, 60000);
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

    // Clear error debounce
    if (errorDebounceRef.current) {
      clearTimeout(errorDebounceRef.current);
      errorDebounceRef.current = null;
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
      sourceMac: nextChannel.source_mac
    });

    // Reset advancing flag after a short delay
    setTimeout(() => {
      isAdvancingRef.current = false;
    }, 500);

    // Set long fallback timeout (60 seconds) - only advances on error or timeout
    autoTestTimerRef.current = setTimeout(() => {
      console.log('[Auto-Test] Timeout reached (60s), moving to next channel...');
      handleNextChannel();
    }, 60000);
  };

  const handleStopAutoTest = () => {
    if (autoTestTimerRef.current) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }
    if (errorDebounceRef.current) {
      clearTimeout(errorDebounceRef.current);
      errorDebounceRef.current = null;
    }
    cleanupErrorListener();
    setAutoTesting(false);
    autoTestingRef.current = false;
    isAdvancingRef.current = false;
  };

  const setupErrorListener = () => {
    // Clean up any existing listener
    cleanupErrorListener();

    // Store the original console.error if not already stored
    if (!originalConsoleErrorRef.current) {
      originalConsoleErrorRef.current = console.error;
    }

    // Listen for console errors from mpegts player
    playerErrorListenerRef.current = (...args) => {
      // Call original console.error
      originalConsoleErrorRef.current.apply(console, args);

      // Check if this is an mpegts player error
      const errorString = args.join(' ');
      if (errorString.includes('[ERROR] mpegts player error') ||
          errorString.includes('HttpStatusCodeInvalid') ||
          errorString.includes('NetworkError') ||
          errorString.includes('404') ||
          errorString.includes('403')) {

        // Only auto-advance if we're still auto-testing (use ref for current value)
        if (autoTestingRef.current && !isAdvancingRef.current) {
          // Clear any existing debounce timer
          if (errorDebounceRef.current) {
            clearTimeout(errorDebounceRef.current);
          }

          // Debounce errors - only advance after 300ms of no new errors
          // This prevents multiple errors from same channel from triggering multiple advances
          errorDebounceRef.current = setTimeout(() => {
            console.log('[Auto-Test] Error detected, moving to next channel...');
            handleNextChannel();
          }, 300);
        }
      }
    };

    console.error = playerErrorListenerRef.current;
  };

  const cleanupErrorListener = () => {
    if (playerErrorListenerRef.current && originalConsoleErrorRef.current) {
      // Restore original console.error
      console.error = originalConsoleErrorRef.current;
      playerErrorListenerRef.current = null;
    }
  };

  useEffect(() => {
    fetchLiveEvents();

    // Cleanup on unmount
    return () => {
      if (autoTestTimerRef.current) {
        clearTimeout(autoTestTimerRef.current);
      }
      if (errorDebounceRef.current) {
        clearTimeout(errorDebounceRef.current);
      }
      cleanupErrorListener();
    };
  }, []);

  const formatTime = (isoString) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatDate = (isoString) => {
    const date = new Date(isoString);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return 'Tomorrow';
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const getLeagueColor = (leagueName) => {
    // Football (American)
    if (leagueName === 'NFL' || leagueName === 'NCAAF') return 'bg-purple-500/20 text-purple-300';
    // Basketball
    if (['NBA', 'NCAAB', 'WCAAB', 'WNBA'].includes(leagueName)) return 'bg-orange-500/20 text-orange-300';
    // Hockey
    if (leagueName === 'NHL') return 'bg-blue-500/20 text-blue-300';
    // Soccer
    if (['Premier League', 'MLS', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'Champions League',
         'Europa League', 'Liga MX', 'EFL Championship', 'Eredivisie', 'Primeira Liga'].includes(leagueName)) {
      return 'bg-emerald-500/20 text-emerald-300';
    }
    // Combat Sports
    if (leagueName === 'UFC' || leagueName === 'Boxing') return 'bg-red-500/20 text-red-300';
    // Golf
    if (leagueName === 'PGA' || leagueName === 'LPGA') return 'bg-teal-500/20 text-teal-300';
    // Tennis
    if (leagueName === 'ATP' || leagueName === 'WTA') return 'bg-yellow-500/20 text-yellow-300';
    // Baseball
    if (leagueName === 'MLB' || leagueName === 'College Baseball') return 'bg-indigo-500/20 text-indigo-300';
    // Racing
    if (['Formula 1', 'NASCAR', 'IndyCar'].includes(leagueName)) return 'bg-pink-500/20 text-pink-300';
    // Default
    return 'bg-slate-500/20 text-slate-300';
  };

  const EventCard = ({ event, isLive }) => (
    <button
      onClick={() => handleEventClick(event)}
      className={`w-full rounded-xl border p-4 text-left transition-all hover:scale-[1.02] hover:shadow-lg ${
        isLive
          ? 'border-green-500/30 bg-green-500/5 hover:border-green-500/50'
          : 'border-slate-800/70 bg-slate-950/40 hover:border-slate-700'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-xs font-semibold text-slate-300">
              {event.sport_type}
            </span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getLeagueColor(event.league_name)}`}>
              {event.league_name}
            </span>
            {isLive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2.5 py-0.5 text-xs font-medium text-green-300">
                <span className="h-2 w-2 animate-pulse rounded-full bg-green-400"></span>
                LIVE
              </span>
            )}
          </div>
          <h3 className="mb-1 text-base font-semibold text-slate-100">
            {event.event_name}
          </h3>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <div className="flex items-center gap-1.5">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{formatDate(event.event_start)} at {formatTime(event.event_start)}</span>
            </div>
          </div>
        </div>
        <svg className="h-5 w-5 flex-shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>
    </button>
  );

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
              <EventCard key={event.event_id} event={event} isLive={true} />
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
              <EventCard key={event.event_id} event={event} isLive={false} />
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
                          <p className="font-medium text-slate-200 break-words">
                            {channel.name}
                          </p>
                          {channel.category && (
                            <p className="text-xs text-slate-500 break-words">
                              {channel.category}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
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
              <p className="truncate text-sm font-medium text-slate-200">
                {pipChannel.name}
              </p>
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
              selectedChannel={{
                id: pipChannel.id,
                name: pipChannel.name,
                logo: pipChannel.logo,
                url: pipChannel.url
              }}
              playbackMethod="mpegts-player"
              matchedChannels={{}}
              theatreMode={false}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveEventsView;
