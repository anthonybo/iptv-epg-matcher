import React, { useState, useEffect, useRef } from 'react';

/**
 * ChannelTableRow — single channel row in the polished media-table.
 *
 * Layout: [select checkbox] [logo tile + name + source/host meta] [group chip] [actions]
 *
 * States (left strip + background tint):
 *   - Auto-testing: 3px violet stripe + bg tint + pulsing dot on the logo
 *   - Active (player): 2px cyan stripe + bg tint + cyan-100 title text
 *   - Selected: cyan-filled checkbox (no row tint — selection is a different axis)
 *   - Hover: faint cyan stripe + slate row tint
 */

// Strip M3U/EXTINF cruft so the title doesn't render as raw playlist text.
const cleanChannelName = (name) => {
  if (!name) return 'Unnamed Channel';
  let cleaned = String(name).replace(/#EXTINF:[^,]*,/, '');
  cleaned = cleaned.replace(/tvg-[a-z]+="[^"]*"/g, '');
  cleaned = cleaned.replace(/group-title="[^"]*"/g, '');
  return cleaned.trim() || 'Unnamed Channel';
};

// Pull just the hostname out of a stream URL. The raw URL has the
// protocol, port, path, and sometimes user@host credentials embedded —
// none of which a viewer cares about. The hostname alone is a useful
// "where the stream is coming from" hint.
const extractHostname = (url) => {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch (_) {
    const m = String(url).match(/^[a-z]+:\/\/(?:[^/@]+@)?([^/:?#]+)/i);
    return m ? m[1] : null;
  }
};

// Two-letter monogram used as the logo fallback. Skips non-alphanumerics
// so a broken upstream name like `?? IRAN ??` becomes "IR" instead of "??".
const monogram = (name) => {
  const cleaned = String(name || '').replace(/[^a-z0-9 ]/gi, ' ').trim();
  if (!cleaned) return '??';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

const ChannelTableRow = ({
  channel,
  index,
  isSelected,
  isActive,
  isMatched,
  isAutoTesting = false,
  autoTestDisabled = false,
  onToggle,
  onClick,
  onPreview,
  onAutoTest
}) => {
  const [imageError, setImageError] = useState(false);
  const rowRef = useRef(null);

  // Scroll the row into view when auto-test moves to it.
  useEffect(() => {
    if (isAutoTesting && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isAutoTesting]);

  const displayName = cleanChannelName(channel.name);
  const hasHD = /\b(?:HD|FHD|UHD|4K|2160P|1080P)\b/i.test(displayName);
  const logoUrl = channel.logo || channel.tvgLogo;
  const hostname = extractHostname(channel.url);

  // Visual hierarchy of row states: auto-testing > active > hover.
  // Selection is signalled by the checkbox, not the row background,
  // so users can multi-select without losing track of what's playing.
  const rowStateClass = isAutoTesting
    ? 'bg-violet-500/[0.10] border-l-[3px] border-l-violet-500'
    : isActive
    ? 'bg-cyan-500/[0.06] border-l-[2px] border-l-cyan-500'
    : 'border-l-[2px] border-l-transparent hover:bg-slate-900/60 hover:border-l-cyan-500/30';

  return (
    <tr
      ref={rowRef}
      className={`group border-b border-slate-800/50 transition-colors ${rowStateClass}`}
    >
      {/* Select checkbox — squarish, matches bulk-bar "Select all" */}
      <td className="w-12 pl-3 pr-2 py-3 align-middle">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle && onToggle(channel);
          }}
          className={`flex items-center justify-center w-4 h-4 rounded-sm border transition ${
            isSelected
              ? 'border-cyan-500/60 bg-cyan-500 shadow-[0_0_8px_-2px_rgba(34,211,238,0.6)]'
              : 'border-slate-700 hover:border-slate-500 bg-slate-900/40'
          }`}
          aria-label={isSelected ? 'Deselect channel' : 'Select channel'}
          aria-pressed={isSelected}
        >
          {isSelected && (
            <svg className="w-3 h-3 text-slate-950" fill="none" stroke="currentColor" strokeWidth={3.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
      </td>

      {/* Logo + Name + Meta — clickable as a unit, opens the player */}
      <td className="px-3 py-3 min-w-0">
        <div
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => onClick && onClick(channel)}
        >
          {/* Logo tile with hairline frame so off-color/transparent logos
              still have visual containment. Falls back to a monogram. */}
          <div className="relative w-12 h-12 flex-shrink-0 rounded-md border border-slate-800 bg-slate-900/60 flex items-center justify-center overflow-hidden">
            {isAutoTesting && (
              <span
                aria-hidden
                className="absolute -top-1 -left-1 w-2.5 h-2.5 rounded-full bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.9)] animate-pulse"
              />
            )}
            {logoUrl && !imageError ? (
              <img
                src={logoUrl}
                alt=""
                className="w-full h-full object-contain p-1"
                onError={() => setImageError(true)}
                loading="lazy"
              />
            ) : (
              <span className="font-mono text-[12px] font-bold tracking-[0.12em] text-slate-500">
                {monogram(displayName)}
              </span>
            )}
          </div>

          {/* Name + meta stack */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={`text-[13.5px] font-semibold truncate ${
                  isActive ? 'text-cyan-100' : 'text-slate-100 group-hover:text-cyan-100/95'
                } transition-colors`}
                title={displayName}
              >
                {displayName}
              </span>
              {hasHD && (
                <span className="flex-shrink-0 h-4 px-1.5 inline-flex items-center rounded-sm font-mono text-[9px] font-bold tracking-[0.12em] text-slate-400 bg-slate-800/80 border border-slate-700/80">
                  HD
                </span>
              )}
              {isMatched && (
                <span
                  className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-sm bg-emerald-500/15 border border-emerald-500/40"
                  title="Matched with EPG"
                >
                  <svg className="w-2.5 h-2.5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              )}
            </div>
            {(channel.sourceName || hostname) && (
              <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500 truncate">
                {channel.sourceName && (
                  <span className="truncate">{channel.sourceName}</span>
                )}
                {channel.sourceName && hostname && (
                  <span className="text-slate-700 flex-shrink-0">·</span>
                )}
                {hostname && (
                  <span className="truncate normal-case tracking-normal text-slate-600">{hostname}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </td>

      {/* Group/category — slate chip, em-dash when missing */}
      <td className="px-3 py-3">
        {channel.groupTitle ? (
          <span
            className="inline-flex items-center max-w-[280px] h-6 px-2 rounded-md border border-slate-800 bg-slate-900/40 font-mono text-[10.5px] uppercase tracking-[0.14em] text-slate-400"
            title={channel.groupTitle}
          >
            <span className="truncate">{channel.groupTitle}</span>
          </span>
        ) : (
          <span className="font-mono text-[12px] text-slate-700" title="No category">—</span>
        )}
      </td>

      {/* Actions cluster — tertiary | secondary | primary */}
      <td className="px-3 py-3">
        <div className="flex items-center justify-end gap-1.5">
          {/* Auto-test from here — tertiary, icon only */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAutoTest && onAutoTest(channel);
            }}
            disabled={autoTestDisabled}
            className={`flex items-center justify-center w-8 h-8 rounded-md border transition ${
              autoTestDisabled
                ? 'border-slate-800/60 text-slate-700 cursor-not-allowed'
                : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-violet-200 hover:border-violet-500/40 hover:bg-violet-500/[0.08]'
            }`}
            title={autoTestDisabled ? 'Auto-test already in progress' : 'Auto-test from this channel'}
            aria-label="Auto-test from this channel"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>

          {/* Preview (PiP) — secondary */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPreview && onPreview(channel);
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-800 bg-slate-900/40 text-slate-300 hover:text-slate-100 hover:border-slate-700 transition"
            title="Preview in picture-in-picture"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <rect x="3" y="5" width="14" height="10" rx="1.5" />
              <rect x="11" y="11" width="10" height="8" rx="1.5" fill="currentColor" stroke="none" opacity="0.4" />
            </svg>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em]">Preview</span>
          </button>

          {/* Open in player — primary action, cyan accent */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClick && onClick(channel);
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-cyan-500/40 bg-cyan-500/[0.08] text-cyan-200 hover:bg-cyan-500/15 hover:border-cyan-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition"
            title="Open in player"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em]">Open</span>
          </button>
        </div>
      </td>
    </tr>
  );
};

// Memoize so a parent re-render (selection change, search update,
// other-row state flip) doesn't force every row in a 200-row table
// to re-render. The default shallow compare is enough — props are
// primitive flags + the channel object reference (channels list is
// rebuilt on fetch, not mutated, so reference equality is reliable).
export default React.memo(ChannelTableRow);
