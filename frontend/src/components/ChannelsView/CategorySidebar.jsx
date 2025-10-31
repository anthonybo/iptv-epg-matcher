import React, { useState } from 'react';

/**
 * CategorySidebar - Left sidebar with category filters
 */
const CategorySidebar = ({ categories, selectedCategories, onToggle, onClearAll, loading }) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredCategories = searchTerm
    ? categories.filter(cat =>
        cat.name.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : categories;

  const hasSelected = selectedCategories.size > 0;

  return (
    <div className="flex h-full w-72 flex-col border-r border-slate-800/80 bg-slate-950/80 backdrop-blur">
      {/* Header */}
      <div className="border-b border-slate-800/80 px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-[0.35em] text-slate-300">
            Categories
          </h3>
          {hasSelected && (
            <button
              onClick={onClearAll}
              className="text-xs font-medium text-blue-400 transition-colors hover:text-blue-200"
            >
              Clear ({selectedCategories.size})
            </button>
          )}
        </div>

        {/* Category search */}
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            placeholder="Filter categories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full rounded-lg border border-slate-800/80 bg-slate-900/70 py-1.5 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          />
        </div>
      </div>

      {/* Category list */}
      <div className="flex-1 overflow-y-auto">
        {loading && categories.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-500"></div>
            <p className="mt-2 text-sm text-slate-500">Loading categories...</p>
          </div>
        ) : filteredCategories.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <svg className="mx-auto h-12 w-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="mt-2 text-sm text-slate-500">
              {searchTerm ? 'No matching categories' : 'No categories available'}
            </p>
          </div>
        ) : (
          <div className="py-2">
            {filteredCategories.map((category) => {
              const isSelected = selectedCategories.has(category.name);

              return (
                <button
                  key={category.name}
                  onClick={() => onToggle(category.name)}
                  className={`flex w-full items-center justify-between px-4 py-2.5 transition-colors ${
                    isSelected
                      ? 'rounded-lg bg-blue-500/15 text-blue-100 shadow-inner shadow-blue-500/10'
                      : 'hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center">
                    <div
                      className={`mr-3 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-2 transition-colors ${
                        isSelected
                          ? 'border-blue-400 bg-blue-500'
                          : 'border-slate-600 bg-slate-900'
                      }`}
                    >
                      {isSelected && (
                        <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <span
                      className={`truncate text-sm ${
                        isSelected ? 'font-medium text-blue-100' : 'text-slate-300'
                      }`}
                    >
                      {category.name}
                    </span>
                  </div>
                  {category.count > 0 && (
                    <span
                      className={`ml-2 flex-shrink-0 rounded-full px-2 py-0.5 text-xs ${
                        isSelected
                          ? 'bg-blue-500/30 text-blue-100'
                          : 'bg-slate-800/80 text-slate-400'
                      }`}
                    >
                      {category.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="border-t border-slate-800/80 bg-slate-900/70 px-4 py-3">
        <p className="text-xs text-slate-500">
          {categories.length} {categories.length === 1 ? 'category' : 'categories'} total
        </p>
      </div>
    </div>
  );
};

export default CategorySidebar;
