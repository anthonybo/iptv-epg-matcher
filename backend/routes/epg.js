/**
 * EPG Routes - handles EPG-related endpoints with throttled logging
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const logger = require('../utils/logger');
const sessionStorage = require('../utils/sessionStorage');
const sqlite3 = require('sqlite3').verbose();

// Path to the SQLite database created by epg_parser.py
const DB_PATH = path.join(__dirname, '../data/epg.db');

// Initialize database connection
let db = null;

const initDb = async () => {
  return new Promise((resolve, reject) => {
    if (db) {
      return resolve(db);
    }
    
    db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        logger.error(`Failed to open database: ${err.message}`);
        return reject(err);
      }
      
      logger.info(`Connected to SQLite database at ${DB_PATH}`);
      resolve(db);
    });
  });
};

// Initialize database on module load
initDb().catch(err => {
  logger.error(`Database initialization error: ${err.message}`);
});

// Helper to run queries with proper error handling
const runQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('Database not initialized'));
    }
    
    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.error(`Query error: ${err.message}, SQL: ${sql}, Params: ${JSON.stringify(params)}`);
        return reject(err);
      }
      resolve(rows);
    });
  });
};

// Get database statistics
const getDatabaseStats = async () => {
  try {
    await initDb();
    
    // Get source count
    const sourceCountResult = await runQuery('SELECT COUNT(*) as count FROM sources');
    const sourceCount = sourceCountResult[0]?.count || 0;
    
    // Get channel count
    const channelCountResult = await runQuery('SELECT COUNT(*) as count FROM channels');
    const channelCount = channelCountResult[0]?.count || 0;
    
    // Get program count
    const programCountResult = await runQuery('SELECT COUNT(*) as count FROM programs');
    const programCount = programCountResult[0]?.count || 0;
    
    // Get source details
    const sources = await runQuery('SELECT name, channel_count, program_count, last_updated FROM sources ORDER BY name');
    
    return {
      sourceCount,
      channelCount,
      programCount,
      sources,
      databasePath: DB_PATH
    };
  } catch (error) {
    logger.error(`Error getting database stats: ${error.message}`);
    return {
      sourceCount: 0,
      channelCount: 0,
      programCount: 0,
      sources: [],
      error: error.message,
      databasePath: DB_PATH
    };
  }
};

// Search for channels in the database
const searchChannels = async (query) => {
  try {
    await initDb();
    
    // Normalize the search term
    const searchTerm = query.toLowerCase().trim();
    
    // Use SQLite's LIKE operator for partial matching
    const sql = `
      SELECT c.id, c.name, c.icon, s.name as source_name,
             (SELECT COUNT(*) FROM programs WHERE channel_id = c.id) as program_count
      FROM channels c
      JOIN sources s ON c.source_id = s.id
      WHERE LOWER(c.name) LIKE ? 
      ORDER BY c.name
      LIMIT 100
    `;
    
    return await runQuery(sql, [`%${searchTerm}%`]);
  } catch (error) {
    logger.error(`Error searching channels: ${error.message}`);
    return [];
  }
};

// Get channel details by ID
const getChannelById = async (channelId) => {
  try {
    await initDb();
    
    logger.info(`Looking up channel by ID: "${channelId}"`);
    
    // First try exact match
    const sql = `
      SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
      FROM channels c
      JOIN sources s ON c.source_id = s.id
      WHERE c.id = ?
    `;
    
    let results = await runQuery(sql, [channelId]);
    
    // If no results, try variations
    if (results.length === 0) {
      logger.info(`No channel found for exact ID ${channelId}, trying variations`);
      
      // Try lowercase
      const lowerCaseId = channelId.toLowerCase();
      if (lowerCaseId !== channelId) {
        logger.info(`Trying lowercase variation: "${lowerCaseId}"`);
        results = await runQuery(sql, [lowerCaseId]);
      }
      
      // Try with/without .us domain suffix
      if (results.length === 0) {
        if (channelId.endsWith('.us')) {
          // Try without .us suffix
          const withoutUsSuffix = channelId.substring(0, channelId.length - 3);
          logger.info(`Trying without .us suffix: "${withoutUsSuffix}"`);
          results = await runQuery(sql, [withoutUsSuffix]);
        } else {
          // Try with .us suffix
          const withUsSuffix = `${channelId}.us`;
          logger.info(`Trying with .us suffix: "${withUsSuffix}"`);
          results = await runQuery(sql, [withUsSuffix]);
        }
      }
      
      // Try without spaces, dashes, dots
      if (results.length === 0) {
        const normalizedId = channelId.replace(/[\s\.\-_]+/g, '').toLowerCase();
        
        // Only if normalizing actually changed something
        if (normalizedId !== channelId.toLowerCase()) {
          // Search for channels with a similar ID
          const fuzzySearchSql = `
            SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
            FROM channels c
            JOIN sources s ON c.source_id = s.id
            WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(c.id, ' ', ''), '.', ''), '-', ''), '_', '')) = ?
            LIMIT 5
          `;
          
          logger.info(`Trying normalized ID (no special chars): "${normalizedId}"`);
          results = await runQuery(fuzzySearchSql, [normalizedId]);
        }
      }
      
      // Try directly searching for Travel Channel variations based on the name
      if (results.length === 0 && channelId.toLowerCase().includes('travel')) {
        logger.info(`Trying name-based lookup for Travel Channel variations`);
        const travelChannelSql = `
          SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
          FROM channels c
          JOIN sources s ON c.source_id = s.id
          WHERE LOWER(c.name) LIKE '%travel%channel%'
          ORDER BY 
            CASE 
              WHEN c.id = 'travelchannel.us' THEN 1
              WHEN c.id LIKE 'travelchannel.%' THEN 2
              WHEN c.id LIKE '%travel%channel%' THEN 3
              ELSE 4
            END,
            LENGTH(c.name)
          LIMIT 5
        `;
        results = await runQuery(travelChannelSql, []);
      }
      
      // Try to search by partial name matching
      if (results.length === 0 && channelId.length > 3) {
        // Try extracting a potential name from the ID
        // Replace common separators with spaces and convert to title case
        const potentialName = channelId
          .replace(/[_\.\-]/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
          .toLowerCase()
          .trim();
        
        if (potentialName.length > 3) {
          const nameSearchSql = `
            SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
            FROM channels c
            JOIN sources s ON c.source_id = s.id
            WHERE LOWER(c.name) LIKE ?
            ORDER BY 
              CASE 
                WHEN LOWER(c.name) = ? THEN 1
                WHEN LOWER(c.name) LIKE ? || '%' THEN 2
                ELSE 3
              END,
              LENGTH(c.name)
            LIMIT 1
          `;
          
          logger.info(`Trying name-based lookup with potential name: "${potentialName}"`);
          results = await runQuery(nameSearchSql, [
            `%${potentialName}%`, 
            potentialName,
            potentialName
          ]);
        }
      }
    }
    
    // If we found a match, return it with a note if it's not the exact ID
    if (results.length > 0) {
      const result = results[0];
      if (result.id !== channelId) {
        logger.info(`Found channel "${result.name}" with similar ID: "${result.id}" (originally requested: "${channelId}")`);
      } else {
        logger.info(`Found exact channel match: "${result.name}" (${result.id})`);
      }
      return result;
    }
    
    logger.info(`No matching channel found for ID: ${channelId}`);
    return null;
  } catch (error) {
    logger.error(`Error getting channel by ID: ${error.message}`);
    return null;
  }
};

// Get programs for a channel
const getProgramsByChannelId = async (channelId, startTime, endTime) => {
  try {
    await initDb();
    
    // Default time window: from now to 24 hours later
    const now = startTime || new Date();
    const tomorrow = endTime || new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    // Format date objects to ISO strings for SQLite comparison
    const nowStr = now.toISOString();
    const tomorrowStr = tomorrow.toISOString();
    
    // Log the time window for debugging
    logger.info(`Searching for programs between ${nowStr} and ${tomorrowStr}`);
    logger.info(`Channel ID to search: ${channelId}`);
    
    // Try directly checking if any programs exist for this channel
    const countSql = `
      SELECT COUNT(*) as count
      FROM programs
      WHERE channel_id = ?
    `;
    
    const countResult = await runQuery(countSql, [channelId]);
    const totalPrograms = countResult[0]?.count || 0;
    
    if (totalPrograms > 0) {
      logger.info(`Found ${totalPrograms} total programs for channel ${channelId} in database`);
      
      // Get a sample to see date format
      const sampleSql = `
        SELECT id, title, start, stop
        FROM programs
        WHERE channel_id = ?
        LIMIT 3
      `;
      
      const samplePrograms = await runQuery(sampleSql, [channelId]);
      if (samplePrograms.length > 0) {
        logger.info(`Sample program dates: ${JSON.stringify(samplePrograms.map(p => ({ 
          title: p.title,
          start: p.start,
          stop: p.stop
        })))}`);
      }
    }
    
    // Normalize channel ID to improve matching
    let normalizedChannelId = channelId;
    let programs = [];
    
    // First try exact match with corrected time window logic
    // Programs that START before the end time AND END after the start time
    const sql = `
      SELECT id, title, description, start, stop, channel_id
      FROM programs
      WHERE channel_id = ? AND start < ? AND stop > ?
      ORDER BY start
      LIMIT 100
    `;
    
    programs = await runQuery(sql, [normalizedChannelId, tomorrowStr, nowStr]);
    
    // If no results, try using a broader time window
    if (programs.length === 0) {
      logger.info(`No programs found for ${channelId} in normal time window, trying without time restrictions`);
      
      const allProgramsSql = `
        SELECT id, title, description, start, stop, channel_id
        FROM programs
        WHERE channel_id = ?
        ORDER BY start
        LIMIT 100
      `;
      
      programs = await runQuery(allProgramsSql, [normalizedChannelId]);
      
      if (programs.length > 0) {
        logger.info(`Found ${programs.length} programs for ${channelId} without time restrictions`);
        return programs;
      }
    }
    
    // If no results, try variations of the channel ID
    if (programs.length === 0) {
      logger.info(`No programs found for exact ID ${normalizedChannelId}, trying variations`);
      
      // Try different case (lowercase)
      const lowerCaseId = normalizedChannelId.toLowerCase();
      if (lowerCaseId !== normalizedChannelId) {
        programs = await runQuery(sql, [lowerCaseId, tomorrowStr, nowStr]);
      }
      
      // If still no results, try with/without .us domain suffix
      if (programs.length === 0) {
        if (normalizedChannelId.endsWith('.us')) {
          // Try without .us suffix
          const withoutUsSuffix = normalizedChannelId.substring(0, normalizedChannelId.length - 3);
          programs = await runQuery(sql, [withoutUsSuffix, tomorrowStr, nowStr]);
        } else {
          // Try with .us suffix
          const withUsSuffix = `${normalizedChannelId}.us`;
          programs = await runQuery(sql, [withUsSuffix, tomorrowStr, nowStr]);
        }
      }
      
      // If still no results, try searching for the channel first
      if (programs.length === 0) {
        logger.info(`Still no programs found for ID variations, searching by channel name`);
        
        // Find the channel by its ID
        const channelInfo = await getChannelById(normalizedChannelId);
        
        if (channelInfo) {
          // If we found the channel, look for any programs with matching name
          const channelSearchSql = `
            SELECT c.id 
            FROM channels c
            WHERE LOWER(c.name) LIKE ? 
            LIMIT 10
          `;
          
          const channelNamePattern = `%${channelInfo.name.toLowerCase().replace(/\s+/g, '%')}%`;
          const matchingChannels = await runQuery(channelSearchSql, [channelNamePattern]);
          
          if (matchingChannels.length > 0) {
            const channelIds = matchingChannels.map(c => c.id);
            
            // Look for programs for any of these channel IDs with corrected time window logic
            const programsByNameSql = `
              SELECT id, title, description, start, stop, channel_id
              FROM programs
              WHERE channel_id IN (${channelIds.map(() => '?').join(',')}) 
                AND start < ? 
                AND stop > ?
              ORDER BY start
              LIMIT 100
            `;
            
            programs = await runQuery(
              programsByNameSql, 
              [...channelIds, tomorrowStr, nowStr]
            );
            
            if (programs.length > 0) {
              logger.info(`Found ${programs.length} programs via channel name match`);
            }
          }
        }
      }
    }
    
    // If still no programs, try a more lenient time window (next 7 days)
    if (programs.length === 0) {
      logger.info(`No programs found within 24 hour window, trying extended 7-day window`);
      const extendedEndTime = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const extendedEndStr = extendedEndTime.toISOString();
      
      const extendedSql = `
        SELECT id, title, description, start, stop, channel_id
        FROM programs
        WHERE channel_id = ? AND start < ? AND stop > ?
        ORDER BY start
        LIMIT 100
      `;
      
      programs = await runQuery(extendedSql, [normalizedChannelId, extendedEndStr, nowStr]);
    }
    
    // If still no programs, try without time constraints at all
    if (programs.length === 0) {
      logger.info(`No programs found with time constraints, retrieving any programs available for this channel`);
      
      const anyProgramsSql = `
        SELECT id, title, description, start, stop, channel_id
        FROM programs
        WHERE channel_id = ?
        ORDER BY start
        LIMIT 100
      `;
      
      programs = await runQuery(anyProgramsSql, [normalizedChannelId]);
    }
    
    logger.info(`Returning ${programs.length} programs for channel ${channelId}`);
    return programs;
  } catch (error) {
    logger.error(`Error getting programs for channel: ${error.message}`);
    return [];
  }
};

// Run the Python parser
const runEpgParser = async (options = {}) => {
  return new Promise((resolve, reject) => {
    const pythonPath = 'python3'; // Adjust according to your environment
    const scriptPath = path.join(__dirname, '../epg_parser.py');
    
    let args = [];
    
    if (options.force) {
      args.push('--force');
    }
    
    if (options.source) {
      args.push(`--source=${options.source}`);
    }
    
    const cmd = `${pythonPath} ${scriptPath} ${args.join(' ')}`;
    
    logger.info(`Running EPG parser: ${cmd}`);
    
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        logger.error(`EPG parser error: ${error.message}`);
        logger.error(`Stderr: ${stderr}`);
        return reject(error);
      }
      
      logger.info(`EPG parser completed successfully`);
      logger.debug(`Stdout: ${stdout}`);
      
      resolve({
        success: true,
        output: stdout
      });
    });
  });
};

// Get categories for a session
const getCategories = async (sessionId) => {
  try {
    const session = sessionStorage.getSession(sessionId);
    if (!session || !session.data || !session.data.channels || !Array.isArray(session.data.channels)) {
      logger.warn(`No channels found in session ${sessionId} for categories`);
      return [];
    }
    
    // Get unique categories from channels
    const categories = new Set();
    session.data.channels.forEach(channel => {
      if (channel.group && typeof channel.group === 'string') {
        categories.add(channel.group);
      }
    });
    
    return Array.from(categories).sort();
  } catch (error) {
    logger.error(`Error getting categories: ${error.message}`);
    return [];
  }
};

/**
 * POST /init
 * Initialize EPG session
 */
