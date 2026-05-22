-- 031: drop redundant indexes on iptv_channels.
--
-- iptv_channels currently has 12 indexes. Each INSERT/DELETE updates
-- every one of them, which is why bulk refresh of a 50k-channel source
-- was taking 15-25 minutes. Two of those indexes are exact duplicates
-- of work already covered by the unique composite + a prefix scan:
--
--   * idx_iptv_channels_channel_id_source_id (channel_id, source_id)
--     is an exact duplicate of iptv_channels_channel_source_unique
--     (channel_id, source_id) — both ordinary B-tree, same columns.
--
--   * idx_iptv_channels_channel_id (channel_id) is a single-column
--     index whose query patterns are fully covered by the composite
--     unique above as a prefix (Postgres uses a composite index for
--     any leading-column query).
--
-- Removing the two redundants cuts index maintenance work during
-- INSERT/DELETE by ~17% with zero query-plan impact.

DROP INDEX IF EXISTS idx_iptv_channels_channel_id_source_id;
DROP INDEX IF EXISTS idx_iptv_channels_channel_id;
