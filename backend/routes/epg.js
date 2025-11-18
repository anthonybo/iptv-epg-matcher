/**
 * EPG Routes - handles EPG-related endpoints with throttled logging
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const logger = require('../utils/logger');
const sessionStorage = require('../utils/session');
const { authMiddleware } = require('../middleware/authMiddleware');
const liveEventsService = require('../services/liveEventsService');
const { broadcastSSEUpdate } = require('../utils/sseUtils');
const postgresService = require('../services/postgresService');

// Apply optional auth middleware to all routes
router.use(authMiddleware);

// Load EPG sources from config file (single source of truth)
const EPG_SOURCES_CONFIG = require('../config/epg_sources.json');

// Get only enabled sources (including user-added sources)
async function getEnabledEpgSources() {
  // Get config-based sources
  const configSources = EPG_SOURCES_CONFIG.sources
    .filter(source => source.enabled)
    .map(source => source.url);

  // Get user-added sources from database
  try {
    const result = await postgresService.query(
      'SELECT url FROM user_epg_sources WHERE enabled = true'
    );
    const userSources = result.rows || [];

    if (userSources && userSources.length > 0) {
      const userUrls = userSources.map(s => s.url);
      logger.info(`[EPG Sources] Adding ${userUrls.length} user EPG sources to bulk refresh`);
      return [...configSources, ...userUrls];
    }
  } catch (err) {
    logger.warn(`[EPG Sources] Could not load user EPG sources: ${err.message}`);
  }

  return configSources;
}

// Get all sources (including disabled ones) with metadata
function getAllEpgSourcesWithMetadata() {
  return EPG_SOURCES_CONFIG.sources;
}

// Track running EPG refresh process
let epgRefreshProcess = null;
let epgRefreshStatus = {
  isRunning: false,
  startedAt: null,
  currentSource: 0,
  totalSources: 0,
  lastMessage: null,
  completedSources: [], // Track which sources completed successfully
  lastResults: null // Store last refresh results
};

// Import EPG database service for PostgreSQL
const epgDatabaseService = require('../services/epgDatabaseService');

// For PostgreSQL, we don't have a file path - use connection string instead
const DB_PATH = 'PostgreSQL (iptvguru database)';

// No-op function for compatibility (PostgreSQL doesn't need initialization)
const initDb = async () => {
  // PostgreSQL pool is already initialized, nothing to do
  return Promise.resolve();
};

// Helper to run queries with proper error handling (uses PostgreSQL)
const runQuery = async (sql, params = []) => {
  try {
    const { pool } = require('../services/postgresService');

    // Convert SQLite table names to PostgreSQL table names
    let pgSql = sql;

    pgSql = pgSql.replace(/\bFROM\s+channels\b/gi, 'FROM epg_channels');
    pgSql = pgSql.replace(/\bJOIN\s+channels\b/gi, 'JOIN epg_channels');
    pgSql = pgSql.replace(/\bFROM\s+programs\b/gi, 'FROM epg_programs');
    pgSql = pgSql.replace(/\bJOIN\s+programs\b/gi, 'JOIN epg_programs');
    pgSql = pgSql.replace(/\bFROM\s+sources\b/gi, 'FROM epg_sources');
    pgSql = pgSql.replace(/\bJOIN\s+sources\b/gi, 'JOIN epg_sources');

    // Convert SQLite column names to PostgreSQL column names
    // Use word boundaries and handle prefixed versions first
    pgSql = pgSql.replace(/\bp\.start\b/g, 'p.start_time');
    pgSql = pgSql.replace(/\bp\.stop\b/g, 'p.stop_time');

    // Replace start/stop in SELECT, WHERE, ORDER BY contexts - be more aggressive
    pgSql = pgSql.replace(/\bstart\b/gi, 'start_time');
    pgSql = pgSql.replace(/\bstop\b/gi, 'stop_time');

    // Convert SQLite strftime to PostgreSQL NOW() + interval
    pgSql = pgSql.replace(/strftime\('%Y%m%d%H%M%S \+0000',\s*'now',\s*'-(\d+)\s+hours?'\)/gi,
      (match, hours) => `NOW() - INTERVAL '${hours} hours'`);
    pgSql = pgSql.replace(/strftime\('%Y%m%d%H%M%S \+0000',\s*'now',\s*'\+(\d+)\s+hours?'\)/gi,
      (match, hours) => `NOW() + INTERVAL '${hours} hours'`);
    pgSql = pgSql.replace(/strftime\('%Y%m%d%H%M%S \+0000',\s*'now'\)/gi, 'NOW()');

    // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
    let paramIndex = 1;
    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

    const result = await pool.query(pgSql, params);
    return result.rows;
  } catch (err) {
    logger.error(`Query error: ${err.message}, SQL: ${sql.substring(0, 100)}..., Params: ${JSON.stringify(params)}`);
    throw err;
  }
};

/**
 * Detect if program content is actually LIVE (sports, live events)
 * Uses category and title pattern matching
 */
