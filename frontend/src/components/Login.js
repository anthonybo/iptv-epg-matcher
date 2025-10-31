/**
 * Login Component
 * Allows users to log in to their account
 */
import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

const Login = ({ onSwitchToRegister, onSkip, sessionId }) => {
  const { login } = useAuth();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!usernameOrEmail || !password) {
      setError('Please enter both username/email and password');
      return;
    }

    setLoading(true);

    try {
      const result = await login(usernameOrEmail, password, sessionId);

      if (!result.success) {
        setError(result.error || 'Login failed');
      }
      // On success, AuthContext will update and App.js will re-render
    } catch (err) {
      setError('An unexpected error occurred');
      console.error('[Login] Error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950">
      <div className="w-full max-w-md rounded-2xl border border-slate-800/70 bg-slate-900/80 p-8 shadow-2xl shadow-slate-950/40">
        {/* Logo/Title */}
        <div className="text-center mb-8">
          <div className="mb-4 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
              <polyline points="17 2 12 7 7 2"></polyline>
            </svg>
          </div>
          <h1 className="mb-2 text-3xl font-bold text-slate-100">Welcome Back</h1>
          <p className="text-slate-400">Sign in to access your IPTV Guide</p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
            <p className="text-sm text-rose-200">{error}</p>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Username/Email Input */}
          <div>
            <label htmlFor="usernameOrEmail" className="mb-2 block text-sm font-medium text-slate-200">
              Username or Email
            </label>
            <input
              id="usernameOrEmail"
              type="text"
              value={usernameOrEmail}
              onChange={(e) => setUsernameOrEmail(e.target.value)}
              className="w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
              placeholder="Enter your username or email"
              autoComplete="username"
              disabled={loading}
            />
          </div>

          {/* Password Input */}
          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-slate-200">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
              placeholder="Enter your password"
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-all hover:shadow-xl hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <span className="flex items-center justify-center">
                <svg className="-ml-1 mr-3 h-5 w-5 animate-spin text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* Footer Links */}
        <div className="mt-6 space-y-4 text-center">
          <p className="text-sm text-slate-400">
            Don't have an account?{' '}
            <button
              onClick={onSwitchToRegister}
              className="font-medium text-blue-300 transition-colors hover:text-blue-200"
              disabled={loading}
            >
              Sign up
            </button>
          </p>

          {onSkip && (
            <button
              onClick={onSkip}
              className="text-sm text-slate-500 underline transition-colors hover:text-slate-300"
              disabled={loading}
            >
              Continue without an account
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Login;
