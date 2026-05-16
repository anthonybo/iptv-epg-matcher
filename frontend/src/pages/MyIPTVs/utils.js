// Group by HOSTNAME only — strip the port. IPTV panels almost
// universally serve the same accounts on multiple ports (80, 8080,
// 25461, etc.) so a user who imported the same provider via both
// `vodlat.top` and `vodlat.top:8080` ended up with two visually-
// identical groups carrying the same accounts. Hostname-only grouping
// merges them under one card. The group display label drops the port
// too so the card header reads `vodlat.top` even when individual rows
// were imported with a port.
export const getDomainKey = (source) => {
  try {
    const url = new URL(source.url);
    return `${source.type || 'm3u'}://${url.hostname}`;
  } catch {
    return `${source.type || 'm3u'}://${source.url || source.id}`;
  }
};

export const getDomainLabel = (source) => {
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.url || 'Unknown domain';
  }
};

export const getAccountLabel = (source) => {
  if (source.nickname) return source.nickname;
  if (source.type === 'stalker' && source.mac_address) return source.mac_address;
  if (source.username) return source.username;
  return source.name || `Source #${source.id}`;
};

// Window during which a stream-test result is considered "recent
// enough" to override stale refresh-failure counters. 30 minutes
// matches the typical IPTV provider outage / blip cycle — a stream
// test that passed within that window is direct evidence the account
// is reachable RIGHT NOW, regardless of how many refresh attempts
// failed an hour ago.
const STREAM_TEST_FRESH_MS = 30 * 60 * 1000;

export const getAccountHealth = (source, refreshStatus, testResult) => {
  // In-flight refresh status always wins — the user just clicked
  // refresh, we should show what's happening now.
  if (refreshStatus === 'loading') return 'loading';
  if (refreshStatus === 'success') return 'ok';
  if (refreshStatus === 'error') return 'error';

  // rate_limited is a TRANSIENT upstream throttle (Cloudflare 403
  // after a burst of bulk-add requests). It's the most recent
  // attempted action — the user just tried to refresh and the
  // provider said "back off". Outrank older stream test results
  // (e.g. a 26-minute-old 0/5) here: showing red conflates provider
  // throttling (wait a few minutes) with stream-test failures
  // (account/streams broken). Channels are still in the DB intact.
  if (source.last_refresh_status === 'rate_limited') return 'warn';

  // Recent stream test is a strong "is this thing alive" signal.
  // A 5/5 pass within the last 30 minutes overrides a stale
  // failure_count from refresh attempts that happened before the
  // test ran. (Refresh-then-test ordering is handled above.)
  const testedAt = testResult?.testedAt;
  const testFresh = typeof testedAt === 'number' && (Date.now() - testedAt) < STREAM_TEST_FRESH_MS;
  if (testFresh) {
    if (testResult.status === 'passed')  return 'ok';
    if (testResult.status === 'partial') return 'warn';
    if (testResult.status === 'failed' || testResult.status === 'error') return 'error';
    // 'testing' falls through to the older signals — better to show
    // the stable state than flicker to blue mid-test.
  }

  if (source.last_refresh_status === 'error') return 'error';
  if ((source.failure_count || 0) >= 3) return 'error';
  if ((source.failure_count || 0) > 0) return 'warn';
  if (source.account_status && source.account_status !== 'Active') return 'warn';
  if (source.last_refresh_status === 'success') return 'ok';
  if ((source.channel_count || 0) > 0) return 'ok';
  return 'unknown';
};

export const healthDotClasses = {
  ok: 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]',
  warn: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
  error: 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]',
  loading: 'bg-blue-400 animate-pulse',
  unknown: 'bg-slate-500',
};

// Builds the domain groups. Sorting is OWNED by DomainSection (which
// applies an active sort key) — this just buckets sources by host so
// the page header / per-domain UI can re-sort independently.
export const groupSourcesByDomain = (sources) => {
  const map = new Map();
  for (const source of sources) {
    const key = getDomainKey(source);
    if (!map.has(key)) {
      map.set(key, {
        key,
        domain: getDomainLabel(source),
        type: source.type || 'm3u',
        sources: [],
      });
    }
    map.get(key).sources.push(source);
  }
  return Array.from(map.values());
};