const detectLiveContent = (title, category) => {
  if (!title) return false;

  const titleLower = title.toLowerCase();
  const categoryLower = (category || '').toLowerCase();

  // Skip if title already has LIVE prefix (avoid double prefix)
  // Check for both regular "Live:" and small caps "ʟɪᴠᴇ"
  if (/^live:?\s/i.test(title) || title.startsWith('ʟɪᴠᴇ ')) {
    return false;
  }

  // Check title for live sports patterns - STRONGEST INDICATOR
  const livePatterns = [
    / vs\.?\s/i,          // "Team A vs Team B" or "Team A vs. Team B"
    / @ /i,               // "Team A @ Team B"
  ];

  const hasVsPattern = livePatterns.some(pattern => pattern.test(title));

  // Strong indicator - if has vs/@ pattern, it's very likely live sports
  if (hasVsPattern) {
    // But exclude if it says "next game" or similar
    const excludeNext = ['next game', 'upcoming', 'scheduled'];
    const hasExcludeNext = excludeNext.some(pattern => titleLower.includes(pattern));
    return !hasExcludeNext;
  }

  // For titles without vs/@ pattern, be more strict
  // Only match if it has sports category AND specific live event keywords
  const sportsCategories = [
    'sport', 'sports', 'live sport'
  ];

  const hasSportsCategory = sportsCategories.some(sport => categoryLower.includes(sport));

  if (hasSportsCategory) {
    // Keywords that indicate it's a live broadcast (not just sports content)
    const liveBroadcastKeywords = [
      'qualifying', 'practice session', 'free practice',
      'championship', 'playoff', 'semifinal', 'quarterfinal', 'final round'
    ];

    const hasLiveBroadcastKeyword = liveBroadcastKeywords.some(keyword => titleLower.includes(keyword));

    // Exclude obvious non-live content
    const excludePatterns = [
      'replay', 'repeat', 'highlights', 'classic', 'rewind',
      'encore', 'recorded', 'best of', 'top 10', 'greatest',
      'next game', 'upcoming', 'documentary', 'news', 'talk show'
    ];

    const isExcluded = excludePatterns.some(pattern => titleLower.includes(pattern));

    return !isExcluded && hasLiveBroadcastKeyword;
  }

  return false;
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
// Helper function to convert EPG timestamp format to ISO string
// Converts "YYYYMMDDHHMMSS +TZTZ" to ISO format or Date object
const convertEPGTimestampToISO = (timestamp) => {
  if (!timestamp) return null;

  try {
    // PostgreSQL returns Date objects, SQLite returns strings
    if (timestamp instanceof Date) {
      return timestamp.toISOString();
    }

    // Handle string timestamps (SQLite format)
    if (typeof timestamp !== 'string') {
      return timestamp.toString(); // Convert to string if needed
    }

    // Format: "YYYYMMDDHHMMSS +TZTZ" e.g., "20251030103000 +0000"
    const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second, tz] = match;

    // Parse timezone offset
    const tzSign = tz[0];
    const tzHours = parseInt(tz.substring(1, 3));
    const tzMinutes = parseInt(tz.substring(3, 5));
    const tzOffsetMinutes = (tzSign === '+' ? 1 : -1) * (tzHours * 60 + tzMinutes);

    // Create date in the specified timezone
    const date = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
    ));

    // Adjust for timezone offset (subtract because EPG timestamps are in local time)
    date.setMinutes(date.getMinutes() - tzOffsetMinutes);

    return date.toISOString();
  } catch (error) {
    logger.error(`Error converting timestamp ${timestamp}: ${error.message}`);
    return null;
  }
};

