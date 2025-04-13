import api from './api';
import axios from 'axios';
import { API_BASE_URL } from '../config';

// Add a current session storage mechanism
let currentSessionId = null;
let channelCache = {
  byId: {},
  all: [],
  categories: [],
  lastUpdated: null,
  isLoading: false,
  totalChannels: 0,
  loadedChannels: 0
};

// Update session ID storage
export const setCurrentSession = (sessionId) => {
  if (!sessionId) return;
  currentSessionId = sessionId;
  localStorage.setItem('currentSessionId', sessionId);
  console.log(`Session ID saved: ${sessionId}`);
  
  // Clear channel cache when session changes
  channelCache = {
    byId: {},
    all: [],
    categories: [],
    lastUpdated: null,
    isLoading: false,
    totalChannels: 0,
    loadedChannels: 0
  };
};

export const getCurrentSession = () => {
  if (!currentSessionId) {
    currentSessionId = localStorage.getItem('currentSessionId');
  }
  return currentSessionId;
};

// Update the loadChannelsAndEpg function to store the session ID
export const loadChannelsAndEpg = async (urls, options = {}) => {
  try {
    const response = await api.post('/load', urls);
    const { sessionId } = response.data;
    
    // Save session ID as current session
    if (sessionId) {
      setCurrentSession(sessionId);
      console.log(`Session ID set from load response: ${sessionId}`);
    }
    
    return response.data;
  } catch (error) {
    console.error('Error loading channels and EPG:', error);
    throw error;
  }
};

// Add a debug helper on window for use in the browser console
window.forceLog = {
  categories: null,
  channels: null,
  logCategories: function(cats) {
    this.categories = cats;
    console.log('[FORCE LOG] Categories:', cats);
    return cats;
  },
  logChannels: function(chs) {
    this.channels = chs;
    console.log('[FORCE LOG] Channels:', chs);
    return chs;
  },
  fetchCategoriesDirectly: async function() {
    try {
      const sessionId = localStorage.getItem('currentSessionId');
      if (!sessionId) {
        console.error('[FORCE LOG] No session ID available');
        return null;
      }
      
      console.log('[FORCE LOG] Fetching categories directly for session:', sessionId);
      
      const response = await fetch(`/api/channels/${sessionId}/categories`);
      if (!response.ok) {
        console.error('[FORCE LOG] Failed to fetch categories:', response.status, response.statusText);
        return null;
      }
      
      const text = await response.text();
      console.log('[FORCE LOG] Raw response:', text.substring(0, 200) + '...');
      
      const data = JSON.parse(text);
      this.categories = data.categories || data;
      console.log('[FORCE LOG] Parsed categories:', this.categories);
      
      return this.categories;
    } catch (error) {
      console.error('[FORCE LOG] Error fetching categories:', error);
      return null;
    }
  }
};

// Fetch all channel categories using the current session ID
export const fetchCategories = async (forceRefresh = false) => {
  try {
    const sessionId = getCurrentSession();
    if (!sessionId) {
      console.error('[ERROR] fetchCategories - No session ID available');
      return null;
    }

    // Try to get categories from cache first
    if (!forceRefresh && channelCache.categories && channelCache.categories.length > 0) {
      console.log(`[INFO] fetchCategories - Returning ${channelCache.categories.length} categories from cache`);
      return channelCache.categories;
    }

    console.log(`[INFO] fetchCategories - Fetching categories from API for session ${sessionId}`);
    const response = await axios.get(`${API_BASE_URL}/api/channels/${sessionId}/categories`);
    
    console.log('[DEBUG] fetchCategories - Raw response data:', response.data);
    console.log('[DEBUG] fetchCategories - Response data type:', typeof response.data);
    console.log('[DEBUG] fetchCategories - Is array:', Array.isArray(response.data));
    
    if (response.data) {
      console.log(`[SUCCESS] fetchCategories - Received categories from API`);
      
      // Check if data is array format
      if (Array.isArray(response.data)) {
        console.log(`[INFO] fetchCategories - Response is an array with ${response.data.length} items`);
        // Check first item format
        if (response.data.length > 0) {
          console.log('[DEBUG] fetchCategories - First item:', response.data[0]);
        }
        
        // Format data if needed
        const formattedCategories = response.data.map(cat => {
          // If the category is just a string, convert to object format
          if (typeof cat === 'string') {
            return { name: cat, count: 0 };
          }
          // If it's already an object, make sure it has the right properties
          if (typeof cat === 'object') {
            return { 
              name: cat.name || cat.category || cat.title || cat,
              count: cat.count || cat.channelCount || 0
            };
          }
          return cat;
        });
        
        // Update cache
        channelCache.categories = formattedCategories;
        console.log(`[SUCCESS] fetchCategories - Formatted and saved ${formattedCategories.length} categories`);
        return formattedCategories;
      } else if (typeof response.data === 'object') {
        // Try to handle object response format
        console.log('[DEBUG] fetchCategories - Response is an object with keys:', Object.keys(response.data));
        
        let extractedCategories = [];
        
        // Case: { categories: [...] }
        if (response.data.categories && Array.isArray(response.data.categories)) {
          extractedCategories = response.data.categories;
        } 
        // Try to find any array in the object that might be categories
        else {
          for (const key of Object.keys(response.data)) {
            if (Array.isArray(response.data[key])) {
              extractedCategories = response.data[key];
              console.log(`[INFO] fetchCategories - Found array in key "${key}" with ${extractedCategories.length} items`);
              break;
            }
          }
        }
        
        // Format the extracted categories
        if (extractedCategories.length > 0) {
          const formattedCategories = extractedCategories.map(cat => {
            if (typeof cat === 'string') {
              return { name: cat, count: 0 };
            }
            if (typeof cat === 'object') {
              return { 
                name: cat.name || cat.category || cat.title || cat,
                count: cat.count || cat.channelCount || 0
              };
            }
            return cat;
          });
          
          // Update cache
          channelCache.categories = formattedCategories;
          console.log(`[SUCCESS] fetchCategories - Extracted and formatted ${formattedCategories.length} categories`);
          return formattedCategories;
        }
      }
      
      console.warn('[WARN] fetchCategories - Could not extract categories from response:', response.data);
      return null;
    } else {
      console.warn('[WARN] fetchCategories - Invalid response format:', response.data);
      return null;
    }
  } catch (error) {
    console.error('[ERROR] fetchCategories - Failed to fetch categories:', error);
    return null;
  }
};

