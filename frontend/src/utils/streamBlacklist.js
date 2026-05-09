/**
 * Short-term blacklist of recently-failed channels.
 *
 * The multi-view auto-find loop kept cycling back through the same
 * broken streams: stream A dies → find-alt picks B → B dies → find-alt
 * picks C → ... and after a couple rotations we'd be back at A. With
 * five consecutive Reelz channels in a row each erroring within 10s of
 * mounting, the user's tile flickered through stream after stream for
 * minutes.
 *
 * This module remembers which (sourceId, channelId) pairs have died
 * recently so the next find-alternative request can exclude them at the
 * backend level. Entries auto-expire after the TTL — a transient
 * upstream blip shouldn't blacklist a channel forever.
 *
 * Why 60 minutes (was 5)?
 *   The earlier 5-min TTL was tuned for occasional blips. In practice,
 *   when the user pins to a brand whose streams are mostly broken right
 *   now, the find-alt loop cycles through 4–5 dead channels in the
 *   first minute, settles on one that limps along, then 6+ minutes
 *   later that one dies too. By then the original 4–5 dead entries have
 *   expired and find-alt picks them again — exactly the loop the log
 *   from 2026-05-08 21:04 captured (xtream_53345 retried 7 minutes
 *   after it first died). 60 minutes is long enough that a session of
 *   cycling through reelz-style channels never hits the same dead one
 *   twice; transient blips that resolve in <1h still recover via
 *   user-triggered manual searches that bypass the blacklist.
 *
 * Why sessionStorage?
 *   In-memory only meant a tab refresh wiped the dead-channel list and
 *   the auto-find loop started picking already-tried-and-failed
 *   channels from scratch. sessionStorage survives refresh but doesn't
 *   leak across browser windows, which is the right scope: each tab is
 *   one multi-view session.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes
const STORAGE_KEY = 'iptv_stream_blacklist_v1';

// Hot in-memory mirror of the persisted blob. Reads stay O(1); writes
// flush back to sessionStorage. Loaded once at module init.
let blacklist = new Map(); // key → expiresAt

const supportsSessionStorage = (() => {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return false;
    const t = '__iptv_bl_test__';
    window.sessionStorage.setItem(t, t);
    window.sessionStorage.removeItem(t);
    return true;
  } catch {
    return false;
  }
})();

function load() {
  if (!supportsSessionStorage) return;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const now = Date.now();
    for (const [k, exp] of Object.entries(parsed)) {
      if (typeof exp === 'number' && exp > now) blacklist.set(k, exp);
    }
  } catch {
    // Corrupt blob — drop silently.
  }
}

function persist() {
  if (!supportsSessionStorage) return;
  try {
    const obj = {};
    for (const [k, v] of blacklist.entries()) obj[k] = v;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Quota / serialization issues — non-fatal, in-memory copy still works.
  }
}

load();

function key(sourceId, channelId) {
  return `${sourceId ?? ''}::${channelId ?? ''}`;
}

function pruneExpired() {
  const now = Date.now();
  let mutated = false;
  for (const [k, exp] of blacklist.entries()) {
    if (now > exp) {
      blacklist.delete(k);
      mutated = true;
    }
  }
  if (mutated) persist();
}

export function blacklistChannel(sourceId, channelId, ttlMs = DEFAULT_TTL_MS) {
  if (!channelId) return;
  blacklist.set(key(sourceId, channelId), Date.now() + ttlMs);
  persist();
}

export function isBlacklisted(sourceId, channelId) {
  if (!channelId) return false;
  const k = key(sourceId, channelId);
  const exp = blacklist.get(k);
  if (!exp) return false;
  if (Date.now() > exp) {
    blacklist.delete(k);
    persist();
    return false;
  }
  return true;
}

// Returns the channel IDs of every still-valid blacklist entry, so a
// caller building a search-channel `excludeChannelIds` request can
// merge them in without caring about source IDs.
export function getBlacklistedChannelIds() {
  pruneExpired();
  const ids = new Set();
  for (const k of blacklist.keys()) {
    const channelId = k.split('::')[1];
    if (channelId) ids.add(channelId);
  }
  return Array.from(ids);
}

export function clearBlacklist() {
  blacklist.clear();
  persist();
}
