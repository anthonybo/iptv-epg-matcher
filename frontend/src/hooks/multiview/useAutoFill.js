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
 * Owns the auto-fill slice for the multi-view page.
 *
 * `/api/live-events/auto-fill-streams` streams NDJSON (one validated channel
 * per line) so the UI can fill slots progressively instead of waiting for
 * every ffprobe test to finish — that's why this reads the response via
 * `getReader()` instead of `.json()`.
 *
 * Returns:
 *   - autoFillProgress — `{ found, target, status }` or null; drives the
 *     progress pill rendered in <MultiViewHeader>.
 *   - handleAutoFill(sportType, leagueName) — the click handler wired to
 *     the "Auto-fill" button and the sport dropdown.
 */
export function useAutoFill({
  streams,
  autoFillSettings,
  setSearchingStream,
  setShowSportDropdown
}) {
  const [autoFillProgress, setAutoFillProgress] = useState(null);

  const handleAutoFill = async (sportType = null, leagueName = null) => {
    const currentStreamCount = streams.length;
    const slotsToFill = Math.max(0, autoFillSettings.maxSlots - currentStreamCount);

    if (slotsToFill === 0) {
      showToast(`Already at max slots (${autoFillSettings.maxSlots})`, 'info');
      return;
    }

    setSearchingStream(true);
    setAutoFillProgress({ found: 0, target: slotsToFill, status: 'Searching...' });
    setShowSportDropdown(false);

    try {
      const currentEventIds = autoFillSettings.avoidDuplicateEvents
        ? streams.map((s) => s.espnEventId).filter((id) => id)
        : [];
      const currentSourceIds = autoFillSettings.avoidDuplicateSources
        ? streams.map((s) => s.sourceId).filter((id) => id)
        : [];
      const currentChannelIds = streams.map((s) => s.id).filter((id) => id);

      const token = getToken();
      if (!token) {
        showToast('Authentication required', 'error');
        setSearchingStream(false);
        setAutoFillProgress(null);
        return;
      }

      const response = await fetch('/api/live-events/auto-fill-streams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/x-ndjson'
        },
        body: JSON.stringify({
          sportType,
          leagueName,
          maxStreams: slotsToFill,
          excludeSourceIds: currentSourceIds,
          excludeEventIds: currentEventIds,
          excludeChannelIds: currentChannelIds,
          minQuality: autoFillSettings.minQuality
        })
      });

      if (!response.ok || !response.body) {
        // Fall back to reading the body as JSON for error responses (e.g. 401).
        let message = 'Failed to auto-fill streams';
        try {
          const errData = await response.json();
          if (errData?.error || errData?.message) message = errData.error || errData.message;
        } catch {}
        showToast(message, 'error');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let addedCount = 0;
      let doneMessage = null;

      const handleLine = async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch (e) {
          console.warn('[Auto-fill] Bad NDJSON line:', trimmed);
          return;
        }

        if (msg.type === 'channel' && msg.channel) {
          const success = await addToMultiview(msg.channel);
          if (success) {
            addedCount++;
            setAutoFillProgress({
              found: addedCount,
              target: slotsToFill,
              status: `Added ${addedCount}/${slotsToFill}...`
            });
            // Let other parts of the UI (e.g. the slot grid) re-render as
            // each stream lands, rather than waiting for the whole batch.
            window.dispatchEvent(new Event('multiviewUpdate'));
          }
        } else if (msg.type === 'done') {
          doneMessage = msg.message || null;
        } else if (msg.type === 'error') {
          throw new Error(msg.error || 'Auto-fill stream failed');
        }
      };

      // Read the NDJSON stream: each complete newline-terminated JSON object
      // represents one validated channel (or a terminal done/error record).
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          await handleLine(line);
        }
      }
      // Flush any final partial line (shouldn't normally happen, but be safe).
      if (buffer.trim()) await handleLine(buffer);

      if (addedCount > 0) {
        showToast(
          `Added ${addedCount} stream${addedCount !== 1 ? 's' : ''} to Multi-View`,
          'success'
        );
      } else {
        showToast(doneMessage || 'No working streams found', 'error');
      }
    } catch (error) {
      console.error('[Auto-fill] Error:', error);
      showToast('Failed to auto-fill streams', 'error');
    } finally {
      setSearchingStream(false);
      setAutoFillProgress(null);
    }
  };

  return { autoFillProgress, handleAutoFill };
}
