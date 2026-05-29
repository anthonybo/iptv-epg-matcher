/**
 * AuthWrapper Component
 * Wraps the application and handles authentication state
 * Shows login/register or allows users to continue without authentication
 */
import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext';
import Login from './Login';
import Register from './Register';
import SessionManager from '../utils/sessionManager';
import LocationSelector from './LocationSelector';

const AuthWrapper = ({ children }) => {
  const { isAuthenticated, loading, user } = useAuth();
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'register'
  const [sessionId, setSessionId] = useState(null);

  // Load session ID once
  React.useEffect(() => {
    const loadSessionId = () => {
      const existingSessionId = SessionManager.getSessionId();
      setSessionId(existingSessionId);
    };

    loadSessionId();
  }, []);

  // If loading, show loading spinner
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-b-2 border-blue-500"></div>
          <p className="text-slate-300">Loading...</p>
        </div>
      </div>
    );
  }

  // Authentication is required — every core route is requireAuth-gated,
  // so a guest with no token gets 401'd out of every real feature.
  // Show the app only when authenticated; otherwise the login/register
  // screens. (The old "continue without an account" path rendered the
  // shell but bounced to login on the first protected API call.)
  if (isAuthenticated) {
    return children;
  }

  if (authMode === 'login') {
    return (
      <Login
        onSwitchToRegister={() => setAuthMode('register')}
        sessionId={sessionId}
      />
    );
  }

  return (
    <Register
      onSwitchToLogin={() => setAuthMode('login')}
      sessionId={sessionId}
    />
  );
};

/**
 * UserBadge Component
 * Shows logged in user info with logout button
 */
