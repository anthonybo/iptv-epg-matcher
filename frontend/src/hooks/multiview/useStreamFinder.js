import { useState } from 'react';
import { showToast } from '../../components/Toast';
import { addToMultiview } from '../../utils/multiviewManager';

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

/**
 * Owns the "find me a stream to add" handlers exposed by the header and
 * the live-scores ticker. This is distinct from useFindAlternative (which
 * *replaces* a dead stream) — these handlers *add* a new stream.
 *
 * Six user-facing actions, sharing a small slice of state:
 *   - open the sport dropdown (fetches the live-sports summary)
 *   - random working stream across any sport (Sport dropdown → any)
 *   - random sports channel (button in header)
 *   - random channel of any kind (button in header)
 *   - local news (button in header)
 *   - sport-specific random stream (click a row in the Sport dropdown)
 *   - click a score in the ticker to add that specific matchup
 *
 * All seven mutate `searchingStream` so the header shows a global spinner
 * (except `handleFindLocalNews` which has its own `searchingNews` toggle
 * because the button lives next to the news icon, not the random one).
 *
 * `handleSportSelect` is the only one that supports cancellation — the
 * Sport dropdown has a Cancel button that aborts an in-flight fetch.
 */
export function useStreamFinder({ streams, autoFillSettings, setShowSettingsModal }) {
  const [searchingStream, setSearchingStream] = useState(false);
  const [searchAbortController, setSearchAbortController] = useState(null);
  const [showSportDropdown, setShowSportDropdown] = useState(false);
  const [liveSports, setLiveSports] = useState([]);
  const [loadingSports, setLoadingSports] = useState(false);
  const [searchingNews, setSearchingNews] = useState(false);

  // Toggle the sport dropdown. When opening, fetch the live-sports summary
  // so the dropdown shows only sports with currently-live events, and
  // excludes events already in the grid so we don't suggest duplicates.
  const openSportDropdown = async () => {
    if (showSportDropdown) {
      setShowSportDropdown(false);
      return;
    }

    setShowSportDropdown(true);
    setLoadingSports(true);

    try {
      const currentEventIds = streams.map((s) => s.espnEventId).filter((id) => id);
      const token = getToken();
      if (!token) {
        setLiveSports([]);
        setLoadingSports(false);
        return;
      }

      const queryParams =
        currentEventIds.length > 0
          ? `?excludeEventIds=${currentEventIds.join('&excludeEventIds=')}`
          : '';

      const response = await fetch(`/api/live-events/live-sports-summary${queryParams}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      setLiveSports(data.success ? data.sports || [] : []);
    } catch (error) {
      console.error('Error fetching live sports:', error);
      setLiveSports([]);
    } finally {
      setLoadingSports(false);
    }
  };

  const cancelSearch = () => {
    if (searchAbortController) {
      searchAbortController.abort();
      setSearchAbortController(null);
    }
    setSearchingStream(false);
  };

  const findRandomSportsChannel = async () => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    try {
      const currentSourceIds = streams.map((s) => s.sourceId).filter((id) => id);
      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        return;
      }

      const response = await fetch('/api/live-events/random-sports-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ excludeSourceIds: currentSourceIds })
      });
      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          showToast(`Added ${data.channel.name}`, 'success');
          window.dispatchEvent(new Event('multiviewUpdate'));
        } else {
          showToast('Failed to add channel to multiview', 'error');
        }
      } else {
        showToast(data.error || 'No sports channels found', 'error');
      }
    } catch (error) {
      console.error('[Random Sports Channel] Error:', error);
      showToast('Failed to find random sports channel', 'error');
    } finally {
      setSearchingStream(false);
    }
  };

  const findLocalNews = async () => {
    setSearchingNews(true);

    try {
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map((s) => s.sourceId).filter((id) => id)
        : [];
      const currentChannelIds = streams.map((s) => s.id).filter((id) => id);
      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        setSearchingNews(false);
        return;
      }

      const response = await fetch('/api/live-events/local-news', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          excludeSourceIds: currentSourceIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality
        })
      });
      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          showToast(
            `Added ${data.channel.name} (${data.location.city}, ${data.location.stateAbbrev})`,
            'success'
          );
          window.dispatchEvent(new Event('multiviewUpdate'));
        } else {
          showToast('Failed to add news channel to multiview', 'error');
        }
      } else if (data.error === 'No location set') {
        showToast('Please set your location in Settings first', 'error');
        if (setShowSettingsModal) setShowSettingsModal(true);
      } else {
        showToast(data.message || data.error || 'No local news found', 'error');
      }
    } catch (error) {
      console.error('[Local News] Error:', error);
      showToast('Failed to find local news', 'error');
    } finally {
      setSearchingNews(false);
    }
  };

  const findRandomAnyChannel = async () => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    try {
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map((s) => s.sourceId).filter((id) => id)
        : [];
      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        return;
      }

      const response = await fetch('/api/live-events/random-any-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          excludeSourceIds: currentSourceIds,
          minQuality: autoFillSettings.minQuality
        })
      });
      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          showToast(`Added ${data.channel.name}`, 'success');
          window.dispatchEvent(new Event('multiviewUpdate'));
        } else {
          showToast('Failed to add channel to multiview', 'error');
        }
      } else {
        showToast(data.error || 'No channels found', 'error');
      }
    } catch (error) {
      console.error('[Random Any Channel] Error:', error);
      showToast('Failed to find random channel', 'error');
    } finally {
      setSearchingStream(false);
    }
  };

  // Pick a random working stream for a specific sport/league. Supports
  // cancellation via the header's Cancel button (stored abort controller).
  const selectSport = async (sportType, leagueName) => {
    setSearchingStream(true);
    setShowSportDropdown(false);

    const abortController = new AbortController();
    setSearchAbortController(abortController);

    try {
      const currentEventIds = streams.map((s) => s.espnEventId).filter((id) => id);
      const currentSourceIds = streams.map((s) => s.sourceId).filter((id) => id);
      const token = getToken();
      if (!token) {
        setSearchingStream(false);
        setSearchAbortController(null);
        return;
      }

      const response = await fetch('/api/live-events/random-working-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          sportType,
          leagueName,
          excludeEventIds: currentEventIds,
          excludeSourceIds: currentSourceIds
        }),
        signal: abortController.signal
      });
      const data = await response.json();

      if (data.success && data.channel) {
        const success = await addToMultiview(data.channel);
        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          showToast(`Added "${data.channel.name}" to Multi-View`, 'success');
        } else {
          showToast('Failed to add stream to Multi-View', 'error');
        }
      } else {
        showToast(data.message || 'No working streams found', 'error');
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error finding random stream:', error);
        showToast('Error finding random stream', 'error');
      }
    } finally {
      setSearchingStream(false);
      setSearchAbortController(null);
    }
  };

  // Triggered when the user clicks a score in the live-scores ticker.
  // Searches for a working stream for that specific matchup and adds it,
  // tagging the channel with espnEventId/espnEventName so later features
  // (find-alternative, duplicate detection) know what game it represents.
  const handleTickerEventClick = async (score) => {
    if (streams.length >= autoFillSettings.maxSlots) {
      showToast(`Already at max slots (${autoFillSettings.maxSlots})`, 'info');
      return;
    }

    setSearchingStream(true);

    try {
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map((s) => s.sourceId).filter((id) => id)
        : [];
      const currentChannelIds = streams.map((s) => s.id).filter((id) => id);
      const currentEventIds = streams.map((s) => s.espnEventId).filter((id) => id);
      if (currentEventIds.includes(score.event_id)) {
        showToast('This game is already in your Multi-View', 'info');
        setSearchingStream(false);
        return;
      }

      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        return;
      }

      // Use "Team1 at Team2" so the backend event parser picks up both
      // teams (the searchChannel endpoint splits on at/vs/@).
      const searchQuery = `${score.away_team} at ${score.home_team}`;
      const response = await fetch('/api/live-events/search-channel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          query: searchQuery,
          excludeSourceIds: currentSourceIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality,
          espnEventId: score.event_id
        })
      });
      const data = await response.json();

      if (data.success && data.channel) {
        const channelWithEvent = {
          ...data.channel,
          espnEventId: score.event_id,
          espnEventName: `${score.away_team} vs ${score.home_team}`
        };
        const success = await addToMultiview(channelWithEvent);
        if (success) {
          window.dispatchEvent(new Event('multiviewUpdate'));
          const qualityText = data.channel.quality ? ` (${data.channel.quality}p)` : '';
          showToast(
            `Added stream for ${score.away_team} vs ${score.home_team}${qualityText}`,
            'success'
          );
        } else {
          showToast('Failed to add channel to Multi-View', 'error');
        }
      } else {
        showToast(
          data.message ||
            `No working stream found for ${score.away_team} vs ${score.home_team}`,
          'error'
        );
      }
    } catch (error) {
      console.error('[Ticker Event Click] Error:', error);
      showToast('Failed to find stream for this game', 'error');
    } finally {
      setSearchingStream(false);
    }
  };

  return {
    // State
    searchingStream,
    setSearchingStream,
    showSportDropdown,
    setShowSportDropdown,
    liveSports,
    loadingSports,
    searchingNews,
    // Handlers
    openSportDropdown,
    cancelSearch,
    findRandomSportsChannel,
    findLocalNews,
    findRandomAnyChannel,
    selectSport,
    handleTickerEventClick
  };
}
