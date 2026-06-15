import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

/**
 * All-Games-Today modal.
 *
 * Lists every event whose start time falls on the user's local calendar
 * date — live, scheduled, AND finished. Each row carries the same data
 * the ticker would produce on click (event_id + team names + sport),
 * so picking a row exercises the exact ticker-click pipeline (search,
 * score, ffprobe, swap into multi-view) regardless of whether the
 * event is currently live. Useful for testing search/scoring changes
 * outside a live window.
 *
 * Visual direction: a sports broadcast scoreboard. Each event is a
 * "card" with a colored sport-of-the-row left rail + a stacked
 * SPORT/LEAGUE badge in the league's brand color. Status pill uses
 * broadcast conventions — LIVE pulses in TV-on-air red, scores render
 * in scoreboard yellow Geist Mono. The modal injects its own Google
 * Fonts (Anton + DM Sans + JetBrains Mono) on mount so the parent
 * doesn't need to know about it.
 */

const STATUS_PALETTE = {
  live:      'bg-emerald-900/40 text-emerald-200 border-emerald-700',
  scheduled: 'bg-slate-800     text-slate-300   border-slate-600',
  final:     'bg-slate-800/60  text-slate-500   border-slate-700'
};

function statusKindOf(event) {
  if (event.is_live) return 'live';
  const sType = String(event.status_type || '').toUpperCase();
  const gStat = String(event.game_status || '').toUpperCase();
  // Soccer reports a finished match as STATUS_FULL_TIME / "Full Time" (and
  // after-extra-time / penalties), NOT STATUS_FINAL — so the old FINAL-only
  // check mislabeled a finished World Cup game as "scheduled". Treat all of
  // those terminal states as final.
  if (
    sType.includes('FINAL') || sType.includes('FULL_TIME') || sType.includes('PLAY_COMPLETE') || sType.includes('POST') ||
    ['FULL TIME', 'FT', 'FINAL', 'COMPLETED'].includes(gStat) || gStat.includes('AET')
  ) return 'final';
  return 'scheduled';
}

function formatLocalTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return '—';
  }
}

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

