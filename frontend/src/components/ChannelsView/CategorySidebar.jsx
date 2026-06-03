import React, { useState } from 'react';

/**
 * CategorySidebar — left category rail.
 *
 * Broadcast-control-room treatment: cyan accents (was inconsistent
 * blue), mono tabular counts, a cyan left-bar + tint on the selected
 * category, glass header, refined hover. Props/behavior unchanged
 * (categories, selectedCategories, onToggle, onClearAll, loading).
 */
const MONO = '"JetBrains Mono", ui-monospace, monospace';

const CategorySidebar = ({ categories, selectedCategories, onToggle, onClearAll, loading }) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredCategories = searchTerm
    ? categories.filter((cat) => cat.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : categories;

  const hasSelected = selectedCategories.size > 0;

  const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

  return (
    <div className="flex h-full w-72 flex-col border-r border-slate-800/70 bg-slate-950/60">
      {/* Header */}
      <div className="border-b border-slate-800/70 px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h3
            className="text-[11px] font-bold uppercase tracking-[0.3em] text-slate-300"
            style={{ fontFamily: MONO }}
          >
            Categories
          </h3>
          {hasSelected && (
            <button
              onClick={onClearAll}
              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-300 transition-colors hover:text-cyan-200"
              style={{ fontFamily: MONO }}
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear {selectedCategories.size}
            </button>
          )}
        </div>

        {/* Category search */}
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            placeholder="Filter categories…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full rounded-lg border border-slate-800 bg-slate-900/60 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-cyan-500/60 focus:outline-none focus:ring-2 focus:ring-cyan-500/15"
          />
        </div>
      </div>

      {/* Category list */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {loading && categories.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400"></div>
            <p className="mt-3 text-xs text-slate-500" style={{ fontFamily: MONO }}>Loading…</p>
          </div>
        ) : filteredCategories.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <svg className="mx-auto h-10 w-10 text-slate-700" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="mt-3 text-sm text-slate-500">
              {searchTerm ? 'No matching categories' : 'No categories available'}
            </p>
          </div>
        ) : (
          <div className="space-y-px px-2">
            {filteredCategories.map((category) => {
              const isSelected = selectedCategories.has(category.name);
              return (
                <button
                  key={category.name}
                  onClick={() => onToggle(category.name)}
                  title={category.name}
                  className={`group/cat flex w-full items-center gap-2.5 rounded-lg border-l-2 py-2 pl-2.5 pr-2 text-left transition-colors ${
                    isSelected
                      ? 'border-l-cyan-400 bg-cyan-500/[0.10] text-cyan-50'
                      : 'border-l-transparent hover:border-l-cyan-500/30 hover:bg-slate-800/50'
                  }`}
                >
                  {/* Checkbox */}
                  <span
                    className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border transition ${
                      isSelected
                        ? 'border-cyan-400/60 bg-cyan-500 shadow-[0_0_8px_-2px_rgba(34,211,238,0.6)]'
                        : 'border-slate-700 bg-slate-900/50 group-hover/cat:border-slate-500'
                    }`}
                  >
                    {isSelected && (
                      <svg className="h-3 w-3 text-slate-950" fill="none" stroke="currentColor" strokeWidth={3.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>

                  {/* Name */}
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${isSelected ? 'font-medium' : 'text-slate-300 group-hover/cat:text-slate-100'}`}>
                    {category.name}
                  </span>

                  {/* Count — mono, tabular */}
                  {category.count > 0 && (
                    <span
                      className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
                        isSelected ? 'bg-cyan-500/20 text-cyan-200' : 'bg-slate-800/70 text-slate-500 group-hover/cat:text-slate-400'
                      }`}
                      style={{ fontFamily: MONO }}
                    >
                      {fmtCount(category.count)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="border-t border-slate-800/70 bg-slate-950/60 px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500" style={{ fontFamily: MONO }}>
          {categories.length} {categories.length === 1 ? 'category' : 'categories'}
          {hasSelected && <span className="text-cyan-400"> · {selectedCategories.size} active</span>}
        </p>
      </div>
    </div>
  );
};

export default CategorySidebar;