// ─── Account row grid template ───────────────────────────────────────
// One canonical grid definition used by BOTH the header row (in
// DomainSection) and every <AccountRow>. Keeping these in lockstep is
// the whole point of having a shared constant — the previous
// flex+conditional-width layout drifted whenever an optional cell
// disappeared on some rows, so columns visibly shifted from row to row.
//
// Tracks:
//   1. account label (1fr, shrinkable)
//   2. channels      (right-aligned, mono)
//   3. expires       (right-aligned, mono)
//   4. conn          (right-aligned, mono)
//   5. last check    (left-aligned, can carry a sub-line)
//   6. streams       (left-aligned, pill + optional "tested ago")
//   7. actions       (FIXED width — see note below)
//
// Why the actions track MUST be fixed:
//   The column header in DomainSection and the data rows render
//   different content in the actions cell — header has just a hairline
//   spacer (~16px), each row carries 5+ ActionButtons + View +
//   Chevron (~260px). With `auto` here, the header's 1fr account
//   track expanded ~250px wider than every row's, dragging the
//   fixed columns right of it (Channels, Expires, …) out of
//   alignment between header and rows.
//   Fixing this track to a value that comfortably fits the widest
//   row's action strip locks every fixed column to the same absolute
//   x in both the header and every row.
//
// All numeric cells use rem so alignment survives the user's font
// size preference. Total fixed: 5 + 5 + 3.5 + 7.25 + 6.25 + 17 = 44rem.
export const ACCOUNT_GRID_TEMPLATE =
  'minmax(0, 1fr) 5rem 5rem 3.5rem 7.25rem 6.25rem 17rem';

// ─── Sorting ──────────────────────────────────────────────────────────
// Sort options the user can pick per-domain or globally. Each comparator
// receives an optional `ctx` carrying refresh-status / test-results
// state so health-based sorts can see in-flight transitions.
//
// All comparators are stable-on-tie via the final localeCompare
// fallback so swapping sort keys doesn't reshuffle equal rows.

const HEALTH_RANK = { error: 0, warn: 1, unknown: 2, loading: 3, ok: 4 };

const expiryTimestamp = (source) => {
  const v = source?.exp_date;
  if (!v || v === 'null') return null;
  const seconds = parseInt(v, 10);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
};

const nameKey = (s) => (getAccountLabel(s) || '').toLowerCase();

// "Default" — your stated preference: healthy/long-lived first, then
// by expiration descending so accounts expiring SOONEST end up at the
// bottom. Sources with no expiration (Stalker, M3U) outrank expirable
// sources at the same health level because they never go stale.
const compareDefault = (a, b, ctx) => {
  const ha = HEALTH_RANK[getAccountHealth(a, ctx?.refresh?.[a.id], ctx?.testResults?.[a.id])] ?? -1;
  const hb = HEALTH_RANK[getAccountHealth(b, ctx?.refresh?.[b.id], ctx?.testResults?.[b.id])] ?? -1;
  if (ha !== hb) return hb - ha; // higher rank (ok=4) wins → top
  const ea = expiryTimestamp(a);
  const eb = expiryTimestamp(b);
  if (ea === null && eb !== null) return -1; // no-exp wins
  if (ea !== null && eb === null) return 1;
  if (ea !== null && eb !== null && ea !== eb) return eb - ea; // later expiry → top
  return nameKey(a).localeCompare(nameKey(b));
};

const compareExpiresSoonest = (a, b) => {
  // Soonest (or already-expired) FIRST, no-expiration last. Useful
  // when the user wants to triage what's about to fall over.
  const ea = expiryTimestamp(a);
  const eb = expiryTimestamp(b);
  if (ea === null && eb === null) return nameKey(a).localeCompare(nameKey(b));
  if (ea === null) return 1;
  if (eb === null) return -1;
  if (ea !== eb) return ea - eb;
  return nameKey(a).localeCompare(nameKey(b));
};

