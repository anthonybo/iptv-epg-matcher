import React from 'react';

/**
 * BlacklistModal — drawer content for managing the blacklist.
 *
 * Renders only the inner content (filter empty-state + list). The
 * parent wraps it in <DrawerShell> which owns the title bar, close,
 * minimize, and slide-in motion. The `isOpen` prop is kept so the
 * page can short-circuit rendering when the panel isn't in the
 * drawer stack at all.
 */
const BlacklistModal = ({
  isOpen,
  blacklistedChannels = [],
  onRemoveFromBlacklist
}) => {
  if (!isOpen) return null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Subhead */}
      <div className="flex-shrink-0 px-4 py-2.5 border-b border-slate-800/60 flex items-center justify-between">
        <p className="text-[10.5px] text-slate-500 leading-tight">
          Channels excluded from random fill &amp; autoplay.
        </p>
        <span className="font-mono text-[10px] text-slate-600 tabular-nums">
          {String(blacklistedChannels.length).padStart(2, '0')} entries
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-3 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
        {blacklistedChannels.length === 0 ? (
          <div className="px-4 py-12 flex flex-col items-center gap-3 text-center">
            <div className="w-10 h-10 rounded-full bg-rose-500/10 ring-1 ring-rose-500/25 flex items-center justify-center">
              <svg className="w-5 h-5 text-rose-300/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <p className="text-sm text-slate-300">No blacklisted channels</p>
            <p className="text-xs text-slate-500 max-w-xs">
              Click the ban icon on any tile&apos;s overflow menu to add it here.
            </p>
          </div>
        ) : (
          <ul className="space-y-1">
            {blacklistedChannels.map((channelName, index) => (
              <li
                key={index}
                className="group/row flex items-center gap-2 p-2.5 rounded-lg bg-slate-900/50 border border-slate-800 hover:border-slate-700 hover:bg-slate-900 transition"
              >
                <span aria-hidden className="w-[2px] self-stretch rounded bg-gradient-to-b from-rose-400 to-rose-600 opacity-70 group-hover/row:opacity-100" />
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <svg className="flex-shrink-0 w-3.5 h-3.5 text-rose-300/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                  <span className="text-[12.5px] text-slate-200 truncate">{channelName}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveFromBlacklist?.(channelName)}
                  className="flex-shrink-0 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] rounded border border-emerald-700/60 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/40 hover:border-emerald-600 transition"
                  title="Unblock this channel"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default React.memo(BlacklistModal);
