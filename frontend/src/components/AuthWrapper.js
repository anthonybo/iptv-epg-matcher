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
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-white">Loading...</p>
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
          <div className="fixed top-4 right-4 z-50">
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
        className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg shadow-lg transition-colors"
      >
        <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-sm font-bold">
          {user.username.charAt(0).toUpperCase()}
        </div>
        <span className="text-sm font-medium">{user.username}</span>
        <svg
          className={`w-4 h-4 transition-transform ${showMenu ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {showMenu && (
        <div className="absolute right-0 mt-2 w-48 bg-gray-800 rounded-lg shadow-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700">
            <p className="text-sm text-gray-400">Signed in as</p>
            <p className="text-sm font-medium text-white truncate">{user.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-gray-700 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
