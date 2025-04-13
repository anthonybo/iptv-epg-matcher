const fs = require('fs');
const path = require('path');
const util = require('util');
const zlib = require('zlib');
const sax = require('sax');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const readFile = promisify(fs.readFile);
const logger = require('./logger');

// Add a function to throttle logging
const shouldLogProgress = (current, total) => {
  // Only log on the first item, every 10000 items, and at 100%
  return current === 1 || 
         current % 10000 === 0 || 
         (total > 0 && current === total);
};

/**
 * Parse an EPG XML file into channels and programs using streaming
 * @param {string} xmlPath - Path to the XML file
 * @param {string} sourceKey - Identifier for the source
 * @returns {Object} - Object containing channels and programs
 */
const parseEpgXml = async (xmlPath, sourceKey) => {
  logger.info(`Starting to parse EPG XML from ${path.basename(xmlPath)} for source ${sourceKey}`);
  
  try {
    // Create a streaming parser instead of loading the whole file
    const parser = sax.createStream(true, {
      trim: true,
      normalize: true,
      position: false
    });
    
    let currentTag = null;
    let currentChannelId = null;
    let currentProgram = null;
    let textContent = '';
    
    const channels = {};
    const programs = {};
    
    let channelCount = 0;
    let programCount = 0;
    
    return new Promise((resolve, reject) => {
      parser.on('error', (err) => {
        logger.error(`Error parsing EPG XML: ${err.message}`);
        reject(err);
      });
      
      parser.on('text', (text) => {
        textContent += text;
      });
      
      parser.on('opentag', (node) => {
        currentTag = node.name;
        
        if (currentTag === 'channel') {
          channelCount++;
          // Log progress at reasonable intervals
          if (shouldLogProgress(channelCount, -1)) {
            logger.info(`Parsed ${channelCount} channels from ${path.basename(xmlPath)}`);
          }
          
          currentChannelId = node.attributes.id;
          if (currentChannelId) {
            channels[currentChannelId] = {
              id: currentChannelId,
              name: '',
              icon: '',
              sourceKey
            };
          }
        } else if (currentTag === 'programme') {
          programCount++;
          // Log progress at reasonable intervals
          if (shouldLogProgress(programCount, -1)) {
            logger.info(`Parsed ${programCount} programs from ${path.basename(xmlPath)}`);
          }
          
          const attrs = node.attributes;
          if (attrs.start && attrs.stop && attrs.channel) {
            const programId = `${attrs.channel}-${attrs.start}`;
            currentProgram = {
              id: programId,
              channelId: attrs.channel,
              start: attrs.start,
              stop: attrs.stop,
              title: '',
              description: '',
              sourceKey
            };
          }
        }
        
        textContent = '';
      });
      
      parser.on('closetag', (tagName) => {
        if (tagName === 'channel') {
          currentChannelId = null;
        } else if (tagName === 'programme' && currentProgram) {
          programs[currentProgram.id] = currentProgram;
          currentProgram = null;
        } else if (currentChannelId && channels[currentChannelId]) {
          if (tagName === 'display-name') {
            channels[currentChannelId].name = textContent.trim();
          } else if (tagName === 'icon' && currentTag === 'icon') {
            // Icon URL might be in an attribute, not in text content
          }
        } else if (currentProgram) {
          if (tagName === 'title') {
            currentProgram.title = textContent.trim();
          } else if (tagName === 'desc') {
            currentProgram.description = textContent.trim();
          }
        }
        
        currentTag = null;
        textContent = '';
      });
      
      parser.on('end', () => {
        logger.info(`Finished parsing EPG XML. Found ${channelCount} channels and ${programCount} programs from ${path.basename(xmlPath)}`);
        resolve({ channels, programs });
      });
      
      // Create read stream and pipe to parser
      const readStream = fs.createReadStream(xmlPath, { encoding: 'utf8' });
      readStream.pipe(parser);
      
      // Handle read stream errors
      readStream.on('error', (err) => {
        logger.error(`Error reading EPG file stream: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    logger.error(`Error reading EPG XML file: ${error.message}`);
    return { channels: {}, programs: {} };
  }
};

/**
 * Process an EPG file (which might be compressed)
 * @param {string} filePath - Path to the EPG file
 * @param {string} sourceKey - Identifier for the source
 * @returns {Object} - Object containing channels and programs
 */
const processEpgFile = async (filePath, sourceKey) => {
  logger.info(`Processing EPG file: ${path.basename(filePath)} for source ${sourceKey}`);
  
  try {
    // Check if the file is gzipped
    const isGzipped = path.extname(filePath).toLowerCase() === '.gz';
    
    if (isGzipped) {
      // For gzipped files, create a temporary file and process it
      const tempPath = path.join(path.dirname(filePath), `_temp_${path.basename(filePath, '.gz')}`);
      
      // Create decompression stream
      const gzipStream = fs.createReadStream(filePath);
      const gunzipStream = zlib.createGunzip();
      const writeStream = fs.createWriteStream(tempPath);
      
      logger.info(`Decompressing gzipped EPG file: ${path.basename(filePath)}`);
      
      // Pipe streams: read -> gunzip -> write
      await new Promise((resolve, reject) => {
        const pipeline = gzipStream.pipe(gunzipStream).pipe(writeStream);
        pipeline.on('finish', resolve);
        pipeline.on('error', reject);
      });
      
      logger.info(`Decompression complete, parsing XML: ${path.basename(tempPath)}`);
      
      // Parse the decompressed XML
      const result = await parseEpgXml(tempPath, sourceKey);
      
      // Clean up temporary file
      try {
        await fs.promises.unlink(tempPath);
      } catch (err) {
        logger.warn(`Warning: Could not delete temporary file ${tempPath}: ${err.message}`);
      }
      
      return result;
    } else {
      return await parseEpgXml(filePath, sourceKey);
    }
  } catch (error) {
    logger.error(`Error processing EPG file ${filePath}: ${error.message}`);
    return { channels: {}, programs: {} };
  }
};

module.exports = {
  parseEpgXml,
  processEpgFile
}; 