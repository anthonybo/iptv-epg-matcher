/**
 * Emergency fix for readChunkedCache function
 * This will be loaded early in the application startup
 */
const fs = require('fs');
const path = require('path');
const logger = require('./config/logger');
const { CACHE_DIR } = require('./config/constants');

// Export the function globally as a temporary fix
global.readChunkedCache = function(metadata, chunkDir) {
  try {
    logger.info(`Reading chunked source: ${metadata.sourceKey}`);
    
    // Initialize the reconstructed source
    const source = {
      channels: [],
      programs: [],
      channelMap: {},
      programMap: {}
    };
    
    // Process each chunk
    for (const chunk of metadata.chunks || []) {
      const chunkPath = path.join(CACHE_DIR, chunk.path);
      
      if (!fs.existsSync(chunkPath)) {
        logger.warn(`Chunk file not found: ${chunkPath}`);
        continue;
      }
      
      try {
        const chunkData = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
        
        // Process based on chunk type
        switch (chunk.type) {
          case 'channels':
            source.channels = chunkData.data || [];
            logger.debug(`Loaded ${source.channels.length} channels from chunk`);
            break;
          
          case 'channelMap':
            source.channelMap = chunkData.data || {};
            logger.debug(`Loaded channel map with ${Object.keys(source.channelMap).length} entries from chunk`);
            break;
          
          case 'programMap':
            source.programMap = chunkData.data || {};
            logger.debug(`Loaded program map with ${Object.keys(source.programMap).length} entries from chunk`);
            break;
          
          case 'programs':
            // Add programs to the array
            if (chunkData.data && Array.isArray(chunkData.data)) {
              source.programs.push(...chunkData.data);
              logger.debug(`Loaded ${chunkData.data.length} programs from chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks || 1}`);
            }
            break;
          
          default:
            logger.warn(`Unknown chunk type: ${chunk.type}`);
        }
      } catch (chunkError) {
        logger.error(`Error loading chunk ${chunk.path}: ${chunkError.message}`);
      }
    }
    
    logger.info(`Successfully reconstructed chunked source ${metadata.sourceKey}: ${source.channels.length} channels, ${source.programs.length} programs`);
    return source;
  } catch (e) {
    logger.error(`Failed to read chunked cache: ${e.message}`, { error: e.message, stack: e.stack });
    return null;
  }
};

// Log that the function has been loaded
logger.info('Emergency readChunkedCache function loaded globally');