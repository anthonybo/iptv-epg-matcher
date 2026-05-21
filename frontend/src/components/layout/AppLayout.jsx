import React from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import Sidebar from '../../Sidebar';
import SessionDebugger from '../SessionDebugger';
import { ServerStatusModal } from '../modals/ServerStatusModal';
import { LoadingPickerModal } from '../modals/LoadingPickerModal';
import AddSourceModal from '../modals/AddSourceModal';
import { UserBadge } from '../AuthWrapper';
import TheatreView from '../../TheatreView';

export function AppLayout({ children, fetchCategoriesFromApi, onExitTheatre, onEpgMatch }) {
  const {
    sessionId,
    showSidebar,
    setShowSidebar,
    activeTab,
    totalChannels,
    categories,
    matchedChannels,
    totalMatches,
    epgSources,
    userSources,
    sessionDebuggerOpen,
    setSessionDebuggerOpen,
    showServerStatus,
    setShowServerStatus,
    backgroundLoadings,
    setBackgroundLoadings,
    showLoadingPicker,
    setShowLoadingPicker,
    showAddModal,
    setShowAddModal,
    setActiveTab,
    isTheatreMode,
    selectedChannel,
  } = useAppContext();

  // Drop a single stuck "loading" entry. Used by the bubble's
  // hover-popup dismiss buttons. The backend may or may not still
  // be working in the background — we only clear our local tracking,
  // which is what was making the bubble appear forever after the
  // SSE pipe dropped a 'complete' event.
  const clearBackgroundLoading = (sessionIdToClear) => {
    setBackgroundLoadings((prev) => {
      const next = new Map(prev);
      next.delete(sessionIdToClear);
      return next;
    });
  };
  const clearAllBackgroundLoading = () => setBackgroundLoadings(new Map());

  const { user, isAuthenticated: authIsAuthenticated } = useAuth();

  const toggleSidebar = () => {
    setShowSidebar(prev => !prev);
  };

  const handleReset = () => {
    window.location.reload();
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 font-sans text-slate-100">
      {isTheatreMode && activeTab === 'player' && (
        <TheatreView
          sessionId={sessionId}
          selectedChannel={selectedChannel}
          matchedChannels={matchedChannels}
          onEpgMatch={onEpgMatch}
          onExitTheatre={onExitTheatre}
        />
      )}

      {!isTheatreMode && (
        <header className="sticky top-0 z-[60] flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-1.5 shadow-lg shadow-slate-950/20">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSidebar}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950"
            aria-label="Toggle sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          {sessionId && (
            <div className="hidden items-center rounded-full border border-blue-400/40 bg-blue-500/15 px-2 py-0.5 text-[9px] font-semibold text-blue-200 sm:inline-flex">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mr-1 h-2.5 w-2.5"
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              {typeof sessionId === 'string' ? sessionId : 'Loading...'}
            </div>
          )}
        </div>

        <div className="flex flex-1 items-center justify-center px-2">
          <h1 className="text-xs font-semibold text-blue-300 sm:text-sm">IPTV Guru</h1>
        </div>

        <div className="flex items-center gap-2">
          {sessionId && activeTab === 'channels' && (
            <button
              type="button"
              onClick={async () => {
                console.log('[AppLayout] Manually reloading categories');
                await fetchCategoriesFromApi(sessionId);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-200 transition hover:bg-emerald-500/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6"></path>
                <path d="M1 20v-6h6"></path>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
                <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
              Reload ({categories.length})
            </button>
          )}

          {authIsAuthenticated && user && (
            <UserBadge
              user={user}
              onOpenSessionDebugger={() => setSessionDebuggerOpen(true)}
              onOpenServerStatus={() => setShowServerStatus(true)}
            />
          )}
        </div>
      </header>
      )}

      <div className="flex flex-1">
        {!isTheatreMode && (
          <Sidebar
            showSidebar={showSidebar}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            handleReset={handleReset}
            totalChannels={totalChannels}
            categoryCount={categories.length}
            matchedChannelCount={Object.keys(matchedChannels).length}
            totalMatchesCount={totalMatches}
            epgSourceCount={epgSources.length}
            userSourcesCount={userSources.length}
          />
        )}

        <main className="flex-1 overflow-y-auto bg-slate-950">
          {children}
        </main>
      </div>

      {backgroundLoadings.size > 0 && (
        <div
          className="fixed bottom-6 right-6 z-50 cursor-pointer group"
          onClick={() => {
            if (backgroundLoadings.size === 1) {
              setActiveTab('myiptvs');
              setShowAddModal(true);
            } else {
              setShowLoadingPicker(true);
            }
          }}
          title={`${backgroundLoadings.size} source${backgroundLoadings.size > 1 ? 's' : ''} loading - click to view`}
        >
          <div className="relative">
            <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-75"></div>

            <div className="relative bg-gradient-to-br from-blue-500 to-blue-600 rounded-full p-3 shadow-lg border border-blue-400/30 transition-all duration-200 group-hover:scale-110 group-hover:shadow-xl">
              <svg className="w-6 h-6 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>

              {backgroundLoadings.size > 1 && (
                <div className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center border-2 border-slate-900">
                  {backgroundLoadings.size}
                </div>
              )}

              {/* Hover popover — bumped to group-hover/focus-within
                  so the dismiss buttons inside don't dismiss the
                  popup the moment the mouse leaves the bubble. */}
              <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-80 pointer-events-auto">
                <div className="bg-slate-800 text-white text-xs rounded-lg shadow-xl border border-slate-600 max-h-80 overflow-hidden flex flex-col">
                  {/* Header strip — title + global dismiss-all when
                      more than one entry is stuck. */}
                  <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-700/80 bg-slate-900/40">
                    <div className="font-semibold text-[12px]">
                      {backgroundLoadings.size === 1 ? 'Background Loading' : `${backgroundLoadings.size} Sources Loading`}
                    </div>
                    {backgroundLoadings.size > 1 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); clearAllBackgroundLoading(); }}
                        title="Dismiss all tracking — work may still be running in the background"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-[0.14em] text-slate-400 hover:bg-rose-500/15 hover:text-rose-200 transition"
                      >
                        Dismiss all
                      </button>
                    )}
                  </div>

                  {/* Per-entry list. Each row has a small × that
                      drops just that sessionId so the user can
                      surgically clear a single stuck entry. */}
                  <div className="px-3 py-2 space-y-2 overflow-y-auto">
                    {Array.from(backgroundLoadings.values()).map((loading) => (
                      <div
                        key={loading.sessionId}
                        className="group/row flex items-start gap-2 border-t border-slate-700/60 pt-2 first:border-t-0 first:pt-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-blue-300 mb-0.5 truncate">{loading.sourceName}</div>
                          <div className="text-slate-300 text-[11px] break-words">
                            {loading.status || 'Processing…'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); clearBackgroundLoading(loading.sessionId); }}
                          title="Dismiss this loading indicator. The backend may still be working — this just clears the UI bubble."
                          className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-slate-500 hover:bg-rose-500/15 hover:text-rose-200 transition"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Footer hint */}
                  <div className="px-3 py-2 text-slate-400 text-[10px] border-t border-slate-700 leading-relaxed">
                    {backgroundLoadings.size === 1
                      ? 'Click bubble to view details. Click × to dismiss if it\'s stuck.'
                      : 'Click bubble to pick a source. Click × on a row to dismiss it.'}
                  </div>
                  <div className="absolute top-full right-6 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-slate-800"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global Add-IPTV-Source modal. Mounted at the layout level so a
          minimized bulk-add survives navigation to other pages. */}
      <AddSourceModal />

      <LoadingPickerModal
        isOpen={showLoadingPicker}
        onClose={() => setShowLoadingPicker(false)}
        backgroundLoadings={backgroundLoadings}
      />

      <SessionDebugger
        isOpen={sessionDebuggerOpen}
        onClose={() => setSessionDebuggerOpen(false)}
      />

      <ServerStatusModal
        isOpen={showServerStatus}
        onClose={() => setShowServerStatus(false)}
      />
    </div>
  );
}
