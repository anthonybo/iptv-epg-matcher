/**
 * Bundled-EPG service — per-IPTV-source EPG ingest.
 *
 * Most IPTV providers ship their own XMLTV EPG alongside the M3U /
 * Xtream channel list. This service auto-discovers that URL and
 * pulls it into our usual epg_sources / epg_channels / epg_programs
 * tables, tagged with the iptv_source it belongs to (post-035
 * `epg_sources.owner_iptv_source_id`).
 *
 * Discovery rules (matching TiviMate / OTT Navigator / Threadfin):
 *   - Xtream  → `${base_url}/xmltv.php?username=X&password=Y`
 *   - M3U     → `#EXTM3U` header attributes `url-tvg="…"` or
 *               `x-tvg-url="…"` (de-facto standard, multiple URLs
 *               comma-separated; we take the first non-empty)
 *
 * Source-id strategy: deterministic per-iptv_source rather than
 * per-URL — two iptv_sources can legitimately share a URL (two
 * accounts on the same Xtream backend) and each needs its own EPG
 * source row so the partitioned epg_programs storage stays cleanly
 * scoped.
 *
 *   bundled_${iptv_source_id}
 *
 * Status is tracked on iptv_sources via the post-035 columns:
 *
 *   bundled_epg_url               cached URL (so we don't re-detect
 *                                 on every refresh)
 *   bundled_epg_status            null | 'pending' | 'ok' | 'failed' | 'no_url'
 *   bundled_epg_error             last failure message
 *   bundled_epg_last_refreshed    wall-clock of last 'ok' state
 *   bundled_epg_channel_count     denormalised counts for the UI
 *   bundled_epg_program_count
 */

const logger = require('../config/logger');
const fetch = require('node-fetch');
const { pool } = require('./postgresService');
const epgParserService = require('./epgParserService');

// 8 KiB of an M3U is plenty to capture the first-line header — even
// a verbose `#EXTM3U` declaration with multiple tvg attributes fits
// in <2 KiB. Bounded fetch so we don't pull a 50MB playlist just to
// read its header.
const M3U_HEAD_READ_BYTES = 8 * 1024;
const M3U_HEAD_FETCH_TIMEOUT_MS = 15_000;

// ─── URL discovery ───────────────────────────────────────────────────

/**
 * Derive the Xtream bundled-EPG URL from credentials.
 *
 * Standard pattern across every Xtream-Codes backend:
 *   {base}/xmltv.php?username=X&password=Y
 */
function xtreamEpgUrl(iptvSource) {
  if (!iptvSource || iptvSource.type !== 'xtream') return null;
  const base = (iptvSource.url || '').replace(/\/+$/, '');
  if (!base || !iptvSource.username || !iptvSource.password) return null;
  const u = encodeURIComponent(iptvSource.username);
  const p = encodeURIComponent(iptvSource.password);
  return `${base}/xmltv.php?username=${u}&password=${p}`;
}

/**
 * Parse the `#EXTM3U` header for the bundled-EPG URL.
 *
 * Header looks like (one or both attributes; URL may be quoted with
 * `"`, `'`, or unquoted up to whitespace):
 *   #EXTM3U url-tvg="https://example.com/epg.xml.gz" x-tvg-url="…"
 *
 * Some providers list multiple URLs comma-separated. We return the
 * first non-empty entry — the simplest correct behavior; if the user
 * needs a different one they can paste it manually.
 */
function extractTvgUrlFromM3uHeader(headerText) {
  if (!headerText || typeof headerText !== 'string') return null;
  // Header is the first line (or two). Read only up to first \n to
  // be safe.
  const firstLine = headerText.split(/\r?\n/, 1)[0] || '';
  if (!firstLine.startsWith('#EXTM3U')) return null;

  // Match url-tvg / x-tvg-url with quoted or unquoted value.
  const re = /(?:url-tvg|x-tvg-url)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i;
  const m = firstLine.match(re);
  if (!m) return null;
  const raw = m[1] || m[2] || m[3] || '';
  // url-tvg can be comma-separated. Take the first.
  const first = raw.split(',').map((s) => s.trim()).find(Boolean);
  return first || null;
}

/**
 * Fetch the first N bytes of an M3U so we can parse its header
 * without downloading the full (potentially 50MB+) playlist.
 *
 * Aborts after M3U_HEAD_READ_BYTES read OR M3U_HEAD_FETCH_TIMEOUT_MS
 * elapsed, whichever comes first. Returns the bytes as a UTF-8
 * string (the header is always ASCII).
 */
