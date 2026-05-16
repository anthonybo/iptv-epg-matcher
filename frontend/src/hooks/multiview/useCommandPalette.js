import { useCallback, useEffect, useState } from 'react';

/**
 * useCommandPalette — owns open/close state for the multi-view
 * command palette and binds the global keymap (⌘K / Ctrl+K / "/").
 *
 * Returns { isOpen, open, close, toggle }. The actual list of
 * commands is constructed in MultiViewPage and passed to the
 * CommandPalette component — keeps actions co-located with their
 * handlers.
 */
export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  useEffect(() => {
    const onKey = (e) => {
      // ⌘K / Ctrl+K — toggle from anywhere.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toggle();
        return;
      }
      // "/" — open, but only when nothing else is taking input.
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target?.tagName || '').toLowerCase();
        const isEditable =
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          (e.target?.isContentEditable);
        if (!isEditable) {
          e.preventDefault();
          open();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toggle]);

  return { isOpen, open, close, toggle };
}
