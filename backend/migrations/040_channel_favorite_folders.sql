-- 040_channel_favorite_folders.sql
--
-- Adds preset folders for the multi-view favorites strip. A folder is
-- a user-owned grouping of channel_favorites; the favorite rows reference
-- it via a nullable folder_id. NULL = top level (the existing behaviour).
--
-- See frontend/src/components/MultiView/FavoritesStrip.jsx for the
-- consumer side.

CREATE TABLE IF NOT EXISTS channel_favorite_folders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(80) NOT NULL,
  color       VARCHAR(16),
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_channel_favorite_folders_user_position
  ON channel_favorite_folders(user_id, position);

ALTER TABLE channel_favorites
  ADD COLUMN IF NOT EXISTS folder_id        INTEGER REFERENCES channel_favorite_folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS folder_position  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_channel_favorites_user_folder
  ON channel_favorites(user_id, folder_id, folder_position);
