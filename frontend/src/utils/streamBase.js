/**
 * Origin of the streaming endpoints (`/api/stream/...`, `/api/vod-stream/...`).
 *
 * In DEV we point streaming requests at the BACKEND port directly
 * (http://<host>:5001) instead of routing through the Vite proxy on
 * :3000. Reason: the browser's HTTP/1.1 limit of ~6 concurrent
 * connections is per ORIGIN. When the multi-view page mounts six
 * tile streams, all six connection slots to localhost:3000 are
 * permanently occupied, and every subsequent /api/* call on the
 * same origin queues forever — most visibly, the Breaking-events
 * fetch never gets a slot and times out at 60s.
 *
 * Sending streams to a different port = different origin = a fresh
 * pool of 6 connections that doesn't compete with the API pool.
 *
 * In PROD this is empty string (same-origin). The reverse proxy
 * out front (nginx / cloudflare / etc.) typically speaks HTTP/2,
 * which multiplexes everything over a single connection and
 * makes this whole issue go away.
 *
 * The backend has app.use(cors()) globally, so cross-origin
 * requests from the dev frontend resolve cleanly. The stream URL
 * carries auth via a `?token=` query param (not a header) because
 * <video> elements can't set Authorization, so there's no CORS
 * preflight to worry about.
 */
export function streamBase() {
  if (import.meta.env.DEV) {
    // Use the same hostname the user loaded the page from so this
    // works for both localhost and LAN access (192.168.x.y).
    const host = (typeof window !== 'undefined' && window.location?.hostname) || 'localhost';
    return `http://${host}:5001`;
  }
  return '';
}
