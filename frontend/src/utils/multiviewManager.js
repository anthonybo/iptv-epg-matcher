/**
 * MultiView Manager - Handles adding, removing, and persisting multiview streams
 */

const MULTIVIEW_STORAGE_KEY = 'multiview_streams';

/**
 * Get all multiview streams from localStorage
 * @returns {Array} Array of stream objects
 */
export const getMultiviewStreams = () => {
  try {
    const stored = localStorage.getItem(MULTIVIEW_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Error reading multiview streams:', error);
    return [];
  }
};

/**
 * Save multiview streams to localStorage
 * @param {Array} streams - Array of stream objects to save
 */
export const saveMultiviewStreams = (streams) => {
  try {
    localStorage.setItem(MULTIVIEW_STORAGE_KEY, JSON.stringify(streams));
  } catch (error) {
    console.error('Error saving multiview streams:', error);
  }
};

/**
 * Add a stream to multiview
 * @param {Object} channel - Channel object to add
 * @returns {Array} Updated streams array
 */
export const addToMultiview = (channel) => {
  const streams = getMultiviewStreams();

  // Check if stream already exists (avoid duplicates)
  const exists = streams.some(
    stream => stream.id === channel.id && stream.sourceId === channel.sourceId
  );

  if (exists) {
    console.log('[MultiView] Stream already in multiview');
    return streams;
  }

  // Add new stream
  const newStream = {
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
    // ESPN event data for reliable matching
    espnEventId: channel.espnEventId,
    espnEventName: channel.espnEventName,
    addedAt: Date.now()
  };

  const updatedStreams = [...streams, newStream];
  saveMultiviewStreams(updatedStreams);

  console.log(`[MultiView] Added stream: ${channel.name} (Total: ${updatedStreams.length})`);
  return updatedStreams;
};

/**
 * Remove a stream from multiview
 * @param {string} id - Channel ID
 * @param {string} sourceId - Source ID
 * @returns {Array} Updated streams array
 */
export const removeFromMultiview = (id, sourceId) => {
  const streams = getMultiviewStreams();
  const updatedStreams = streams.filter(
    stream => !(stream.id === id && stream.sourceId === sourceId)
  );

  saveMultiviewStreams(updatedStreams);
  console.log(`[MultiView] Removed stream (Remaining: ${updatedStreams.length})`);
  return updatedStreams;
};

/**
 * Clear all multiview streams
 */
export const clearMultiview = () => {
  saveMultiviewStreams([]);
  console.log('[MultiView] Cleared all streams');
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
