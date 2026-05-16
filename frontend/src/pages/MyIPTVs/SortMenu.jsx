import React, { useEffect, useRef, useState } from 'react';
import { SORT_OPTIONS, DEFAULT_SORT_KEY } from './utils';

/**
 * Sort menu button + dropdown shared between the MyIPTVs page header
 * ("Sort all") and each DomainSection header (per-domain override).
 *
 * Props
 *   label              — Button label shown beside the icon, e.g.
 *                        "Sort all" or just "Sort". Defaults to "Sort".
 *   value              — Current sort key (one of SORT_OPTIONS keys).
 *                        For the per-domain instance, this is the
 *                        *effective* key (override OR inherited).
 *   onChange(key)      — Called when the user picks a sort option.
 *                        Key '__inherit__' means "clear my per-domain
 *                        override; use global default" — only emitted
 *                        when `inheritOption` is true.
 *   inheritOption      — When true, the menu includes a top-level
 *                        "Use global default" entry. Use this in the
 *                        per-domain menu only.
 *   inheriting         — When true, marks the inherit option as active
 *                        and dims the otherwise-active sort option's
 *                        check so the user sees they're inheriting.
 *   globalSortKey      — The current global default. Shown next to the
 *                        inherit option for context.
 *   onResetOverrides   — Optional callback. When provided, the menu
 *                        gains a "Reset per-domain overrides" entry.
 *                        Used by the global menu so the user can
 *                        re-sync every domain to the global key.
 *   compact            — When true, button shrinks to icon-only (no
 *                        label). Used in per-domain headers where the
 *                        space is tight.
 *   align              — 'left' | 'right'. Defaults to 'right'.
 */
export default function SortMenu({
  label = 'Sort',
  value = DEFAULT_SORT_KEY,
  onChange,
  inheritOption = false,
  inheriting = false,
  globalSortKey = DEFAULT_SORT_KEY,
  onResetOverrides = null,
  compact = false,
  align = 'right',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeOption = SORT_OPTIONS[value] || SORT_OPTIONS[DEFAULT_SORT_KEY];
  const buttonTitle = inheriting
    ? `${label} · using global default (${activeOption.label})`
    : `${label} · ${activeOption.label}`;

  // Inline SVG arrows-up-down so we don't pull in an icon library.
  const SortIcon = (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h11M3 12h8M3 17h5M17 4v16m0 0l-3-3m3 3l3-3" />
    </svg>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={buttonTitle}
        className={`inline-flex items-center gap-1.5 rounded-lg border transition-colors ${
          compact ? 'p-1.5' : 'px-2.5 py-1.5'
        } ${
          open
            ? 'border-blue-500/60 bg-blue-500/10 text-blue-200'
            : inheriting
              ? 'border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              : 'border-slate-600 bg-slate-800/60 text-slate-200 hover:bg-slate-700/60 hover:border-slate-500'
        }`}
      >
        {SortIcon}
        {!compact && (
          <>
            <span className="text-xs font-medium">{label}</span>
            <span className="text-[10px] text-slate-500 uppercase tracking-[0.08em] hidden sm:inline">
              · {activeOption.label}
            </span>
            <svg
              className={`w-3 h-3 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute z-40 mt-2 w-64 rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl shadow-black/40 backdrop-blur-sm overflow-hidden ${
            align === 'left' ? 'left-0' : 'right-0'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 pt-3 pb-2 border-b border-slate-800/80">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {label}
            </p>
          </div>

          <ul className="py-1 max-h-80 overflow-y-auto">
            {inheritOption && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onChange?.('__inherit__');
                    setOpen(false);
                  }}
                  className={`group/opt w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                    inheriting
                      ? 'bg-blue-500/10 text-blue-100'
                      : 'text-slate-300 hover:bg-slate-800/80'
                  }`}
                >
                  <span className="w-3.5 h-3.5 flex-shrink-0 mt-0.5">
                    {inheriting ? (
                      <svg className="w-3.5 h-3.5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold leading-tight">
                      Use global default
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      Currently: {SORT_OPTIONS[globalSortKey]?.label || 'Smart'}
                    </div>
                  </div>
                </button>
              </li>
            )}

            {inheritOption && (
              <li className="my-1 mx-3 border-t border-slate-800/80" aria-hidden="true" />
            )}

            {Object.entries(SORT_OPTIONS).map(([key, opt]) => {
              const active = !inheriting && key === value;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange?.(key);
                      setOpen(false);
                    }}
                    className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                      active
                        ? 'bg-blue-500/15 text-blue-100'
                        : 'text-slate-300 hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="w-3.5 h-3.5 flex-shrink-0 mt-0.5">
                      {active && (
                        <svg className="w-3.5 h-3.5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold leading-tight">{opt.label}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{opt.hint}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {onResetOverrides && (
            <>
              <div className="border-t border-slate-800/80" />
              <button
                type="button"
                onClick={() => {
                  onResetOverrides();
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-[11px] text-amber-300/90 hover:bg-amber-500/10 transition-colors"
              >
                Reset per-domain overrides
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
