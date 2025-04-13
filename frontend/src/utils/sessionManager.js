/**
 * Session Manager utility for handling session persistence and validation
 * Provides centralized session management across the application
 */
import axios from 'axios';
import { API_BASE_URL } from '../config';

const SessionManager = {
    // Track validation attempts to prevent loops
    _validationAttempts: {},
    _maxValidationAttempts: 3,
    _validationCooldown: 10000, // 10 seconds

    /**
     * Get the current session ID from localStorage
     * @returns {string|null} The session ID or null if not found
     */
    getSessionId: () => {
      try {
        // Check multiple possible keys for compatibility
        const sessionId = localStorage.getItem('iptv_epg_session_id') || 
                         localStorage.getItem('sessionId') || 
                         localStorage.getItem('session_id');
        
        console.log(`[SessionManager] Retrieved session ID from storage: ${sessionId || 'not found'}`);
        
        if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
          console.log('[SessionManager] No valid session ID found, creating new one');
          return SessionManager.init();
        }
        
        return sessionId;
      } catch (error) {
        console.error('[SessionManager] Error retrieving session ID:', error);
        return null;
      }
    },
    
    /**
     * Initializes a session - creates a new one if needed or validates existing
     * @returns {Promise<string|null>} The session ID or null on failure
     */
    async init() {
      try {
        console.log('[SessionManager] Initializing session');
        
        // Try to get existing session ID
        let sessionId = localStorage.getItem('iptv_epg_session_id') || 
                        localStorage.getItem('sessionId') || 
                        localStorage.getItem('session_id');
        
        // If no session or invalid format, create a new one
        if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
          console.log('[SessionManager] No valid session found, creating new one');
          
          // Try to create a new session
          try {
            const response = await axios.post(`${API_BASE_URL}/api/session/create`);
            
            if (response.data && response.data.sessionId) {
              sessionId = response.data.sessionId;
              SessionManager.saveSessionId(sessionId);
              console.log(`[SessionManager] Created new session: ${sessionId}`);
            } else {
              throw new Error('Invalid response from session creation endpoint');
            }
          } catch (createError) {
            console.error('[SessionManager] Failed to create session via API:', createError);
            
            // As fallback, generate a client-side ID
            sessionId = 'session_' + Math.random().toString(36).substring(2, 15);
            SessionManager.saveSessionId(sessionId);
            console.log(`[SessionManager] Created fallback client-side session: ${sessionId}`);
          }
        } else {
          // Validate existing session
          console.log(`[SessionManager] Validating existing session: ${sessionId}`);
          
          const isValid = await SessionManager.validateSession(sessionId);
          if (!isValid) {
            console.log(`[SessionManager] Session ${sessionId} is invalid, creating new one`);
            
            // Try to create a new session
            try {
              const response = await axios.post(`${API_BASE_URL}/api/session/create`);
              
              if (response.data && response.data.sessionId) {
                sessionId = response.data.sessionId;
                SessionManager.saveSessionId(sessionId);
                console.log(`[SessionManager] Created new session: ${sessionId}`);
              } else {
                throw new Error('Invalid response from session creation endpoint');
              }
            } catch (createError) {
              console.error('[SessionManager] Failed to create session via API:', createError);
              
              // As fallback, generate a client-side ID
              sessionId = 'session_' + Math.random().toString(36).substring(2, 15);
              SessionManager.saveSessionId(sessionId);
              console.log(`[SessionManager] Created fallback client-side session: ${sessionId}`);
            }
          }
        }
        
        // Try to register session with the backend
        try {
          await axios.post(`${API_BASE_URL}/api/session/register`, { sessionId });
          console.log(`[SessionManager] Registered session with backend: ${sessionId}`);
        } catch (registerError) {
          console.warn('[SessionManager] Failed to register session with backend:', registerError);
          // Continue anyway, as the session ID is still valid for client use
        }
        
        return sessionId;
      } catch (error) {
        console.error('[SessionManager] Session initialization failed:', error);
        return null;
      }
    },
    
    /**
     * Save session ID to localStorage
     * @param {string} sessionId The session ID to save
     */
    saveSessionId: (sessionId) => {
      if (!sessionId) {
        console.warn('[SessionManager] Attempt to save invalid session ID:', sessionId);
        return;
      }
      
      try {
        console.log(`[SessionManager] Saving session ID to localStorage: ${sessionId}`);
        localStorage.setItem('iptv_epg_session_id', sessionId);
        localStorage.setItem('sessionId', sessionId);
        localStorage.setItem('session_id', sessionId);
        
        // Also add to window object for debugging
        window.currentSessionId = sessionId;
        
        console.log(`[SessionManager] Saved session ID: ${sessionId}`);
        
        // Dispatch a custom event for any listeners
        const event = new CustomEvent('sessionUpdated', { detail: { sessionId } });
        window.dispatchEvent(event);
        
        // Reset validation attempts for this session ID
        SessionManager._validationAttempts[sessionId] = {
          count: 0,
          lastAttempt: 0
        };
      } catch (e) {
        console.error('[SessionManager] Error saving session ID:', e);
      }
    },
    
    /**
     * Clear the current session ID and all related session data
     */
    clearSession: () => {
      console.log('[SessionManager] Clearing session data');
      try {
        // Get current session ID for cleanup
        const currentSessionId = SessionManager.getSessionId();
        
        // Clear session ID
        localStorage.removeItem('iptv_epg_session_id');
        localStorage.removeItem('sessionId');
        localStorage.removeItem('session_id');
        
        // Clear any other session-related data
        localStorage.removeItem('matchedChannels');
        
        // Clear window debug reference
        if (window.currentSessionId) {
          delete window.currentSessionId;
        }
        
        // Clean up validation attempts
        if (currentSessionId && SessionManager._validationAttempts[currentSessionId]) {
          delete SessionManager._validationAttempts[currentSessionId];
        }
        
        console.log('[SessionManager] Session data cleared successfully');
        
        // Reload the page to start fresh
        window.location.reload();
      } catch (e) {
        console.error('[SessionManager] Error clearing session data:', e);
      }
    },
    
    /**
     * Check if a session is valid by making a test request
     * @param {string} sessionId Session ID to validate
     * @returns {Promise<boolean>} Promise resolving to true if valid, false otherwise
     */
    validateSession: async (sessionId) => {
      if (!sessionId) {
        console.warn('[SessionManager] No session ID provided for validation');
        return false;
      }
      
      // Check if we've exceeded validation attempts for this session
      const validationInfo = SessionManager._validationAttempts[sessionId] || { count: 0, lastAttempt: 0 };
      const now = Date.now();
      
      if (validationInfo.count >= SessionManager._maxValidationAttempts && 
          (now - validationInfo.lastAttempt) < SessionManager._validationCooldown) {
        console.warn(`[SessionManager] Too many validation attempts for session ${sessionId}, cooling down`);
        return false;
      }
      
      // Update validation attempts
      SessionManager._validationAttempts[sessionId] = {
        count: validationInfo.count + 1,
        lastAttempt: now
      };
      
      console.log(`[SessionManager] Validating session: ${sessionId} (attempt ${validationInfo.count + 1})`);
      
      try {
        const response = await axios.get(`${API_BASE_URL}/api/status/session/${sessionId}`);
        const isValid = response.data && response.data.valid;
        
        console.log(`[SessionManager] Session validation result for ${sessionId}: ${isValid ? 'valid' : 'invalid'}`);
        
        // If valid, ensure the session is properly saved
        if (isValid) {
          SessionManager.saveSessionId(sessionId);
          // Reset validation attempts on success
          SessionManager._validationAttempts[sessionId] = { count: 0, lastAttempt: now };
        }
        
        return isValid;
      } catch (error) {
        console.error('[SessionManager] Session validation error:', error);
        return false;
      }
    },
    
    /**
     * Listen for session updates and respond to them
     * Call this once at app initialization
     */
    setupSessionListener: () => {
      window.sessionManager = SessionManager; // Expose to window for debug access
      
      window.addEventListener('sessionUpdated', (event) => {
        const { sessionId } = event.detail;
        console.log(`[SessionManager] Session updated event: ${sessionId}`);
        
        // Reset validation attempts when session is updated
        SessionManager._validationAttempts[sessionId] = { 
          count: 0, 
          lastAttempt: Date.now() 
        };
      });
      
      console.log('[SessionManager] Session listener setup complete');
      
      // Check for an existing session and validate it
      const existingSession = SessionManager.getSessionId();
      if (existingSession) {
        console.log(`[SessionManager] Found existing session at startup: ${existingSession}`);
      }
    },
    
    /**
     * Force load a specific session ID (for debugging)
     * @param {string} sessionId The session ID to force
     */
    forceSession: (sessionId) => {
      if (!sessionId) {
        console.error('[SessionManager] Cannot force empty session ID');
        return;
      }
      
      console.log(`[SessionManager] Force loading session: ${sessionId}`);
      SessionManager.saveSessionId(sessionId);
      
      // Reload the page to apply the session
      window.location.reload();
    }
  };
  
  // Add a global method to force a session from the console for debugging
  window.forceSession = (sessionId) => {
    console.log(`[CONSOLE DEBUG] Forcing session ID: ${sessionId}`);
    SessionManager.forceSession(sessionId);
  };
  
  export default SessionManager;