router.post('/init', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    logger.info(`Initializing EPG session ${sessionId}`);
    
    // Initialize database
    await initDb();
    
    // Check for existing session
    let session = sessionStorage.getSession(sessionId);
    
    if (!session) {
      logger.info(`Creating new EPG session ${sessionId}`);
      session = sessionStorage.createSession(sessionId, {
        data: {
          channels: []
        }
      });
    } else if (!session.data || !session.data.channels) {
      // Make sure channels array exists
      logger.info(`Updating EPG session ${sessionId} with channels array`);
      session = sessionStorage.updateSession(sessionId, {
        data: {
          channels: []
        }
      });
    }
    
    // Get database stats
    const stats = await getDatabaseStats();
    
    return res.json({
      success: true,
      sessionId,
      message: `EPG session initialized with ID ${sessionId}`,
      stats,
      dbType: 'sqlite'
    });
  } catch (error) {
    logger.error(`Error initializing EPG session: ${error.message}`);
    return res.status(500).json({
      error: `Failed to initialize EPG session: ${error.message}`
    });
  }
});

/**
 * GET /search
 * Global search endpoint without session
 */
router.get('/search', async (req, res) => {
  try {
    const { query } = req.query;

    logger.info(`Global search requested for term: ${query}`);
    
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }
    
    // Initialize database
    await initDb();
    
    // Search channels in the database
    const results = await searchChannels(query);
    
    // Get database stats
    const stats = await getDatabaseStats();
    
    return res.json({
      results,
      term: query,
      sessionId: `db_${Date.now()}`,
      sourceCount: stats.sourceCount,
      channelCount: stats.channelCount,
      matches: results.length,
      message: results.length > 0 
        ? `Found ${results.length} matches for "${query}"`
        : `No matches found for "${query}"`
    });
  } catch (error) {
    logger.error(`Error in global search: ${error.message}`);
    res.status(500).json({ error: `Search error: ${error.message}` });
  }
});

