import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useCommercialOrchestrator — drives auto-mute from the SERVER-SIDE ad
 * detector (commercialFingerprintService).
 *
 * The previous client-side detector (useCommercialDetector: Web-Audio
 * analyser + logo CV) was dead-on-arrival and damaged playback, so it has
 * been retired. Detection now happens server-side: the backend decodes each
 * channel's audio, computes Shazam-style landmark fingerprints, learns
 * repeated ad creatives by cross-channel/cross-time repetition, and emits a
 * high-precision `commercial-break` start/end over SSE when a channel's audio
 * matches a CONFIRMED ad. This hook:
 *
 *   1. While enabled, starts/stops server analysis for the visible IPTV tiles
 *      (POST /api/commercial/analyze[/stop], keyed by sourceId+channelId).
 *   2. Subscribes to the global SSE channel and, on a `commercial-break`
 *      start, mutes the matching tile (via toggleMute) and flags it with the
 *      AD chip; on end, restores the tile's prior audio state.
 *   3. Exposes Undo: treat a flagged tile as a false positive — restore audio
 *      and stop reacting to that channel for a short window.
 *
 * Only tiles we muted are restored, and only if the user hadn't already muted
 * them — we never override a user's explicit mute.
 */

const UNDO_IGNORE_MS = 60_000;

const getToken = () =>
  localStorage.getItem('auth_token') ||
  sessionStorage.getItem('token') ||
  localStorage.getItem('token');

// IMPORTANT: these commercial calls use raw fetch, NOT the shared apiClient.
// apiClient's 401 handler triggers redirectToLogin() (clears the token), so a
// 401 on these fire-and-forget background calls — fired for every tile when
// detection is on — would log the user out (and a multi-tile refresh storm
// would loop it). A background feature must never be able to end the session,
// so we send the token manually and swallow any failure (incl. 401) silently.
const authHeaders = () => {
  const token = getToken();
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
};

// Any session id works — the backend broadcasts commercial-break events to all
// connected SSE clients. Read the stored id; fall back to a throwaway one.
let _fallbackSid = null;
const getSessionId = () => {
  const sid =
    localStorage.getItem('iptv_epg_session_id') ||
    localStorage.getItem('sessionId') ||
    localStorage.getItem('session_id');
  if (sid && sid !== 'null' && sid !== 'undefined') return sid;
  if (!_fallbackSid) _fallbackSid = 'mv_' + Math.random().toString(36).slice(2);
  return _fallbackSid;
};

const keyForStream = (s) => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
const stableKeyForStream = (s) => `${s.sourceId}_${s.id}`;

