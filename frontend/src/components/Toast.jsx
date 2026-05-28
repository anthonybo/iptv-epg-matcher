import React, { useEffect, useRef, useState } from 'react';

/**
 * Toast notification surface — slim broadcast-monitor chyron with a
 * card-stack metaphor.
 *
 * Aesthetic: matches the PlayerRecoveryBanner — glass over slate,
 * severity-coded left edge bar, mono UPPERCASE label, lifetime
 * progress strip along the bottom.
 *
 * Stack behaviour: only the newest (front) toast is fully visible.
 * Older toasts sit behind it with a small downward offset + scale +
 * fade so a thin sliver peeks out from below. The user sees one
 * card at a time and is aware more are queued. A "Clear all" button
 * appears above the stack when ≥ 2 toasts are present.
 *
 * Lifetime: only the FRONT toast counts down. Back toasts pause
 * their timers and resume when they become the front (their full
 * duration starts fresh on promotion). This matches the user's
 * mental model of "one notification at a time".
 *
 * API (unchanged):
 *   showToast(message, type, duration, action?)
 *     - message:  string (preserves \n for multi-line)
 *     - type:     'success' | 'error' | 'warning' | 'info'
 *     - duration: ms (default 3000)
 *     - action:   { label, onClick } — optional inline button
 */

const SEVERITY = {
  success: {
    label: 'Success',
    accent: 'rgb(52, 211, 153)',          // emerald-400
    accentSoft: 'rgba(52, 211, 153, 0.55)',
    labelText: 'rgb(110, 231, 183)',      // emerald-300
    edgeBar:  'rgba(52, 211, 153, 0.85)',
    border:   'rgba(52, 211, 153, 0.28)',
    radialAccent: 'rgba(52, 211, 153, 0.10)'
  },
  error: {
    label: 'Failed',
    accent: 'rgb(244, 63, 94)',           // rose-500
    accentSoft: 'rgba(244, 63, 94, 0.55)',
    labelText: 'rgb(253, 164, 175)',      // rose-300
    edgeBar:  'rgba(244, 63, 94, 0.85)',
    border:   'rgba(244, 63, 94, 0.32)',
    radialAccent: 'rgba(244, 63, 94, 0.10)'
  },
  warning: {
    label: 'Alert',
    accent: 'rgb(245, 158, 11)',          // amber-500
    accentSoft: 'rgba(245, 158, 11, 0.55)',
    labelText: 'rgb(252, 211, 77)',       // amber-300
    edgeBar:  'rgba(245, 158, 11, 0.85)',
    border:   'rgba(245, 158, 11, 0.28)',
    radialAccent: 'rgba(245, 158, 11, 0.10)'
  },
  info: {
    label: 'Info',
    accent: 'rgb(34, 211, 238)',          // cyan-400
    accentSoft: 'rgba(34, 211, 238, 0.55)',
    labelText: 'rgb(103, 232, 249)',      // cyan-300
    edgeBar:  'rgba(34, 211, 238, 0.85)',
    border:   'rgba(34, 211, 238, 0.24)',
    radialAccent: 'rgba(34, 211, 238, 0.08)'
  }
};

const TOAST_BG_TOP    = 'rgba(15, 23, 42, 0.88)';
const TOAST_BG_BOTTOM = 'rgba(2, 6, 23, 0.94)';
const TOAST_HAIRLINE  = 'rgba(148, 163, 184, 0.08)';
const PROGRESS_TRACK  = 'rgba(15, 23, 42, 0.6)';
const BODY_TEXT       = 'rgb(226, 232, 240)';
const SUBTLE_TEXT     = 'rgba(148, 163, 184, 0.7)';