/**
 * GET /debug/stats
 * Get database statistics
 */
router.get('/debug/stats', async (req, res) => {
  try {
    // Initialize database
    await initDb();
    
    // Get database stats
    const stats = await getDatabaseStats();

    res.json({
      stats,
      status: 'Database is operational',
      databasePath: stats.databasePath,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error getting database stats: ${error.message}`);
    res.status(500).json({ error: `Failed to get database stats: ${error.message}` });
  }
});

/**
 * POST /parse
 * Parse EPG from URL or file using epg_parser.py
 */
router.post('/parse', async (req, res) => {
  try {
    const { url, force = false } = req.body;
    
    // Start parsing in the background
    res.json({
      status: 'EPG parsing started',
      source: url || 'all sources',
      timestamp: new Date().toISOString()
    });
    
    // Run the EPG parser
    const options = {
      force,
      source: url
    };
    
    runEpgParser(options).then(result => {
      logger.info(`EPG parse completed: ${result.success}`);
    }).catch(error => {
      logger.error(`EPG parse error: ${error.message}`);
    });
  } catch (error) {
    logger.error(`Error parsing EPG: ${error.message}`);
  }
});

/**
 * GET /:sessionId/categories
 * Get categories for session (with proper 200 response)
 */
router.get('/:sessionId/categories', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.debug(`REQUEST RECEIVED for categories: sessionId=${sessionId}`);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    const categories = await getCategories(sessionId);
    
    return res.json({
      success: true,
      sessionId,
      categories,
      count: categories.length
    });
  } catch (error) {
    logger.error(`Error getting categories: ${error.message}`);
    return res.status(500).json({ error: `Failed to get categories: ${error.message}` });
  }
});

/**
 * GET /:sessionId/search
 * Search for channels across EPG sources with session
 */
router.get('/:sessionId/search', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { term } = req.query;
    
    logger.info(`Search requested for session ${sessionId}, term: ${term}`);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    if (!term || term.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }
    
    const session = sessionStorage.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Initialize database
    await initDb();
    
    // Search channels in the database
    const results = await searchChannels(term);
    
    // Get database stats
    const stats = await getDatabaseStats();
    
    // Store search in session history
    if (!session.searchHistory) {
      session.searchHistory = [];
    }
    session.searchHistory.push({
      term,
      timestamp: new Date().toISOString(),
      resultCount: results.length
    });
    session.updated = new Date().toISOString();
    sessionStorage.updateSession(sessionId, session);
    
    return res.json({
      results,
      term,
      sessionId,
      sourceCount: stats.sourceCount,
      channelCount: stats.channelCount,
      matches: results.length,
      message: results.length > 0 
        ? `Found ${results.length} matches for "${term}"`
        : `No matches found for "${term}"`
    });
  } catch (error) {
    logger.error(`Error searching EPG data: ${error.message}`);
    res.status(500).json({ error: `Search error: ${error.message}` });
  }
});
  
/**
 * GET /:sessionId
 * Get channel data by channelId
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { channelId } = req.query;
    
    if (!channelId) {
      return res.status(400).json({ 
        error: 'Channel ID is required',
        success: false
      });
    }
    
    logger.info(`Getting EPG data for channel: ${channelId}`);
    
    // Initialize database
    await initDb();
    
    try {
      // Get channel info
      const channelInfo = await getChannelById(channelId);
      
      if (!channelInfo) {
        return res.status(404).json({
          error: `Channel not found: ${channelId}`,
          success: false,
          channelId
        });
      }
      
      // Get time window: from now to 7 days later (extended from 24 hours)
      const now = new Date();
      const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      
      // Log the time window for debugging
      logger.info(`Searching for programs between ${now.toISOString()} and ${endDate.toISOString()} (7-day window)`);
      
      // Get programs for this channel
      let programs = await getProgramsByChannelId(channelId, now, endDate);
      
      // Format the dates properly for the frontend
      programs = programs.map(program => {
        // Handle EPG date format like "20250412100000 +0000"
        try {
          if (program.start && typeof program.start === 'string') {
            // Parse date format YYYYMMDDHHMMSS +ZZZZ
            const dateStr = program.start;
            if (dateStr.match(/^\d{14}\s+[\+\-]\d{4}$/)) {
              const year = dateStr.substring(0, 4);
              const month = dateStr.substring(4, 6);
              const day = dateStr.substring(6, 8);
              const hour = dateStr.substring(8, 10);
              const minute = dateStr.substring(10, 12);
              const second = dateStr.substring(12, 14);
              const tzOffset = dateStr.substring(15);
              
              // Create ISO format date 
              const isoDate = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzOffset.replace(/(\+|\-)(\d{2})(\d{2})/, '$1$2:$3')}`;
              program.start = isoDate;
              logger.debug(`Converted program start date from ${dateStr} to ${isoDate}`);
            }
          }
          
          if (program.stop && typeof program.stop === 'string') {
            // Parse date format YYYYMMDDHHMMSS +ZZZZ
            const dateStr = program.stop;
            if (dateStr.match(/^\d{14}\s+[\+\-]\d{4}$/)) {
              const year = dateStr.substring(0, 4);
              const month = dateStr.substring(4, 6);
              const day = dateStr.substring(6, 8);
              const hour = dateStr.substring(8, 10);
              const minute = dateStr.substring(10, 12);
              const second = dateStr.substring(12, 14);
              const tzOffset = dateStr.substring(15);
              
              // Create ISO format date 
              const isoDate = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzOffset.replace(/(\+|\-)(\d{2})(\d{2})/, '$1$2:$3')}`;
              program.stop = isoDate;
              logger.debug(`Converted program stop date from ${dateStr} to ${isoDate}`);
            }
          }
        } catch (error) {
          logger.error(`Error formatting program dates: ${error.message}`, { program });
        }
        
        return program;
      });
      
      // Find current program
      const currentProgram = programs.find(p => {
        try {
          const startTime = new Date(p.start);
          const stopTime = new Date(p.stop);
          const currentTime = new Date();
          return startTime <= currentTime && stopTime >= currentTime;
        } catch (err) {
          return false;
        }
      });
      
      // Get sources list for context
      const sourcesList = await runQuery('SELECT id, name FROM sources ORDER BY name');
      
      return res.json({
        success: true,
        channelId,
        channel: channelInfo,
        programs,
        currentProgram,
        sources: sourcesList,
        timeWindow: {
          start: now.toISOString(),
          end: endDate.toISOString()
        }
      });
    } catch (error) {
      logger.error(`Error getting channel data: ${error.message}`);
      return res.status(500).json({
        error: `Failed to get channel data: ${error.message}`,
        success: false,
        channelId
      });
    }
  } catch (error) {
    logger.error(`Error in channel data endpoint: ${error.message}`);
    res.status(500).json({
      error: `Server error: ${error.message}`,
      success: false
    });
  }
});

/**
 * GET /:sessionId/sources
 * Get all EPG sources for a session
 */
router.get('/:sessionId/sources', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.info(`Getting EPG sources for session ${sessionId}`);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    // Initialize database
    await initDb();
    
    // Get sources from the database
    const sources = await runQuery(`
      SELECT id, name, url, last_updated, channel_count, program_count
      FROM sources
      ORDER BY name
    `);
    
    return res.json({
      success: true,
      sessionId,
      sources,
      count: sources.length,
      message: `Retrieved ${sources.length} EPG sources`
    });
  } catch (error) {
    logger.error(`Error getting EPG sources: ${error.message}`);
    return res.status(500).json({ 
      error: `Failed to get EPG sources: ${error.message}`,
      success: false 
    });
  }
});

/**
 * POST /:sessionId/match
 * Match an EPG channel to an M3U channel and save to session
 */
router.post('/:sessionId/match', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { epgChannel, m3uChannel } = req.body;
    
    logger.info(`Matching EPG channel to M3U channel in session ${sessionId}`);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    if (!epgChannel || !m3uChannel) {
      return res.status(400).json({ 
        error: 'Both epgChannel and m3uChannel are required', 
        received: { hasEpgChannel: !!epgChannel, hasM3uChannel: !!m3uChannel }
      });
    }
    
    // Get session
    const session = sessionStorage.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Initialize matched channels array if not exists
    if (!session.data.matches) {
      session.data.matches = [];
    }
    
    // Check if match already exists and update or add new
    const existingMatchIndex = session.data.matches.findIndex(
      match => match.m3uChannel.id === m3uChannel.id
    );
    
    if (existingMatchIndex !== -1) {
      // Update existing match
      session.data.matches[existingMatchIndex] = { epgChannel, m3uChannel };
      logger.info(`Updated existing match for channel ${m3uChannel.name}`);
    } else {
      // Add new match
      session.data.matches.push({ epgChannel, m3uChannel });
      logger.info(`Added new match for channel ${m3uChannel.name} with EPG ${epgChannel.name}`);
    }
    
    // Update session
    sessionStorage.updateSession(sessionId, session);
    
    return res.json({
      success: true,
      sessionId,
      message: `EPG channel ${epgChannel.name} matched to M3U channel ${m3uChannel.name}`,
      matchCount: session.data.matches.length
    });
  } catch (error) {
    logger.error(`Error matching channels: ${error.message}`);
    return res.status(500).json({ 
      error: `Failed to match channels: ${error.message}`,
      success: false
    });
  }
});

// Add shutdown handling
process.on('SIGINT', () => {
  if (db) {
    db.close((err) => {
      if (err) {
        logger.error(`Error closing database: ${err.message}`);
      } else {
        logger.info('Database connection closed');
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

module.exports = router;
