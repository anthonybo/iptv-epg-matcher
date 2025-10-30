/**
 * Global configuration settings
 */

// config.js - Application configuration

/**
 * Configuration object for the application
 */
const resolveDefaultApiUrl = () => {
  if (process.env.REACT_APP_API_URL) {
    return process.env.REACT_APP_API_URL;
  }

  // In development we rely on the CRA proxy by using relative /api routes
  if (process.env.NODE_ENV !== 'production') {
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
  debugMode: process.env.REACT_APP_DEBUG === 'true' || process.env.NODE_ENV !== 'production',
  
  // Environment
  environment: process.env.NODE_ENV || 'development',
  
  // Version
  version: process.env.REACT_APP_VERSION || '1.0.0'
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
export const DEBUG_MODE = process.env.NODE_ENV !== 'production';

// Session storage keys
export const SESSION_ID_KEY = 'currentSessionId';
export const FALLBACK_SESSION_ID_KEY = 'sessionId'; 
