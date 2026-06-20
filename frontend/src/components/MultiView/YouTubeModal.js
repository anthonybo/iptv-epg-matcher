import React, { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../utils/apiClient';
import useYouTubeFavorites from '../../hooks/multiview/useYouTubeFavorites';

/**
 * YouTubeModal — multi-view drawer for adding YouTube channels as tiles.
 *
 * Three modes, switchable via tabs:
 *
 *   1. URL / handle      — paste any youtube.com URL, @handle, or UC…
 *                          channel id. Resolve via yt-dlp, then either
 *                          "Add now" or "Save as favorite + add".
 *   2. Search             — yt-dlp ytsearch. Returns up to 8 channel
 *                          candidates with name, avatar, sample video.
 *   3. Favorites          — saved channels. One-click play; rename or
 *                          remove via the row's overflow controls.
 *                          Live-status probe shows a LIVE / OFFLINE dot.
 *
 * Visual language matches ChannelPickerModal: dense rows with a
 * left-edge rail (red for YouTube, to keep distinct from the other
 * drawer accents), 36px avatar, name + handle, action chips on the
 * right. Tabs reuse the same TabButton visual idiom.
 *
 * Props:
 *   isOpen         — mount flag from panel manager
 *   isVisible      — focus management
 *   onPick(stream) — fires with a fully-shaped multi-view stream
 *                    payload (sourceType='youtube', etc.); parent
 *                    forwards to multi-view's normal add-stream path.
 *   onAfterPick    — minimize the drawer on success
 *   onStatusChange — drawer dock status
 *   autoFocusRef   — input focus bridge for DrawerShell
 */
const YouTubeModal = ({
  isOpen,
  isVisible,
  onPick,
  onAfterPick,
  onStatusChange,
  autoFocusRef = null
}) => {
  const [activeTab, setActiveTab] = useState('url');
  const [pickingId, setPickingId] = useState(null);

  const inputRef = useRef(null);

  // URL / handle resolve state
  const [urlInput, setUrlInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const [resolvedChannel, setResolvedChannel] = useState(null);

  // Search state
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLastQuery, setSearchLastQuery] = useState(null);

  const favs = useYouTubeFavorites({ enabled: isOpen });

  // Refocus the active tab's input when the drawer becomes visible.
  useEffect(() => {
    if (!isVisible) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [isVisible, activeTab]);

  // Bridge focus method to DrawerShell.
  useEffect(() => {
    if (!autoFocusRef) return;
    autoFocusRef.current = { focus: () => inputRef.current?.focus() };
  }, [autoFocusRef]);

  // Probe live status on favorites once when the favorites tab is opened.
  const probedRef = useRef(false);
  useEffect(() => {
    if (activeTab === 'favorites' && !probedRef.current && favs.favorites.length > 0) {
      probedRef.current = true;
      favs.probeLiveStatuses();
    }
  }, [activeTab, favs.favorites.length, favs.probeLiveStatuses]);

  // Report status to the dock.
  useEffect(() => {
    if (!onStatusChange) return;
    if (activeTab === 'url') {
      if (resolving) onStatusChange({ kind: 'working', text: 'Resolving…' });
      else if (resolvedChannel) onStatusChange({ kind: 'idle', text: resolvedChannel.isLive ? 'LIVE' : 'Resolved' });
      else if (resolveError) onStatusChange({ kind: 'error', text: 'Error' });
      else onStatusChange({ kind: 'idle', text: 'URL' });
    } else if (activeTab === 'search') {
      if (searching) onStatusChange({ kind: 'working', text: 'Searching…' });
      else if (searchResults.length > 0) onStatusChange({ kind: 'idle', text: `${searchResults.length} channels` });
      else if (searchError) onStatusChange({ kind: 'error', text: 'Error' });
      else onStatusChange({ kind: 'idle', text: 'Search' });
    } else {
      if (favs.loading) onStatusChange({ kind: 'working', text: 'Loading…' });
      else onStatusChange({ kind: 'idle', text: favs.favorites.length ? `${favs.favorites.length} saved` : 'Favorites' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, resolving, resolvedChannel?.channelId, resolveError, searching, searchResults.length, searchError, favs.loading, favs.favorites.length]);

  /* ────────── Search ────────── */

  const handleSearch = useCallback(async (raw) => {
    const q = (raw ?? searchInput).trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    setSearchLastQuery(q);
    try {
      const r = await apiClient.get(`/youtube/search`, { params: { q, limit: 8 } });
      setSearchResults(Array.isArray(r.data?.results) ? r.data.results : []);
    } catch (e) {
      setSearchError(e.response?.data?.error || e.message);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchInput]);

  /* ────────── Resolve a URL / handle ────────── */

  // The resolve endpoint only accepts a URL, @handle, or UC… channel id, so a
  // bare name like "dads gone" is rejected. But users type channel NAMES into
  // this box expecting it to find the channel, so when the input isn't a
  // resolvable target, route it to Search instead of erroring out.
  const looksLikeYouTubeTarget = (s) =>
    /youtu\.?be|youtube\.com/i.test(s) ||
    /^https?:\/\//i.test(s) ||
    /^@[\w.-]+$/.test(s) ||
    /^UC[\w-]{20,}$/.test(s);

  const handleResolve = useCallback(async (raw) => {
    const input = (raw ?? urlInput).trim();
    if (!input) return;
    if (!looksLikeYouTubeTarget(input)) {
      setActiveTab('search');
      setSearchInput(input);
      handleSearch(input);
      return;
    }
    setResolving(true);
    setResolveError(null);
    setResolvedChannel(null);
    try {
      const r = await apiClient.post('/youtube/resolve', { input });
      const ch = r.data?.channel;
      if (!ch) throw new Error('No channel data returned.');
      setResolvedChannel(ch);
    } catch (e) {
      setResolveError(e.response?.data?.error || e.message);
    } finally {
      setResolving(false);
    }
  }, [urlInput, handleSearch]);

  /* ────────── Convert channel info → multi-view stream payload ────────── */

  const buildStream = useCallback((channel) => ({
    id: channel.channelId,
    name: channel.customName || channel.name || 'YouTube channel',
    logo: channel.avatarUrl || null,
    url: channel.channelUrl || `https://www.youtube.com/channel/${channel.channelId}`,
    sourceId: 0,                       // sentinel — non-IPTV source
    sourceType: 'youtube',
    sourceName: 'YouTube',
    sourceUrl: channel.channelUrl || null,
    sourceUsername: null,
    sourcePassword: null,
    sourceMac: null,
    // YouTube-specific extras (frontend tile uses these to render
    // OFFLINE state without re-resolving).
    ytChannelId: channel.channelId,
    ytHandle: channel.handle || null
  }), []);

  const handlePick = useCallback(async (channel) => {
    if (!onPick) return false;
    const stream = buildStream(channel);
    setPickingId(channel.channelId);
    try {
      const ok = await onPick(stream);
      if (ok && onAfterPick) onAfterPick();
      return ok;
    } finally {
      setPickingId(null);
    }
  }, [onPick, onAfterPick, buildStream]);

  const handleSaveAndAdd = useCallback(async (channel) => {
    setPickingId(channel.channelId);
    try {
      await favs.addFavorite(channel);
      await handlePick(channel);
    } finally {
      setPickingId(null);
    }
  }, [favs, handlePick]);

  const handleSaveOnly = useCallback(async (channel) => {
    setPickingId(channel.channelId);
    try {
      await favs.addFavorite(channel);
    } finally {
      setPickingId(null);
    }
  }, [favs]);

  if (!isOpen) return null;

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* ───────── Header / tabs ───────── */}
      <div className="flex-shrink-0 px-3 pt-3 pb-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900/60 p-0.5">
            <TabButton
              active={activeTab === 'url'}
              onClick={() => setActiveTab('url')}
              label="URL"
              accentColor="rose"
            />
            <TabButton
              active={activeTab === 'search'}
              onClick={() => setActiveTab('search')}
              label="Search"
              accentColor="rose"
              count={searchResults.length}
            />
            <TabButton
              active={activeTab === 'favorites'}
              onClick={() => setActiveTab('favorites')}
              label="Favorites"
              accentColor="amber"
              count={favs.favorites.length}
              loading={favs.loading}
              icon={
                <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor">
                  <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
                </svg>
              }
            />
          </div>
        </div>
      </div>

      {/* ───────── Body ───────── */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-3 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
        {activeTab === 'url' && (
          <UrlTab
            inputRef={inputRef}
            urlInput={urlInput}
            setUrlInput={setUrlInput}
            resolving={resolving}
            resolveError={resolveError}
            resolvedChannel={resolvedChannel}
            onResolve={handleResolve}
            onPick={handlePick}
            onSaveAndAdd={handleSaveAndAdd}
            onSaveOnly={handleSaveOnly}
            isFavorite={favs.isFavorite}
            pickingId={pickingId}
          />
        )}

        {activeTab === 'search' && (
          <SearchTab
            inputRef={inputRef}
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            searching={searching}
            searchError={searchError}
            searchResults={searchResults}
            searchLastQuery={searchLastQuery}
            onSearch={handleSearch}
            onPick={handlePick}
            onSaveAndAdd={handleSaveAndAdd}
            onSaveOnly={handleSaveOnly}
            isFavorite={favs.isFavorite}
            pickingId={pickingId}
          />
        )}

        {activeTab === 'favorites' && (
          <FavoritesTab
            favorites={favs.favorites}
            loading={favs.loading}
            error={favs.error}
            statusLoading={favs.statusLoading}
            liveStatusById={favs.liveStatusById}
            onPick={handlePick}
            onRefreshStatuses={favs.probeLiveStatuses}
            onRemove={favs.removeFavorite}
            onRename={favs.renameFavorite}
            pickingId={pickingId}
          />
        )}
      </div>

      {/* ───────── Footer ───────── */}
      <div className="flex-shrink-0 px-4 py-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
        <span className="font-mono normal-case tracking-normal text-[11px] text-slate-500 truncate">
          {activeTab === 'url'
            ? 'YouTube URL, @handle, or UC channel id'
            : activeTab === 'search'
            ? (searchLastQuery ? `Results for "${searchLastQuery}"` : 'Type a search term and press Enter')
            : `${favs.favorites.length} saved YouTube channel${favs.favorites.length === 1 ? '' : 's'}`}
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <kbd className="px-1 py-px rounded border border-slate-800 bg-slate-900 font-mono text-[9px] text-slate-500 normal-case tracking-normal">Esc</kbd>
          <span className="text-slate-700 normal-case tracking-normal">min</span>
        </span>
      </div>
    </div>
  );
};

/* ────────── URL TAB ────────── */

const UrlTab = ({
  inputRef, urlInput, setUrlInput, resolving, resolveError, resolvedChannel,
  onResolve, onPick, onSaveAndAdd, onSaveOnly, isFavorite, pickingId
}) => {
  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => { e.preventDefault(); onResolve(); }}
        className="relative"
      >
        <input
          ref={inputRef}
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://youtube.com/@channel  ·  @handle  ·  UC..."
          className="w-full px-3 py-2 pr-24 rounded-lg bg-slate-900/60 ring-1 ring-slate-800 focus:ring-rose-500/40 text-slate-100 text-sm font-mono outline-none placeholder:text-slate-600"
          autoComplete="off"
          spellCheck="false"
        />
        <button
          type="submit"
          disabled={resolving || !urlInput.trim()}
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1 rounded-md text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
            resolving
              ? 'bg-rose-500/15 text-rose-300 cursor-wait'
              : urlInput.trim()
              ? 'bg-rose-500/15 hover:bg-rose-500/25 ring-1 ring-rose-500/40 text-rose-200'
              : 'bg-slate-800/50 text-slate-600 cursor-not-allowed'
          }`}
        >
          {resolving ? '…' : 'Resolve'}
        </button>
      </form>

      {resolveError && (
        <div className="px-3 py-2 rounded-lg bg-rose-500/[0.06] ring-1 ring-rose-500/25 text-xs text-rose-200 font-mono">
          {resolveError}
        </div>
      )}

      {!resolveError && !resolvedChannel && !resolving && (
        <HelperBlock>
          <p>Pastes accepted:</p>
          <ul className="mt-1.5 ml-3 space-y-0.5 font-mono text-[11px] text-slate-500">
            <li>• <span className="text-slate-400">https://youtube.com/@LofiGirl</span></li>
            <li>• <span className="text-slate-400">@LofiGirl</span></li>
            <li>• <span className="text-slate-400">UCSJ4gkVC6NrvII8umztf0Ow</span></li>
            <li>• <span className="text-slate-400">youtube.com/watch?v=...</span></li>
          </ul>
        </HelperBlock>
      )}

      {resolvedChannel && (
        <ChannelRow
          channel={resolvedChannel}
          liveOverride={resolvedChannel.isLive}
          onPick={onPick}
          onSaveAndAdd={onSaveAndAdd}
          onSaveOnly={onSaveOnly}
          isFavorited={isFavorite(resolvedChannel.channelId)}
          isPicking={pickingId === resolvedChannel.channelId}
          showDescription
        />
      )}
    </div>
  );
};

/* ────────── SEARCH TAB ────────── */

const SearchTab = ({
  inputRef, searchInput, setSearchInput, searching, searchError, searchResults, searchLastQuery,
  onSearch, onPick, onSaveAndAdd, onSaveOnly, isFavorite, pickingId
}) => {
  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => { e.preventDefault(); onSearch(); }}
        className="relative"
      >
        <input
          ref={inputRef}
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search YouTube channels…"
          className="w-full px-3 py-2 pr-24 rounded-lg bg-slate-900/60 ring-1 ring-slate-800 focus:ring-rose-500/40 text-slate-100 text-sm outline-none placeholder:text-slate-600"
          autoComplete="off"
          spellCheck="false"
        />
        <button
          type="submit"
          disabled={searching || !searchInput.trim()}
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1 rounded-md text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
            searching
              ? 'bg-rose-500/15 text-rose-300 cursor-wait'
              : searchInput.trim()
              ? 'bg-rose-500/15 hover:bg-rose-500/25 ring-1 ring-rose-500/40 text-rose-200'
              : 'bg-slate-800/50 text-slate-600 cursor-not-allowed'
          }`}
        >
          {searching ? '…' : 'Search'}
        </button>
      </form>

      {searchError && (
        <div className="px-3 py-2 rounded-lg bg-rose-500/[0.06] ring-1 ring-rose-500/25 text-xs text-rose-200 font-mono">
          {searchError}
        </div>
      )}

      {!searching && !searchError && searchResults.length === 0 && (
        <HelperBlock>
          <p>YouTube search via yt-dlp.</p>
          <p className="mt-1 text-[11px] text-slate-600">
            Results are channels (deduped from video matches). Search takes
            2-5 seconds. Press Enter to run.
          </p>
        </HelperBlock>
      )}

      {searching && <SpinnerBlock label="Searching YouTube…" />}

      {searchResults.length > 0 && (
        <ul className="space-y-1.5">
          {searchResults.map((c) => (
            <ChannelRow
              key={c.channelId}
              channel={c}
              onPick={onPick}
              onSaveAndAdd={onSaveAndAdd}
              onSaveOnly={onSaveOnly}
              isFavorited={isFavorite(c.channelId)}
              isPicking={pickingId === c.channelId}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

/* ────────── FAVORITES TAB ────────── */

const FavoritesTab = ({
  favorites, loading, error, statusLoading, liveStatusById,
  onPick, onRefreshStatuses, onRemove, onRename, pickingId
}) => {
  if (loading) return <SpinnerBlock label="Loading favorites…" />;
  if (error) return (
    <div className="px-3 py-2 rounded-lg bg-rose-500/[0.06] ring-1 ring-rose-500/25 text-xs text-rose-200 font-mono">
      {error}
    </div>
  );
  if (favorites.length === 0) return (
    <HelperBlock>
      <p className="text-slate-300">No saved YouTube channels yet.</p>
      <p className="mt-1 text-[11px] text-slate-500">
        Resolve a URL or run a search, then tap <span className="text-amber-300/80">♥ Save</span>.
        Saved channels appear here and can be added to multi-view in one click.
      </p>
    </HelperBlock>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-600">
        <span>{favorites.length} saved · live status</span>
        <button
          type="button"
          onClick={onRefreshStatuses}
          disabled={statusLoading}
          className={`px-2 py-0.5 rounded-md font-mono text-[10px] tracking-normal normal-case transition ${
            statusLoading
              ? 'text-slate-500 cursor-wait'
              : 'text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10'
          }`}
          title="Re-probe each channel for current live status"
        >
          {statusLoading ? 'checking…' : 'refresh ↻'}
        </button>
      </div>
      <ul className="space-y-1.5">
        {favorites.map((f) => {
          const ch = {
            channelId: f.channelId,
            name: f.customName || f.name,
            handle: f.handle,
            avatarUrl: f.avatarUrl,
            channelUrl: f.channelUrl
          };
          const liveKnown = Object.prototype.hasOwnProperty.call(liveStatusById, f.channelId);
          const liveOverride = liveKnown ? liveStatusById[f.channelId] : null;
          return (
            <ChannelRow
              key={f.id}
              channel={ch}
              liveOverride={liveOverride}
              onPick={onPick}
              isPicking={pickingId === f.channelId}
              isFavorited
              onRemoveFavorite={() => onRemove(f.id)}
              onRenameFavorite={(name) => onRename(f.id, name)}
              isSavedRow
            />
          );
        })}
      </ul>
    </div>
  );
};

/* ────────── CHANNEL ROW (shared) ────────── */

const ChannelRow = ({
  channel,
  liveOverride = null,    // boolean | null. null = unknown.
  onPick,
  onSaveAndAdd,
  onSaveOnly,
  onRemoveFavorite,
  onRenameFavorite,
  isFavorited = false,
  isPicking = false,
  showDescription = false,
  isSavedRow = false
}) => {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(channel.name || '');

  const isLive = liveOverride === null ? channel.isLive : liveOverride;
  const liveKnown = liveOverride !== null || typeof channel.isLive === 'boolean';

  return (
    <li>
      <div
        className={`group/yt relative flex items-stretch gap-3 rounded-xl overflow-hidden transition ${
          isPicking
            ? 'bg-rose-500/[0.08] ring-1 ring-rose-500/40 cursor-wait'
            : 'bg-slate-900/40 hover:bg-slate-800/70 ring-1 ring-transparent hover:ring-slate-700/70'
        }`}
      >
        {/* Left rail — YouTube red */}
        <span
          className={`relative w-[3px] flex-shrink-0 self-stretch bg-gradient-to-b ${
            isLive
              ? 'from-rose-300 to-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
              : 'from-slate-500 to-slate-700 opacity-60'
          } transition`}
        >
          {isLive && (
            <span className="absolute -top-0.5 -left-0.5 -right-0.5 h-1.5 rounded-full bg-rose-300 animate-pulse" />
          )}
        </span>

        {/* Body */}
        <div className="flex-1 min-w-0 flex items-center gap-3 pr-3 py-2.5">
          {/* Avatar */}
          <div className="relative flex-shrink-0 w-9 h-9 rounded-full overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
            {channel.avatarUrl ? (
              <img
                src={channel.avatarUrl}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { e.target.style.display = 'none'; }}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-600 text-xs font-bold">
                {String(channel.name || '?').slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>

          {/* Name + handle + status pills */}
          <div className="flex-1 min-w-0">
            {renaming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onRenameFavorite?.(draftName.trim() || null);
                  setRenaming(false);
                }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => { setRenaming(false); setDraftName(channel.name || ''); }}
                  autoFocus
                  className="flex-1 min-w-0 px-2 py-0.5 rounded bg-slate-800 ring-1 ring-rose-500/40 text-sm text-slate-100 outline-none"
                />
              </form>
            ) : (
              <div className="text-sm font-semibold text-slate-100 truncate">
                {channel.name}
              </div>
            )}
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500 font-mono">
              {channel.handle && <span className="truncate max-w-[140px]">{channel.handle}</span>}
              {channel.handle && liveKnown && <span className="text-slate-700">·</span>}
              {liveKnown && (
                <span className={`inline-flex items-center gap-1 px-1.5 py-px rounded-sm text-[9px] font-bold uppercase tracking-[0.16em] ${
                  isLive
                    ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40'
                    : 'bg-slate-800/60 text-slate-500 ring-1 ring-slate-700/40'
                }`}>
                  {isLive ? <><span className="w-1 h-1 rounded-full bg-rose-400 animate-pulse" /> LIVE</> : 'OFFLINE'}
                </span>
              )}
            </div>
            {showDescription && channel.description && (
              <div className="mt-1.5 text-[11px] text-slate-500 line-clamp-2 leading-tight">
                {channel.description.slice(0, 160)}
              </div>
            )}
          </div>

          {/* Right-side actions */}
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {!isSavedRow && (onSaveOnly || onSaveAndAdd) && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); (onSaveOnly || onSaveAndAdd)(channel); }}
                disabled={isPicking || isFavorited}
                className={`p-1.5 rounded-md transition ${
                  isFavorited
                    ? 'text-amber-300/90 cursor-default'
                    : 'text-slate-500 hover:text-amber-300 hover:bg-amber-500/10'
                }`}
                title={isFavorited ? 'Saved to favorites' : 'Save to favorites'}
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5}>
                  <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
                </svg>
              </button>
            )}
            {isSavedRow && onRenameFavorite && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setRenaming(true); setDraftName(channel.name || ''); }}
                className="p-1.5 rounded-md text-slate-500 hover:text-cyan-300 hover:bg-cyan-500/10 transition"
                title="Rename"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 0 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                </svg>
              </button>
            )}
            {isSavedRow && onRemoveFavorite && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemoveFavorite(); }}
                className="p-1.5 rounded-md text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
                title="Remove favorite"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => onPick?.(channel)}
              disabled={isPicking}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
                isPicking
                  ? 'bg-rose-500/15 text-rose-200 cursor-wait'
                  : isLive === false && liveKnown
                  ? 'bg-slate-800/60 text-slate-500 hover:bg-slate-800 hover:text-slate-300 ring-1 ring-slate-700'
                  : 'bg-rose-500/20 hover:bg-rose-500/35 ring-1 ring-rose-500/40 text-rose-100'
              }`}
              title={isLive === false && liveKnown ? 'Add tile — channel is offline, will show OFFLINE state' : 'Add to multi-view'}
            >
              {isPicking ? '…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </li>
  );
};

/* ────────── Subcomponents ────────── */

const TabButton = ({ active, onClick, label, count, loading, accentColor = 'rose', icon }) => {
  const palette = accentColor === 'amber'
    ? { activeBg: 'bg-amber-500/10', activeRing: 'ring-amber-400/30', activeText: 'text-amber-200', activeCount: 'text-amber-300/90', dot: 'bg-amber-400' }
    : { activeBg: 'bg-rose-500/10',  activeRing: 'ring-rose-400/30',  activeText: 'text-rose-200',  activeCount: 'text-rose-300/90',  dot: 'bg-rose-400'  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
        active
          ? `${palette.activeBg} ring-1 ${palette.activeRing} ${palette.activeText}`
          : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/60'
      }`}
    >
      {icon && <span className={active ? palette.activeText : 'text-slate-500'}>{icon}</span>}
      <span>{label}</span>
      {(count !== undefined) && (
        <span className={`font-mono text-[10px] tabular-nums tracking-normal ${active ? palette.activeCount : 'text-slate-600'}`}>
          {loading ? '—' : count}
        </span>
      )}
      {active && <span className={`absolute -bottom-px left-2 right-2 h-px ${palette.dot} opacity-80`} />}
    </button>
  );
};

const HelperBlock = ({ children }) => (
  <div className="px-3 py-3 rounded-lg bg-slate-900/40 ring-1 ring-slate-800/70 text-xs text-slate-400 leading-relaxed">
    {children}
  </div>
);

const SpinnerBlock = ({ label }) => (
  <div className="px-3 py-10 flex flex-col items-center gap-3 text-slate-400">
    <div className="relative w-10 h-10">
      <div className="absolute inset-0 rounded-full border-2 border-slate-800" />
      <div className="absolute inset-0 rounded-full border-2 border-t-transparent animate-spin border-rose-400" />
    </div>
    <p className="text-xs font-mono tracking-tight text-slate-500">{label}</p>
  </div>
);

export default React.memo(YouTubeModal);
