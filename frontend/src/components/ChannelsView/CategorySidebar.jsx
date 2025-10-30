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
    <div className="w-72 bg-white border-r border-gray-200 flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
            Categories
          </h3>
          {hasSelected && (
            <button
              onClick={onClearAll}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              Clear ({selectedCategories.size})
            </button>
          )}
        </div>

        {/* Category search */}
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            placeholder="Filter categories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full pl-9 pr-3 py-1.5 text-sm border border-gray-300 rounded-md placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Category list */}
      <div className="flex-1 overflow-y-auto">
        {loading && categories.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <p className="text-sm text-gray-500 mt-2">Loading categories...</p>
          </div>
        ) : filteredCategories.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-gray-500 mt-2">
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
                  className={`w-full px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors ${
                    isSelected ? 'bg-blue-50' : ''
                  }`}
                >
                  <div className="flex items-center min-w-0 flex-1">
                    <div
                      className={`flex-shrink-0 w-4 h-4 rounded border-2 mr-3 flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'bg-blue-600 border-blue-600'
                          : 'border-gray-300 bg-white'
                      }`}
                    >
                      {isSelected && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <span
                      className={`text-sm truncate ${
                        isSelected ? 'font-medium text-blue-900' : 'text-gray-700'
                      }`}
                    >
                      {category.name}
                    </span>
                  </div>
                  {category.count > 0 && (
                    <span
                      className={`ml-2 px-2 py-0.5 text-xs rounded-full flex-shrink-0 ${
                        isSelected
                          ? 'bg-blue-200 text-blue-800'
                          : 'bg-gray-200 text-gray-600'
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
      <div className="px-4 py-3 border-t border-gray-200 bg-gray-50">
        <p className="text-xs text-gray-600">
          {categories.length} {categories.length === 1 ? 'category' : 'categories'} total
        </p>
      </div>
    </div>
  );
};

export default CategorySidebar;
