/**
 * Global configuration settings
 */

// config.js - Application configuration

/**
 * Configuration object for the application
 */
const config = {
  // API Base URL - Backend server
  apiUrl: process.env.REACT_APP_API_URL || 'http://localhost:5001',
  
  // Debug mode
  debugMode: process.env.REACT_APP_DEBUG === 'true' || true,
  
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