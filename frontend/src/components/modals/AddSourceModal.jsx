import React from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { showToast } from '../Toast';
import Configuration from '../../Configuration';
import iptvSourcesService from '../../services/iptvSourcesService';

/**
 * Global Add-IPTV-Source modal.
 *
 * Lives in <AppLayout> rather than inside the MyIPTVs page so a
 * bulk-add can be minimized and survive page navigation. Previously
 * the modal (including BulkAddSources + EventSources + queue pump)
 * was rendered inside MyIPTVs, so switching away killed everything.
 *
 * Layout: max-w-4xl when bulk-add is running (more rows visible),
 * max-w-2xl otherwise. The modal header is its own band with a
 * live status chip + two clearly distinct buttons:
 *   - Minimize  (when bg work is active)  -> keeps loading alive
 *   - Close     (always)                   -> closes the modal
 *     The two buttons are visually different so the user can't
 *     accidentally tear down a 5-minute bulk-add.
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

  const refreshUserSources = async () => {
    try {
      const sources = await iptvSourcesService.getUserSources();
      setUserSources(sources);
    } catch (err) {
      console.error('[AddSourceModal] Failed to reload user sources', err);
    }
  };

  if (!showAddModal && backgroundLoadings.size === 0) return null;

  const bulkActive = backgroundLoadings.has?.('bulk-add');
  const anyActive = backgroundLoadings.size > 0;

  // Modal sizes up to 4xl while a bulk-add is running so the user can
  // see 12-15 source rows at once instead of 5-6.
  const modalWidth = bulkActive ? 'max-w-4xl' : 'max-w-2xl';

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${
        showAddModal ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
      style={{
        // Subtle two-tone vignette so the modal reads as floating
        // glass rather than a flat sheet over solid black.
        background:
          'radial-gradient(ellipse at center top, rgba(15,23,42,0.78) 0%, rgba(0,0,0,0.88) 70%)'
      }}
    >
      <div
        className={`relative w-full ${modalWidth} max-h-[92vh] bg-slate-950 border border-slate-800/80 rounded-2xl shadow-[0_30px_80px_-15px_rgba(0,0,0,0.8),0_0_0_1px_rgba(148,163,184,0.04)] overflow-hidden flex flex-col transition-transform duration-200 ${
          showAddModal ? 'scale-100' : 'scale-95'
        }`}
      >
        {/* Top accent hairline — cyan when work is in flight,
            emerald when idle. The visual at-a-glance "is this thing
            doing something" cue. */}
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 top-0 h-px ${
            anyActive
              ? 'bg-gradient-to-r from-transparent via-cyan-400/70 to-transparent'
              : 'bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent'
          }`}
        />

        {/* ── HEADER ─────────────────────────────────────────────── */}
        <header className="flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-800/80 bg-slate-950">
          <div className="flex items-center gap-3 min-w-0">
            {/* Module marker — small square icon tile, identity for the modal */}
            <span className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </span>
            <div className="min-w-0">
              <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-600 leading-tight">
                IPTV Sources
              </div>
              <h3 className="text-[15px] font-bold text-slate-100 leading-tight">
                Add IPTV Source
              </h3>
            </div>

            {/* Live status chip — pulsing LED + mono label. Stronger
                than the prior washed-out blue pill: amber while
                fetching/loading, distinct enough to read at a glance. */}
            {bulkActive && (
              <span className="ml-2 inline-flex items-center gap-2 px-2 py-1 rounded-md border border-amber-500/40 bg-amber-500/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inset-0 rounded-full bg-amber-400 animate-ping opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_6px_rgba(251,191,36,0.7)]" />
                </span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-200">
                  Loading
                </span>
              </span>
            )}
          </div>

          {/* Right-side action cluster. Two visually distinct buttons:
              MINIMIZE (cyan-toned, keeps work alive) and CLOSE
              (rose-on-hover, destroys the modal state). When no
              background work, only Close shows. */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {anyActive && (
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                title="Minimize — loading continues in the background. Reopen from the menu."
                className="group inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-cyan-500/30 bg-cyan-500/[0.06] text-cyan-200 hover:bg-cyan-500/10 hover:border-cyan-500/40 transition"
              >
                <svg className="w-3.5 h-3.5 transition group-hover:-translate-y-px" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 19h14" />
                </svg>
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                  Minimize
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                // When work is in flight, Close still just minimizes
                // (we never want to silently tear down a queue). The
                // user can fully exit by canceling from the bulk-add
                // panel itself.
                setShowAddModal(false);
              }}
              title={anyActive ? 'Close the window (loading continues)' : 'Close'}
              className="group inline-flex items-center justify-center h-8 w-8 rounded-md border border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-rose-500/15 hover:border-rose-500/40 hover:text-rose-200 transition"
            >
              <svg className="w-3.5 h-3.5 transition group-hover:rotate-90" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {/* ── BODY ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
          <Configuration
            embedded
            onSourceCompleted={async () => {
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
