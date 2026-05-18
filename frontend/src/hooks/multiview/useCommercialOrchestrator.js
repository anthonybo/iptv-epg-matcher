import { useCallback, useEffect, useRef, useState } from 'react';
import { useCommercialDetector } from './useCommercialDetector';
import { deleteLatestFingerprintForChannel } from '../../utils/adFingerprintStore';

/**
 * useCommercialOrchestrator — owns the mute-swap policy + FP learning
 * on top of the per-tile detector.
 *
 * Audio model
 * -----------
 *   - `preferredKey` is the tile the user wants to hear. Initialized
 *     to the first unmuted tile and updated whenever the user manually
 *     unmutes a different tile. We always try to keep audio on this
 *     one.
 *   - When the preferred tile enters a break, we **swap**: mute the
 *     preferred tile and unmute a tile in `content` state. The pair
 *     is tracked in `swapActiveRef = { mutedKey, unmutedKey }`.
 *   - When the preferred tile's break ends, we **roll back the swap**:
 *     unmute the preferred tile, re-mute the temporary one. The user
 *     returns to whatever they were originally watching, ad-free.
 *   - If the temp tile ALSO enters a break mid-swap, we just silence
 *     it (no chain-swap) and wait for the preferred tile's break to
 *     end.
 *
 * False-positive learning
 * -----------------------
 *   If the user clicks Undo on the AD chip (or manually unmutes the
 *   muted preferred tile) within FP_WINDOW_MS, we treat it as a
 *   false positive: POST to /false-positive (relaxes thresholds and
 *   opens a 60s ignore window for that channel), then roll back the
 *   swap so audio returns to the original tile.
 */

const FP_WINDOW_MS = 10_000;

const getToken = () =>
  localStorage.getItem('auth_token') ||
  sessionStorage.getItem('token') ||
  localStorage.getItem('token');

const authHeaders = () => {
  const token = getToken();
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
};

const keyForStream = (s) => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
const stableKeyForStream = (s) => `${s.sourceId}_${s.id}`;

