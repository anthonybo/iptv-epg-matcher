import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Recovery status surface — sits at the top of the video tile and
 * tells the user the stream is in trouble + how much longer we'll
 * try before giving up.
 *
 * Aesthetic: broadcast-monitor chyron. Glass treatment, slate base,
 * amber warning hue with a cyan active indicator. Replaces the
 * previous flat-blue full-width bar that fought the HTML5 controls
 * for screen real estate.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────┐
 *   │ ◉ STREAM PAUSED · backend reconnecting · 07/15s │
 *   │ ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   │  ← progress strip
 *   └──────────────────────────────────────────────────┘
 *
 * Parses the existing string format:
 *   "Stream paused — backend reconnecting…"
 *   "Stream paused 7s — backend reconnecting (gives up at 15s)"
 *   "Reconnecting (1/3)…"
 *   "Buffering — connecting to stream"
 *
 * Whatever shape comes in, we surface a structured status row. If
 * we can't parse counters, the progress strip stays out of the way.
 */
export default function PlayerRecoveryBanner({ recoveryStatus }) {
  // Elapsed time since recovery state BEGAN (null → set transition).
  // Critically NOT reset when the status text updates — e.g. when
  // failureCount ticks from 1→2 and the message changes from
  // "Connection failed" to "2 attempts failed", the user wants to
  // keep seeing the cumulative elapsed time, not have the counter
  // restart at 0 every retry. Previous behaviour reset the counter
  // on every text change and the user saw it perpetually jumping
  // back to single digits.
  const [tick, setTick] = useState(0);
  const startedAtRef = useRef(null);

  useEffect(() => {
    if (!recoveryStatus) {
      startedAtRef.current = null;
      setTick(0);
      return undefined;
    }
    if (startedAtRef.current == null) {
      startedAtRef.current = Date.now();
      setTick(0);
    }
    const id = setInterval(
      () => setTick(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      250
    );
    return () => clearInterval(id);
  }, [recoveryStatus]);

  // Parse the status string into label / detail / counter / limit
  // pieces so each can be styled distinctly.
  const parsed = useMemo(() => parseStatus(recoveryStatus, tick), [recoveryStatus, tick]);

  if (!recoveryStatus) return null;

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          // High z so it sits above any video frame artifacts but
          // doesn't fight modals (PlayerErrorModal is z-50 territory).
          zIndex: 45,
          pointerEvents: 'none',
          display: 'flex',
          justifyContent: 'center',
          // Slide-in: tiny, fast — the surface should feel like it
          // belongs to the tile, not a notification popping in.
          animation: 'iptv-chyron-in 320ms cubic-bezier(0.22, 1, 0.36, 1)'
        }}
      >
        <div
          style={{
            // Constrained width keeps it readable without spanning the
            // whole tile like a generic toast. Falls back to full-width
            // on narrow tiles via maxWidth.
            width: '100%',
            maxWidth: 520,
            display: 'grid',
            gridTemplateRows: 'auto 2px',
            gap: 0,
            borderRadius: 6,
            overflow: 'hidden',
            // Border + warm accent escalate with severity so the
            // chyron itself communicates "this is getting serious"
            // before you even read the text.
            border: `1px solid ${
              parsed.severity === 'connecting' ? COLORS.borderCyan
              : parsed.severity === 'critical' ? COLORS.borderRose
              : COLORS.borderAmber
            }`,
            background: [
              `radial-gradient(120% 200% at 0% 50%, ${
                parsed.severity === 'connecting' ? COLORS.bgCoolAccent
                : parsed.severity === 'critical' ? COLORS.bgHotAccent
                : COLORS.bgWarmAccent
              } 0%, transparent 55%)`,
              `linear-gradient(180deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`
            ].join(', '),
            backdropFilter: 'blur(14px) saturate(140%)',
            WebkitBackdropFilter: 'blur(14px) saturate(140%)',
            boxShadow: [
              '0 1px 0 rgba(255,255,255,0.05) inset',
              '0 12px 32px -12px rgba(0,0,0,0.55)',
              `0 0 0 1px ${COLORS.borderHairline}`
            ].join(', '),
            color: COLORS.textPrimary,
            fontFamily: '"SF Mono", ui-monospace, "Roboto Mono", "Menlo", monospace',
            pointerEvents: 'auto'
          }}
        >
          {/* Row 1: indicator · label · detail · counter */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto',
              alignItems: 'center',
              gap: 12,
              padding: '8px 12px 7px 12px',
              minHeight: 30
            }}
          >
            <Indicator severity={parsed.severity} />

            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                minWidth: 0,
                overflow: 'hidden'
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color:
                    parsed.severity === 'connecting' ? COLORS.cyanLabel
                    : parsed.severity === 'critical' ? COLORS.roseLabel
                    : COLORS.amberLabel,
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
              >
                {parsed.label}
              </span>
              {parsed.failureCount > 0 && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '1px 6px 1px 6px',
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    fontVariantNumeric: 'tabular-nums',
                    borderRadius: 3,
                    background: parsed.severity === 'critical'
                      ? 'rgba(244, 63, 94, 0.18)'
                      : 'rgba(245, 158, 11, 0.18)',
                    color: parsed.severity === 'critical' ? COLORS.roseLabel : COLORS.amberLabel,
                    border: `1px solid ${parsed.severity === 'critical' ? 'rgba(244, 63, 94, 0.35)' : 'rgba(245, 158, 11, 0.35)'}`,
                    flexShrink: 0,
                    fontFamily: '"SF Mono", ui-monospace, "Roboto Mono", "Menlo", monospace'
                  }}
                >
                  ×{parsed.failureCount}
                </span>
              )}
              {parsed.detail && (
                <>
                  <span
                    style={{
                      color: COLORS.dividerMuted,
                      fontSize: 9,
                      fontWeight: 400,
                      flexShrink: 0
                    }}
                  >
                    ▸
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 400,
                      color: COLORS.textSecondary,
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      minWidth: 0
                    }}
                  >
                    {parsed.detail}
                  </span>
                </>
              )}
            </div>

            {/* Counter — mono, tabular-nums. Either the upstream-supplied
                "elapsed/limit" pair or our own elapsed clock. */}
            <span
              style={{
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
                color: COLORS.counterText,
                fontWeight: 500,
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
                paddingLeft: 4,
                borderLeft: `1px solid ${COLORS.dividerHairline}`,
                marginLeft: 4
              }}
            >
              {parsed.counter}
            </span>
          </div>

          {/* Row 2: progress strip — shows fraction of time elapsed
              versus the give-up limit. Falls back to an indeterminate
              sweep when there's no known limit. */}
          <div
            style={{
              position: 'relative',
              background: COLORS.progressTrack,
              overflow: 'hidden'
            }}
          >
            {parsed.limit ? (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${Math.min(100, (parsed.elapsed / parsed.limit) * 100)}%`,
                  background: progressGradient(parsed.elapsed, parsed.limit),
                  transition: 'width 250ms linear'
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  width: '32%',
                  background: COLORS.progressIndeterminate,
                  animation: 'iptv-chyron-sweep 1.6s ease-in-out infinite'
                }}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Indicator ───────────────────────────────────────────────────
function Indicator({ severity }) {
  const color =
    severity === 'connecting' ? COLORS.cyan
    : severity === 'critical' ? COLORS.rose
    : COLORS.amber;
  return (
    <span
      style={{
        position: 'relative',
        width: 10,
        height: 10,
        flexShrink: 0
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 999,
          background: color,
          boxShadow: `0 0 8px ${color}`
        }}
      />
      <span
        style={{
          position: 'absolute',
          inset: -3,
          borderRadius: 999,
          border: `1px solid ${color}`,
          opacity: 0.6,
          animation: 'iptv-chyron-pulse 1.6s ease-out infinite'
        }}
      />
    </span>
  );
}

// ─── Status parser ───────────────────────────────────────────────
/**
 * Best-effort parse of the recovery-status string into a structured
 * shape. The string format isn't strict so we look for known patterns
 * and fall back to displaying the whole string as the detail.
 *
 * Recognised shapes:
 *   "Stream paused 7s — backend reconnecting (gives up at 15s)"
 *   "Stream paused — backend reconnecting…"
 *   "Reconnecting (3/6)..."
 *   "Stream glitched — reloading (2/3)…"
 *   "Buffering — connecting to stream"
 *   "Reconnecting via backend…"
 */
function parseStatus(raw, ownTick) {
  if (!raw) {
    return {
      label: '',
      detail: '',
      counter: '',
      elapsed: 0,
      limit: 0,
      severity: 'connecting'
    };
  }

  let label = '';
  let detail = '';
  let counter = '';
  let elapsed = 0;
  let limit = 0;
  let severity = 'connecting';

  // "N attempts failed" — the most concrete signal we get. Show it
  // as the primary label so the user instantly knows multiple
  // requests have failed.
  const attemptsFailedMatch = raw.match(/(\d+)\s+attempts?\s+failed/i);

  // Find an embedded "Ns" + optional "(gives up at Ns)" pair.
  const elapsedSecMatch = raw.match(/(\d+)\s*s\b/);
  const limitMatch = raw.match(/gives up at\s+(\d+)\s*s/i);
  if (elapsedSecMatch) elapsed = parseInt(elapsedSecMatch[1], 10);
  if (limitMatch) limit = parseInt(limitMatch[1], 10);

  // Look for "(N/M)" retry counters too.
  const retryCounterMatch = raw.match(/\((\d+)\/(\d+)\)/);
  if (retryCounterMatch && !limit) {
    elapsed = parseInt(retryCounterMatch[1], 10);
    limit = parseInt(retryCounterMatch[2], 10);
  }

  // Split label vs detail on the first em-dash variant.
  const dashSplit = raw.split(/\s+[—–-]\s+/);
  if (dashSplit.length >= 2) {
    label = dashSplit[0].trim();
    detail = dashSplit.slice(1).join(' — ').trim();
  } else {
    label = raw.trim();
  }

  // Strip the counter from the detail since we render it separately.
  detail = detail
    .replace(/\(gives up at\s+\d+\s*s\)/i, '')
    .replace(/\(\d+\/\d+\)/g, '')
    .replace(/[…\.]{1,3}$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip the embedded "Ns" from the label — we render it as the counter.
  // (Match a STANDALONE "Ns" with surrounding boundary, not e.g.
  // "attempts" which contains "s".)
  label = label
    .replace(/(^|\s)\d+\s*s(?=\s|$)/g, '$1')
    .trim();

  // Build the counter display
  if (limit) {
    counter = `${String(elapsed).padStart(2, '0')}/${limit}s`;
  } else if (retryCounterMatch) {
    counter = `${retryCounterMatch[1]}/${retryCounterMatch[2]}`;
  } else {
    // Fall back to our own mounted-elapsed counter for parity.
    counter = `${String(ownTick).padStart(2, '0')}s`;
  }

  // Severity: cyan for the early "buffering / connecting" state,
  // amber once we're actively trying to recover from a known failure,
  // rose once multiple attempts have failed (real cause for concern).
  const looksLikeConnecting = /buffer|connecting|warming/i.test(raw);
  const failureCount = attemptsFailedMatch ? parseInt(attemptsFailedMatch[1], 10) : 0;
  if (failureCount >= 3) severity = 'critical';
  else if (failureCount >= 1 || /failed|reconnecting|paused|glitched|retrying/i.test(raw)) {
    severity = 'warning';
  } else if (looksLikeConnecting) {
    severity = 'connecting';
  } else {
    severity = 'warning';
  }

  return {
    label: label.toUpperCase(),
    detail,
    counter,
    elapsed,
    limit,
    severity,
    failureCount
  };
}

// ─── Progress gradient — cyan early, amber on approach, rose at limit ──
function progressGradient(elapsed, limit) {
  if (!limit) return COLORS.progressIndeterminate;
  const frac = elapsed / limit;
  if (frac < 0.5) return `linear-gradient(90deg, ${COLORS.cyan} 0%, ${COLORS.cyanSoft} 100%)`;
  if (frac < 0.8) return `linear-gradient(90deg, ${COLORS.cyan} 0%, ${COLORS.amber} 100%)`;
  return `linear-gradient(90deg, ${COLORS.amber} 0%, ${COLORS.rose} 100%)`;
}

// ─── Palette ─────────────────────────────────────────────────────
// Inline so the component is portable (the existing player surfaces
// don't share a token system; everything else uses inline styles).
const COLORS = {
  bgTop: 'rgba(15, 23, 42, 0.78)',           // slate-900/78
  bgBottom: 'rgba(2, 6, 23, 0.88)',          // slate-950/88
  bgWarmAccent: 'rgba(245, 158, 11, 0.08)',  // amber-500/8 — left-edge warmth
  bgCoolAccent: 'rgba(34, 211, 238, 0.06)',  // cyan-400/6 — connecting state
  bgHotAccent:  'rgba(244, 63, 94, 0.10)',   // rose-500/10 — critical state

  borderAmber: 'rgba(245, 158, 11, 0.25)',
  borderCyan:  'rgba(34, 211, 238, 0.22)',
  borderRose:  'rgba(244, 63, 94, 0.32)',
  borderHairline: 'rgba(148, 163, 184, 0.08)',
  dividerHairline: 'rgba(148, 163, 184, 0.18)',
  dividerMuted: 'rgba(148, 163, 184, 0.4)',

  textPrimary: 'rgb(241, 245, 249)',         // slate-100
  textSecondary: 'rgba(226, 232, 240, 0.82)',// slate-200/82
  counterText: 'rgb(252, 211, 77)',          // amber-300

  amber: 'rgb(245, 158, 11)',                // amber-500
  amberLabel: 'rgb(252, 211, 77)',           // amber-300
  cyan: 'rgb(34, 211, 238)',                 // cyan-400
  cyanSoft: 'rgba(34, 211, 238, 0.55)',
  cyanLabel: 'rgb(103, 232, 249)',           // cyan-300
  rose: 'rgb(244, 63, 94)',                  // rose-500 — used for critical state + near give-up
  roseLabel: 'rgb(253, 164, 175)',           // rose-300

  progressTrack: 'rgba(15, 23, 42, 0.6)',
  progressIndeterminate:
    'linear-gradient(90deg, transparent 0%, rgb(34, 211, 238) 50%, transparent 100%)'
};

// Keyframes injected via <style> so the component stays self-contained.
const KEYFRAMES = `
  @keyframes iptv-chyron-in {
    0%   { opacity: 0; transform: translateY(-8px) scale(0.985); }
    100% { opacity: 1; transform: translateY(0)    scale(1);     }
  }
  @keyframes iptv-chyron-pulse {
    0%   { transform: scale(1);   opacity: 0.7; }
    70%  { transform: scale(2.4); opacity: 0;   }
    100% { transform: scale(2.4); opacity: 0;   }
  }
  @keyframes iptv-chyron-sweep {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(310%);  }
  }
`;
