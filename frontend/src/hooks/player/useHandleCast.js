import { useCallback } from 'react';

/**
 * Returns a click handler for the Cast button. If we're already casting
 * this tab, stop. Otherwise:
 *   1. Ask the backend what its LAN IP is (Chromecast can't reach
 *      localhost — it has to see a routable address on the same network).
 *   2. Build the HLS-transcoded stream URL against that IP. HLS is used
 *      here rather than raw TS because Chromecast doesn't support mpegts.
 *   3. Hand it to the useCast hook's castMedia() along with the channel
 *      name / logo for the receiver UI.
 *
 * We `alert()` on error because this is user-initiated from a button
 * click; silent failure would be confusing.
 */
export default function useHandleCast({
  sessionId,
  selectedChannel,
  getChannelId,
  castMedia,
  stopCasting,
  isCasting,
  log = () => {}
}) {
  return useCallback(async () => {
    if (isCasting) {
      stopCasting();
      return;
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL || '/api';
      const networkInfoUrl = `${apiUrl}/network-info`;

      log('info', 'Fetching network info for casting', { networkInfoUrl });
      const response = await fetch(networkInfoUrl);
      const networkInfo = await response.json();
      log('info', 'Network info received', networkInfo);

      const serverIP = networkInfo.primaryAddress;
      const port = apiUrl.match(/:(\d+)/)?.[1] || '5001';
      const castApiUrl = `http://${serverIP}:${port}/api`;
      let streamUrl = `${castApiUrl}/stream/${sessionId}/${getChannelId()}/hls.m3u8`;

      // Scope the upstream search to the matching source when we know it,
      // otherwise the backend would search every source.
      if (selectedChannel?.sourceId) {
        streamUrl += `?source_id=${selectedChannel.sourceId}`;
      }

      const channelName = selectedChannel?.name || 'IPTV Stream';
      const logoUrl = selectedChannel?.logo || selectedChannel?.tvgLogo;

      log('info', 'Starting cast with HLS transcoded stream', { streamUrl, channelName, serverIP });
      castMedia(streamUrl, channelName, logoUrl);
    } catch (error) {
      const errorMsg = `Failed to get network info for casting: ${error.message}`;
      log('error', errorMsg);
      alert(errorMsg);
    }
  }, [isCasting, sessionId, selectedChannel, getChannelId, castMedia, stopCasting, log]);
}
