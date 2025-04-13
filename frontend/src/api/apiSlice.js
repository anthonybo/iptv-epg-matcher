import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { v4 as uuidv4 } from 'uuid';

// Get or create a persistent session ID
export const getSessionId = () => { // Export the function directly
  let sessionId = localStorage.getItem('iptv_epg_session_id');
  console.log(`[apiSlice/getSessionId] Raw value from localStorage: '${sessionId}' (type: ${typeof sessionId})`);
  
  // Check for null/undefined VALUES *and* STRING representations
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    console.log(`[apiSlice/getSessionId] Invalid or missing sessionId found ('${sessionId}'), generating a new one.`);
    sessionId = uuidv4();
    localStorage.setItem('iptv_epg_session_id', sessionId);
    
    // Also store in standard session storage keys for compatibility
    localStorage.setItem('currentSessionId', sessionId);
    localStorage.setItem('sessionId', sessionId);
    
    console.log(`[apiSlice/getSessionId] Generated and stored new sessionId: ${sessionId}`);
  } else {
    console.log(`[apiSlice/getSessionId] Using existing valid sessionId: ${sessionId}`);
    
    // Ensure it's also in the other standard storage keys
    localStorage.setItem('currentSessionId', sessionId);
    localStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
};

// Session ID export for direct use in components
export const SESSION_ID = getSessionId();

// Create our API with endpoints
export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ 
    baseUrl: import.meta.env.VITE_API_URL || 'http://localhost:5001/api',
    // Add custom headers if needed
    prepareHeaders: (headers) => {
      const sessionId = getSessionId();
      headers.set('X-Session-ID', sessionId);
      return headers;
    }
  }),
  endpoints: (builder) => ({
    // Channel endpoints
    loadData: builder.mutation({
      query: (formData) => {
        // Ensure we have the latest session ID
        const sessionId = getSessionId();
        console.log(`[apiSlice/loadData] Adding sessionId to request: ${sessionId}`);
        
        return {
          url: '/load',
          method: 'POST',
          body: { ...formData, sessionId },
        };
      },
    }),

    // Add endpoint for fetching channels
    getChannels: builder.query({
      query: (sessionId) => {
        // Log the sessionId received by the query function
        console.log(`[apiSlice/getChannels Query] Received sessionId: ${sessionId} (type: ${typeof sessionId})`);
        
        // Validate sessionId or get a new one
        const effectiveSessionId = sessionId || getSessionId();
        if (!effectiveSessionId) {
          console.error('[apiSlice/getChannels Query] No valid sessionId available');
          throw new Error('No valid session ID available');
        }
        
        console.log(`[apiSlice/getChannels Query] Using sessionId: ${effectiveSessionId}`);
        return `/channels/${effectiveSessionId}?limit=1000`;
      },
    }),

    // Health check endpoint
    getHealth: builder.query({
      query: () => '/health',
    }),
  }),
});

// SSE connection manager for real-time updates
class SSEManager {
  constructor() {
    this.eventSource = null;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000; // Start with 2 seconds
  }

  connect() {
    if (this.eventSource) {
      this.disconnect(); // Close existing connection before creating a new one
    }

    const currentSessionId = getSessionId(); // Get current ID
    const url = `${import.meta.env.VITE_API_URL || 'http://localhost:5001/api'}/stream-updates/${currentSessionId}`;
    
    try {
      console.log(`[SSE] Connecting to SSE stream at ${url}`);
      this.eventSource = new EventSource(url);
      
      this.eventSource.onopen = () => {
        console.log('[SSE] Connection established with session ID:', currentSessionId);
        this.reconnectAttempts = 0;
        this.reconnectDelay = 2000; // Reset on successful connection
      };
      
      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[SSE] Message received:', data);
          this.notifyListeners(data);
        } catch (error) {
          console.error('[SSE] Error parsing SSE message:', error, event.data);
        }
      };
      
      this.eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        this.disconnect();
        
        // Implement exponential backoff for reconnection
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(30000, this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1));
          console.log(`[SSE] Attempting to reconnect in ${delay/1000} seconds (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          
          setTimeout(() => {
            this.connect();
          }, delay);
        } else {
          console.error('[SSE] Maximum reconnection attempts reached');
        }
      };
    } catch (error) {
      console.error('[SSE] Error creating EventSource:', error);
    }
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(callback);
    
    // Auto-connect when adding first listener
    if (this.eventSource === null) {
      this.connect();
    }
    
    // Return unsubscribe function
    return () => {
      if (this.listeners.has(type)) {
        this.listeners.get(type).delete(callback);
        if (this.listeners.get(type).size === 0) {
          this.listeners.delete(type);
        }
      }
      
      // Auto-disconnect when no listeners remain
      if (this.listeners.size === 0) {
        this.disconnect();
      }
    };
  }

  notifyListeners(data) {
    const { type, ...payload } = data;
    
    console.log(`[SSE] Event received: ${type}`, payload);
    
    // Special handling for connection messages
    if (type === 'connection') {
      console.log('[SSE] Server confirms connection:', payload.message);
    }
    
    // Handle heartbeats with minimal logging
    if (type === 'heartbeat') {
      console.debug('[SSE] Heartbeat received at', new Date().toISOString());
      return;
    }
    
    // For regular events
    if (this.listeners.has(type)) {
      this.listeners.get(type).forEach(callback => {
        try {
          callback(payload);
          console.log(`[SSE] Notified listener for event type: ${type}`);
        } catch (error) {
          console.error(`[SSE] Error in listener for '${type}':`, error);
        }
      });
    } else {
      console.warn(`[SSE] No listeners registered for event type: ${type}`);
    }
    
    // Also trigger 'all' listeners
    if (this.listeners.has('all')) {
      this.listeners.get('all').forEach(callback => {
        try {
          callback({ type, ...payload });
        } catch (error) {
          console.error(`[SSE] Error in 'all' listener:`, error);
        }
      });
    }
  }
}

// Create singleton instance
export const sseManager = new SSEManager();

// Export the auto-generated hooks
export const {
  useLoadDataMutation,
  useGetChannelsQuery, // Export the new hook
  useGetHealthQuery,
  // ... other hooks
} = apiSlice;