import { useEffect, useState } from 'react';
import apiClient from '../../utils/apiClient';

/**
 * Manage the "now playing" EPG data for the currently selected channel.
 *
 * Fetches the current + upcoming programs from /epg/:sessionId whenever
 * the channel changes, and listens for the window-level
 * `epgMatchUpdated` event so a brand-new EPG match immediately refreshes
 * the overlay without a page reload.
 *
 * Pass the IPTV channel ID (NOT the EPG id) — the backend resolves the
 * match server-side and returns the program rows. Wired to opt out in
 * theatre mode since the multi-view UI doesn't show the EPG overlay.
 *
 * Returns { epgData: { currentProgram, programs, sourceKey } | null }.
 */
export default function useEpgData({
  sessionId,
  channelId,
  skip = false,
  log = () => {}
}) {
  const [epgData, setEpgData] = useState(null);

  useEffect(() => {
    if (skip) return;
    if (!sessionId || !channelId) return;
    fetchEpgData({ sessionId, channelId, setEpgData, log });
  }, [sessionId, channelId, skip]);

  useEffect(() => {
    if (skip) return;

    const handleEpgMatchUpdate = (event) => {
      const { iptvChannelId, epgChannelId } = event.detail || {};

      log('info', 'Received epgMatchUpdated event', {
        iptvChannelId,
        epgChannelId,
        currentChannelId: channelId,
        isCurrentChannel: iptvChannelId === channelId
      });

      if (iptvChannelId === channelId) {
        log('info', 'Refreshing EPG data for current channel after match using IPTV channel ID');
        if (!sessionId || !iptvChannelId) return;

        apiClient
          .get(`/epg/${sessionId}?channelId=${encodeURIComponent(iptvChannelId)}`)
          .then((response) => {
            log('info', 'EPG data refreshed after match', {
              hasCurrentProgram: !!response.data.currentProgram,
              programCount: response.data.programs?.length || 0
            });
            setEpgData(response.data);
          })
          .catch((error) => {
            log('error', 'Failed to refresh EPG data after match', { error: error.message });
          });
      }
    };

    window.addEventListener('epgMatchUpdated', handleEpgMatchUpdate);
    return () => window.removeEventListener('epgMatchUpdated', handleEpgMatchUpdate);
  }, [sessionId, channelId, skip]);

  return { epgData };
}

async function fetchEpgData({ sessionId, channelId, setEpgData, log }) {
  try {
    // Defensive: a caller might hand us the whole channel object. Extract
    // the identifier and fall back to JSON-stringify only as a last resort
    // so bad input surfaces in logs instead of silently dropping the fetch.
    let channelIdStr;
    if (typeof channelId === 'object' && channelId !== null) {
      channelIdStr = channelId.id || channelId.epgId || '';
      if (!channelIdStr) {
        try {
          channelIdStr = JSON.stringify(channelId);
          log('warn', `Had to use JSON representation of iptvChannelId: ${channelIdStr}`);
        } catch (err) {
          log('error', 'Failed to stringify iptvChannelId object', { error: err.message });
          return;
        }
      }
    } else {
      channelIdStr = String(channelId);
    }

    if (!channelIdStr) {
      log('error', 'Invalid IPTV channel ID: empty after extraction', { originalId: channelId });
      return;
    }

    log('info', `Fetching EPG data for IPTV channel ID: ${channelIdStr}`);
    const response = await apiClient.get(
      `/epg/${sessionId}?channelId=${encodeURIComponent(channelIdStr)}`
    );

    if (response.data) {
      log('info', 'EPG data received', {
        hasCurrentProgram: !!response.data.currentProgram,
        programCount: response.data.programs?.length || 0,
        sourceKey: response.data.sourceKey || 'unknown'
      });
      setEpgData(response.data);
    } else {
      log('error', 'No EPG data returned');
      setEpgData(null);
    }
  } catch (error) {
    log('error', 'Failed to load EPG data', { error: error.message });
    setEpgData(null);
  }
}
