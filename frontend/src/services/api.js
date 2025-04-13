import axios from 'axios';
import { API_BASE_URL } from '../config';
import { getSessionId, storeSessionId } from './sessionService';

// Create axios instance with default config
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000
});

// Add request interceptor to inject session ID where appropriate
api.interceptors.request.use(
  (config) => {
    // For channel requests, ensure session ID is added to URL and params
    if (config.url && config.url.includes('/channels/')) {
      const sessionId = getSessionId();
      
      // If URL ends with 'null' or contains '/null/', fix it
      if (config.url.endsWith('/null') || config.url.includes('/null/')) {
        console.log('Fixing null session ID in URL:', config.url);
        const fixedUrl = config.url.replace('/null', `/${sessionId}`);
        config.url = fixedUrl;
      }
      
      // Always add sessionId to query parameters as backup
      config.params = config.params || {};
      config.params.sessionId = sessionId;
      
      console.log(`Added session ID to request: ${sessionId}`, config.url);
    }
    
    return config;
  },
  (error) => Promise.reject(error)
);

/**
 * Load channels and EPG data
 */
export const loadChannelsAndEpg = async (data) => {
  try {
    console.log('Loading channels and EPG with data:', data);
    const response = await api.post('/load', data);
    
    // Store the session ID from the response
    if (response.data && response.data.sessionId) {
      console.log(`Received session ID from load response: ${response.data.sessionId}`);
      storeSessionId(response.data.sessionId);
    }
    
    return response.data;
  } catch (error) {
    console.error('Error loading channels and EPG:', error);
    throw error;
  }
};

/**
 * Fetch channels with pagination and optional filtering
 */
export const fetchChannels = async (page = 1, limit = 1000, filter = null) => {
  try {
    // Get the current session ID
    const sessionId = getSessionId();
    
    if (!sessionId) {
      console.error('No active session ID available');
      throw new Error('No active session. Please load channels first.');
    }
    
    console.log(`Fetching channels with session ID: ${sessionId}`);
    
    // Make the API call - interceptor will ensure sessionId is added
    const response = await api.get(`/channels/${sessionId}`, {
      params: { page, limit, filter }
    });
    
    return response.data;
  } catch (error) {
    console.error('Error fetching channels:', error);
    throw error;
  }
};

export default api;