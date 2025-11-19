/**
 * EPG Query Service
 * Handles all database queries for EPG data (channels, programs, statistics)
 */

const logger = require('../utils/logger');
const postgresService = require('./postgresService');
const epgDatabaseService = require('./epgDatabaseService');
const { convertEPGTimestampToISO } = require('../utils/epgTransformUtils');

/**
 * Get database statistics
 */
const getDatabaseStats = async () => {
  try {
    const result = await postgresService.query(`
      SELECT
        (SELECT COUNT(*) FROM epg_sources) as source_count,
        (SELECT COUNT(*) FROM epg_channels) as channel_count,
        (SELECT COUNT(*) FROM epg_programs) as program_count
    `);

    const stats = result.rows[0] || { source_count: 0, channel_count: 0, program_count: 0 };

    // Get source details
    const sourcesResult = await postgresService.query(`
      SELECT name, channel_count, program_count, last_updated
      FROM epg_sources
      ORDER BY name
    `);

    return {
      sourceCount: parseInt(stats.source_count) || 0,
      channelCount: parseInt(stats.channel_count) || 0,
      programCount: parseInt(stats.program_count) || 0,
      sources: sourcesResult.rows,
      databasePath: 'PostgreSQL (iptvguru database)'
    };
  } catch (error) {
    logger.error(`Error getting database stats: ${error.message}`);
    return {
      sourceCount: 0,
      channelCount: 0,
      programCount: 0,
      sources: [],
      error: error.message,
      databasePath: 'PostgreSQL (iptvguru database)'
    };
  }
};

/**
 * Search for channels in the database
 */
const searchChannels = async (query) => {
  try {
    const searchTerm = query.toLowerCase().trim();

    const sql = `
      SELECT c.id, c.name, c.icon, s.name as source_name,
             (SELECT COUNT(*) FROM epg_programs WHERE channel_id = c.id) as program_count,
             p.id as current_program_id,
             p.title as current_program_title,
             p.description as current_program_description,
             p.start_time as current_program_start,
             p.stop_time as current_program_stop
      FROM epg_channels c
      JOIN epg_sources s ON c.source_id = s.id
      LEFT JOIN epg_programs p ON c.id = p.channel_id
        AND p.start_time IS NOT NULL
        AND p.stop_time IS NOT NULL
        AND p.start_time < NOW()
        AND p.stop_time > NOW()
      WHERE LOWER(c.name) LIKE $1
      ORDER BY c.name
      LIMIT 100
    `;

    const result = await postgresService.query(sql, [`%${searchTerm}%`]);

    // Transform results to include current program as nested object
    return result.rows.map(row => ({
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

/**
 * Get channel details by ID with fuzzy matching fallback
 */
const getChannelById = async (channelId) => {
  try {
    logger.info(`Looking up channel by ID: "${channelId}"`);

    const sql = `
      SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
      FROM epg_channels c
      JOIN epg_sources s ON c.source_id = s.id
      WHERE c.id = $1
    `;

    let result = await postgresService.query(sql, [channelId]);

    // If no results, try variations
    if (result.rows.length === 0) {
      logger.info(`No channel found for exact ID ${channelId}, trying variations`);

      // Try lowercase
      const lowerCaseId = channelId.toLowerCase();
      if (lowerCaseId !== channelId) {
        logger.info(`Trying lowercase variation: "${lowerCaseId}"`);
        result = await postgresService.query(sql, [lowerCaseId]);
      }

      // Try with/without .us domain suffix
      if (result.rows.length === 0) {
        if (channelId.endsWith('.us')) {
          const withoutUsSuffix = channelId.substring(0, channelId.length - 3);
          logger.info(`Trying without .us suffix: "${withoutUsSuffix}"`);
          result = await postgresService.query(sql, [withoutUsSuffix]);
        } else {
          const withUsSuffix = `${channelId}.us`;
          logger.info(`Trying with .us suffix: "${withUsSuffix}"`);
          result = await postgresService.query(sql, [withUsSuffix]);
        }
      }

      // Try without spaces, dashes, dots
      if (result.rows.length === 0) {
        const normalizedId = channelId.replace(/[\s\.\-_]+/g, '').toLowerCase();

        if (normalizedId !== channelId.toLowerCase()) {
          const fuzzySearchSql = `
            SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
            FROM epg_channels c
            JOIN epg_sources s ON c.source_id = s.id
            WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(c.id, ' ', ''), '.', ''), '-', ''), '_', '')) = $1
            LIMIT 5
          `;

          logger.info(`Trying normalized ID (no special chars): "${normalizedId}"`);
          result = await postgresService.query(fuzzySearchSql, [normalizedId]);
        }
      }

      // Try name-based lookup for Travel Channel variations
      if (result.rows.length === 0 && channelId.toLowerCase().includes('travel')) {
        logger.info(`Trying name-based lookup for Travel Channel variations`);
        const travelChannelSql = `
          SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
          FROM epg_channels c
          JOIN epg_sources s ON c.source_id = s.id
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
        result = await postgresService.query(travelChannelSql, []);
      }

      // Try partial name matching
      if (result.rows.length === 0 && channelId.length > 3) {
        const potentialName = channelId
          .replace(/[_\.\-]/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .trim();

        if (potentialName.length > 3) {
          const nameSearchSql = `
            SELECT c.id, c.name, c.icon, s.name as source_name, s.id as source_id
            FROM epg_channels c
            JOIN epg_sources s ON c.source_id = s.id
            WHERE LOWER(c.name) LIKE $1
            ORDER BY
              CASE
                WHEN LOWER(c.name) = $2 THEN 1
                WHEN LOWER(c.name) LIKE $3 || '%' THEN 2
                ELSE 3
              END,
              LENGTH(c.name)
            LIMIT 1
          `;

          logger.info(`Trying name-based lookup with potential name: "${potentialName}"`);
          result = await postgresService.query(nameSearchSql, [
            `%${potentialName}%`,
            potentialName,
            potentialName
          ]);
        }
      }
    }

    // If we found a match, return it with a note if it's not the exact ID
    if (result.rows.length > 0) {
      const channel = result.rows[0];
      if (channel.id !== channelId) {
        logger.info(`Found channel "${channel.name}" with similar ID: "${channel.id}" (originally requested: "${channelId}")`);
      } else {
        logger.info(`Found exact channel match: "${channel.name}" (${channel.id})`);
      }
      return channel;
    }

    logger.info(`No matching channel found for ID: ${channelId}`);
    return null;
  } catch (error) {
    logger.error(`Error getting channel by ID: ${error.message}`);
    return null;
  }
};

/**
 * Get categories for a session (from session storage)
 */
const getCategories = (session) => {
  try {
    if (!session || !session.data || !session.data.channels || !Array.isArray(session.data.channels)) {
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

module.exports = {
  getDatabaseStats,
  searchChannels,
  getChannelById,
  getCategories
};
