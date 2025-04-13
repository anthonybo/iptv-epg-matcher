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
  const [formattedCategories, setFormattedCategories] = useState([]);
  
  // Try to extract a name and count from any category object format
  const extractCategoryInfo = (cat) => {
    if (!cat) return { name: 'Unknown', count: 0 };
    
    // If it's a string, use that as the name
    if (typeof cat === 'string') return { name: cat, count: 0 };
    
    // If it's an object, try to extract name and count
    if (typeof cat === 'object') {
      // Try various properties that might contain the category name
      const possibleNameProps = ['name', 'category', 'title', 'groupTitle', 'group'];
      let name = null;
      
      // Try each property until we find one that works
      for (const prop of possibleNameProps) {
        if (cat[prop] && typeof cat[prop] === 'string') {
          name = cat[prop];
          break;
        }
      }
      
      // If we still don't have a name, try toString() or stringify
      if (!name) {
        name = cat.toString && cat.toString() !== '[object Object]' 
               ? cat.toString() 
               : JSON.stringify(cat);
      }
      
      // Try to extract a count if available
      const count = typeof cat.count === 'number' ? cat.count : 
                   typeof cat.channelCount === 'number' ? cat.channelCount : 0;
                   
      return { name, count };
    }
    
    // Fallback for any other data type
    return { name: String(cat), count: 0 };
  };

  // Process categories when they change
  useEffect(() => {
    console.log('[CategoryManager] Received categories:', {
      count: categories?.length || 0,
      sample: categories?.slice(0, 3) || [],
      type: Array.isArray(categories) ? 'array' : typeof categories
    });

    // DEBUG: Log the first few categories to see their exact structure
    if (Array.isArray(categories) && categories.length > 0) {
      const firstFew = categories.slice(0, 5);
      console.log('[CategoryManager] First 5 category objects:', firstFew);
      
      // Check if these are just strings without name/count properties
      const needsFormatting = firstFew.some(cat => 
        typeof cat === 'string' || 
        (typeof cat === 'object' && cat !== null && (!cat.name || !cat.count))
      );
      
      console.log('[CategoryManager] Categories need formatting:', needsFormatting);
    }

    // Ensure we have an array and format categories to have name & count
    let processedCategories = [];
    if (Array.isArray(categories) && categories.length > 0) {
      processedCategories = categories.map(extractCategoryInfo);
      
      // Log the first few processed categories
      console.log('[CategoryManager] First 5 processed categories:', processedCategories.slice(0, 5));
      
      // Sort alphabetically
      processedCategories.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      
      console.log(`[CategoryManager] Processed ${processedCategories.length} categories`);
    } else {
      console.warn('[CategoryManager] Invalid categories format or empty:', categories);
    }
    
    setFormattedCategories(processedCategories);
  }, [categories]);
  
  // Handle category visibility toggle
  const toggleCategory = (category) => {
    // Get updated hidden categories list
    const updatedHiddenCategories = hiddenCategories.includes(category)
      ? hiddenCategories.filter(c => c !== category)
      : [...hiddenCategories, category];
    
    console.log(`[CategoryManager] Toggle category "${category}" - now ${hiddenCategories.includes(category) ? 'visible' : 'hidden'}`);
    
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
    console.log(`[CategoryManager] Selected category: "${category}"`);
    
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
    const allCategoryNames = formattedCategories.map(cat => cat.name);
    console.log(`[CategoryManager] Hiding all ${allCategoryNames.length} categories`);
    onVisibilityChange(allCategoryNames);
  };

  // Handle "Show All" button
  const showAllCategories = () => {
    console.log('[CategoryManager] Showing all categories');
    onVisibilityChange([]);
    onCategorySelect(null);
  };

  // Filter categories based on search term
  const filteredCategories = categoryFilter
    ? formattedCategories.filter(cat => 
        cat.name?.toLowerCase().includes(categoryFilter.toLowerCase())
      )
    : formattedCategories;

  console.log('[CategoryManager] Filtered categories count:', filteredCategories.length);
  
  // Debug condition for when categories are not showing
  if (categories.length > 0 && formattedCategories.length === 0) {
    console.error('[CRITICAL] Categories available but not processed:', {
      rawCount: categories.length,
      formattedCount: formattedCategories.length,
      filteredCount: filteredCategories.length,
      rawSample: categories.slice(0, 3)
    });
  }

  // EMERGENCY FALLBACK - create categories from any available data if formatted ones failed
  const displayCategories = filteredCategories.length > 0 
    ? filteredCategories 
    : (categories.length > 0 && formattedCategories.length === 0)
      ? categories.map(cat => {
          if (typeof cat === 'string') return { name: cat, count: 0 };
          if (typeof cat === 'object' && cat !== null) {
            return { 
              name: cat.name || cat.category || cat.title || cat.groupTitle || 
                    (typeof cat === 'string' ? cat : JSON.stringify(cat)), 
              count: cat.count || 0 
            };
          }
          return { name: String(cat || 'Unknown Category'), count: 0 };
        })
      : filteredCategories;

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
          Categories ({formattedCategories.length})
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
        {displayCategories.length > 0 ? (
          displayCategories.map(cat => (
            <div 
              key={cat.name || `category-${Math.random()}`} 
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
                  id={`category-${cat.name?.replace(/\s+/g, '-')?.toLowerCase() || `cat-${Math.random()}`}`}
                  checked={!hiddenCategories.includes(cat.name)}
                  onChange={() => toggleCategory(cat.name)}
                  style={{ 
                    marginRight: '8px',
                    accentColor: '#1a73e8'
                  }}
                />
                <label 
                  htmlFor={`category-${cat.name?.replace(/\s+/g, '-')?.toLowerCase() || `cat-${Math.random()}`}`}
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
            color: '#888',
            fontSize: '14px'
          }}>
            {categoryFilter 
              ? "No categories match your filter" 
              : categories.length > 0 
                ? "Processing categories..." 
                : "No categories available"}
            
            {/* Show diagnostic info if we have categories data but nothing to display */}
            {categories.length > 0 && formattedCategories.length === 0 && (
              <div style={{ 
                marginTop: '10px', 
                padding: '10px', 
                backgroundColor: '#fff0f0', 
                border: '1px solid #ffcdd2',
                borderRadius: '4px',
                fontSize: '12px',
                color: '#d32f2f',
                textAlign: 'left'
              }}>
                <p style={{ margin: '0 0 5px 0', fontWeight: 'bold' }}>Diagnostic Information:</p>
                <ul style={{ margin: '0', paddingLeft: '20px' }}>
                  <li>Raw categories: {categories.length}</li>
                  <li>Processed categories: {formattedCategories.length}</li>
                  <li>Category type: {Array.isArray(categories) ? 'Array' : typeof categories}</li>
                  <li>First item type: {categories.length > 0 ? typeof categories[0] : 'N/A'}</li>
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CategoryManager;