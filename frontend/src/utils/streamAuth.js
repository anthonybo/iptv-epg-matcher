/**
 * Utility for adding authentication to stream URLs
 * Video players can't send Authorization headers, so we add the token as a query parameter
 */

/**
 * Get the auth token from localStorage
 * @returns {string|null} The auth token or null if not found
 */
export function getAuthToken() {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

/**
 * Add auth token to a stream URL as a query parameter
 * @param {string} url - The stream URL
 * @returns {string} The URL with auth token appended
 */
export function addAuthToStreamUrl(url) {
  if (!url) return url;

  const token = getAuthToken();
  if (!token) return url;

  // Check if URL already has query parameters
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
