-- 037: YouTube channel favorites (per-user, multi-view-tile presets).
--
-- Scope: the multi-view grid is gaining "YouTube" as a source type
-- alongside xtream / stalker / m3u. Users want to paste a URL, search
-- yt-dlp's catalog, and save channels they care about so they can fill
-- a tile in one click — same UX as the IPTV favorites strip.
--
-- channel_id holds the YouTube UCID (e.g. UCSJ4gkVC6NrvII8umztf0Ow).
-- handle is the public @-handle when known. avatar_url + name are
-- denormalized cache values from the resolution step so the favorites
-- list renders instantly without re-hitting yt-dlp.
--
-- last_seen_live_at: updated by the live-status probe so the picker
-- can show a LIVE / OFFLINE dot without re-resolving on every render.

CREATE TABLE IF NOT EXISTS youtube_favorites (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      VARCHAR(64)  NOT NULL,
    name            VARCHAR(255) NOT NULL,
    custom_name     VARCHAR(255),
    handle          VARCHAR(128),
    avatar_url      TEXT,
    channel_url     TEXT,
    last_seen_live_at TIMESTAMPTZ,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_favorites_user
    ON youtube_favorites (user_id, added_at DESC);
