/**
 * MultiView Manager - Handles adding, removing, and persisting multiview streams
 */

const getAuthToken = () => {
  return localStorage.getItem('auth_token') || sessionStorage.getItem('token') || localStorage.getItem('token');
};

/**
 * Get all multiview streams from API
 * @returns {Promise<Array>} Array of stream objects
 */
export const getMultiviewStreams = async () => {
  try {
    const token = getAuthToken();
    if (!token) {
      console.error('No auth token found for multiview');
      return [];
    }

    const response = await fetch('/api/multiview', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();
    if (data.success) {
      return data.streams || [];
    }

    console.error('Failed to load multiview streams:', data.error);
    return [];
  } catch (error) {
    console.error('Error reading multiview streams:', error);
    return [];
  }
};

/**
 * Add a stream to multiview
 * @param {Object} channel - Channel object to add
 * @returns {Promise<boolean>} Success status
 */
export const addToMultiview = async (channel) => {
  try {
    const token = getAuthToken();
    if (!token) {
      console.error('No auth token found for multiview');
      return false;
    }

    // Normalize channel data
    const normalizedChannel = {
      id: channel.id,
      name: channel.name,
      logo: channel.logo || channel.tvgLogo,
      url: channel.url,
      sourceId: channel.sourceId || channel.source_id,
      sourceType: channel.sourceType || channel.source_type,
      sourceUrl: channel.sourceUrl || channel.source_url,
      sourceUsername: channel.sourceUsername || channel.source_username,
      sourcePassword: channel.sourcePassword || channel.source_password,
      sourceMac: channel.sourceMac || channel.source_mac,
      sourceName: channel.sourceName || channel.source_name,
      espnEventId: channel.espnEventId,
      espnEventName: channel.espnEventName
    };

    const response = await fetch('/api/multiview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ channel: normalizedChannel })
    });

    const data = await response.json();
    if (data.success) {
      console.log(`[MultiView] Added stream: ${channel.name}`);
      return true;
    }

    console.error('Failed to add to multiview:', data.error);
    return false;
  } catch (error) {
    console.error('Error adding to multiview:', error);
    return false;
  }
};

/**
 * Remove a stream from multiview
 * @param {string} id - Channel ID
 * @param {string} sourceId - Source ID
 * @returns {Promise<boolean>} Success status
 */
export const removeFromMultiview = async (id, sourceId) => {
  try {
    const token = getAuthToken();
    if (!token) {
      console.error('No auth token found for multiview');
      return false;
    }

    const response = await fetch(`/api/multiview/${encodeURIComponent(id)}/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();
    if (data.success) {
      console.log(`[MultiView] Removed stream`);
      return true;
    }

    console.error('Failed to remove from multiview:', data.error);
    return false;
  } catch (error) {
    console.error('Error removing from multiview:', error);
    return false;
  }
};

/**
 * Clear all multiview streams
 * @returns {Promise<boolean>} Success status
 */
export const clearMultiview = async () => {
  try {
    const token = getAuthToken();
    if (!token) {
      console.error('No auth token found for multiview');
      return false;
    }

    const response = await fetch('/api/multiview', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();
    if (data.success) {
      console.log('[MultiView] Cleared all streams');
      return true;
    }

    console.error('Failed to clear multiview:', data.error);
    return false;
  } catch (error) {
    console.error('Error clearing multiview:', error);
    return false;
  }
};

/**
 * Calculate optimal grid layout based on number of streams
 * @param {number} count - Number of streams
 * @returns {Object} { columns, rows }
 */
export const calculateLayout = (count) => {
  if (count === 0) return { columns: 1, rows: 1 };
  if (count === 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  if (count <= 6) return { columns: 3, rows: 2 };
  if (count <= 9) return { columns: 3, rows: 3 };
  if (count <= 12) return { columns: 4, rows: 3 };
  if (count <= 16) return { columns: 4, rows: 4 };
  if (count <= 20) return { columns: 5, rows: 4 };
  if (count <= 25) return { columns: 5, rows: 5 };

  // For larger counts, use square-ish grid
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { columns: cols, rows };
};
