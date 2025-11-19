/**
 * EPG Match Service
 * Handles EPG channel matching, dummy EPG generation, and LIVE prefix logic
 */

const logger = require('../utils/logger');
const postgresService = require('./postgresService');
const epgDatabaseService = require('./epgDatabaseService');
const liveEventsService = require('./liveEventsService');
const { getChannelById } = require('./epgQueryService');

/**
 * Generate dummy EPG programs for a channel (7 days of 3-hour blocks)
 */
const generateDummyEpgPrograms = async (channelName, enableLivePrefix = false, autoDetectLive = false) => {
  const programs = [];
  const now = new Date();
  const nowTimestamp = now.getTime();

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
      if (isCurrentlyAiring && autoDetectLive && channelName) {
        isLiveEvent = await liveEventsService.isProgramLive(channelName);
      }

      // Add LIVE prefix if: currently airing AND (per-channel setting OR matches live event in database)
      const shouldAddLivePrefix = isCurrentlyAiring && (enableLivePrefix || isLiveEvent);

      const title = shouldAddLivePrefix
        ? `ʟɪᴠᴇ ${channelName}`
        : channelName;

      programs.push({
        id: `dummy_${channelName}_${day}_${hour}`,
        title: title,
        description: `Streaming on ${channelName}`,
        start: startDate.toISOString(),
        stop: stopDate.toISOString()
      });
    }
  }

  return programs;
};

/**
 * Add LIVE prefix to program title if applicable
 */
const addLivePrefixIfNeeded = async (program, enableLivePrefix, autoDetectLive) => {
  const nowTimestamp = Date.now();
  const startTime = new Date(program.start).getTime();
  const stopTime = new Date(program.stop).getTime();
  const isCurrentlyAiring = nowTimestamp >= startTime && nowTimestamp < stopTime;

  // Check if program matches a currently live event in database
  let isLiveEvent = false;
  if (isCurrentlyAiring && autoDetectLive && program.title) {
    isLiveEvent = await liveEventsService.isProgramLive(program.title);
  }

  // Add LIVE prefix if: currently airing AND (per-channel setting OR matches live event in database)
  const shouldAddLivePrefix = isCurrentlyAiring && (enableLivePrefix || isLiveEvent);

  return shouldAddLivePrefix
    ? `ʟɪᴠᴇ ${program.title || 'Unknown'}`
    : program.title;
};

/**
 * Get all matched channels with EPG programs for a user
 */
