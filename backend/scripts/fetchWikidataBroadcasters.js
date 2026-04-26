#!/usr/bin/env node
/**
 * Fetch league → broadcaster mappings from Wikidata's P3301
 * ("broadcast by") property, write to
 * backend/config/wikidata_broadcasters.json. Run weekly via cron or
 * by hand. The output is loaded by broadcasterAliases.js as a
 * supplement to the hand-curated LEAGUE_BROADCASTER_FALLBACKS map —
 * the hand-curated entries take precedence; Wikidata fills gaps for
 * leagues we haven't manually mapped yet.
 *
 * Note: Major North-American leagues (NBA, NFL, MLB, NHL) typically
 * do NOT have P3301 populated on Wikidata. The lift here is for
 * less-mainstream leagues — Catalan Basketball, Liga ASOBAL handball,
 * Turkish Basketball Super League, regional rugby, etc. — that ESPN
 * doesn't cover and our hand-curated map has skipped.
 *
 * Usage:
 *   node backend/scripts/fetchWikidataBroadcasters.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_PATH = path.join(__dirname, '..', 'config', 'wikidata_broadcasters.json');

// SPARQL: walk the sports-league subclass tree (Q623109) and collect
// any entity with a P3301 (broadcast by) claim. Group broadcasters by
// league and pull each broadcaster's English label.
const SPARQL = `
SELECT
  ?league ?leagueLabel
  (GROUP_CONCAT(DISTINCT ?broadcasterLabel; separator="|") AS ?broadcasters)
WHERE {
  ?league wdt:P31/wdt:P279* wd:Q623109 .
  ?league wdt:P3301 ?broadcaster .
  ?broadcaster rdfs:label ?broadcasterLabel .
  FILTER(LANG(?broadcasterLabel) = "en")
  ?league rdfs:label ?leagueLabel .
  FILTER(LANG(?leagueLabel) = "en")
}
GROUP BY ?league ?leagueLabel
LIMIT 1000
`;

function sparqlGet(query) {
  return new Promise((resolve, reject) => {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
    https
      .get(url, { headers: { 'User-Agent': 'iptv-epg-matcher/0.1 (broadcast aggregator)' } }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
          } else {
            reject(new Error(`HTTP ${resp.statusCode}`));
          }
        });
      })
      .on('error', reject);
  });
}

(async function main() {
  console.log('[Wikidata] running SPARQL...');
  let data;
  try {
    data = await sparqlGet(SPARQL);
  } catch (e) {
    console.error('[Wikidata] query failed:', e.message);
    process.exit(1);
  }

  const bindings = data.results?.bindings || [];
  console.log(`[Wikidata] got ${bindings.length} leagues with broadcasters`);

  const out = {};
  for (const b of bindings) {
    const leagueName = b.leagueLabel?.value;
    const broadcasters = (b.broadcasters?.value || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!leagueName || broadcasters.length === 0) continue;
    out[leagueName] = broadcasters;
  }

  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        _metadata: {
          fetched_at: new Date().toISOString(),
          source: 'Wikidata P3301',
          query_url: 'https://query.wikidata.org/sparql',
          league_count: Object.keys(out).length,
          note:
            'Hand-curated entries in broadcasterAliases.LEAGUE_BROADCASTER_FALLBACKS take precedence at runtime. Re-run weekly: node backend/scripts/fetchWikidataBroadcasters.js'
        },
        leagues: out
      },
      null,
      2
    )
  );
  console.log(`[Wikidata] wrote ${Object.keys(out).length} leagues to ${OUTPUT_PATH}`);
})();
