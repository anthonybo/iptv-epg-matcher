/**
 * adFingerprintStore — server-backed passive hotlist of confirmed
 * commercial-audio fingerprints, keyed by (user, channel).
 *
 * Why server instead of IndexedDB:
 *   - Survives browser-clear and switches between devices.
 *   - The dashboard can show usage totals (rows / bytes / channels).
 *   - The backend can enforce per-user storage budgets and prune
 *     oldest entries safely with logging.
 *
 * Wire format:
 *   Each fingerprint is a Uint32Array of 32-bit signatures (one per
 *   ~250ms of audio captured during a confirmed break). On the wire
 *   it's base64-encoded BYTEA; we pack/unpack via the helpers below.
 *
 * In-memory matching (the hot path) lives in useCommercialDetector —
 * this module just handles persistence + Hamming-distance matching.
 */

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

// Encode Uint32Array → base64 string. Little-endian bytes.
const encodeFingerprint = (u32) => {
  const u8 = new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
};

// Decode base64 → Uint32Array.
const decodeFingerprint = (b64) => {
  const bin = atob(b64);
  const len = bin.length;
  if (len === 0 || len % 4 !== 0) return new Uint32Array(0);
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
  return new Uint32Array(u8.buffer);
};

/**
 * POST a confirmed-break fingerprint to the server. Server applies
 * the per-user storage budget and may prune oldest entries; the
 * response includes the new usage stats.
 */
export async function saveFingerprint(channelId, fingerprint, durationMs) {
  if (!channelId || !fingerprint || fingerprint.length === 0) return null;
  if (!getToken()) return null;
  try {
    const res = await fetch(
      `/api/commercial-profile/fingerprints/${encodeURIComponent(channelId)}`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fingerprint: encodeFingerprint(fingerprint),
          durationMs: Math.round(durationMs || 0)
        })
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      console.warn('[adFingerprintStore] save failed', data?.error || res.statusText);
      return null;
    }
    return data.fingerprint?.id ?? null;
  } catch (e) {
    console.warn('[adFingerprintStore] save error', e);
    return null;
  }
}

/**
 * Load all stored fingerprints for a channel. Returns plain objects
 * with Uint32Array fingerprint payloads, ready for in-memory matching.
 */
export async function loadFingerprintsForChannel(channelId) {
  if (!channelId || !getToken()) return [];
  try {
    const res = await fetch(
      `/api/commercial-profile/fingerprints/${encodeURIComponent(channelId)}`,
      { headers: authHeaders() }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success || !Array.isArray(data.fingerprints)) return [];
    return data.fingerprints.map((row) => ({
      id: row.id,
      fingerprint: decodeFingerprint(row.fingerprint),
      capturedAt: row.capturedAt,
      durationMs: row.durationMs
    }));
  } catch (e) {
    console.warn('[adFingerprintStore] load error', e);
    return [];
  }
}

/**
 * Drop the most-recently-captured fingerprint for a channel. Called
 * on FP-undo so the bad capture doesn't keep matching.
 */
export async function deleteLatestFingerprintForChannel(channelId) {
  if (!channelId || !getToken()) return false;
  try {
    const res = await fetch(
      `/api/commercial-profile/fingerprints/${encodeURIComponent(channelId)}/latest`,
      { method: 'DELETE', headers: authHeaders() }
    );
    const data = await res.json().catch(() => null);
    return Boolean(data?.success && data.deleted > 0);
  } catch (e) {
    console.warn('[adFingerprintStore] delete error', e);
    return false;
  }
}

/**
 * Fetch usage stats for the dashboard. Returns null on failure so
 * the dashboard can render a "not available" state gracefully.
 */
export async function getFingerprintStats() {
  if (!getToken()) return null;
  try {
    const res = await fetch('/api/commercial-profile/fingerprints/stats', {
      headers: authHeaders()
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return null;
    return data.stats;
  } catch (e) {
    console.warn('[adFingerprintStore] stats error', e);
    return null;
  }
}

/**
 * popcount on a 32-bit integer — counts set bits.
 */
const popcount32 = (n) => {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
};

/**
 * Match a sliding window against a stored fingerprint. Returns
 * { matchRatio, offset } — matchRatio is the fraction of signature
 * pairs whose Hamming distance ≤ threshold at the best offset.
 *
 * matchRatio ≥ 0.7 with a 5-second window is a strong "yes, same
 * audio" signal — much higher confidence than the loudness/silence
 * heuristics it replaces as the primary signal.
 */
export function matchFingerprint(stored, window, hammingThreshold = 6) {
  if (!stored || !window || window.length === 0 || stored.length < window.length) {
    return { matchRatio: 0, offset: -1 };
  }
  let bestRatio = 0;
  let bestOffset = -1;
  const span = stored.length - window.length + 1;
  for (let off = 0; off < span; off++) {
    let hits = 0;
    for (let i = 0; i < window.length; i++) {
      const dist = popcount32(stored[off + i] ^ window[i]);
      if (dist <= hammingThreshold) hits++;
    }
    const ratio = hits / window.length;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestOffset = off;
      if (ratio >= 0.98) break;
    }
  }
  return { matchRatio: bestRatio, offset: bestOffset };
}

export { popcount32 };
