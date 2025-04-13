/**
 * EPG Finder - Utility to locate EPG data in memory and expose it
 */
const logger = require('./logger');

/**
 * Search for EPG data in memory and expose it globally
 */
function findAndExposeEpgData() {
  const startTime = Date.now();
  logger.info('Scanning memory for EPG data');
  
  try {
    // Function to recursively search for EPG data
    const findEpgData = (obj, path = 'global') => {
      if (!obj || typeof obj !== 'object') return null;
      
      // Check if this object directly has channels
      if (obj.channels && Array.isArray(obj.channels) && obj.channels.length > 0) {
        logger.info(`Found EPG channels at ${path}: ${obj.channels.length} channels`);
        return { type: 'direct', source: obj, path, channelCount: obj.channels.length };
      }
      
      // Check if this is a container of sources
      let bestSource = null;
      let maxChannels = 0;
      
      // Skip checking some known complex objects that can cause issues
      if (path.includes('socket') || path.includes('require.cache')) {
        return null;
      }
      
      // If this is an object with properties, check each property
      if (typeof obj === 'object' && !Array.isArray(obj)) {
        let sourceCount = 0;
        let totalChannels = 0;
        
        for (const key in obj) {
          try {
            const val = obj[key];
            
            // Skip functions and null values
            if (typeof val === 'function' || val === null) continue;
            
            // Check if this is an EPG source with channels
            if (val && typeof val === 'object' && val.channels && Array.isArray(val.channels)) {
              sourceCount++;
              totalChannels += val.channels.length;
              
              // Keep track of the largest source
              if (val.channels.length > maxChannels) {
                maxChannels = val.channels.length;
                bestSource = { type: 'source', source: val, path: `${path}.${key}`, channelCount: val.channels.length };
              }
            }
          } catch (e) {
            // Ignore errors in accessing properties
          }
        }
        
        // If we found multiple sources, this might be a sources container
        if (sourceCount > 1) {
          logger.info(`Found potential EPG sources container at ${path}: ${sourceCount} sources with ${totalChannels} channels`);
          return { type: 'container', source: obj, path, sourceCount, totalChannels };
        }
      }
      
      return bestSource;
    };
    
    // Start by checking common locations
    const epgSourcesLocations = [
      global._loadedEpgSources,
      global.epgSources,
      global._epgCache
    ];
    
    // Try direct known locations first
    for (const location of epgSourcesLocations) {
      if (location) {
        const result = findEpgData(location);
        if (result) {
          logger.info(`Found EPG data in known location: ${result.path} with ${result.channelCount || 0} channels`);
          
          // Store references for global access
          global._directEpgAccess = result.source;
          global._epgDataSource = result;
          
          // Make it accessible via exports
          module.exports.epgData = result.source;
          
          return result.source;
        }
      }
    }
    
    // If not found, scan the entire global object
    for (const key in global) {
      try {
        if (Date.now() - startTime > 5000) {
          logger.warn('EPG data search timeout after 5000ms');
          break;
        }
        
        const result = findEpgData(global[key], `global.${key}`);
        if (result) {
          logger.info(`Found EPG data in global.${key} with ${result.channelCount || result.totalChannels || 0} channels`);
          
          // Store for direct access
          global._directEpgAccess = result.source;
          global._epgDataSource = result;
          module.exports.epgData = result.source;
          
          // If we found a container of sources
          if (result.type === 'container') {
            global._epgSourcesContainer = result.source;
          }
          
          return result.source;
        }
      } catch (e) {
        // Ignore errors in accessing global properties
      }
    }
    
    // Create a place to store epg data if not found
    if (!global._centralEpgData) {
      global._centralEpgData = {
        sources: {},
        channels: [],
        addSource: function(url, source) {
          this.sources[url] = source;
          
          // Extract channels
          if (source && source.channels) {
            this.channels = this.channels.concat(source.channels);
          }
          
          logger.info(`Added EPG source to central store: ${url}`);
        }
      };
      
      // Expose this via exports
      module.exports.epgData = global._centralEpgData;
    }
    
    logger.info('EPG data scan complete, no suitable data found');
    return null;
  } catch (error) {
    logger.error(`Error in EPG data finder: ${error.message}`);
    return null;
  }
}

/**
 * Get all available EPG channels from multiple possible storage locations
 */
