import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * CommandPalette — Spotlight-style overlay. Centered horizontally,
 * top offset 20% so the eye lands on it naturally without obscuring
 * the tile grid. Each rail icon (and a few additional power actions)
 * surfaces here as a command.
 *
 * Keyboard:
 *   ↑/↓        — move selection
 *   Enter      — run the highlighted command
 *   Esc        — close
 *   Type       — fuzzy-match command labels + hints
 *
 * Commands shape:
 *   {
 *     id:     string,
 *     label:  string,
 *     hint?:  string,   // appears under the label
 *     group?: string,   // category — used for sectioning the list
 *     kbd?:   string,   // optional keyboard shortcut chip on the right
 *     icon?:  ReactNode,
 *     accent?: 'cyan'|'amber'|'rose'|'emerald'|'violet',
 *     run:    () => void,
 *     disabled?: boolean
 *   }
 */
const CommandPalette = ({ isOpen, onClose, commands = [] }) => {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Reset on open. Auto-focus the input so the user can start typing.
  useEffect(() => {
    if (!isOpen) return undefined;
    setQuery('');
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Filter + group. A command "matches" when every space-separated
  // term appears as a substring in label OR hint OR group. Cheap and
  // predictable — power users get a Linear-grade palette without us
  // hauling in fuse.js.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.filter((c) => !c.hidden);
    const terms = q.split(/\s+/);
    return commands
      .filter((c) => !c.hidden)
      .filter((c) => {
        const hay = `${c.label} ${c.hint || ''} ${c.group || ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
  }, [query, commands]);

  // Clamp selection when filter changes.
  useEffect(() => {
    if (activeIdx >= visible.length) setActiveIdx(0);
  }, [visible, activeIdx]);

  // Key handling — capture before the input/dialog handle. Esc on the
  // input clears query first, then closes (Spotlight-style).
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (query) {
          setQuery('');
        } else {
          onClose?.();
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, Math.max(0, visible.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = visible[activeIdx];
        if (cmd && !cmd.disabled) {
          cmd.run?.();
          onClose?.();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, query, visible, activeIdx, onClose]);

  // Scroll the active row into view (smooth, blockless).
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-row-idx="${activeIdx}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIdx, isOpen]);

  if (!isOpen) return null;

  // Section breaks — only when the previous row has a different
  // .group, so the list renders as a natural taxonomy.
  let lastGroup = null;
  const rows = [];
  visible.forEach((cmd, idx) => {
    if (cmd.group && cmd.group !== lastGroup) {
      rows.push(
        <li key={`sep-${cmd.group}`} className="px-3 pt-2 pb-1 text-[9px] font-mono uppercase tracking-[0.22em] text-slate-600 select-none">
          {cmd.group}
        </li>
      );
      lastGroup = cmd.group;
    } else if (!cmd.group) {
      lastGroup = null;
    }
    rows.push(
      <Row
        key={cmd.id}
        cmd={cmd}
        active={idx === activeIdx}
        onHover={() => setActiveIdx(idx)}
        onClick={() => {
          if (cmd.disabled) return;
          cmd.run?.();
          onClose?.();
        }}
        dataIdx={idx}
      />
    );
  });

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center px-4 pt-[16vh] backdrop-blur-md bg-slate-950/70"
      onClick={onClose}
      role="dialog"
      aria-label="Command palette"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at center top, rgba(15,23,42,0.5), rgba(2,6,23,0.85) 70%)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[520px] rounded-xl border border-slate-700/80 bg-slate-900/95 shadow-[0_30px_80px_-15px_rgba(0,0,0,0.7)] overflow-hidden mv-anim-palette-in"
      >
        {/* Cyan rail at the top — matches the rail's hairline motif. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />

        {/* Input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-800/80">
          <svg className="w-4 h-4 text-cyan-300/80 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-[14px] text-slate-100 placeholder-slate-500 focus:outline-none"
          />
          <kbd className="font-mono text-[10px] text-slate-500 bg-slate-950/80 px-1.5 py-0.5 rounded border border-slate-800 tracking-tight">
            Esc
          </kbd>
        </div>

        {/* List */}
        <ul
          ref={listRef}
          className="max-h-[55vh] overflow-y-auto py-1 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]"
        >
          {rows.length === 0 ? (
            <li className="px-4 py-8 text-center text-[12px] text-slate-500">
              No commands match
              <div className="font-mono text-cyan-300/80 mt-1">"{query}"</div>
            </li>
          ) : rows}
        </ul>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500 font-mono">
          <span className="flex items-center gap-2">
            <kbd className="px-1 py-px rounded bg-slate-950 border border-slate-800 normal-case tracking-normal">↑↓</kbd>
            <span>navigate</span>
          </span>
          <span className="flex items-center gap-2">
            <kbd className="px-1 py-px rounded bg-slate-950 border border-slate-800 normal-case tracking-normal">↵</kbd>
            <span>run</span>
          </span>
          <span className="flex items-center gap-2">
            <kbd className="px-1 py-px rounded bg-slate-950 border border-slate-800 normal-case tracking-normal">/</kbd>
            <span>reopen</span>
          </span>
        </div>
      </div>
    </div>
  );
};

const Row = ({ cmd, active, onHover, onClick, dataIdx }) => {
  const accent = cmd.accent || 'cyan';
  const accentText = {
    cyan:    active ? 'text-cyan-200'    : 'text-slate-400 group-hover/cmd:text-cyan-200',
    amber:   active ? 'text-amber-200'   : 'text-slate-400 group-hover/cmd:text-amber-200',
    rose:    active ? 'text-rose-200'    : 'text-slate-400 group-hover/cmd:text-rose-200',
    emerald: active ? 'text-emerald-200' : 'text-slate-400 group-hover/cmd:text-emerald-200',
    violet:  active ? 'text-violet-200'  : 'text-slate-400 group-hover/cmd:text-violet-200'
  }[accent];

  const railColor = {
    cyan:    'bg-cyan-400',
    amber:   'bg-amber-300',
    rose:    'bg-rose-300',
    emerald: 'bg-emerald-300',
    violet:  'bg-violet-300'
  }[accent];

  return (
    <li
      data-row-idx={dataIdx}
      onMouseMove={onHover}
      onClick={onClick}
      aria-disabled={cmd.disabled || undefined}
      className={`group/cmd relative cursor-pointer flex items-center gap-3 mx-2 my-px px-2.5 py-2 rounded-md transition ${
        cmd.disabled
          ? 'opacity-40 cursor-not-allowed'
          : active
          ? 'bg-slate-800/80'
          : 'hover:bg-slate-800/50'
      }`}
    >
      {active && !cmd.disabled && (
        <span aria-hidden className={`absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full ${railColor} shadow-[0_0_6px_rgba(251,191,36,0.4)]`} />
      )}
      <span className={`flex-shrink-0 w-5 h-5 inline-flex items-center justify-center ${accentText}`}>
        {cmd.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-slate-100 truncate">{cmd.label}</div>
        {cmd.hint && (
          <div className="text-[10px] text-slate-500 truncate">{cmd.hint}</div>
        )}
      </div>
      {cmd.kbd && (
        <kbd className="flex-shrink-0 font-mono text-[10px] text-slate-500 bg-slate-950/80 px-1.5 py-0.5 rounded border border-slate-800 tracking-tight">
          {cmd.kbd}
        </kbd>
      )}
    </li>
  );
};

export default CommandPalette;
