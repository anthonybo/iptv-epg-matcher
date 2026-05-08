# IPTV Source "Refresh All" — Optimization Plan

> **Status**: planning notes, deferred. Started 2026-05-05.
> **Goal**: cut "Refresh All" runtime from many minutes to seconds for the
> common case where most upstream catalogs are unchanged since the last
> refresh.

## Current state

Captured from logs + DB on 2026-05-05.

```
53 Xtream sources, 1,128,301 total channels
Many sources: 50K+ channels each
Refresh duration:  median 30s · p95 3.6 min · max 7.0 min (single source)
Status:           32 never-refreshed · 13 success · 8 error
```

Hosts with multiple sources (frontend already serializes per host):

```
lordstreams.live:        10 sources
canal-pro.xyz:8080:       9
xxip9.top:8080:           8   (worst-case host, ~50 min if all timeouts)
hostengine.live:25461:    7
```

## What `POST /api/iptv/sources/:id/refresh-account-info` does today

1. Lookup source by id (full table scan-equivalent — fetches ALL user
   sources then `.find()`s in JS).
2. Delete cache file *before* network fetch.
3. `GET get_live_categories` (1 round-trip).
4. `GET get_live_streams` (1 round-trip, ~30 MB JSON for big providers).
5. `GET account info` (1 round-trip).
6. `DELETE FROM iptv_channels WHERE source_id = $1` (50K rows).
7. `INSERT … ON CONFLICT DO UPDATE` in 100 batches of 500 (the
   `ON CONFLICT` branch can never fire — nothing exists post-DELETE).
8. Save categories.
9. Look up server geo location.

The frontend (`MyIPTVs.jsx::handleRefreshAll`) groups sources by host
and runs hosts in parallel, sources within a host serially. That part
is correct.

## Verified problems (with PG / Node / Xtream docs)

### 1. ON CONFLICT DO UPDATE always rewrites the tuple — even when values are unchanged

> *"An update to a row always results in the creation of entirely new
> index entries for that row, even if the key values remain
> unchanged."* — [PG 16 — Index Access Method](https://www.postgresql.org/docs/16/indexam.html)

So a "plain" upsert isn't a free no-op for unchanged rows. We need a
**conditional** ON CONFLICT clause. PG's `IS DISTINCT FROM` operator
is NULL-safe and documented for exactly this.

The Heap-Only-Tuples (HOT) optimization can avoid index churn — but
**only** when no indexed columns change. We have a GIN trigram index
on `iptv_channels.name` (migration 023), so any `name` change rewrites
trgm index entries. Conditional upsert keeps unchanged rows untouched
and HOT-eligible.

> *"Heap-Only Tuples (HOT) … allows updates to a row to occur in place
> without updating indexes if the update does not change the indexed
> columns."* — [PG 16 — Database Physical Storage](https://www.postgresql.org/docs/16/internals.html)

### 2. node-fetch `timeout` is total request time and was never in the spec

> *"node-fetch only addition in its early days and was never
> implemented in the spec. Now there is a way to control it using
> AbortController."* — [node-fetch #523](https://github.com/node-fetch/node-fetch/issues/523)

For 30 MB JSON responses on slow upstreams, the existing 30 s `timeout:`
option is plausibly tight. The modern pattern uses `AbortSignal.timeout(ms)`
or a manual `AbortController` so the caller can distinguish total
deadline from socket-idle.

Reference: [Better Stack — Node.js timeouts](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/).

### 3. Xtream API has no real pagination, but has category-id filter

`get_live_streams` returns the entire catalog. There's no `?limit=` or
`?offset=`. Optional `&category_id=X` scopes to one category — useful
fallback for providers that consistently time out on the full catalog.
Per-category fetch trades round-trips for resilience.

