/**
 * Published EPG Service
 * Manages published EPG data in the database (replaces static XMLTV files)
 */

const logger = require('../utils/logger');
const postgresService = require('./postgresService');

/**
 * Populate published_epg table for a credential
 * This replaces the static XMLTV file generation
 */
const publishEpgForCredential = async (credentialId, userId, matchedChannels, epgPrograms) => {
  try {
    logger.info(`Publishing EPG for credential ${credentialId}, user ${userId}: ${matchedChannels.length} channels, ${epgPrograms.length} programs`);

    // Start transaction
    await postgresService.query('BEGIN');

    // Delete old published EPG for this credential
    await postgresService.query('DELETE FROM published_epg WHERE credential_id = $1', [credentialId]);
    logger.info(`Deleted old EPG data for credential ${credentialId}`);

    // Insert new EPG data in batches (for performance)
    const batchSize = 1000;
    let insertedCount = 0;

    for (let i = 0; i < epgPrograms.length; i += batchSize) {
      const batch = epgPrograms.slice(i, i + batchSize);

      // Build bulk insert query
      const values = [];
      const placeholders = [];

      batch.forEach((prog, idx) => {
        const baseIdx = idx * 11;
        placeholders.push(
          `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11})`
        );

        // Parse XMLTV timestamp to PostgreSQL timestamp
        const parseXmltvTime = (xmltvTime) => {
          if (!xmltvTime) return null;
          // Format: YYYYMMDDHHMMSS +TZTZ
          const dateStr = xmltvTime.substring(0, 14);
          const year = dateStr.substring(0, 4);
          const month = dateStr.substring(4, 6);
          const day = dateStr.substring(6, 8);
          const hour = dateStr.substring(8, 10);
          const minute = dateStr.substring(10, 12);
          const second = dateStr.substring(12, 14);
          return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
        };

        values.push(
          credentialId,
          userId,
          prog.iptv_channel_id || prog.channel_id,
          prog.epg_channel_id || prog.channel_id,
          prog.channel_name || prog.title, // For dummy EPG, title is the channel name
          prog.logo_url || null,
          prog.title,
          prog.description,
          parseXmltvTime(prog.start),
          parseXmltvTime(prog.stop),
          prog.category || prog.categories || null
        );
      });

      if (placeholders.length > 0) {
        const insertQuery = `
          INSERT INTO published_epg
          (credential_id, user_id, iptv_channel_id, epg_channel_id, channel_name, logo_url, title, description, start_time, stop_time, categories)
          VALUES ${placeholders.join(', ')}
        `;

        await postgresService.query(insertQuery, values);
        insertedCount += batch.length;
      }
    }

    // Commit transaction
    await postgresService.query('COMMIT');

    logger.info(`Published ${insertedCount} EPG programs for credential ${credentialId}`);

    return {
      success: true,
      programCount: insertedCount
    };
  } catch (error) {
    // Rollback on error
    await postgresService.query('ROLLBACK');
    logger.error(`Error publishing EPG for credential ${credentialId}: ${error.message}`);
    throw error;
  }
};

/**
 * Get published EPG data for a credential (for XMLTV generation)
 */
const getPublishedEpg = async (credentialId) => {
  try {
    const result = await postgresService.query(`
      SELECT
        iptv_channel_id,
        epg_channel_id,
        channel_name,
        logo_url,
        title,
        description,
        (start_time AT TIME ZONE 'UTC') as start_time,
        (stop_time AT TIME ZONE 'UTC') as stop_time,
        categories
      FROM published_epg
      WHERE credential_id = $1
      AND stop_time >= NOW()
      ORDER BY iptv_channel_id, start_time
    `, [credentialId]);

    return result.rows || [];
  } catch (error) {
    logger.error(`Error getting published EPG for credential ${credentialId}: ${error.message}`);
    throw error;
  }
};

/**
 * Get published EPG data for a user (all credentials)
 */
const getPublishedEpgForUser = async (userId) => {
  try {
    const result = await postgresService.query(`
      SELECT
        p.iptv_channel_id,
        p.epg_channel_id,
        p.channel_name,
        p.logo_url,
        p.title,
        p.description,
        (p.start_time AT TIME ZONE 'UTC') as start_time,
        (p.stop_time AT TIME ZONE 'UTC') as stop_time,
        p.categories,
        c.username as credential_username
      FROM published_epg p
      JOIN credentials c ON c.id = p.credential_id
      WHERE p.user_id = $1
      AND p.stop_time >= NOW()
      ORDER BY p.channel_name, p.start_time
    `, [userId]);

    return result.rows || [];
  } catch (error) {
    logger.error(`Error getting published EPG for user ${userId}: ${error.message}`);
    throw error;
  }
};

/**
 * Delete published EPG for a credential
 */
const deletePublishedEpg = async (credentialId) => {
  try {
    await postgresService.query('DELETE FROM published_epg WHERE credential_id = $1', [credentialId]);
    logger.info(`Deleted published EPG for credential ${credentialId}`);
  } catch (error) {
    logger.error(`Error deleting published EPG for credential ${credentialId}: ${error.message}`);
    throw error;
  }
};

/**
 * Get published EPG statistics for a credential
 */
const getPublishedEpgStats = async (credentialId) => {
  try {
    const result = await postgresService.query(`
      SELECT
        COUNT(DISTINCT iptv_channel_id) as channel_count,
        COUNT(*) as program_count,
        MAX(published_at) as last_published
      FROM published_epg
      WHERE credential_id = $1
    `, [credentialId]);

    return result.rows[0] || { channel_count: 0, program_count: 0, last_published: null };
  } catch (error) {
    logger.error(`Error getting stats for credential ${credentialId}: ${error.message}`);
    throw error;
  }
};

module.exports = {
  publishEpgForCredential,
  getPublishedEpg,
  getPublishedEpgForUser,
  deletePublishedEpg,
  getPublishedEpgStats
};
