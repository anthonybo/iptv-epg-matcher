import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Modal that shows a list of channel candidates for a free-form query —
 * the disambiguation UI for "reelz" → 12 different Reelz variants and
 * the per-tile "switch source" picker for swapping between accounts on
 * the same upstream provider.
 *
 * The modal does NOT ffprobe candidates; it lists them straight from
 * /api/live-events/channel-candidates so the open is instant. Picking
 * one calls `onPick(channel)`; validation happens at play time and the
 * existing find-alternative loop kicks in if the picked stream is dead.
 *
 * Visual model — "control-room console":
 *   - Each row carries a left-edge color rail encoding source type
 *     (xtream=blue, stalker=violet, m3u=emerald). No type badge needed.
 *   - The channel name and the account credential sit on the SAME line
 *     so a column of "5 accounts on lordstreams.live carrying Reelz"
 *     becomes a vertical mono column the eye scans down.
 *   - Mono font is the visual signal for "this is a technical
 *     identifier you act on" — host, credential, MAC. Sans for the
 *     human-readable bits (name, category, source label).
 *
 * Props (unchanged contract):
 *   isOpen, onClose, title, subtitle, loading, error, candidates,
 *   onPick(channel) → boolean, currentChannelId, currentSourceId
 */
const ChannelPickerModal = ({
  isOpen,
  onClose,
  title = 'Pick a channel',
  subtitle,
  loading = false,
  error = null,
  candidates = [],
  onPick,
  currentChannelId = null,
  currentSourceId = null
}) => {
  const [filter, setFilter] = useState('');
  const [pickingId, setPickingId] = useState(null);
  const inputRef = useRef(null);

  // Auto-focus the filter on open + reset stale UI state.
  useEffect(() => {
    if (!isOpen) return;
    setFilter('');
    setPickingId(null);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Esc closes. Bound only while open so the global keymap isn't
  // burdened the rest of the time.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return candidates;
    return candidates.filter((c) =>
      // Username + MAC included so the user can drill the list down to
      // a specific account when they have many on the same provider.
      [c.name, c.sourceName, c.category, c.sourceUsername, c.sourceMac, c.sourceUrl]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(f))
    );
  }, [filter, candidates]);

  if (!isOpen) return null;

  const handlePick = async (channel) => {
    if (!onPick || pickingId) return;
    const key = `${channel.sourceId}::${channel.id}`;
    setPickingId(key);
    try {
      const ok = await onPick(channel);
      if (ok) onClose?.();
    } finally {
      setPickingId(null);
    }
  };

  // Source-type → rail palette. Each tuple: [solid, glow]. Used as
  // gradient stops on the left-edge rail. Picked to be readable on
  // slate-900 and to map intuitively (blue=common xtream, violet=stb-y
  // stalker, emerald=plain m3u).
  const railFor = (type) => {
    switch (type) {
      case 'xtream':  return 'from-sky-400 to-blue-500';
      case 'stalker': return 'from-violet-400 to-purple-500';
      case 'm3u':     return 'from-emerald-400 to-teal-500';
      default:        return 'from-slate-500 to-slate-600';
    }
  };

  const typeLabel = (type) => {
    if (!type) return 'Source';
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  // Hostname only — the path component is noise for an account picker.
  const hostOf = (url) => {
    if (!url) return null;
    try { return new URL(url).host.toLowerCase(); }
    catch { return null; }
  };

  // The right-side credential. Username for xtream/m3u, MAC for
  // stalker. Stays compact (≤30 chars) — the row's filter input lets
  // the user drill into one account if a long username is the
  // disambiguator they need.
  const credLabel = (c) => {
    const max = 30;
    const trunc = (s) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s || '');
    if (c.sourceType === 'stalker' && c.sourceMac) {
      return { kind: 'mac', text: c.sourceMac };
    }
    if (c.sourceUsername) {
      return { kind: 'user', text: trunc(c.sourceUsername) };
    }
    return null;
  };

  const totalCount = candidates.length;
  const showCount = filtered.length;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center px-4 pt-16 backdrop-blur-md bg-slate-950/80"
      onClick={onClose}
      style={{
        // Soft radial vignette over the backdrop — keeps the modal
        // looking lifted off the page without a heavy black overlay.
        backgroundImage:
          'radial-gradient(ellipse at center top, rgba(15,23,42,0.55), rgba(2,6,23,0.85) 70%)'
      }}
    >
      <div
        className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/95 shadow-[0_30px_80px_-15px_rgba(0,0,0,0.7),0_0_0_1px_rgba(148,163,184,0.05)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top accent — a slim gradient strip at the very top edge
            anchors the panel and matches the "rail" motif used in
            each row. Pure decoration. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-500/60 to-transparent"
        />

        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-slate-800/80">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/90 bg-cyan-500/10 border border-cyan-500/20">
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-60 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300" />
                </span>
                Picker
              </span>
              <h2 className="text-[15px] font-semibold text-slate-100 leading-none">
                {title}
              </h2>
            </div>
            {subtitle && (
              <p className="mt-2 text-xs text-slate-400 truncate">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="group/close p-1.5 rounded-lg text-slate-500 hover:bg-slate-800/80 hover:text-slate-100 transition"
            title="Close"
          >
            <svg className="w-4 h-4 transition group-hover/close:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Filter input */}
        <div className="px-6 pt-4 pb-3">
          <div className={`relative group/filter rounded-xl border transition ${
            filter
              ? 'border-cyan-500/40 bg-slate-900 shadow-[0_0_0_3px_rgba(34,211,238,0.07)]'
              : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
          }`}>
            <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 transition ${
              filter ? 'text-cyan-300' : 'text-slate-500 group-hover/filter:text-slate-400'
            }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, host, account, MAC, or category…"
              className="w-full bg-transparent pl-10 pr-24 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
              {filter && (
                <button
                  type="button"
                  onClick={() => {
                    setFilter('');
                    inputRef.current?.focus();
                  }}
                  className="p-0.5 rounded text-slate-500 hover:text-slate-200 transition"
                  title="Clear filter"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                {loading ? '—' : (filter ? `${showCount}/${totalCount}` : totalCount)}
              </span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div
          className="max-h-[60vh] overflow-y-auto px-3 pb-3 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]"
          style={{
            // Webkit scrollbar via inline style so we don't need a
            // global stylesheet. Slim, slate-toned, blends with the
            // panel.
            WebkitOverflowScrolling: 'touch'
          }}
        >
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState message={error} />
          ) : filtered.length === 0 ? (
            <EmptyState filtered={Boolean(filter)} totalCount={totalCount} />
          ) : (
            <ul className="space-y-1">
              {filtered.map((c) => {
                const key = `${c.sourceId}::${c.id}`;
                const isPicking = pickingId === key;
                const isCurrent =
                  currentChannelId &&
                  currentSourceId &&
                  c.id === currentChannelId &&
                  c.sourceId === currentSourceId;
                const cred = credLabel(c);
                const host = hostOf(c.sourceUrl);
                const otherDisabled = pickingId && !isPicking;

                return (
                  <li key={key}>
                    <button
                      onClick={() => handlePick(c)}
                      disabled={isPicking || isCurrent || otherDisabled}
                      className={`group/row relative w-full text-left flex items-stretch gap-3 rounded-xl overflow-hidden transition ${
                        isCurrent
                          ? 'bg-emerald-500/[0.07] ring-1 ring-emerald-500/30 cursor-default'
                          : isPicking
                          ? 'bg-cyan-500/[0.07] ring-1 ring-cyan-500/40 cursor-wait'
                          : otherDisabled
                          ? 'opacity-40 cursor-not-allowed'
                          : 'bg-slate-900/40 hover:bg-slate-800/70 ring-1 ring-transparent hover:ring-slate-700/70 hover:translate-x-[1px]'
                      }`}
                    >
                      {/* Left-edge rail. Encodes source type via color
                          and brightens on hover. The "now playing" row
                          gets an emerald rail with a pulsing dot at
                          the top to mark the active slot. */}
                      <span
                        className={`relative w-[3px] flex-shrink-0 self-stretch bg-gradient-to-b ${
                          isCurrent
                            ? 'from-emerald-300 to-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                            : isPicking
                            ? 'from-cyan-300 to-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.5)]'
                            : `${railFor(c.sourceType)} opacity-60 group-hover/row:opacity-100 group-hover/row:shadow-[0_0_8px_rgba(148,163,184,0.3)]`
                        } transition`}
                      >
                        {isCurrent && (
                          <span className="absolute -top-0.5 -left-0.5 -right-0.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
                        )}
                      </span>

                      {/* Content */}
                      <div className="flex-1 min-w-0 flex items-center gap-3 pr-3 py-2.5">
                        {/* Logo with subtle bevel — the same logos
                            elsewhere are rendered on slate-800; reuse
                            that for visual consistency across the app. */}
                        <div className="relative flex-shrink-0 w-9 h-9 rounded-lg overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
                          {c.logo ? (
                            <img
                              src={c.logo}
                              alt=""
                              className="w-full h-full object-contain"
                              onError={(e) => { e.target.style.display = 'none'; }}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-600">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17 9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z" />
                              </svg>
                            </div>
                          )}
                          {/* Inner highlight */}
                          <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/5" />
                        </div>

                        {/* Two-line column. Line 1 carries name +
                            credential side by side. Line 2 carries
                            type, source name, host, category. */}
                        <div className="min-w-0 flex-1">
                          {/* Line 1 */}
                          <div className="flex items-baseline gap-3">
                            <span className="text-[14px] font-semibold text-slate-100 truncate flex-shrink min-w-0">
                              {c.name}
                            </span>
                            {isCurrent && (
                              <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-300 bg-emerald-500/15 border border-emerald-500/25">
                                <span className="w-1 h-1 rounded-full bg-emerald-400" />
                                On air
                              </span>
                            )}
                            <div className="flex-1" />
                            {cred && (
                              <span
                                className={`flex-shrink-0 font-mono text-[11px] truncate max-w-[42%] tracking-tight ${
                                  cred.kind === 'mac'
                                    ? 'text-violet-300'
                                    : 'text-cyan-300'
                                }`}
                                title={cred.text}
                              >
                                {cred.kind === 'mac' ? cred.text : `@${cred.text}`}
                              </span>
                            )}
                          </div>

                          {/* Line 2 — meta. Uses · separators so it
                              reads as a single sentence at a glance.
                              Type label uses the same color family as
                              the rail for cross-reference. */}
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 min-w-0">
                            <span
                              className={`flex-shrink-0 uppercase tracking-[0.14em] text-[9px] font-bold ${
                                c.sourceType === 'xtream'  ? 'text-sky-400/80' :
                                c.sourceType === 'stalker' ? 'text-violet-400/80' :
                                c.sourceType === 'm3u'     ? 'text-emerald-400/80' :
                                                             'text-slate-500'
                              }`}
                            >
                              {typeLabel(c.sourceType)}
                            </span>
                            <span className="text-slate-700">·</span>
                            <span className="truncate text-slate-400">
                              {c.sourceName || `Source ${c.sourceId}`}
                            </span>
                            {host && (
                              <>
                                <span className="text-slate-700">·</span>
                                <span className="font-mono text-[10px] text-slate-500 truncate">
                                  {host}
                                </span>
                              </>
                            )}
                            {c.category && (
                              <>
                                <span className="text-slate-700 hidden sm:inline">·</span>
                                <span className="hidden sm:inline truncate text-slate-500">
                                  {c.category}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Trailing affordance. Spinner during pick,
                            "Use →" with a sliding arrow on hover, and
                            nothing for the now-playing row (already
                            communicated by the rail + on-air chip). */}
                        <div className="flex-shrink-0 w-12 flex items-center justify-end">
                          {isPicking ? (
                            <svg className="w-4 h-4 animate-spin text-cyan-300" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          ) : isCurrent ? (
                            <span className="text-[10px] font-mono text-emerald-400/70 tracking-tighter">
                              live
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 group-hover/row:text-cyan-300 transition">
                              <span className="opacity-0 group-hover/row:opacity-100 transition">Use</span>
                              <svg
                                className="w-3.5 h-3.5 transition group-hover/row:translate-x-1"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                              </svg>
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800/80 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
          <span className="font-mono normal-case tracking-normal text-[11px] text-slate-500">
            {loading
              ? 'Scanning your sources…'
              : totalCount === 0
              ? 'No matches'
              : filter
              ? `${showCount} of ${totalCount} match`
              : `${totalCount} ${totalCount === 1 ? 'channel' : 'channels'}`}
          </span>
          <span className="flex items-center gap-2">
            <kbd className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900 font-mono text-[10px] text-slate-400 normal-case tracking-normal">
              Esc
            </kbd>
            <span className="text-slate-600 normal-case tracking-normal">to close</span>
          </span>
        </div>
      </div>
    </div>
  );
};

// ─── Sub-states ────────────────────────────────────────────────────────

const LoadingState = () => (
  <div className="px-3 py-10 flex flex-col items-center gap-3 text-slate-400">
    <div className="relative w-10 h-10">
      <div className="absolute inset-0 rounded-full border-2 border-slate-800" />
      <div className="absolute inset-0 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
    </div>
    <p className="text-xs font-mono tracking-tight text-slate-500">
      Scanning your sources…
    </p>
  </div>
);

const ErrorState = ({ message }) => (
  <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
    <div className="w-10 h-10 rounded-full bg-rose-500/10 ring-1 ring-rose-500/30 flex items-center justify-center">
      <svg className="w-5 h-5 text-rose-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m0 3v.008m9-3.758a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
    <p className="text-sm text-slate-200">Couldn't load candidates</p>
    <p className="text-xs text-slate-500 max-w-sm">{message}</p>
  </div>
);

const EmptyState = ({ filtered, totalCount }) => (
  <div className="px-4 py-12 flex flex-col items-center gap-3 text-center">
    <div className="w-10 h-10 rounded-full bg-slate-800/70 ring-1 ring-slate-700 flex items-center justify-center">
      <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    </div>
    <div>
      <p className="text-sm text-slate-300">
        {filtered ? 'No rows match that filter' : 'No matching channels'}
      </p>
      <p className="mt-1 text-xs text-slate-500 max-w-sm">
        {filtered
          ? `Try clearing the filter — ${totalCount} candidate${totalCount === 1 ? '' : 's'} loaded.`
          : 'No channels in your sources match this query.'}
      </p>
    </div>
  </div>
);

export default ChannelPickerModal;
