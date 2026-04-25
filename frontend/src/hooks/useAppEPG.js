import { useEffect, useCallback } from 'react';
import { useAppContext } from '../contexts/AppContext';
import apiClient from '../utils/apiClient';
import { API_BASE_URL } from '../config';

const resolveApiBase = () => {
  if (API_BASE_URL) {
    return API_BASE_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:5001`;
  }

  return '';
};

export function useAppEPG() {
  const {
    sessionId,
    epgSources,
    setEpgSources,
    matchedChannels,
    setMatchedChannels,
    totalChannels,
    setTotalChannels,
    setStatus,
    setStatusType,
    channels,
  } = useAppContext();

  // Fetch matched channels from backend
  const fetchMatchedChannels = useCallback(async () => {
    try {
      console.log('[useEPG] Fetching matched channels');
      const response = await apiClient.get('/epg/matched-channels-with-programs');

      if (response.data && Array.isArray(response.data.channels)) {
        const matchesMap = response.data.channels.reduce((acc, channel) => {
          if (channel.id && channel.epgId) {
            acc[channel.id] = channel.epgId;
            console.log(`[useEPG] Matched channel map: ${channel.id} -> ${channel.epgId}`);
          }
          if (channel.tvg?.id && channel.tvg.id !== channel.id && channel.epgId) {
            acc[channel.tvg.id] = channel.epgId;
            console.log(`[useEPG] Matched channel map (tvg): ${channel.tvg.id} -> ${channel.epgId}`);
          }
          return acc;
        }, {});

        console.log(`[useEPG] Loaded ${response.data.channels.length} matched channels`);
        console.log('[useEPG] Matches map:', matchesMap);
        setMatchedChannels(matchesMap);
        saveMatchedChannels(matchesMap);
        return matchesMap;
      }
    } catch (error) {
      console.error('[useEPG] Error fetching matched channels:', error);
      const savedMatches = JSON.parse(localStorage.getItem('matchedChannels') || '{}');
      setMatchedChannels(savedMatches);
    }
  }, [setMatchedChannels]);

  // Save matched channels to localStorage
  const saveMatchedChannels = useCallback((matches) => {
    localStorage.setItem('matchedChannels', JSON.stringify(matches));
  }, []);

  // Load matched channels from localStorage on mount
  useEffect(() => {
    const savedMatches = JSON.parse(localStorage.getItem('matchedChannels') || '{}');
    setMatchedChannels(savedMatches);
  }, [setMatchedChannels]);

  // Listen for match updates from EPGMatcher
  useEffect(() => {
    const handleRefreshMatches = () => {
      console.log('[useEPG] Received refreshMatchedChannels event, fetching latest matches');
      fetchMatchedChannels();
    };

    window.addEventListener('refreshMatchedChannels', handleRefreshMatches);

    return () => {
      window.removeEventListener('refreshMatchedChannels', handleRefreshMatches);
    };
  }, [fetchMatchedChannels]);

  // Update EPG sources status
  const updateEpgSourcesStatus = useCallback(async () => {
    if (!sessionId) return;

    try {
      const response = await apiClient.get(`/epg/${sessionId}/sources?_t=${Date.now()}`);
      const data = response.data;

      if (data && data.sources) {
        setEpgSources(data.sources);

        if (data.sources.length > 0) {
          const reportedCount = Number(
            data.totalChannels ??
            data.channelCount ??
            (Array.isArray(data.channels) ? data.channels.length : undefined)
          );

          if (Number.isFinite(reportedCount) && reportedCount > 0 && reportedCount !== totalChannels) {
            setTotalChannels(reportedCount);
          }

          const channelCount = reportedCount > 0 ? reportedCount : totalChannels;
          const message = `${channelCount} channels loaded with ${data.sources.length} EPG ${data.sources.length === 1 ? 'source' : 'sources'} available`;
          setStatus(message);
          setStatusType('success');
        }
      }
    } catch (error) {
      console.error('[useEPG] Error updating EPG sources:', error);
    }
  }, [sessionId, setEpgSources, totalChannels, setTotalChannels, setStatus, setStatusType]);

  // Listen for EPG source updates
  useEffect(() => {
    const handleEpgSourcesUpdated = (event) => {
      console.log('[useEPG] EPG sources updated event received:', event.detail);
      updateEpgSourcesStatus();
    };

    window.addEventListener('epgSourcesUpdated', handleEpgSourcesUpdated);
    updateEpgSourcesStatus();

    return () => {
      window.removeEventListener('epgSourcesUpdated', handleEpgSourcesUpdated);
    };
  }, [updateEpgSourcesStatus]);

  // Handle EPG matching
  const handleEpgMatch = useCallback(async (channelId, epgId) => {
    if (!epgId || !channelId) {
      console.warn('Missing required parameters for matching:', { channelId, epgId });
      return;
    }

    console.log('[useEPG] handleEpgMatch called with:', { channelId, epgId });

    let displayName = '';
    if (typeof epgId === 'object') {
      displayName = epgId.epgName || epgId.name || epgId.epgId || epgId.id || '';
      if (epgId.sourceName) {
        displayName += ` (${epgId.sourceName})`;
      }
    } else {
      displayName = String(epgId);
    }

    const updatedMatches = {
      ...matchedChannels,
      [channelId]: epgId
    };
    setMatchedChannels(updatedMatches);
    saveMatchedChannels(updatedMatches);

    setStatus(`Matched channel to ${displayName}`);
    setStatusType('success');

    if (sessionId) {
      try {
        let epgChannel = {};

        if (typeof epgId === 'object') {
          epgChannel = {
            id: epgId.epgId || epgId.id || '',
            name: epgId.epgName || epgId.name || '',
            icon: epgId.epgIcon || epgId.icon || null,
            source_name: epgId.sourceName || epgId.source_name || 'Unknown',
            source_id: epgId.sourceId || epgId.source_id || ''
          };
        } else {
          epgChannel = {
            id: String(epgId),
            name: String(epgId),
            icon: null,
            source_name: 'Unknown',
            source_id: ''
          };
        }

        const matchedChannel = channels.find(c => c.tvgId === channelId || c.id === channelId);

        if (!matchedChannel) {
          console.warn('[useEPG] Could not find matched channel in loaded channels:', channelId);
        }

        const m3uChannel = {
          id: channelId,
          name: matchedChannel ? matchedChannel.name : channelId,
          logo: matchedChannel ? (matchedChannel.logo || matchedChannel.tvgLogo) : null,
          url: matchedChannel ? matchedChannel.url : null,
          group: matchedChannel ? matchedChannel.groupTitle : ''
        };

        console.log('[useEPG] Matching:', {
          epgChannel,
          m3uChannel,
          originalEpgId: epgId,
          channelId
        });

        await apiClient.post(`/epg/${sessionId}/match`, {
          epgChannel,
          m3uChannel
        });

        console.log('[useEPG] Match saved to session');
      } catch (error) {
        console.error('[useEPG] Failed to update matched channels in session', error.response || error);
        const errorDetails = error.response?.data?.error || error.message;
        setStatus(`Warning: Match saved locally but not on server: ${errorDetails}`);
        setStatusType('warning');
      }
    }
  }, [sessionId, matchedChannels, setMatchedChannels, channels, setStatus, setStatusType, saveMatchedChannels]);

  const handleEpgSourcesUpdated = useCallback(() => {
    console.log('[useEPG] EPG sources updated, refetching from API');
    window.dispatchEvent(new CustomEvent('epgSourcesUpdated', {
      detail: { timestamp: Date.now() }
    }));
  }, []);

  return {
    epgSources,
    matchedChannels,
    fetchMatchedChannels,
    handleEpgMatch,
    handleEpgSourcesUpdated,
    updateEpgSourcesStatus,
  };
}
