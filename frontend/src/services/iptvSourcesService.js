import apiClient from '../utils/apiClient';

/**
 * Service for managing user's IPTV sources
 */
class IPTVSourcesService {
  /**
   * Get all IPTV sources for the authenticated user
   * @returns {Promise<Array>} List of sources with preferences
   */
  async getUserSources() {
    try {
      const response = await apiClient.get('/iptv/sources');
      return response.data.sources || [];
    } catch (error) {
      console.error('Error fetching user sources:', error);
      throw error;
    }
  }

  /**
   * Toggle source active state
   * @param {number} sourceId - Source ID
   * @param {boolean} isActive - New active state
   * @returns {Promise<Object>} Response data
   */
  async toggleSourceActive(sourceId, isActive) {
    try {
      const response = await apiClient.post(`/iptv/sources/${sourceId}/activate`, {
        isActive
      });
      return response.data;
    } catch (error) {
      console.error('Error toggling source active state:', error);
      throw error;
    }
  }

  /**
   * Update source priority
   * @param {number} sourceId - Source ID
   * @param {number} priority - New priority (1, 2, 3...)
   * @returns {Promise<Object>} Response data
   */
  async updateSourcePriority(sourceId, priority) {
    try {
      const response = await apiClient.put(`/iptv/sources/${sourceId}/priority`, {
        priority
      });
      return response.data;
    } catch (error) {
      console.error('Error updating source priority:', error);
      throw error;
    }
  }

  /**
   * Update source nickname
   * @param {number} sourceId - Source ID
   * @param {string} nickname - New nickname
   * @returns {Promise<Object>} Response data
   */
  async updateSourceNickname(sourceId, nickname) {
    try {
      const response = await apiClient.put(`/iptv/sources/${sourceId}/nickname`, {
        nickname
      });
      return response.data;
    } catch (error) {
      console.error('Error updating source nickname:', error);
      throw error;
    }
  }

  /**
   * Update source credentials (URL, username, password)
   * @param {number} sourceId - Source ID
   * @param {Object} credentials - { url, username, password }
   * @returns {Promise<Object>} Response data
   */
  async updateSourceCredentials(sourceId, credentials) {
    try {
      const response = await apiClient.put(`/iptv/sources/${sourceId}/credentials`, credentials);
      return response.data;
    } catch (error) {
      console.error('Error updating source credentials:', error);
      throw error;
    }
  }

  /**
   * Batch reorder sources (for drag-and-drop)
   * @param {Array<{sourceId: number, priority: number}>} sources - Sources with new priorities
   * @returns {Promise<Object>} Response data
   */
  async reorderSources(sources) {
    try {
      const response = await apiClient.put('/iptv/sources/reorder', {
        sources
      });
      return response.data;
    } catch (error) {
      console.error('Error reordering sources:', error);
      throw error;
    }
  }

  /**
   * Delete source from user's account
   * @param {number} sourceId - Source ID
   * @returns {Promise<Object>} Response data
   */
  async deleteSource(sourceId) {
    try {
      const response = await apiClient.delete(`/iptv/sources/${sourceId}`);
      return response.data;
    } catch (error) {
      console.error('Error deleting source:', error);
      throw error;
    }
  }

  /**
   * Get alternate feeds for a channel
   * @param {string} channelName - Channel name
   * @param {string} epgChannelId - EPG channel ID (optional)
   * @returns {Promise<Array>} List of alternate feeds
   */
  async getAlternateFeeds(channelName, epgChannelId = null) {
    try {
      const params = { channelName };
      if (epgChannelId) {
        params.epgChannelId = epgChannelId;
      }

      const response = await apiClient.get('/iptv/alternate-feeds', { params });
      return response.data.feeds || [];
    } catch (error) {
      // If not authenticated, return empty array
      if (error.response?.status === 401) {
        return [];
      }
      console.error('Error fetching alternate feeds:', error);
      throw error;
    }
  }

  /**
   * Refresh account information for an Xtream source
   * @param {number} sourceId - Source ID
   * @returns {Promise<Object>} Updated account info
   */
  async refreshAccountInfo(sourceId) {
    try {
      const response = await apiClient.post(`/iptv/sources/${sourceId}/refresh-account-info`);
      return response.data;
    } catch (error) {
      console.error('Error refreshing account info:', error);
      throw error;
    }
  }

  /**
   * Test stream connectivity for a source
   * @param {number} sourceId - Source ID
   * @returns {Promise<Object>} Stream diagnostics
   */
  async testStreams(sourceId) {
    try {
      const response = await apiClient.post(`/iptv/sources/${sourceId}/test-streams`);
      return response.data;
    } catch (error) {
      console.error('Error testing streams:', error);
      throw error;
    }
  }
}

export default new IPTVSourcesService();
