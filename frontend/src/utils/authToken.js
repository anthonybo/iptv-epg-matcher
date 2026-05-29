/**
 * Shared auth-token helpers for silent session refresh.
 *
 * The app uses a single localStorage JWT (no separate refresh token).
 * It's a 7-day token; when it lapses, every authenticated request
 * 401s. Rather than dump the user on the login screen mid-session,
 * we exchange the expired token for a fresh one at /api/auth/refresh
 * (which accepts a recently-expired token within a server-side grace
 * window). Login is only the terminal fallback when refresh itself
 * fails (token expired beyond grace, bad signature, user gone).
 *
 * Used by:
 *   - apiClient response interceptor (auto-refresh + retry on 401)
 *   - the Breaking-events EventSource (can't set headers, so it
 *     refreshes proactively then rides the token as a query param)
 */

const TOKEN_KEY = 'auth_token';

export function getToken() {
  return (
    localStorage.getItem(TOKEN_KEY) ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token') ||
    null
  );
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Decode a JWT payload without verifying (client-side only — never
 * trust this for authz, just for "should I refresh proactively?").
 * Returns null on any malformed input.
 */
export function decodeJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

/** Seconds until `exp`; negative if already expired; null if unknown. */
export function secondsUntilExpiry(token = getToken()) {
  const payload = decodeJwt(token);
  if (!payload || !payload.exp) return null;
  return payload.exp - Math.floor(Date.now() / 1000);
}

export function isTokenExpired(token = getToken()) {
  const s = secondsUntilExpiry(token);
  return s !== null && s <= 0;
}

/**
 * True when the token is expired OR will expire within `withinSec`.
 * Lets callers (e.g. before opening a long-lived SSE) refresh ahead
 * of a lapse instead of reacting to a mid-stream 401.
 */
export function tokenNeedsRefresh(withinSec = 60, token = getToken()) {
  const s = secondsUntilExpiry(token);
  if (s === null) return false; // unknown shape — don't churn
  return s <= withinSec;
}

// Single-flight guard: concurrent 401s (or an SSE + an XHR lapsing at
// the same instant) must not fire N parallel refreshes. The first
// caller starts the refresh; everyone else awaits the same promise.
let inFlightRefresh = null;

/**
 * Exchange the stored token for a fresh one. Resolves to the new
 * token string on success, or null if refresh failed (caller should
 * then send the user to login). Never throws.
 */
export function refreshAuthToken() {
  if (inFlightRefresh) return inFlightRefresh;

  const current = getToken();
  if (!current) return Promise.resolve(null);

  inFlightRefresh = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${current}`
    },
    body: JSON.stringify({ token: current })
  })
    .then(async (resp) => {
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      if (data && data.success && data.token) {
        setToken(data.token);
        if (data.user) {
          try { localStorage.setItem('user', JSON.stringify(data.user)); } catch (_) {}
        }
        return data.token;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => { inFlightRefresh = null; });

  return inFlightRefresh;
}

/** Terminal fallback: clear creds and bounce to login. */
export function redirectToLogin() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('user');
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}
