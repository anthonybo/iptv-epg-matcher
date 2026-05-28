import apiClient from '../utils/apiClient';
import axios from 'axios';

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
  /**
   * Refresh VOD catalog only (no channels) for one source.
   * @param {number} sourceId
   * @param {{ kind?: 'movies'|'series'|'all', signal?: AbortSignal }} opts
   */
  async refreshVod(sourceId, { kind = 'all', signal } = {}) {
    try {
      const response = await apiClient.post(
        `/iptv/sources/${sourceId}/refresh-vod?kind=${encodeURIComponent(kind)}`,
        {},
        { timeout: 20 * 60 * 1000, signal }
      );
      return response.data;
    } catch (error) {
      if (axios.isCancel?.(error) || error.name === 'CanceledError' || error.name === 'AbortError') {
        const cancelErr = new Error('Cancelled');
        cancelErr.cancelled = true;
        throw cancelErr;
      }
      throw error;
    }
  }

  async refreshAccountInfo(sourceId, { signal, skipVod = false } = {}) {
    try {
      // Generous timeout — large Xtream providers with 50k+ channels
      // and a pg_trgm GIN index take 10-15 min on the INSERT step.
      // 20 min matches the backend's req.setTimeout, so we won't
      // give up before the server does.
      //
      // skipVod=true is what bulk "Refresh all" uses to skip the
      // 5-min-per-source VOD ingest — channel listings come back
      // fast and the user can trigger VOD separately if they care.
      const url = `/iptv/sources/${sourceId}/refresh-account-info${skipVod ? '?skipVod=1' : ''}`;
      const response = await apiClient.post(url, {}, {
        timeout: 20 * 60 * 1000,
        // AbortController signal — when the user hits Cancel on the
        // Refresh-all pill we cancel the in-flight axios call. The
        // backend route's req 'close' handler picks up the
        // disconnect and stops the host-bucket loop.
        signal,
      });
      return response.data;
    } catch (error) {
      // Don't noisy-log canceled requests — that's the user's intent.
      if (axios.isCancel?.(error) || error.name === 'CanceledError' || error.name === 'AbortError') {
        const cancelErr = new Error('Cancelled');
        cancelErr.cancelled = true;
        throw cancelErr;
      }
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
