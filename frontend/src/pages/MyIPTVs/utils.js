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
