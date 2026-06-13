/**
 * Social feed service — backs the multiview "Live chatter" side panel.
 *
 * On request, returns the latest X/Twitter posts for a hashtag (default
 * #OPLive, the On Patrol: Live tag). Posts are fetched server-side via
 * the cookie-authenticated scraper, deduped into Postgres, and served
 * newest-first. A short freshness window (FRESH_TTL_MS) coalesces the
 * panel's ~30s polls — and any concurrent viewers — into one upstream
 * fetch per tag, so we never hammer X. The DB is the source of truth so
 * the feed survives restarts and shows immediately on the next open.
 *
 * Mirrors the breaking-events persistence convention (ON CONFLICT upsert
 * keyed on the platform id + time-bounded retention purge).
 */
const pg = require('./postgresService');
const logger = require('../config/logger');
const { getScraper, isConfigured, SearchMode } = require('./xScraper');

const FRESH_TTL_MS = 30 * 1000;        // refetch a tag at most this often
const FETCH_COUNT = 40;                // posts pulled per upstream fetch
const DEFAULT_LIMIT = 60;              // posts returned to the panel
const MAX_LIMIT = 100;
const RETENTION_DAYS = 7;              // drop posts older than this
const PURGE_INTERVAL_MS = 60 * 60_000; // purge at most hourly

// Per-tag last-upstream-fetch timestamps and in-flight fetch promises so
// concurrent polls share one upstream call instead of stampeding.
const lastFetchAt = new Map();   // tag -> epoch ms
const inFlight = new Map();      // tag -> Promise
let lastPurgeAt = 0;

/** Normalize a user-supplied tag to the stored form: no '#', lower-case,
 *  alphanumerics + underscore only. Falls back to 'oplive'. */
function normalizeTag(raw) {
  const t = String(raw || '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return t || 'oplive';
}

/** Highest-bitrate progressive MP4 from a video_info.variants array. */
function bestMp4(variants) {
  const mp4 = (variants || []).filter((v) => v.content_type === 'video/mp4' && v.url);
  if (mp4.length === 0) return null;
  mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0].url;
}

/** Pull image + video media off a scraper tweet into our compact shape.
 *  We read the RAW extended_entities payload because it carries the real
 *  video POSTER (media_url_https, a .jpg) and the playable MP4 variants.
 *  The convenience `tweet.videos[].preview` is the .mp4 itself — not a
 *  poster — so using it as an <img> src renders a broken-image box. */
function extractMedia(tweet) {
  const out = [];
  const raw = tweet.__raw_UNSTABLE || {};
  const rawMedia = raw.extended_entities?.media || raw.entities?.media || [];
  for (const m of rawMedia) {
    if (m.type === 'photo') {
      const u = m.media_url_https || m.media_url;
      if (u) out.push({ type: 'photo', url: u, thumb: u });
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const mp4 = bestMp4(m.video_info?.variants);
      const poster = m.media_url_https || null;
      // Keep it if we have something to render — a playable file and/or a poster.
      if (mp4 || poster) {
        out.push({ type: 'video', url: mp4, thumb: poster, gif: m.type === 'animated_gif' });
      }
    }
  }
  // Fallback when the raw payload is missing: photos only (real image URLs).
  // We skip tweet.videos here because its `preview` is the mp4, not a poster.
  if (out.length === 0) {
    for (const p of (tweet.photos || [])) {
      if (p && p.url) out.push({ type: 'photo', url: p.url, thumb: p.url });
    }
  }
  return out;
}

/** Map a scraper tweet to a social_feed_posts row tuple. Returns null
 *  for tweets we can't key (no id). */
function tweetToRow(tweet, tag) {
  if (!tweet || !tweet.id) return null;
  const postedAt = tweet.timeParsed instanceof Date
    ? tweet.timeParsed.toISOString()
    : (typeof tweet.timestamp === 'number' ? new Date(tweet.timestamp * 1000).toISOString() : null);
  const handle = tweet.username || null;
  return {
    post_id: String(tweet.id),
    tag,
    author_handle: handle,
    author_name: tweet.name || null,
    text: tweet.text || null,
    media: extractMedia(tweet),
    url: tweet.permanentUrl || (handle ? `https://x.com/${handle}/status/${tweet.id}` : null),
    likes: Number(tweet.likes) || 0,
    retweets: Number(tweet.retweets) || 0,
    replies: Number(tweet.replies) || 0,
    posted_at: postedAt
  };
}