async function fetchM3uHead(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), M3U_HEAD_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      // Range header asks the server to skip body delivery past N
      // bytes — most providers honor it. If they don't, we abort the
      // stream ourselves once enough bytes have been read.
      headers: { Range: `bytes=0-${M3U_HEAD_READ_BYTES - 1}` },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    let received = 0;
    const chunks = [];
    for await (const chunk of res.body) {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= M3U_HEAD_READ_BYTES) {
        controller.abort();
        break;
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public discovery entry point. Returns a URL string or null.
 * Never throws — failures are logged + returned as null so the
 * caller can mark `bundled_epg_status='no_url'` cleanly.
 */
async function discoverEpgUrl(iptvSource) {
  if (!iptvSource) return null;
  // Honor a previously-cached URL unless caller forces re-discovery.
  if (iptvSource.bundled_epg_url) return iptvSource.bundled_epg_url;

  if (iptvSource.type === 'xtream') {
    return xtreamEpgUrl(iptvSource);
  }
  if (iptvSource.type === 'm3u') {
    if (!iptvSource.url) return null;
    try {
      const head = await fetchM3uHead(iptvSource.url);
      return extractTvgUrlFromM3uHeader(head);
    } catch (e) {
      logger.warn(`[bundled-epg] M3U header fetch failed for source ${iptvSource.id}: ${e.message}`);
      return null;
    }
  }
  // Stalker (MAG portal) and other types don't have a standard EPG
  // endpoint — they expose programmes via the portal API itself,
  // which is a different ingest path entirely. Skip silently.
  return null;
}

// ─── Ingest ──────────────────────────────────────────────────────────

/**
 * Set the bundled-EPG status on iptv_sources. Centralised so every
 * code path writes the same fields with the same constraints.
 */
async function updateStatus(iptvSourceId, fields) {
  const sets = [];
  const params = [iptvSourceId];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await pool.query(
    `UPDATE iptv_sources SET ${sets.join(', ')} WHERE id = $1`,
    params
  );
}

/**
 * Full ingest pipeline for a single IPTV source's bundled EPG.
 *
 *   1. Look up the source row.
 *   2. Discover the EPG URL (or use cached value).
 *   3. Mark status 'pending' so the UI can show a spinner.
 *   4. Hand off to epgParserService.parseEpgSource with a
 *      deterministic source-id override and the owner FK.
 *   5. Persist final status: 'ok' with counts, or 'failed' with
 *      error message. Never throws — bundled-EPG failures must NOT
 *      block the IPTV channel refresh that triggered them.
 *
 * Returns { success, reason?, channelCount?, programCount? }.
 */
async function ingestBundledEpgForSource(iptvSourceId, options = {}) {
  const { force = false, onProgress = null } = options;

  const sourceRes = await pool.query(
    'SELECT * FROM iptv_sources WHERE id = $1',
    [iptvSourceId]
  );
  if (sourceRes.rows.length === 0) {
    logger.warn(`[bundled-epg] no iptv_source ${iptvSourceId}`);
    return { success: false, reason: 'no_source' };
  }
  const source = sourceRes.rows[0];

  // Discovery (use cached URL unless force=true)
  let url = source.bundled_epg_url;
  if (!url || force) {
    url = await discoverEpgUrl(source);
    if (url && url !== source.bundled_epg_url) {
      await updateStatus(iptvSourceId, { bundled_epg_url: url });
    }
  }
  if (!url) {
    logger.info(`[bundled-epg] source ${iptvSourceId} (${source.name}) has no discoverable EPG URL`);
    await updateStatus(iptvSourceId, {
      bundled_epg_status: 'no_url',
      bundled_epg_error: null
    });
    return { success: false, reason: 'no_url' };
  }

  await updateStatus(iptvSourceId, {
    bundled_epg_status: 'pending',
    bundled_epg_error: null
  });

  const t0 = Date.now();
  try {
    const result = await epgParserService.parseEpgSource(
      {
        name: `Bundled: ${source.name}`,
        url,
        // Deterministic id keyed to the iptv_source — independent of
        // the URL so multiple accounts on the same Xtream backend
        // each get their own EPG storage. See note at top of file.
        sourceIdOverride: `bundled_${iptvSourceId}`,
        ownerIptvSourceId: iptvSourceId
      },
      { force, cache: true, onProgress }
    );

    if (!result || result.success === false) {
      throw new Error(result?.error || 'parseEpgSource returned no result');
    }

    await updateStatus(iptvSourceId, {
      bundled_epg_status: 'ok',
      bundled_epg_error: null,
      bundled_epg_last_refreshed: new Date(),
      bundled_epg_channel_count: result.channelCount || 0,
      bundled_epg_program_count: result.programCount || 0
    });

    logger.info(
      `[bundled-epg] ${source.name}: ${result.channelCount || 0} channels, ` +
      `${result.programCount || 0} programs in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    return {
      success: true,
      channelCount: result.channelCount,
      programCount: result.programCount,
      duration: Date.now() - t0
    };
  } catch (err) {
    const errMsg = String(err.message || err).slice(0, 500);
    logger.warn(`[bundled-epg] ingest failed for source ${iptvSourceId} (${source.name}): ${errMsg}`);
    await updateStatus(iptvSourceId, {
      bundled_epg_status: 'failed',
      bundled_epg_error: errMsg
    });
    return { success: false, reason: 'ingest_failed', error: errMsg };
  }
}

module.exports = {
  // discovery
  discoverEpgUrl,
  xtreamEpgUrl,
  extractTvgUrlFromM3uHeader,
  // ingest
  ingestBundledEpgForSource
};
