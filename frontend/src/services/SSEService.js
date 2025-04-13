import { API_BASE_URL } from '../config';
import axios from 'axios';

// Local getSessionId implementation to avoid circular import issues
function getSessionId() {
  try {
    // Check multiple possible storage keys
    const sessionId = localStorage.getItem('iptv_epg_session_id') || 
                      localStorage.getItem('sessionId') || 
                      localStorage.getItem('session_id');
    
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
      console.error('[SSEService] No valid session ID found in localStorage');
      // Generate a new session ID
      const newSessionId = 'session_' + Math.random().toString(36).substring(2, 15);
      localStorage.setItem('iptv_epg_session_id', newSessionId);
      localStorage.setItem('sessionId', newSessionId);
      localStorage.setItem('session_id', newSessionId);
      console.log(`[SSEService] Created new session ID: ${newSessionId}`);
      return newSessionId;
    }
    
    console.log(`[SSEService] Using existing session ID: ${sessionId}`);
    return sessionId;
  } catch (e) {
    console.error('[SSEService] Error getting/creating session ID:', e);
    return null;
  }
}

let eventSource = null;
let listeners = {};
let connectionStatus = 'disconnected';
let reconnectTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000; // 2 seconds

/**
 * Update the connection status and dispatch event
 * @param {string} status - The new connection status
 */
function updateConnectionStatus(status) {
  if (connectionStatus !== status) {
    connectionStatus = status;
    console.log(`[SSEService] Connection status changed to: ${status}`);
    
    // Dispatch status change event
    window.dispatchEvent(new CustomEvent('sseStatusChange', {
      detail: { status }
    }));
  }
}

/**
 * Get the current connection status
 * @returns {string} - Current connection status
 */
function getConnectionStatus() {
  return connectionStatus;
}

/**
 * Register the session with the server
 * @param {string} sessionId - The session ID to register
 * @returns {Promise<boolean>} - Promise resolving to true if registration was successful
 */
async function registerSession(sessionId) {
  if (!sessionId) {
    console.error('[SSEService] Cannot register without a session ID');
    return false;
  }
  
  try {
    console.log(`[SSEService] Registering session: ${sessionId}`);
    const response = await axios.post(`${API_BASE_URL}/api/session/register`, { sessionId });
    
    if (response.status === 200 && response.data.success) {
      console.log(`[SSEService] Successfully registered session: ${sessionId}`);
      return true;
    } else {
      console.error(`[SSEService] Failed to register session: ${sessionId}`, response.status);
      return false;
    }
  } catch (error) {
    console.error('[SSEService] Error registering session:', error);
    return false;
  }
}

/**
 * Handle connection errors and implement reconnection logic
 */
function handleConnectionError() {
  // Close the current connection if it exists
  if (eventSource) {
    try {
      eventSource.close();
    } catch (e) {
      console.error('[SSEService] Error closing EventSource during reconnect:', e);
    }
    eventSource = null;
  }

  // Try to reconnect if we haven't exceeded the maximum attempts
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    
    console.log(`[SSEService] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY}ms`);
    
    // Set up reconnect timeout
    reconnectTimeout = setTimeout(() => {
      const sessionId = getSessionId();
                      
      if (sessionId) {
        console.log(`[SSEService] Attempting to reconnect with session ID: ${sessionId}`);
        
        // Try to register the session first to ensure it exists on the backend
        registerSession(sessionId)
          .then(registered => {
            if (registered) {
              console.log(`[SSEService] Successfully registered session before reconnecting: ${sessionId}`);
            } else {
              console.warn(`[SSEService] Failed to register session before reconnecting`);
            }
            // Continue anyway - the server should auto-create the session
            setupSSE(sessionId);
          })
          .catch(() => {
            // Try to reconnect anyway
            setupSSE(sessionId);
          });
      } else {
        console.error('[SSEService] Cannot reconnect: No session ID available');
        updateConnectionStatus('error');
      }
    }, RECONNECT_DELAY);
  } else {
    console.error(`[SSEService] Maximum reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
    updateConnectionStatus('disconnected');
  }
}

/**
 * Set up the SSE connection
 * @param {string} sessionId - The session ID to use for the connection
 * @returns {EventSource|null} - The EventSource object or null on failure
 */
function setupSSE(sessionId) {
  if (!sessionId) {
    console.error('[SSEService] Cannot setup SSE without a session ID');
    updateConnectionStatus('error');
    return null;
  }

  try {
    // Clean up existing connection if any
    if (eventSource) {
      console.log('[SSEService] Closing existing connection before creating a new one');
      closeSSE();
    }

    // Clear any pending reconnect
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    console.log(`[SSEService] Setting up SSE connection for session: ${sessionId}`);
    updateConnectionStatus('connecting');
    
    // Create a new EventSource
    const url = `${API_BASE_URL}/api/events/${sessionId}`;
    console.log(`[SSEService] Connecting to: ${url}`);
    
    eventSource = new EventSource(url);
    
    // Set up event handlers
    eventSource.onopen = () => {
      console.log('[SSEService] Connection opened successfully');
      updateConnectionStatus('connected');
      reconnectAttempts = 0; // Reset reconnect attempts on successful connection
    };
    
    eventSource.onerror = (error) => {
      console.error('[SSEService] Connection error:', error);
      updateConnectionStatus('error');
      
      // Handle reconnection
      handleConnectionError();
    };
    
    eventSource.onmessage = (event) => {
      // Generic message handler
      try {
        const data = JSON.parse(event.data);
        console.log(`[SSEService] Received message: ${data.type}`, data);
        
        // Dispatch to specific listeners
        if (data.type && listeners[data.type]) {
          listeners[data.type].forEach(callback => {
            try {
              callback(data);
            } catch (callbackError) {
              console.error(`[SSEService] Error in listener callback for ${data.type}:`, callbackError);
            }
          });
        }
      } catch (parseError) {
        console.error('[SSEService] Error parsing event data:', parseError, event.data);
      }
    };

    return eventSource;
  } catch (error) {
    console.error('[SSEService] Error setting up SSE:', error);
    updateConnectionStatus('error');
    return null;
  }
}

function closeSSE() {
  if (eventSource) {
    console.log('[SSEService] Closing SSE connection');
    try {
      eventSource.close();
    } catch (e) {
      console.error('[SSEService] Error closing EventSource:', e);
    }
    eventSource = null;
  }
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  updateConnectionStatus('disconnected');
}

function addListener(eventType, callback) {
  if (!listeners[eventType]) {
    listeners[eventType] = [];
  }
  
  listeners[eventType].push(callback);
  
  return () => {
    removeListener(eventType, callback);
  };
}

function removeListener(eventType, callback) {
  if (listeners[eventType]) {
    listeners[eventType] = listeners[eventType].filter(cb => cb !== callback);
  }
}

function triggerStatusChange() {
  window.dispatchEvent(new CustomEvent('sseStatusChange', { 
    detail: { status: connectionStatus, timestamp: new Date() }
  }));
}

// Don't run the initialization at import time, this causes the error
// Initialize connection when needed instead
/* 
(() => {
  const sessionId = getSessionId();
  if (sessionId) {
    console.log('Auto-initializing SSE connection');
    eventSource = setupSSE(sessionId);
  }
})();
*/

// Export all functions in a single export statement
export {
  setupSSE,
  closeSSE,
  addListener,
  removeListener,
  getConnectionStatus,
  registerSession
};