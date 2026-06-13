-- Migration: 051_social_feed
-- Description: Realtime social (X/Twitter) hashtag feed backing the
--   multiview "Live chatter" side panel. The panel polls a hashtag
--   (default #OPLive — the On Patrol: Live tag) and shows the latest
--   posts BESIDE the video grid so you can watch + read along.
--   Posts are fetched server-side via @the-convocation/twitter-scraper
--   (cookie-authenticated, no paid API) and persisted here so concurrent
--   panel polls share one upstream fetch and the feed survives restarts.
--   Mirrors the breaking_events convention: ON CONFLICT upsert keyed on
--   the platform-native id + time-bounded retention purge.
-- Date: 2026-06-06

CREATE TABLE IF NOT EXISTS social_feed_posts (
  post_id       TEXT          PRIMARY KEY,                  -- platform-native id (tweet id)
  platform      TEXT          NOT NULL DEFAULT 'x',
  tag           TEXT          NOT NULL,                     -- normalized hashtag, lower-case, no '#'
  author_handle TEXT,
  author_name   TEXT,
  text          TEXT,
  media         JSONB         NOT NULL DEFAULT '[]'::jsonb, -- [{ type:'photo'|'video', url, thumb }]
  url           TEXT,                                       -- permalink to the original post
  likes         INTEGER       NOT NULL DEFAULT 0,
  retweets      INTEGER       NOT NULL DEFAULT 0,
  replies       INTEGER       NOT NULL DEFAULT 0,
  posted_at     TIMESTAMPTZ,                                -- when the post was authored
  ingested_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Retrieval: newest-first within a tag (the panel's primary query).
CREATE INDEX IF NOT EXISTS idx_social_feed_tag_posted
  ON social_feed_posts (tag, posted_at DESC NULLS LAST);

-- Retention purge scans by ingest time.
CREATE INDEX IF NOT EXISTS idx_social_feed_ingested
  ON social_feed_posts (ingested_at);
