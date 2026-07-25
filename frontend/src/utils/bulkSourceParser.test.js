import { describe, it, expect } from 'vitest';
import { parseBulkSources } from './bulkSourceParser';

// The parser echoes the source line back as `entry.raw` / `error.text`. That's
// incidental to what we're asserting (the parsed meaning), so strip it to keep
// expectations focused and readable.
const clean = (result) => ({
  entries: result.entries.map(({ raw, ...rest }) => rest),
  errors: result.errors.map(({ text, ...rest }) => rest),
});

const stalker = (server, mac) => ({ type: 'stalker', server, mac });
const xtream = (server, username, password) => ({ type: 'xtream', server, username, password });

describe('parseBulkSources — Xtream', () => {
  it('parses a full get.php M3U URL', () => {
    const r = clean(parseBulkSources('http://srv.tv:8080/get.php?username=u1&password=p1&type=m3u_plus'));
    expect(r.entries).toEqual([xtream('http://srv.tv:8080', 'u1', 'p1')]);
    expect(r.errors).toEqual([]);
  });

  it('parses multiple get.php URLs on separate lines', () => {
    const r = clean(parseBulkSources(
      'http://a.tv/get.php?username=u1&password=p1\nhttp://b.tv/get.php?username=u2&password=p2'
    ));
    expect(r.entries).toEqual([
      xtream('http://a.tv', 'u1', 'p1'),
      xtream('http://b.tv', 'u2', 'p2'),
    ]);
  });

  it('parses labeled Username/Password on one line, bound to a labeled SERVER', () => {
    const r = clean(parseBulkSources('SERVER: http://xt.tv:8080\nUsername: bob | Password: secret'));
    expect(r.entries).toEqual([xtream('http://xt.tv:8080', 'bob', 'secret')]);
  });

  it('pairs Username/Password split across lines with metadata between', () => {
    const r = clean(parseBulkSources(
      'SERVER: http://xt.tv:8080\nUsername: bob\nExpires: 2027\nPassword: secret'
    ));
    expect(r.entries).toEqual([xtream('http://xt.tv:8080', 'bob', 'secret')]);
  });

  it('parses the compact columnar format (host  user:pass  metadata)', () => {
    const r = clean(parseBulkSources('xt.tv:8080   bob:secret   Active 2027'));
    expect(r.entries).toEqual([xtream('http://xt.tv:8080', 'bob', 'secret')]);
  });

  it('does NOT treat an embedded-auth URL as separate credentials', () => {
    const r = clean(parseBulkSources('http://john:doe@embed.tv:8080/get.php?username=u9&password=p9'));
    expect(r.entries).toEqual([xtream('http://embed.tv:8080', 'u9', 'p9')]);
  });

  it('normalizes a bare-URL server context (with a path) down to its origin', () => {
    // A bare URL sets the server context; the Xtream server field must be the
    // origin only — a path would break player_api.php / get.php calls.
    const r = clean(parseBulkSources('http://ctx.tv:8080/xmltv.php\nuser=alice pass=wonderland'));
    expect(r.entries).toEqual([xtream('http://ctx.tv:8080', 'alice', 'wonderland')]);
  });
});

describe('parseBulkSources — Stalker / MAC', () => {
  it('binds MACs to a preceding labeled PORTAL and KEEPS the /c/ path', () => {
    // Regression: the portal path is required — Stalker auth hits
    // `${portal}/portal.php`, so stripping /c/ would break the handshake.
    const r = clean(parseBulkSources(
      'PORTAL: http://p.tv:8080/c/\nMAC: 00:1A:79:00:00:01\nMAC: 00:1A:79:00:00:02'
    ));
    expect(r.entries).toEqual([
      stalker('http://p.tv:8080/c/', '00:1A:79:00:00:01'),
      stalker('http://p.tv:8080/c/', '00:1A:79:00:00:02'),
    ]);
    expect(r.errors).toEqual([]);
  });

  it('accepts a bare host[:port] portal and MAC', () => {
    const r = clean(parseBulkSources('SERVER: p.tv:8080\nMAC: 00:1A:79:00:00:03'));
    expect(r.entries).toEqual([stalker('http://p.tv:8080', '00:1A:79:00:00:03')]);
  });

  it('binds a MAC to an inline portal on the same line', () => {
    const r = clean(parseBulkSources('00:1A:79:00:00:04  http://inline.tv:8080/c/'));
    expect(r.entries).toEqual([stalker('http://inline.tv:8080/c/', '00:1A:79:00:00:04')]);
  });

  it('binds bare MACs to the default portal option', () => {
    const r = clean(parseBulkSources('MAC: 00:1A:79:00:00:06', { defaultPortal: 'http://z1mac.com:8080/c/' }));
    expect(r.entries).toEqual([stalker('http://z1mac.com:8080/c/', '00:1A:79:00:00:06')]);
  });
});

