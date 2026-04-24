import { useCallback, useEffect, useState } from 'react';
import { showToast } from '../../components/Toast';
import {
  clearMultiview,
  getMultiviewStreams,
  removeFromMultiview,
  updateMutedState
} from '../../utils/multiviewManager';

/**
 * Owns the multi-view stream slice: the streams array itself, per-slot
 * mute and quality tracking, the initial load on mount, and the
 * `multiviewUpdate` window event that other parts of the app fire when
 * they add/remove streams (auto-fill, find-alternative, etc.).
 *
 * Stream operations (toggleMute / refresh / remove / clearAll / quality)
 * live here because they all mutate this slice — keeping them beside
 * the state avoids passing 5 setters around.
 *
 * Returns everything the page needs to pass down to <MultiViewGrid>,
 * <MultiViewHeader>, and sibling hooks (useFindAlternative needs
 * setStreams + setStreamQualities to swap a dead stream).
 */
export function useMultiViewStreams() {
  const [streams, setStreams] = useState([]);
  const [mutedStreams, setMutedStreams] = useState(new Set());
  const [streamQualities, setStreamQualities] = useState({});
  const [loadingStreams, setLoadingStreams] = useState(true);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Load streams from API on mount and subscribe to the `multiviewUpdate`
  // window event so sibling features (auto-fill, find-alternative,
  // live-scores ticker click) can append without a round-trip through
  // props.
  useEffect(() => {
    let ignore = false;

    const loadStreams = async () => {
      try {
        setLoadingStreams(true);
        const loaded = await getMultiviewStreams();
        if (!ignore) {
          const mutedSet = new Set();
          loaded.forEach((stream) => {
            const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
            if (stream.muted !== false) {
              mutedSet.add(streamKey);
            }
          });

          setMutedStreams(mutedSet);
          await new Promise((resolve) => setTimeout(resolve, 10));

          if (!ignore) {
            setStreams(loaded);
          }
        }
      } catch (error) {
        if (!ignore) {
          console.error('Failed to load multiview streams:', error);
          showToast('Failed to load streams', 'error');
        }
      } finally {
        if (!ignore) {
          setLoadingStreams(false);
        }
      }
    };

    loadStreams();

    const handleMultiviewUpdate = async () => {
      try {
        const loaded = await getMultiviewStreams();
        if (!ignore) {
          setStreams((prevStreams) => {
            // If the backend has fewer streams than we do, treat it as a
            // full reset (e.g. clear-all from another tab).
            if (loaded.length < prevStreams.length) {
              const mutedSet = new Set();
              loaded.forEach((stream) => {
                const streamKey = `${stream.sourceId}_${stream.id}_${stream._refreshKey || ''}`;
                if (stream.muted !== false) {
                  mutedSet.add(streamKey);
                }
              });
              setMutedStreams(mutedSet);
              return loaded;
            }

            // Otherwise, only append the streams we don't know about yet.
            // Don't replace existing streams wholesale — that would remount
            // every IPTVPlayer and break playback.
            const prevKeys = new Set(prevStreams.map((s) => `${s.sourceId}_${s.id}`));
            const newStreams = loaded.filter(
              (s) => !prevKeys.has(`${s.sourceId}_${s.id}`)
            );

            if (newStreams.length > 0) {
              setMutedStreams((prev) => {
                const updated = new Set(prev);
                newStreams.forEach((s) => {
                  const streamKey = `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
                  if (s.muted !== false) {
                    updated.add(streamKey);
                  }
                });
                return updated;
              });
              return [...prevStreams, ...newStreams];
            }

            return prevStreams;
          });
        }
      } catch (error) {
        if (!ignore) {
          console.error('Failed to reload multiview streams:', error);
          showToast('Failed to reload streams', 'error');
        }
      }
    };

    window.addEventListener('multiviewUpdate', handleMultiviewUpdate);
    return () => {
      ignore = true;
      window.removeEventListener('multiviewUpdate', handleMultiviewUpdate);
    };
  }, []);

  // Toggle mute optimistically, roll back on server failure.
  const toggleMute = async (streamKey) => {
    // streamKey is `${sourceId}_${channelId}_${optionalRefreshTimestamp}`.
    // channelId itself can contain underscores (e.g. `xtream_2500`), so we
    // can't just split on `_` — we detect the trailing 13-digit timestamp
    // and peel it off if present.
    const parts = streamKey.split('_');
    if (parts.length < 2) return;

    const sourceId = parts[0];
    const lastPart = parts[parts.length - 1];
    const isTimestamp = /^\d{13}$/.test(lastPart);
    const channelId =
      isTimestamp && parts.length > 2
        ? parts.slice(1, -1).join('_')
        : parts.slice(1).join('_');

    const wasMuted = mutedStreams.has(streamKey);
    const newMutedState = !wasMuted;

    setMutedStreams((prev) => {
      const newSet = new Set(prev);
      if (wasMuted) newSet.delete(streamKey);
      else newSet.add(streamKey);
      return newSet;
    });

    const success = await updateMutedState(channelId, sourceId, newMutedState);
    if (!success) {
      setMutedStreams((prev) => {
        const newSet = new Set(prev);
        if (wasMuted) newSet.add(streamKey);
        else newSet.delete(streamKey);
        return newSet;
      });
      showToast('Failed to update mute state', 'error');
    }
  };

  // Force a refresh of a single slot by bumping its `_refreshKey`, which
  // changes the React key used by <IPTVPlayer> and causes a full remount.
  // Transfer the muted-state entry from the old key to the new one so the
  // user doesn't suddenly hear audio they had silenced.
  const refreshStream = (id, sourceId) => {
    const newRefreshKey = Date.now();

    setStreams((prevStreams) => {
      const oldStream = prevStreams.find(
        (s) => s.id === id && s.sourceId === sourceId
      );
      if (oldStream) {
        const oldKey = `${sourceId}_${id}_${oldStream._refreshKey || ''}`;
        const newKey = `${sourceId}_${id}_${newRefreshKey}`;

        setMutedStreams((prev) => {
          const wasMuted = prev.has(oldKey);
          if (wasMuted) {
            const updated = new Set(prev);
            updated.delete(oldKey);
            updated.add(newKey);
            return updated;
          }
          return prev;
        });
      }

      return prevStreams.map((stream) => {
        if (stream.id === id && stream.sourceId === sourceId) {
          return { ...stream, _refreshKey: newRefreshKey };
        }
        return stream;
      });
    });
    showToast('Stream refreshed', 'success');
  };

  const removeStream = async (id, sourceId) => {
    try {
      const success = await removeFromMultiview(id, sourceId);
      if (success) {
        setStreams((prevStreams) =>
          prevStreams.filter(
            (stream) => !(stream.id === id && stream.sourceId === sourceId)
          )
        );
        const streamKey = `${sourceId}_${id}`;
        setStreamQualities((prev) => {
          const { [streamKey]: _removed, ...rest } = prev;
          return rest;
        });
      } else {
        showToast('Failed to remove stream', 'error');
      }
    } catch (error) {
      console.error('Error removing stream:', error);
      showToast('Failed to remove stream', 'error');
    }
  };

  const clearAll = async () => {
    try {
      const success = await clearMultiview();
      if (success) {
        window.dispatchEvent(new Event('multiviewUpdate'));
        setStreamQualities({});
        showToast('All streams cleared', 'success');
      } else {
        showToast('Failed to clear streams', 'error');
      }
    } catch (error) {
      console.error('Error clearing streams:', error);
      showToast('Failed to clear streams', 'error');
    }
  };

  const onQualityDetected = useCallback((streamId, quality) => {
    setStreamQualities((prev) => ({ ...prev, [streamId]: quality }));
  }, []);

  return {
    streams,
    setStreams,
    mutedStreams,
    streamQualities,
    setStreamQualities,
    loadingStreams,
    showClearConfirm,
    setShowClearConfirm,
    toggleMute,
    refreshStream,
    removeStream,
    clearAll,
    onQualityDetected
  };
}