const UPSERT_SQL = `
  INSERT INTO social_feed_posts
    (post_id, platform, tag, author_handle, author_name, text, media, url, likes, retweets, replies, posted_at)
  VALUES ($1,'x',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
  ON CONFLICT (post_id) DO UPDATE SET
    tag      = EXCLUDED.tag,
    text     = EXCLUDED.text,
    media    = EXCLUDED.media,
    likes    = GREATEST(social_feed_posts.likes,    EXCLUDED.likes),
    retweets = GREATEST(social_feed_posts.retweets, EXCLUDED.retweets),
    replies  = GREATEST(social_feed_posts.replies,  EXCLUDED.replies)
`;

/** Fetch fresh posts for a tag from X and upsert them. Returns the count
 *  ingested this cycle. Silently returns 0 when the scraper isn't
 *  configured / authenticated. */
async function fetchUpstream(tag) {
  const s = await getScraper();
  if (!s) return 0;

  // Latest mode + no retweets keeps the panel a live conversation feed
  // rather than a pile of RTs of the same post.
  const query = `#${tag} -filter:retweets`;
  const rows = [];
  try {
    for await (const tweet of s.searchTweets(query, FETCH_COUNT, SearchMode.Latest)) {
      const row = tweetToRow(tweet, tag);
      if (row) rows.push(row);
    }
  } catch (err) {
    logger.warn(`[socialFeed] searchTweets("${query}") failed: ${err.message}`);
    return 0;
  }

  if (rows.length === 0) return 0;

  await pg.transaction(async (client) => {
    for (const r of rows) {
      await client.query(UPSERT_SQL, [
        r.post_id, r.tag, r.author_handle, r.author_name, r.text,
        JSON.stringify(r.media), r.url, r.likes, r.retweets, r.replies, r.posted_at
      ]);
    }
  });

  logger.info(`[socialFeed] #${tag}: +${rows.length} posts`);
  return rows.length;
}

/** Drop posts older than the retention window. Rate-limited to hourly. */
async function maybePurge() {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = now;
  try {
    await pg.query(
      `DELETE FROM social_feed_posts WHERE ingested_at < now() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)]
    );
  } catch (err) {
    logger.warn(`[socialFeed] purge failed: ${err.message}`);
  }
}

/** Read the latest stored posts for a tag. */
async function readPosts(tag, limit) {
  const result = await pg.query(
    `SELECT post_id, platform, tag, author_handle, author_name, text, media, url,
            likes, retweets, replies, posted_at
       FROM social_feed_posts
      WHERE tag = $1
      ORDER BY posted_at DESC NULLS LAST, ingested_at DESC
      LIMIT $2`,
    [tag, limit]
  );
  return result.rows;
}

/**
 * Public entry point. Returns { configured, tag, posts, fetchedUpstream }.
 * Refreshes from X when the tag is stale (or force=true), then serves the
 * newest stored posts. Never throws on upstream failure — it falls back
 * to whatever is already persisted.
 */
async function getFeed(tagRaw, { limit = DEFAULT_LIMIT, force = false } = {}) {
  const tag = normalizeTag(tagRaw);
  const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const configured = isConfigured();

  if (configured) {
    const stale = force || (Date.now() - (lastFetchAt.get(tag) || 0)) > FRESH_TTL_MS;
    if (stale) {
      // Coalesce concurrent refreshes for the same tag.
      let pending = inFlight.get(tag);
      if (!pending) {
        pending = (async () => {
          try {
            const n = await fetchUpstream(tag);
            lastFetchAt.set(tag, Date.now());
            await maybePurge();
            return n;
          } finally {
            inFlight.delete(tag);
          }
        })();
        inFlight.set(tag, pending);
      }
      try { await pending; } catch (_) { /* served from DB below */ }
    }
  }

  const posts = await readPosts(tag, cap);
  return {
    configured,
    tag,
    posts,
    fetchedUpstream: configured,
    cachedAt: lastFetchAt.get(tag) || null
  };
}

module.exports = { getFeed, normalizeTag };
