/**
 * Global configuration settings
 */

// config.js - Application configuration

/**
 * Configuration object for the application
 */
const resolveDefaultApiUrl = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // In development we rely on Vite proxy by using relative /api routes
  if (import.meta.env.DEV) {
    return '';
  }

  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.protocol}//${window.location.host}`;
  }

  return '';
};

const config = {
  // API Base URL - Backend server
  apiUrl: resolveDefaultApiUrl(),

  // Debug mode
  debugMode: import.meta.env.VITE_DEBUG === 'true' || import.meta.env.DEV,

  // Environment
  environment: import.meta.env.MODE || 'development',

  // Version
  version: import.meta.env.VITE_VERSION || '1.0.0'
};

// Export API base URL for services
export const API_BASE_URL = config.apiUrl;

// Log configuration on load in development
if (config.debugMode) {
  console.log('[CONFIG] API Base URL:', config.apiUrl || '(using relative URLs)');
  console.log('[CONFIG] App configuration loaded:', config);
}

export default config;

// Other configuration settings
export const DEFAULT_PAGINATION_LIMIT = 1000;
export const MAX_CHANNELS_PER_PAGE = 100;
export const DEFAULT_CATEGORY = 'all';

// Debug mode
export const DEBUG_MODE = import.meta.env.DEV;

// Session storage keys
export const SESSION_ID_KEY = 'currentSessionId';
export const FALLBACK_SESSION_ID_KEY = 'sessionId'; 
