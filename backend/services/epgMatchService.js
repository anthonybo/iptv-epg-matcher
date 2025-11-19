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

    // Get matched channels from PostgreSQL database
    const query = `
      SELECT
        m.iptv_channel_id,
        c.name as iptv_channel_name,
        m.epg_channel_id,
        m.use_dummy_epg,
        c.source_id as iptv_source_id,
        s.auto_detect_live,
        c.enable_live_prefix
      FROM epg_matches m
      LEFT JOIN iptv_channels c ON m.iptv_channel_id = c.channel_id
      LEFT JOIN iptv_sources s ON c.source_id = s.id
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

            let fallbackQuery = `
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
              fallbackQuery += ` AND EXISTS (
                SELECT 1 FROM user_iptv_preferences p
                WHERE p.user_id = $2 AND p.source_id = c.source_id
              )`;
              params.push(userId);
            }

            fallbackQuery += ` LIMIT 1`;

            const iptvChannelByEpgResult = await postgresService.query(fallbackQuery, params);
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

          formattedPrograms = await generateDummyEpgPrograms(
            currentChannelName,
            match.enable_live_prefix === 1,
            match.auto_detect_live === 1
          );
        } else {
          // Regular EPG channel
          if (!channelInfo) {
            logger.warn(`No EPG data found for channel ${epgChannelId}`);
            continue;
          }

          // Get programs for this channel (12 hours in the past to 48 hours in the future for guide view)
          const now = new Date();
          const startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
          const endTime = new Date(now.getTime() + 48 * 60 * 60 * 1000);

          const programs = await epgDatabaseService.getProgramsByChannelId(epgChannelId, startTime, endTime);

          // Add LIVE prefix if needed
          formattedPrograms = await Promise.all(programs.map(async (p) => {
            const title = await addLivePrefixIfNeeded(
              { ...p, start: p.start, stop: p.stop },
              match.enable_live_prefix === 1,
              match.auto_detect_live === 1
            );

            return {
              id: p.id,
              title: title,
              description: p.description,
              start: p.start,
              stop: p.stop
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
        logger.error(`Error fetching EPG for channel ${match.iptv_channel_id}: ${channelError.message}`);
      }
    }

    // Sort channels by name
    channelsWithEpg.sort((a, b) => a.name.localeCompare(b.name));

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
