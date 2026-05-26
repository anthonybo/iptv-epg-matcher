import React, { useEffect, useState } from 'react';

/**
 * Loading state surfaced while the player is starting or recovering.
 *
 * Design notes:
 *   • The wrapper is `pointer-events: none` so clicks fall through to
 *     the OSD beneath. (Previously the overlay sat at z-30 above the
 *     OSD's z-20 and captured every click — there was no way to
 *     × the tile while waiting.) The inner pill stays opaque visually
 *     and re-enables pointer events on the embedded Cancel button.
 *   • Shows an elapsed-time counter so a hung stream is *visibly*
 *     hung — important UX cue that "this isn't loading, the source
 *     is dead."
 *   • Accepts a `status` prop to surface upstream/recovery state
 *     ("Buffering…", "Re-resolving…", etc.) instead of generic
 *     "Loading…". Falls back to "Loading…" if no status given.
 *   • Cancel button only renders when `onCancel` is wired so single-
 *     view callers (which never want a remove button) don't get one.
 */
export default function PlayerLoadingOverlay({ visible, status = null, onCancel = null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!visible) {
      setElapsed(0);
      return undefined;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  const label = typeof status === 'string' && status.trim()
    ? status
    : 'Loading…';

  const elapsedTxt = elapsed > 0 ? ` · ${elapsed}s` : '';

  return (
    <div
      // pointer-events-none on the wrapper so the OSD's × and other
      // controls stay clickable while loading.
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 15,           // below TileOSD's z-20 so OSD controls win
        pointerEvents: 'none'
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          backgroundColor: 'rgba(2, 6, 23, 0.78)',
          color: 'white',
          borderRadius: '10px',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          maxWidth: '80%',
          // Pill itself can capture clicks for the Cancel button.
          pointerEvents: 'auto',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
          border: '1px solid rgba(148, 163, 184, 0.15)'
        }}
      >
        <div
          style={{
            display: 'inline-block',
            width: '16px',
            height: '16px',
            border: '2px solid rgba(255,255,255,0.25)',
            borderRadius: '50%',
            borderTopColor: 'rgb(34, 211, 238)',  // cyan
            animation: 'spin 1s linear infinite',
            flexShrink: 0
          }}
        />
        <span style={{ fontSize: '11px', fontFamily: 'system-ui, sans-serif' }}>
          <span style={{ fontWeight: 500 }}>{label}</span>
          {elapsedTxt && (
            <span style={{ fontFamily: 'ui-monospace, monospace', opacity: 0.65, marginLeft: 4 }}>
              {elapsedTxt}
            </span>
          )}
        </span>
        {onCancel && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            style={{
              marginLeft: 4,
              padding: '2px 8px',
              fontSize: '9px',
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              borderRadius: '4px',
              border: '1px solid rgba(244, 63, 94, 0.4)',
              background: 'rgba(244, 63, 94, 0.12)',
              color: 'rgb(253, 164, 175)',
              cursor: 'pointer',
              fontFamily: 'system-ui, sans-serif'
            }}
            title="Remove this tile"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
