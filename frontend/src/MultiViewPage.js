import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  YouTubeModal,
  BroadcasterCoverageModal,
  ChannelPickerModal,
  MultiViewRail,
  MultiViewTopBar,
  FavoritesPanel,
  LayoutPanel,
  CommandPalette,
  DrawerShell,
  MultiViewTaskBar
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
import { useCommercialOrchestrator } from './hooks/multiview/useCommercialOrchestrator';
import usePanelManager from './hooks/multiview/usePanelManager';
import useYouTubeFavorites from './hooks/multiview/useYouTubeFavorites';

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
      playerType: 'mpegts-player',
      // Commercial auto-skip — off by default. When enabled, both
      // audio and logo detection run unless individually disabled.
      commercialAutoSkip: false,
      commercialDetectAudio: true,
      commercialDetectLogo: true
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

  // ─── Drawer/panel management ───────────────────────────────────────
  // Each rail icon opens a drawer via the panel manager (search,
  // trending, allgames, coverage, blacklist, settings, favorites,
  // layout). One drawer visible at a time; the rest dock in the
  // bottom taskbar but stay mounted so async work keeps running.
  const panels = usePanelManager();
  const ytFavs = useYouTubeFavorites({ enabled: true });
  // Destructure the stable callbacks (useCallback'd inside the hook
  // with [] deps) so memoised openers below don't churn on every
  // render — depending on the `panels` object directly would mean
  // every useCallback we build with it as a dep re-creates each render
  // (panels is a new object literal even though its methods are
  // stable references).
  const {
    open: openPanel,
    minimize: minimizePanel,
    restore: restorePanel,
    close: closePanel,
    toggle: togglePanelManager,
    setStatus: setPanelStatus,
    isMounted: isPanelMounted,
    isOpen: isPanelOpen,
    get: getPanel
  } = panels;
  // Ref for the channel picker's filter input so DrawerShell can
  // refocus it every time the drawer pops back into view.
  const pickerFocusRef = useRef(null);

  // ─── Drag/drop state for tile reordering ───────────────────────────
  const [activeId, setActiveId] = useState(null);
  const [streamOrder, setStreamOrder] = useState({});

  // ─── Hooks ─────────────────────────────────────────────────────────
  const {
    blacklistedChannels,
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
  } = useStreamFinder({
    streams,
    autoFillSettings,
    // useStreamFinder pops settings when local-news fails for lack of
    // a saved location. Route that through the panel manager.
    setShowSettingsModal: (v) => {
      if (v) openPanel('settings', { title: 'Multi-View Settings', spineColor: 'emerald', icon: GEAR_ICON });
      else closePanel('settings');
    }
  });

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

  // Tracks slots that have already received an auto-refresh in the
  // current dead-stream cycle. Cleared when the slot emits the
  // `iptv:streamPlaying` event (in initMpegts.js) — see the listener
  // attached inside handleStreamDead below. Prevents an infinite
  // refresh→fail→refresh loop on a genuinely broken stream.
  const refreshAttemptedSlotsRef = useRef(new Set());

  // Timestamp of the last visibility-change-to-hidden. Used by the
  // wake-up effect below to decide whether enough time has passed
  // that streams are likely stale and need a refresh.
  const lastHiddenAtRef = useRef(0);

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

  // Single entry point for "run a search". Used by:
  //   - the TopBar's submit (handleSearchSubmit below)
  //   - the in-drawer search input (Enter / Search button)
  //
  // openPanel('search') is idempotent AND restores a minimized panel
  // back to the open state — that's the bug the user hit before this
  // wrapper existed: hitting the TopBar search while the drawer was
  // docked would update the data underneath but never re-surface the
  // drawer. Now every search routes through here, so the drawer
  // always pops back into view when fresh results arrive.
  const performSearch = useCallback(
    (q) => {
      openPanel('search', { title: 'Search', spineColor: 'cyan', icon: SEARCH_ICON });
      openPickerForQuery(q);
    },
    [openPanel, openPickerForQuery]
  );

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

  // Commercial auto-skip orchestrator — owns detection + mute-swap +
  // false-positive learning. Disabled until the user opts in via the
  // settings panel. Sub-toggles let them lean on just audio (sports)
  // or include logo detection (cable).
  const commercial = useCommercialOrchestrator({
    enabled: Boolean(autoFillSettings.commercialAutoSkip),
    audioEnabled: autoFillSettings.commercialDetectAudio !== false,
    logoEnabled: autoFillSettings.commercialDetectLogo !== false,
    streams,
    mutedStreams,
    toggleMute
  });

  // ─── Effects ───────────────────────────────────────────────────────
  useEffect(() => { setLayout(calculateLayout(streams.length)); }, [streams.length]);
  useEffect(() => {
    localStorage.setItem('multiview_autofill_settings', JSON.stringify(autoFillSettings));
  }, [autoFillSettings]);
  useEffect(() => {
    localStorage.setItem('multiview_layout_mode', layoutMode);
  }, [layoutMode]);
  // Close all panels when theatre mode flips on — they'd be invisible
  // anyway, and stale open state would resurface them on exit.
  useEffect(() => {
    if (isTheatreMode) {
      panels.panels.forEach((p) => closePanel(p.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTheatreMode]);

  // Mirror static counts into panel status so the taskbar chip stays
  // in sync for panels that don't manage their own status (blacklist,
  // favorites, layout). setPanelStatus is idempotent so these can
  // safely fire every render without triggering re-render loops.
  useEffect(() => {
    setPanelStatus('blacklist', { kind: 'idle', text: `${blacklistedChannels.length} entries` });
  }, [blacklistedChannels.length, setPanelStatus]);
  useEffect(() => {
    setPanelStatus('favorites', { kind: 'idle', text: `${favorites.length} saved` });
  }, [favorites.length, setPanelStatus]);
  useEffect(() => {
    setPanelStatus('layout', { kind: 'idle', text: `${streams.length} tile${streams.length === 1 ? '' : 's'}` });
  }, [streams.length, setPanelStatus]);

  // Mirror the picker hook's isOpen into the panel manager so the
  // picker's openForQuery / openForStream / openEmpty calls (which
  // each setIsOpen(true) internally) automatically pop the drawer.
  // When the picker hook's isOpen flips false (close was called), we
  // also close the drawer — the picker's own X is the only path that
  // does this, since the modal no longer has its own close button.
  const pickerHookIsOpen = pickerState.isOpen;
  useEffect(() => {
    if (pickerHookIsOpen) {
      openPanel('search', {
        title: 'Search',
        spineColor: 'cyan',
        icon: SEARCH_ICON
      });
    }
    // We don't auto-close on isOpen→false here because that case
    // would conflict with the user's own minimize-via-drawer-chrome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerHookIsOpen]);

  // ─── Wired handlers ────────────────────────────────────────────────

  // Favorite a currently-playing tile.
  //
  // YouTube tiles route through youtube_favorites (separate table —
  // see migration 037). The IPTV favorites table requires a real
  // (source_id, channel_id) tuple, which YouTube tiles don't have
  // (they carry sourceId=0 as a sentinel). Keeping the two domains
  // separate avoids polluting IPTV favorites with YouTube rows.
  const handleToggleTileFavorite = useCallback(async (stream) => {
    if (stream?.sourceType === 'youtube') {
      const channelId = stream.id;
      const existing = ytFavs.favorites.find((f) => f.channelId === channelId);
      if (existing) {
        await ytFavs.removeFavorite(existing.id);
        showToast(`Removed "${stream.name}" from favorites`, 'success');
      } else {
        const added = await ytFavs.addFavorite({
          channelId,
          name: stream.name,
          handle: stream.ytHandle || null,
          avatarUrl: stream.logo || null,
          channelUrl: stream.url || null
        });
        if (added) showToast(`Saved "${stream.name}" to favorites`, 'success');
        else showToast(`Failed to save "${stream.name}"`, 'error');
      }
      return;
    }

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
  }, [isFavorite, toggleFavorite, ytFavs]);

  // Play a favorite chip — fast-path: if already on screen, surface a
  // toast (no duplicate tiles); otherwise addToMultiview and bump
  // played-count for future "recent" sort.
  //
  // YouTube favorites route through the same addToMultiview path but
  // skip bumpPlayed (which targets the IPTV favorites table). The fav
  // object carries the full normalised shape already — see
  // mergedFavorites below for the merge.
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
      ytHandle: fav.ytHandle,
      searchQuery: fav.name
    };
    const ok = await addToMultiview(channel);
    if (ok) {
      window.dispatchEvent(new Event('multiviewUpdate'));
      if (fav.sourceType !== 'youtube') bumpPlayed(fav.id);
      showToast(`Added "${fav.name}" to Multi-View`, 'success');
      return true;
    }
    showToast(`Failed to add "${fav.name}"`, 'error');
    return false;
  }, [streams, bumpPlayed]);

  // Merge IPTV + YouTube favorites into a single list for the topbar
  // strip. YouTube favorites carry sourceType='youtube' and a string
  // id prefixed with 'yt:' so React keys don't collide with the
  // numeric IPTV favorite ids.
  const mergedFavorites = useMemo(() => {
    const yt = (ytFavs.favorites || []).map((f) => ({
      id: `yt:${f.id}`,
      sourceId: 0,
      channelId: f.channelId,
      name: f.customName || f.name,
      logo: f.avatarUrl || null,
      url: f.channelUrl || null,
      sourceType: 'youtube',
      sourceName: 'YouTube',
      sourceUrl: f.channelUrl || null,
      ytHandle: f.handle || null
    }));
    return [...favorites, ...yt];
  }, [favorites, ytFavs.favorites]);

  // Remove handler that knows about both tables. The strip passes a
  // raw favorite id; YouTube ids carry the 'yt:' prefix so we can
  // route correctly. IPTV ids stay numeric.
  const handleRemoveFavoriteSmart = useCallback(async (id) => {
    if (typeof id === 'string' && id.startsWith('yt:')) {
      const numeric = parseInt(id.slice(3), 10);
      if (Number.isFinite(numeric)) await ytFavs.removeFavorite(numeric);
      return;
    }
    return removeFavorite(id);
  }, [removeFavorite, ytFavs]);

  // Header search submit — open the picker so generic queries surface
  // every match rather than auto-adding whichever ffprobe-validates
  // first. Routes through `performSearch` so a TopBar search ALSO
  // restores the drawer when it was minimized.
  const handleSearchSubmit = useCallback((e) => {
    e?.preventDefault?.();
    const q = String(searchQuery || '').trim();
    if (q.length < 2) return;
    performSearch(q);
    setSearchQuery('');
    setShowSearchInput(false);
  }, [searchQuery, performSearch, setSearchQuery, setShowSearchInput]);

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

  // Page Visibility wake-up. When the user backgrounds the tab, the
  // browser throttles XHR/fetch and the resilient-proxy backend often
  // gives up after its retry budget; when they come back the player
  // is sitting on a frozen frame with no event to recover from. If
  // the tab was hidden for >30s, refresh every active stream (the
  // same path as the manual ↻ button), staggered 300ms apart so we
  // don't kick off N parallel mpegts re-inits + N backend ffmpeg
  // pipes simultaneously.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        lastHiddenAtRef.current = Date.now();
        console.info(`[multiview][visibility] tab hidden`);
        return;
      }
      const hiddenMs = lastHiddenAtRef.current
        ? Date.now() - lastHiddenAtRef.current
        : 0;
      lastHiddenAtRef.current = 0;
      console.info(
        `[multiview][visibility] tab visible after ${hiddenMs}ms hidden (streams=${streams?.length || 0})`
      );
      if (hiddenMs < 30000) return;
      if (!streams || streams.length === 0) return;

      console.info(
        `[multiview][visibility] hidden >30s — proactively refreshing ${streams.length} streams (staggered 300ms)`
      );
      // Snapshot the current stream list — refreshStream mutates the
      // live array, so iterate over a copy.
      const snapshot = streams.slice();
      snapshot.forEach((s, idx) => {
        if (!s || !s.id || !s.sourceId) return;
        setTimeout(() => {
          refreshStream(s.id, s.sourceId);
        }, idx * 300);
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [streams, refreshStream]);

  // When IPTVPlayer declares a slot dead (45s frozen, fatal error,
  // etc.), try an automatic refresh of the same channel FIRST before
  // escalating to find-alternative. The refresh path is exactly what
  // the manual ↻ button does: bump the slot's _refreshKey, which
  // forces IPTVPlayer to unmount + remount with a fresh mpegts
  // instance + fresh backend connection. Empirically that fixes most
  // "stuck" streams without swapping the user to a different channel.
  //
  // Loop guard: refreshAttemptedSlotsRef tracks which slots we've
  // already auto-refreshed in this dead-stream cycle. If the same
  // slot dies again before successfully playing, we go straight to
  // find-alternative (the swap is the user's escape hatch when the
  // channel genuinely is broken). The set is cleared when
  // initMpegts.js emits the `iptv:streamPlaying` event for the slot.
  const handleStreamDead = useCallback((stream) => {
    if (!stream || !stream.id || !stream.sourceId) return;
    const slotKey = `${stream.sourceId}_${stream.id}`;
    const channelName = stream.name || stream.id;
    const startedAt = Date.now();

    if (refreshAttemptedSlotsRef.current.has(slotKey)) {
      // Refresh was already tried and it ALSO failed. Escalate.
      refreshAttemptedSlotsRef.current.delete(slotKey);
      console.warn(
        `[multiview][recovery] ${channelName}: auto-refresh already failed this cycle — escalating to find-alternative`
      );
      handleFindAlternative(stream, true);
      return;
    }

    refreshAttemptedSlotsRef.current.add(slotKey);
    console.info(
      `[multiview][recovery] ${channelName}: stream declared dead — triggering auto-refresh (slot=${slotKey})`
    );
    refreshStream(stream.id, stream.sourceId);

    // Wait up to 12s for the stream to start playing. If it does,
    // initMpegts.js fires `iptv:streamPlaying` and the listener clears
    // the slot from the attempted-set. If it doesn't, the timeout
    // promotes to find-alternative. 12s is tight enough that the
    // total recovery window (freeze detection ~8-15s + refresh wait
    // 12s) stays under 30s — matching what the user expects from
    // hitting the manual ↻ button.
    const onPlay = (e) => {
      const d = e.detail || {};
      if (d.sourceId === stream.sourceId && d.channelId === stream.id) {
        const elapsed = Date.now() - startedAt;
        console.info(
          `[multiview][recovery] ${channelName}: auto-refresh succeeded after ${elapsed}ms ✓`
        );
        window.removeEventListener('iptv:streamPlaying', onPlay);
        clearTimeout(timeoutId);
        refreshAttemptedSlotsRef.current.delete(slotKey);
      }
    };
    window.addEventListener('iptv:streamPlaying', onPlay);
    const timeoutId = setTimeout(() => {
      window.removeEventListener('iptv:streamPlaying', onPlay);
      if (refreshAttemptedSlotsRef.current.has(slotKey)) {
        const elapsed = Date.now() - startedAt;
        console.warn(
          `[multiview][recovery] ${channelName}: auto-refresh did NOT confirm playback within ${elapsed}ms — escalating to find-alternative`
        );
        refreshAttemptedSlotsRef.current.delete(slotKey);
        // Stream still wasn't playing after the refresh window — try
        // an alternative now. handleFindAlternative has its own
        // chain-breaker so this won't runaway.
        handleFindAlternative(stream, true);
      }
    }, 12000);
  }, [refreshStream, handleFindAlternative]);

  // ─── Panel openers (rail icons + command palette) ──────────────────
  // Each rail icon → panel.open with the module's descriptor (title,
  // spine color, icon). Calling .open while a panel is already in the
  // stack restores it; calling on the currently-open panel keeps it
  // (no flicker).
  const openSearchPanel = useCallback(() => {
    openPanel('search', { title: 'Search', spineColor: 'cyan', icon: SEARCH_ICON });
    openPickerEmptyHook();
  }, [openPanel, openPickerEmptyHook]);

  const openTrendingPanel = useCallback(() => {
    openPanel('trending', { title: 'Trending', spineColor: 'rose', icon: FLAME_ICON });
  }, [openPanel]);

  const openAllGamesPanel = useCallback(() => {
    openPanel('allgames', { title: "Today's Slate", spineColor: 'amber', icon: BALL_ICON });
  }, [openPanel]);

  const openYouTubePanel = useCallback(() => {
    openPanel('youtube', { title: 'YouTube', spineColor: 'rose', icon: YOUTUBE_ICON });
  }, [openPanel]);

  const openCoveragePanel = useCallback(() => {
    openPanel('coverage', { title: 'Broadcaster Coverage', spineColor: 'indigo', icon: BROADCAST_ICON });
  }, [openPanel]);

  const openBlacklistPanel = useCallback(() => {
    openPanel('blacklist', { title: 'Blacklist', spineColor: 'rose', icon: BAN_ICON });
  }, [openPanel]);

  const openSettingsPanel = useCallback(() => {
    openPanel('settings', { title: 'Settings', spineColor: 'emerald', icon: GEAR_ICON });
  }, [openPanel]);

  const openFavoritesPanel = useCallback(() => {
    togglePanelManager('favorites', { title: 'Favorites', spineColor: 'amber', icon: HEART_ICON });
  }, [togglePanelManager]);

  const openLayoutPanel = useCallback(() => {
    togglePanelManager('layout', { title: 'Layout', spineColor: 'cyan', icon: LAYOUT_ICON });
  }, [togglePanelManager]);

  // ─── Stable per-panel callback bundles ─────────────────────────────
  // The inline arrows we were passing to drawer/modal props
  // (onMinimize, onClose, onStatusChange, onAfterPick) had a fresh
  // identity every render. React.memo couldn't kick in, so every
  // page re-render (4Hz from the commercial orchestrator + every
  // keystroke + every panel state mutation) re-rendered ALL mounted
  // drawer bodies — which is what was making the search drawer feel
  // sticky and intercepting clicks on the header's minimize button.
  // Bind these once per panel id and reuse the references.
  const onMinimizeSearch    = useCallback(() => minimizePanel('search'),    [minimizePanel]);
  const onMinimizeTrending  = useCallback(() => minimizePanel('trending'),  [minimizePanel]);
  const onMinimizeAllGames  = useCallback(() => minimizePanel('allgames'),  [minimizePanel]);
  const onMinimizeYouTube   = useCallback(() => minimizePanel('youtube'),   [minimizePanel]);
  const onMinimizeCoverage  = useCallback(() => minimizePanel('coverage'),  [minimizePanel]);
  const onMinimizeBlacklist = useCallback(() => minimizePanel('blacklist'), [minimizePanel]);
  const onMinimizeSettings  = useCallback(() => minimizePanel('settings'),  [minimizePanel]);
  const onMinimizeFavorites = useCallback(() => minimizePanel('favorites'), [minimizePanel]);
  const onMinimizeLayout    = useCallback(() => minimizePanel('layout'),    [minimizePanel]);

  const onCloseTrending  = useCallback(() => closePanel('trending'),  [closePanel]);
  const onCloseAllGames  = useCallback(() => closePanel('allgames'),  [closePanel]);
  const onCloseYouTube   = useCallback(() => closePanel('youtube'),   [closePanel]);
  const onCloseCoverage  = useCallback(() => closePanel('coverage'),  [closePanel]);
  const onCloseBlacklist = useCallback(() => closePanel('blacklist'), [closePanel]);
  const onCloseSettings  = useCallback(() => closePanel('settings'),  [closePanel]);
  const onCloseFavorites = useCallback(() => closePanel('favorites'), [closePanel]);
  const onCloseLayout    = useCallback(() => closePanel('layout'),    [closePanel]);

  const onStatusSearch   = useCallback((s) => setPanelStatus('search',   s), [setPanelStatus]);
  const onStatusTrending = useCallback((s) => setPanelStatus('trending', s), [setPanelStatus]);
  const onStatusAllGames = useCallback((s) => setPanelStatus('allgames', s), [setPanelStatus]);
  const onStatusYouTube  = useCallback((s) => setPanelStatus('youtube',  s), [setPanelStatus]);
  const onStatusCoverage = useCallback((s) => setPanelStatus('coverage', s), [setPanelStatus]);

  const onVisibleFocusSearch = useCallback(() => pickerFocusRef.current?.focus?.(), []);

  // The in-drawer search calls the same path the TopBar uses, so
  // both surfaces restore the panel on a fresh query.
  const onSearchFromPicker = performSearch;

  // Stable picker / test callbacks for each discovery panel. The
  // searchByName + handleTickerEventClick references are themselves
  // useCallback'd inside their respective hooks; if they ever start
  // churning identity, this useMemo wall stops the lag at the door.
  const onTrendingPick = useCallback(
    (channel, signal) => searchByName(channel.name, { mode: 'brand', signal }),
    [searchByName]
  );
  const onAllGamesPick = useCallback(
    async (event, signal) => {
      await handleTickerEventClick(event, { signal });
      return true;
    },
    [handleTickerEventClick]
  );
  const onAllGamesPickBroadcaster = useCallback(
    (code, signal) => searchByName(code, { mode: 'brand', signal }),
    [searchByName]
  );

  // YouTube picker hands back a fully-shaped stream payload (sourceType
  // 'youtube', sourceId 0). Route through the same addToMultiview path
  // as every other stream source so persistence, dedupe, and layout
  // ripple work uniformly.
  const onYouTubePick = useCallback(async (stream) => {
    if (!stream || !stream.id) return false;
    const alreadyOnScreen = streams.some(
      (s) => s.id === stream.id && s.sourceType === 'youtube'
    );
    if (alreadyOnScreen) {
      showToast(`"${stream.name}" is already on screen`, 'info');
      return false;
    }
    const ok = await addToMultiview(stream);
    if (ok) {
      window.dispatchEvent(new Event('multiviewUpdate'));
      showToast(`Added "${stream.name}" to Multi-View`, 'success');
      return true;
    }
    showToast(`Failed to add "${stream.name}"`, 'error');
    return false;
  }, [streams]);

  const onCoverageTest = useCallback(
    (code, signal, aliases) => searchByName(code, { mode: 'brand', signal, aliases }),
    [searchByName]
  );

  // Rail's `activePanel` prop expects a single id for the currently
  // open panel (drives the recessed/active visual state). Map panel
  // manager's openPanel into that contract.
  const activePanelId = panels.openPanel?.id || null;
  const togglePanel = useCallback((id) => {
    // Backwards-compatible hook for older rail wiring — favorites
    // and layout are the only callers via this shape.
    if (id === 'favorites') openFavoritesPanel();
    else if (id === 'layout') openLayoutPanel();
  }, [openFavoritesPanel, openLayoutPanel]);

  const setTheatreMode = useCallback((v) => {
    setIsTheatreMode(typeof v === 'function' ? v(isTheatreMode) : v);
  }, [isTheatreMode, setIsTheatreMode]);

  // Tickering toggle — modifies autoFillSettings (persisted).
  const toggleTicker = useCallback(() => {
    setAutoFillSettings((s) => ({ ...s, showLiveScoresTicker: !s.showLiveScoresTicker }));
  }, []);

  // Search activator from the rail — open the inline TopBar input.
  // The picker drawer pops as soon as the user submits a query (via
  // handleSearchSubmit) or types in the drawer's own filter input.
  const openSearch = useCallback(() => setShowSearchInput(true), [setShowSearchInput]);

  // "Open picker" rail icon — opens the modal with no query so the
  // user lands on the Favorites tab (or an empty Results tab if no
  // favorites yet). The filter input is ready for typing if they want
  // to search instead.
  const openPickerEmpty = openSearchPanel;

  // Wrap openForStream so the per-tile "alternate sources" button
  // opens the drawer too (the picker hook flips its own isOpen,
  // which the effect mirrors, but we want the descriptor right).
  const openPickerForStreamPanel = useCallback((stream) => {
    openPanel('search', {
      title: stream?.name ? `Alt: ${stream.name}` : 'Alt sources',
      spineColor: 'cyan',
      icon: SEARCH_ICON
    });
    openPickerForStream(stream);
  }, [openPanel, openPickerForStream]);

  // Close the search drawer fully — also resets the picker hook
  // state so the next open starts fresh.
  const handleSearchClose = useCallback(() => {
    closePanel('search');
    pickerState.onClose?.();
  }, [closePanel, pickerState]);

  // ─── Command palette commands ──────────────────────────────────────
  const commands = useMemo(() => [
    // FIND
    { id: 'search',     group: 'Find',     label: 'Search channel',          hint: 'Open the search input',  kbd: '/',    accent: 'cyan',    icon: <CmdIcon name="search" />,   run: openSearch },
    { id: 'autofill',   group: 'Find',     label: 'AutoFill tiles',          hint: 'Fill empty slots with live sports', accent: 'emerald', icon: <CmdIcon name="bolt" />, run: () => handleAutoFill(null, null) },
    { id: 'random-sport', group: 'Find',   label: 'Random sports channel',   hint: 'One random live sports stream', accent: 'emerald', icon: <CmdIcon name="ball" />, run: findRandomSportsChannel },
    { id: 'random-any', group: 'Find',     label: 'Random any channel',      hint: 'Truly random — anything in your sources', accent: 'violet', icon: <CmdIcon name="grid" />, run: findRandomAnyChannel },
    { id: 'picker',     group: 'Find',     label: 'Open channel picker',     hint: 'Browse your favorites + library', accent: 'cyan', icon: <CmdIcon name="grid" />, run: openPickerEmpty },
    // DISCOVER
    { id: 'trending',   group: 'Discover', label: 'Trending channels',       hint: 'YT / Twitch / Reddit / Bluesky composite', accent: 'rose', icon: <CmdIcon name="flame" />, run: openTrendingPanel },
    { id: 'allgames',   group: 'Discover', label: 'All games today',         hint: 'Live, scheduled, and final',  accent: 'emerald', icon: <CmdIcon name="ball" />, run: openAllGamesPanel },
    { id: 'youtube',    group: 'Discover', label: 'Add YouTube channel',     hint: 'Paste URL · search · favorites', accent: 'rose', icon: <CmdIcon name="play" />, run: openYouTubePanel },
    { id: 'coverage',   group: 'Discover', label: 'Broadcaster coverage',    hint: 'Alias gaps and discovery report', accent: 'cyan', icon: <CmdIcon name="broadcast" />, run: openCoveragePanel },
    { id: 'news',       group: 'Discover', label: 'Find local news',         hint: 'Random local news station',   accent: 'amber',   icon: <CmdIcon name="news" />, disabled: searchingNews, run: findLocalNews },
    // SAVED
    { id: 'favorites',  group: 'Saved',    label: 'Open favorites',          hint: 'Slide-in panel for management', accent: 'amber', icon: <CmdIcon name="heart" />, run: openFavoritesPanel },
    { id: 'blacklist',  group: 'Saved',    label: 'Manage blacklist',        hint: 'Channels excluded from random fill', accent: 'amber', icon: <CmdIcon name="ban" />, run: openBlacklistPanel },
    { id: 'settings',   group: 'Saved',    label: 'Multi-view settings',     hint: 'Player type, max slots, duplicate rules', accent: 'cyan', icon: <CmdIcon name="gear" />, run: openSettingsPanel },
    // VIEW
    { id: 'layout',     group: 'View',     label: 'Change layout',           hint: 'Grid / featured / dual / theatre', accent: 'cyan', icon: <CmdIcon name="layout" />, run: openLayoutPanel },
    { id: 'theatre',    group: 'View',     label: isTheatreMode ? 'Exit theatre mode' : 'Enter theatre mode', hint: 'Hide all chrome', accent: 'amber', icon: <CmdIcon name="theatre" />, disabled: streams.length === 0, run: () => setTheatreMode((v) => !v) },
    { id: 'ticker',     group: 'View',     label: autoFillSettings.showLiveScoresTicker ? 'Hide live scores ticker' : 'Show live scores ticker', hint: 'Bottom-edge running ticker', accent: 'emerald', icon: <CmdIcon name="ticker" />, run: toggleTicker },
    { id: 'clear',      group: 'View',     label: 'Clear all streams',       hint: 'Remove every tile', accent: 'rose', icon: <CmdIcon name="trash" />, disabled: streams.length === 0, run: () => setShowClearConfirm(true) }
  ], [
    openSearch, handleAutoFill, openPickerEmpty, searchingNews, findLocalNews,
    findRandomSportsChannel, findRandomAnyChannel,
    openTrendingPanel, openAllGamesPanel, openYouTubePanel, openCoveragePanel,
    openFavoritesPanel, openBlacklistPanel, openSettingsPanel, openLayoutPanel,
    isTheatreMode, streams.length, autoFillSettings.showLiveScoresTicker,
    toggleTicker, setShowClearConfirm, setTheatreMode
  ]);

  // ─── Render ────────────────────────────────────────────────────────
  // Layout offsets:
  //   - Ticker (when on) lives at the very bottom of the viewport,
  //     full-width, owned by the page wrapper.
  //   - Vertical dock (TaskBar) lives on the right edge of the
  //     content column, top to (bottom - ticker).
  //   - Drawers anchor top-left of the content column. Their bottom
  //     stops above the ticker; their width is unaffected by the
  //     dock (the dock overlays them on the right edge, but since
  //     drawers are 340-580px wide and the dock is 48px, the overlap
  //     is small and intentional — the dock is "on top of" the
  //     drawer's far edge, which already has the colored spine).
  const tickerHeight = autoFillSettings.showLiveScoresTicker ? 48 : 0;
  // Drawer's top starts BELOW the topbar so the topbar's controls
  // (favorites strip, inline search input, command palette button)
  // stay accessible without fighting the drawer for clicks.
  const drawerTopGap = isTheatreMode ? 0 : 40; // topbar is h-10 = 40px
  // Drawer's bottom = ticker so its body sits cleanly above the
  // ticker.
  const drawerBottomGap = tickerHeight;
  // Right-side dock width when at least one panel is docked. The
  // grid reserves this much padding-right so tiles don't extend
  // under it — the per-tile X-close button in the OSD would
  // otherwise be unreachable. 48 = MultiViewTaskBar's w-12.
  const dockWidth = panels.minimizedPanels.length > 0 ? 48 : 0;

  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden">
      {/* Left rail — page-scoped controls. Hidden in theatre mode for
          true distraction-free viewing. */}
      {!isTheatreMode && (
        <MultiViewRail
          onSearch={openSearch}
          onAutoFill={() => handleAutoFill(null, null)}
          onOpenPicker={openPickerEmpty}
          onOpenTrending={openTrendingPanel}
          onOpenAllGames={openAllGamesPanel}
          onOpenYouTube={openYouTubePanel}
          onOpenCoverage={openCoveragePanel}
          onLocalNews={findLocalNews}
          onOpenBlacklist={openBlacklistPanel}
          onOpenSettings={openSettingsPanel}
          onOpenClearConfirm={() => setShowClearConfirm(true)}
          onOpenPalette={palette.open}
          activePanel={activePanelId}
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
            favorites={mergedFavorites}
            streams={streams}
            streamOrder={streamOrder}
            onPlayFavorite={handlePlayFavorite}
            onRemoveFavorite={handleRemoveFavoriteSmart}
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
        <div
          className={`flex-1 ${isTheatreMode ? 'p-0 overflow-hidden' : 'p-3 overflow-auto'}`}
          style={isTheatreMode ? undefined : { paddingRight: `${12 + dockWidth}px` }}
        >
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
            onStreamDead={handleStreamDead}
            onFindAlternative={handleFindAlternative}
            onFindDifferentGame={handleFindDifferentGame}
            onAlternateSources={openPickerForStreamPanel}
            onBlacklist={addToBlacklist}
            onRemove={removeStream}
            isFavorited={(sourceId, id) =>
              Number(sourceId) === 0
                ? ytFavs.isFavorite(id)
                : isFavorite(sourceId, id)
            }
            onToggleFavorite={handleToggleTileFavorite}
            autoMutedKeys={commercial.autoMutedKeys}
            tileStates={commercial.tileStates}
            onRegisterVideoElement={commercial.registerVideoElement}
            onUnregisterVideoElement={commercial.unregisterVideoElement}
            onUndoAdMute={commercial.undoForKey}
            onQualityDetected={onQualityDetected}
          />
        </div>

        {/* ── Drawer panels ────────────────────────────────────────
            All drawers mount inside this content column (left edge =
            just right of the rail). Each panel stays mounted while
            in the dock so its async work (search debounce, polling
            fetches) keeps running while minimized.

            Reserve room at the bottom for the taskbar when at least
            one panel is docked, so drawers don't overlap their own
            minimized chips. */}
        {!isTheatreMode && (
          <>
            {/* SEARCH / CHANNEL PICKER — the most-used drawer.
                Drawer width 540px (dense rows, two-column metadata). */}
            {isPanelMounted('search') && (
              <DrawerShell
                isMounted={isPanelMounted('search')}
                isVisible={isPanelOpen('search')}
                width={540}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title={getPanel('search')?.title || 'Search'}
                subtitle={pickerState.subtitle}
                icon={SEARCH_ICON}
                spineColor="cyan"
                status={getPanel('search')?.status}
                onMinimize={onMinimizeSearch}
                onClose={handleSearchClose}
                onVisibleFocus={onVisibleFocusSearch}
              >
                <ChannelPickerModal
                  {...pickerState}
                  isOpen={isPanelMounted('search')}
                  isVisible={isPanelOpen('search')}
                  onAfterPick={onMinimizeSearch}
                  onSearch={onSearchFromPicker}
                  autoFocusRef={pickerFocusRef}
                  onStatusChange={onStatusSearch}
                  favorites={favorites}
                  favoritesLoading={favoritesLoading}
                  isFavorite={isFavorite}
                  onToggleFavorite={toggleFavorite}
                />
              </DrawerShell>
            )}

            {/* TRENDING */}
            {isPanelMounted('trending') && (
              <DrawerShell
                isMounted={isPanelMounted('trending')}
                isVisible={isPanelOpen('trending')}
                width={460}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Trending"
                subtitle="YT · Twitch · Reddit · Bluesky"
                icon={FLAME_ICON}
                spineColor="rose"
                status={getPanel('trending')?.status}
                onMinimize={onMinimizeTrending}
                onClose={onCloseTrending}
              >
                <TrendingModal
                  isOpen={isPanelMounted('trending')}
                  onPick={onTrendingPick}
                  onAfterPick={onMinimizeTrending}
                  onStatusChange={onStatusTrending}
                />
              </DrawerShell>
            )}

            {/* ALL GAMES — densest list, 560px feels right. */}
            {isPanelMounted('allgames') && (
              <DrawerShell
                isMounted={isPanelMounted('allgames')}
                isVisible={isPanelOpen('allgames')}
                width={560}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Today's Slate"
                subtitle="Live · scheduled · final"
                icon={BALL_ICON}
                spineColor="amber"
                status={getPanel('allgames')?.status}
                onMinimize={onMinimizeAllGames}
                onClose={onCloseAllGames}
              >
                <AllGamesModal
                  isOpen={isPanelMounted('allgames')}
                  onPick={onAllGamesPick}
                  onPickBroadcaster={onAllGamesPickBroadcaster}
                  onAfterPick={onMinimizeAllGames}
                  onStatusChange={onStatusAllGames}
                />
              </DrawerShell>
            )}

            {/* YOUTUBE — URL paste / search / favorites tabs. 480px is
                comfortable for the URL input + paste hints; gives the
                row layout room for the channel handle + LIVE chip. */}
            {isPanelMounted('youtube') && (
              <DrawerShell
                isMounted={isPanelMounted('youtube')}
                isVisible={isPanelOpen('youtube')}
                width={480}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="YouTube"
                subtitle="URL · search · favorites"
                icon={YOUTUBE_ICON}
                spineColor="rose"
                status={getPanel('youtube')?.status}
                onMinimize={onMinimizeYouTube}
                onClose={onCloseYouTube}
              >
                <YouTubeModal
                  isOpen={isPanelMounted('youtube')}
                  isVisible={isPanelOpen('youtube')}
                  onPick={onYouTubePick}
                  onAfterPick={onMinimizeYouTube}
                  onStatusChange={onStatusYouTube}
                />
              </DrawerShell>
            )}

            {/* BROADCASTER COVERAGE */}
            {isPanelMounted('coverage') && (
              <DrawerShell
                isMounted={isPanelMounted('coverage')}
                isVisible={isPanelOpen('coverage')}
                width={560}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Broadcaster Coverage"
                subtitle="Alias gaps & match stats"
                icon={BROADCAST_ICON}
                spineColor="indigo"
                status={getPanel('coverage')?.status}
                onMinimize={onMinimizeCoverage}
                onClose={onCloseCoverage}
              >
                <BroadcasterCoverageModal
                  isOpen={isPanelMounted('coverage')}
                  onTestCode={onCoverageTest}
                  onStatusChange={onStatusCoverage}
                />
              </DrawerShell>
            )}

            {/* BLACKLIST — slim, 380px. */}
            {isPanelMounted('blacklist') && (
              <DrawerShell
                isMounted={isPanelMounted('blacklist')}
                isVisible={isPanelOpen('blacklist')}
                width={380}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Blacklist"
                icon={BAN_ICON}
                spineColor="rose"
                status={getPanel('blacklist')?.status}
                onMinimize={onMinimizeBlacklist}
                onClose={onCloseBlacklist}
              >
                <BlacklistModal
                  isOpen={isPanelMounted('blacklist')}
                  blacklistedChannels={blacklistedChannels}
                  onRemoveFromBlacklist={removeFromBlacklist}
                />
              </DrawerShell>
            )}

            {/* SETTINGS — wide because of the section nav. */}
            {isPanelMounted('settings') && (
              <DrawerShell
                isMounted={isPanelMounted('settings')}
                isVisible={isPanelOpen('settings')}
                width={580}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Multi-View Settings"
                subtitle="Auto-fill · player · display"
                icon={GEAR_ICON}
                spineColor="emerald"
                onMinimize={onMinimizeSettings}
                onClose={onCloseSettings}
              >
                <SettingsModal
                  isOpen={isPanelMounted('settings')}
                  streams={streams}
                  autoFillSettings={autoFillSettings}
                  setAutoFillSettings={setAutoFillSettings}
                />
              </DrawerShell>
            )}

            {/* FAVORITES — compact, 340px. */}
            {isPanelMounted('favorites') && (
              <DrawerShell
                isMounted={isPanelMounted('favorites')}
                isVisible={isPanelOpen('favorites')}
                width={340}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Favorites"
                icon={HEART_ICON}
                spineColor="amber"
                status={getPanel('favorites')?.status}
                onMinimize={onMinimizeFavorites}
                onClose={onCloseFavorites}
              >
                <FavoritesPanel
                  isOpen={isPanelMounted('favorites')}
                  favorites={favorites}
                  streams={streams}
                  onPlay={handlePlayFavorite}
                  onRemove={removeFavorite}
                  onReorder={reorderFavorites}
                />
              </DrawerShell>
            )}

            {/* LAYOUT — compact, 340px. */}
            {isPanelMounted('layout') && (
              <DrawerShell
                isMounted={isPanelMounted('layout')}
                isVisible={isPanelOpen('layout')}
                width={340}
                topGap={drawerTopGap}
                bottomGap={drawerBottomGap}
                title="Layout"
                icon={LAYOUT_ICON}
                spineColor="cyan"
                status={getPanel('layout')?.status}
                onMinimize={onMinimizeLayout}
                onClose={onCloseLayout}
              >
                <LayoutPanel
                  isOpen={isPanelMounted('layout')}
                  layoutMode={layoutMode}
                  onLayoutChange={setLayoutMode}
                  showTicker={autoFillSettings.showLiveScoresTicker}
                  onToggleTicker={toggleTicker}
                  isTheatreMode={isTheatreMode}
                  onToggleTheatre={() => setTheatreMode((v) => !v)}
                  streamsCount={streams.length}
                />
              </DrawerShell>
            )}

            {/* ── TASKBAR / DOCK ──────────────────────────────────
                Only mounts when at least one panel is minimized. */}
            <MultiViewTaskBar
              panels={panels.minimizedPanels}
              onRestore={restorePanel}
              onClose={closePanel}
              topOffset={drawerTopGap}
              bottomOffset={tickerHeight}
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

      {/* ─── Global confirm/palette overlays (not part of dock) ─── */}
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
// Module icons — used in drawer headers + taskbar chips so each panel
// has a consistent identity color/glyph pair. Smaller than the rail's
// own icons (the drawer chrome's icon slot is 16px).
const ICON_PROPS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  viewBox: '0 0 24 24',
  className: 'w-full h-full'
};
const SEARCH_ICON = (<svg {...ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>);
const FLAME_ICON = (<svg {...ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3c1 4 5 5 5 9a5 5 0 11-10 0c0-2 1-3 2-4-1 4 3 4 3 0 0-2 0-3 0-5z" /></svg>);
const BALL_ICON = (<svg {...ICON_PROPS}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18M5.5 5.5l13 13M18.5 5.5l-13 13" /></svg>);
const BROADCAST_ICON = (<svg {...ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M4.93 19.07a10 10 0 010-14.14M19.07 4.93a10 10 0 010 14.14M8.46 16.46a5 5 0 010-7.07M15.54 9.39a5 5 0 010 7.07" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg>);
const YOUTUBE_ICON = (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-full h-full"><rect x="2.5" y="6" width="19" height="12" rx="3" /><path d="M11 9.5l4 2.5-4 2.5v-5z" fill="currentColor" stroke="none" /></svg>);
const BAN_ICON = (<svg {...ICON_PROPS}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M5.6 5.6l12.8 12.8" /></svg>);
const GEAR_ICON = (<svg {...ICON_PROPS}><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>);
const HEART_ICON = (<svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full"><path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" /></svg>);
const LAYOUT_ICON = (<svg {...ICON_PROPS}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>);

const CmdIcon = ({ name }) => {
  const cls = 'w-4 h-4';
  switch (name) {
    case 'search':    return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>);
    case 'bolt':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" /></svg>);
    case 'grid':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></svg>);
    case 'flame':     return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3c1 4 5 5 5 9a5 5 0 11-10 0c0-2 1-3 2-4-1 4 3 4 3 0 0-2 0-3 0-5z" /></svg>);
    case 'ball':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18M5.5 5.5l13 13M18.5 5.5l-13 13" /></svg>);
    case 'broadcast': return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cls}><path strokeLinecap="round" strokeLinejoin="round" d="M4.93 19.07a10 10 0 010-14.14M19.07 4.93a10 10 0 010 14.14M8.46 16.46a5 5 0 010-7.07M15.54 9.39a5 5 0 010 7.07" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg>);
    case 'play':      return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={cls}><rect x="2.5" y="6" width="19" height="12" rx="3" /><path d="M11 9.5l4 2.5-4 2.5v-5z" fill="currentColor" stroke="none" /></svg>);
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
