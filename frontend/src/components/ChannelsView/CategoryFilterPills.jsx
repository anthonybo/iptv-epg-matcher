import React from 'react';

/**
 * CategoryFilterPills - Displays categories as clickable filter pills
 * @param {Array} categories - Array of category objects {name, count}
 * @param {Set} selectedCategories - Set of selected category names
 * @param {Function} onToggle - Callback when a category is toggled
 * @param {Function} onClearAll - Callback to clear all selections
 */
const CategoryFilterPills = ({
  categories,
  selectedCategories,
  onToggle,
  onClearAll
}) => {
  if (!categories || categories.length === 0) {
    return (
      <div className="text-gray-500 text-sm italic py-4">
        No categories available
      </div>
    );
  }

  const hasSelectedCategories = selectedCategories.size > 0;

  return (
    <div className="space-y-3">
      {/* Header with clear button */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-800">
          Categories
          {hasSelectedCategories && (
            <span className="ml-2 text-sm font-normal text-gray-600">
              ({selectedCategories.size} selected)
            </span>
          )}
        </h3>
        {hasSelectedCategories && (
          <button
            onClick={onClearAll}
            className="text-sm text-blue-600 hover:text-blue-800 hover:underline transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Pills container with scrolling */}
      <div className="max-h-96 overflow-y-auto">
        <div className="flex flex-wrap gap-2">
          {categories.map((category) => {
            const isSelected = selectedCategories.has(category.name);

            return (
              <button
                key={category.name}
                onClick={() => onToggle(category.name)}
                className={`
                  inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium
                  transition-all duration-200 ease-in-out
                  ${isSelected
                    ? 'bg-blue-600 text-white shadow-md hover:bg-blue-700 hover:shadow-lg'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 hover:shadow-sm'
                  }
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                `}
              >
                {isSelected && (
                  <svg
                    className="w-4 h-4 mr-1"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
                <span>{category.name}</span>
                {category.count > 0 && (
                  <span className={`
                    ml-1.5 text-xs
                    ${isSelected ? 'text-blue-200' : 'text-gray-500'}
                  `}>
                    ({category.count})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-gray-500 italic">
        Click categories to filter channels. Multiple selections show channels from any selected category.
      </p>
    </div>
  );
};

export default CategoryFilterPills;
