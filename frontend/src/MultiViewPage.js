import React, { useState, useEffect, useCallback, useMemo } from 'react';
import ConfirmModal from './components/ConfirmModal';
import { showToast } from './components/Toast';
import { useAppContext } from './contexts/AppContext';
import { addToMultiview, calculateLayout } from './utils/multiviewManager';

// Import extracted components
import {
  MultiViewGrid,
  SettingsModal,
  BlacklistModal,
  TrendingModal,
  AllGamesModal,
  BroadcasterCoverageModal,
  ChannelPickerModal,
  MultiViewRail,
  MultiViewTopBar,
  FavoritesPanel,
  LayoutPanel,
  CommandPalette
} from './components/MultiView';
import LiveScoresTicker from './components/LiveScoresTicker';

// Behavior hooks that own self-contained slices of this page. Keeps the
// component focused on rendering + wiring.
import { useBlacklist } from './hooks/multiview/useBlacklist';
import { useAutoFill } from './hooks/multiview/useAutoFill';
import { useFindAlternative } from './hooks/multiview/useFindAlternative';
import { useMultiViewStreams } from './hooks/multiview/useMultiViewStreams';
import { useStreamFinder } from './hooks/multiview/useStreamFinder';
import { useStreamSearch } from './hooks/multiview/useStreamSearch';
import { useChannelPicker } from './hooks/multiview/useChannelPicker';
import { useFavorites } from './hooks/multiview/useFavorites';
import { useCommandPalette } from './hooks/multiview/useCommandPalette';

/**
 * MultiViewPage — Patchbay-layout multi-stream viewer.
 *
 *   ┌──┬──────────────────────────────────────────────┐
 *   │  │ PRESETS [05] · favorites strip      [⌘K]    │
 *   │R ├──────────────────────────────────────────────┤
 *   │A │                                              │
 *   │I │  ┌────────┐  ┌────────┐                      │
 *   │L │  │ TILE 1 │  │ TILE 2 │                      │
 *   │  │  └────────┘  └────────┘                      │
 *   │  │                                              │
 *   └──┴──────────────────────────────────────────────┘
 *
 * The left rail holds page-scoped controls grouped by verb (Find /
 * Discover / Saved / View). Panels (favorites, layout) slide in from
 * the rail's right edge over the tile area. ⌘K and "/" open the
 * command palette as a power-user accelerator. Per-tile controls
 * live in a hover OSD inside each StreamCell.
 */