// Helper function to generate categories from channels
const generateCategoriesFromChannels = (channels) => {
  if (!channels || channels.length === 0) {
    console.warn('[WARN] generateCategoriesFromChannels - No channels provided');
    return [];
  }
  
  try {
    console.log(`[INFO] generateCategoriesFromChannels - Generating from ${channels.length} channels`);
    const categoryCounts = channels.reduce((acc, ch) => {
      const groupTitle = ch.groupTitle || 'Uncategorized';
      acc[groupTitle] = (acc[groupTitle] || 0) + 1;
      return acc;
    }, {});
    
    const generatedCategories = Object.entries(categoryCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
      
    console.log(`[SUCCESS] generateCategoriesFromChannels - Generated ${generatedCategories.length} categories`);
    return generatedCategories;
  } catch (error) {
    console.error('[ERROR] generateCategoriesFromChannels - Exception:', error);
    return [];
  }
};

// Update the fetchChannels function to use the current session ID with better pagination and caching
export const fetchChannels = async (page = 1, limit = 500, category = null) => {
  try {
    console.log('[TRACE] fetchChannels - Starting');
    const sessionId = getCurrentSession();
    
    if (!sessionId) {
      console.error('[ERROR] fetchChannels - No session ID available');
      throw new Error('No active session. Please load channels first.');
    }
    
    console.log(`[DEBUG] fetchChannels - Using session ID: ${sessionId}, page: ${page}, limit: ${limit}, category: ${category || 'none'}`);
    
    // Check if we've already loaded these channels
    if (channelCache.all.length > 0 && !category) {
      console.log(`[INFO] fetchChannels - Using cached channels (${channelCache.all.length} channels)`);
      
      // Make sure categories are available in the cache
      if (!channelCache.categories || channelCache.categories.length === 0) {
        console.log('[WARN] fetchChannels - No categories in cache, will attempt to generate them');
        
        // Try to generate categories from cached channels
        const generatedCategories = generateCategoriesFromChannels(channelCache.all);
        if (generatedCategories.length > 0) {
          console.log(`[INFO] fetchChannels - Generated ${generatedCategories.length} categories from cached channels`);
          channelCache.categories = generatedCategories;
        }
      } else {
        console.log(`[INFO] fetchChannels - Using ${channelCache.categories.length} cached categories`);
      }
      
      return {
        channels: channelCache.all,
        categories: channelCache.categories,
        pagination: {
          totalChannels: channelCache.totalChannels,
          loadedChannels: channelCache.loadedChannels,
          page: 1,
          totalPages: Math.ceil(channelCache.totalChannels / limit) || 1
        },
        totalChannels: channelCache.totalChannels, // Add top-level totalChannels for backward compatibility
        fromCache: true
      };
    }
    
    console.log(`[INFO] fetchChannels - Fetching channels page ${page} (limit: ${limit}${category ? `, category: ${category}` : ''})`);
    
    // Use a larger timeout for this request
    const response = await api.get(`/channels/${sessionId}`, {
      params: { page, limit, category },
      timeout: 60000 // 60 seconds timeout
    });
    
    console.log('[DEBUG] fetchChannels - Response status:', response.status);
    console.log('[DEBUG] fetchChannels - Response data structure:', {
      hasChannels: !!response.data.channels,
      channelsLength: response.data.channels?.length || 0,
      hasCategories: !!response.data.categories,
      categoriesLength: response.data.categories?.length || 0,
      hasPagination: !!response.data.pagination,
      totalChannels: response.data.pagination?.totalChannels || response.data.totalChannels || 0
    });
    
    // Log the first category if available
    if (response.data.categories && response.data.categories.length > 0) {
      console.log('[INFO] fetchChannels - First category from channel response:', response.data.categories[0]);
      // Also log first few categories to see their structure
      console.log(`[INFO] fetchChannels - First 3 categories (sample):`, response.data.categories.slice(0, 3));
    } else {
      console.warn('[WARN] fetchChannels - No categories found in API response');
    }
    
    // Store received channels in cache if not using category filter
    if (!category) {
      // Add new channels to the cache
      response.data.channels.forEach(channel => {
        if (!channelCache.byId[channel.tvgId]) {
          channelCache.byId[channel.tvgId] = channel;
          channelCache.all.push(channel);
        }
      });
      
      // Update cache metadata
      channelCache.lastUpdated = new Date();
      channelCache.totalChannels = response.data.pagination?.totalChannels || response.data.totalChannels || response.data.channels.length;
      channelCache.loadedChannels = channelCache.all.length;
      
      // If categories are included in the response, store them
      if (response.data.categories && Array.isArray(response.data.categories)) {
        console.log(`[INFO] fetchChannels - Storing ${response.data.categories.length} categories from channel response in cache`);
        channelCache.categories = response.data.categories;
      } else {
        // If no categories in response, try to generate them from channels
        console.log('[INFO] fetchChannels - No categories in API response, generating from channels');
        const generatedCategories = generateCategoriesFromChannels(channelCache.all);
        if (generatedCategories.length > 0) {
          console.log(`[INFO] fetchChannels - Generated ${generatedCategories.length} categories from channels`);
          channelCache.categories = generatedCategories;
        }
      }
      
      // Update the response to use our cached channels
      response.data.loadedChannels = channelCache.loadedChannels;
    }
    
    // Make sure the totalChannels is set
    if (response.data.pagination && !response.data.pagination.totalChannels) {
      response.data.pagination.totalChannels = response.data.channels.length;
    }
    
    // Add totalChannels at the top level for backward compatibility
    if (!response.data.totalChannels && response.data.pagination?.totalChannels) {
      response.data.totalChannels = response.data.pagination.totalChannels;
    }
    
    // If we have categories in the cache but not in the response, add them
    if ((!response.data.categories || response.data.categories.length === 0) && 
        channelCache.categories && channelCache.categories.length > 0) {
      console.log(`[INFO] fetchChannels - Adding ${channelCache.categories.length} cached categories to response`);
      response.data.categories = channelCache.categories;
    }
    
    console.log('[TRACE] fetchChannels - Completed, returning response');
    return response.data;
  } catch (error) {
    console.error('[ERROR] fetchChannels - Error fetching channels:', error);
    throw error;
  }
};

// Progressively load all channels in chunks to prevent UI freezing
export const loadAllChannelsProgressively = async (
  onProgress = (loaded, total) => {}, 
  chunkSize = 500,
  maxChunks = 10
) => {
  try {
    // Reset loading state
    channelCache.isLoading = true;
    
    // Fetch the first page to get total count
    const firstPage = await fetchChannels(1, chunkSize);
    const totalChannels = firstPage.pagination?.totalChannels || firstPage.channels.length;
    const totalPages = Math.ceil(totalChannels / chunkSize);
    
    // Limit the number of pages to prevent loading too much
    const pagesToLoad = Math.min(totalPages, maxChunks);
    
    console.log(`Loading ${pagesToLoad} pages of ${totalPages} total (${totalChannels} channels)`);
    
    // Call the progress callback with initial data
    onProgress(channelCache.loadedChannels, totalChannels);
    
    // If we already have all channels, no need to fetch more
    if (channelCache.loadedChannels >= totalChannels) {
      channelCache.isLoading = false;
      return {
        channels: channelCache.all,
        categories: channelCache.categories,
        totalChannels,
        loadedChannels: channelCache.loadedChannels,
        fromCache: true
      };
    }
    
    // Function to load the next page with a delay to prevent UI freezing
    const loadNextPage = async (page) => {
      if (page > pagesToLoad || !channelCache.isLoading) {
        return;
      }
      
      try {
        await fetchChannels(page, chunkSize);
        
        // Update progress
        onProgress(channelCache.loadedChannels, totalChannels);
        
        // Schedule the next page load with a small delay
        setTimeout(() => loadNextPage(page + 1), 300);
      } catch (error) {
        console.error(`Error loading page ${page}:`, error);
        channelCache.isLoading = false;
      }
    };
    
    // Start loading from page 2 (since we already loaded page 1)
    loadNextPage(2);
    
    // Return the initial data while the rest loads in the background
    return {
      channels: channelCache.all,
      categories: channelCache.categories,
      totalChannels,
      loadedChannels: channelCache.loadedChannels,
      loading: true
    };
  } catch (error) {
    channelCache.isLoading = false;
    console.error('Error in progressive loading:', error);
    throw error;
  }
};

// Stop loading channels if in progress
export const cancelChannelLoading = () => {
  channelCache.isLoading = false;
};

// ... other functions