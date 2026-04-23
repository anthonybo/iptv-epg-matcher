const MAC_RE = /\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\b/g;
const URL_RE = /https?:\/\/[^\s,<>"']+/gi;
const GET_PHP_RE = /\/get\.php\?[^\s]*username=/i;

const stripTrailingPunctuation = (value) => value.replace(/[.,;:)\]]+$/g, '');

const normalizeMac = (mac) => mac.toUpperCase();

const parseXtreamUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password');
    if (!username || !password) return null;

    const server = `${url.protocol}//${url.host}`;
    return {
      type: 'xtream',
      server,
      username,
      password,
      raw: rawUrl,
    };
  } catch (_err) {
    return null;
  }
};

const extractUrls = (line) => {
  const matches = line.match(URL_RE) || [];
  return matches.map(stripTrailingPunctuation);
};

const extractMacs = (line) => {
  const matches = line.match(MAC_RE) || [];
  return matches.map(normalizeMac);
};

const dedupeKey = (entry) => {
  if (entry.type === 'xtream') {
    return `xtream|${entry.server.toLowerCase()}|${entry.username}|${entry.password}`;
  }
  return `stalker|${(entry.server || '').toLowerCase()}|${entry.mac}`;
};

export const parseBulkSources = (rawText, options = {}) => {
  const defaultPortal = (options.defaultPortal || '').trim();
  const entries = [];
  const errors = [];
  const seen = new Set();

  if (!rawText || !rawText.trim()) {
    return { entries, errors };
  }

  let currentPortal = defaultPortal || null;

  const lines = rawText.split(/\r?\n/);
  lines.forEach((originalLine, index) => {
    const line = originalLine.trim();
    if (!line) return;

    const urlsInLine = extractUrls(line);
    const xtreamUrls = urlsInLine.filter((u) => GET_PHP_RE.test(u));
    const macsInLine = extractMacs(line);

    if (xtreamUrls.length > 0) {
      xtreamUrls.forEach((url) => {
        const parsed = parseXtreamUrl(url);
        if (!parsed) {
          errors.push({ line: index + 1, text: originalLine, reason: 'Could not parse Xtream URL' });
          return;
        }
        const key = dedupeKey(parsed);
        if (seen.has(key)) return;
        seen.add(key);
        entries.push(parsed);
      });
      return;
    }

    const nonXtreamUrls = urlsInLine.filter((u) => !GET_PHP_RE.test(u));

    if (macsInLine.length > 0) {
      const portal = nonXtreamUrls[0] || currentPortal;
      if (!portal) {
        errors.push({
          line: index + 1,
          text: originalLine,
          reason: 'MAC found without a portal URL — set a default portal or include one on the line',
        });
        return;
      }
      if (nonXtreamUrls[0]) currentPortal = nonXtreamUrls[0];
      macsInLine.forEach((mac) => {
        const entry = { type: 'stalker', server: portal, mac, raw: originalLine };
        const key = dedupeKey(entry);
        if (seen.has(key)) return;
        seen.add(key);
        entries.push(entry);
      });
      return;
    }

    if (nonXtreamUrls.length > 0) {
      currentPortal = nonXtreamUrls[0];
      return;
    }
  });

  return { entries, errors };
};

export const describeEntry = (entry) => {
  if (entry.type === 'xtream') {
    return `${entry.server} — ${entry.username}`;
  }
  return `${entry.server} — ${entry.mac}`;
};

export default parseBulkSources;
