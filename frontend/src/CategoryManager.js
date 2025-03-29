import React, { useState, useEffect } from 'react';
import axios from 'axios';

/**
 * CategoryManager component for managing channel categories
 * 
 * @param {Object} props Component properties
 * @param {Array} props.categories List of categories with name and count
 * @param {Function} props.onCategorySelect Callback when category is selected
 * @param {Function} props.onVisibilityChange Callback when category visibility changes
 * @param {Array} props.hiddenCategories List of category names that are hidden
 * @param {string} props.selectedCategory Currently selected category name
 * @param {string} props.sessionId Current session ID
 * @returns {JSX.Element} Category management UI
 */
const CategoryManager = ({ 
  categories = [],
  onCategorySelect,
  onVisibilityChange,
  hiddenCategories = [],
  selectedCategory,
  sessionId
}) => {
  // Local state for category filter
  const [categoryFilter, setCategoryFilter] = useState('');
  
  // Handle category visibility toggle
  const toggleCategory = (category) => {
    // Get updated hidden categories list
    const updatedHiddenCategories = hiddenCategories.includes(category)
      ? hiddenCategories.filter(c => c !== category)
      : [...hiddenCategories, category];
    
    // Call the parent callback with updated list
    onVisibilityChange(updatedHiddenCategories);
    
    // If we're showing a previously hidden category, make it visible but don't automatically select it
    // This avoids causing tab switches or other unexpected navigations
    if (hiddenCategories.includes(category) && category === selectedCategory) {
      // If this was both hidden and selected, make sure it stays selected and visible
      onCategorySelect(category);
    }
  };

  // Handle selecting a category to view
  const handleCategorySelect = async (category) => {
    // If this category is hidden, make it visible first
    if (hiddenCategories.includes(category)) {
      const updatedHiddenCategories = hiddenCategories.filter(c => c !== category);
      onVisibilityChange(updatedHiddenCategories);
    }
    
    // Call the parent callback
    onCategorySelect(category);
  };

  // Handle "Hide All" button
  const unselectAllCategories = () => {
    const allCategoryNames = categories.map(cat => cat.name);
    console.log('Hiding all categories:', allCategoryNames);
    onVisibilityChange(allCategoryNames);
  };

  // Handle "Show All" button
  const showAllCategories = () => {
    console.log('Showing all categories');
    onVisibilityChange([]);
    onCategorySelect(null);
  };

  // Filter categories based on search term
  const filteredCategories = categoryFilter
    ? categories.filter(cat => 
        cat.name.toLowerCase().includes(categoryFilter.toLowerCase())
      )
    : categories;

  return (
    <div>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '10px'
      }}>
        <h3 style={{ 
          margin: 0, 
          fontSize: '16px', 
          color: '#444',
          fontWeight: '500'
        }}>
          Categories
        </h3>
        
        <div style={{ display: 'flex', gap: '5px' }}>
          <button 
            onClick={unselectAllCategories} 
            style={{ 
              padding: '4px 8px', 
              fontSize: '12px',
              background: 'transparent',
              border: '1px solid #ddd',
              borderRadius: '4px',
              cursor: 'pointer',
              color: '#666'
            }}
          >
            Hide All
          </button>
          <button 
            onClick={showAllCategories} 
            style={{ 
              padding: '4px 8px', 
              fontSize: '12px',
              background: 'transparent',
              border: '1px solid #ddd',
              borderRadius: '4px',
              cursor: 'pointer',
              color: '#666'
            }}
          >
            Show All
          </button>
        </div>
      </div>
      
      {/* Category filter input */}
      <div style={{ marginBottom: '10px', position: 'relative' }}>
        <svg 
          style={{ 
            position: 'absolute', 
            left: '8px', 
            top: '50%', 
            transform: 'translateY(-50%)',
            color: '#666' 
          }} 
          xmlns="http://www.w3.org/2000/svg" 
          width="14" 
          height="14" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2" 
          strokeLinecap="round" 
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="text"
          placeholder="Filter categories..."
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{ 
            width: '100%',
            padding: '8px 10px 8px 30px',
            borderRadius: '6px',
            border: '1px solid #ddd',
            fontSize: '13px'
          }}
        />
        {categoryFilter && (
          <button
            onClick={() => setCategoryFilter('')}
            style={{
              position: 'absolute',
              right: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '2px',
              color: '#999'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        )}
      </div>
      
      <div style={{ 
        maxHeight: 'calc(100vh - 240px)', 
        overflowY: 'auto', 
        border: '1px solid #eee', 
        borderRadius: '8px',
        padding: '5px',
        backgroundColor: 'white'
      }}>
        {filteredCategories.length > 0 ? (
          filteredCategories.map(cat => (
            <div 
              key={cat.name} 
              style={{ 
                margin: '2px 0',
                borderRadius: '4px',
                overflow: 'hidden'
              }}
            >
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                backgroundColor: selectedCategory === cat.name ? '#f0f7ff' : 'transparent',
                padding: '8px 10px',
                borderRadius: '4px',
                transition: 'background-color 0.2s ease'
              }}>
                <input
                  type="checkbox"
                  id={`category-${cat.name}`}
                  checked={!hiddenCategories.includes(cat.name)}
                  onChange={() => toggleCategory(cat.name)}
                  style={{ 
                    marginRight: '8px',
                    accentColor: '#1a73e8'
                  }}
                />
                <label 
                  htmlFor={`category-${cat.name}`}
                  onClick={() => handleCategorySelect(cat.name)} 
                  style={{ 
                    cursor: 'pointer', 
                    flex: 1,
                    fontSize: '14px',
                    color: selectedCategory === cat.name ? '#1a73e8' : '#444',
                    fontWeight: selectedCategory === cat.name ? '500' : 'normal',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}
                >
                  <span style={{ 
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}>
                    {cat.name}
                  </span>
                  <span style={{ 
                    backgroundColor: '#f1f1f1',
                    borderRadius: '30px',
                    padding: '2px 8px',
                    fontSize: '12px',
                    color: '#666',
                    minWidth: '30px',
                    textAlign: 'center'
                  }}>
                    {cat.count}
                  </span>
                </label>
              </div>
            </div>
          ))
        ) : (
          <div style={{
            padding: '20px',
            textAlign: 'center',
            color: '#666'
          }}>
            No categories match your filter
          </div>
        )}
      </div>
    </div>
  );
};

export default CategoryManager;