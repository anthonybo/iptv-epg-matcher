-- 029: add trailer_youtube_id to canonical movies + series tables.
-- Populated by the VOD enrichment worker from Cinemeta's
-- `trailers[0].source` or `trailerStreams[0].ytId` fields. Surfaced
-- on the detail page as an embedded YouTube player.
ALTER TABLE movies ADD COLUMN IF NOT EXISTS trailer_youtube_id TEXT;
ALTER TABLE series ADD COLUMN IF NOT EXISTS trailer_youtube_id TEXT;
