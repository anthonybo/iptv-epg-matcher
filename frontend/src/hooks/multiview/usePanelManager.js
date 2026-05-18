import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * usePanelManager — central registry for slide-in drawer panels.
 *
 * Behavior:
 *   - At most ONE panel visible (state === 'open') at a time. Opening a
 *     new panel automatically minimizes the currently-open one.
 *   - Many panels may be minimized simultaneously. Minimized panels
 *     remain mounted in the React tree so their hooks (search debounce,
 *     polling fetches) keep running — they're just hidden via display:
 *     none in DrawerShell. This is the whole point: the user can pin
 *     a long search "down here" and keep watching streams.
 *   - close() is the only operation that fully unmounts a panel. Use
 *     it sparingly — most "X" clicks should probably minimize instead
 *     so the user doesn't lose in-flight work.
 *
 * State shape per panel:
 *   {
 *     id:         string                 unique key ('search', 'trending', …)
 *     state:      'open' | 'minimized'
 *     title:      string                 short label for the taskbar chip
 *     spineColor: string                 'cyan' | 'amber' | 'rose' | 'emerald' | …
 *     icon:       ReactNode              small SVG for the chip
 *     status:     { kind, text } | null  live status displayed in the chip
 *     openedAt:   number                 timestamp for stable ordering
 *   }
 *
 * The descriptor passed to open() can override any field except `id`
 * and `state`. The taskbar reads `title`, `spineColor`, `icon`, and
 * `status` from this shape so each module's identity propagates from
 * the page-level open() call.
 */
export default function usePanelManager() {
  const [panels, setPanels] = useState([]);

  // Keep a ref in sync so the imperative checkers below see fresh
  // state even in the same render. Callers occasionally need this
  // (e.g., a click handler that asks "am I already open?" before
  // opening, to avoid restoring a freshly-minimized panel).
  const panelsRef = useRef(panels);
  panelsRef.current = panels;

  const open = useCallback((id, descriptor = {}) => {
    setPanels((cur) => {
      // Minimize any currently-open peer first so the new panel has
      // the visible slot to itself.
      const others = cur.map((p) =>
        p.state === 'open' && p.id !== id
          ? { ...p, state: 'minimized' }
          : p
      );
      const idx = others.findIndex((p) => p.id === id);
      if (idx === -1) {
        return [
          ...others,
          {
            id,
            state: 'open',
            status: null,
            openedAt: Date.now(),
            title: id,
            spineColor: 'cyan',
            icon: null,
            ...descriptor
          }
        ];
      }
      return others.map((p, i) =>
        i === idx
          ? { ...p, state: 'open', ...descriptor }
          : p
      );
    });
  }, []);

  const minimize = useCallback((id) => {
    setPanels((cur) =>
      cur.map((p) => (p.id === id ? { ...p, state: 'minimized' } : p))
    );
  }, []);

  const restore = useCallback((id) => {
    setPanels((cur) =>
      cur.map((p) => {
        if (p.id === id) return { ...p, state: 'open' };
        // Same rule as open(): only one visible at a time.
        if (p.state === 'open') return { ...p, state: 'minimized' };
        return p;
      })
    );
  }, []);

  const close = useCallback((id) => {
    setPanels((cur) => cur.filter((p) => p.id !== id));
  }, []);

  // setStatus accepts either a plain object {kind, text} OR null
  // (clears). The chip animates based on `kind` ('working' breathes,
  // 'idle' is solid emerald, 'error' is solid rose, 'warn' is amber).
  //
  // CRITICAL: structurally compare to the current status and no-op if
  // unchanged. Modal effects fire their setStatus on every render
  // (inline-arrow callback identity churn) and without this guard
  // every call mints a new state array → re-renders the page → re-runs
  // the modal effect → infinite loop. With this guard, the redundant
  // calls are silently dropped.
  const setStatus = useCallback((id, status) => {
    setPanels((cur) => {
      const idx = cur.findIndex((p) => p.id === id);
      if (idx === -1) return cur;
      const prev = cur[idx].status;
      const next = status || null;
      const same =
        (prev === next) ||
        (prev && next && prev.kind === next.kind && prev.text === next.text);
      if (same) return cur;
      const out = cur.slice();
      out[idx] = { ...cur[idx], status: next };
      return out;
    });
  }, []);

  // Update arbitrary descriptor fields (title, icon, spineColor) on
  // an existing panel. Useful when a panel's identity shifts mid-life
  // — e.g., the search picker's title becomes "Search: 'eagles'" once
  // a query is committed.
  const updateDescriptor = useCallback((id, patch) => {
    setPanels((cur) =>
      cur.map((p) => (p.id === id ? { ...p, ...patch } : p))
    );
  }, []);

  // Toggle: if the panel is open, minimize it; if minimized, restore;
  // if not mounted, open with the descriptor. Lets a single rail-icon
  // click handler do the right thing in every state.
  const toggle = useCallback((id, descriptor = {}) => {
    const cur = panelsRef.current.find((p) => p.id === id);
    if (!cur) return open(id, descriptor);
    if (cur.state === 'open') return minimize(id);
    return restore(id);
  }, [open, minimize, restore]);

  // Read helpers — exposed as plain functions reading from the ref so
  // they're stable across renders. Useful in callbacks that don't
  // want to take a re-render-triggering dependency on the panel list.
  const isMounted = useCallback(
    (id) => panelsRef.current.some((p) => p.id === id),
    []
  );
  const isOpen = useCallback(
    (id) => panelsRef.current.some((p) => p.id === id && p.state === 'open'),
    []
  );
  const get = useCallback(
    (id) => panelsRef.current.find((p) => p.id === id) || null,
    []
  );

  // Derived collections for the page render.
  const openPanel = useMemo(
    () => panels.find((p) => p.state === 'open') || null,
    [panels]
  );
  const minimizedPanels = useMemo(
    () => panels.filter((p) => p.state === 'minimized'),
    [panels]
  );

  return {
    panels,
    openPanel,
    minimizedPanels,
    open,
    minimize,
    restore,
    close,
    toggle,
    setStatus,
    updateDescriptor,
    isMounted,
    isOpen,
    get
  };
}
