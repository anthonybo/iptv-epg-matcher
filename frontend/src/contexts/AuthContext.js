/**
 * Authentication Context
 * Provides authentication state and methods throughout the app
 */
import React, { createContext, useState, useContext, useEffect } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../config';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load token from localStorage on mount
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const storedToken = localStorage.getItem('auth_token');

        if (!storedToken) {
          setLoading(false);
          return;
        }

        // Verify token is still valid by fetching user info
        const response = await axios.get(`${API_BASE_URL}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${storedToken}`
          }
        });

        if (response.data.success) {
          setToken(storedToken);
          setUser(response.data.user);
          console.log('[AuthContext] Restored user session:', response.data.user.username);
        } else {
          // Token invalid, clear it
          localStorage.removeItem('auth_token');
        }
      } catch (error) {
        console.error('[AuthContext] Failed to restore session:', error);
        localStorage.removeItem('auth_token');
      } finally {
        setLoading(false);
      }
    };

    loadAuth();
  }, []);

  /**
   * Register a new user
   */
  const register = async (username, email, password, sessionId) => {
    try {
      setError(null);

      const response = await axios.post(`${API_BASE_URL}/api/auth/register`, {
        username,
        email,
        password,
        sessionId
      });

      if (response.data.success) {
        const { user: newUser, token: newToken } = response.data;

        // Save token to localStorage
        localStorage.setItem('auth_token', newToken);

        // Update state
        setToken(newToken);
        setUser(newUser);

        console.log('[AuthContext] User registered successfully:', newUser.username);
        return { success: true, user: newUser };
      }

      return { success: false, error: 'Registration failed' };
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      console.error('[AuthContext] Registration error:', errorMessage);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  /**
   * Login with username/email and password
   */
  const login = async (usernameOrEmail, password, sessionId) => {
    try {
      setError(null);

      const response = await axios.post(`${API_BASE_URL}/api/auth/login`, {
        usernameOrEmail,
        password,
        sessionId
      });

      if (response.data.success) {
        const { user: loggedInUser, token: newToken } = response.data;

        // Save token to localStorage
        localStorage.setItem('auth_token', newToken);

        // Update state
        setToken(newToken);
        setUser(loggedInUser);

        console.log('[AuthContext] User logged in successfully:', loggedInUser.username);
        return { success: true, user: loggedInUser };
      }

      return { success: false, error: 'Login failed' };
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      console.error('[AuthContext] Login error:', errorMessage);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  /**
   * Logout current user
   */
  const logout = async () => {
    try {
      if (token) {
        // Call logout endpoint to invalidate session
        await axios.post(
          `${API_BASE_URL}/api/auth/logout`,
          {},
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
      }
    } catch (error) {
      console.error('[AuthContext] Logout error:', error);
      // Continue with logout even if API call fails
    } finally {
      // Clear local state
      localStorage.removeItem('auth_token');
      setToken(null);
      setUser(null);
      console.log('[AuthContext] User logged out');
    }
  };

  /**
   * Link existing session data to authenticated user
   */
  const linkSession = async (sessionId) => {
    try {
      if (!token) {
        return { success: false, error: 'Not authenticated' };
      }

      const response = await axios.post(
        `${API_BASE_URL}/api/auth/link-session`,
        { sessionId },
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (response.data.success) {
        console.log('[AuthContext] Session linked successfully:', response.data.linked);
        return { success: true, linked: response.data.linked };
      }

      return { success: false, error: 'Failed to link session' };
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      console.error('[AuthContext] Link session error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  /**
   * Refresh user data
   */
  const refreshUser = async () => {
    try {
      if (!token) {
        return;
      }

      const response = await axios.get(`${API_BASE_URL}/api/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (response.data.success) {
        setUser(response.data.user);
      }
    } catch (error) {
      console.error('[AuthContext] Failed to refresh user:', error);
    }
  };

  const value = {
    user,
    token,
    loading,
    error,
    isAuthenticated: !!user,
    register,
    login,
    logout,
    linkSession,
    refreshUser
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