const UserBadge = ({
  user,
  onOpenSessionDebugger,
  onOpenServerStatus,
  // placement: 'bottom-right' (default — drops down + aligns right edge)
  //           | 'top-left'      (drops UP + aligns left edge — used in expanded sidebar bottom)
  //           | 'top-right'     (drops UP + aligns right edge)
  //           | 'right-bottom'  (pops to the RIGHT of trigger, bottom-aligned
  //                              — used in compact sidebar rail where the
  //                              trigger sits in a 56px column and an
  //                              upward menu would clip into the rail edges)
  placement = 'bottom-right',
  // variant: 'pill' (default — bordered avatar+name+chevron pill)
  //        | 'compact' (avatar-only square, for compact rail)
  //        | 'row'     (full-width avatar+name row, for expanded sidebar)
  variant = 'pill'
}) => {
  const { logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({});

  const handleLogout = async () => {
    await logout();
    window.location.reload();
  };

  const handleMenuItemClick = (callback) => {
    setShowMenu(false);
    callback?.();
  };

  // Position the portaled menu against the trigger's viewport rect. Each
  // placement variant picks an anchor edge + offset. Defensive clamps
  // keep the menu inside the viewport even when the trigger sits in a
  // corner (sidebar bottom on a short screen, etc.).
  const positionMenu = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const MARGIN = 8;
    const MENU_W = 224;     // w-56
    const MENU_H_EST = 320; // generous worst-case estimate for clamping

    let top, left;
    switch (placement) {
      case 'top-left':
        top  = rect.top - MARGIN;
        left = rect.left;
        // Translate Y by -100% via transform so the menu's bottom sits
        // on (top - margin). We accomplish that by setting top and
        // letting the transform anchor it.
        setMenuStyle({ position: 'fixed', top, left, transform: 'translateY(-100%)' });
        return;
      case 'top-right':
        top  = rect.top - MARGIN;
        left = rect.right - MENU_W;
        setMenuStyle({ position: 'fixed', top, left, transform: 'translateY(-100%)' });
        return;
      case 'right-bottom': {
        // Anchor menu's BOTTOM edge to trigger's bottom — menu grows up.
        top  = rect.bottom;
        left = rect.right + MARGIN;
        // Clamp horizontally: if menu would run off the right edge,
        // pin to viewport right with same margin.
        const maxLeft = window.innerWidth - MENU_W - MARGIN;
        if (left > maxLeft) left = maxLeft;
        // Clamp vertically: keep at least MENU_H_EST inside viewport.
        if (top < MENU_H_EST + MARGIN) {
          // not enough room above the anchor — fall back to align top to trigger top
          setMenuStyle({ position: 'fixed', top: Math.max(MARGIN, rect.top), left });
        } else {
          setMenuStyle({ position: 'fixed', top, left, transform: 'translateY(-100%)' });
        }
        return;
      }
      case 'bottom-right':
      default:
        top  = rect.bottom + MARGIN;
        left = rect.right - MENU_W;
        if (left < MARGIN) left = MARGIN;
        setMenuStyle({ position: 'fixed', top, left });
        return;
    }
  }, [placement]);

  useLayoutEffect(() => {
    if (!showMenu) return undefined;
    positionMenu();
    const onResize = () => positionMenu();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [showMenu, positionMenu]);

  // Click-outside / Esc to close. We compare against both refs since
  // the portaled menu lives elsewhere in the DOM.
  useEffect(() => {
    if (!showMenu) return undefined;
    const onClick = (e) => {
      if (
        triggerRef.current?.contains(e.target) ||
        menuRef.current?.contains(e.target)
      ) return;
      setShowMenu(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setShowMenu(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [showMenu]);

  const triggerClass =
    variant === 'compact' ? 'flex h-9 w-9 items-center justify-center rounded-md text-slate-300 hover:bg-slate-800/70 hover:text-slate-100 transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40'
  : variant === 'row'     ? 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-slate-200 hover:bg-slate-800/70 transition focus:outline-none focus:ring-1 focus:ring-cyan-500/40'
  :                         'flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 shadow-lg shadow-slate-950/30 transition-colors hover:bg-slate-800';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setShowMenu(!showMenu)}
        className={triggerClass}
        aria-label={`Account menu for ${user.username}`}
        aria-expanded={showMenu}
        aria-haspopup="menu"
      >
        <div className={`flex items-center justify-center rounded-full bg-cyan-500 text-[10px] font-bold text-slate-950 ${variant === 'compact' ? 'h-6 w-6 text-[11px]' : 'h-5 w-5'}`}>
          {user.username.charAt(0).toUpperCase()}
        </div>
        {variant !== 'compact' && (
          <span className={`font-medium truncate ${variant === 'row' ? 'flex-1 text-left text-[12px] text-slate-100' : 'text-[11px]'}`}>
            {user.username}
          </span>
        )}
        {variant !== 'compact' && (
          <svg
            className={`h-3 w-3 transition-transform ${showMenu ? 'rotate-180' : ''} ${variant === 'row' ? 'text-slate-500' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Dropdown Menu — portaled to document.body so it escapes every
          parent stacking context (sidebar's z-30 was clipping it under
          the multi-view rail, etc.). Positioned via getBoundingClientRect
          in the layout effect above. */}
      {showMenu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={menuStyle}
          className="w-56 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/60 backdrop-blur-md z-[9999]"
        >
          <div className="border-b border-slate-800 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Signed in as</p>
            <p className="truncate text-sm font-semibold text-slate-100">{user.email}</p>
          </div>

          {/* Location Section */}
          <div className="border-b border-slate-800">
            <div className="px-4 py-2">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Location</p>
            </div>
            <div className="px-2 pb-2">
              <LocationSelector compact={false} showLabel={true} className="w-full" />
            </div>
          </div>

          {/* Debugging Section */}
          <div className="border-b border-slate-800">
            <div className="px-4 py-2">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Debug Tools</p>
            </div>
            {onOpenServerStatus && (
              <button
                onClick={() => handleMenuItemClick(onOpenServerStatus)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-cyan-300 transition-colors hover:bg-slate-800"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
                Server Status
              </button>
            )}
            {onOpenSessionDebugger && (
              <button
                onClick={() => handleMenuItemClick(onOpenSessionDebugger)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-blue-300 transition-colors hover:bg-slate-800"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Session Debugger
              </button>
            )}
          </div>

          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-rose-300 transition-colors hover:bg-slate-800"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Logout
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};

export { UserBadge };
export default AuthWrapper;
