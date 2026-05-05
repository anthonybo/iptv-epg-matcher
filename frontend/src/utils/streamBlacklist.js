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
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const blacklist = new Map(); // key → expiresAt

function key(sourceId, channelId) {
  return `${sourceId ?? ''}::${channelId ?? ''}`;
}

function pruneExpired() {
  const now = Date.now();
  for (const [k, exp] of blacklist.entries()) {
    if (now > exp) blacklist.delete(k);
  }
}

export function blacklistChannel(sourceId, channelId, ttlMs = DEFAULT_TTL_MS) {
  if (!channelId) return;
  blacklist.set(key(sourceId, channelId), Date.now() + ttlMs);
}

export function isBlacklisted(sourceId, channelId) {
  if (!channelId) return false;
  const k = key(sourceId, channelId);
  const exp = blacklist.get(k);
  if (!exp) return false;
  if (Date.now() > exp) {
    blacklist.delete(k);
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
}
