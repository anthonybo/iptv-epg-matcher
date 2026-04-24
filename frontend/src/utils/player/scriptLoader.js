/**
 * Lazy-load the CDN scripts that IPTVPlayer depends on at runtime:
 *   - Clappr + level-selector (fallback HLS player)
 *   - mpegts.js (primary TS-over-HTTP player)
 *
 * Each loader is a no-op once its global is already attached to `window`,
 * so calling this on every mount is safe. The mpegts loader accepts an
 * `onReady` callback so the caller can re-initialize the player once the
 * script attaches for the first time (the useEffect that triggers the
 * very first load happens before mpegts.js is parsed).
 */

function ensureScript({ src, crossOrigin, onload }) {
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  if (crossOrigin) script.crossOrigin = crossOrigin;
  if (onload) script.onload = onload;
  document.head.appendChild(script);
  return script;
}

export function loadPlayerScripts({ onMpegtsReady, log } = {}) {
  const logInfo = (msg) => (log ? log('info', msg) : null);

  if (!window.Clappr) {
    ensureScript({
      src: 'https://cdn.jsdelivr.net/npm/clappr@latest/dist/clappr.min.js',
      onload: () => {
        logInfo('Clappr loaded');
        ensureScript({
          src:
            'https://cdn.jsdelivr.net/npm/clappr-level-selector-plugin@latest/dist/level-selector.min.js',
          onload: () => logInfo('Level selector plugin loaded')
        });
      }
    });
  }

  if (!window.mpegts) {
    ensureScript({
      src: 'https://cdn.jsdelivr.net/npm/mpegts.js@latest',
      // Needed so window.onerror receives real error details from this CDN
      // script instead of the opaque "Script error." placeholder.
      crossOrigin: 'anonymous',
      onload: () => {
        logInfo('mpegts.js loaded');
        if (onMpegtsReady) onMpegtsReady();
      }
    });
  }
}
