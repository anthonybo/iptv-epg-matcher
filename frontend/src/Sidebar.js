import React from 'react';

const menuItems = [
  {
    id: 'myiptvs',
    label: 'My IPTVs',
    countKey: 'userSourcesCount',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
  },
  {
    id: 'epg',
    label: 'EPG Sources',
    countKey: 'epgSourceCount',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 22h16" />
        <path d="M5 2v5h14V2" />
        <path d="M19 9H5l-2 5h18l-2-5Z" />
        <path d="M7 14v4" />
        <path d="M17 14v4" />
      </svg>
    ),
  },
  {
    id: 'channels',
    label: 'Channels',
    countKey: 'totalChannels',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'guide',
    label: 'Guide',
    countKey: 'matchedChannelCount',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M22 7h-4" />
        <path d="M22 12h-4" />
        <path d="M22 17h-4" />
        <path d="M6 7h6" />
        <path d="M6 12h6" />
        <path d="M6 17h6" />
      </svg>
    ),
  },
  {
    id: 'liveevents',
    label: 'Live Events',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
        <circle cx="12" cy="12" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'player',
    label: 'Player',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polygon points="10 8 16 12 10 16 10 8" />
      </svg>
    ),
  },
  {
    id: 'multiview',
    label: 'Multi-View',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v6h6" />
        <path d="M21 21v-6h-6" />
        <path d="M3 9a9 9 0 0 1 15-6.7" />
        <path d="M21 15a9 9 0 0 1-15 6.7" />
      </svg>
    ),
  },
  {
    id: 'editor',
    label: 'IPTV Editor',
    countKey: 'totalMatchesCount',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  },
  {
    id: 'publish',
    label: 'Credentials',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M7 15h0M2 9.5h20" />
      </svg>
    ),
  },
];

const TabButton = ({ id, label, icon, onClick, isActive, count }) => (
  <button
    type="button"
    onClick={() => onClick(id)}
    className={`group flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950 ${
      isActive ? 'bg-blue-500/20 text-blue-100' : 'text-slate-300 hover:bg-slate-800/80'
    }`}
  >
    <span className="flex items-center gap-2">
      <span className={`flex h-7 w-7 items-center justify-center rounded-lg border transition-colors duration-150 ${
        isActive ? 'border-blue-400 bg-blue-500/15 text-blue-100' : 'border-slate-800 bg-slate-900 text-slate-400 group-hover:text-slate-100'
      }`}
      >
        {icon}
      </span>
      <span className={`font-medium ${isActive ? 'text-blue-100' : 'text-slate-200'} group-hover:text-slate-100`}>
        {label}
      </span>
    </span>
    {typeof count === 'number' && count > 0 && (
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
        isActive ? 'bg-blue-500/30 text-blue-100' : 'bg-slate-800 text-slate-300'
      }`}
      >
        {count}
      </span>
    )}
  </button>
);

const Sidebar = ({
  showSidebar,
  activeTab,
  setActiveTab,
  handleReset,
  totalChannels = 0,
  categoryCount = 0,
  matchedChannelCount = 0,
  totalMatchesCount = 0,
  epgSourceCount = 0,
  userSourcesCount = 0,
}) => {
  const visibilityClass = showSidebar ? 'flex' : 'hidden';

  const counts = {
    totalChannels,
    matchedChannelCount,
    totalMatchesCount,
    epgSourceCount,
    userSourcesCount,
  };

  return (
    <aside className={`${visibilityClass} sticky top-0 h-screen w-72 flex-col border-r border-slate-800/80 bg-slate-950/80 text-slate-200 backdrop-blur`}>
      <div className="border-b border-slate-800/70 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/20 text-blue-300">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
          </span>
          <h2 className="text-sm font-semibold text-slate-100">IPTV Guru</h2>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-4 py-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500">Navigation</p>
        <div className="flex flex-col gap-1.5">
          {menuItems.map((item) => (
            <TabButton
              key={item.id}
              id={item.id}
              label={item.label}
              icon={item.icon}
              onClick={setActiveTab}
              isActive={activeTab === item.id}
              count={item.countKey ? counts[item.countKey] : undefined}
            />
          ))}
        </div>
      </nav>

      {totalChannels > 0 && (
        <div className="space-y-3 border-t border-slate-800/70 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500">Statistics</p>
          <dl className="space-y-1.5 text-xs text-slate-300">
            <div className="flex justify-between">
              <dt>Total Channels</dt>
              <dd className="font-semibold text-slate-100">{totalChannels}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Categories</dt>
              <dd className="font-semibold text-slate-100">{categoryCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt>EPG Matches</dt>
              <dd className="font-semibold text-slate-100">{matchedChannelCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt>EPG Sources</dt>
              <dd className="font-semibold text-slate-100">{epgSourceCount}</dd>
            </div>
          </dl>

          <button
            type="button"
            onClick={handleReset}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 2v6h6" />
              <path d="M2.66 15.57a10 10 0 1 0 .57-8.38" />
            </svg>
            Reset
          </button>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
