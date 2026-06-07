/**
 * Genre normalization — the enrichment source (Cinemeta/IMDb) returns
 * inconsistent labels for the same genre, e.g. both "Sci-Fi" and
 * "Science Fiction". Collapse those aliases to one canonical label so
 * the filter doesn't show duplicates and `genres @> ARRAY['Science
 * Fiction']` matches everything.
 *
 * Keep this in sync with the `normalize_genres()` SQL function
 * (migration 050) — the SQL one normalizes the stored catalog arrays in
 * bulk; this JS one normalizes per-request reads (the detail endpoint).
 */
const GENRE_ALIASES = {
  'sci-fi': 'Science Fiction',
  'scifi': 'Science Fiction',
  'sci fi': 'Science Fiction',
  'science-fiction': 'Science Fiction',
};

function normalizeGenres(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (let g of input) {
    if (g == null) continue;
    g = String(g).trim();
    if (!g) continue;
    const canonical = GENRE_ALIASES[g.toLowerCase()] || g;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

module.exports = { GENRE_ALIASES, normalizeGenres };
