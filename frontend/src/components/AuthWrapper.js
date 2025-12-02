/**
 * AuthWrapper Component
 * Wraps the application and handles authentication state
 * Shows login/register or allows users to continue without authentication
 */
import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Login from './Login';
import Register from './Register';
import SessionManager from '../utils/sessionManager';
import LocationSelector from './LocationSelector';

const AuthWrapper = ({ children }) => {
  const { isAuthenticated, loading, user } = useAuth();
  const [showAuth, setShowAuth] = useState(true); // Show auth screen by default
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

  // If authenticated or user skipped auth, show the app
  if (isAuthenticated || !showAuth) {
    return children;
  }

  // Show authentication screens
  if (authMode === 'login') {
    return (
      <Login
        onSwitchToRegister={() => setAuthMode('register')}
        onSkip={() => setShowAuth(false)}
        sessionId={sessionId}
      />
    );
  }

  return (
    <Register
      onSwitchToLogin={() => setAuthMode('login')}
      onSkip={() => setShowAuth(false)}
      sessionId={sessionId}
    />
  );
};

/**
 * UserBadge Component
 * Shows logged in user info with logout button
 */
const UserBadge = ({ user, onOpenSessionDebugger, onOpenServerStatus }) => {
  const { logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const handleLogout = async () => {
    await logout();
    window.location.reload();
  };

  const handleMenuItemClick = (callback) => {
    setShowMenu(false);
    callback?.();
  };

  return (
    <div className="relative z-[100]">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 shadow-lg shadow-slate-950/30 transition-colors hover:bg-slate-800"
      >
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">
          {user.username.charAt(0).toUpperCase()}
        </div>
        <span className="text-[11px] font-medium">{user.username}</span>
        <svg
          className={`h-3 w-3 transition-transform ${showMenu ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {showMenu && (
        <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl shadow-slate-950/30 z-[9999]">
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
        </div>
      )}
    </div>
  );
};

export { UserBadge };
export default AuthWrapper;