const MultiViewPage = ({ sessionId }) => {
  const { isTheatreMode, setIsTheatreMode } = useAppContext();
  const [layout, setLayout] = useState({ columns: 1, rows: 1 });

  // ─── Persistent local state (layout mode, autofill prefs) ──────────
  const [autoFillSettings, setAutoFillSettings] = useState(() => {
    const saved = localStorage.getItem('multiview_autofill_settings');
    const defaults = {
      maxSlots: 4,
      avoidDuplicateSources: true,
      avoidDuplicateEvents: true,
      minQuality: 0,
      showLiveScoresTicker: false,
      playerType: 'mpegts-player'
    };
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { ...defaults, ...parsed };
      } catch { return defaults; }
    }
    return defaults;
  });
  const [layoutMode, setLayoutMode] = useState(() => {
    const saved = localStorage.getItem('multiview_layout_mode');
    return saved || 'grid';
  });

  // ─── Modal visibility (rail icons open these) ──────────────────────
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showTrendingModal, setShowTrendingModal] = useState(false);
  const [showAllGamesModal, setShowAllGamesModal] = useState(false);
  const [showBroadcasterCoverageModal, setShowBroadcasterCoverageModal] = useState(false);

  // ─── Slide-in panel state (only one open at a time) ────────────────
  const [activePanel, setActivePanel] = useState(null); // 'favorites' | 'layout' | null

  // ─── Drag/drop state for tile reordering ───────────────────────────
  const [activeId, setActiveId] = useState(null);
  const [streamOrder, setStreamOrder] = useState({});

  // ─── Hooks ─────────────────────────────────────────────────────────
  const {
    blacklistedChannels,
    showBlacklistModal,
    setShowBlacklistModal,
    addToBlacklist,
    removeFromBlacklist
  } = useBlacklist();

  const {
    streams,
    setStreams,
    mutedStreams,
    streamVolumes,
    setStreamVolume,
    streamQualities,
    setStreamQualities,
    loadingStreams,
    showClearConfirm,
    setShowClearConfirm,
    toggleMute,
    refreshStream,
    removeStream,
    clearAll,
    onQualityDetected
  } = useMultiViewStreams();

  const {
    searchingStream,
    searchStatus,
    setSearchingStream,
    setShowSportDropdown,
    searchingNews,
    cancelSearch,
    findLocalNews,
    findRandomSportsChannel,
    findRandomAnyChannel,
    handleTickerEventClick
  } = useStreamFinder({ streams, autoFillSettings, setShowSettingsModal });

  const {
    showSearchInput,
    setShowSearchInput,
    searchQuery,
    setSearchQuery,
    isSearching,
    searchByName
  } = useStreamSearch({ streams, autoFillSettings });

  const { autoFillProgress, handleAutoFill } = useAutoFill({
    streams,
    autoFillSettings,
    setSearchingStream,
    setShowSportDropdown
  });

  const {
    findingAlternativeFor,
    handleFindAlternative,
    handleFindDifferentGame
  } = useFindAlternative({
    streams,
    setStreams,
    setStreamQualities,
    mutedStreams,
    autoFillSettings
  });

  const {
    pickerState,
    openForQuery: openPickerForQuery,
    openForStream: openPickerForStream,
    openEmpty: openPickerEmptyHook
  } = useChannelPicker({
    streams,
    setStreams,
    setStreamQualities,
    mutedStreams
  });

  const {
    favorites,
    loading: favoritesLoading,
    isFavorite,
    toggleFavorite,
    removeFavorite,
    reorder: reorderFavorites,
    bumpPlayed
  } = useFavorites();

  const palette = useCommandPalette();

  // ─── Effects ───────────────────────────────────────────────────────
  useEffect(() => { setLayout(calculateLayout(streams.length)); }, [streams.length]);
  useEffect(() => {
    localStorage.setItem('multiview_autofill_settings', JSON.stringify(autoFillSettings));
  }, [autoFillSettings]);
  useEffect(() => {
    localStorage.setItem('multiview_layout_mode', layoutMode);
  }, [layoutMode]);
  // Close panels when theatre mode flips on — they'd be invisible anyway.
  useEffect(() => { if (isTheatreMode) setActivePanel(null); }, [isTheatreMode]);

  // ─── Wired handlers ────────────────────────────────────────────────

  // Favorite a currently-playing tile.
  const handleToggleTileFavorite = useCallback(async (stream) => {
    const wasFavorited = isFavorite(stream.sourceId, stream.id);
    const result = await toggleFavorite(stream);
    if (!result.ok) {
      const verb = wasFavorited ? 'remove from favorites' : 'save to favorites';
      showToast(`Failed to ${verb}: ${result.error || 'unknown error'}`, 'error');
      return;
    }
    showToast(
      wasFavorited
        ? `Removed "${stream.name}" from favorites`
        : `Saved "${stream.name}" to favorites`,
      'success'
    );
  }, [isFavorite, toggleFavorite]);

  // Play a favorite chip — fast-path: if already on screen, surface a
  // toast (no duplicate tiles); otherwise addToMultiview and bump
  // played-count for future "recent" sort.
  const handlePlayFavorite = useCallback(async (fav) => {
    const alreadyOnScreen = streams.some(
      (s) => s.id === fav.channelId && s.sourceId === fav.sourceId
    );
    if (alreadyOnScreen) {
      showToast(`"${fav.name}" is already on screen`, 'info');
      return false;
    }
    const channel = {
      id: fav.channelId,
      sourceId: fav.sourceId,
      name: fav.name,
      logo: fav.logo,
      url: fav.url,
      sourceType: fav.sourceType,
      sourceUrl: fav.sourceUrl,
      sourceUsername: fav.sourceUsername,
      sourcePassword: fav.sourcePassword,
      sourceMac: fav.sourceMac,
      sourceName: fav.sourceName,
      searchQuery: fav.name
    };
    const ok = await addToMultiview(channel);
    if (ok) {
      window.dispatchEvent(new Event('multiviewUpdate'));
      bumpPlayed(fav.id);
      showToast(`Added "${fav.name}" to Multi-View`, 'success');
      return true;
    }
    showToast(`Failed to add "${fav.name}"`, 'error');
    return false;
  }, [streams, bumpPlayed]);

  // Header search submit — open the picker so generic queries surface
  // every match rather than auto-adding whichever ffprobe-validates
  // first.
  const handleSearchSubmit = useCallback((e) => {
    e?.preventDefault?.();
    const q = String(searchQuery || '').trim();
    if (q.length < 2) return;
    openPickerForQuery(q);
    setSearchQuery('');
    setShowSearchInput(false);
  }, [searchQuery, openPickerForQuery, setSearchQuery, setShowSearchInput]);

  // Drag-and-drop tile reordering (preserved from previous design).
  const handleDragStart = useCallback((event) => { setActiveId(event.active.id); }, []);
  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    setActiveId(null);
    if (over && active.id !== over.id) {
      setStreamOrder((currentOrder) => {
        const streamKeys = streams.map((s) => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`);
        const getOrder = (key) => currentOrder[key] ?? streamKeys.indexOf(key);
        const activeOrder = getOrder(active.id);
        const overOrder = getOrder(over.id);
        const newOrder = {};
        streamKeys.forEach((key) => {
          const currentKeyOrder = getOrder(key);
          if (key === active.id) newOrder[key] = overOrder;
          else if (activeOrder < overOrder)
            newOrder[key] = (currentKeyOrder > activeOrder && currentKeyOrder <= overOrder)
              ? currentKeyOrder - 1 : currentKeyOrder;
          else
            newOrder[key] = (currentKeyOrder >= overOrder && currentKeyOrder < activeOrder)
              ? currentKeyOrder + 1 : currentKeyOrder;
        });
        return newOrder;
      });
    }
  }, [streams]);

  // Panel toggle — clicking the same icon twice closes it.
  const togglePanel = useCallback((id) => {
    setActivePanel((cur) => (cur === id ? null : id));
  }, []);

  const setTheatreMode = useCallback((v) => {
    setIsTheatreMode(typeof v === 'function' ? v(isTheatreMode) : v);
  }, [isTheatreMode, setIsTheatreMode]);

  // Tickering toggle — modifies autoFillSettings (persisted).
  const toggleTicker = useCallback(() => {
    setAutoFillSettings((s) => ({ ...s, showLiveScoresTicker: !s.showLiveScoresTicker }));
  }, []);

  // Search activator from the rail — open the inline TopBar input.
  const openSearch = useCallback(() => setShowSearchInput(true), [setShowSearchInput]);

  // "Open picker" rail icon — opens the modal with no query so the
  // user lands on the Favorites tab (or an empty Results tab if no
  // favorites yet). The filter input is ready for typing if they want
  // to search instead.
  const openPickerEmpty = openPickerEmptyHook;

  // ─── Command palette commands ──────────────────────────────────────
  const commands = useMemo(() => [
    // FIND
    { id: 'search',     group: 'Find',     label: 'Search channel',          hint: 'Open the search input',  kbd: '/',    accent: 'cyan',    icon: <CmdIcon name="search" />,   run: openSearch },
    { id: 'autofill',   group: 'Find',     label: 'AutoFill tiles',          hint: 'Fill empty slots with live sports', accent: 'emerald', icon: <CmdIcon name="bolt" />, run: () => handleAutoFill(null, null) },
    { id: 'random-sport', group: 'Find',   label: 'Random sports channel',   hint: 'One random live sports stream', accent: 'emerald', icon: <CmdIcon name="ball" />, run: findRandomSportsChannel },
    { id: 'random-any', group: 'Find',     label: 'Random any channel',      hint: 'Truly random — anything in your sources', accent: 'violet', icon: <CmdIcon name="grid" />, run: findRandomAnyChannel },
    { id: 'picker',     group: 'Find',     label: 'Open channel picker',     hint: 'Browse your favorites + library', accent: 'cyan', icon: <CmdIcon name="grid" />, run: openPickerEmpty },
    // DISCOVER
    { id: 'trending',   group: 'Discover', label: 'Trending channels',       hint: 'YT / Twitch / Reddit / Bluesky composite', accent: 'rose', icon: <CmdIcon name="flame" />, run: () => setShowTrendingModal(true) },
    { id: 'allgames',   group: 'Discover', label: 'All games today',         hint: 'Live, scheduled, and final',  accent: 'emerald', icon: <CmdIcon name="ball" />, run: () => setShowAllGamesModal(true) },
    { id: 'coverage',   group: 'Discover', label: 'Broadcaster coverage',    hint: 'Alias gaps and discovery report', accent: 'cyan', icon: <CmdIcon name="broadcast" />, run: () => setShowBroadcasterCoverageModal(true) },
    { id: 'news',       group: 'Discover', label: 'Find local news',         hint: 'Random local news station',   accent: 'amber',   icon: <CmdIcon name="news" />, disabled: searchingNews, run: findLocalNews },
    // SAVED
    { id: 'favorites',  group: 'Saved',    label: 'Open favorites',          hint: 'Slide-in panel for management', accent: 'amber', icon: <CmdIcon name="heart" />, run: () => togglePanel('favorites') },
    { id: 'blacklist',  group: 'Saved',    label: 'Manage blacklist',        hint: 'Channels excluded from random fill', accent: 'amber', icon: <CmdIcon name="ban" />, run: () => setShowBlacklistModal(true) },
    { id: 'settings',   group: 'Saved',    label: 'Multi-view settings',     hint: 'Player type, max slots, duplicate rules', accent: 'cyan', icon: <CmdIcon name="gear" />, run: () => setShowSettingsModal(true) },
    // VIEW
    { id: 'layout',     group: 'View',     label: 'Change layout',           hint: 'Grid / featured / dual / theatre', accent: 'cyan', icon: <CmdIcon name="layout" />, run: () => togglePanel('layout') },
    { id: 'theatre',    group: 'View',     label: isTheatreMode ? 'Exit theatre mode' : 'Enter theatre mode', hint: 'Hide all chrome', accent: 'amber', icon: <CmdIcon name="theatre" />, disabled: streams.length === 0, run: () => setTheatreMode((v) => !v) },
    { id: 'ticker',     group: 'View',     label: autoFillSettings.showLiveScoresTicker ? 'Hide live scores ticker' : 'Show live scores ticker', hint: 'Bottom-edge running ticker', accent: 'emerald', icon: <CmdIcon name="ticker" />, run: toggleTicker },
    { id: 'clear',      group: 'View',     label: 'Clear all streams',       hint: 'Remove every tile', accent: 'rose', icon: <CmdIcon name="trash" />, disabled: streams.length === 0, run: () => setShowClearConfirm(true) }
  ], [
    openSearch, handleAutoFill, openPickerEmpty, searchingNews, findLocalNews,
    findRandomSportsChannel, findRandomAnyChannel,
    togglePanel, isTheatreMode, streams.length, autoFillSettings.showLiveScoresTicker,
    toggleTicker, setShowClearConfirm, setShowBlacklistModal, setShowSettingsModal,
    setShowAllGamesModal, setShowBroadcasterCoverageModal, setShowTrendingModal, setTheatreMode
  ]);

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden">
      {/* Left rail — page-scoped controls. Hidden in theatre mode for
          true distraction-free viewing. */}
      {!isTheatreMode && (
        <MultiViewRail
          onSearch={openSearch}
          onAutoFill={() => handleAutoFill(null, null)}
          onOpenPicker={openPickerEmpty}
          onOpenTrending={() => setShowTrendingModal(true)}
          onOpenAllGames={() => setShowAllGamesModal(true)}
          onOpenCoverage={() => setShowBroadcasterCoverageModal(true)}
          onLocalNews={findLocalNews}
          onOpenBlacklist={() => setShowBlacklistModal(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onOpenClearConfirm={() => setShowClearConfirm(true)}
          onOpenPalette={palette.open}
          activePanel={activePanel}
          onTogglePanel={togglePanel}
          isTheatreMode={isTheatreMode}
          onToggleTheatre={() => setTheatreMode((v) => !v)}
          hasStreams={streams.length > 0}
          blacklistCount={blacklistedChannels.length}
          favoritesCount={favorites.length}
          searchingNews={searchingNews}
          autoFillProgress={autoFillProgress}
          isSearching={isSearching}
        />
      )}

      {/* Main content column — top bar above, grid below, slide-in
          panels overlay on top. `relative` is what anchors the panel
          positioning. */}
      <div className="relative flex-1 flex flex-col min-w-0">
        {!isTheatreMode && (
          <MultiViewTopBar
            favorites={favorites}
            streams={streams}
            streamOrder={streamOrder}
            onPlayFavorite={handlePlayFavorite}
            onRemoveFavorite={removeFavorite}
            showSearchInput={showSearchInput}
            setShowSearchInput={setShowSearchInput}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            isSearching={isSearching}
            onSearchChannel={handleSearchSubmit}
            autoFillProgress={autoFillProgress}
            searchingStream={searchingStream}
            searchStatus={searchStatus}
            onCancelSearch={cancelSearch}
            onOpenPalette={palette.open}
          />
        )}

        {/* Tile grid */}
        <div className={`flex-1 ${isTheatreMode ? 'p-0 overflow-hidden' : 'p-3 overflow-auto'}`}>
          <MultiViewGrid
            streams={streams}
            streamOrder={streamOrder}
            sessionId={sessionId}
            isTheatreMode={isTheatreMode}
            layout={layout}
            layoutMode={layoutMode}
            mutedStreams={mutedStreams}
            streamVolumes={streamVolumes}
            streamQualities={streamQualities}
            findingAlternativeFor={findingAlternativeFor}
            activeId={activeId}
            loadingStreams={loadingStreams}
            playerType={autoFillSettings.playerType}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onToggleMute={toggleMute}
            onVolumeChange={setStreamVolume}
            onRefresh={refreshStream}
            onFindAlternative={handleFindAlternative}
            onFindDifferentGame={handleFindDifferentGame}
            onAlternateSources={openPickerForStream}
            onBlacklist={addToBlacklist}
            onRemove={removeStream}
            isFavorited={isFavorite}
            onToggleFavorite={handleToggleTileFavorite}
            onQualityDetected={onQualityDetected}
          />
        </div>

        {/* Slide-in panels — positioned absolute against this column so
            they overlay the tiles but not the rail. */}
        {!isTheatreMode && (
          <>
            <FavoritesPanel
              isOpen={activePanel === 'favorites'}
              onClose={() => setActivePanel(null)}
              favorites={favorites}
              streams={streams}
              onPlay={handlePlayFavorite}
              onRemove={removeFavorite}
              onReorder={reorderFavorites}
            />
            <LayoutPanel
              isOpen={activePanel === 'layout'}
              onClose={() => setActivePanel(null)}
              layoutMode={layoutMode}
              onLayoutChange={setLayoutMode}
              showTicker={autoFillSettings.showLiveScoresTicker}
              onToggleTicker={toggleTicker}
              isTheatreMode={isTheatreMode}
              onToggleTheatre={() => setTheatreMode((v) => !v)}
              streamsCount={streams.length}
            />
          </>
        )}
      </div>

      {/* Exit theatre — only visible while in theatre mode. */}
      {isTheatreMode && (
        <button
          onClick={() => setTheatreMode(false)}
          className="fixed top-4 right-4 z-50 flex items-center justify-center w-10 h-10 rounded-lg border border-slate-700 bg-slate-900/90 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 shadow-2xl"
          title="Exit theatre mode"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* ─── Global modals (still mounted, just opened by rail/palette) ─── */}
      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={clearAll}
        title="Clear All Streams"
        message={`Are you sure you want to remove all ${streams.length} stream${streams.length !== 1 ? 's' : ''} from Multi-View?`}
        confirmText="Clear All"
        cancelText="Cancel"
        variant="danger"
      />
      <BlacklistModal
        isOpen={showBlacklistModal}
        onClose={() => setShowBlacklistModal(false)}
        blacklistedChannels={blacklistedChannels}
        onRemoveFromBlacklist={removeFromBlacklist}
      />
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        streams={streams}
        autoFillSettings={autoFillSettings}
        setAutoFillSettings={setAutoFillSettings}
      />
      <TrendingModal
        isOpen={showTrendingModal}
        onClose={() => setShowTrendingModal(false)}
        onPick={(channel, signal) =>
          searchByName(channel.name, { mode: 'brand', signal })
        }
      />
      <BroadcasterCoverageModal
        isOpen={showBroadcasterCoverageModal}
        onClose={() => setShowBroadcasterCoverageModal(false)}
        onTestCode={(code, signal, aliases) =>
          searchByName(code, { mode: 'brand', signal, aliases })
        }
      />
      <AllGamesModal
        isOpen={showAllGamesModal}
        onClose={() => setShowAllGamesModal(false)}
        onPick={async (event, signal) => {
          await handleTickerEventClick(event, { signal });
          return true;
        }}
        onPickBroadcaster={(code, signal) => searchByName(code, { mode: 'brand', signal })}
      />

      <ChannelPickerModal
        {...pickerState}
        favorites={favorites}
        favoritesLoading={favoritesLoading}
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
      />

      <CommandPalette
        isOpen={palette.isOpen}
        onClose={palette.close}
        commands={commands}
      />

      {/* Live scores ticker (bottom edge, position: bottom) */}
      {autoFillSettings.showLiveScoresTicker && (
        <LiveScoresTicker
          position="bottom"
          updateInterval={60000}
          onEventClick={handleTickerEventClick}
        />
      )}
    </div>
  );
};

// Tiny inline-icon helper for the command palette rows so the
// palette stays a single self-contained component without growing a
// giant icon dictionary at module level.
const CmdIcon = ({ name }) => {
  const cls = 'w-4 h-4';
  switch (name) {
    case 'search':    return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>);
    case 'bolt':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" /></svg>);
    case 'grid':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></svg>);
    case 'flame':     return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3c1 4 5 5 5 9a5 5 0 11-10 0c0-2 1-3 2-4-1 4 3 4 3 0 0-2 0-3 0-5z" /></svg>);
    case 'ball':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18M5.5 5.5l13 13M18.5 5.5l-13 13" /></svg>);
    case 'broadcast': return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M4.93 19.07a10 10 0 010-14.14M19.07 4.93a10 10 0 010 14.14M8.46 16.46a5 5 0 010-7.07M15.54 9.39a5 5 0 010 7.07" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg>);
    case 'news':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" /></svg>);
    case 'heart':     return (<svg viewBox="0 0 24 24" fill="currentColor" className={cls}><path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" /></svg>);
    case 'ban':       return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M5.6 5.6l12.8 12.8" /></svg>);
    case 'gear':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>);
    case 'layout':    return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>);
    case 'theatre':   return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>);
    case 'ticker':    return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><rect x="2" y="9" width="20" height="6" rx="1.5" /><path d="M2 12h20" /></svg>);
    case 'trash':     return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>);
    default: return null;
  }
};

export default MultiViewPage;
