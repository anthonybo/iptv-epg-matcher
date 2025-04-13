/**
 * EPG Parser Service - Efficient EPG XML parsing with streaming
 * Parses EPG XML directly into the database to minimize memory usage
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xmltv = require('xmltv');
const crypto = require('crypto');
const logger = require('../config/logger');
const db = require('./databaseService');
const { XMLParser } = require('fast-xml-parser');

/**
 * Parse EPG data from a URL or file and store in the database
 * @param {string} source - URL or file path to the EPG data
 * @param {string} sourceName - Name for the EPG source
 * @returns {Promise} Promise resolving to parsing statistics
 */
async function parseEpgSource(source, sourceName) {
  try {
    // Generate ID for this source
    const sourceId = generateSourceId(source, sourceName);
    
    // Determine if source is a URL or file path
    const isUrl = source.startsWith('http://') || source.startsWith('https://');
    
    logger.info(`Starting EPG parsing for ${sourceName} (${sourceId}) from ${isUrl ? 'URL' : 'file'}: ${source}`);
    
    // Add source to the database
    await db.addSource({
      id: sourceId,
      name: sourceName || `EPG Source ${sourceId}`,
      url: isUrl ? source : null,
      filePath: !isUrl ? source : null
    });
    
    // Get the XML content
    let xmlContent;
    if (isUrl) {
      xmlContent = await fetchXmlFromUrl(source);
    } else {
      xmlContent = await readXmlFromFile(source);
    }
    
    if (!xmlContent) {
      throw new Error(`Failed to get XML content from source: ${source}`);
    }
    
    // Parse the XML content
    const result = await parseXmlContent(xmlContent, sourceId);
    
    // Update source statistics
    await db.updateSourceStats(sourceId, result.channelCount, result.programCount);
    
    logger.info(`EPG parsing complete for ${sourceName}: ${result.channelCount} channels, ${result.programCount} programs`);
    
    return {
      sourceId,
      sourceName,
      ...result
    };
  } catch (error) {
    logger.error(`Error parsing EPG source ${sourceName}: ${error.message}`);
    throw error;
  }
}

/**
 * Generate a unique source ID based on source URL/path and name
 */
function generateSourceId(source, name) {
  const input = `${source}:${name || ''}`;
  return crypto.createHash('md5').update(input).digest('hex');
}

/**
 * Fetch XML content from a URL
 */
async function fetchXmlFromUrl(url) {
  try {
    logger.info(`Fetching EPG data from URL: ${url}`);
    
    const response = await axios.get(url, {
      responseType: 'text',
      timeout: 60000, // 60 second timeout
      maxContentLength: 100 * 1024 * 1024, // 100MB max size
      headers: {
        'Accept': 'application/xml, text/xml, */*',
        'User-Agent': 'EPG-Parser/1.0'
      }
    });
    
    if (response.status !== 200) {
      throw new Error(`Failed to fetch XML: HTTP status ${response.status}`);
    }
    
    logger.info(`Successfully fetched EPG data from URL: ${url} (size: ${response.data.length} bytes)`);
    return response.data;
  } catch (error) {
    logger.error(`Error fetching XML from URL ${url}: ${error.message}`);
    throw error;
  }
}

/**
 * Read XML content from a file
 */