// Local-date YYYY-MM-DD anchor so the backend filters on the user's
// calendar day, not the server's. toISOString() would shift by the
// timezone offset; build the string from the Date object's local parts.
function localDateString(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── Sport visual identity ────────────────────────────────────────────
// Each sport gets a distinctive brand color (pulled from real league
// palettes) plus a 3-letter league shorthand. Drives the row's left
// edge stripe and the SPORT/LEAGUE stacked badge.
const SPORT_THEME = {
  hockey:        { color: '#1e88e5', tag: 'NHL', label: 'HOCKEY' },
  basketball:    { color: '#ff7a00', tag: 'NBA', label: 'BASKETBALL' },
  baseball:      { color: '#dc2626', tag: 'MLB', label: 'BASEBALL' },
  football:      { color: '#0b3b75', tag: 'NFL', label: 'FOOTBALL' },
  soccer:        { color: '#00a651', tag: 'SOC', label: 'SOCCER' },
  mma:           { color: '#f59e0b', tag: 'MMA', label: 'MMA' },
  boxing:        { color: '#e11d48', tag: 'BOX', label: 'BOXING' },
  wrestling:     { color: '#b45309', tag: 'WWE', label: 'WRESTLING' },
  tennis:        { color: '#a3e635', tag: 'ATP', label: 'TENNIS' },
  golf:          { color: '#15803d', tag: 'PGA', label: 'GOLF' },
  cricket:       { color: '#16a34a', tag: 'CKT', label: 'CRICKET' },
  racing:        { color: '#ef4444', tag: 'F1',  label: 'RACING' },
  volleyball:    { color: '#fb923c', tag: 'VOL', label: 'VOLLEYBALL' },
  handball:      { color: '#6366f1', tag: 'HBL', label: 'HANDBALL' },
  rugby:         { color: '#22c55e', tag: 'RUG', label: 'RUGBY' },
  lacrosse:      { color: '#a855f7', tag: 'LAX', label: 'LACROSSE' },
  softball:      { color: '#ec4899', tag: 'SBL', label: 'SOFTBALL' },
  default:       { color: '#64748b', tag: 'SPT', label: 'SPORT' }
};

// ─── League tier classification ───────────────────────────────────────
// Sport_type alone is too coarse — MLB and NCAA Baseball both
// resolve to `baseball` and render the badge in the same red. The
// user can't tell them apart in a 50-event stack. This classifier
// returns a TIER which the badge uses to add a colored accent stripe
// (gold = pro top, cream = college, cyan = international, slate =
// pro-other), modulate saturation, and color-code the league text.
// Same sport color stays for muscle memory; tier accent is the
// glanceable differentiator.
function classifyLeague(leagueName) {
  if (!leagueName) return 'unknown';
  const L = String(leagueName).toLowerCase().trim();

  // College / amateur — broadest first so "ncaa baseball" never
  // matches the pro set below.
  if (L.includes('ncaa') || L.includes('college') ||
      L.startsWith('cbb') || L.startsWith('cfb') ||
      L.includes('high school')) return 'college';

  // Pro-major — household-name top leagues. The eye associates
  // these with the sport's brand color so they get the strongest
  // (gold) accent and full saturation.
  const PRO_MAJOR = new Set([
    'mlb', 'nfl', 'nba', 'nhl', 'mls',
    'premier league', 'epl', 'pl',
    'la liga', 'laliga', 'bundesliga', 'serie a', 'ligue 1',
    'wnba', 'nwsl',
    'pga tour', 'pga',
    'atp', 'wta',
    'f1', 'formula 1', 'formula one', 'motogp',
    'ufc'
  ]);
  if (PRO_MAJOR.has(L)) return 'pro';

  // International / cross-border tournaments — cyan accent.
  if (L.includes('champions league') ||
      L.includes('europa league') ||
      L.includes('uefa') || L.includes('fifa') ||
      L.includes('world cup') || L.includes('copa') ||
      L.includes('olympics') || L.includes('davis cup') ||
      L.includes('concacaf') || L.includes('afc ') ||
      L.includes('international')) return 'international';

  // Pro-other — non-major pro leagues. Same sport color, muted
  // slate accent so they don't compete with pro-major for the eye.
  const PRO_OTHER = new Set([
    'liga mx', 'j league', 'j1 league', 'k league', 'kbo', 'npb',
    'afl', 'cfl',
    'liv golf', 'liv',
    'indycar', 'nascar', 'nascar cup series',
    'bellator', 'one championship', 'pfl', 'glory'
  ]);
  if (PRO_OTHER.has(L)) return 'pro-other';
  if (L.includes('league') || L.includes('tour') ||
      L.includes('series') || L.includes('championship') ||
      L.includes('cup')) return 'pro-other';

  return 'minor';
}

// Tier visual identity — accent color (top stripe + league text)
// and a saturation modulation factor applied to the badge body.
const TIER_THEME = {
  'pro':           { accent: '#fbbf24', satFactor: 1.00, accentGlow: 0.55 },  // gold — top tier
  'college':       { accent: '#fde68a', satFactor: 0.55, accentGlow: 0.30 },  // cream paper — NCAA pennant vibe
  'international': { accent: '#22d3ee', satFactor: 0.95, accentGlow: 0.50 },  // cyan — neutral cross-border
  'pro-other':     { accent: '#94a3b8', satFactor: 0.80, accentGlow: 0.25 },  // slate-400 — minor-pro
  'minor':         { accent: null,     satFactor: 0.70, accentGlow: 0 },     // no stripe
  'unknown':       { accent: null,     satFactor: 1.00, accentGlow: 0 }
};

function themeFor(sportType, leagueName) {
  const tier = classifyLeague(leagueName);
  const tierTheme = TIER_THEME[tier] || TIER_THEME.unknown;
  const merge = (base) => ({
    ...base,
    league: leagueName || base.tag,
    tier,
    tierAccent: tierTheme.accent,
    tierSatFactor: tierTheme.satFactor,
    tierAccentGlow: tierTheme.accentGlow
  });

  if (!sportType) return merge(SPORT_THEME.default);
  const k = String(sportType).toLowerCase();
  // Direct hits first; fall back to "starts with" for variations
  // ("Soccer" vs "Soccer (Women's)") that ESPN sometimes returns.
  if (SPORT_THEME[k]) return merge(SPORT_THEME[k]);
  for (const key of Object.keys(SPORT_THEME)) {
    if (key !== 'default' && k.includes(key)) return merge(SPORT_THEME[key]);
  }
  return merge(SPORT_THEME.default);
}

// Short league string for the badge's secondary line. Long names
// like "UEFA Champions League" need shortening to fit 88px; NCAA
// variants collapse to just "NCAA" because the sport label above
// already says BASEBALL / FOOTBALL / etc. — no point repeating.
function shortLeagueLabel(leagueName, tier, fallbackTag) {
  if (!leagueName) return fallbackTag || '';
  const L = String(leagueName);
  if (tier === 'college') {
    // "NCAA Baseball" / "NCAA Men's Basketball" → just "NCAA"
    // (sport name is already on the line above)
    return 'NCAA';
  }
  // Smart abbreviations for the long international names.
  const ABBREV = {
    'uefa champions league': 'UCL',
    'uefa europa league': 'UEL',
    'uefa conference league': 'UECL',
    'concacaf champions league': 'CCL',
    'afc champions league': 'ACL',
    'copa libertadores': 'LIBERTADORES',
    'copa sudamericana': 'SUDAMERICANA',
    'fifa world cup': 'WORLD CUP',
    'fifa club world cup': 'CLUB WC'
  };
  const abbrev = ABBREV[L.toLowerCase()];
  if (abbrev) return abbrev;
  // Default: uppercase and truncate.
  const up = L.toUpperCase();
  return up.length > 14 ? up.slice(0, 13) + '…' : up;
}

// Status visual identity — broadcast red for LIVE (industry
// convention), amber for upcoming, dimmed slate for done.
const STATUS_THEME = {
  live:      { dot: '#ef4444', text: '#fee2e2', bg: 'rgba(239,68,68,0.16)', border: 'rgba(239,68,68,0.4)' },
  scheduled: { dot: '#fbbf24', text: '#fef3c7', bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.3)' },
  final:     { dot: '#64748b', text: '#cbd5e1', bg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.3)' }
};

// Inject Google Fonts once per page-load, idempotent. Keeps the
// modal self-contained — no need to edit index.html or a global
// stylesheet.
function ensureFontsLoaded() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('all-games-modal-fonts')) return;
  const link = document.createElement('link');
  link.id = 'all-games-modal-fonts';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500;700&display=swap';
  document.head.appendChild(link);
}

const FONT_DISPLAY = "'Anton', 'Bebas Neue', sans-serif";
const FONT_BODY    = "'DM Sans', system-ui, sans-serif";
const FONT_MONO    = "'JetBrains Mono', ui-monospace, 'SF Mono', monospace";

// ─── Team display helpers ─────────────────────────────────────────────
// live_events doesn't carry team logo URLs (the table was built before
// we cared about per-team branding), so we synthesise a stable 2-3
// letter monogram + hashed color per team name. Same visual idea as
// the channel-row monograms — gives the eye a fixed shape/color to
// anchor on while scanning, without us having to pull team logos from
// ESPN's CDN (which needs team IDs we don't currently store).
function teamMonogram(name) {
  if (!name) return '??';
  // Words to ignore when picking initials — sport leagues sprinkle
  // these everywhere and they're never the distinguishing token.
  const STOP = /^(the|of|fc|cf|sc|ac|cd|de|los|las|le|la|el|al|at|vs)$/i;
  const words = String(name)
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP.test(w));
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

