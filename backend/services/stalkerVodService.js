const fetch = require('node-fetch');
const logger = require('../config/logger');
const stalkerService = require('./stalkerService');

/**
 * stalkerVodService — VOD (movies + series-as-VOD) for MAG/Stalker
 * portals. Mirrors the structure of xtreamVodService but uses
 * Stalker's `portal.php?type=vod` surface, which is paginated and
 * series-as-VOD-hierarchy rather than a separate endpoint.
 *
 * Stalker's VOD surface (single endpoint with action verbs):
 *   GET portal.php?type=vod&action=get_categories
 *     → { js: [{ id, title, alias }] }
 *
 *   GET portal.php?type=vod&action=get_ordered_list&category={id}&p={n}
 *     → { js: { total_items, max_page_items, data: [{id, name, ...}] } }
 *
 *   Series: in canonical Stalker, a series is a top-level VOD entry
 *   whose `is_series` flag is 1. Drilling in:
 *     GET ...&action=get_ordered_list&movie_id={series}&season_id=0&episode_id=0&p=1
 *       → seasons list
 *     GET ...&action=get_ordered_list&movie_id={series}&season_id={n}&episode_id=0&p=1
 *       → episodes for that season
 *
 *   GET portal.php?type=vod&action=create_link&cmd=/media/file_{id}.mpg
 *     → { js: { cmd: "ffmpeg http://..." } }
 *     Strip the leading `ffmpeg ` token before using.
 *
 * Auth: uses the same handshake + Bearer token pattern as the live
 * channels code. We reuse stalkerService.authenticateStalker so
 * token logic stays in one place.
 *
 * Wire-up: P1's vodIngestService.ingestVodForSource branches on
 * source.type. Stalker support is added by a follow-up commit that
 * extends that branch to call ingestStalkerVodForSource(source).
 */

const STALKER_HEADERS = (normalizedMac, token) => ({
  'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
  'X-User-Agent': 'Model: MAG250; Link: WiFi',
  'Cookie': `mac=${normalizedMac}; stb_lang=en; timezone=America/New_York`,
  'Authorization': `Bearer ${token}`
});

const normalizeMacAddress = (mac) =>
  String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '').match(/.{1,2}/g)?.join(':') || mac;

async function fetchVodJson(baseUrl, params, normalizedMac, token, { timeoutMs = 30000 } = {}) {
  const url = `${baseUrl}portal.php?${new URLSearchParams(params).toString()}&JsHttpRequest=1-xml`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: STALKER_HEADERS(normalizedMac, token),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stalker VOD HTTP ${response.status} ${response.statusText} — ${body.slice(0, 200)}`);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Stalker VOD non-JSON response (first 200 chars): ${text.slice(0, 200)}`);
  }
  return data;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Returns [{ categoryId, name, parentId }]. Empty array on any
 * "no categories" response shape — Stalker portals vary on whether
 * they return [] or { data: [] } or null.
 */
async function getVodCategories(portalUrl, macAddress) {
  const normalizedMac = normalizeMacAddress(macAddress);
  const { token, baseUrl } = await stalkerService.authenticateStalker(portalUrl, macAddress);
  const data = await fetchVodJson(baseUrl, { type: 'vod', action: 'get_categories' }, normalizedMac, token);
  const raw = Array.isArray(data?.js) ? data.js : Array.isArray(data?.js?.data) ? data.js.data : [];
  return raw
    .filter((c) => c && (c.id != null || c.category_id != null))
    .map((c) => ({
      categoryId: String(c.id ?? c.category_id),
      name: String(c.title || c.name || c.alias || '').trim() || 'Uncategorised',
      parentId: c.parent_id ? String(c.parent_id) : null
    }));
}

/**
 * Walks `get_ordered_list` page-by-page until we've covered
 * total_items, returns the combined movie array. For very large
 * catalogues this can take multiple seconds — caller should expect
 * to await for a while.
 *
 * series_flag: when true, only series entries returned (is_series=1).
 * Stalker's response mixes movies + series; we filter client-side
 * because the API doesn't have a "series only" filter.
 */
async function getVodOrderedList(portalUrl, macAddress, { categoryId = null, seriesOnly = false, maxPages = 500 } = {}) {
  const normalizedMac = normalizeMacAddress(macAddress);
  const { token, baseUrl } = await stalkerService.authenticateStalker(portalUrl, macAddress);

  const all = [];
  let page = 1;
  let totalItems = null;
  let totalPages = null;

  while (page <= maxPages) {
    const params = {
      type: 'vod',
      action: 'get_ordered_list',
      sortby: 'added',
      p: String(page)
    };
    if (categoryId) params.category = String(categoryId);
    const data = await fetchVodJson(baseUrl, params, normalizedMac, token);
    const block = data?.js || {};
    const rows = Array.isArray(block.data) ? block.data : [];
    if (totalItems == null) {
      totalItems = parseInt(block.total_items, 10) || 0;
      const maxPerPage = parseInt(block.max_page_items, 10) || rows.length || 0;
      totalPages = maxPerPage > 0 ? Math.ceil(totalItems / maxPerPage) : 1;
    }
    for (const row of rows) {
      if (!row || row.id == null) continue;
      if (seriesOnly && !row.is_series) continue;
      if (!seriesOnly && row.is_series) continue;
      all.push(row);
    }
    if (rows.length === 0 || page >= totalPages) break;
    page += 1;
  }
  return all;
}

/**
 * Resolve a Stalker create_link command to a playable URL. Returns
 * the URL with any leading "ffmpeg " token stripped.
 */
async function createLink(portalUrl, macAddress, cmd) {
  const normalizedMac = normalizeMacAddress(macAddress);
  const { token, baseUrl } = await stalkerService.authenticateStalker(portalUrl, macAddress);
  const data = await fetchVodJson(
    baseUrl,
    { type: 'vod', action: 'create_link', cmd },
    normalizedMac,
    token
  );
  let url = data?.js?.cmd || data?.js?.url || '';
  if (!url) throw new Error('Stalker create_link returned no URL');
  // Stalker frequently prefixes the URL with "ffmpeg " or "auto " —
  // tokens the original STB would parse to choose a player. Strip
  // them so we get a plain HTTP(S) URL.
  url = String(url).replace(/^\s*(ffmpeg|auto)\s+/i, '').trim();
  return url;
}

/**
 * Convert a Stalker VOD row to the normalised shape that
 * vodIngestService.upsertMovieStreams expects.
 */
function normalizeStalkerMovieRow(row) {
  return {
    providerStreamId: String(row.id),
    rawName: String(row.name || row.title || '').trim(),
    name: String(row.name || row.title || '').trim(),
    year: row.year ? parseInt(row.year, 10) : null,
    categoryId: row.category_id != null ? String(row.category_id) : null,
    containerExtension: row.container_extension || null,
    addedAt: row.added ? new Date(row.added).toISOString() : null,
    rating: row.rating_kinopoisk || row.rating || null,
    raw: row
  };
}

function normalizeStalkerSeriesRow(row) {
  return {
    providerSeriesId: String(row.id),
    rawName: String(row.name || row.title || '').trim(),
    name: String(row.name || row.title || '').trim(),
    year: row.year ? parseInt(row.year, 10) : null,
    categoryId: row.category_id != null ? String(row.category_id) : null,
    cover: row.screenshot_uri || row.cover || null,
    rating: row.rating || null,
    raw: row
  };
}

module.exports = {
  getVodCategories,
  getVodOrderedList,
  createLink,
  normalizeStalkerMovieRow,
  normalizeStalkerSeriesRow
};
