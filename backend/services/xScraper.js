/**
 * Shared X/Twitter scraper — cookie-authenticated reader built on
 * @the-convocation/twitter-scraper.
 *
 * X gates nearly all reads behind a logged-in session in 2026 (guest
 * tokens are heavily restricted and the official free hashtag-search
 * embed was removed), so we authenticate with session cookies supplied
 * via the X_COOKIES env var — a raw "name=value; name2=value2" cookie
 * string copied from a logged-in browser. No paid API, no dev account.
 *
 * Pattern lifted from a sibling project (StormWire's getScraper): one
 * lazily-initialized, memoised authenticated instance reused across
 * callers. searchTweets() works reliably with valid session cookies;
 * the per-user UserTweets GraphQL endpoint behind getTweets() 401s even
 * when authenticated, so callers should query via search ("#hashtag" or
 * "from:handle") instead.
 *
 * To get X_COOKIES: log into x.com in a browser, open DevTools →
 * Application → Cookies → https://x.com, and copy the cookie header
 * (at minimum auth_token and ct0). Put it in backend/.env as:
 *   X_COOKIES="auth_token=...; ct0=...; ..."
 */
const { Scraper, SearchMode } = require('@the-convocation/twitter-scraper');
const logger = require('../config/logger');

let scraper = null;
let initPromise = null;

/** True when X_COOKIES is present — lets callers surface a "connect X"
 *  hint instead of erroring when the feature isn't configured yet. */
function isConfigured() {
  return Boolean(process.env.X_COOKIES && process.env.X_COOKIES.trim());
}

/**
 * Returns an authenticated Scraper, or null when X_COOKIES is missing /
 * invalid. Memoised: the first call authenticates; later calls reuse the
 * same instance. Concurrent first-callers share one in-flight init.
 */
async function getScraper() {
  if (scraper) return scraper;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const cookieStr = process.env.X_COOKIES;
    if (!cookieStr || !cookieStr.trim()) {
      logger.warn('[xScraper] X_COOKIES not set — X feed disabled');
      return null;
    }
    try {
      const s = new Scraper();
      // The lib wants each cookie as a Set-Cookie-style string scoped to
      // the x.com domain. Split the raw header on ';' and re-attach the
      // domain/path so setCookies() accepts them.
      const cookies = cookieStr
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const [name, ...rest] = c.split('=');
          return `${name.trim()}=${rest.join('=').trim()}; Domain=.x.com; Path=/`;
        });
      await s.setCookies(cookies);
      if (!(await s.isLoggedIn())) {
        logger.error('[xScraper] X auth failed — cookies invalid or expired');
        return null;
      }
      logger.info('[xScraper] X scraper authenticated');
      scraper = s;
      return s;
    } catch (err) {
      logger.error(`[xScraper] init failed: ${err.message}`);
      return null;
    } finally {
      // Allow a future retry if this attempt produced no instance (e.g.
      // expired cookies the user later refreshes) — only the successful
      // path memoises into `scraper`.
      initPromise = null;
    }
  })();

  return initPromise;
}

/** Drop the cached instance so the next getScraper() re-authenticates
 *  (e.g. after the user updates X_COOKIES without a full restart). */
function resetScraper() {
  scraper = null;
  initPromise = null;
}

module.exports = { getScraper, resetScraper, isConfigured, SearchMode };
