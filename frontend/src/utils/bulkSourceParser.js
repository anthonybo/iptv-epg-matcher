const MAC_RE = /\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\b/g;
const URL_RE = /https?:\/\/[^\s,<>"']+/gi;
const GET_PHP_RE = /\/get\.php\?[^\s]*username=/i;
// Labeled credentials: "Username: X | Password: Y", "user=foo pass=bar", etc.
// URLs are stripped from the line before these match so embedded-auth URLs
// (http://user:pass@host) don't trigger false hits.
const USERNAME_LABEL_RE = /\buser(?:name)?\s*[:=]\s*([^\s|,]+)/i;
const PASSWORD_LABEL_RE = /\bpass(?:word)?\s*[:=]\s*([^\s|,]+)/i;

const stripTrailingPunctuation = (value) => value.replace(/[.,;:)\]]+$/g, '');

const normalizeMac = (mac) => mac.toUpperCase();

const extractUserPass = (line) => {
  const cleaned = line.replace(URL_RE, ' ');
  const uMatch = cleaned.match(USERNAME_LABEL_RE);
  const pMatch = cleaned.match(PASSWORD_LABEL_RE);
  if (!uMatch && !pMatch) return null;
  return {
    username: uMatch ? stripTrailingPunctuation(uMatch[1]) : null,
    password: pMatch ? stripTrailingPunctuation(pMatch[1]) : null,
  };
};

const normalizeServer = (rawUrl) => {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return rawUrl;
  }
};

// `host.tld` or `host.tld:port` — no scheme. Must have at least one dot in the
// host and a TLD of 2+ letters so we don't falsely match MACs or random text.
const BARE_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+(?::\d{1,5})?$/;
// user:pass — anything non-whitespace/non-colon as user, anything non-whitespace as pass.
const COLON_CREDS_RE = /^([^\s:]+):(\S+)$/;

// Compact columnar format: `host[:port]   user:pass   <trailing metadata>`.
// Columns are separated by runs of 2+ whitespace or tabs.
const extractCompactXtream = (line) => {
  const cols = line.split(/\s{2,}|\t+/);
  if (cols.length < 2) return null;
  const host = cols[0].trim();
  if (!BARE_HOST_RE.test(host)) return null;
  const credsMatch = cols[1].trim().match(COLON_CREDS_RE);
  if (!credsMatch) return null;
  return {
    server: `http://${host}`,
    username: credsMatch[1],
    password: credsMatch[2],
  };
};

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

  // Shared "last-seen server URL" context. A URL anywhere in the text updates
  // it and subsequent MAC or Username/Password lines bind to it.
  let currentServer = defaultPortal || null;
  // Some pastes put Username and Password on separate lines (with metadata
  // between them). Hold the first-seen half until the matching half arrives.
  let pendingHalf = null; // { kind: 'username'|'password', value, line, text } | null

  const orphanReason = (kind) => (
    kind === 'username' ? 'Username without matching Password' : 'Password without matching Username'
  );

  const lines = rawText.split(/\r?\n/);
  lines.forEach((originalLine, index) => {
    const line = originalLine.trim();
    if (!line) return;

    const urlsInLine = extractUrls(line);
    const xtreamUrls = urlsInLine.filter((u) => GET_PHP_RE.test(u));
    const macsInLine = extractMacs(line);
    const userPass = extractUserPass(line);

    // Priority 1: a full Xtream M3U URL on the line — self-contained.
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

    // Priority 2: compact columnar format — `host:port  user:pass  <metadata>`.
    // Runs before the label and MAC checks because the line has no scheme and
    // none of the other patterns would match.
    if (urlsInLine.length === 0 && macsInLine.length === 0) {
      const compact = extractCompactXtream(line);
      if (compact) {
        const entry = {
          type: 'xtream',
          server: compact.server,
          username: compact.username,
          password: compact.password,
          raw: originalLine,
        };
        const key = dedupeKey(entry);
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(entry);
        }
        return;
      }
    }

    // Priority 3: labeled Username/Password — binds to current or inline server.
    // Pairs can span multiple lines: `Username: X\n<metadata>\nPassword: Y`.
    if (userPass && (userPass.username || userPass.password)) {
      const inlineServer = nonXtreamUrls[0] ? normalizeServer(nonXtreamUrls[0]) : null;
      const server = inlineServer || currentServer;
      if (inlineServer) currentServer = inlineServer;

      let { username, password } = userPass;

      // Consume a pending half of the opposite kind to complete the pair.
      if (!username && pendingHalf?.kind === 'username') {
        username = pendingHalf.value;
        pendingHalf = null;
      } else if (!password && pendingHalf?.kind === 'password') {
        password = pendingHalf.value;
        pendingHalf = null;
      }

      if (username && password) {
        // Complete pair. Any still-pending half of either kind is orphaned.
        if (pendingHalf) {
          errors.push({ line: pendingHalf.line, text: pendingHalf.text, reason: orphanReason(pendingHalf.kind) });
          pendingHalf = null;
        }
        if (!server) {
          errors.push({
            line: index + 1,
            text: originalLine,
            reason: 'Username/Password found without a server URL — add a "Portal: http://..." line above or set a default portal',
          });
          return;
        }
        const entry = { type: 'xtream', server, username, password, raw: originalLine };
        const key = dedupeKey(entry);
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(entry);
        }
        return;
      }

      // Still incomplete — stash this half. A new same-kind half replaces and
      // errors the old one (it never got its match).
      const newKind = username ? 'username' : 'password';
      const newValue = username || password;
      if (pendingHalf && pendingHalf.kind === newKind) {
        errors.push({ line: pendingHalf.line, text: pendingHalf.text, reason: orphanReason(pendingHalf.kind) });
      }
      pendingHalf = { kind: newKind, value: newValue, line: index + 1, text: originalLine };
      return;
    }

    // Priority 3: a MAC on the line — Stalker entry bound to current or inline portal.
    if (macsInLine.length > 0) {
      const inlineServer = nonXtreamUrls[0] || null;
      const portal = inlineServer || currentServer;
      if (!portal) {
        errors.push({
          line: index + 1,
          text: originalLine,
          reason: 'MAC found without a portal URL — set a default portal or include one on the line',
        });
        return;
      }
      if (inlineServer) currentServer = inlineServer;
      macsInLine.forEach((mac) => {
        const entry = { type: 'stalker', server: portal, mac, raw: originalLine };
        const key = dedupeKey(entry);
        if (seen.has(key)) return;
        seen.add(key);
        entries.push(entry);
      });
      return;
    }

    // Priority 4: a URL alone — remember it as the server context for the next line.
    if (nonXtreamUrls.length > 0) {
      currentServer = nonXtreamUrls[0];
      return;
    }
  });

  // Any half-credential still waiting at the end never got matched.
  if (pendingHalf) {
    errors.push({ line: pendingHalf.line, text: pendingHalf.text, reason: orphanReason(pendingHalf.kind) });
  }

  return { entries, errors };
};

export const describeEntry = (entry) => {
  if (entry.type === 'xtream') {
    return `${entry.server} — ${entry.username}`;
  }
  return `${entry.server} — ${entry.mac}`;
};

export default parseBulkSources;
