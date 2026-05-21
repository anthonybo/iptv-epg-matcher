import React, { useState } from 'react';
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