function teamHue(name) {
  if (!name) return 200;
  // Cheap hash → hue. Same input always yields same color so the
  // user's Texas Rangers tile is stable across renders/sessions.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function TeamTile({ name }) {
  const initials = teamMonogram(name);
  const hue = teamHue(name);
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center flex-shrink-0"
      style={{
        width: 32,
        height: 32,
        borderRadius: 4,
        background: `hsla(${hue}, 45%, 24%, 0.55)`,
        border: `1px solid hsla(${hue}, 60%, 50%, 0.45)`,
        fontFamily: FONT_MONO,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.06em',
        color: `hsla(${hue}, 70%, 78%, 1)`,
        textShadow: '0 1px 0 rgba(0,0,0,0.4)'
      }}
    >
      {initials}
    </span>
  );
}

const AllGamesModal = ({ isOpen, onPick, onPickBroadcaster, onAfterPick, onStatusChange }) => {
  const [events, setEvents] = useState([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // The Play / chip click currently in flight. Stored as
  // { id, controller } so the same state slot covers both the
  // row-level Play and the per-chip broadcaster pick — only one of
  // either type runs at once. Cancel button calls controller.abort()
  // which propagates to the backend search-channel route via 'close'.
  const [picking, setPicking] = useState(null); // { id, controller, kind: 'event' | 'broadcaster' } | null
  const [statusFilter, setStatusFilter] = useState('all'); // all | live | scheduled | final
  const [sportFilter, setSportFilter] = useState('all');
  // Free-form search across team / league / sport / broadcaster.
  // Cleared every time the modal reopens so a stale query from a
  // previous session doesn't hide today's events.
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef(null);
  const today = localDateString();

  useEffect(() => { ensureFontsLoaded(); }, []);

  // `forceScores` (set by the REFRESH button) first triggers an
  // immediate server-side scores + is_live update, then re-queries.
  // Without it the button only re-read the same stale DB rows, so a
  // game that had just gone live (or a non-ESPN-sourced game the
  // background poll can't flip) would never show as LIVE on demand.
  const fetchEvents = useCallback(async (forceScores = false) => {
    const token = getToken();
    if (!token) {
      setError('Authentication required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (forceScores) {
        // Best-effort — if the scores refresh fails we still re-query
        // so the user at least gets the latest stored data.
        try {
          await fetch('/api/live-events/refresh-scores', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          });
        } catch (scoreErr) {
          console.warn('[AllGamesModal] force scores refresh failed', scoreErr);
        }
      }
      const resp = await fetch(`/api/live-events/today?date=${today}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data?.error || `HTTP ${resp.status}`);
      }
      setEvents(data.events || []);
      setAiEnabled(Boolean(data.aiEnabled));
    } catch (err) {
      console.error('[AllGamesModal] fetch failed', err);
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    if (isOpen) fetchEvents();
  }, [isOpen, fetchEvents]);

  // Reset the query + auto-focus the search box when the modal opens.
  // Without the reset the previous session's filter would silently
  // hide today's events. The 60ms delay lets the modal finish mounting
  // before the focus call so it doesn't get stolen by a sibling.
  useEffect(() => {
    if (!isOpen) return undefined;
    setSearchQuery('');
    const t = setTimeout(() => searchInputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Sport list for the filter chips, derived from the loaded events so
  // the user only sees options that exist today.
  const sportOptions = useMemo(() => {
    const sports = new Set(events.map((e) => e.sport_type).filter(Boolean));
    return ['all', ...Array.from(sports).sort()];
  }, [events]);

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // Tokenise the query so "lakers warriors" matches an event with
    // both names anywhere in the searchable text — order-independent.
    // Each token must hit somewhere; an unmatched token rejects.
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    return events.filter((e) => {
      if (sportFilter !== 'all' && e.sport_type !== sportFilter) return false;
      if (statusFilter !== 'all' && statusKindOf(e) !== statusFilter) return false;
      if (tokens.length === 0) return true;
      // Concatenate every searchable field once per row — cheaper than
      // per-token-per-field iteration on 200+ events.
      const haystack = [
        e.away_team,
        e.home_team,
        e.league_name,
        e.sport_type,
        e.event_name,
        ...(Array.isArray(e.broadcasts) ? e.broadcasts : [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [events, statusFilter, sportFilter, searchQuery]);

  // Counts for the status filter pills — show "Live (3) Scheduled (12)
  // Final (8)" so the user knows whether scrolling is worth it.
  const counts = useMemo(() => {
    const out = { all: events.length, live: 0, scheduled: 0, final: 0 };
    for (const e of events) out[statusKindOf(e)] += 1;
    return out;
  }, [events]);

  const handlePick = useCallback(async (event) => {
    if (picking) return;
    const controller = new AbortController();
    setPicking({ id: event.event_id, controller, kind: 'event' });
    try {
      const ok = await Promise.resolve(onPick && onPick(event, controller.signal));
      if (ok) onAfterPick?.();
    } finally {
      setPicking(null);
    }
  }, [picking, onPick, onAfterPick]);

  // Click on a broadcaster chip → brand-mode search for that channel.
  // Same pipeline as the Coverage modal's per-row Test button. The
  // chip's eventId+code combo identifies which one is loading so we
  // can spinner just that pill.
  const handlePickBroadcaster = useCallback(async (eventId, code) => {
    if (picking || !onPickBroadcaster) return;
    const key = `${eventId}::${code}`;
    const controller = new AbortController();
    setPicking({ id: key, controller, kind: 'broadcaster' });
    try {
      await Promise.resolve(onPickBroadcaster(code, controller.signal));
    } finally {
      setPicking(null);
    }
  }, [picking, onPickBroadcaster]);

  const handleCancel = useCallback(() => {
    if (picking?.controller) {
      console.log(`[AllGames] Cancel clicked (kind=${picking.kind}, id=${picking.id})`);
      picking.controller.abort();
    } else {
      console.warn('[AllGames] Cancel clicked but no controller in flight');
    }
  }, [picking]);

  // Report live status to the dock chip. Don't depend on
  // `onStatusChange` — it's an inline arrow whose identity changes
  // every render, which would loop with the setStatus side-effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onStatusChange) return;
    if (loading) onStatusChange({ kind: 'working', text: 'Loading slate…' });
    else if (error) onStatusChange({ kind: 'error', text: 'Error' });
    else {
      const live = events.filter((e) => statusKindOf(e) === 'live').length;
      const total = events.length;
      onStatusChange({
        kind: 'idle',
        text: live > 0 ? `${live} live · ${total} today` : `${total} today`
      });
    }
  }, [loading, error, events]);

  if (!isOpen) return null;

  return (
    <div
      className="flex-1 min-h-0 flex flex-col relative"
      style={{
        background: 'linear-gradient(180deg, #0d1119 0%, #0a0d14 100%)',
        fontFamily: FONT_BODY
      }}
    >
      {/* Subtle scanline texture overlay — broadcast CRT vibe.
          Pointer-events:none so it never interferes. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0px, rgba(255,255,255,0.012) 1px, transparent 1px, transparent 3px)',
          mixBlendMode: 'overlay'
        }}
      />

        {/* ── FILTERS HEADER ─────────────────────────────────────── */}
        <div
          className="relative flex-shrink-0 px-4 pt-3 pb-3"
          style={{ borderBottom: '1px solid #1f2632' }}
        >
          {/* Date strip — small accent showing what slate we're looking at */}
          <div className="flex items-baseline gap-3 mb-3">
            <span
              className="text-[11px] uppercase tracking-[0.28em]"
              style={{ fontFamily: FONT_MONO, color: '#475569' }}
            >
              {new Date(today + 'T00:00:00').toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric'
              })}
            </span>
            <span
              className="text-[10px] tracking-[0.18em]"
              style={{ fontFamily: FONT_MONO, color: '#334155' }}
            >
              &mdash; live, scheduled, and final
            </span>
            {aiEnabled && (
              <span
                title="AI channel matching is on: broadcasters tagged ✦AI were resolved by AI, and clicking PLAY uses AI to pick the right channel."
                className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 text-[9.5px] tracking-[0.12em]"
                style={{
                  fontFamily: FONT_MONO,
                  fontWeight: 700,
                  color: '#67e8f9',
                  background: 'rgba(34,211,238,0.10)',
                  border: '1px solid rgba(34,211,238,0.3)',
                  borderRadius: '3px'
                }}
              >
                ✦ AI MATCHING ON
              </span>
            )}
          </div>

          {/* Search input — broadcaster console style, scanline-toned
              chrome that matches the modal's CRT aesthetic. Tokenised
              query so "lakers warriors" works the same as
              "warriors lakers". */}
          <div className="mt-4">
            <div
              className="relative flex items-center"
              style={{
                background: searchQuery ? 'rgba(56,189,248,0.06)' : 'rgba(255,255,255,0.025)',
                border: `1px solid ${searchQuery ? 'rgba(56,189,248,0.45)' : '#1f2632'}`,
                borderRadius: '2px',
                transition: 'background 120ms, border-color 120ms',
                boxShadow: searchQuery ? '0 0 0 3px rgba(56,189,248,0.06)' : 'none'
              }}
            >
              <span
                className="pl-3 pr-2 select-none"
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: '11px',
                  letterSpacing: '0.22em',
                  color: searchQuery ? '#7dd3fc' : '#475569',
                  borderRight: '1px solid #1f2632',
                  alignSelf: 'stretch',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                ▸ FIND
              </span>
              <svg
                className="ml-3 flex-shrink-0"
                style={{ width: 14, height: 14, color: searchQuery ? '#7dd3fc' : '#64748b' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(ev) => setSearchQuery(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === 'Escape' && searchQuery) { ev.stopPropagation(); setSearchQuery(''); } }}
                placeholder="Team, league, sport, or broadcaster…"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent px-3 py-2.5 outline-none"
                style={{
                  fontFamily: FONT_BODY,
                  fontSize: '13px',
                  color: '#f1f5f9',
                  letterSpacing: '0.01em'
                }}
              />
              {searchQuery && (
                <>
                  <span
                    className="px-2 select-none"
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '10px',
                      color: '#7dd3fc',
                      letterSpacing: '0.05em'
                    }}
                  >
                    {filteredEvents.length}/{events.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
                    title="Clear search (Esc)"
                    aria-label="Clear search"
                    className="mr-2 flex items-center justify-center w-6 h-6 transition"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid #2a3340',
                      borderRadius: '2px',
                      color: '#94a3b8'
                    }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.background = 'rgba(239,68,68,0.18)'; ev.currentTarget.style.color = '#fca5a5'; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.background = 'rgba(255,255,255,0.04)'; ev.currentTarget.style.color = '#94a3b8'; }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Status filter row — chunky scoreboard pills */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {[
              { id: 'all',       label: 'ALL',       count: counts.all,       color: '#cbd5e1' },
              { id: 'live',      label: 'LIVE',      count: counts.live,      color: '#ef4444' },
              { id: 'scheduled', label: 'SCHEDULED', count: counts.scheduled, color: '#fbbf24' },
              { id: 'final',     label: 'FINAL',     count: counts.final,     color: '#94a3b8' }
            ].map((opt) => {
              const active = statusFilter === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setStatusFilter(opt.id)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 transition"
                  style={{
                    fontFamily: FONT_DISPLAY,
                    fontSize: '12px',
                    letterSpacing: '0.12em',
                    background: active ? `${opt.color}22` : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${active ? opt.color + '99' : '#1f2632'}`,
                    color: active ? opt.color : '#94a3b8',
                    borderRadius: '2px'
                  }}
                >
                  {opt.label}
                  <span
                    className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1"
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '10px',
                      fontWeight: 700,
                      letterSpacing: 0,
                      background: active ? opt.color : 'rgba(255,255,255,0.06)',
                      color: active ? '#0a0d14' : '#cbd5e1',
                      borderRadius: '2px'
                    }}
                  >
                    {opt.count}
                  </span>
                </button>
              );
            })}

            <div className="flex-1" />

            <button
              onClick={() => fetchEvents(true)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 transition disabled:opacity-50"
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: '11px',
                letterSpacing: '0.15em',
                background: 'rgba(56,189,248,0.08)',
                border: '1px solid rgba(56,189,248,0.3)',
                color: '#7dd3fc',
                borderRadius: '2px'
              }}
            >
              <svg
                className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {loading ? 'LOADING' : 'REFRESH'}
            </button>
          </div>

          {/* Sport filter row — compact chips, only shown if >1 sport */}
          {sportOptions.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span
                className="mr-1 text-[10px] uppercase"
                style={{ fontFamily: FONT_MONO, color: '#64748b', letterSpacing: '0.18em' }}
              >
                ▸ Sport
              </span>
              {sportOptions.map((s) => {
                const active = sportFilter === s;
                const t = s === 'all' ? null : themeFor(s, null);
                return (
                  <button
                    key={s}
                    onClick={() => setSportFilter(s)}
                    className="px-2 py-1 transition"
                    style={{
                      fontFamily: FONT_BODY,
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      background: active && t
                        ? `${t.color}26`
                        : active
                          ? 'rgba(255,255,255,0.08)'
                          : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${active && t ? t.color + '80' : active ? '#475569' : '#1f2632'}`,
                      color: active && t ? '#fff' : active ? '#f1f5f9' : '#cbd5e1',
                      borderRadius: '2px'
                    }}
                  >
                    {s === 'all' ? 'All' : s}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── BODY ────────────────────────────────────────────────── */}
        <div className="relative flex-1 overflow-y-auto">
          {error && (
            <div
              className="m-5 p-4 text-sm"
              style={{
                fontFamily: FONT_BODY,
                color: '#fecaca',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.4)',
                borderLeft: '4px solid #ef4444',
                borderRadius: '2px'
              }}
            >
              <strong style={{ fontFamily: FONT_DISPLAY, letterSpacing: '0.1em', fontSize: '12px' }}>ERROR&nbsp;&nbsp;</strong>
              {error}
            </div>
          )}

          {!error && loading && events.length === 0 && (
            <div className="text-center py-16" style={{ color: '#64748b' }}>
              <svg
                className="animate-spin w-8 h-8 mx-auto mb-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
                style={{ color: '#7dd3fc' }}
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <p
                className="text-xs uppercase"
                style={{ fontFamily: FONT_DISPLAY, letterSpacing: '0.25em', color: '#94a3b8' }}
              >
                Loading the slate
              </p>
            </div>
          )}

          {!error && !loading && filteredEvents.length === 0 && (
            <div className="text-center py-20">
              <p
                className="text-base mb-2"
                style={{ fontFamily: FONT_DISPLAY, fontSize: '24px', letterSpacing: '0.04em', color: '#475569' }}
              >
                {events.length === 0 ? 'NO GAMES TODAY' : 'NO MATCHES'}
              </p>
              <p style={{ color: '#64748b', fontSize: '13px' }}>
                {events.length === 0
                  ? 'The schedule is empty for this date.'
                  : 'Adjust the filters to see more events.'}
              </p>
            </div>
          )}

          {filteredEvents.length > 0 && (
            <ul className="divide-y" style={{ borderColor: '#161b24' }}>
              {filteredEvents.map((e) => {
                const kind = statusKindOf(e);
                const sTheme = STATUS_THEME[kind];
                const sport = themeFor(e.sport_type, e.league_name);
                const isPickingThis = picking?.kind === 'event' && picking.id === e.event_id;
                const isOtherPicking = Boolean(picking) && !isPickingThis;
                const broadcasts = Array.isArray(e.broadcasts) ? e.broadcasts : [];
                const hasScore = e.home_score != null || e.away_score != null;

                return (
                  <li
                    key={e.event_id}
                    className="relative group"
                    style={{
                      background: isPickingThis ? 'rgba(56,189,248,0.04)' : 'transparent',
                      transition: 'background 150ms'
                    }}
                    onMouseEnter={(ev) => {
                      if (!isPickingThis) ev.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                    }}
                    onMouseLeave={(ev) => {
                      if (!isPickingThis) ev.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {/* Sport-color left rail — defines the row */}
                    <div
                      aria-hidden="true"
                      className="absolute left-0 top-0 bottom-0 transition-all"
                      style={{
                        width: '4px',
                        background: sport.color,
                        opacity: kind === 'final' ? 0.35 : 1,
                        boxShadow: kind === 'live' ? `0 0 12px ${sport.color}80` : 'none'
                      }}
                    />

                    <div className="flex items-stretch gap-4 pl-6 pr-4 py-4">
                      {/* ── Sport / League badge (tier-aware) ────────
                          Three layers of league differentiation:
                            1. Top accent stripe (3px) — tier color
                               (gold=pro-major, cream=NCAA, cyan=
                               international, slate=pro-other). The
                               eye reads this band before parsing
                               text — scanning a 50-event stack, the
                               user maps "gold-topped row = MLB,
                               cream-topped = NCAA" within seconds.
                            2. Body saturation — college tier desats
                               to ~55% so brighter pro badges win
                               the eye on a crowded list.
                            3. League text color — accent-coloured
                               for non-default tiers, so even if the
                               stripe is occluded the text still
                               tier-codes itself.
                       */}
                      <div className="flex-shrink-0 flex flex-col items-center justify-center w-[88px]">
                        <div
                          className="w-full overflow-hidden text-center"
                          style={{
                            // Body gradient — desaturate for college via the
                            // alpha suffix; pro tiers keep the strong fill.
                            background: sport.tier === 'college'
                              ? `linear-gradient(180deg, ${sport.color}15, ${sport.color}06)`
                              : `linear-gradient(180deg, ${sport.color}25, ${sport.color}0d)`,
                            border: `1px solid ${sport.color}${sport.tier === 'college' ? '38' : '55'}`,
                            borderRadius: '2px',
                            position: 'relative'
                          }}
                          title={e.league_name || sport.label}
                        >
                          {/* Tier accent stripe — top edge.
                              Only renders for classifiable tiers; minor
                              and unknown stay clean. The boxShadow
                              gives a subtle glow so the stripe reads
                              even when the row background tints (hover
                              / picking states). */}
                          {sport.tierAccent && (
                            <div
                              aria-hidden="true"
                              style={{
                                height: 3,
                                background: sport.tierAccent,
                                boxShadow: `0 1px 6px ${sport.tierAccent}${Math.round(sport.tierAccentGlow * 255).toString(16).padStart(2, '0')}`
                              }}
                            />
                          )}
                          <div className="px-2 pt-1.5 pb-2">
                            <div
                              className="leading-none"
                              style={{
                                fontFamily: FONT_DISPLAY,
                                fontSize: '11px',
                                letterSpacing: '0.15em',
                                color: sport.color,
                                filter: sport.tier === 'college'
                                  ? 'brightness(0.85) saturate(0.6)'
                                  : 'brightness(1.4) saturate(1.2)'
                              }}
                            >
                              {sport.label}
                            </div>
                            <div
                              className="mt-1 leading-none"
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: '9px',
                                fontWeight: 700,
                                letterSpacing: '0.1em',
                                // League text picks up the tier accent
                                // color so the differentiator is visible
                                // even without the stripe (e.g. when
                                // the stripe area is hidden by the
                                // hover background).
                                color: sport.tierAccent || '#cbd5e1',
                                textShadow: sport.tierAccent
                                  ? `0 0 8px ${sport.tierAccent}40`
                                  : 'none'
                              }}
                            >
                              {shortLeagueLabel(e.league_name, sport.tier, sport.tag)}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* ── Status pill ─────────────────────────────── */}
                      <div className="flex-shrink-0 flex items-center justify-center w-[92px]">
                        <div
                          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 w-full"
                          style={{
                            background: sTheme.bg,
                            border: `1px solid ${sTheme.border}`,
                            borderRadius: '2px'
                          }}
                        >
                          {kind === 'live' && (
                            <span className="relative flex h-2 w-2">
                              <span
                                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-70"
                                style={{ background: sTheme.dot }}
                              />
                              <span
                                className="relative inline-flex rounded-full h-2 w-2"
                                style={{ background: sTheme.dot, boxShadow: `0 0 6px ${sTheme.dot}` }}
                              />
                            </span>
                          )}
                          {kind === 'scheduled' && (
                            <svg className="w-3 h-3" fill="none" stroke={sTheme.dot} viewBox="0 0 24 24" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          )}
                          {kind === 'final' && (
                            <svg className="w-3 h-3" fill={sTheme.dot} viewBox="0 0 24 24">
                              <path d="M5 13l4 4L19 7" stroke={sTheme.dot} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                          <span
                            style={{
                              fontFamily: FONT_DISPLAY,
                              fontSize: '12px',
                              letterSpacing: '0.12em',
                              color: sTheme.text,
                              lineHeight: 1
                            }}
                          >
                            {kind === 'live'
                              ? (e.game_clock || 'LIVE')
                              : kind === 'final'
                                ? 'FINAL'
                                : formatLocalTime(e.event_start).replace(/\s/g, ' ')}
                          </span>
                        </div>
                      </div>

                      {/* ── Matchup + score + broadcasters ───────────
                          Stacked vertical layout (away over home) —
                          each team gets its own line with monogram
                          tile + full name + per-team score. The old
                          horizontal "Away AT Home" layout was
                          competing with the score block for ~250px
                          of width and aggressively truncated long
                          city names to 3-5 chars ("Tex…", "Los A…").
                          Stacked gives each name the full row width,
                          so "Los Angeles Angels" reads in full. The
                          `title` attribute carries the full team
                          name for hover even when truncation kicks
                          in on a very narrow viewport. */}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col gap-1.5">
                          {(() => {
                            // Team-less events (tennis tournaments, racing,
                            // individual sports) store home/away as the
                            // literal "Unknown" while the real identity lives
                            // in event_name ("Roland Garros"). Render a single
                            // event-name row instead of two "Unknown" lines.
                            const isPh = (t) => !t || ['unknown', 'tbd', 'tba', 'n/a', 'na'].includes(String(t).trim().toLowerCase());
                            const teamless = isPh(e.away_team) && isPh(e.home_team) && e.event_name;
                            return teamless
                              ? [{ name: e.event_name, score: null, side: 'EVENT' }]
                              : [
                                  { name: e.away_team, score: e.away_score, side: 'AWAY' },
                                  { name: e.home_team, score: e.home_score, side: 'HOME' }
                                ];
                          })().map((t, idx) => {
                            // Winner detection on finals — bold + bright vs dimmed.
                            const isFinal = kind === 'final';
                            const hasOpponentScore = isFinal && hasScore;
                            const isWinner =
                              hasOpponentScore &&
                              t.score != null &&
                              (idx === 0
                                ? (e.away_score ?? 0) > (e.home_score ?? 0)
                                : (e.home_score ?? 0) > (e.away_score ?? 0));
                            const isLoser =
                              hasOpponentScore &&
                              t.score != null &&
                              !isWinner &&
                              (e.away_score ?? 0) !== (e.home_score ?? 0);
                            return (
                              <div
                                key={t.side}
                                className="flex items-center gap-2.5 min-w-0"
                                title={t.name || ''}
                              >
                                <TeamTile name={t.name || ''} />
                                <span
                                  className="truncate"
                                  style={{
                                    fontFamily: FONT_BODY,
                                    fontSize: '14px',
                                    fontWeight: isWinner ? 700 : 600,
                                    color: isLoser ? '#94a3b8' : isFinal ? '#e2e8f0' : '#f1f5f9',
                                    letterSpacing: '-0.005em',
                                    flex: '1 1 auto',
                                    minWidth: 0
                                  }}
                                >
                                  {t.name || <span style={{ color: '#475569' }}>—</span>}
                                </span>
                                {/* Per-team score (right-aligned, scoreboard yellow) */}
                                {hasScore && (
                                  <span
                                    className="flex-shrink-0 inline-flex items-center justify-end tabular-nums"
                                    style={{
                                      fontFamily: FONT_MONO,
                                      fontSize: '17px',
                                      fontWeight: 700,
                                      color: isLoser
                                        ? '#cbd5e1'
                                        : isFinal
                                          ? '#fde68a'
                                          : '#fbcf3a',
                                      letterSpacing: '0.04em',
                                      lineHeight: 1,
                                      minWidth: 32
                                    }}
                                  >
                                    {t.score ?? 0}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* Broadcaster chips — MUCH more legible */}
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {broadcasts.length > 0 ? (
                            broadcasts.map((b, idx) => {
                              const chipKey = `${e.event_id}::${b}`;
                              const isThisLoading = picking?.kind === 'broadcaster' && picking.id === chipKey;
                              const isOtherLoading = Boolean(picking) && !isThisLoading;
                              const canPick = Boolean(onPickBroadcaster);

                              if (isThisLoading) {
                                return (
                                  <span
                                    key={`${e.event_id}-b-${idx}`}
                                    className="inline-flex items-center overflow-hidden"
                                    style={{
                                      background: 'rgba(56,189,248,0.18)',
                                      border: '1px solid rgba(56,189,248,0.6)',
                                      borderRadius: '2px',
                                      fontFamily: FONT_BODY
                                    }}
                                  >
                                    <span className="inline-flex items-center gap-1.5 px-2 py-1">
                                      <svg
                                        className="animate-spin"
                                        style={{ width: 11, height: 11, color: '#7dd3fc' }}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                      >
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                                      </svg>
                                      <span
                                        style={{
                                          fontSize: '11px',
                                          fontWeight: 700,
                                          letterSpacing: '0.04em',
                                          color: '#e0f2fe'
                                        }}
                                      >
                                        {b}
                                      </span>
                                    </span>
                                    <button
                                      type="button"
                                      onClick={(ev) => { ev.stopPropagation(); handleCancel(); }}
                                      title="Cancel this search"
                                      className="px-2 py-1 transition"
                                      style={{
                                        background: 'rgba(239,68,68,0.5)',
                                        color: '#fff',
                                        borderLeft: '1px solid rgba(56,189,248,0.6)',
                                        fontSize: '11px',
                                        fontWeight: 700
                                      }}
                                      onMouseEnter={(ev) => { ev.currentTarget.style.background = 'rgba(239,68,68,0.8)'; }}
                                      onMouseLeave={(ev) => { ev.currentTarget.style.background = 'rgba(239,68,68,0.5)'; }}
                                    >
                                      ✕
                                    </button>
                                  </span>
                                );
                              }
                              return (
                                <button
                                  key={`${e.event_id}-b-${idx}`}
                                  type="button"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    if (canPick) handlePickBroadcaster(e.event_id, b);
                                  }}
                                  disabled={!canPick || isOtherLoading}
                                  title={canPick ? `Try ${b} — searches your IPTV catalog for this channel` : b}
                                  className="inline-flex items-center gap-1.5 px-2 py-1 transition"
                                  style={{
                                    fontFamily: FONT_BODY,
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    letterSpacing: '0.04em',
                                    background: isOtherLoading
                                      ? 'rgba(255,255,255,0.02)'
                                      : 'rgba(255,255,255,0.06)',
                                    border: `1px solid ${isOtherLoading ? '#1f2632' : '#2a3340'}`,
                                    color: isOtherLoading ? '#475569' : '#e2e8f0',
                                    borderRadius: '2px',
                                    cursor: isOtherLoading || !canPick ? 'not-allowed' : 'pointer'
                                  }}
                                  onMouseEnter={(ev) => {
                                    if (canPick && !isOtherLoading) {
                                      ev.currentTarget.style.background = 'rgba(56,189,248,0.18)';
                                      ev.currentTarget.style.borderColor = 'rgba(56,189,248,0.6)';
                                      ev.currentTarget.style.color = '#e0f2fe';
                                    }
                                  }}
                                  onMouseLeave={(ev) => {
                                    if (canPick && !isOtherLoading) {
                                      ev.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                                      ev.currentTarget.style.borderColor = '#2a3340';
                                      ev.currentTarget.style.color = '#e2e8f0';
                                    }
                                  }}
                                >
                                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15.536a5 5 0 010-7.072m-2.828 9.9a9 9 0 010-12.728" />
                                  </svg>
                                  {b}
                                </button>
                              );
                            })
                          ) : (Array.isArray(e.aiBroadcasts) && e.aiBroadcasts.length > 0) ? (
                            <>
                              {/* AI-resolved networks — tagged so it's clear
                                  the AI filled these in. Honest tooltip: these
                                  are the LIKELY carriers, not a guaranteed feed. */}
                              <span
                                title="Resolved by AI — the likely network(s) for this event, not a guaranteed live feed"
                                className="inline-flex items-center gap-1 px-1.5 py-1"
                                style={{
                                  fontFamily: FONT_MONO,
                                  fontSize: '9px',
                                  fontWeight: 700,
                                  letterSpacing: '0.1em',
                                  color: '#67e8f9',
                                  background: 'rgba(34,211,238,0.12)',
                                  border: '1px solid rgba(34,211,238,0.35)',
                                  borderRadius: '2px'
                                }}
                              >
                                ✦ AI
                              </span>
                              {e.aiBroadcasts.map((b, idx) => {
                                const chipKey = `${e.event_id}::${b}`;
                                const isThisLoading = picking?.kind === 'broadcaster' && picking.id === chipKey;
                                const isOtherLoading = Boolean(picking) && !isThisLoading;
                                const canPick = Boolean(onPickBroadcaster);
                                return (
                                  <button
                                    key={`${e.event_id}-ai-${idx}`}
                                    type="button"
                                    onClick={(ev) => { ev.stopPropagation(); if (canPick) handlePickBroadcaster(e.event_id, b); }}
                                    disabled={!canPick || isOtherLoading}
                                    title={canPick ? `AI-resolved — try ${b} (searches your catalog)` : b}
                                    className="inline-flex items-center gap-1.5 px-2 py-1 transition"
                                    style={{
                                      fontFamily: FONT_BODY,
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      letterSpacing: '0.04em',
                                      background: isOtherLoading ? 'rgba(34,211,238,0.04)' : 'rgba(34,211,238,0.10)',
                                      border: `1px dashed ${isOtherLoading ? '#1f2632' : 'rgba(34,211,238,0.45)'}`,
                                      color: isOtherLoading ? '#475569' : '#a5f3fc',
                                      borderRadius: '2px',
                                      cursor: isOtherLoading || !canPick ? 'not-allowed' : 'pointer'
                                    }}
                                    onMouseEnter={(ev) => {
                                      if (canPick && !isOtherLoading) {
                                        ev.currentTarget.style.background = 'rgba(34,211,238,0.22)';
                                        ev.currentTarget.style.borderColor = 'rgba(34,211,238,0.7)';
                                        ev.currentTarget.style.color = '#e0f7ff';
                                      }
                                    }}
                                    onMouseLeave={(ev) => {
                                      if (canPick && !isOtherLoading) {
                                        ev.currentTarget.style.background = 'rgba(34,211,238,0.10)';
                                        ev.currentTarget.style.borderColor = 'rgba(34,211,238,0.45)';
                                        ev.currentTarget.style.color = '#a5f3fc';
                                      }
                                    }}
                                  >
                                    {isThisLoading ? (
                                      <svg className="animate-spin" style={{ width: 11, height: 11 }} fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                      </svg>
                                    ) : (
                                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15.536a5 5 0 010-7.072m-2.828 9.9a9 9 0 010-12.728" />
                                      </svg>
                                    )}
                                    {b}
                                  </button>
                                );
                              })}
                            </>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1.5 px-2 py-1"
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: '10px',
                                color: '#475569',
                                fontStyle: 'italic',
                                letterSpacing: '0.05em'
                              }}
                            >
                              No broadcaster data
                            </span>
                          )}
                        </div>
                      </div>

                      {/* ── Play / Cancel button ─────────────────── */}
                      <div className="flex-shrink-0 flex items-center">
                        {isPickingThis ? (
                          <button
                            onClick={handleCancel}
                            title="Cancel this search"
                            className="inline-flex items-center gap-2 px-4 py-2.5 transition"
                            style={{
                              fontFamily: FONT_DISPLAY,
                              fontSize: '12px',
                              letterSpacing: '0.15em',
                              background: '#7f1d1d',
                              color: '#fee2e2',
                              border: '1px solid #b91c1c',
                              borderRadius: '2px',
                              boxShadow: '0 0 0 1px rgba(239,68,68,0.2), 0 4px 12px -4px rgba(239,68,68,0.5)'
                            }}
                            onMouseEnter={(ev) => { ev.currentTarget.style.background = '#991b1b'; }}
                            onMouseLeave={(ev) => { ev.currentTarget.style.background = '#7f1d1d'; }}
                          >
                            <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                            </svg>
                            CANCEL
                          </button>
                        ) : (
                          <button
                            onClick={() => handlePick(e)}
                            disabled={isOtherPicking}
                            className="inline-flex items-center gap-2 px-4 py-2.5 transition"
                            style={{
                              fontFamily: FONT_DISPLAY,
                              fontSize: '12px',
                              letterSpacing: '0.15em',
                              background: isOtherPicking ? 'rgba(255,255,255,0.04)' : '#0c2a4a',
                              color: isOtherPicking ? '#475569' : '#bae6fd',
                              border: `1px solid ${isOtherPicking ? '#1f2632' : '#1d4ed8'}`,
                              borderRadius: '2px',
                              cursor: isOtherPicking ? 'not-allowed' : 'pointer',
                              boxShadow: isOtherPicking ? 'none' : '0 0 0 1px rgba(59,130,246,0.15)'
                            }}
                            onMouseEnter={(ev) => {
                              if (!isOtherPicking) {
                                ev.currentTarget.style.background = '#1e3a8a';
                                ev.currentTarget.style.color = '#dbeafe';
                              }
                            }}
                            onMouseLeave={(ev) => {
                              if (!isOtherPicking) {
                                ev.currentTarget.style.background = '#0c2a4a';
                                ev.currentTarget.style.color = '#bae6fd';
                              }
                            }}
                          >
                            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                            PLAY
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ── FOOTER ──────────────────────────────────────────────── */}
        <div
          className="relative flex-shrink-0 px-6 py-3 flex items-center justify-between gap-4"
          style={{
            borderTop: '1px solid #1f2632',
            background: 'rgba(0,0,0,0.3)'
          }}
        >
          <p
            className="text-[11px] leading-snug"
            style={{ color: '#64748b', fontFamily: FONT_BODY }}
          >
            Click PLAY on a finished game to verify the broadcaster matcher would have picked the right channel had it been live.
          </p>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: '10px',
              letterSpacing: '0.18em',
              color: '#475569'
            }}
          >
            {filteredEvents.length} / {events.length}{' '}
            <span style={{ color: '#334155' }}>EVENTS</span>
          </span>
        </div>
    </div>
  );
};

export default React.memo(AllGamesModal);
