/**
 * GDELT 2.0 source for the breaking-events pipeline.
 *
 * GDELT is an academic real-time event database that crawls 8,000+
 * news sources globally every 15 minutes. Where Reddit gives us
 * "what people are TALKING about" (live sports moments, viral chases,
 * streamer events), GDELT gives us "what's actually HAPPENING" — a
 * chemical-tank incident in Orange County hits GDELT the moment any
 * local outlet files a story, even before it goes national.
 *
 * The two sources are complementary; the orchestrator merges them
 * before handing the combined signal list to the LLM for clustering.
 *
 * API: https://api.gdeltproject.org/api/v2/doc/doc
 *   - No auth required
 *   - JSON returned
 *   - Theme + keyword filters for high-signal queries
 *   - sourcelang:eng to skip non-English sources
 *
 * No published rate limit but we keep it polite: one request per
 * orchestrator tick (15-min cache covers the whole user base).
 */

const axios = require('axios');
const logger = require('../../config/logger');

const ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';

// Breadth of "critical incident" keywords + theme codes. GDELT supports
// both keyword search and its own taxonomy of themes (BREAKING_NEWS,
// NATURAL_DISASTER, etc.). We union them so we catch:
//   - hyperlocal incidents that haven't been theme-coded yet (caught by
//     keywords like "evacuation" or "pursuit")
//   - longer-running stories that are tagged with a theme but might not
//     have those keywords in the headline (caught by theme: filters)
//
// `sourcelang:eng` filters to English-language sources so our LLM
// prompt doesn't get noisy translations of the same event.
// Instead of enumerating keywords (always misses something — chemical
// tank, paraglider crash, drone-strike framings all use different
// vocabulary), we filter on GDELT's own intrinsic signals:
//
//   1. tone < -3      → article carries enough negative sentiment to
//                       indicate a real incident (deaths, damage, crisis).
//                       Genuine TV-worthy incidents land < -5, but we
//                       use -3 to keep recall high and let the LLM
//                       prune.
//   2. sourcelang:eng → English-language sources so the LLM prompt
//                       isn't muddied with translations.
//
// We DON'T filter by theme here — GDELT's theme tags can be noisy /
// over-classified, and excluding by theme is a high-recall risk. The
// LLM gets the raw negative-tone article stream and clusters/ranks it
// into the events that actually matter.
//
// Compact (~36 chars) so we never hit GDELT's "query too long" cap.
const QUERY = 'tone<-3 sourcelang:eng';

// Cache: GDELT data updates every 15 min, so the cache TTL matches.
// Same orchestrator-level cache as Reddit but tracked separately so
// one source failing doesn't blow away the other's data.
const CACHE_TTL_MS = 15 * 60 * 1000;
let cached = { ts: 0, articles: [] };

/**
 * @returns {Promise<Array<{title:string, url:string, domain:string, sourceCountry:string|null, language:string|null, publishedAt:number, themes:string[]|null, tone:number|null}>>}
 */
async function collectArticles({ maxRecords = 75, timespanHours = 2 } = {}) {
  if (cached.articles.length > 0 && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.articles;
  }

  const params = {
    query: QUERY,
    mode: 'ArtList',
    maxrecords: String(maxRecords),
    format: 'json',
    sort: 'DateDesc',
    timespan: `${timespanHours}h`
  };

  try {
    const t0 = Date.now();
    const resp = await axios.get(ENDPOINT, {
      params,
      timeout: 25_000,
      headers: { Accept: 'application/json' },
      // GDELT sometimes wraps the JSON in odd whitespace; let axios still
      // try to parse but tolerate trailing garbage gracefully.
      transformResponse: [(data) => {
        if (typeof data !== 'string') return data;
        try {
          return JSON.parse(data);
        } catch (e) {
          // Sometimes GDELT prefixes the JSON body with whitespace or BOM.
          const trimmed = data.replace(/^﻿/, '').trim();
          try { return JSON.parse(trimmed); } catch { return { articles: [] }; }
        }
      }]
    });

    const rows = Array.isArray(resp.data?.articles) ? resp.data.articles : [];
    const articles = rows.map((a) => ({
      title:          String(a.title || '').trim(),
      url:            a.url || null,
      domain:         a.domain || (() => { try { return new URL(a.url).host; } catch { return null; } })(),
      sourceCountry:  a.sourcecountry || null,
      language:       a.language || null,
      publishedAt:    parseGdeltDate(a.seendate),
      themes:         splitThemes(a.themes),
      tone:           parseTone(a.tone)
    })).filter((a) => a.title && a.url);

    // GDELT can return many duplicates of the same headline across
    // syndicating outlets. Dedupe by normalized title.
    const byTitle = new Map();
    for (const a of articles) {
      const key = a.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
      const prev = byTitle.get(key);
      if (!prev || a.publishedAt > prev.publishedAt) byTitle.set(key, a);
    }
    const deduped = Array.from(byTitle.values()).sort((a, b) => b.publishedAt - a.publishedAt);

    cached = { ts: Date.now(), articles: deduped };
    logger.info(`[BreakingEvents:GDELT] ${deduped.length} articles in ${Date.now() - t0}ms`);
    return deduped;
  } catch (err) {
    logger.warn(`[BreakingEvents:GDELT] fetch failed: ${err.message}`);
    // Return whatever stale cache we have rather than empty so the
    // orchestrator can still synthesize against the last good signal.
    return cached.articles;
  }
}

function parseGdeltDate(s) {
  // GDELT seendate is YYYYMMDDTHHMMSSZ
  if (!s || typeof s !== 'string') return 0;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function splitThemes(s) {
  if (!s || typeof s !== 'string') return null;
  return s.split(';').map((t) => t.trim()).filter(Boolean).slice(0, 10);
}

function parseTone(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).split(',')[0]);
  return Number.isFinite(n) ? n : null;
}

module.exports = { collectArticles };
