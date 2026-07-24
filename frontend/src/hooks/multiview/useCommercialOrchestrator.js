import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useCommercialOrchestrator — drives ad-aware muting in MultiView from the
 * SERVER-SIDE detector(s) (commercialBoundaryService = immediate black+silence;
 * commercialFingerprintService = high-confidence catalog match), delivered over
 * SSE as `commercial-break` events.
 *
 * Two behaviours, gated by props:
 *
 *   Per-tile auto-mute (default): on a break, mute that tile (confidence-gated:
 *   black+silence / fingerprint mute; weak scene-burst only flags) and show the
 *   AD chip; unmute on break-end. We only ever unmute what WE muted.
 *
 *   Audio-follow (opt-in, `audioFollow`): keep audio on exactly ONE ad-free
 *   stream. When the audible stream enters an ad, mute it and move audio to a
 *   stream that isn't in an ad (sticky — stays put until its own ad). If EVERY
 *   active stream is in an ad, stay silent (unmute none). When a stream's ad
 *   ends, audio is available to move back to it only if the current one ads.
 */

const UNDO_IGNORE_MS = 60_000;

const getToken = () =>
  localStorage.getItem('auth_token') ||
  sessionStorage.getItem('token') ||
  localStorage.getItem('token');

// IMPORTANT: these commercial calls use raw fetch, NOT the shared apiClient.
// apiClient's 401 handler triggers redirectToLogin() (clears the token), so a
// 401 on these fire-and-forget background calls would log the user out (and a
// multi-tile refresh storm would loop it). Send the token manually and swallow
// any failure (incl. 401) silently so a background call can never end the session.
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
  audioFollow = false,
  streams = [],
  mutedStreams,
  toggleMute
}) {
  // Live mirrors so SSE/timer callbacks always see current values.
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const mutedRef = useRef(mutedStreams);
  mutedRef.current = mutedStreams;
  const toggleMuteRef = useRef(toggleMute);
  toggleMuteRef.current = toggleMute;
  const audioFollowRef = useRef(audioFollow);
  audioFollowRef.current = audioFollow;

  // Tiles currently flagged as in-ad (drives the chip): streamKey → info.
  const autoMutedRef = useRef(new Map());
  const [autoMutedKeys, setAutoMutedKeys] = useState(new Set());
  const [tileStates, setTileStates] = useState({});
  // stableKey → timestamp until which we ignore detections (after an Undo)
  const ignoreUntilRef = useRef(new Map());

  // Audio-follow bookkeeping.
  const followAudibleRef = useRef(null);          // stableKey currently carrying audio
  const followMutedRef = useRef(new Set());        // fullKeys WE muted via follow reconcile

  const sync = useCallback(() => {
    setAutoMutedKeys(new Set(autoMutedRef.current.keys()));
    const ts = {};
    for (const [k, info] of autoMutedRef.current) {
      ts[k] = { signals: info.signals || ['ad break'], confidence: info.confidence, state: 'in_break' };
    }
    setTileStates(ts);
  }, []);

  const muteTile = (key) => { if (!mutedRef.current?.has?.(key)) toggleMuteRef.current?.(key); };
  const unmuteTile = (key) => { if (mutedRef.current?.has?.(key)) toggleMuteRef.current?.(key); };

  const findStream = (sourceId, channelId) =>
    streamsRef.current.find(
      (x) => String(x.id) === String(channelId) && String(x.sourceId) === String(sourceId)
    );

  // Set of stableKeys currently in an ad (derived from the flagged map).
  const adStableKeys = () => {
    const s = new Set();
    for (const info of autoMutedRef.current.values()) s.add(`${info.sourceId}_${info.channelId}`);
    return s;
  };

  // ─── Audio-follow: keep exactly one ad-free stream audible ───────
  // Idempotent: re-running it before React re-renders (so mutedRef is stale)
  // must NOT double-toggle. We guard mutes with followMutedRef (what WE muted)
  // and the target-takeover with the previously-audible key.
  const reconcileFollowAudio = useCallback(() => {
    if (!audioFollowRef.current) return;
    const active = streamsRef.current.filter((s) => s && s.id != null);
    if (active.length === 0) return;
    const ad = adStableKeys();
    const inAd = (s) => ad.has(stableKeyForStream(s));

    // Sticky: keep the current audible stream if it's still ad-free; otherwise
    // move to the first ad-free stream; if EVERY stream is in an ad, target is
    // null → everything stays muted (silence).
    const wasAudible = followAudibleRef.current;
    const curStream = active.find((s) => stableKeyForStream(s) === wasAudible);
    const target = (curStream && !inAd(curStream))
      ? curStream
      : (active.find((s) => !inAd(s)) || null);
    const targetKey = target ? keyForStream(target) : null;
    const targetStable = target ? stableKeyForStream(target) : null;

    for (const s of active) {
      const k = keyForStream(s);
      if (k === targetKey) {
        // Make the target audible.
        if (followMutedRef.current.has(k)) {
          unmuteTile(k);
          followMutedRef.current.delete(k);
        } else if (mutedRef.current?.has?.(k) && targetStable !== wasAudible) {
          // Newly taking over a tile the user had muted.
          toggleMuteRef.current?.(k);
        }
      } else if (!followMutedRef.current.has(k) && !mutedRef.current?.has?.(k)) {
        // Mute non-target tiles — but only once (followMutedRef guards reruns).
        toggleMuteRef.current?.(k);
        followMutedRef.current.add(k);
      }
    }
    followAudibleRef.current = targetStable;
  }, []);

  const restoreFollowMuted = useCallback(() => {
    for (const k of followMutedRef.current) unmuteTile(k);
    followMutedRef.current.clear();
    followAudibleRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── SSE handlers ───────────────────────────────────────────────
  const onAdStart = useCallback((sourceId, channelId, meta = {}) => {
    const stableKey = `${sourceId}_${channelId}`;
    const until = ignoreUntilRef.current.get(stableKey);
    if (until && Date.now() < until) return; // user recently said "not an ad"

    const stream = findStream(sourceId, channelId);
    if (!stream) return;
    const key = keyForStream(stream);
    if (autoMutedRef.current.has(key)) return;

    const confidence = meta.confidence || 'low';
    const wasUserMuted = Boolean(mutedRef.current?.has?.(key));
    // Record the in-ad flag (drives the chip) regardless of mode.
    const info = {
      mutedAt: Date.now(), channelId, sourceId, wasUserMuted, muted: false,
      creativeId: meta.creativeId || null,
      confidence,
      source: meta.source || null,
      signals: meta.signals && meta.signals.length
        ? meta.signals
        : (meta.source === 'fingerprint' ? ['matched ad'] : ['ad break'])
    };
    autoMutedRef.current.set(key, info);

    if (audioFollowRef.current) {
      // Audio-follow owns the muting: move audio off this tile to an ad-free one.
      reconcileFollowAudio();
    } else {
      // Per-tile: confidence-gated mute (black+silence/fingerprint mute; weak
      // scene-burst only flags). Below mute-grade precision → don't yank audio.
      const muted = confidence !== 'low' && !wasUserMuted;
      if (muted) { muteTile(key); info.muted = true; }
    }
    sync();
  }, [sync, reconcileFollowAudio]);

  const onAdEnd = useCallback((sourceId, channelId) => {
    for (const [key, info] of autoMutedRef.current) {
      if (String(info.sourceId) === String(sourceId) && String(info.channelId) === String(channelId)) {
        if (!audioFollowRef.current && info.muted) unmuteTile(key); // per-tile restore
        autoMutedRef.current.delete(key);
      }
    }
    // In follow-mode, re-route audio now that this tile is ad-free again.
    if (audioFollowRef.current) reconcileFollowAudio();
    sync();
  }, [sync, reconcileFollowAudio]);

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
      if (!msg || msg.type !== 'commercial-break') return;
      // Accept both detectors: 'boundary' (immediate black+silence, lower
      // confidence) and 'fingerprint' (catalog match, high confidence).
      if (msg.source !== 'fingerprint' && msg.source !== 'boundary') return;
      const meta = { creativeId: msg.creativeId, confidence: msg.confidence, source: msg.source, signals: msg.signals };
      if (msg.breakType === 'start') onAdStart(msg.sourceId, msg.channelId, meta);
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
      if (info.muted) unmuteTile(key);
    }
    autoMutedRef.current.clear();
    restoreFollowMuted();
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, restoreFollowMuted]);

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
        onAdEnd(info.sourceId, info.channelId); // clear any lingering flag/chip
      }
    }
    // Keep audio-follow consistent as tiles are added/removed.
    if (audioFollowRef.current) reconcileFollowAudio();
    return undefined;
  }, [enabled, streams, stopAnalysis, restoreAll, onAdEnd, reconcileFollowAudio]);

  // React to the audio-follow toggle flipping while detection is on.
  const prevFollowRef = useRef(audioFollow);
  useEffect(() => {
    const was = prevFollowRef.current;
    prevFollowRef.current = audioFollow;
    if (!enabled) return;
    if (audioFollow && !was) {
      // Just enabled → anchor audio to the current audible tile (or the first),
      // then enforce the single-ad-free-audible policy.
      const active = streamsRef.current.filter((s) => s && s.id != null);
      const current = active.find((s) => !mutedRef.current?.has?.(keyForStream(s))) || active[0];
      followAudibleRef.current = current ? stableKeyForStream(current) : null;
      reconcileFollowAudio();
    } else if (!audioFollow && was) {
      // Just disabled → unmute everything follow had muted.
      restoreFollowMuted();
    }
  }, [audioFollow, enabled, reconcileFollowAudio, restoreFollowMuted]);

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
    if (!audioFollowRef.current && info.muted) unmuteTile(key);
    autoMutedRef.current.delete(key);
    if (audioFollowRef.current) reconcileFollowAudio(); // this tile no longer counts as in-ad
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, reconcileFollowAudio]);

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