export function useCommercialOrchestrator({
  enabled = false,
  streams = [],
  mutedStreams,
  toggleMute
}) {
  // Live mirrors so SSE/timer callbacks always see current values without
  // re-subscribing.
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const mutedRef = useRef(mutedStreams);
  mutedRef.current = mutedStreams;
  const toggleMuteRef = useRef(toggleMute);
  toggleMuteRef.current = toggleMute;

  // Tiles WE auto-muted: streamKey → { mutedAt, channelId, sourceId, wasUserMuted, creativeId }
  const autoMutedRef = useRef(new Map());
  const [autoMutedKeys, setAutoMutedKeys] = useState(new Set());
  const [tileStates, setTileStates] = useState({});
  // stableKey → timestamp until which we ignore detections (after an Undo)
  const ignoreUntilRef = useRef(new Map());

  const sync = useCallback(() => {
    setAutoMutedKeys(new Set(autoMutedRef.current.keys()));
    const ts = {};
    for (const k of autoMutedRef.current.keys()) ts[k] = { signals: ['ad detected'], state: 'in_break' };
    setTileStates(ts);
  }, []);

  const muteTile = (key) => { if (!mutedRef.current?.has?.(key)) toggleMuteRef.current?.(key); };
  const unmuteTile = (key) => { if (mutedRef.current?.has?.(key)) toggleMuteRef.current?.(key); };

  const findStream = (sourceId, channelId) =>
    streamsRef.current.find(
      (x) => String(x.id) === String(channelId) && String(x.sourceId) === String(sourceId)
    );

  // ─── SSE handlers ───────────────────────────────────────────────
  const onAdStart = useCallback((sourceId, channelId, creativeId) => {
    const stableKey = `${sourceId}_${channelId}`;
    const until = ignoreUntilRef.current.get(stableKey);
    if (until && Date.now() < until) return; // user recently said "not an ad"

    const stream = findStream(sourceId, channelId);
    if (!stream) return;
    const key = keyForStream(stream);
    if (autoMutedRef.current.has(key)) return;

    const wasUserMuted = Boolean(mutedRef.current?.has?.(key));
    autoMutedRef.current.set(key, { mutedAt: Date.now(), channelId, sourceId, wasUserMuted, creativeId });
    if (!wasUserMuted) muteTile(key);
    sync();
  }, [sync]);

  const onAdEnd = useCallback((sourceId, channelId) => {
    // Match by source+channel (the full key can change if the tile refreshed).
    for (const [key, info] of autoMutedRef.current) {
      if (String(info.sourceId) === String(sourceId) && String(info.channelId) === String(channelId)) {
        if (!info.wasUserMuted) unmuteTile(key);
        autoMutedRef.current.delete(key);
      }
    }
    sync();
  }, [sync]);

  // ─── SSE subscription (only while enabled) ──────────────────────
  useEffect(() => {
    if (!enabled) return undefined;
    let es;
    try {
      es = new EventSource(`/api/events/${encodeURIComponent(getSessionId())}`);
    } catch (e) {
      console.warn('[CommercialOrch] SSE open failed:', e);
      return undefined;
    }
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || msg.type !== 'commercial-break' || msg.source !== 'fingerprint') return;
      if (msg.breakType === 'start') onAdStart(msg.sourceId, msg.channelId, msg.creativeId);
      else if (msg.breakType === 'end') onAdEnd(msg.sourceId, msg.channelId);
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => { try { es.close(); } catch (e) { /* noop */ } };
  }, [enabled, onAdStart, onAdEnd]);

  // ─── Start/stop server analysis for visible IPTV tiles ──────────
  // stableKey → { sourceId, channelId }
  const analyzingRef = useRef(new Map());

  const stopAnalysis = useCallback((sourceId, channelId) => {
    fetch('/api/commercial/analyze/stop', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channelId, sourceId })
    }).catch(() => {});
  }, []);

  const restoreAll = useCallback(() => {
    for (const [key, info] of autoMutedRef.current) {
      if (!info.wasUserMuted) unmuteTile(key);
    }
    autoMutedRef.current.clear();
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  useEffect(() => {
    if (!enabled) {
      for (const { sourceId, channelId } of analyzingRef.current.values()) stopAnalysis(sourceId, channelId);
      analyzingRef.current.clear();
      restoreAll();
      return undefined;
    }

    const present = new Set();
    for (const s of streams) {
      // Skip YouTube and sentinel-source tiles — nothing to analyze upstream.
      if (s.sourceType === 'youtube' || s.sourceId === 0 || s.sourceId == null) continue;
      const sk = stableKeyForStream(s);
      present.add(sk);
      if (!analyzingRef.current.has(sk)) {
        analyzingRef.current.set(sk, { sourceId: s.sourceId, channelId: s.id });
        fetch('/api/commercial/analyze', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ channelId: s.id, sourceId: s.sourceId })
        }).catch(() => {});
      }
    }
    // Stop analysis for tiles that were removed.
    for (const [sk, info] of [...analyzingRef.current]) {
      if (!present.has(sk)) {
        analyzingRef.current.delete(sk);
        stopAnalysis(info.sourceId, info.channelId);
        onAdEnd(info.sourceId, info.channelId); // clear any lingering auto-mute/chip
      }
    }
    return undefined;
  }, [enabled, streams, stopAnalysis, restoreAll, onAdEnd]);

  // Stop everything on unmount.
  useEffect(() => () => {
    for (const { sourceId, channelId } of analyzingRef.current.values()) stopAnalysis(sourceId, channelId);
    analyzingRef.current.clear();
  }, [stopAnalysis]);

  // ─── Undo (false positive) ──────────────────────────────────────
  const undoForKey = useCallback((key) => {
    const info = autoMutedRef.current.get(key);
    if (!info) return;
    ignoreUntilRef.current.set(`${info.sourceId}_${info.channelId}`, Date.now() + UNDO_IGNORE_MS);
    if (!info.wasUserMuted) unmuteTile(key);
    autoMutedRef.current.delete(key);
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  return {
    autoMutedKeys,
    tileStates,
    undoForKey,
    // Retained for call-site compatibility; the client detector is retired.
    registerVideoElement: () => {},
    unregisterVideoElement: () => {},
    profiles: {},
    profilesLoaded: true
  };
}