Refs: [GitHub Xtream API doc](https://github.com/infinitel8p/xtream/blob/main/api.md),
[Xtream Codes setup guide 2026](https://troypoint.com/xtream-codes-api/).

### 4. Cache deletion happens before network fetch

When the upstream is down (8 of 21 sources currently failing), we lose
the last-known-good snapshot we could have served. Standard pattern:
swap the cache only on successful fetch.

### 5. Real upstream error is swallowed

Code throws `new Error('Failed to fetch channels from Xtream API')`
with no status code, no body excerpt. Logs say "Failed to fetch
channels" — could be 401, 429, ETIMEDOUT, malformed JSON, anything.

## Recommended fixes — ranked by ROI

### High-confidence, citation-backed batch (ship first)

| # | Fix | Effort |
|---|---|---|
| 1 | Cache delete only after successful fetch | trivial |
| 2 | "Skip if `last_successful_refresh < 6h`" guard on Refresh-All | small |
| 3 | Content-hash short-circuit (`last_response_sha` column on `iptv_sources`; SHA-256 of channels JSON; skip DB writes if matched) | small migration + ~30 LOC |
| 4 | **Replace `DELETE; INSERT … ON CONFLICT` with conditional upsert** (`DO UPDATE SET … WHERE (existing) IS DISTINCT FROM (EXCLUDED)`) + tail `DELETE FROM iptv_channels WHERE source_id = $1 AND channel_id NOT IN (…)` to remove stale rows | medium — touches `postgresService.saveChannels` |
| 5 | Switch fetch from node-fetch `timeout: 30000` to `AbortSignal.timeout(60_000)` for the channels endpoint specifically (categories + account stay at 30s) | small |
| 6 | Surface real upstream error: capture status code + first 200 chars of body, store in `last_refresh_error` | small |

### Medium ROI, deferred

7. **Server-side bulk refresh route** (`POST /api/iptv/sources/refresh-all`) with NDJSON progress stream + global concurrency limiter (e.g. 6 total, max 2 per host). Eliminates 53× HTTP round-trips and gives the backend visibility into total parallelism.
8. **Per-category fallback**: when a source's full-catalog fetch fails twice in a row, fall back to `get_live_categories` then per-category `get_live_streams` requests. Smaller responses each, paid for in round-trips.

### Big lever, larger refactor

9. **Cross-source channel deduplication.** When 8 sources for `xxip9.top` carry essentially the same 50K channels, normalize to a unique-channels table + a join table (`source_channel`). Likely drops 1.13 M rows → ~250–300 K. Big payoff for the search-channel route too (every WHERE filter scans fewer rows). Requires schema migration + careful rewrite of save / search paths.

## Migration sketch for fix #3

```sql
-- migrations/025_add_iptv_sources_response_hash.sql
ALTER TABLE iptv_sources
  ADD COLUMN IF NOT EXISTS last_response_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_iptv_sources_response_sha
  ON iptv_sources(last_response_sha)
  WHERE last_response_sha IS NOT NULL;
```

## Code sketch for fix #4 (conditional upsert)

```js
// in postgresService.saveChannels — replace the DELETE+INSERT block
const insertSql = `
  INSERT INTO iptv_channels (
    channel_id, source_id, name, stream_url, logo_url, category,
    tvg_id, tvg_name, group_title, source_type, source_username,
    source_password, source_url, source_mac
  ) VALUES ${values.join(', ')}
  ON CONFLICT (channel_id, source_id) DO UPDATE SET
    name        = EXCLUDED.name,
    stream_url  = EXCLUDED.stream_url,
    logo_url    = EXCLUDED.logo_url,
    category    = EXCLUDED.category,
    tvg_id      = EXCLUDED.tvg_id,
    tvg_name    = EXCLUDED.tvg_name,
    group_title = EXCLUDED.group_title,
    updated_at  = CURRENT_TIMESTAMP
  WHERE (
    iptv_channels.name,        iptv_channels.stream_url,  iptv_channels.logo_url,
    iptv_channels.category,    iptv_channels.tvg_id,      iptv_channels.tvg_name,
    iptv_channels.group_title
  ) IS DISTINCT FROM (
    EXCLUDED.name,             EXCLUDED.stream_url,       EXCLUDED.logo_url,
    EXCLUDED.category,         EXCLUDED.tvg_id,           EXCLUDED.tvg_name,
    EXCLUDED.group_title
  )
`;

// After all batches, delete any rows that no longer exist upstream
const allChannelIds = uniqueChannels.map((c) => c.id);
await queryWithRetry(
  'DELETE FROM iptv_channels WHERE source_id = $1 AND channel_id <> ALL($2)',
  [sourceId, allChannelIds]
);
```

## Expected impact (estimates)

| Scenario | Today | After #1–#6 |
|---|---|---|
| First refresh after deploy (no hash baseline) | 5–30 min | same |
| Refresh-All within 6 h of last success | 5–30 min | ~5 s (skipped via #2) |
| Refresh-All, mostly-unchanged catalogs | 5–30 min | ~30 s (network fetches only; #3 skips DB writes) |
| Refresh-All, some catalogs changed | 5–30 min | proportional to changes (#4 skips no-op rows) |
| Single source down upstream | source loses cache, future refreshes also slow | source keeps cache, error message is actionable (#1, #6) |

## Sources

- [PostgreSQL 16 — INSERT (ON CONFLICT)](https://www.postgresql.org/docs/16/sql-insert.html)
- [PostgreSQL 16 — Index Access Method Interface](https://www.postgresql.org/docs/16/indexam.html)
- [PostgreSQL 16 — Database Physical Storage (HOT)](https://www.postgresql.org/docs/16/internals.html)
- [node-fetch — deprecate timeout in favor of AbortController (#523)](https://github.com/node-fetch/node-fetch/issues/523)
- [Better Stack — A Complete Guide to Timeouts in Node.js](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/)
- [Xtream Codes API reference](https://github.com/infinitel8p/xtream/blob/main/api.md)
- [Xtream Codes Setup Guide 2026 (TROYPOINT)](https://troypoint.com/xtream-codes-api/)

## Files most relevant when this picks up

- `backend/routes/iptvSources.js:367` — refresh-account-info handler
- `backend/services/epgService.js:1617` — `loadXtreamEPG` (upstream fetch + cache)
- `backend/services/postgresService.js:319` — `saveChannels` (DELETE+INSERT path)
- `frontend/src/pages/MyIPTVs/MyIPTVs.jsx:196` — `handleRefreshAll` (per-host parallelism)
- `backend/migrations/023_add_iptv_channels_name_trgm_index.sql` — context for why index churn matters