async function readXmlFromFile(filePath) {
  try {
    logger.info(`Reading EPG data from file: ${filePath}`);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    // Read file content
    const content = fs.readFileSync(filePath, 'utf8');
    
    logger.info(`Successfully read EPG data from file: ${filePath} (size: ${content.length} bytes)`);
    return content;
  } catch (error) {
    logger.error(`Error reading XML from file ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Parse XML content using the xmltv library
 */
async function parseXmlContent(xmlContent, sourceId) {
  return new Promise((resolve, reject) => {
    let channelCount = 0;
    let programCount = 0;
    const channelBatch = [];
    const programBatch = [];
    const batchSize = 5000;
    
    logger.info(`Parsing XML content for source ${sourceId}`);
    
    // Create a parser
    const parser = xmltv.createParser();
    
    parser.on('channel', async (channel) => {
      try {
        // Extract channel data
        const channelData = {
          id: channel.id,
          source: sourceId,
          name: channel.displayNames?.[0]?.name || channel.id,
          icon: channel.icon?.src,
          language: channel.displayNames?.[0]?.lang,
          category: null,
          country: null
        };
        
        // Add to batch
        channelBatch.push(channelData);
        channelCount++;
        
        // Process in batches
        if (channelBatch.length >= batchSize) {
          await processBatch('channels', channelBatch);
        }
        
        // Log progress
        if (channelCount % 500 === 0) {
          logger.debug(`Parsed ${channelCount} channels`);
        }
      } catch (error) {
        logger.error(`Error processing channel ${channel.id}: ${error.message}`);
      }
    });
    
    parser.on('programme', async (program) => {
      try {
        // Generate unique ID for the program
        const programId = generateProgramId(program);
        
        // Extract program data
        const programData = {
          id: programId,
          channelId: program.channel,
          title: program.title?.[0]?.value || 'Unknown Program',
          start: program.start,
          stop: program.stop,
          description: program.desc?.[0]?.value || null,
          category: program.category?.[0]?.value || null,
          episode: program.episodeNum?.[0]?.value || null,
          season: null,
          year: program.date || null,
          poster: null
        };
        
        // Add to batch
        programBatch.push(programData);
        programCount++;
        
        // Process in batches
        if (programBatch.length >= batchSize) {
          await processBatch('programs', programBatch);
        }
        
        // Log progress
        if (programCount % 50000 === 0) {
          logger.info(`Parsed ${programCount} programs for source ${sourceId}`);
        }
      } catch (error) {
        logger.error(`Error processing program: ${error.message}`);
      }
    });
    
    parser.on('end', async () => {
      try {
        // Process any remaining channels
        if (channelBatch.length > 0) {
          await processBatch('channels', channelBatch);
        }
        
        // Process any remaining programs
        if (programBatch.length > 0) {
          await processBatch('programs', programBatch);
        }
        
        logger.info(`Parsing complete for source ${sourceId}: ${channelCount} channels, ${programCount} programs`);
        
        resolve({
          channelCount,
          programCount,
          success: true
        });
      } catch (error) {
        logger.error(`Error finalizing parse: ${error.message}`);
        reject(error);
      }
    });
    
    parser.on('error', (error) => {
      logger.error(`Parser error: ${error.message}`);
      reject(error);
    });
    
    // Process batches of channels or programs
    async function processBatch(type, batch) {
      try {
        if (type === 'channels') {
          await db.addChannels([...batch]);
          batch.length = 0; // Clear the array
        } else if (type === 'programs') {
          await db.addPrograms([...batch]);
          batch.length = 0; // Clear the array
        }
      } catch (error) {
        logger.error(`Error processing ${type} batch: ${error.message}`);
        throw error;
      }
    }
    
    // Generate a unique ID for a program
    function generateProgramId(program) {
      const input = `${program.channel}:${program.start}:${program.title?.[0]?.value || ''}`;
      return crypto.createHash('md5').update(input).digest('hex');
    }
    
    // Start parsing
    try {
      parser.write(xmlContent);
      parser.end();
    } catch (error) {
      logger.error(`Error starting parse: ${error.message}`);
      reject(error);
    }
  });
}

/**
 * Parse multiple EPG sources
 * @param {Array} sources - Array of source objects with url/path and name properties
 * @returns {Promise} Promise resolving to parsing statistics
 */
async function parseMultipleSources(sources) {
  try {
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      throw new Error('No EPG sources provided');
    }
    
    logger.info(`Starting parsing of ${sources.length} EPG sources`);
    
    const results = [];
    
    for (const source of sources) {
      try {
        // Get the source URL or file path and name
        const sourceUrl = source.url || source.path || source.filePath || source;
        const sourceName = source.name || `EPG Source ${results.length + 1}`;
        
        // Parse the source
        const result = await parseEpgSource(sourceUrl, sourceName);
        results.push(result);
      } catch (error) {
        logger.error(`Error parsing source ${source.name || source.url || source}: ${error.message}`);
        results.push({ error: error.message, source });
      }
    }
    
    // Calculate total stats
    const totalChannels = results.reduce((sum, r) => sum + (r.channelCount || 0), 0);
    const totalPrograms = results.reduce((sum, r) => sum + (r.programCount || 0), 0);
    
    logger.info(`Completed parsing of ${results.length} EPG sources: ${totalChannels} channels, ${totalPrograms} programs`);
    
    return {
      sources: results,
      totalChannels,
      totalPrograms,
      success: true
    };
  } catch (error) {
    logger.error(`Error parsing multiple sources: ${error.message}`);
    throw error;
  }
}

/**
 * Scan a directory for XMLTV files and parse them
 * @param {string} directory - Directory path to scan
 * @returns {Promise} Promise resolving to parsing statistics
 */
async function parseDirectorySources(directory) {
  try {
    logger.info(`Scanning directory for EPG files: ${directory}`);
    
    // Check if directory exists
    if (!fs.existsSync(directory)) {
      throw new Error(`Directory not found: ${directory}`);
    }
    
    // Get all files in the directory
    const files = fs.readdirSync(directory);
    
    // Filter for XML or XMLTV files
    const xmlFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ext === '.xml' || ext === '.xmltv';
    });
    
    if (xmlFiles.length === 0) {
      logger.warn(`No XML or XMLTV files found in directory: ${directory}`);
      return {
        sources: [],
        totalChannels: 0,
        totalPrograms: 0,
        success: true
      };
    }
    
    logger.info(`Found ${xmlFiles.length} XML/XMLTV files in directory: ${directory}`);
    
    // Create source objects
    const sources = xmlFiles.map(file => ({
      path: path.join(directory, file),
      name: path.basename(file, path.extname(file))
    }));
    
    // Parse all sources
    return await parseMultipleSources(sources);
  } catch (error) {
    logger.error(`Error parsing directory sources: ${error.message}`);
    throw error;
  }
}

// Configuration
const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  trimValues: true,
};

// Helper to generate a unique ID
const generateId = (str) => {
  return crypto.createHash('md5').update(str).digest('hex');
};

// EPG Parser Service
const epgParserService = {
  /**
   * Load EPG data from a directory containing XML/XMLTV files
   * @param {string} directoryPath - Path to directory containing EPG files
   * @returns {Promise<Object>} - Result of the loading operation
   */
  async loadFromDirectory(directoryPath) {
    try {
      logger.info(`Loading EPG data from directory: ${directoryPath}`);
      
      // Check if directory exists
      if (!fs.existsSync(directoryPath)) {
        throw new Error(`Directory does not exist: ${directoryPath}`);
      }
      
      // Get all XML files in the directory
      const files = fs.readdirSync(directoryPath)
        .filter(file => file.endsWith('.xml') || file.endsWith('.xmltv'))
        .map(file => path.join(directoryPath, file));
      
      if (files.length === 0) {
        throw new Error(`No XML or XMLTV files found in directory: ${directoryPath}`);
      }
      
      logger.info(`Found ${files.length} EPG files to process`);
      
      // Load each file
      const results = await Promise.all(
        files.map(file => this.loadFromFile(file))
      );
      
      // Aggregate results
      const totalResults = results.reduce((total, result) => {
        total.sources.push(...result.sources);
        total.totalChannels += result.totalChannels;
        total.totalPrograms += result.totalPrograms;
        return total;
      }, { sources: [], totalChannels: 0, totalPrograms: 0 });
      
      return {
        success: true,
        message: `Loaded ${totalResults.totalChannels} channels and ${totalResults.totalPrograms} programs from ${files.length} files`,
        sources: totalResults.sources,
        totalChannels: totalResults.totalChannels,
        totalPrograms: totalResults.totalPrograms,
      };
    } catch (error) {
      logger.error(`Error loading EPG data from directory: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Load EPG data from a single file
   * @param {string} filePath - Path to EPG XML/XMLTV file
   * @returns {Promise<Object>} - Result of the loading operation
   */
  async loadFromFile(filePath) {
    try {
      logger.info(`Loading EPG data from file: ${filePath}`);
      
      // Read file
      const xmlData = fs.readFileSync(filePath, 'utf8');
      
      // Parse XML
      const parser = new XMLParser(XML_PARSER_OPTIONS);
      const result = parser.parse(xmlData);
      
      // Extract source info
      const sourceId = generateId(filePath);
      const sourceName = path.basename(filePath, path.extname(filePath));
      
      // Add source to database
      await db.addSource({
        id: sourceId,
        name: sourceName,
        filePath: filePath,
      });
      
      // Process TV data
      const processed = await this.processTvData(result, sourceId);
      
      // Update source stats
      await db.updateSourceStats(
        sourceId,
        processed.channels.length,
        processed.programs.length
      );
      
      return {
        success: true,
        sources: [{
          id: sourceId,
          name: sourceName,
          file: filePath,
          channelCount: processed.channels.length,
          programCount: processed.programs.length,
        }],
        totalChannels: processed.channels.length,
        totalPrograms: processed.programs.length,
      };
    } catch (error) {
      logger.error(`Error loading EPG data from file: ${filePath} - ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Load EPG data from URLs
   * @param {Array<string>} urls - Array of URLs to EPG XML/XMLTV files
   * @returns {Promise<Object>} - Result of the loading operation
   */
  async loadFromUrls(urls) {
    try {
      logger.info(`Loading EPG data from ${urls.length} URLs`);
      
      // Load each URL
      const results = await Promise.all(
        urls.map(url => this.loadFromUrl(url))
      );
      
      // Aggregate results
      const totalResults = results.reduce((total, result) => {
        if (result.success) {
          total.sources.push(...result.sources);
          total.totalChannels += result.totalChannels;
          total.totalPrograms += result.totalPrograms;
        }
        return total;
      }, { sources: [], totalChannels: 0, totalPrograms: 0 });
      
      return {
        success: true,
        message: `Loaded ${totalResults.totalChannels} channels and ${totalResults.totalPrograms} programs from ${totalResults.sources.length} URLs`,
        sources: totalResults.sources,
        totalChannels: totalResults.totalChannels,
        totalPrograms: totalResults.totalPrograms,
      };
    } catch (error) {
      logger.error(`Error loading EPG data from URLs: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Load EPG data from a single URL
   * @param {string} url - URL to EPG XML/XMLTV file
   * @returns {Promise<Object>} - Result of the loading operation
   */
  async loadFromUrl(url) {
    try {
      logger.info(`Loading EPG data from URL: ${url}`);
      
      // Download XML data
      const response = await axios.get(url, {
        responseType: 'text',
        timeout: 30000, // 30 seconds timeout
      });
      
      const xmlData = response.data;
      
      // Parse XML
      const parser = new XMLParser(XML_PARSER_OPTIONS);
      const result = parser.parse(xmlData);
      
      // Extract source info
      const sourceId = generateId(url);
      const sourceName = url.split('/').pop().split('?')[0].replace(/\.(xml|xmltv)$/, '');
      
      // Add source to database
      await db.addSource({
        id: sourceId,
        name: sourceName,
        url: url,
      });
      
      // Process TV data
      const processed = await this.processTvData(result, sourceId);
      
      // Update source stats
      await db.updateSourceStats(
        sourceId,
        processed.channels.length,
        processed.programs.length
      );
      
      return {
        success: true,
        sources: [{
          id: sourceId,
          name: sourceName,
          url: url,
          channelCount: processed.channels.length,
          programCount: processed.programs.length,
        }],
        totalChannels: processed.channels.length,
        totalPrograms: processed.programs.length,
      };
    } catch (error) {
      logger.error(`Error loading EPG data from URL: ${url} - ${error.message}`);
      return {
        success: false,
        message: `Failed to load EPG data from URL: ${url} - ${error.message}`,
        sources: [],
        totalChannels: 0,
        totalPrograms: 0,
      };
    }
  },
  
  /**
   * Process TV data from parsed XML
   * @param {Object} data - Parsed XML data
   * @param {string} sourceId - Source ID
   * @returns {Promise<Object>} - Processed channels and programs
   */
  async processTvData(data, sourceId) {
    try {
      const tv = data.tv || data.TV;
      
      if (!tv) {
        throw new Error('Invalid EPG format: Missing tv/TV element');
      }
      
      // Process channels
      const channels = this.extractChannels(tv, sourceId);
      
      // Save channels to database
      if (channels.length > 0) {
        await db.addChannels(channels);
        logger.info(`Added ${channels.length} channels from source ${sourceId}`);
      } else {
        logger.warn(`No channels found in source ${sourceId}`);
      }
      
      // Process programs
      const programs = this.extractPrograms(tv);
      
      // Save programs to database in batches
      if (programs.length > 0) {
        const batchSize = 1000;
        let processed = 0;
        
        for (let i = 0; i < programs.length; i += batchSize) {
          const batch = programs.slice(i, Math.min(i + batchSize, programs.length));
          await db.addPrograms(batch);
          
          processed += batch.length;
          if (processed % 10000 === 0 || processed === programs.length) {
            logger.debug(`Added ${processed}/${programs.length} programs from source ${sourceId}`);
          }
        }
        
        logger.info(`Added ${programs.length} programs from source ${sourceId}`);
      } else {
        logger.warn(`No programs found in source ${sourceId}`);
      }
      
      return { channels, programs };
    } catch (error) {
      logger.error(`Error processing TV data: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Extract channels from TV data
   * @param {Object} tv - TV data
   * @param {string} sourceId - Source ID
   * @returns {Array<Object>} - Extracted channels
   */
  extractChannels(tv, sourceId) {
    try {
      // Handle both array and single channel cases
      const channelData = tv.channel ? (Array.isArray(tv.channel) ? tv.channel : [tv.channel]) : [];
      
      const channels = channelData.map(channel => {
        const id = channel['@_id'] || channel.id;
        
        if (!id) {
          logger.warn('Channel missing ID, skipping');
          return null;
        }
        
        // Extract display-name (could be string or object)
        let name;
        if (channel['display-name']) {
          if (typeof channel['display-name'] === 'string') {
            name = channel['display-name'];
          } else if (Array.isArray(channel['display-name'])) {
            name = channel['display-name'][0] || '';
            if (typeof name !== 'string') {
              name = name['#text'] || '';
            }
          } else {
            name = channel['display-name']['#text'] || '';
          }
        } else {
          name = id;
        }
        
        // Extract icon URL
        let icon = '';
        if (channel.icon) {
          icon = channel.icon['@_src'] || '';
        }
        
        return {
          id,
          sourceId,
          name,
          icon,
        };
      }).filter(Boolean);
      
      return channels;
    } catch (error) {
      logger.error(`Error extracting channels: ${error.message}`);
      return [];
    }
  },
  
  /**
   * Extract programs from TV data
   * @param {Object} tv - TV data
   * @returns {Array<Object>} - Extracted programs
   */
  extractPrograms(tv, sourceId) {
    try {
      // Handle both array and single program cases
      const programData = tv.programme ? (Array.isArray(tv.programme) ? tv.programme : [tv.programme]) : [];
      
      const programs = programData.map(program => {
        const channelId = program['@_channel'] || program.channel;
        
        if (!channelId) {
          logger.warn('Program missing channel ID, skipping');
          return null;
        }
        
        // Extract program title
        let title = '';
        if (program.title) {
          if (typeof program.title === 'string') {
            title = program.title;
          } else if (Array.isArray(program.title)) {
            title = program.title[0] || '';
            if (typeof title !== 'string') {
              title = title['#text'] || '';
            }
          } else {
            title = program.title['#text'] || '';
          }
        }
        
        if (!title) {
          logger.warn('Program missing title, skipping');
          return null;
        }
        
        // Extract program description
        let description = '';
        if (program.desc) {
          if (typeof program.desc === 'string') {
            description = program.desc;
          } else if (Array.isArray(program.desc)) {
            description = program.desc[0] || '';
            if (typeof description !== 'string') {
              description = description['#text'] || '';
            }
          } else {
            description = program.desc['#text'] || '';
          }
        }
        
        // Extract program category
        let category = '';
        if (program.category) {
          if (typeof program.category === 'string') {
            category = program.category;
          } else if (Array.isArray(program.category)) {
            category = program.category[0] || '';
            if (typeof category !== 'string') {
              category = category['#text'] || '';
            }
          } else {
            category = program.category['#text'] || '';
          }
        }
        
        // Extract program start and stop times
        const start = program['@_start'] || '';
        const stop = program['@_stop'] || '';
        
        // Parse dates in XMLTV format (YYYYMMDDHHMMSS +0000)
        let startTime, stopTime;
        
        try {
          if (start) {
            // Convert XMLTV date format to ISO string
            const year = start.substring(0, 4);
            const month = start.substring(4, 6) - 1; // Months are 0-indexed
            const day = start.substring(6, 8);
            const hour = start.substring(8, 10);
            const minute = start.substring(10, 12);
            const second = start.substring(12, 14) || '00';
            
            // Get timezone offset if present
            let tzOffset = '+0000';
            if (start.length > 14) {
              tzOffset = start.substring(14).trim();
            }
            
            // Create date string in ISO format
            const dateStr = `${year}-${month + 1}-${day}T${hour}:${minute}:${second}${tzOffset.replace(/^(\+|-)(\d{2})(\d{2})$/, '$1$2:$3')}`;
            startTime = new Date(dateStr).toISOString();
          } else {
            logger.warn('Program missing start time, using current time');
            startTime = new Date().toISOString();
          }
          
          if (stop) {
            // Convert XMLTV date format to ISO string
            const year = stop.substring(0, 4);
            const month = stop.substring(4, 6) - 1; // Months are 0-indexed
            const day = stop.substring(6, 8);
            const hour = stop.substring(8, 10);
            const minute = stop.substring(10, 12);
            const second = stop.substring(12, 14) || '00';
            
            // Get timezone offset if present
            let tzOffset = '+0000';
            if (stop.length > 14) {
              tzOffset = stop.substring(14).trim();
            }
            
            // Create date string in ISO format
            const dateStr = `${year}-${month + 1}-${day}T${hour}:${minute}:${second}${tzOffset.replace(/^(\+|-)(\d{2})(\d{2})$/, '$1$2:$3')}`;
            stopTime = new Date(dateStr).toISOString();
          } else {
            // If stop time is missing, set it to start time + 1 hour
            const endDate = new Date(startTime);
            endDate.setHours(endDate.getHours() + 1);
            stopTime = endDate.toISOString();
            logger.warn('Program missing stop time, using start time + 1 hour');
          }
        } catch (error) {
          logger.warn(`Error parsing program dates: ${error.message}, skipping`);
          return null;
        }
        
        // Generate a unique ID for the program
        const id = generateId(`${channelId}-${title}-${startTime}`);
        
        return {
          id,
          channelId,
          title,
          description,
          start: startTime,
          stop: stopTime,
          category,
        };
      }).filter(Boolean);
      
      return programs;
    } catch (error) {
      logger.error(`Error extracting programs: ${error.message}`);
      return [];
    }
  },
  
  /**
   * Clear all EPG data
   * @returns {Promise<Object>} - Result of the clearing operation
   */
  async clearAllData() {
    try {
      await db.clearEpgData();
      
      return {
        success: true,
        message: 'All EPG data cleared successfully',
      };
    } catch (error) {
      logger.error(`Error clearing EPG data: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Get database statistics
   * @returns {Promise<Object>} - Database statistics
   */
  async getStats() {
    try {
      const stats = await db.getDatabaseStats();
      
      return {
        success: true,
        stats,
      };
    } catch (error) {
      logger.error(`Error getting EPG stats: ${error.message}`);
      throw error;
    }
  },
};

module.exports = epgParserService; 