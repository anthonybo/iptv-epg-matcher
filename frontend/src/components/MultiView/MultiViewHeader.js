import React from 'react';
import ReactDOM from 'react-dom';
import { LAYOUT_MODES } from './layoutModes';

const MultiViewHeader = ({
  streams,
  layout,
  // Search state
  showSearchInput,
  setShowSearchInput,
  searchQuery,
  setSearchQuery,
  isSearching,
  onSearchChannel,
  // Random stream state
  showSportDropdown,
  searchingStream,
  autoFillProgress,
  liveSports,
  loadingSports,
  onRandomStreamClick,
  onCancelSearch,
  onAutoFill,
  onSportSelect,
  onRandomSportsChannel,
  onRandomAnyChannel,
  // Settings
  autoFillSettings,
  onShowSettings,
  // Local News
  onFindLocalNews,
  searchingNews,
  // Layout
  layoutMode,
  showLayoutMenu,
  setShowLayoutMenu,
  onLayoutChange,
  layoutButtonRef,
  // Blacklist
  blacklistedChannels,
  onShowBlacklist,
  // Theatre mode
  onTheatreMode,
  // Clear
  onShowClearConfirm
}) => {
  return (
    <div className="flex-shrink-0 border-b border-slate-800 bg-slate-900/80 px-4 py-2 relative z-[9999]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-100">Multi-View</h1>
          <p className="text-xs text-slate-400 truncate">
            {streams.length === 0
              ? 'Add streams using the + button on any player'
              : `${streams.length} stream${streams.length !== 1 ? 's' : ''} · ${layout.columns}×${layout.rows} grid`
            }
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Quick Search */}
          <SearchInput
            showSearchInput={showSearchInput}
            setShowSearchInput={setShowSearchInput}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            isSearching={isSearching}
            searchingStream={searchingStream}
            onSearchChannel={onSearchChannel}
          />

          {/* Auto-fill progress indicator */}
          {autoFillProgress && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-700 text-emerald-300 text-xs">
              <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>{autoFillProgress.status}</span>
            </div>
          )}

          {/* Random Stream Dropdown */}
          <RandomStreamDropdown
            showSportDropdown={showSportDropdown}
            searchingStream={searchingStream}
            autoFillProgress={autoFillProgress}
            liveSports={liveSports}
            loadingSports={loadingSports}
            streams={streams}
            autoFillSettings={autoFillSettings}
            onRandomStreamClick={onRandomStreamClick}
            onCancelSearch={onCancelSearch}
            onAutoFill={onAutoFill}
            onSportSelect={onSportSelect}
            onRandomSportsChannel={onRandomSportsChannel}
            onRandomAnyChannel={onRandomAnyChannel}
          />

          {/* Settings Button */}
          <button
            onClick={onShowSettings}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700/50 hover:border-slate-500"
            title="Multi-View Settings"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-slate-400">{autoFillSettings.maxSlots}</span>
          </button>

          {/* Local News Button */}
          <button
            onClick={onFindLocalNews}
            disabled={searchingNews}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              searchingNews
                ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
                : 'border-amber-700 bg-amber-900/20 text-amber-300 hover:bg-amber-900/40'
            }`}
            title="Find Local News"
          >
            {searchingNews ? (
              <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
              </svg>
            )}
            News
          </button>

          {/* Layout Mode Button */}
          <LayoutModeButton
            layoutMode={layoutMode}
            showLayoutMenu={showLayoutMenu}
            setShowLayoutMenu={setShowLayoutMenu}
            onLayoutChange={onLayoutChange}
            layoutButtonRef={layoutButtonRef}
          />

          {/* Blacklist Button */}
          <button
            onClick={onShowBlacklist}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              blacklistedChannels.length > 0
                ? 'border-yellow-700 bg-yellow-900/20 text-yellow-300 hover:bg-yellow-900/40'
                : 'border-slate-700 bg-slate-900/20 text-slate-400 hover:bg-slate-900/40'
            }`}
            title="Manage Blacklisted Channels"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
            Blacklist {blacklistedChannels.length > 0 && `(${blacklistedChannels.length})`}
          </button>

          {streams.length > 0 && (
            <>
              <button
                onClick={onTheatreMode}
                className="inline-flex items-center gap-1.5 rounded-lg border border-purple-700 bg-purple-900/20 px-3 py-1.5 text-xs font-semibold text-purple-300 transition hover:bg-purple-900/40"
                title="Theatre Mode"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
                Theatre
              </button>
              <button
                onClick={onShowClearConfirm}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-700 bg-red-900/20 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-900/40"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Clear
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// Search Input Sub-component
const SearchInput = ({
  showSearchInput,
  setShowSearchInput,
  searchQuery,
  setSearchQuery,
  isSearching,
  searchingStream,
  onSearchChannel
}) => {
  return (
    <div className="flex items-center gap-2">
      {showSearchInput ? (
        <form onSubmit={onSearchChannel} className="flex items-center gap-2">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search channel..."
              autoFocus
              disabled={isSearching}
              className="w-48 px-3 py-1.5 pl-8 text-xs rounded-lg border border-indigo-600 bg-slate-800/80 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
            />
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <button
            type="submit"
            disabled={isSearching || !searchQuery.trim()}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition ${
              isSearching
                ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
                : 'border-indigo-600 bg-indigo-900/40 text-indigo-300 hover:bg-indigo-900/60'
            }`}
          >
            {isSearching ? (
              <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              'Find'
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowSearchInput(false);
              setSearchQuery('');
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-600 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-slate-300 transition"
            title="Close search"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </form>
      ) : (
        <button
          onClick={() => setShowSearchInput(true)}
          disabled={searchingStream || isSearching}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition ${
            searchingStream || isSearching
              ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
              : 'border-indigo-600 bg-indigo-900/20 text-indigo-300 hover:bg-indigo-900/40'
          }`}
          title="Search for a channel"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      )}
    </div>
  );
};

// Random Stream Dropdown Sub-component
const RandomStreamDropdown = ({
  showSportDropdown,
  searchingStream,
  autoFillProgress,
  liveSports,
  loadingSports,
  streams,
  autoFillSettings,
  onRandomStreamClick,
  onCancelSearch,
  onAutoFill,
  onSportSelect,
  onRandomSportsChannel,
  onRandomAnyChannel
}) => {
  return (
    <div className="flex items-center gap-2 random-stream-dropdown">
      {/* Main Random Button */}
      <button
        onClick={onRandomStreamClick}
        disabled={searchingStream}
        className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition ${
          searchingStream
            ? 'border-slate-600 bg-slate-800/50 text-slate-500 cursor-not-allowed'
            : showSportDropdown
            ? 'border-emerald-600 bg-emerald-900/40 text-emerald-300'
            : 'border-emerald-700 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/40'
        }`}
        title="Add Random Live Stream"
      >
        {searchingStream && !autoFillProgress ? (
          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        )}
      </button>

      {/* Cancel Search Button */}
      {searchingStream && (
        <button
          onClick={onCancelSearch}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-700 bg-red-900/20 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-900/40"
          title="Cancel Search"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Cancel
        </button>
      )}

      {/* Expanded Sport Icons */}
      {showSportDropdown && !loadingSports && (
        <>
          {/* Auto-fill (Any Sport) Button */}
          <button
            onClick={() => onAutoFill(null, null)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-500 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60 transition text-xs font-semibold"
            title={`Auto-fill up to ${autoFillSettings.maxSlots} slots with any live sport`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Fill {autoFillSettings.maxSlots - streams.length > 0 ? autoFillSettings.maxSlots - streams.length : 0}
          </button>

          {/* Single stream button */}
          <button
            onClick={() => onSportSelect(null, null)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-emerald-600 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/50 transition"
            title="Add 1 Random Sport Stream"
          >
            <span className="text-xs font-bold">+1</span>
          </button>

          {/* Random Sports Channel (General) Icon */}
          <button
            onClick={onRandomSportsChannel}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-orange-600 bg-orange-900/30 text-orange-300 hover:bg-orange-900/50 transition"
            title="Random Sports Channel (any)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>

          {/* Random Any Channel Icon - Truly random from all channels */}
          <button
            onClick={onRandomAnyChannel}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-violet-600 bg-violet-900/30 text-violet-300 hover:bg-violet-900/50 transition"
            title="Random Any Channel (truly random)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          </button>

          {/* Divider */}
          {liveSports.length > 0 && (
            <div className="w-px h-6 bg-slate-600"></div>
          )}

          {/* Sport Icons with auto-fill on click */}
          {liveSports.map((sport, index) => (
            <button
              key={index}
              onClick={() => onAutoFill(sport.sport_type, sport.league_name)}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-blue-600 bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 transition font-bold text-xs"
              title={`Auto-fill ${sport.league_name} (${sport.event_count} live games)`}
            >
              {sport.league_name}
              <span className="text-blue-400/70 font-normal">({sport.event_count})</span>
            </button>
          ))}
        </>
      )}

      {/* Loading Indicator */}
      {showSportDropdown && loadingSports && (
        <div className="flex items-center px-2">
          <svg className="animate-spin h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
      )}
    </div>
  );
};

// Layout Mode Button Sub-component
const LayoutModeButton = ({
  layoutMode,
  showLayoutMenu,
  setShowLayoutMenu,
  onLayoutChange,
  layoutButtonRef
}) => {
  return (
    <div className="relative layout-menu-dropdown">
      <button
        ref={layoutButtonRef}
        onClick={() => setShowLayoutMenu(!showLayoutMenu)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-700 bg-cyan-900/20 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-900/40"
        title="Change Layout"
      >
        {LAYOUT_MODES[layoutMode]?.icon}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Layout Mode Dropdown - Rendered via Portal to avoid z-index issues */}
      {showLayoutMenu && layoutButtonRef.current && ReactDOM.createPortal(
        <div
          className="layout-menu-portal fixed w-56 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
          style={{
            top: layoutButtonRef.current.getBoundingClientRect().bottom + 8,
            right: window.innerWidth - layoutButtonRef.current.getBoundingClientRect().right,
            zIndex: 99999
          }}
        >
          <div className="p-2">
            <p className="text-xs text-slate-500 font-medium px-2 py-1 mb-1">Layout Mode</p>
            {Object.values(LAYOUT_MODES).map((mode) => (
              <button
                key={mode.id}
                onClick={() => {
                  onLayoutChange(mode.id);
                  setShowLayoutMenu(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition ${
                  layoutMode === mode.id
                    ? 'bg-cyan-900/40 text-cyan-300'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <span className={layoutMode === mode.id ? 'text-cyan-400' : 'text-slate-500'}>
                  {mode.icon}
                </span>
                <div>
                  <div className="text-sm font-medium">{mode.name}</div>
                  <div className="text-xs text-slate-500">{mode.description}</div>
                </div>
                {layoutMode === mode.id && (
                  <svg className="w-4 h-4 ml-auto text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default MultiViewHeader;
