import axios from 'axios';
import SessionManager from './sessionManager';
import { refreshAuthToken, redirectToLogin } from './authToken';

/**
 * Configured axios instance with interceptors for handling session errors
 */
const apiClient = axios.create({
  baseURL: '/api'
});

// Add request interceptor to check session and add auth token
apiClient.interceptors.request.use(
  async (config) => {
    // Add JWT token if available
    const token = localStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Extract session ID from the URL if present
    const urlSessionIdMatch = config.url.match(/\/([a-f0-9]{8})(?:\/|$|\?)/);
    const urlSessionId = urlSessionIdMatch ? urlSessionIdMatch[1] : null;

    // If there's a session ID in the URL, validate it
    if (urlSessionId) {
      const isValid = await SessionManager.validateSession(urlSessionId);

      if (!isValid) {
        // Cancel the request and trigger session reset
        SessionManager.clearSession();
        return Promise.reject(new axios.Cancel('Invalid session'));
      }
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Add response interceptor to catch session and auth errors
apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    // Authentication error (401): try a SILENT token refresh and
    // retry the original request once before giving up. This turns
    // the weekly token expiry from "kicked to the login screen
    // mid-session" into a transparent reconnect. Only when the
    // refresh itself fails (token expired beyond the server grace
    // window, bad signature, user gone) do we clear creds + redirect.
    const original = error.config;
    const isRefreshCall = original && String(original.url || '').includes('/auth/refresh');

    if (error.response && error.response.status === 401 && original && !original._retried && !isRefreshCall) {
      original._retried = true;
      const newToken = await refreshAuthToken();
      if (newToken) {
        original.headers = original.headers || {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original); // replay with the fresh token
      }
      // Refresh failed → session is genuinely dead.
      console.warn('Token refresh failed; redirecting to login');
      redirectToLogin();
      return Promise.reject(new Error('Your session has expired. Please log in again.'));
    }

    if (error.response && error.response.status === 401) {
      // A 401 on the refresh call itself, or an already-retried
      // request → terminal.
      redirectToLogin();
      return Promise.reject(new Error('Your session has expired. Please log in again.'));
    }

    // Check if this is a session not found error
    if (error.response && error.response.status === 404) {
      // Look for "Session not found" in the error message
      const errorMessage = error.response.data?.error || '';
      if (errorMessage.toLowerCase().includes('session not found')) {
        console.warn('Session not found, clearing session data');
        SessionManager.clearSession();
        return Promise.reject(new Error('Your session has expired. Please reload your data.'));
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;