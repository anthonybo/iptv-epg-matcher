import React from 'react';

export const LAYOUT_MODES = {
  grid: {
    id: 'grid',
    name: 'Grid',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
    description: 'Equal sized grid'
  },
  featured_bottom: {
    id: 'featured_bottom',
    name: 'Featured + Bottom',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="20" height="14" rx="1" strokeWidth="2"/>
        <rect x="2" y="18" width="6" height="4" rx="0.5" strokeWidth="1.5"/>
        <rect x="9" y="18" width="6" height="4" rx="0.5" strokeWidth="1.5"/>
        <rect x="16" y="18" width="6" height="4" rx="0.5" strokeWidth="1.5"/>
      </svg>
    ),
    description: 'One large, rest at bottom'
  },
  featured_right: {
    id: 'featured_right',
    name: 'Featured + Right',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="14" height="20" rx="1" strokeWidth="2"/>
        <rect x="18" y="2" width="4" height="6" rx="0.5" strokeWidth="1.5"/>
        <rect x="18" y="9" width="4" height="6" rx="0.5" strokeWidth="1.5"/>
        <rect x="18" y="16" width="4" height="6" rx="0.5" strokeWidth="1.5"/>
      </svg>
    ),
    description: 'One large, rest on right'
  },
  dual_bottom: {
    id: 'dual_bottom',
    name: 'Dual + Bottom',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="9.5" height="14" rx="1" strokeWidth="2"/>
        <rect x="12.5" y="2" width="9.5" height="14" rx="1" strokeWidth="2"/>
        <rect x="2" y="18" width="6" height="4" rx="0.5" strokeWidth="1.5"/>
        <rect x="9" y="18" width="6" height="4" rx="0.5" strokeWidth="1.5"/>
        <rect x="16" y="18" width="6" height="4" rx="0.5" strokeWidth="1.5"/>
      </svg>
    ),
    description: 'Two large, rest at bottom'
  },
  dual_right: {
    id: 'dual_right',
    name: 'Dual + Right',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="14" height="9.5" rx="1" strokeWidth="2"/>
        <rect x="2" y="12.5" width="14" height="9.5" rx="1" strokeWidth="2"/>
        <rect x="18" y="2" width="4" height="6" rx="0.5" strokeWidth="1.5"/>
        <rect x="18" y="9" width="4" height="6" rx="0.5" strokeWidth="1.5"/>
        <rect x="18" y="16" width="4" height="6" rx="0.5" strokeWidth="1.5"/>
      </svg>
    ),
    description: 'Two large stacked, rest on right'
  },
  portrait: {
    id: 'portrait',
    name: 'Portrait stack',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="6" y="2" width="12" height="6" rx="1" strokeWidth="2"/>
        <rect x="6" y="9" width="12" height="6" rx="1" strokeWidth="2"/>
        <rect x="6" y="16" width="12" height="6" rx="1" strokeWidth="2"/>
      </svg>
    ),
    description: 'Vertical column — pairs with the chatter feed'
  }
};

export const getGridContainerStyle = (layoutMode, isTheatreMode, streamCount, layout) => {
  const gap = isTheatreMode ? '0px' : '12px';
  const secondarySize = isTheatreMode ? '120px' : '128px';
  const sidebarSize = isTheatreMode ? '200px' : '192px';

  switch (layoutMode) {
    case 'grid':
      return {
        display: 'grid',
        gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
        gap
      };
    case 'featured_bottom':
      if (streamCount <= 1) {
        return { display: 'grid', gridTemplateRows: '1fr', gap };
      }
      return {
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(streamCount - 1, 5)}, 1fr)`,
        gridTemplateRows: `1fr ${secondarySize}`,
        gap
      };
    case 'featured_right':
      if (streamCount <= 1) {
        return { display: 'grid', gridTemplateColumns: '1fr', gap };
      }
      return {
        display: 'grid',
        gridTemplateColumns: `1fr ${sidebarSize}`,
        gridTemplateRows: `repeat(${Math.min(streamCount - 1, 5)}, 1fr)`,
        gap
      };
    case 'dual_bottom':
      if (streamCount <= 2) {
        return {
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(streamCount, 2)}, 1fr)`,
          gap
        };
      }
      return {
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(2, Math.min(streamCount - 2, 5))}, 1fr)`,
        gridTemplateRows: `1fr 1fr ${secondarySize}`,
        gap
      };
    case 'portrait':
      // Single vertical column. Few streams fill the height; many overflow
      // into a scroll (the tile-grid wrapper is overflow-auto).
      return {
        display: 'grid',
        gridTemplateColumns: '1fr',
        gridAutoRows: streamCount <= 3 ? '1fr' : 'minmax(210px, 1fr)',
        gap
      };
    case 'dual_right': {
      if (streamCount <= 2) {
        return {
          display: 'grid',
          gridTemplateColumns: '1fr',
          gridTemplateRows: `repeat(${Math.min(streamCount, 2)}, 1fr)`,
          gap
        };
      }
      const sidebarCount = streamCount - 2;
      const rowCount = Math.max(2, sidebarCount);
      return {
        display: 'grid',
        gridTemplateColumns: `1fr ${sidebarSize}`,
        gridTemplateRows: `repeat(${rowCount}, 1fr)`,
        gap
      };
    }
    default:
      return {
        display: 'grid',
        gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
        gap
      };
  }
};

export const getStreamGridPosition = (layoutMode, visualOrder, streamCount) => {
  let gridColumn = undefined;
  let gridRow = undefined;

  if (layoutMode === 'featured_bottom') {
    if (visualOrder === 0 && streamCount > 1) {
      gridColumn = '1 / -1';
      gridRow = '1';
    } else if (visualOrder > 0) {
      gridRow = '2';
    }
  } else if (layoutMode === 'featured_right') {
    if (visualOrder === 0 && streamCount > 1) {
      gridColumn = '1';
      gridRow = '1 / -1';
    } else if (visualOrder > 0) {
      gridColumn = '2';
    }
  } else if (layoutMode === 'dual_bottom') {
    if (visualOrder < 2 && streamCount > 2) {
      const cols = Math.max(2, Math.min(streamCount - 2, 5));
      const halfCols = Math.ceil(cols / 2);
      gridColumn = visualOrder === 0 ? `1 / ${halfCols + 1}` : `${halfCols + 1} / -1`;
      gridRow = '1 / 3';
    } else if (visualOrder >= 2) {
      gridRow = '3';
    }
  } else if (layoutMode === 'dual_right') {
    const sidebarCount = streamCount - 2;
    const rowCount = Math.max(2, sidebarCount);

    if (visualOrder < 2 && streamCount > 2) {
      gridColumn = '1';
      const halfRows = Math.ceil(rowCount / 2);
      if (visualOrder === 0) {
        gridRow = `1 / ${halfRows + 1}`;
      } else {
        gridRow = `${halfRows + 1} / -1`;
      }
    } else if (visualOrder >= 2) {
      gridColumn = '2';
      const sidebarIndex = visualOrder - 2;
      gridRow = String(sidebarIndex + 1);
    }
  }

  return { gridColumn, gridRow };
};