const compareHealth = (a, b, ctx) => {
  const ha = HEALTH_RANK[getAccountHealth(a, ctx?.refresh?.[a.id], ctx?.testResults?.[a.id])] ?? -1;
  const hb = HEALTH_RANK[getAccountHealth(b, ctx?.refresh?.[b.id], ctx?.testResults?.[b.id])] ?? -1;
  if (ha !== hb) return hb - ha;
  return nameKey(a).localeCompare(nameKey(b));
};

const compareChannelsMost = (a, b) => {
  const diff = (b.channel_count || 0) - (a.channel_count || 0);
  if (diff !== 0) return diff;
  return nameKey(a).localeCompare(nameKey(b));
};

const compareRefreshedRecent = (a, b) => {
  const ta = lastSourceCheckAt(a) ?? 0;
  const tb = lastSourceCheckAt(b) ?? 0;
  if (ta !== tb) return tb - ta;
  return nameKey(a).localeCompare(nameKey(b));
};

const compareTestedRecent = (a, b, ctx) => {
  const ta = ctx?.testResults?.[a.id]?.testedAt ?? 0;
  const tb = ctx?.testResults?.[b.id]?.testedAt ?? 0;
  if (ta !== tb) return tb - ta;
  return nameKey(a).localeCompare(nameKey(b));
};

const compareNameAsc = (a, b) => nameKey(a).localeCompare(nameKey(b));

export const SORT_OPTIONS = {
  default:          { label: 'Smart',          hint: 'Healthy first · expiring last',      compare: compareDefault },
  expiresSoonest:   { label: 'Expires soon',   hint: 'Most urgent first',                 compare: compareExpiresSoonest },
  health:           { label: 'Health',         hint: 'Working first',                     compare: compareHealth },
  channelsMost:     { label: 'Channel count',  hint: 'Most channels first',               compare: compareChannelsMost },
  refreshedRecent:  { label: 'Last refreshed', hint: 'Recently refreshed first',          compare: compareRefreshedRecent },
  testedRecent:     { label: 'Last tested',    hint: 'Recently stream-tested first',      compare: compareTestedRecent },
  nameAsc:          { label: 'Name A → Z',     hint: 'Alphabetical',                      compare: compareNameAsc },
};

export const DEFAULT_SORT_KEY = 'default';

// Apply a sort option to a source array (non-mutating). Falls back to
// 'default' when the key isn't recognized — guards against stale
// localStorage values from an old version of the option list.
export const sortSources = (sources, sortKey, ctx) => {
  const opt = SORT_OPTIONS[sortKey] || SORT_OPTIONS[DEFAULT_SORT_KEY];
  return [...sources].sort((a, b) => opt.compare(a, b, ctx));
};

// Helper used by handleRefreshAll for rate-limit-aware host grouping.
// Stalker keys include MAC because each MAC is rate-limited separately.
export const getRefreshHostKey = (source) => {
  try {
    const url = new URL(source.url);
    if (source.type === 'stalker' && source.mac) return `${url.host}:${source.mac}`;
    return url.host;
  } catch {
    return String(source.id);
  }
};

// "4/25/26" — tabular-friendly short form. Handles the Xtream quirk where
// exp_date can be either a UNIX-seconds string or the literal "null".
export const formatExpDate = (expDate) => {
  if (!expDate || expDate === 'null') return null;
  const seconds = parseInt(expDate, 10);
  if (!Number.isFinite(seconds)) return null;
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
};

// Days until expiration (negative if past). null if no exp.
export const daysUntilExp = (expDate) => {
  if (!expDate || expDate === 'null') return null;
  const seconds = parseInt(expDate, 10);
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000 - Date.now();
  return Math.round(ms / (24 * 60 * 60 * 1000));
};

// "just now", "3m ago", "2h ago", "Apr 21". Relative-then-absolute.
export const formatRelativeTime = (value) => {
  if (!value) return null;
  const ts = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  const deltaSec = Math.round((Date.now() - ts) / 1000);
  if (deltaSec < 30) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
};

// "May 14, 8:31 PM" — locale-aware absolute timestamp for tooltips.
// Returns null on bad input so callers can fall back to the value
// they had. Used to layer exact-time provenance on top of the
// shortened relative label.
export const formatAbsoluteTime = (value) => {
  if (!value) return null;
  const ts = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ts).toString();
  }
};

