-- Migration: 050_genre_normalize
-- Description: Cinemeta/IMDb hand back inconsistent genre labels for the
--   same concept (notably "Sci-Fi" AND "Science Fiction"), which split
--   the VOD genre filter into duplicate buckets and make
--   `genres @> ARRAY['Science Fiction']` miss the "Sci-Fi" rows.
--   normalize_genres() collapses the known aliases and de-dupes, and is
--   applied to the catalog `genres` arrays at refresh time so the stored
--   values (and thus the filter) are canonical. Keep the alias list in
--   sync with utils/genreNormalize.js (used for per-request reads).
-- Date: 2026-06-02

CREATE OR REPLACE FUNCTION normalize_genres(g text[])
RETURNS text[] AS $$
  SELECT COALESCE(array_agg(DISTINCT canon ORDER BY canon), '{}'::text[])
  FROM (
    SELECT CASE lower(trim(x))
             WHEN 'sci-fi'           THEN 'Science Fiction'
             WHEN 'scifi'            THEN 'Science Fiction'
             WHEN 'sci fi'           THEN 'Science Fiction'
             WHEN 'science-fiction'  THEN 'Science Fiction'
             ELSE trim(x)
           END AS canon
    FROM unnest(g) AS x
    WHERE x IS NOT NULL AND trim(x) <> ''
  ) t;
$$ LANGUAGE sql IMMUTABLE;