const searchChannels = async (query) => {
  try {
    await initDb();

    // Normalize the search term
    const searchTerm = query.toLowerCase().trim();

    // Use SQLite's LIKE operator for partial matching
    // Also fetch the current program for each channel
    // Use SQLite's strftime to get current time in the same format as the database
    const sql = `
      SELECT c.id, c.name, c.icon, s.name as source_name,
             (SELECT COUNT(*) FROM programs WHERE channel_id = c.id) as program_count,
             p.id as current_program_id,
             p.title as current_program_title,
             p.description as current_program_description,
             p.start as current_program_start,
             p.stop as current_program_stop
      FROM channels c
      JOIN sources s ON c.source_id = s.id
      LEFT JOIN programs p ON c.id = p.channel_id
        AND p.start IS NOT NULL
        AND p.stop IS NOT NULL
        AND p.start < strftime('%Y%m%d%H%M%S +0000', 'now')
        AND p.stop > strftime('%Y%m%d%H%M%S +0000', 'now')
      WHERE LOWER(c.name) LIKE ?
      ORDER BY c.name
      LIMIT 100
    `;

    const results = await runQuery(sql, [`%${searchTerm}%`]);

    // Transform results to include current program as nested object
    return results.map(row => ({
      id: row.id,
      name: row.name,
      icon: row.icon,
      source_name: row.source_name,
      program_count: row.program_count,
      currentProgram: row.current_program_id ? {
        id: row.current_program_id,
        title: row.current_program_title,
        description: row.current_program_description,
        start: convertEPGTimestampToISO(row.current_program_start),
        stop: convertEPGTimestampToISO(row.current_program_stop)
      } : null
    }));
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

    // Check if we're using PostgreSQL or SQLite
    const usePostgres = process.env.USE_POSTGRES === 'true';

    let nowParam, tomorrowParam;

    if (usePostgres) {
      // PostgreSQL: Use ISO format timestamps
      nowParam = now.toISOString();
      tomorrowParam = tomorrow.toISOString();
    } else {
      // SQLite: Format date objects to EPG format (YYYYMMDDHHmmss +0000)
      const formatToEPGDate = (date) => {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hour = String(date.getUTCHours()).padStart(2, '0');
        const minute = String(date.getUTCMinutes()).padStart(2, '0');
        const second = String(date.getUTCSeconds()).padStart(2, '0');
        return `${year}${month}${day}${hour}${minute}${second} +0000`;
      };
      nowParam = formatToEPGDate(now);
      tomorrowParam = formatToEPGDate(tomorrow);
    }

    const nowStr = nowParam;
    const tomorrowStr = tomorrowParam;

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

// Import EPG parser service
const epgParserService = require('../services/epgParserService');

// Run the Node.js EPG parser
const runEpgParser = async (options = {}) => {
  // Check if already running
  if (epgRefreshStatus.isRunning) {
    logger.warn('EPG refresh already in progress, ignoring duplicate request');
    throw new Error('EPG refresh already in progress');
  }

  try {
    epgRefreshStatus = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      currentSource: 0,
      totalSources: 0,
      lastMessage: 'Starting EPG refresh...',
      completedSources: [],
      lastResults: null
    };

    // Broadcast start
    broadcastToAllClients('epg-progress', {
      type: 'epg-progress',
      message: 'Starting EPG refresh...',
      timestamp: new Date().toISOString()
    });

    // Parse all sources with progress callback
    const results = await epgParserService.parseAllSources({
      force: options.force || false,
      cache: true,
      dropIndexes: true,
      onProgress: (message) => {
        // Update status
        epgRefreshStatus.lastMessage = message;

        // Extract source progress from message like "Processing source 2/7: EPG.pw - US"
        const sourceMatch = message.match(/Processing source (\d+)\/(\d+):/);
        if (sourceMatch) {
          epgRefreshStatus.currentSource = parseInt(sourceMatch[1]);
          epgRefreshStatus.totalSources = parseInt(sourceMatch[2]);
        }

        // Extract total sources from message like "Found 7 EPG sources to process"
        const totalMatch = message.match(/Found (\d+) EPG sources to process/);
        if (totalMatch) {
          epgRefreshStatus.totalSources = parseInt(totalMatch[1]);
        }

        // Extract completed source info from message like "✓ Completed EPG Share 01 - All Sources: 15279 channels, 50000 programs"
        const completedMatch = message.match(/✓ Completed (.+?):\s*(\d+) channels?,\s*(\d+) programs?/);
        if (completedMatch) {
          const sourceName = completedMatch[1];
          const channelCount = parseInt(completedMatch[2]);
          const programCount = parseInt(completedMatch[3]);

          epgRefreshStatus.completedSources.push({
            name: sourceName,
            channelCount: channelCount,
            programCount: programCount,
            status: 'complete'
          });

          logger.info(`[EPG Progress] Marked source as complete: ${sourceName} (${channelCount} channels, ${programCount} programs)`);
        }

        // Extract failed source info from message like "✗ Failed EPG Share 01: error message"
        const failedMatch = message.match(/✗ Failed (.+?):\s*(.+)$/);
        if (failedMatch) {
          const sourceName = failedMatch[1];
          const errorMessage = failedMatch[2];

          epgRefreshStatus.completedSources.push({
            name: sourceName,
            channelCount: 0,
            programCount: 0,
            status: 'failed',
            error: errorMessage
          });

          logger.info(`[EPG Progress] Marked source as failed: ${sourceName} - ${errorMessage}`);
        }

        // Debug log
        logger.info(`[EPG Progress Callback] Broadcasting: ${message}`);

        // Broadcast to frontend
        broadcastToAllClients('epg-progress', {
          type: 'epg-progress',
          message: message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Store results and reset running status
    epgRefreshStatus.isRunning = false;
    epgRefreshStatus.lastResults = results;

    if (!results.success) {
      const errorMsg = `EPG refresh completed with errors: ${results.summary.failedSources}/${results.summary.totalSources} sources failed`;
      logger.warn(errorMsg);

      // Broadcast completion with warnings
      broadcastToAllClients('epg-complete', {
        type: 'epg-complete',
        message: errorMsg,
        summary: results.summary,
        timestamp: new Date().toISOString()
      });

      return {
        success: false,
        message: errorMsg,
        results: results
      };
    }

    const successMsg = `EPG refresh completed: ${results.summary.successfulSources}/${results.summary.totalSources} sources successful, ${results.summary.totalChannels} channels, ${results.summary.totalPrograms} programs`;
    logger.info(successMsg);

    // Broadcast completion
    broadcastToAllClients('epg-complete', {
      type: 'epg-complete',
      message: successMsg,
      summary: results.summary,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      message: successMsg,
      results: results
    };
  } catch (error) {
    epgRefreshStatus.isRunning = false;
    logger.error(`EPG refresh error: ${error.message}`);

    // Broadcast error
    broadcastToAllClients('epg-error', {
      type: 'epg-error',
      message: `EPG refresh failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });

    throw error;
  }
};

// Helper function to broadcast to all connected clients
function broadcastToAllClients(eventType, data) {
  // Debug logging
  logger.info(`[Broadcast Helper] Calling broadcastSSEUpdate with eventType: ${eventType}, data type: ${data.type}`);

  // Use the existing SSE utility to broadcast to all sessions
  broadcastSSEUpdate(data, null);
}

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
 * GET /refresh-status
 * Get current EPG refresh status
 */
router.get('/refresh-status', (req, res) => {
  res.json({
    isRunning: epgRefreshStatus.isRunning,
    startedAt: epgRefreshStatus.startedAt,
    currentSource: epgRefreshStatus.currentSource,
    totalSources: epgRefreshStatus.totalSources,
    lastMessage: epgRefreshStatus.lastMessage,
    completedSources: epgRefreshStatus.completedSources || [],
    lastResults: epgRefreshStatus.lastResults
  });
});

/**
 * POST /parse
 * Parse EPG from URL or file using epg_parser.py
 */
router.post('/parse', async (req, res) => {
  try {
    const { url, force = false } = req.body;

    // Check if already running
    if (epgRefreshStatus.isRunning) {
      return res.status(409).json({
        error: 'EPG refresh already in progress',
        status: epgRefreshStatus,
        timestamp: new Date().toISOString()
      });
    }

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
 * IPTV Editor Endpoints - User-authenticated endpoints for editing matched channels
 * These routes MUST come before /:sessionId routes to avoid parameter matching conflicts
 */

/**
 * GET /matched-channels
 * Get all matched channels for the authenticated user (for IPTV Editor)
 */
router.get('/matched-channels', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get matched channels: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const postgresService = require('../services/postgresService');

    const result = await postgresService.query(`
      SELECT
        m.id as match_id,
        m.iptv_channel_id,
        c.name as iptv_channel_name,
        m.epg_channel_id,
        CASE WHEN m.use_dummy_epg THEN 1 ELSE 0 END as use_dummy_epg,
        CASE WHEN c.enable_live_prefix THEN 1 ELSE 0 END as enable_live_prefix,
        c.id as iptv_channel_table_id,
        c.source_id,
        c.name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        s.name as source_name
      FROM epg_matches m
      JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `, [userId]);

    const channels = result.rows;

    res.json({
      channels,
      count: channels.length
    });
  } catch (error) {
    logger.error('Error fetching matched channels for editor:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /matched-channels-with-programs
 * Get all channels that have been matched with EPG data, along with their programs (auth required)
 */
router.get('/matched-channels-with-programs', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get matched channels with programs: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`Getting matched channels with programs for user ${userId}`);

    // Get matched channels from PostgreSQL database
    const postgresService = require('../services/postgresService');

    const query = `
      SELECT
        m.iptv_channel_id,
        c.name as iptv_channel_name,
        m.epg_channel_id,
        m.use_dummy_epg,
        c.source_id as iptv_source_id,
        s.auto_detect_live
      FROM epg_matches m
      LEFT JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      LEFT JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `;
    const params = [userId];

    const result = await postgresService.query(query, params);
    const dbMatches = result.rows;

    if (dbMatches.length === 0) {
      return res.json({
        success: true,
        channels: [],
        count: 0,
        message: 'No matched channels found'
      });
    }

    // Initialize database
    await initDb();

    // Fetch EPG data for each matched channel
    const channelsWithEpg = [];

    for (const match of dbMatches) {
      try {
        const epgChannelId = match.epg_channel_id;
        const iptvChannelId = match.iptv_channel_id;
        const iptvChannelName = match.iptv_channel_name;

        if (!epgChannelId) {
          logger.warn(`No EPG ID found for channel ${iptvChannelId}`);
          continue;
        }

        // Get full IPTV channel info from IPTV database, including source info
        let iptvChannelData = null;
        let iptvSourceInfo = null;
        try {
          logger.info(`Looking for IPTV channel with ID: ${iptvChannelId}`);

          const iptvChannelResult = await postgresService.query(`
            SELECT c.channel_id, c.name, c.logo_url as logo, c.stream_url as url, c.group_title, c.tvg_id as epg_channel_id, c.source_id,
                   CASE WHEN s.name LIKE 'Legacy IPTV Source%' THEN s.url ELSE s.name END as source_name,
                   s.url as source_url,
                   s.type as source_type
            FROM iptv_channels c
            LEFT JOIN iptv_sources s ON c.source_id = s.id
            WHERE c.channel_id = $1
            LIMIT 1
          `, [iptvChannelId]);
          iptvChannelData = iptvChannelResult.rows[0];

          // If no channel found by channel_id, try matching by epg_channel_id (case-insensitive)
          if (!iptvChannelData) {
            logger.warn(`No IPTV channel found for ID: ${iptvChannelId}, trying epg_channel_id match`);

            // Build query with optional user filtering
            let query = `
              SELECT c.channel_id, c.name, c.logo_url as logo, c.stream_url as url, c.group_title, c.tvg_id as epg_channel_id, c.source_id,
                     CASE WHEN s.name LIKE 'Legacy IPTV Source%' THEN s.url ELSE s.name END as source_name,
                     s.url as source_url,
                     s.type as source_type
              FROM iptv_channels c
              LEFT JOIN iptv_sources s ON c.source_id = s.id
              WHERE LOWER(c.tvg_id) = LOWER($1)
            `;
            const params = [iptvChannelId];

            // Filter by user's sources if authenticated
            if (userId) {
              query += ` AND EXISTS (
                SELECT 1 FROM user_iptv_preferences p
                WHERE p.user_id = $2 AND p.source_id = c.source_id
              )`;
              params.push(userId);
            }

            query += ` LIMIT 1`;

            const iptvChannelByEpgResult = await postgresService.query(query, params);
            const iptvChannelByEpg = iptvChannelByEpgResult.rows[0];

            if (iptvChannelByEpg) {
              logger.info(`Found IPTV channel by EPG ID match: ${iptvChannelByEpg.name} (${iptvChannelByEpg.channel_id})`);
              iptvChannelData = iptvChannelByEpg;
            }
          }

          if (!iptvChannelData) {
            logger.warn(`No IPTV channel found for ID: ${iptvChannelId} even after EPG ID fallback`);

            // Use stored source_id from match as fallback
            if (match.iptv_source_id) {
              logger.info(`Using stored source_id ${match.iptv_source_id} from match`);

              const sourceInfoResult = await postgresService.query(`
                SELECT id,
                       CASE WHEN name LIKE 'Legacy IPTV Source%' THEN url ELSE name END as name,
                       url,
                       type
                FROM iptv_sources
                WHERE id = $1
              `, [match.iptv_source_id]);
              const sourceInfo = sourceInfoResult.rows[0];

              if (sourceInfo) {
                // Get user's nickname if authenticated
                if (userId) {
                  const sourcePrefsResult = await postgresService.query(`
                    SELECT nickname FROM user_iptv_preferences
                    WHERE user_id = $1 AND source_id = $2
                  `, [userId, sourceInfo.id]);
                  const sourcePrefs = sourcePrefsResult.rows[0];

                  // Determine display name with fallback logic
                  let displayName = sourcePrefs?.nickname || sourceInfo.name;
                  if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
                    displayName = sourceInfo.url || `Source ${sourceInfo.id}`;
                  }

                  iptvSourceInfo = {
                    id: sourceInfo.id,
                    name: displayName,
                    type: sourceInfo.type
                  };
                } else {
                  // Determine display name with fallback logic
                  let displayName = sourceInfo.name;
                  if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
                    displayName = sourceInfo.url || `Source ${sourceInfo.id}`;
                  }

                  iptvSourceInfo = {
                    id: sourceInfo.id,
                    name: displayName,
                    type: sourceInfo.type
                  };
                }
              }
            }
          } else {
            logger.info(`Found IPTV channel: ${iptvChannelData.name}, source_id: ${iptvChannelData.source_id}`);
          }

          // Get user's nickname for this source if available
          if (iptvChannelData && iptvChannelData.source_id && userId) {
            const sourcePrefsResult = await postgresService.query(`
              SELECT nickname FROM user_iptv_preferences
              WHERE user_id = $1 AND source_id = $2
            `, [userId, iptvChannelData.source_id]);
            const sourcePrefs = sourcePrefsResult.rows[0];

            // Determine display name with fallback logic
            let displayName = sourcePrefs?.nickname || iptvChannelData.source_name;

            // Fallback: if source name is invalid, extract URL from channel
            if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
              try {
                const urlObj = new URL(iptvChannelData.url);
                displayName = `${urlObj.protocol}//${urlObj.host}`;
                logger.info(`Extracted URL fallback for source ${iptvChannelData.source_id}: ${displayName}`);
              } catch (urlError) {
                displayName = iptvChannelData.source_url || `Source ${iptvChannelData.source_id}`;
                logger.warn(`Failed to extract URL for source ${iptvChannelData.source_id}, using: ${displayName}`);
              }
            }

            iptvSourceInfo = {
              id: iptvChannelData.source_id,
              name: displayName,
              type: iptvChannelData.source_type
            };
          } else if (iptvChannelData && iptvChannelData.source_id) {
            // Determine display name with fallback logic
            let displayName = iptvChannelData.source_name;

            // Fallback: if source name is invalid, extract URL from channel
            if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
              try {
                const urlObj = new URL(iptvChannelData.url);
                displayName = `${urlObj.protocol}//${urlObj.host}`;
                logger.info(`Extracted URL fallback for source ${iptvChannelData.source_id}: ${displayName}`);
              } catch (urlError) {
                displayName = iptvChannelData.source_url || `Source ${iptvChannelData.source_id}`;
                logger.warn(`Failed to extract URL for source ${iptvChannelData.source_id}, using: ${displayName}`);
              }
            }

            iptvSourceInfo = {
              id: iptvChannelData.source_id,
              name: displayName,
              type: iptvChannelData.source_type
            };
          }
        } catch (dbError) {
          logger.warn(`Could not fetch IPTV channel data for ${iptvChannelId}: ${dbError.message}`);
        }

        // Get channel info from EPG database
        const channelInfo = await getChannelById(epgChannelId);

        let formattedPrograms = [];

        // Handle dummy EPG channels
        if (match.use_dummy_epg === 1) {
          logger.info(`Generating dummy EPG programs for channel ${iptvChannelId}`);

          // Use current channel name from fresh data, fallback to stored name
          const currentChannelName = iptvChannelData?.name || iptvChannelName;

          // Generate 7 days of dummy programs (3-hour blocks)
          const now = new Date();
          const nowTimestamp = now.getTime();

          // For dummy EPG, check live_events database to see if channel name matches any live event
          // This allows us to show LIVE for actual live sports events even on dummy EPG channels

          for (let day = 0; day < 7; day++) {
            for (let hour = 0; hour < 24; hour += 3) {
              const startDate = new Date(now);
              startDate.setDate(startDate.getDate() + day);
              startDate.setHours(hour, 0, 0, 0);

              const stopDate = new Date(startDate);
              stopDate.setHours(stopDate.getHours() + 3);

              const blockStartTime = startDate.getTime();
              const blockStopTime = stopDate.getTime();
              const isCurrentlyAiring = nowTimestamp >= blockStartTime && nowTimestamp < blockStopTime;

              // Check if channel name matches any currently live event in database
              let isLiveEvent = false;
              if (isCurrentlyAiring && match.auto_detect_live === 1 && currentChannelName) {
                isLiveEvent = await liveEventsService.isProgramLive(currentChannelName);
              }

              // Add LIVE prefix if: currently airing AND (per-channel setting OR matches live event in database)
              const shouldAddLivePrefix = isCurrentlyAiring &&
                (match.enable_live_prefix === 1 || isLiveEvent);

              const title = shouldAddLivePrefix
                ? `ʟɪᴠᴇ ${currentChannelName}`
                : currentChannelName;

              formattedPrograms.push({
                id: `dummy_${iptvChannelId}_${day}_${hour}`,
                title: title,
                description: `Streaming on ${currentChannelName}`,
                start: startDate.toISOString(),
                stop: stopDate.toISOString()
              });
            }
          }
        } else {
          // Regular EPG channel
          if (!channelInfo) {
            logger.warn(`No EPG data found for channel ${epgChannelId}`);
            continue;
          }

          // Get programs for this channel (12 hours in the past to 48 hours in the future for guide view)
          // Using PostgreSQL epg_programs table via epgDatabaseService
          const now = new Date();
          const startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12 hours ago
          const endTime = new Date(now.getTime() + 48 * 60 * 60 * 1000);   // 48 hours from now

          const programs = await epgDatabaseService.getProgramsByChannelId(epgChannelId, startTime, endTime);

          // PostgreSQL returns ISO timestamps already, no conversion needed
          const nowTimestamp = Date.now();
          formattedPrograms = await Promise.all(programs.map(async (p) => {
            // Programs from PostgreSQL already have ISO format timestamps
            const startISO = p.start;
            const stopISO = p.stop;

            // Check if program is currently airing
            const startTime = new Date(startISO).getTime();
            const stopTime = new Date(stopISO).getTime();
            const isCurrentlyAiring = nowTimestamp >= startTime && nowTimestamp < stopTime;

            // Check if program matches a currently live event in database
            let isLiveEvent = false;
            if (isCurrentlyAiring && match.auto_detect_live === 1 && p.title) {
              isLiveEvent = await liveEventsService.isProgramLive(p.title);
            }

            // Add LIVE prefix if: currently airing AND (per-channel setting OR matches live event in database)
            const shouldAddLivePrefix = isCurrentlyAiring &&
              (match.enable_live_prefix === 1 || isLiveEvent);

            const title = shouldAddLivePrefix
              ? `ʟɪᴠᴇ ${p.title || 'Unknown'}`
              : p.title;

            return {
              id: p.id,
              title: title,
              description: p.description,
              start: startISO,
              stop: stopISO
            };
          }));
        }

        channelsWithEpg.push({
          id: iptvChannelId,
          name: iptvChannelData?.name || channelInfo?.name || iptvChannelName,
          logo: iptvChannelData?.logo || channelInfo?.icon || null,
          url: (iptvChannelData?.url || '').trim(),
          group: {
            title: iptvChannelData?.group_title || ''
          },
          tvg: {
            id: iptvChannelData?.epg_channel_id || epgChannelId
          },
          epgId: epgChannelId,
          epgSource: channelInfo?.source_name || (match.use_dummy_epg === 1 ? 'Dummy EPG' : 'Unknown'),
          iptvSource: iptvSourceInfo,
          programs: formattedPrograms,
          enableLivePrefix: match.enable_live_prefix,
          sourceAutoDetectLive: match.auto_detect_live
        });
      } catch (channelError) {
        logger.error(`Error fetching EPG for channel ${iptvChannelId}: ${channelError.message}`);
      }
    }

    // Sort channels by name
    channelsWithEpg.sort((a, b) => a.name.localeCompare(b.name));

    // Disable caching for this endpoint to ensure fresh data after matches
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    return res.json({
      success: true,
      channels: channelsWithEpg,
      count: channelsWithEpg.length,
      message: `Found ${channelsWithEpg.length} channels with EPG data`
    });
  } catch (error) {
    logger.error(`Error getting matched channels: ${error.message}`);
    return res.status(500).json({
      error: `Failed to get matched channels: ${error.message}`
    });
  }
});

/**
 * PUT /matched-channels/:channelId
 * Update channel metadata
 */
router.put('/matched-channels/:channelId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { channelId } = req.params;
    const { name, logo, group_title } = req.body;

    if (!userId) {
      logger.error('Update channel: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Update the channel in iptv_channels table
    await postgresService.query(`
      UPDATE iptv_channels
      SET name = $1, logo = $2, group_title = $3
      WHERE channel_id = $4
      AND source_id IN (
        SELECT s.id FROM iptv_sources s WHERE s.user_id = $5
      )
    `, [name, logo, group_title, channelId, userId]);

    logger.info(`Updated channel ${channelId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Channel updated successfully'
    });
  } catch (error) {
    logger.error('Error updating channel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /matched-channels/:matchId
 * Remove a specific match by match ID
 */
router.delete('/matched-channels/:matchId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { matchId } = req.params;

    if (!userId) {
      logger.error('Delete matched channel: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Delete the specific match by ID (ensure it belongs to this user)
    const result = await postgresService.query(`
      DELETE FROM epg_matches
      WHERE id = $1 AND user_id = $2
    `, [matchId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    logger.info(`Removed match ID ${matchId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Channel match removed'
    });
  } catch (error) {
    logger.error('Error deleting matched channel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /matched-channels/:matchId/dummy-epg
 * Toggle dummy EPG for a specific match
 */
router.put('/matched-channels/:matchId/dummy-epg', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { matchId } = req.params;
    const { useDummyEpg } = req.body;

    if (!userId) {
      logger.error('Toggle dummy EPG: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (typeof useDummyEpg !== 'boolean') {
      return res.status(400).json({ error: 'useDummyEpg must be a boolean' });
    }

    // Update the dummy EPG flag for this match
    const result = await postgresService.query(`
      UPDATE epg_matches
      SET use_dummy_epg = $1
      WHERE id = $2 AND user_id = $3
    `, [useDummyEpg ? 1 : 0, matchId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    logger.info(`${useDummyEpg ? 'Enabled' : 'Disabled'} dummy EPG for match ID ${matchId} (user ${userId})`);

    res.json({
      success: true,
      message: `Dummy EPG ${useDummyEpg ? 'enabled' : 'disabled'}`,
      useDummyEpg
    });
  } catch (error) {
    logger.error('Error toggling dummy EPG:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /channel-programs/:channelId
 * Get EPG programs for a specific channel
 */
router.get('/channel-programs/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    if (!channelId) {
      return res.status(400).json({ error: 'Channel ID is required' });
    }

    const result = await postgresService.query(`
      SELECT
        channel_id,
        title,
        start_time as start,
        stop_time as stop,
        description,
        categories as category
      FROM epg_programs
      WHERE channel_id = $1
      AND stop_time >= NOW() - INTERVAL '2 hours'
      ORDER BY start_time
      LIMIT 50
    `, [channelId]);

    const programs = result.rows || [];

    res.json({
      programs,
      count: programs.length
    });
  } catch (error) {
    logger.error('Error fetching channel programs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /matched-channels/batch-update-category
 * Rename a category for all channels
 */
router.post('/matched-channels/batch-update-category', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { oldCategory, newCategory } = req.body;

    if (!userId) {
      logger.error('Batch update category: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!oldCategory || !newCategory) {
      return res.status(400).json({ error: 'Old and new category names required' });
    }

    // Update all channels in the category for this user
    const result = await postgresService.query(`
      UPDATE iptv_channels
      SET group_title = $1
      WHERE group_title = $2
      AND source_id IN (
        SELECT s.id FROM iptv_sources s WHERE s.user_id = $3
      )
    `, [newCategory, oldCategory, userId]);

    logger.info(`Renamed category "${oldCategory}" to "${newCategory}" for user ${userId}, ${result.rowCount} channels updated`);

    res.json({
      success: true,
      message: `Category renamed, ${result.rowCount} channels updated`
    });
  } catch (error) {
    logger.error('Error batch updating category:', error);
    res.status(500).json({ error: error.message });
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
 * GET /published-channels-with-programs
 * Returns matched channels with EPG programs from the PUBLISHED/GENERATED XMLTV
 * (includes LIVE prefixes based on channel settings)
 */
router.get('/published-channels-with-programs', async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.error('Get published channels: No user ID in request');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get user's published credentials from PostgreSQL
    const credResult = await postgresService.query(
      'SELECT * FROM credentials WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    const credential = credResult.rows[0];

    if (!credential) {
      return res.status(404).json({
        error: 'No published IPTV data found. Please generate credentials in the Credentials tab first.',
        channels: []
      });
    }

    // Load the generated XMLTV file using the epg_file path from database
    const xmlFilePath = credential.epg_file;

    if (!xmlFilePath || !fs.existsSync(xmlFilePath)) {
      return res.status(404).json({
        error: 'Published EPG file not found. Please regenerate your credentials.',
        channels: [],
        debug: { xmlFilePath, exists: xmlFilePath ? fs.existsSync(xmlFilePath) : false }
      });
    }

    // Parse XMLTV
    const XmltvParser = require('xmltv-parser');
    const parsedXmltv = { channels: [], programmes: [] };

    await new Promise((resolve, reject) => {
      const parser = new XmltvParser();

      parser.onChannel = (channel) => {
        parsedXmltv.channels.push(channel);
      };

      parser.onProgramme = (programme) => {
        parsedXmltv.programmes.push(programme);
      };

      parser.parseFile(xmlFilePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Get matched channels from PostgreSQL
    const channelsResult = await postgresService.query(`
      SELECT DISTINCT
        c.channel_id as id,
        c.name as iptv_channel_name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        m.epg_channel_id,
        m.use_dummy_epg
      FROM iptv_channels c
      JOIN epg_matches m ON c.channel_id = m.iptv_channel_id
      JOIN iptv_sources s ON c.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `, [userId]);

    const matchedChannels = channelsResult.rows;

    // Build response with programs from parsed XMLTV
    const channelsWithPrograms = matchedChannels.map(channel => {
      // Find programs for this channel from the parsed XMLTV
      const channelPrograms = (parsedXmltv.programmes || [])
        .filter(prog => prog.chan === channel.epg_channel_id)
        .map(prog => ({
          title: prog.title || 'Unknown',
          description: prog.desc || null,
          start: prog.start,
          stop: prog.end,
          category: prog.cat && prog.cat.length > 0 ? prog.cat[0] : null
        }));

      return {
        id: channel.id,
        name: channel.iptv_channel_name,
        epgId: channel.epg_channel_id,
        logo: channel.logo,
        url: channel.url,
        groupTitle: channel.group_title,
        useDummyEpg: channel.use_dummy_epg === 1,
        programs: channelPrograms
      };
    });

    logger.info(`Returning ${channelsWithPrograms.length} published channels with programs for user ${userId}`);

    res.json({
      channels: channelsWithPrograms,
      count: channelsWithPrograms.length
    });
  } catch (error) {
    logger.error('Error getting published channels with programs:', {
      message: error.message,
      stack: error.stack,
      userId: req.user?.id
    });
    res.status(500).json({
      error: error.message,
      details: error.stack,
      channels: []
    });
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
      // First, check if this IPTV channel has a match in the epg_matches table (PostgreSQL)
      const postgresService = require('../services/postgresService');
      const userId = req.user?.id;

      let epgChannelId = null;

      // Look up the match from PostgreSQL
      let query = `SELECT epg_channel_id FROM epg_matches WHERE iptv_channel_id = $1`;
      const params = [channelId];

      // Filter by user if authenticated
      if (userId) {
        query += ` AND user_id = $2`;
        params.push(userId);
      } else {
        query += ` AND session_id = $2`;
        params.push(sessionId);
      }

      query += ` LIMIT 1`;

      const result = await postgresService.query(query, params);
      const match = result.rows[0];

      if (match) {
        epgChannelId = match.epg_channel_id;
        logger.info(`Found EPG match: ${channelId} -> ${epgChannelId}`);
      } else {
        logger.info(`No match found for IPTV channel ${channelId}`);
      }

      // Get channel info using the EPG channel ID
      const channelInfo = epgChannelId ? await getChannelById(epgChannelId) : null;

      if (!channelInfo) {
        logger.info(`No EPG channel data found for ${channelId}, returning empty EPG data`);
        return res.json({
          success: true,
          channelId,
          channelInfo: null,
          programs: [],
          message: 'No EPG data available for this channel'
        });
      }
      
      // Get time window: from now to 7 days later (extended from 24 hours)
      const now = new Date();
      const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      // Log the time window for debugging
      logger.info(`Searching for programs between ${now.toISOString()} and ${endDate.toISOString()} (7-day window)`);

      // Get programs for this channel using the EPG channel ID
      // Using PostgreSQL epg_programs table via epgDatabaseService
      let programs = await epgDatabaseService.getProgramsByChannelId(epgChannelId, now, endDate);
      
      // PostgreSQL returns ISO timestamps already, no conversion needed
      // Programs already have the correct format from epgDatabaseService
      
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

      // Disable caching to ensure fresh EPG data
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

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
    const userId = req.user?.id;

    logger.info(`Getting EPG sources for session ${sessionId}, user ${userId || 'none'}`);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Initialize database
    await initDb();

    // Get sources from the database (PostgreSQL)
    const { pool } = require('../services/postgresService');
    const result = await pool.query(`
      SELECT id, name, url, last_updated, channel_count, program_count
      FROM epg_sources
    `);
    const dbSources = result.rows;

    // Create a map of database sources by URL for quick lookup
    const dbSourceMap = {};
    dbSources.forEach(source => {
      if (source.url) {
        dbSourceMap[source.url] = source;
      }
    });

    // Merge config sources with database data
    // This ensures frontend knows about all sources with their status
    const allSourcesMetadata = getAllEpgSourcesWithMetadata();
    const sources = allSourcesMetadata.map((configSource, index) => {
      const dbSource = dbSourceMap[configSource.url];

      return {
        id: dbSource?.id || `source_${index + 1}`,
        name: configSource.name || dbSource?.name || configSource.url.split('/').pop(),
        url: configSource.url,
        enabled: configSource.enabled,
        verified: configSource.verified,
        notes: configSource.notes,
        last_updated: dbSource?.last_updated || null,
        channel_count: dbSource?.channel_count || 0,
        program_count: dbSource?.program_count || 0,
        channelCount: dbSource?.channel_count || 0,
        programCount: dbSource?.program_count || 0,
        isUserSource: false
      };
    });

    // Add user EPG sources if authenticated
    if (userId) {
      const cacheService = require('../services/cacheService');

      const result = await postgresService.query(`
        SELECT id, url, name, enabled, created_at, updated_at
        FROM user_epg_sources
        WHERE user_id = $1
        ORDER BY created_at DESC
      `, [userId]);
      const userSources = result.rows || [];

      // Add user sources to the list
      userSources.forEach(userSource => {
        const dbSource = dbSourceMap[userSource.url];

        // Try to get from cache if not in database
        let channelCount = dbSource?.channel_count || 0;
        let programCount = dbSource?.program_count || 0;
        let lastUpdated = dbSource?.last_updated || null;

        logger.debug(`[EPG Sources] Processing user source: ${userSource.url}, dbSource exists: ${!!dbSource}, dbChannels: ${channelCount}, dbPrograms: ${programCount}`);

        if (!dbSource || channelCount === 0) {
          const cachedData = cacheService.readEpgSourceCache(userSource.url);
          logger.debug(`[EPG Sources] Cache lookup for ${userSource.url}: ${cachedData ? 'FOUND' : 'NOT FOUND'}`, cachedData || {});
          if (cachedData) {
            channelCount = cachedData.channelCount || 0;
            programCount = cachedData.programCount || 0;
            lastUpdated = cachedData.lastUpdated || lastUpdated;
            logger.info(`[EPG Sources] Using cached data for ${userSource.url}: ${channelCount} channels, ${programCount} programs`);
          }
        }

        sources.push({
          id: `user_${userSource.id}`,
          name: userSource.name,
          url: userSource.url,
          enabled: Boolean(userSource.enabled),
          verified: false,
          notes: 'User-added source',
          last_updated: lastUpdated,
          channel_count: channelCount,
          program_count: programCount,
          channelCount: channelCount,
          programCount: programCount,
          isUserSource: true,
          created_at: userSource.created_at,
          updated_at: userSource.updated_at
        });
      });
    }

    // Filter to only enabled sources if requested
    const enabledOnly = req.query.enabled === 'true';
    const filteredSources = enabledOnly ? sources.filter(s => s.enabled) : sources;

    return res.json({
      success: true,
      sessionId,
      sources: filteredSources,
      count: filteredSources.length,
      totalAvailable: sources.length,
      enabledCount: sources.filter(s => s.enabled).length,
      message: `Retrieved ${filteredSources.length} EPG sources (${sources.filter(s => s.enabled).length} enabled, ${dbSources.length} with data)`
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
    const { epgChannel, m3uChannel, useDummyEpg } = req.body;

    logger.info(`Matching EPG channel to M3U channel in session ${sessionId}${useDummyEpg ? ' (with dummy EPG)' : ''}`);

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

    // Initialize session.data if not exists
    if (!session.data) {
      session.data = {};
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

    // Save match to database for persistence
    try {
      const userId = req.user?.id; // Get user ID if authenticated

      // If user is authenticated, delete all old matches for this channel for this user
      // (regardless of session_id) to prevent duplicates
      if (userId) {
        await postgresService.query(`
          DELETE FROM epg_matches
          WHERE user_id = $1 AND iptv_channel_id = $2
        `, [userId, m3uChannel.id]);
        logger.info(`Deleted old matches for user ${userId}, channel ${m3uChannel.id}`);
      }

      // Get source_id from the IPTV channel
      let iptvSourceId = null;
      if (m3uChannel.id) {
        try {
          const sourceResult = await postgresService.query(`
            SELECT source_id FROM iptv_channels WHERE channel_id = $1
          `, [m3uChannel.id]);
          iptvSourceId = sourceResult.rows[0]?.source_id || null;
          if (iptvSourceId) {
            logger.info(`Found source_id ${iptvSourceId} for channel ${m3uChannel.id}`);
          }
        } catch (sourceErr) {
          logger.warn(`Could not get source_id for channel ${m3uChannel.id}: ${sourceErr.message}`);
        }
      }

      // Insert or update match in PostgreSQL
      await postgresService.query(`
        INSERT INTO epg_matches
        (session_id, user_id, iptv_channel_id, epg_channel_id, use_dummy_epg, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (session_id, iptv_channel_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          epg_channel_id = EXCLUDED.epg_channel_id,
          use_dummy_epg = EXCLUDED.use_dummy_epg,
          updated_at = CURRENT_TIMESTAMP
      `, [
        sessionId,
        userId || null,
        m3uChannel.id,
        epgChannel.id,
        useDummyEpg ? 1 : 0
      ]);

      logger.info(`Saved match to database: ${m3uChannel.name} -> ${epgChannel.name}${userId ? ` (user ${userId})` : ''}`);
    } catch (dbError) {
      logger.error(`Failed to save match to database: ${dbError.message}`);
      // Don't fail the request if database save fails
    }

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

/**
 * DELETE /:sessionId/match/:iptvChannelId
 * Remove a match for an IPTV channel
 */
router.delete('/:sessionId/match/:iptvChannelId', async (req, res) => {
  try {
    const { sessionId, iptvChannelId } = req.params;
    const userId = req.user?.id;

    logger.info(`Deleting match for channel ${iptvChannelId} in session ${sessionId}${userId ? ` (user ${userId})` : ''}`);

    // Delete from database
    let query, params;
    if (userId) {
      // Delete for authenticated user (across all sessions)
      query = 'DELETE FROM epg_matches WHERE user_id = $1 AND iptv_channel_id = $2';
      params = [userId, iptvChannelId];
    } else {
      // Delete for session only
      query = 'DELETE FROM epg_matches WHERE session_id = $1 AND iptv_channel_id = $2';
      params = [sessionId, iptvChannelId];
    }

    await postgresService.query(query, params);

    logger.info(`Deleted match for channel ${iptvChannelId}${userId ? ` (user ${userId})` : ''}`);

    return res.json({
      success: true,
      message: 'Match deleted successfully'
    });
  } catch (error) {
    logger.error(`Error deleting match: ${error.message}`);
    return res.status(500).json({
      error: `Failed to delete match: ${error.message}`,
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