export function useCommercialOrchestrator({
  enabled = false,
  audioEnabled = true,
  logoEnabled = true,
  streams = [],
  mutedStreams,         // Set<streamKey>
  toggleMute            // (streamKey) => void
}) {
  // ─── Server-side profiles ───────────────────────────────────────
  const [profiles, setProfiles] = useState({}); // keyed by channelId
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const loadProfiles = useCallback(async () => {
    if (!getToken()) return;
    try {
      const res = await fetch('/api/commercial-profile', { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      if (data?.success && Array.isArray(data.profiles)) {
        const map = {};
        for (const p of data.profiles) map[p.channelId] = p;
        setProfiles(map);
      }
    } catch (e) {
      console.warn('[CommercialOrch] profile load failed:', e);
    } finally {
      setProfilesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (enabled) loadProfiles();
  }, [enabled, loadProfiles]);

  // ─── State refs ────────────────────────────────────────────────
  // The tile the user wants to be audible at any given moment.
  const preferredKeyRef = useRef(null);
  // While a swap is active, holds { mutedKey, unmutedKey }. mutedKey
  // is the preferred tile (in ad break). unmutedKey is the temp tile
  // we unmuted to keep audio flowing — may be null if no content tile
  // was available.
  const swapActiveRef = useRef(null);
  // Tiles we muted: streamKey → { mutedAt, signals, channelId, stableKey }
  const autoMutedRef = useRef(new Map());
  // Tiles we unmuted (the temp audio targets). Just a set — we use it
  // to know which mutes are user-initiated vs orchestrator-initiated.
  const autoUnmutedRef = useRef(new Set());
  // React-visible mirror of autoMutedRef (so the cell can render the
  // AD chip on the right tiles).
  const [autoMutedKeys, setAutoMutedKeys] = useState(new Set());

  const syncAutoMuted = useCallback(() => {
    setAutoMutedKeys(new Set(autoMutedRef.current.keys()));
  }, []);

  // ─── Track which tile the user prefers ──────────────────────────
  // Initialized to the first unmuted tile we see. Updated whenever the
  // user manually unmutes a tile that *we* didn't unmute (a clear
  // signal they're saying "this is the one I want to hear").
  const prevMutedRef = useRef(mutedStreams);
  useEffect(() => {
    if (!enabled) return;

    const prev = prevMutedRef.current;
    prevMutedRef.current = mutedStreams;

    // Initial-pick fallback.
    if (!preferredKeyRef.current) {
      const firstUnmuted = streams.map(keyForStream).find((k) => !mutedStreams.has(k));
      if (firstUnmuted) {
        preferredKeyRef.current = firstUnmuted;
        console.info('[CommercialOrch] preferred initialized to', firstUnmuted);
      }
    }

    // Detect transitions.
    autoMutedRef.current.forEach((info, key) => {
      // Auto-muted tile became unmuted while we were holding the mute.
      if (prev.has(key) && !mutedStreams.has(key)) {
        const age = Date.now() - info.mutedAt;
        if (age <= FP_WINDOW_MS) {
          // Within FP window → user is correcting us.
          fireFalsePositive(key, info);
        } else {
          autoMutedRef.current.delete(key);
          syncAutoMuted();
        }
      }
    });

    // Watch for the user manually toggling mute on tiles we DIDN'T
    // touch — that's how they tell us "I want to hear this one now."
    streams.forEach((s) => {
      const key = keyForStream(s);
      const wasMuted = prev.has(key);
      const isMuted = mutedStreams.has(key);
      if (wasMuted && !isMuted && !autoUnmutedRef.current.has(key)) {
        // Manual unmute (not by us). This is now the preferred tile.
        preferredKeyRef.current = key;
        console.info('[CommercialOrch] preferred updated (manual unmute) to', key);
      } else if (!wasMuted && isMuted && !autoMutedRef.current.has(key)) {
        // Manual mute (not by us). If they just silenced the preferred
        // tile, demote it; another unmuted tile (if any) becomes
        // preferred. Otherwise leave preferred as-is — they might
        // unmute again soon.
        if (preferredKeyRef.current === key) {
          const nextUnmuted = streams.map(keyForStream).find((k) => !mutedStreams.has(k));
          preferredKeyRef.current = nextUnmuted || null;
        }
      }
    });

    // Drop autoUnmuted entries for tiles that the user has now
    // explicitly muted (they handled it themselves).
    autoUnmutedRef.current.forEach((key) => {
      if (mutedStreams.has(key) && !autoMutedRef.current.has(key)) {
        autoUnmutedRef.current.delete(key);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutedStreams, enabled]);

  // ─── Helpers ───────────────────────────────────────────────────

  const findContentTile = useCallback((...excludeKeys) => {
    // Pick the best available swap target. Acceptable states are
    // `content` (clean) and `candidate` (one signal firing but no
    // partner yet — could be a flaky logo, hasn't been confirmed as
    // a break). We REJECT `pending_break` and `in_break` since
    // those are tiles the detector is committing to as ad-bearing.
    //
    // We prefer `content` over `candidate` when both are available
    // — pass through twice, content first.
    const tileStateMap = detectorRef.current?.tileStates || {};
    const excluded = new Set(excludeKeys.filter(Boolean));
    const eligible = (s, requireContent) => {
      const k = keyForStream(s);
      if (excluded.has(k)) return false;
      if (autoMutedRef.current.has(k)) return false;
      const st = tileStateMap[k]?.state || 'content';
      if (requireContent) return st === 'content';
      return st === 'content' || st === 'candidate';
    };
    // First pass: strictly content.
    let candidate = streams.find((s) => eligible(s, true));
    if (candidate) return keyForStream(candidate);
    // Fallback: candidate-state tiles too. Common when persistent
    // logo signal flicker keeps tiles bouncing between content and
    // candidate — better to swap to a noisy-but-probably-fine tile
    // than to leave the user in silence.
    candidate = streams.find((s) => eligible(s, false));
    return candidate ? keyForStream(candidate) : null;
  }, [streams]);

  // ─── Detection handlers ────────────────────────────────────────

  const handleBreakStart = useCallback((key, signals, channelId) => {
    console.info('[CommercialOrch] handleBreakStart', {
      key,
      preferred: preferredKeyRef.current,
      swap: swapActiveRef.current,
      signals
    });
    // We only react to the preferred or the current swap-temp tile.
    if (key !== preferredKeyRef.current && key !== swapActiveRef.current?.unmutedKey) {
      console.info('[CommercialOrch] ignoring break on non-preferred tile', key);
      return;
    }

    const stream = streams.find((s) => keyForStream(s) === key);
    if (!stream) return;

    // Case A: the preferred tile entered a break — start a swap.
    if (key === preferredKeyRef.current && !swapActiveRef.current) {
      autoMutedRef.current.set(key, {
        mutedAt: Date.now(),
        signals,
        channelId,
        stableKey: stableKeyForStream(stream)
      });
      syncAutoMuted();
      // Suppress audio via Web Audio gain (NOT video.muted) so the
      // analyser keeps seeing real audio and can detect break_end.
      detectorRef.current?.suppress(key);

      // Find a temp to give the user audio. The temp tile is
      // user-muted, so we override with toggleMute (which sets
      // video.muted=false, making it audible).
      const tempKey = findContentTile(key);
      if (tempKey) {
        console.info('[CommercialOrch] swap', { from: key, to: tempKey });
        autoUnmutedRef.current.add(tempKey);
        if (mutedStreams.has(tempKey)) toggleMute(tempKey);
        swapActiveRef.current = { mutedKey: key, unmutedKey: tempKey };
      } else {
        console.info('[CommercialOrch] no content tile available — silencing only', { from: key });
        swapActiveRef.current = { mutedKey: key, unmutedKey: null };
      }

      fetch(`/api/commercial-profile/${encodeURIComponent(channelId)}/detection`, {
        method: 'POST',
        headers: authHeaders()
      }).catch(() => {});
      return;
    }

    // Case B: the swap-temp tile ALSO entered a break.
    if (key === swapActiveRef.current?.unmutedKey) {
      autoMutedRef.current.set(key, {
        mutedAt: Date.now(),
        signals,
        channelId,
        stableKey: stableKeyForStream(stream)
      });
      syncAutoMuted();
      // Suppress via gain — keeps analyser alive so we can detect
      // when this temp's break ends.
      detectorRef.current?.suppress(key);

      const mutedKey = swapActiveRef.current.mutedKey;
      const nextTempKey = findContentTile(mutedKey, key);
      if (nextTempKey) {
        console.info('[CommercialOrch] chain-swap', { failedTemp: key, nextTemp: nextTempKey });
        autoUnmutedRef.current.add(nextTempKey);
        if (mutedStreams.has(nextTempKey)) toggleMute(nextTempKey);
        swapActiveRef.current = { mutedKey, unmutedKey: nextTempKey };
      } else {
        console.info('[CommercialOrch] no further content tile — silencing', { failedTemp: key });
        swapActiveRef.current = { mutedKey, unmutedKey: null };
      }
    }
  }, [streams, mutedStreams, toggleMute, findContentTile, syncAutoMuted]);

  const handleBreakEnd = useCallback((key, channelId) => {
    const swap = swapActiveRef.current;
    if (swap && key === swap.mutedKey) {
      // The preferred tile's break ended → full rollback.
      // Release gain on the preferred (analyser was already getting
      // real audio; now it actually reaches the speakers).
      detectorRef.current?.release(key);
      autoMutedRef.current.delete(key);
      // Re-mute the temp via the user side (it was user-muted before
      // we unmuted it for the swap). Restore that.
      if (swap.unmutedKey) {
        if (!mutedStreams.has(swap.unmutedKey)) toggleMute(swap.unmutedKey);
        autoUnmutedRef.current.delete(swap.unmutedKey);
      }
      swapActiveRef.current = null;
      syncAutoMuted();
      console.info('[CommercialOrch] swap restored — preferred audio back, temp re-muted');
      return;
    }
    // A chain-swap failing-temp's break ended (we'd suppressed it via
    // gain). Release the gain and clear bookkeeping. If it was
    // user-unmuted from a prior swap step, restore the user mute too
    // so we don't accidentally play two audio sources at once.
    if (autoMutedRef.current.has(key)) {
      detectorRef.current?.release(key);
      if (autoUnmutedRef.current.has(key)) {
        if (!mutedStreams.has(key)) toggleMute(key);
        autoUnmutedRef.current.delete(key);
      }
      autoMutedRef.current.delete(key);
      syncAutoMuted();
    }
  }, [mutedStreams, toggleMute, syncAutoMuted]);

  // ─── Detector wiring ───────────────────────────────────────────

  // Auto-calibration: detector calls this after 30s of stable content
  // on a channel that lacks a logoDhash. We PUT to /api/commercial-
  // profile/:channelId and hot-swap the updated profile into local
  // state so subsequent detection uses the new signature immediately.
  const handleCalibrate = useCallback(async (channelId, logoDhash, logoRoi) => {
    if (!channelId || !logoDhash) return;
    try {
      const res = await fetch(
        `/api/commercial-profile/${encodeURIComponent(channelId)}`,
        {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ logoDhash, logoRoi })
        }
      );
      const data = await res.json().catch(() => null);
      if (data?.success && data.profile) {
        setProfiles((p) => ({ ...p, [channelId]: data.profile }));
        console.info('[CommercialOrch] calibrated', channelId, '→', logoDhash);
      } else {
        console.warn('[CommercialOrch] calibration save failed', channelId, data?.error);
      }
    } catch (e) {
      console.warn('[CommercialOrch] calibration request failed', channelId, e);
    }
  }, []);

  const detectorRef = useRef(null);
  const detector = useCommercialDetector({
    enabled,
    audioEnabled,
    logoEnabled,
    profiles,
    onBreakStart: handleBreakStart,
    onBreakEnd: handleBreakEnd,
    onCalibrate: handleCalibrate
  });
  detectorRef.current = detector;

  // ─── False-positive learning ───────────────────────────────────

  const fireFalsePositive = useCallback(async (key, info) => {
    // Roll back the swap if this is the suppressed preferred.
    const swap = swapActiveRef.current;
    if (swap && key === swap.mutedKey) {
      detectorRef.current?.release(key);
      if (swap.unmutedKey) {
        if (!mutedStreams.has(swap.unmutedKey)) toggleMute(swap.unmutedKey);
        autoUnmutedRef.current.delete(swap.unmutedKey);
      }
      swapActiveRef.current = null;
    } else if (autoMutedRef.current.has(key)) {
      // FP fired on a chain-swap temp that we'd suppressed.
      detectorRef.current?.release(key);
    }
    autoMutedRef.current.delete(key);
    syncAutoMuted();
    detector.resetTile(key);
    // Unlearn — the fingerprint we captured for this "break" was
    // wrong content. Drop both the IndexedDB record and the in-memory
    // hotlist entry so it doesn't poison future detections.
    if (info.channelId) {
      deleteLatestFingerprintForChannel(info.channelId).catch(() => {});
      detectorRef.current?.forgetLatestHotlistEntry(info.channelId);
    }

    try {
      const res = await fetch(
        `/api/commercial-profile/${encodeURIComponent(info.channelId)}/false-positive`,
        { method: 'POST', headers: authHeaders(), body: JSON.stringify({ signals: info.signals || [] }) }
      );
      const data = await res.json().catch(() => null);
      if (data?.success && data.profile) {
        setProfiles((p) => ({ ...p, [info.channelId]: data.profile }));
      }
    } catch (e) {
      console.warn('[CommercialOrch] FP log failed:', e);
    }
  }, [detector, mutedStreams, toggleMute, syncAutoMuted]);

  // ─── Explicit undo from the AD chip ─────────────────────────────
  const undoForKey = useCallback((key) => {
    const info = autoMutedRef.current.get(key);
    if (info) {
      fireFalsePositive(key, info);
    } else {
      // No bookkeeping (stale chip) — release any stuck gain
      // suppression. The user's video.muted state is untouched.
      detectorRef.current?.release(key);
    }
  }, [fireFalsePositive]);

  return {
    // Detection state
    tileStates: detector.tileStates,
    autoMutedKeys,
    profiles,
    profilesLoaded,
    // Registration (cells call these)
    registerVideoElement: detector.register,
    unregisterVideoElement: detector.unregister,
    // User actions
    undoForKey,
    // Debug
    getDebug: detector.getDebug
  };
}
