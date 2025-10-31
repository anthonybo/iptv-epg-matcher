import React, { useState, useEffect } from 'react';

/**
 * CategoryManager component for managing channel categories
 */
const CategoryManager = ({
  categories = [],
  onCategorySelect,
  onVisibilityChange,
  hiddenCategories = [],
  selectedCategory,
  sessionId
}) => {
  const [categoryFilter, setCategoryFilter] = useState('');
  const [formattedCategories, setFormattedCategories] = useState([]);

  const extractCategoryInfo = (cat) => {
    if (!cat) return { name: 'Unknown', count: 0 };

    if (typeof cat === 'string') return { name: cat, count: 0 };

    if (typeof cat === 'object') {
      const possibleNameProps = ['name', 'category', 'title', 'groupTitle', 'group'];
      const name = possibleNameProps.map((prop) => cat[prop]).find((value) => typeof value === 'string')
        || (cat.toString && cat.toString() !== '[object Object]' ? cat.toString() : JSON.stringify(cat));

      const count = Number(cat.count ?? cat.channelCount ?? cat.total ?? cat.channels ?? 0);

      return { name, count: Number.isFinite(count) ? count : 0 };
    }

    return { name: String(cat), count: 0 };
  };

  useEffect(() => {
    if (!Array.isArray(categories)) {
      setFormattedCategories([]);
      return;
    }

    const processed = categories
      .map(extractCategoryInfo)
      .filter((cat) => cat?.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    setFormattedCategories(processed);
  }, [categories]);

  const toggleCategory = (category) => {
    const updatedHiddenCategories = hiddenCategories.includes(category)
      ? hiddenCategories.filter((c) => c !== category)
      : [...hiddenCategories, category];

    onVisibilityChange(updatedHiddenCategories);

    if (hiddenCategories.includes(category) && category === selectedCategory) {
      onCategorySelect(category);
    }
  };

  const handleCategorySelect = async (category) => {
    if (category === selectedCategory) {
      onCategorySelect(null);
      return;
    }

    if (hiddenCategories.includes(category)) {
      const updatedHidden = hiddenCategories.filter((c) => c !== category);
      onVisibilityChange(updatedHidden);
    }

    onCategorySelect(category);
  };

  const hideAllCategories = () => {
    const allCategoryNames = formattedCategories.map((cat) => cat.name);
    onVisibilityChange(allCategoryNames);
  };

  const showAllCategories = () => {
    onVisibilityChange([]);
    onCategorySelect(null);
  };

  const filteredCategories = categoryFilter
    ? formattedCategories.filter((cat) => cat.name?.toLowerCase().includes(categoryFilter.toLowerCase()))
    : formattedCategories;

  const hasSelected = hiddenCategories.length > 0;

  return (
    <section className="flex h-full flex-col rounded-3xl border border-slate-800/80 bg-slate-950/80">
      <header className="border-b border-slate-800/80 px-5 py-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-500">Categories</h3>
          {hasSelected && (
            <button
              type="button"
              onClick={showAllCategories}
              className="text-xs font-medium text-blue-300 transition hover:text-blue-100"
            >
              Clear ({hiddenCategories.length})
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className="rounded-full bg-slate-900/70 px-2 py-0.5">Total: {formattedCategories.length}</span>
          <span className="rounded-full bg-slate-900/70 px-2 py-0.5">
            Visible: {formattedCategories.length - hiddenCategories.length}
          </span>
        </div>

        <div className="relative mt-4">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </span>
          <input
            type="text"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            placeholder="Filter categories..."
            className="w-full rounded-xl border border-slate-800/80 bg-slate-900/70 py-2 pl-9 pr-10 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
          />
          {categoryFilter && (
            <button
              type="button"
              onClick={() => setCategoryFilter('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={hideAllCategories}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Hide All
          </button>
          <button
            type="button"
            onClick={showAllCategories}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Show All
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {formattedCategories.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-2xl border border-slate-800/70 bg-slate-900/70 text-sm text-slate-400">
            {Array.isArray(categories) && categories.length === 0
              ? 'No categories available yet.'
              : 'Loading categories...'}
          </div>
        ) : (
          <ul className="space-y-2">
            {filteredCategories.length > 0 ? (
              filteredCategories.map((cat) => {
                const isVisible = !hiddenCategories.includes(cat.name);
                const isActive = selectedCategory === cat.name;

                return (
                  <li key={cat.name} className="rounded-xl border border-slate-800/70 bg-slate-900/70">
                    <div className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 transition ${
                      isActive ? 'border border-blue-500/60 bg-blue-500/10 text-blue-100' : 'hover:border-blue-500/40'
                    }`}>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isVisible}
                          onChange={() => toggleCategory(cat.name)}
                          className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-blue-500/70"
                        />
                        <button
                          type="button"
                          onClick={() => handleCategorySelect(cat.name)}
                          className={`text-left text-sm font-medium ${
                            isActive ? 'text-blue-100' : 'text-slate-200'
                          }`}
                        >
                          {cat.name}
                        </button>
                      </div>
                      <span className="inline-flex min-w-[2.5rem] items-center justify-center rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
                        {cat.count}
                      </span>
                    </div>
                  </li>
                );
              })
            ) : (
              <li className="rounded-xl border border-slate-800/70 bg-slate-900/70 px-4 py-6 text-center text-sm text-slate-400">
                {categoryFilter ? 'No categories match your filter.' : 'No categories available.'}
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
};

export default CategoryManager;