const getMatchedChannelsWithPrograms = async (userId) => {
  try {
    if (!userId) {
      throw new Error('User ID is required');
    }

    logger.info(`Getting matched channels with programs for user ${userId}`);

    // OPTIMIZATION: Single query to get all matched channels with full IPTV and source info
    const query = `
      SELECT
        m.iptv_channel_id,
        m.epg_channel_id,
        m.use_dummy_epg,
        m.created_at as match_created_at,
        c.channel_id,
        c.name as iptv_channel_name,
        c.logo_url as logo,
        c.stream_url as url,
        c.group_title,
        c.tvg_id as epg_channel_id_from_channel,
        c.source_id as iptv_source_id,
        c.enable_live_prefix,
        s.auto_detect_live,
        s.type as source_type,
        s.url as source_url,
        CASE WHEN s.name LIKE 'Legacy IPTV Source%' THEN s.url ELSE s.name END as source_name,
        p.nickname as source_nickname
      FROM epg_matches m
      LEFT JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      LEFT JOIN iptv_sources s ON c.source_id = s.id
      LEFT JOIN user_iptv_preferences p ON p.user_id = $1 AND p.source_id = s.id
      WHERE m.user_id = $1
      ORDER BY c.name
    `;

    const result = await postgresService.query(query, [userId]);
    const dbMatches = result.rows;

    if (dbMatches.length === 0) {
      return {
        success: true,
        channels: [],
        count: 0,
        message: 'No matched channels found'
      };
    }

    // Extract unique EPG channel IDs for batch fetch
    const epgChannelIds = [...new Set(dbMatches.map(m => m.epg_channel_id).filter(Boolean))];

    // OPTIMIZATION: Batch fetch EPG channel info
    const epgChannelsMap = new Map();
    if (epgChannelIds.length > 0) {
      const epgChannelsResult = await postgresService.query(`
        SELECT
          ec.id,
          ec.name,
          ec.icon,
          es.name as source_name
        FROM epg_channels ec
        LEFT JOIN epg_sources es ON ec.source_id = es.id
        WHERE ec.id = ANY($1)
      `, [epgChannelIds]);

      epgChannelsResult.rows.forEach(row => {
        epgChannelsMap.set(row.id, row);
      });
    }

    // OPTIMIZATION: Batch fetch programs for all non-dummy channels
    const now = new Date();
    const startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const endTime = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const nonDummyEpgIds = dbMatches
      .filter(m => m.use_dummy_epg !== 1 && m.epg_channel_id)
      .map(m => m.epg_channel_id);

    const programsMap = new Map();
    if (nonDummyEpgIds.length > 0) {
      const programsResult = await postgresService.query(`
        SELECT
          channel_id,
          title,
          description,
          start_time,
          stop_time
        FROM epg_programs
        WHERE channel_id = ANY($1)
        AND stop_time >= $2
        AND start_time <= $3
        ORDER BY channel_id, start_time
      `, [nonDummyEpgIds, startTime, endTime]);

      // Group programs by channel_id
      programsResult.rows.forEach(row => {
        if (!programsMap.has(row.channel_id)) {
          programsMap.set(row.channel_id, []);
        }
        programsMap.get(row.channel_id).push({
          title: row.title,
          description: row.description,
          start: row.start_time,
          stop: row.stop_time
        });
      });
    }

    // Process each matched channel
    const channelsWithEpg = [];

    for (const match of dbMatches) {
      try {
        const epgChannelId = match.epg_channel_id;
        const iptvChannelId = match.iptv_channel_id;

        if (!epgChannelId) {
          logger.warn(`No EPG ID found for channel ${iptvChannelId}`);
          continue;
        }

        // Build source info from joined data
        let iptvSourceInfo = null;
        if (match.iptv_source_id) {
          // Determine display name with fallback logic
          let displayName = match.source_nickname || match.source_name;

          if (!displayName || displayName.startsWith('session_') || displayName === 'null') {
            if (match.url) {
              try {
                const urlObj = new URL(match.url);
                displayName = `${urlObj.protocol}//${urlObj.host}`;
              } catch (urlError) {
                displayName = match.source_url || `Source ${match.iptv_source_id}`;
              }
            } else {
              displayName = match.source_url || `Source ${match.iptv_source_id}`;
            }
          }

          iptvSourceInfo = {
            id: match.iptv_source_id,
            name: displayName,
            type: match.source_type
          };
        }

        // Get EPG channel info from batch-fetched map
        const channelInfo = epgChannelsMap.get(epgChannelId);

        let formattedPrograms = [];

        // Handle dummy EPG channels
        if (match.use_dummy_epg === 1) {
          formattedPrograms = await generateDummyEpgPrograms(
            match.iptv_channel_name,
            match.enable_live_prefix === 1,
            match.auto_detect_live === 1
          );
        } else {
          // Get programs from batch-fetched map
          const programs = programsMap.get(epgChannelId) || [];

          if (programs.length === 0 && !channelInfo) {
            logger.warn(`No EPG data found for channel ${epgChannelId}`);
            continue;
          }

          // Add LIVE prefix if needed
          const nowTimestamp = Date.now();
          formattedPrograms = programs.map(p => {
            const startTime = new Date(p.start).getTime();
            const stopTime = new Date(p.stop).getTime();
            const isCurrentlyAiring = nowTimestamp >= startTime && nowTimestamp < stopTime;

            // Simple LIVE prefix logic (without async database check for performance)
            const shouldAddLivePrefix = isCurrentlyAiring && match.enable_live_prefix === 1;

            return {
              id: `${epgChannelId}_${startTime}`,
              title: shouldAddLivePrefix ? `ʟɪᴠᴇ ${p.title}` : p.title,
              description: p.description,
              start: p.start,
              stop: p.stop
            };
          });
        }

        channelsWithEpg.push({
          id: iptvChannelId,
          name: match.iptv_channel_name || channelInfo?.name || 'Unknown',
          logo: match.logo || channelInfo?.icon || null,
          url: (match.url || '').trim(),
          group: {
            title: match.group_title || ''
          },
          tvg: {
            id: match.epg_channel_id_from_channel || epgChannelId
          },
          epgId: epgChannelId,
          epgSource: channelInfo?.source_name || (match.use_dummy_epg === 1 ? 'Dummy EPG' : 'Unknown'),
          iptvSource: iptvSourceInfo,
          programs: formattedPrograms,
          enableLivePrefix: match.enable_live_prefix,
          sourceAutoDetectLive: match.auto_detect_live
        });
      } catch (channelError) {
        logger.error(`Error processing channel ${match.iptv_channel_id}: ${channelError.message}`);
      }
    }

    // Sort channels by name
    channelsWithEpg.sort((a, b) => a.name.localeCompare(b.name));

    logger.info(`Returning ${channelsWithEpg.length} channels with programs for user ${userId}`);

    return {
      success: true,
      channels: channelsWithEpg,
      count: channelsWithEpg.length,
      message: `Found ${channelsWithEpg.length} channels with EPG data`
    };
  } catch (error) {
    logger.error(`Error getting matched channels: ${error.message}`);
    throw error;
  }
};

/**
 * Save an EPG match to the database
 */
const saveMatch = async (sessionId, userId, iptvChannelId, epgChannelId, useDummyEpg = false) => {
  try {
    // If user is authenticated, delete all old matches for this channel for this user
    if (userId) {
      await postgresService.query(`
        DELETE FROM epg_matches
        WHERE user_id = $1 AND iptv_channel_id = $2
      `, [userId, iptvChannelId]);
      logger.info(`Deleted old matches for user ${userId}, channel ${iptvChannelId}`);
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
      iptvChannelId,
      epgChannelId,
      useDummyEpg ? 1 : 0
    ]);

    logger.info(`Saved match to database: ${iptvChannelId} -> ${epgChannelId}${userId ? ` (user ${userId})` : ''}`);
    return { success: true };
  } catch (error) {
    logger.error(`Failed to save match to database: ${error.message}`);
    throw error;
  }
};

/**
 * Delete a match from the database
 */
const deleteMatch = async (sessionId, userId, iptvChannelId) => {
  try {
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
    return { success: true };
  } catch (error) {
    logger.error(`Error deleting match: ${error.message}`);
    throw error;
  }
};

module.exports = {
  generateDummyEpgPrograms,
  addLivePrefixIfNeeded,
  getMatchedChannelsWithPrograms,
  saveMatch,
  deleteMatch
};
