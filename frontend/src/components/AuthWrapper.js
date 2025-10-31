/**
 * AuthWrapper Component
 * Wraps the application and handles authentication state
 * Shows login/register or allows users to continue without authentication
 */
import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Login from './Login';
import Register from './Register';
import SessionManager from '../utils/sessionManager';

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
    return (
      <>
        {/* Show user info badge if authenticated */}
        {isAuthenticated && user && (
          <div className="fixed right-4 top-4 z-50">
            <UserBadge user={user} />
          </div>
        )}
        {children}
      </>
    );
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
const UserBadge = ({ user }) => {
  const { logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const handleLogout = async () => {
    await logout();
    window.location.reload();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-slate-100 shadow-lg shadow-slate-950/30 transition-colors hover:bg-slate-800"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 text-sm font-bold text-white">
          {user.username.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-medium">{user.username}</span>
        <svg
          className={`h-4 w-4 transition-transform ${showMenu ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {showMenu && (
        <div className="absolute right-0 mt-2 w-48 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl shadow-slate-950/30">
          <div className="border-b border-slate-800 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Signed in as</p>
            <p className="truncate text-sm font-semibold text-slate-100">{user.email}</p>
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

export default AuthWrapper;
