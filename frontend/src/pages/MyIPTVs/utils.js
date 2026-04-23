export const getDomainKey = (source) => {
  try {
    const url = new URL(source.url);
    return `${source.type || 'm3u'}://${url.host}`;
  } catch {
    return `${source.type || 'm3u'}://${source.url || source.id}`;
  }
};

export const getDomainLabel = (source) => {
  try {
    return new URL(source.url).host;
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

export const getAccountHealth = (source, refreshStatus) => {
  if (refreshStatus === 'loading') return 'loading';
  if (refreshStatus === 'success') return 'ok';
  if (refreshStatus === 'error') return 'error';
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
  const healthOrder = { error: 0, warn: 1, unknown: 2, ok: 3, loading: 4 };
  for (const group of map.values()) {
    group.sources.sort((a, b) => {
      const ha = healthOrder[getAccountHealth(a)] ?? 99;
      const hb = healthOrder[getAccountHealth(b)] ?? 99;
      if (ha !== hb) return ha - hb;
      return getAccountLabel(a).localeCompare(getAccountLabel(b));
    });
  }
  return Array.from(map.values());
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