function getAllAvailableChannels() {
  // Start with an empty channels array
  let allChannels = [];
  
  try {
    // First try to access direct EPG data
    if (global._directEpgAccess) {
      // If it's a direct channels array
      if (global._directEpgAccess.channels && Array.isArray(global._directEpgAccess.channels)) {
        return formatChannels(global._directEpgAccess.channels, 'direct');
      }
      
      // If it's a container of sources
      if (global._epgDataSource && global._epgDataSource.type === 'container') {
        for (const sourceKey in global._directEpgAccess) {
          const source = global._directEpgAccess[sourceKey];
          if (source && source.channels && Array.isArray(source.channels)) {
            const formattedChannels = formatChannels(source.channels, sourceKey);
            allChannels = allChannels.concat(formattedChannels);
          }
        }
        
        if (allChannels.length > 0) {
          logger.info(`Using ${allChannels.length} channels from direct source container`);
          return allChannels;
        }
      }
    }
    
    // If we reach here, we didn't find channels in the direct reference
    logger.warn('No channels found in direct EPG data reference');
    
    // Try central store if it exists
    if (global._centralEpgData && global._centralEpgData.channels && Array.isArray(global._centralEpgData.channels)) {
      const formattedChannels = formatChannels(global._centralEpgData.channels, 'central');
      if (formattedChannels.length > 0) {
        logger.info(`Using ${formattedChannels.length} channels from central store`);
        return formattedChannels;
      }
    }
    
    // Final fallback to dummy data if needed
    return getFallbackChannels();
  } catch (error) {
    logger.error(`Error getting all available channels: ${error.message}`);
    return getFallbackChannels();
  }
}

/**
 * Format channels into a consistent structure
 */
function formatChannels(channels, sourceKey = 'unknown') {
  if (!channels || !Array.isArray(channels)) return [];
  
  return channels.map(ch => {
    if (!ch.$ || !ch.$.id) return null;
    
    // Extract display name
    let displayName = ch.$.id;
    let iconUrl = null;
    
    if (ch['display-name'] && Array.isArray(ch['display-name'])) {
      for (const name of ch['display-name']) {
        if (typeof name === 'string') {
          displayName = name;
          break;
        } else if (name && name._) {
          displayName = name._;
          break;
        }
      }
    }
    
    // Extract icon
    if (ch.icon && Array.isArray(ch.icon)) {
      for (const icon of ch.icon) {
        if (icon && icon.$ && icon.$.src) {
          iconUrl = icon.$.src;
          break;
        }
      }
    }
    
    // Return formatted channel
    return {
      id: ch.$.id,
      channelId: ch.$.id,
      channelName: displayName,
      name: displayName,
      icon: iconUrl,
      source: sourceKey,
      hasPrograms: false,  // This will be set correctly by the source
      programCount: 0      // This will be set correctly by the source
    };
  }).filter(Boolean); // Remove null entries
}

/**
 * Get fallback sample channels for development
 */
function getFallbackChannels() {
  logger.warn('Returning fallback sample channels');
  
  return [
    {
      id: 'espn.us',
      channelId: 'espn.us',
      channelName: 'ESPN',
      name: 'ESPN',
      icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/ESPN_logo.svg/1280px-ESPN_logo.svg.png',
      source: 'fallback',
      hasPrograms: false,
      programCount: 0
    },
    {
      id: 'espn2.us',
      channelId: 'espn2.us',
      channelName: 'ESPN 2',
      name: 'ESPN 2',
      icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/ESPN2_logo.svg/1280px-ESPN2_logo.svg.png',
      source: 'fallback',
      hasPrograms: false,
      programCount: 0
    },
    {
      id: 'foxsports1.us',
      channelId: 'foxsports1.us',
      channelName: 'Fox Sports 1',
      name: 'Fox Sports 1',
      icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/2015_Fox_Sports_1_logo.svg/1280px-2015_Fox_Sports_1_logo.svg.png',
      source: 'fallback',
      hasPrograms: false,
      programCount: 0
    },
    {
      id: 'fanduelsportsnetwork.us',
      channelId: 'fanduelsportsnetwork.us',
      channelName: 'FanDuel Sports Network',
      name: 'FanDuel Sports Network',
      icon: 'https://res.cloudinary.com/crunchbase-production/image/upload/c_lpad,h_256,w_256,f_auto,q_auto:eco,dpr_1/v1456376356/rqni5l1ajd0xcxvrqscf.png',
      source: 'fallback',
      hasPrograms: false,
      programCount: 0
    },
    {
      id: 'fanduelsportsnetworkoklahoma.us',
      channelId: 'fanduelsportsnetworkoklahoma.us',
      channelName: 'FanDuel Sports Network Oklahoma',
      name: 'FanDuel Sports Network Oklahoma',
      icon: 'https://res.cloudinary.com/crunchbase-production/image/upload/c_lpad,h_256,w_256,f_auto,q_auto:eco,dpr_1/v1456376356/rqni5l1ajd0xcxvrqscf.png',
      source: 'fallback',
      hasPrograms: false,
      programCount: 0
    }
  ];
}

// Export functions
module.exports = {
  findAndExposeEpgData,
  getAllAvailableChannels,
  formatChannels,
  getFallbackChannels,
  // This will be set by findAndExposeEpgData if data is found
  epgData: null
}; 