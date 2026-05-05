import React, { useState, useEffect, useCallback, useRef } from 'react';
import ConfirmModal from './components/ConfirmModal';
import { useAppContext } from './contexts/AppContext';
import { calculateLayout } from './utils/multiviewManager';

// Import extracted components
import {
  MultiViewHeader,
  MultiViewGrid,
  SettingsModal,
  BlacklistModal,
  TrendingModal,
  AllGamesModal,
  BroadcasterCoverageModal
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

/**
 * MultiViewPage - Display multiple streams in an auto-layout grid
 * Streams persist in localStorage and can be added from any player
 */
const MultiViewPage = ({ sessionId }) => {
  const { isTheatreMode, setIsTheatreMode } = useAppContext();
  const [layout, setLayout] = useState({ columns: 1, rows: 1 });

  // ---------------------------------------------------------------------------
  // Settings + layout + misc local state (things that aren't owned by a hook).
  // ---------------------------------------------------------------------------
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showTrendingModal, setShowTrendingModal] = useState(false);
  const [showAllGamesModal, setShowAllGamesModal] = useState(false);
  const [showBroadcasterCoverageModal, setShowBroadcasterCoverageModal] = useState(false);
  const [autoFillSettings, setAutoFillSettings] = useState(() => {
    const saved = localStorage.getItem('multiview_autofill_settings');
    const defaults = {
      maxSlots: 4,
      avoidDuplicateSources: true,
      avoidDuplicateEvents: true,
      minQuality: 0,
      showLiveScoresTicker: false,
      // Default to mpegts.js (raw TS) — matches the historical behaviour.
      // 'hls-stream' switches to the ffmpeg-remuxed HLS pipeline +
      // hls.js (better recovery, iOS-native playback).
      playerType: 'mpegts-player'
    };
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaults, ...parsed };
    }
    return defaults;
  });

  const [layoutMode, setLayoutMode] = useState(() => {
    const saved = localStorage.getItem('multiview_layout_mode');
    return saved || 'grid';
  });
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const layoutButtonRef = useRef(null);
  const [streamOrder, setStreamOrder] = useState({});

  // ---------------------------------------------------------------------------
  // Hook wiring. Each hook owns one cohesive slice of behaviour so this
  // component can stay focused on composition + rendering.
  // ---------------------------------------------------------------------------

  // Blacklist: loading on mount + add/remove wrappers.
  const {
    blacklistedChannels,
    loadingBlacklist,
    showBlacklistModal,
    setShowBlacklistModal,
    addToBlacklist,
    removeFromBlacklist
  } = useBlacklist();

  // Streams state + per-slot mute/quality + stream operations
  // (refresh, remove, clear all, quality-detected callback).
  const {
    streams,
    setStreams,
    mutedStreams,
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

  // Header "find me a stream" actions: sport dropdown, random/news/any
  // buttons, sport selection, ticker click.
  const {
    searchingStream,
    setSearchingStream,
    showSportDropdown,
    setShowSportDropdown,
    liveSports,
    loadingSports,
    searchingNews,
    openSportDropdown,
    cancelSearch,
    findRandomSportsChannel,
    findLocalNews,
    findRandomAnyChannel,
    selectSport,
    handleTickerEventClick
  } = useStreamFinder({ streams, autoFillSettings, setShowSettingsModal });

  // Header search input (type-to-add-channel).
  const {
    showSearchInput,
    setShowSearchInput,
    searchQuery,
    setSearchQuery,
    isSearching,
    handleSearchChannel,
    searchByName
  } = useStreamSearch({ streams, autoFillSettings });

  // Auto-fill: NDJSON streaming handler + progress state.
  const { autoFillProgress, handleAutoFill } = useAutoFill({
    streams,
    autoFillSettings,
    setSearchingStream,
    setShowSportDropdown
  });

  // Find alternative / find different game: per-slot search concurrency
  // Set, exhausted-queries cache, auto-find rate limiter.
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


  // Update layout when streams change
  useEffect(() => {
    const newLayout = calculateLayout(streams.length);
    setLayout(newLayout);
  }, [streams.length]);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('multiview_autofill_settings', JSON.stringify(autoFillSettings));
  }, [autoFillSettings]);

  // Save layout mode to localStorage
  useEffect(() => {
    localStorage.setItem('multiview_layout_mode', layoutMode);
  }, [layoutMode]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showSportDropdown && !e.target.closest('.random-stream-dropdown')) {
        setShowSportDropdown(false);
      }
      if (showLayoutMenu &&
          !e.target.closest('.layout-menu-dropdown') &&
          !e.target.closest('.layout-menu-portal')) {
        setShowLayoutMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSportDropdown, showLayoutMenu]);

  // Drag and drop handlers
  const handleDragStart = useCallback((event) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      setStreamOrder(currentOrder => {
        const streamKeys = streams.map(s => `${s.sourceId}_${s.id}_${s._refreshKey || ''}`);
        const getOrder = (key) => currentOrder[key] ?? streamKeys.indexOf(key);
        const activeOrder = getOrder(active.id);
        const overOrder = getOrder(over.id);

        const newOrder = {};
        streamKeys.forEach(key => {
          const currentKeyOrder = getOrder(key);
          if (key === active.id) {
            newOrder[key] = overOrder;
          } else if (activeOrder < overOrder) {
            if (currentKeyOrder > activeOrder && currentKeyOrder <= overOrder) {
              newOrder[key] = currentKeyOrder - 1;
            } else {
              newOrder[key] = currentKeyOrder;
            }
          } else {
            if (currentKeyOrder >= overOrder && currentKeyOrder < activeOrder) {
              newOrder[key] = currentKeyOrder + 1;
            } else {
              newOrder[key] = currentKeyOrder;
            }
          }
        });

        return newOrder;
      });
    }
  }, [streams]);

  return (
    <div className="flex flex-col h-screen bg-slate-950">
      {/* Header */}
      {!isTheatreMode && (
        <MultiViewHeader
          streams={streams}
          layout={layout}
          showSearchInput={showSearchInput}
          setShowSearchInput={setShowSearchInput}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          isSearching={isSearching}
          onSearchChannel={handleSearchChannel}
          showSportDropdown={showSportDropdown}
          searchingStream={searchingStream}
          autoFillProgress={autoFillProgress}
          liveSports={liveSports}
          loadingSports={loadingSports}
          onRandomStreamClick={openSportDropdown}
          onCancelSearch={cancelSearch}
          onAutoFill={handleAutoFill}
          onSportSelect={selectSport}
          onRandomSportsChannel={findRandomSportsChannel}
          onRandomAnyChannel={findRandomAnyChannel}
          autoFillSettings={autoFillSettings}
          onShowSettings={() => setShowSettingsModal(true)}
          onShowTrending={() => setShowTrendingModal(true)}
          onShowAllGames={() => setShowAllGamesModal(true)}
          onShowBroadcasterCoverage={() => setShowBroadcasterCoverageModal(true)}
          onFindLocalNews={findLocalNews}
          searchingNews={searchingNews}
          layoutMode={layoutMode}
          showLayoutMenu={showLayoutMenu}
          setShowLayoutMenu={setShowLayoutMenu}
          onLayoutChange={setLayoutMode}
          layoutButtonRef={layoutButtonRef}
          blacklistedChannels={blacklistedChannels}
          onShowBlacklist={() => setShowBlacklistModal(true)}
          onTheatreMode={() => setIsTheatreMode(true)}
          onShowClearConfirm={() => setShowClearConfirm(true)}
        />
      )}

      {/* Exit Theatre Mode Button */}
      {isTheatreMode && (
        <button
          onClick={() => setIsTheatreMode(false)}
          className="fixed top-4 right-4 z-50 flex items-center justify-center w-10 h-10 rounded-lg border border-slate-700 bg-slate-900/90 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 shadow-2xl"
          title="Exit Theatre Mode"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Grid Container */}
      <div className={`flex-1 ${isTheatreMode ? 'p-0 overflow-hidden' : 'p-4 overflow-auto'}`}>
        <MultiViewGrid
          streams={streams}
          streamOrder={streamOrder}
          sessionId={sessionId}
          isTheatreMode={isTheatreMode}
          layout={layout}
          layoutMode={layoutMode}
          mutedStreams={mutedStreams}
          streamQualities={streamQualities}
          findingAlternativeFor={findingAlternativeFor}
          activeId={activeId}
          loadingStreams={loadingStreams}
          playerType={autoFillSettings.playerType}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onToggleMute={toggleMute}
          onRefresh={refreshStream}
          onFindAlternative={handleFindAlternative}
          onFindDifferentGame={handleFindDifferentGame}
          onBlacklist={addToBlacklist}
          onRemove={removeStream}
          onQualityDetected={onQualityDetected}
        />
      </div>

      {/* Modals */}
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
        onPick={(channel) =>
          // Brand mode tells the backend to skip per-event/PPV channels
          // (e.g. "ESPN+ | NBA: Lakers vs Warriors") and prefer the
          // linear feed. Return the promise so the modal can show a
          // per-row spinner and auto-close on success.
          searchByName(channel.name, { mode: 'brand' })
        }
      />

      <BroadcasterCoverageModal
        isOpen={showBroadcasterCoverageModal}
        onClose={() => setShowBroadcasterCoverageModal(false)}
        // Two call shapes from the modal:
        //   row Test    → onTestCode(code, signal, aliases[])
        //   alias chip  → onTestCode(alias, signal)        (3rd arg undefined)
        // Both run brand-mode; the optional aliases array is the row's
        // full expansion list so a single Test click covers every
        // catalog naming variant of the family.
        onTestCode={(code, signal, aliases) =>
          searchByName(code, { mode: 'brand', signal, aliases })
        }
      />

      <AllGamesModal
        isOpen={showAllGamesModal}
        onClose={() => setShowAllGamesModal(false)}
        // Forward each pick straight into the ticker pipeline. The
        // /today endpoint returns rows whose field names already
        // match the score object handleTickerEventClick expects
        // (event_id, event_name, sport_type, league_name, home_team,
        // away_team), so no shape massaging is needed.
        onPick={async (event, signal) => {
          await handleTickerEventClick(event, { signal });
          // Always close after the click — the user gets a toast for
          // success/failure, and they can reopen to try another game.
          return true;
        }}
        // Click on a broadcaster chip → brand-mode search for that
        // channel directly (same pipeline as Coverage modal's Test
        // button). Modal stays open so the user can try multiple
        // chips if the first one isn't carried in their catalog.
        // Signal flows from the chip's AbortController so Cancel
        // works mid-search.
        onPickBroadcaster={(code, signal) => searchByName(code, { mode: 'brand', signal })}
      />

      {/* Live Scores Ticker */}
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

export default MultiViewPage;
