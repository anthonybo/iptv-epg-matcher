/**
 * Session Management Service
 * Handles the storage and retrieval of session IDs with backup strategies
 */

// In-memory storage for active session ID
let currentSessionId = null;

// Storage keys
const PRIMARY_STORAGE_KEY = 'iptv_session_id';
const BACKUP_STORAGE_KEY = 'iptv_session_id_backup';

/**
 * Store a session ID in all available storages
 * @param {string} sessionId - The session ID to store
 * @returns {boolean} Success state
 */
export const storeSessionId = (sessionId) => {
  if (!sessionId) {
    console.error('Cannot store null/undefined session ID');
    return false;
  }

  console.log(`Storing session ID: ${sessionId}`);
  
  // Store in memory
  currentSessionId = sessionId;
  
  // Store in localStorage (with try-catch for private browsing mode)
  try {
    localStorage.setItem(PRIMARY_STORAGE_KEY, sessionId);
    localStorage.setItem(BACKUP_STORAGE_KEY, sessionId);
    localStorage.setItem('lastSessionTimestamp', Date.now().toString());
    console.log('Session ID stored in localStorage');
    return true;
  } catch (e) {
    console.error('Failed to store session ID in localStorage:', e);
    return false;
  }
};

/**
 * Get the current session ID from all available storage locations
 * @returns {string|null} The session ID or null if not found
 */
export const getSessionId = () => {
  // First try memory
  if (currentSessionId) {
    console.log(`Using in-memory session ID: ${currentSessionId}`);
    return currentSessionId;
  }
  
  // Then try localStorage primary key
  try {
    const primaryId = localStorage.getItem(PRIMARY_STORAGE_KEY);
    if (primaryId) {
      console.log(`Using primary localStorage session ID: ${primaryId}`);
      currentSessionId = primaryId; // Sync with memory
      return primaryId;
    }
  } catch (e) {
    console.warn('Error accessing primary localStorage:', e);
  }
  
  // Then try backup key
  try {
    const backupId = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (backupId) {
      console.log(`Using backup localStorage session ID: ${backupId}`);
      // Resync to primary storage
      storeSessionId(backupId);
      return backupId;
    }
  } catch (e) {
    console.warn('Error accessing backup localStorage:', e);
  }
  
  console.warn('No session ID found in any storage');
  return null;
};

/**
 * Clear all session storage
 */
export const clearSession = () => {
  currentSessionId = null;
  
  try {
    localStorage.removeItem(PRIMARY_STORAGE_KEY);
    localStorage.removeItem(BACKUP_STORAGE_KEY);
    localStorage.removeItem('lastSessionTimestamp');
    console.log('Session cleared from all storages');
  } catch (e) {
    console.warn('Error clearing localStorage:', e);
  }
};

/**
 * Create a custom session event that can be listened for
 * @param {string} sessionId - The session ID to broadcast
 */
export const broadcastSessionChange = (sessionId) => {
  if (!sessionId) return;
  
  try {
    window.dispatchEvent(new CustomEvent('sessionChange', {
      detail: { sessionId, timestamp: Date.now() }
    }));
    console.log(`Broadcast session change event: ${sessionId}`);
  } catch (e) {
    console.error('Error broadcasting session event:', e);
  }
};

/**
 * Initialize session from URL if present
 * Checks for a session parameter in the URL and uses it if found
 */
export const initSessionFromUrl = () => {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionParam = urlParams.get('session');
    
    if (sessionParam) {
      console.log(`Found session ID in URL: ${sessionParam}`);
      storeSessionId(sessionParam);
      return sessionParam;
    }
  } catch (e) {
    console.warn('Error parsing URL params:', e);
  }
  
  return null;
};

// Auto-init when imported
initSessionFromUrl();

export default {
  storeSessionId,
  getSessionId,
  clearSession,
  broadcastSessionChange
};