const Toast = ({
  message,
  type = 'success',
  duration = 3000,
  onClose,
  action = null,
  paused = false,
  stackCount = 1,    // total toasts in stack — shows inline clear-all when > 1
  onClearAll = null  // called when user clicks the inline clear-all chip
}) => {
  const [progress, setProgress] = useState(0);
  const elapsedRef = useRef(0);
  const closingRef = useRef(false);
  const tickRef = useRef(null);
  const expiryRef = useRef(null);

  const severity = SEVERITY[type] || SEVERITY.info;

  // Only the front (un-paused) toast counts down. Back-stack toasts
  // pause their lifetime so they don't expire while invisible.
  useEffect(() => {
    if (paused) {
      // pause: clear timers but keep elapsedRef so we resume from
      // where we left off if we ever un-pause. (In practice we
      // restart fresh when a back card is promoted to front; see
      // the elapsedRef = 0 reset below.)
      if (tickRef.current) clearInterval(tickRef.current);
      if (expiryRef.current) clearTimeout(expiryRef.current);
      return undefined;
    }
    // On promotion to front: restart the lifetime fresh so the user
    // gets the full duration on every notification.
    const startedAt = Date.now();
    elapsedRef.current = 0;
    setProgress(0);
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      elapsedRef.current = elapsed;
      setProgress(Math.min(1, elapsed / duration));
    }, 60);
    expiryRef.current = setTimeout(() => handleClose(), duration);
    return () => {
      clearInterval(tickRef.current);
      clearTimeout(expiryRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, duration]);

  const handleClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (onClose) onClose();
  };

  return (
    <div
      role="status"
      aria-live={type === 'error' ? 'assertive' : 'polite'}
      style={{
        display: 'grid',
        gridTemplateColumns: '3px 1fr',
        width: '100%',
        borderRadius: 6,
        overflow: 'hidden',
        border: `1px solid ${severity.border}`,
        background: [
          `radial-gradient(110% 220% at 0% 50%, ${severity.radialAccent} 0%, transparent 60%)`,
          `linear-gradient(180deg, ${TOAST_BG_TOP} 0%, ${TOAST_BG_BOTTOM} 100%)`
        ].join(', '),
        backdropFilter: 'blur(16px) saturate(140%)',
        WebkitBackdropFilter: 'blur(16px) saturate(140%)',
        boxShadow: [
          '0 1px 0 rgba(255,255,255,0.04) inset',
          '0 14px 36px -16px rgba(0,0,0,0.7)',
          `0 0 0 1px ${TOAST_HAIRLINE}`
        ].join(', '),
        color: BODY_TEXT,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
      }}
    >
      {/* Left severity bar */}
      <div
        style={{
          background: `linear-gradient(180deg, ${severity.edgeBar} 0%, ${severity.accentSoft} 100%)`,
          boxShadow: `inset -1px 0 0 ${severity.border}`
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Single-line header: dot · LABEL · message (wraps below if long) · close */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            alignItems: 'flex-start',
            gap: 8,
            padding: '7px 8px 7px 12px',
            minHeight: 28
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              columnGap: 10,
              rowGap: 2,
              minWidth: 0
            }}
          >
            <span
              style={{
                position: 'relative',
                display: 'inline-block',
                width: 7,
                height: 7,
                flexShrink: 0,
                alignSelf: 'center',
                borderRadius: 999,
                background: severity.accent,
                boxShadow: `0 0 6px ${severity.accent}`
              }}
            />
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: severity.labelText,
                fontFamily: '"SF Mono", ui-monospace, "Roboto Mono", "Menlo", monospace',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                lineHeight: 1.4
              }}
            >
              {severity.label}
            </span>
            <span
              style={{
                fontSize: 12.5,
                lineHeight: 1.45,
                color: BODY_TEXT,
                fontWeight: 400,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                minWidth: 0,
                flex: 1
              }}
            >
              {message}
            </span>
          </div>

          {/* Right-side controls: inline clear-all (when stack > 1)
              + single dismiss. Inline placement avoids the wasted
              vertical strip the floating chip used to occupy. */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {stackCount > 1 && onClearAll && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearAll();
                }}
                aria-label={`Dismiss all ${stackCount} notifications`}
                title={`Dismiss all ${stackCount}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  height: 20,
                  padding: '0 6px',
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  borderRadius: 3,
                  border: '1px solid rgba(148, 163, 184, 0.18)',
                  background: 'rgba(148, 163, 184, 0.05)',
                  color: SUBTLE_TEXT,
                  cursor: 'pointer',
                  fontFamily: '"SF Mono", ui-monospace, "Roboto Mono", "Menlo", monospace',
                  transition: 'color 120ms ease, background 120ms ease, border-color 120ms ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = BODY_TEXT;
                  e.currentTarget.style.background = 'rgba(148, 163, 184, 0.14)';
                  e.currentTarget.style.borderColor = 'rgba(148, 163, 184, 0.32)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = SUBTLE_TEXT;
                  e.currentTarget.style.background = 'rgba(148, 163, 184, 0.05)';
                  e.currentTarget.style.borderColor = 'rgba(148, 163, 184, 0.18)';
                }}
              >
                Clear all
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{stackCount}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleClose}
              aria-label="Dismiss"
              style={{
                width: 20,
                height: 20,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                color: SUBTLE_TEXT,
                cursor: 'pointer',
                borderRadius: 3,
                transition: 'color 120ms ease, background 120ms ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = BODY_TEXT;
                e.currentTarget.style.background = 'rgba(148, 163, 184, 0.10)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = SUBTLE_TEXT;
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Optional inline action */}
        {action && (
          <div style={{ padding: '0 12px 8px 12px' }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (action.onClick) action.onClick();
                handleClose();
              }}
              style={{
                padding: '3px 9px',
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                borderRadius: 3,
                border: `1px solid ${severity.border}`,
                background: severity.radialAccent,
                color: severity.labelText,
                cursor: 'pointer',
                fontFamily: '"SF Mono", ui-monospace, "Roboto Mono", "Menlo", monospace',
                transition: 'background 120ms ease, color 120ms ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = severity.accentSoft.replace(/0\.55/, '0.20');
                e.currentTarget.style.color = BODY_TEXT;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = severity.radialAccent;
                e.currentTarget.style.color = severity.labelText;
              }}
            >
              {action.label}
            </button>
          </div>
        )}

        {/* Lifetime strip — only visibly ticks on the front toast.
            Back toasts show a full bar (paused state). */}
        <div style={{ position: 'relative', height: 2, background: PROGRESS_TRACK }}>
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: paused ? '100%' : `${(1 - progress) * 100}%`,
              background: `linear-gradient(90deg, ${severity.accent} 0%, ${severity.accentSoft} 100%)`,
              transition: paused ? 'none' : 'width 60ms linear',
              opacity: paused ? 0.35 : 1
            }}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * ToastContainer — accordion stack at top-center. Newest toast at
 * front, older ones peek out from behind as slivers. Up to 4 cards
 * render; beyond that a "+N more" hint appears.
 */
export const ToastContainer = () => {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handleShowToast = (event) => {
      const { message, type, duration, action } = event.detail;
      const id = Date.now() + Math.random();
      // Newest first — prepend so toasts[0] is always the front card.
      setToasts((prev) => [{ id, message, type, duration, action }, ...prev]);
    };
    window.addEventListener('showToast', handleShowToast);
    return () => window.removeEventListener('showToast', handleShowToast);
  }, []);

  const removeToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };
  const clearAll = () => setToasts([]);

  const MAX_VISIBLE = 4; // 1 front + up to 3 slivers
  const visible = toasts.slice(0, MAX_VISIBLE);
  const overflow = Math.max(0, toasts.length - MAX_VISIBLE);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        width: 'min(92vw, 480px)',
        pointerEvents: 'none'
      }}
    >
      {/* Stack wrapper — relative so the absolutely-positioned slivers
          align under the front card without affecting layout above.
          Clear-all is rendered INSIDE the front toast (next to its
          dismiss button) so it costs zero extra vertical space. */}
      <div style={{ position: 'relative' }}>
        {visible.map((toast, idx) => {
          const isFront = idx === 0;
          // Each subsequent card scales down + offsets down a bit so
          // its bottom edge peeks out under the front. transformOrigin
          // is top-center so the top edges stay roughly aligned.
          const yOffset = idx * 7;
          const scale = 1 - idx * 0.045;
          const opacity = idx === 0 ? 1 : 0.78 - idx * 0.16;
          return (
            <div
              key={toast.id}
              style={{
                // Front takes natural space so the wrapper height adapts
                // to its content; back cards are absolute-positioned
                // overlays anchored to the same top edge.
                position: isFront ? 'relative' : 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${yOffset}px) scale(${scale})`,
                transformOrigin: 'top center',
                opacity,
                zIndex: 100 - idx,
                pointerEvents: isFront ? 'auto' : 'none',
                transition:
                  'transform 280ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                  'opacity 220ms ease'
              }}
            >
              <Toast
                message={toast.message}
                type={toast.type}
                duration={toast.duration || 3000}
                action={toast.action || null}
                paused={!isFront}
                stackCount={isFront ? toasts.length : 1}
                onClearAll={isFront ? clearAll : null}
                onClose={() => removeToast(toast.id)}
              />
            </div>
          );
        })}

        {/* Overflow indicator — only shown when more than MAX_VISIBLE
            toasts are queued. Sits below the visible stack, centred. */}
        {overflow > 0 && (
          <div
            style={{
              position: 'absolute',
              top: (MAX_VISIBLE - 1) * 7 + 24,
              left: 0,
              right: 0,
              textAlign: 'center',
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'rgba(148, 163, 184, 0.5)',
              fontFamily: '"SF Mono", ui-monospace, "Roboto Mono", "Menlo", monospace',
              pointerEvents: 'none'
            }}
          >
            +{overflow} more
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Helper to show a toast. Signature preserved + optional action.
 */
export const showToast = (message, type = 'success', duration = 3000, action = null) => {
  window.dispatchEvent(
    new CustomEvent('showToast', {
      detail: { message, type, duration, action }
    })
  );
};

export default Toast;
