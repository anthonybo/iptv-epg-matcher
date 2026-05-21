import React, { useEffect, useState } from 'react';
import VodBrowse from './VodBrowse';
import VodDetail from './VodDetail';

/**
 * VodPage — owns the list-vs-detail navigation for the Movies and
 * Series tabs. App.js mounts <VodPage kind="movie" /> or kind="series"
 * based on the sidebar selection; internal navigation between the
 * library grid and a single-item detail page is handled here so the
 * sidebar isn't aware of it.
 */
const VodPage = ({ kind }) => {
  const [openItem, setOpenItem] = useState(null);

  // Reset the scroll container when the user switches between Movies
  // and TV Series (or opens/closes a detail page). AppLayout's <main>
  // is the scrollable element — window.scrollTo wouldn't do anything
  // because <body> itself doesn't scroll. Defer to rAF so the reset
  // lands AFTER React commits the new child tree (otherwise the
  // browser can re-apply scroll restoration once the new content
  // grows the document height).
  useEffect(() => {
    let raf1 = 0, raf2 = 0;
    const scroll = () => {
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
      window.scrollTo(0, 0);
    };
    scroll();
    raf1 = requestAnimationFrame(() => {
      scroll();
      raf2 = requestAnimationFrame(scroll);
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [kind, openItem]);

  if (openItem) {
    return (
      <VodDetail
        kind={kind}
        id={openItem.id}
        onBack={() => setOpenItem(null)}
      />
    );
  }
  return <VodBrowse kind={kind} onOpen={setOpenItem} />;
};

export default VodPage;