describe('parseBulkSources — labeled block (order-independent portal)', () => {
  it('binds a MAC that appears ABOVE its PORTAL (the reported failure)', () => {
    // MAC : <mac>, a few metadata lines, then PORTAL : <url>. The forward-only
    // scan cannot see the portal when it hits the MAC, so the MAC is deferred
    // and bound once the PORTAL line arrives. This is the exact paste that used
    // to produce "MAC found without a portal URL" and zero entries.
    const input = [
      'MAC : 00:1A:79:7C:FC:06',
      'STATUS : ACTIVE',
      'EXPIRATION : 28/03/2027 2:41 AM',
      'PORTAL : http://goldenfrance.xyz:80/c/',
      'TIMEZONE : UTC',
      'COUNTRY : United Kingdom',
      'ISP : UK-2 Limited',
      'SCANTYPE : MAC SCANNER',
    ].join('\n');
    const r = clean(parseBulkSources(input));
    expect(r.entries).toEqual([stalker('http://goldenfrance.xyz:80/c/', '00:1A:79:7C:FC:06')]);
    expect(r.errors).toEqual([]);
  });

  it('handles lowercase labels and tab separators', () => {
    const r = clean(parseBulkSources('mac\t:\t00:1A:79:00:00:11\nportal\t:\thttp://low.tv:8080/c/'));
    expect(r.entries).toEqual([stalker('http://low.tv:8080/c/', '00:1A:79:00:00:11')]);
  });

  it('does not mistake "SCANTYPE : MAC SCANNER" for a MAC address', () => {
    const r = clean(parseBulkSources('SCANTYPE : MAC SCANNER'));
    expect(r.entries).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe('parseBulkSources — dedup', () => {
  it('dedupes identical Xtream URLs', () => {
    const r = clean(parseBulkSources(
      'http://a.tv/get.php?username=u1&password=p1\nhttp://a.tv/get.php?username=u1&password=p1'
    ));
    expect(r.entries).toEqual([xtream('http://a.tv', 'u1', 'p1')]);
  });

  it('dedupes the same MAC under the same portal', () => {
    const r = clean(parseBulkSources('PORTAL: http://p.tv/c/\nMAC: 00:1A:79:00:00:07\nMAC: 00:1A:79:00:00:07'));
    expect(r.entries).toEqual([stalker('http://p.tv/c/', '00:1A:79:00:00:07')]);
  });
});

describe('parseBulkSources — mixed input', () => {
  it('parses Xtream and Stalker entries in one paste', () => {
    const r = clean(parseBulkSources(
      'http://a.tv/get.php?username=u1&password=p1\nPORTAL: http://p.tv:8080/c/\nMAC: 00:1A:79:00:00:08'
    ));
    expect(r.entries).toEqual([
      xtream('http://a.tv', 'u1', 'p1'),
      stalker('http://p.tv:8080/c/', '00:1A:79:00:00:08'),
    ]);
  });
});

describe('parseBulkSources — errors & no-ops', () => {
  it('errors on a MAC with no portal anywhere and no default portal', () => {
    const r = clean(parseBulkSources('MAC: 00:1A:79:AA:BB:CC'));
    expect(r.entries).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(1);
    expect(r.errors[0].reason).toMatch(/without a portal URL/i);
  });

  it('errors on an orphan Username with no matching Password', () => {
    const r = clean(parseBulkSources('SERVER: http://x.tv\nUsername: lonely'));
    expect(r.entries).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/without matching Password/i);
  });

  it('ignores pure-metadata lines', () => {
    const r = clean(parseBulkSources('STATUS: ACTIVE\nTIMEZONE: UTC\nSCANTYPE: MAC SCANNER'));
    expect(r).toEqual({ entries: [], errors: [] });
  });

  it('returns empty for empty / whitespace input', () => {
    expect(clean(parseBulkSources(''))).toEqual({ entries: [], errors: [] });
    expect(clean(parseBulkSources('   \n\t\n'))).toEqual({ entries: [], errors: [] });
  });
});

describe('parseBulkSources — known limitation (documented, not a bug to fix silently)', () => {
  it('two MAC-first blocks with different portals + no default portal: MACs bind to the FIRST portal', () => {
    // With no server context yet, both MACs defer; the first PORTAL flushes
    // BOTH. This is strictly better than the old behavior (which errored on
    // every MAC-first block), and the Preview lets the user catch it. If a
    // future change makes each MAC bind to its own block's portal, update this
    // expectation deliberately.
    const r = clean(parseBulkSources(
      'MAC: 00:1A:79:00:00:AA\nPORTAL: http://one.tv:8080/c/\nMAC: 00:1A:79:00:00:BB\nPORTAL: http://two.tv:8080/c/'
    ));
    expect(r.entries).toEqual([
      stalker('http://one.tv:8080/c/', '00:1A:79:00:00:AA'),
      stalker('http://one.tv:8080/c/', '00:1A:79:00:00:BB'),
    ]);
  });

  it('portal-first blocks separated by a blank line bind correctly (the recommended format)', () => {
    const r = clean(parseBulkSources(
      'PORTAL: http://one.tv:8080/c/\nMAC: 00:1A:79:00:00:CC\n\nPORTAL: http://two.tv:8080/c/\nMAC: 00:1A:79:00:00:DD'
    ));
    expect(r.entries).toEqual([
      stalker('http://one.tv:8080/c/', '00:1A:79:00:00:CC'),
      stalker('http://two.tv:8080/c/', '00:1A:79:00:00:DD'),
    ]);
  });
});