// Best-effort timestamp for "when did we last verify this source is
// alive?". Walks through the explicit refresh fields first, falls
// back to row-level updated_at / created_at for sources that were
// just imported (bulk-add doesn't stamp last_refresh_attempt, so
// without this fallback the Last Refresh column was just "—" for
// every freshly-added source). Returns the millisecond timestamp,
// not a string — callers format as relative or absolute as needed.
export const lastSourceCheckAt = (source) => {
  if (!source) return null;
  const candidates = [
    source.last_refresh_attempt,
    source.last_successful_refresh,
    source.last_refreshed,
    source.updated_at,
    source.created_at,
  ];
  for (const v of candidates) {
    if (!v) continue;
    const ts = typeof v === 'number' ? v : new Date(v).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return null;
};

export const formatDuration = (ms) => {
  if (typeof ms !== 'number' || ms <= 0) return null;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const locationLabel = (source) => {
  if (!source) return null;
  if (source.server_city && source.server_country) return `${source.server_city}, ${source.server_country}`;
  if (source.server_country) return source.server_country;
  if (source.server_city) return source.server_city;
  return null;
};

// For singleton Xtream: "server · username"; Stalker: "portal · mac". Used as a row subtitle.
export const accountSubtitle = (source) => {
  const bits = [];
  if (source.type === 'xtream') {
    if (source.username) bits.push(source.username);
  } else if (source.type === 'stalker') {
    if (source.mac_address) bits.push(source.mac_address);
  }
  return bits.join(' · ');
};

// Build a notes-friendly, multi-line credential block. Includes ready-to-paste
// M3U/player_api URLs for Xtream so the user can drop this into any IPTV app.
export const buildCredentialsText = (source) => {
  if (!source) return '';
  const lines = [];
  const host = getDomainLabel(source);
  const header = source.type === 'stalker' && source.mac_address
    ? `${host} — ${source.mac_address}`
    : source.username
      ? `${host} — ${source.username}`
      : host;
  lines.push(header);
  lines.push('');

  if (source.type === 'xtream') {
    lines.push('Type: Xtream');
    if (source.url) lines.push(`Server: ${source.url}`);
    if (source.username) lines.push(`Username: ${source.username}`);
    if (source.password) lines.push(`Password: ${source.password}`);
    if (source.url && source.username && source.password) {
      const base = source.url.endsWith('/') ? source.url.slice(0, -1) : source.url;
      const qs = `username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
      lines.push('');
      lines.push(`M3U: ${base}/get.php?${qs}&type=m3u_plus&output=ts`);
      lines.push(`Player API: ${base}/player_api.php?${qs}`);
      lines.push(`XMLTV: ${base}/xmltv.php?${qs}`);
    }
  } else if (source.type === 'stalker') {
    lines.push('Type: Stalker / MAG');
    if (source.url) lines.push(`Portal: ${source.url}`);
    if (source.mac_address) lines.push(`MAC: ${source.mac_address}`);
  } else {
    lines.push(`Type: ${source.type || 'M3U'}`);
    if (source.url) lines.push(`URL: ${source.url}`);
    if (source.username) lines.push(`Username: ${source.username}`);
    if (source.password) lines.push(`Password: ${source.password}`);
  }

  const meta = [];
  if (source.account_status) meta.push(`Status: ${source.account_status}${source.is_trial === 1 ? ' (Trial)' : ''}`);
  const exp = formatExpDate(source.exp_date);
  if (exp) meta.push(`Expires: ${exp}`);
  if (source.active_connections !== null && source.active_connections !== undefined) {
    meta.push(`Connections: ${source.active_connections} / ${source.max_connections || '?'}`);
  }
  if (source.channel_count) meta.push(`Channels: ${source.channel_count.toLocaleString()}`);
  const loc = locationLabel(source);
  if (loc) meta.push(`Server location: ${loc}`);
  if (meta.length) {
    lines.push('');
    lines.push(...meta);
  }

  return lines.join('\n');
};

export const copyToClipboard = async (text) => {
  if (!text) return false;
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_err) {
      // Fall through to the legacy path.
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_err) {
    return false;
  }
};
