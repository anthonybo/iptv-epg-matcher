import React from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { showToast } from '../Toast';
import Configuration from '../../Configuration';
import iptvSourcesService from '../../services/iptvSourcesService';

/**
 * Global Add-IPTV-Source modal.
 *
 * Lives in <AppLayout> rather than inside the MyIPTVs page so a
 * bulk-add can be minimized and survive page navigation. Previously the
 * modal (including the BulkAddSources orchestrator + its EventSource
 * subscriptions + the queue pump) was rendered inside MyIPTVs, so the
 * moment you switched away from that page the entire bulk-add died and
 * any queued sources evaporated.
 *
 * State + visibility comes from AppContext:
 *   - showAddModal           — true = visible, false = invisible (but DOM-mounted while loading)
 *   - backgroundLoadings     — keeps the modal alive when minimized
 *   - sourceListRevision     — bumped on every change so MyIPTVs / userSources refresh
 */
export default function AddSourceModal() {
  const {
    showAddModal,
    setShowAddModal,
    backgroundLoadings,
    setBackgroundLoadings,
    bumpSourceListRevision,
    setUserSources,
    loadingError,
  } = useAppContext();

  // Keep `userSources` in AppContext fresh whenever something changes.
  // Same fetch the App.js handler used to do — wired here directly so
  // the modal doesn't need a callback prop from App.js.
  const refreshUserSources = async () => {
    try {
      const sources = await iptvSourcesService.getUserSources();
      setUserSources(sources);
    } catch (err) {
      console.error('[AddSourceModal] Failed to reload user sources', err);
    }
  };

  // Render the modal whenever it's explicitly visible OR there's any
  // background-load entry (single-source or 'bulk-add'). Keeps the
  // BulkAddSources component mounted while minimized — that's what
  // preserves the EventSources + queue across page navigation.
  if (!showAddModal && backgroundLoadings.size === 0) return null;

  const minimized = !showAddModal;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 transition-opacity duration-200 ${
        showAddModal ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div
        className={`bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col transition-transform duration-200 ${
          showAddModal ? 'scale-100' : 'scale-95'
        }`}
      >
        {/* Modal Header */}
        <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-semibold text-slate-100">Add IPTV Source</h3>
            {backgroundLoadings.has?.('bulk-add') && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-300 bg-blue-500/15 border border-blue-500/30">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-400" />
                </span>
                Loading in background
              </span>
            )}
          </div>
          <button
            onClick={() => setShowAddModal(false)}
            className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 hover:bg-slate-700 rounded-lg"
            title={
              backgroundLoadings.size > 0
                ? 'Minimize — loading continues in the background'
                : 'Close'
            }
          >
            {backgroundLoadings.size > 0 ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 13H5" />
                </svg>
                <span className="text-xs">Minimize</span>
              </>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <Configuration
            embedded
            onSourceCompleted={async () => {
              // A bulk-added source just finished — refresh the user
              // source list so MyIPTVs (if mounted) sees it. Even when
              // minimized this still fires because BulkAddSources is
              // alive in this always-mounted modal.
              bumpSourceListRevision();
              await refreshUserSources();
            }}
            onLoad={async (data) => {
              if (data?.bulk) {
                bumpSourceListRevision();
                await refreshUserSources();

                const done = data.done || 0;
                const failed = data.failed || 0;
                const total = data.total || done + failed;
                showToast(
                  failed
                    ? `${done} of ${total} sources loaded (${failed} failed). Review the list for details.`
                    : `Loaded ${done} source${done === 1 ? '' : 's'}.`,
                  failed ? 'info' : 'success',
                  7000
                );
                return;
              }

              // Single-source (xtream/stalker) load completed.
              setShowAddModal(false);
              setBackgroundLoadings(new Map());
              bumpSourceListRevision();
              await refreshUserSources();

              showToast(
                `Source added with ${data?.channelCount || 0} channels. Use the test button to check stream connectivity.`,
                'success',
                5000
              );
            }}
            error={loadingError}
            allowedTabs={['xtream', 'stalker', 'bulk']}
            onLoadingChange={(isLoading, sessionId, status, variant) => {
              if (isLoading && sessionId) {
                // The synthetic 'bulk-add' session represents the entire
                // batch (not a single source), so label it explicitly
                // instead of trying to extract a hostname.
                let sourceName = sessionId === 'bulk-add' ? 'Bulk Add' : 'IPTV Source';
                if (status && sessionId !== 'bulk-add') {
                  const portalMatch = status.match(/portal[:\s]+([^\s,]+)/i);
                  const serverMatch = status.match(/server[:\s]+([^\s,]+)/i);
                  if (portalMatch) sourceName = portalMatch[1];
                  else if (serverMatch) sourceName = serverMatch[1];
                }

                setBackgroundLoadings((prev) => {
                  const next = new Map(prev);
                  next.set(sessionId, { sessionId, status, variant, sourceName });
                  return next;
                });
              } else if (sessionId) {
                setBackgroundLoadings((prev) => {
                  const next = new Map(prev);
                  next.delete(sessionId);
                  return next;
                });
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
