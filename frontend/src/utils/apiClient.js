import axios from 'axios';
import SessionManager from './sessionManager';

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
  (error) => {
    // Check if this is an authentication error (401)
    if (error.response && error.response.status === 401) {
      console.warn('Authentication expired, clearing auth token and redirecting to login');
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user');
      // Redirect to login page
      window.location.href = '/login';
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