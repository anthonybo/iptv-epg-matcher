/**
 * Auto-fill route: streams NDJSON back to the client, one channel per line,
 * as each is validated by ffprobe — so the multi-view fills progressively
 * rather than waiting for every slot to be filled.
 * Split out of the original monolithic routes/liveEvents.js.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../../config/logger');
const postgresService = require('../../services/postgresService');
const { execFileAsync, httpAgent, httpsAgent } = require('../../utils/streamAgents');
const { extractSearchTerms, calculateRelevanceScore } = require('../../utils/channelScoring');
const teamMatcher = require('../../utils/teamMatcher');
const teamAliasesService = require('../../services/teamAliasesService');

/**
 * POST /api/live-events/auto-fill-streams
 * Auto-fill multiview with multiple streams at once based on settings
 * Avoids duplicate sources and duplicate events
 */
router.post('/auto-fill-streams', async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const {
    sportType,
    leagueName,
    maxStreams = 4,
    excludeSourceIds = [],
    excludeEventIds = [],
    excludeChannelIds = [],
    minQuality = 0
  } = req.body;

  const minHeight = parseInt(minQuality) || 0;

  // Stream channels back as NDJSON so the UI can fill slots progressively
  // instead of waiting for every ffprobe test to complete.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const writeLine = (obj) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(JSON.stringify(obj) + '\n');
    if (typeof res.flush === 'function') res.flush();
    return true;
  };

  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  try {

    // Fetch blacklisted channels
    const blacklistResult = await postgresService.query(
      'SELECT channel_name FROM blacklisted_channels WHERE user_id = $1',
      [userId]
    );
    const blacklistedChannels = blacklistResult.rows.map(row => row.channel_name);

    logger.info(`Auto-fill: Looking for ${maxStreams} streams (sport: ${sportType || 'any'}, league: ${leagueName || 'any'}, minQuality: ${minHeight}p) for user ${userId}`);
    logger.info(`Auto-fill: Excluding ${excludeSourceIds.length} sources, ${excludeEventIds.length} events, ${excludeChannelIds.length} channels`);

    const foundChannels = [];
    const usedSourceIds = new Set(excludeSourceIds.map(id => parseInt(id)));
    const usedEventIds = new Set(excludeEventIds);
    const usedChannelIds = new Set(excludeChannelIds);

    // Build query for currently live events (PostgreSQL). "Live" =
    // time window OR ESPN's is_live flag — this keeps MLS (and other
    // soccer) games available to auto-fill when stoppage time has
    // pushed them past their estimated event_end. The half-hour floor
    // on event_end guards against stale is_live flags.
    // status_type gate keeps STATUS_FINAL games out even when ESPN's
    // is_live flag is briefly stale post-game.
    const conditions = [
      '((event_start <= $1 AND event_end >= $2) OR (is_live = TRUE AND event_end >= $3))',
      "(status_type IS NULL OR status_type NOT LIKE '%FINAL%')"
    ];
    const now = new Date().toISOString();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const params = [now, now, halfHourAgo];
    let paramIndex = 4;

    if (sportType) {
      conditions.push(`sport_type = $${paramIndex}`);
      params.push(sportType);
      paramIndex++;
    }

    if (leagueName) {
      conditions.push(`league_name = $${paramIndex}`);
      params.push(leagueName);
      paramIndex++;
    }

    // Get all matching live events
    const eventsResult = await postgresService.query(`
      SELECT * FROM live_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY RANDOM()
    `, params);

    const events = eventsResult.rows || [];

    if (events.length === 0) {
      logger.info('Auto-fill: No live events found');
      writeLine({
        type: 'done',
        total: 0,
        message: sportType ? `No live ${sportType} events available` : 'No live events available'
      });
      return res.end();
    }

    logger.info(`Auto-fill: Found ${events.length} matching live events`);

    // Helper function to test a channel - returns { valid: boolean, height: number }
    const testChannel = async (channel) => {
      let testUrl = channel.url;

      // Build proper URL for XTREAM sources
      if (channel.source_type === 'xtream' && channel.source_url && channel.source_username && channel.source_password) {
        const baseUrl = channel.source_url.replace(/\/$/, '');
        const streamId = channel.url.split('/').pop();
        testUrl = `${baseUrl}/live/${channel.source_username}/${channel.source_password}/${streamId}`;
      }

      // Handle Stalker portal authentication
      if (channel.source_type === 'stalker') {
        if (testUrl.includes('portal.php') && testUrl.includes('action=create_link')) {
          const createLinkResponse = await axios.get(testUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
              'X-User-Agent': 'Model: MAG250; Link: WiFi',
              'Cookie': `mac=${channel.source_mac || '00:1A:79:00:00:00'}; stb_lang=en; timezone=America/New_York`
            },
            timeout: 10000,
            httpAgent,
            httpsAgent
          });

          const linkData = createLinkResponse.data;

          if (linkData?.js?.cmd) {
            const freshCmd = linkData.js.cmd;
            const match = freshCmd.match(/ffmpeg\s+(.+)/);
            if (match && match[1]) {
              let freshUrl = match[1];

              // Fix empty stream parameter if needed
              const originalCmdMatch = testUrl.match(/cmd=([^&]+)/);
              if (originalCmdMatch) {
                const originalCmd = decodeURIComponent(originalCmdMatch[1]);
                const originalStreamMatch = originalCmd.match(/stream=([^&]+)/);
                if (originalStreamMatch && (freshUrl.includes('stream=&') || freshUrl.match(/stream=(?:&|$)/))) {
                  freshUrl = freshUrl.replace(/stream=(&|$)/, `stream=${originalStreamMatch[1]}$1`);
                }
              }

              testUrl = freshUrl;
            }
          }
        }

        // Validate Stalker stream
        const ffprobeArgs = [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          '-read_intervals', '%+#1',
          '-timeout', '8000000',
          '-headers', `Cookie: mac=${channel.source_mac}; stb_lang=en\r\nUser-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C)`,
          testUrl
        ];

        const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
          timeout: 10000,
          maxBuffer: 1024 * 1024
        });

        const probeData = JSON.parse(stdout);
        if (!probeData.streams || probeData.streams.length === 0) {
          throw new Error('No streams found');
        }

        const videoStream = probeData.streams.find(s => s.codec_type === 'video');

        // MUST have video - audio-only streams are not valid for IPTV
        if (!videoStream) {
          throw new Error('No video stream');
        }

        return { valid: true, height: videoStream.height || 0 };
      } else {
        // M3U/XTREAM validation
        const ffprobeArgs = [
          '-v', 'error',
          '-print_format', 'json',
          '-show_streams',
          '-read_intervals', '%+#1',
          '-timeout', '8000000',
          testUrl
        ];

        const { stdout } = await execFileAsync('ffprobe', ffprobeArgs, {
          timeout: 10000,
          maxBuffer: 1024 * 1024
        });

        const probeData = JSON.parse(stdout);
        if (!probeData.streams || probeData.streams.length === 0) {
          throw new Error('No streams found');
        }

        const videoStream = probeData.streams.find(s => s.codec_type === 'video');

        // MUST have video - audio-only streams are not valid for IPTV
        if (!videoStream) {
          throw new Error('No video stream');
        }

        return { valid: true, height: videoStream.height || 0 };
      }
    };

    // Track which events we've exhausted all channels for
    const exhaustedEvents = new Set();

    // Do multiple passes through events until we fill all slots or exhaust all options
    const maxPasses = 5; // Try up to 5 passes through the events

    for (let pass = 0; pass < maxPasses && foundChannels.length < maxStreams; pass++) {
      if (clientGone) break;
      logger.info(`Auto-fill: Pass ${pass + 1}/${maxPasses} - ${foundChannels.length}/${maxStreams} streams found`);

      for (const event of events) {
        if (clientGone) break;
        if (foundChannels.length >= maxStreams) {
          break;
        }

        // Skip already used events (when avoidDuplicateEvents is on) or exhausted events
        if (usedEventIds.has(event.event_id) || exhaustedEvents.has(event.event_id)) {
          continue;
        }

      const homeTeam = event.home_team || '';
      const awayTeam = event.away_team || '';

      // Use the new extractSearchTerms function for robust term extraction
      const homeTerms = extractSearchTerms(homeTeam);
      const awayTerms = extractSearchTerms(awayTeam);
      const searchTerms = [...new Set([...homeTerms, ...awayTerms])]; // Dedupe

      if (searchTerms.length === 0) {
        logger.info(`Auto-fill: Event ${event.event_name} has no search terms, skipping`);
        continue;
      }

      // Build channel query
      const channelConditions = searchTerms.map((_, i) => `c.name ILIKE $${i + 2}`).join(' OR ');
      const searchParams = searchTerms.map(term => `%${term}%`);
      let queryParams = [userId, ...searchParams];

      // Build source exclusion clause (exclude already used sources)
      let sourceExclusion = '';
      if (usedSourceIds.size > 0) {
        const sourceParamIndex = queryParams.length + 1;
        const sourcePlaceholders = Array.from(usedSourceIds).map((_, i) => `$${sourceParamIndex + i}`).join(', ');
        sourceExclusion = `AND s.id NOT IN (${sourcePlaceholders})`;
        queryParams.push(...Array.from(usedSourceIds));
      }

      // Build blacklist conditions
      let blacklistConditions = '1=1';
      if (blacklistedChannels.length > 0) {
        const blacklistParamIndex = queryParams.length + 1;
        blacklistConditions = blacklistedChannels.map((name, i) => {
          return `c.name != $${blacklistParamIndex + i}`;
        }).join(' AND ');
        queryParams.push(...blacklistedChannels);
      }

      // Build channel exclusion
      let channelExclusion = '';
      if (usedChannelIds.size > 0) {
        const channelParamIndex = queryParams.length + 1;
        const channelPlaceholders = Array.from(usedChannelIds).map((_, i) => `$${channelParamIndex + i}`).join(', ');
        channelExclusion = `AND c.channel_id NOT IN (${channelPlaceholders})`;
        queryParams.push(...Array.from(usedChannelIds));
      }

      // Build scoring conditions for SQL - prioritize channels with both teams
      let scoringCase = 'CASE ';
      if (homeTeam && awayTeam) {
        // Both teams = highest priority
        scoringCase += `WHEN LOWER(c.name) LIKE LOWER('%${homeTeam.replace(/'/g, "''")}%') AND LOWER(c.name) LIKE LOWER('%${awayTeam.replace(/'/g, "''")}%') THEN 3 `;
      }
      if (homeTeam) {
        scoringCase += `WHEN LOWER(c.name) LIKE LOWER('%${homeTeam.replace(/'/g, "''")}%') THEN 2 `;
      }
      scoringCase += 'ELSE 1 END';

      const sqlQuery = `
        SELECT
          c.channel_id as id,
          c.name,
          c.logo_url as logo,
          c.stream_url as url,
          c.tvg_id as epg_channel_id,
          c.group_title as category,
          s.id as source_id,
          s.name as source_name,
          s.type as source_type,
          s.url as source_url,
          s.username as source_username,
          s.password as source_password,
          s.mac_address as source_mac
        FROM iptv_channels c
        JOIN iptv_sources s ON c.source_id = s.id
        WHERE s.user_id = $1 AND (${channelConditions}) ${sourceExclusion} ${channelExclusion} AND ${blacklistConditions}
        ORDER BY ${scoringCase} DESC, RANDOM()
        LIMIT 50
      `;

      const channelsResult = await postgresService.query(sqlQuery, queryParams);

        let channels = channelsResult.rows || [];

        if (channels.length === 0) {
          // No more channels for this event, mark as exhausted
          exhaustedEvents.add(event.event_id);
          continue;
        }

        // Resolve alias bundles + current EPG programs for this batch.
        // Alias lookups are two single-row queries keyed by (league,
        // team-string); cached per event so we don't hit the DB every
        // channel. EPG is one query covering every candidate's tvg_id.
        const ctx = { sportType: event.sport_type, leagueName: event.league_name };
        let homeBundle = null;
        let awayBundle = null;
        if (event.league_name) {
          try {
            [homeBundle, awayBundle] = await Promise.all([
              teamAliasesService.getAliasesForTeam(event.league_name, homeTeam),
              teamAliasesService.getAliasesForTeam(event.league_name, awayTeam)
            ]);
          } catch (err) {
            logger.warn(`Auto-fill: Alias lookup failed for ${event.event_name}: ${err.message}`);
          }
        }
        // Use the TIERED alias shape so single-word city-only hits don't
        // outscore real team-channel matches.
        const homeAliases = homeBundle
          ? homeBundle.tiered
          : { full: [homeTeam], mascot: [], abbr: [], short: [], manual: [], city: [] };
        const awayAliases = awayBundle
          ? awayBundle.tiered
          : { full: [awayTeam], mascot: [], abbr: [], short: [], manual: [], city: [] };

        const epgByTvgId = new Map();
        const tvgIds = channels.map(c => c.epg_channel_id || c.tvg_id).filter(Boolean);
        if (tvgIds.length > 0) {
          try {
            const { rows } = await postgresService.query(
              `SELECT DISTINCT ON (channel_id) channel_id, title
                 FROM epg_programs
                WHERE channel_id = ANY($1)
                  AND start_time <= NOW()
                  AND stop_time > NOW()
                ORDER BY channel_id, start_time DESC`,
              [tvgIds]
            );
            for (const r of rows) epgByTvgId.set(r.channel_id, r.title);
          } catch (err) {
            logger.warn(`Auto-fill: EPG lookup failed: ${err.message}`);
          }
        }

        const useAliasMatcher = Boolean(homeBundle && awayBundle);
        channels = channels.map(channel => {
          let score;
          if (useAliasMatcher) {
            const programTitle = epgByTvgId.get(channel.epg_channel_id || channel.tvg_id) || null;
            const result = teamMatcher.matchChannel(
              { name: channel.name, currentProgramTitle: programTitle },
              homeAliases,
              awayAliases,
              ctx
            );
            score = result.score;
          } else {
            score = calculateRelevanceScore(channel.name, homeTeam, awayTeam, ctx);
          }
          // Legacy secondary bonuses — keep as-is so channels like
          // "NCAA | Alabama vs Auburn" still pick up +25 for the league
          // word even when it's already in our league-keyword set.
          if (event.league_name && channel.name.toLowerCase().includes(event.league_name.toLowerCase())) {
            score += 25;
          }
          if (event.sport_type && channel.name.toLowerCase().includes(event.sport_type.toLowerCase())) {
            score += 10;
          }
          return { ...channel, relevanceScore: score };
        });

        // Sort by relevance score (highest first) and filter low-relevance channels
        channels.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Only keep channels with score >= 35 (fuzzy match can add ~35 points)
        // Score >= 100 means exact team name match, >= 200 means both teams
        channels = channels.filter(c => c.relevanceScore >= 35);

        if (channels.length === 0) {
          exhaustedEvents.add(event.event_id);
          continue;
        }

        logger.info(`Auto-fill: Found ${channels.length} relevant channels for "${event.event_name}" (top score: ${channels[0]?.relevanceScore})`);

        let foundForThisEvent = false;

        // Filter out already used sources/channels AND collapse duplicates
        // where the same channel name is carried by multiple of the user's
        // accounts on the same upstream host — those are the same stream
        // with different credentials, so probing all of them in one
        // parallel batch just hammers the host with 6+ identical
        // ffprobes, trips rate limits, and burns ~10s per identical fail.
        // Keep the first occurrence (already highest-scored after the
        // sort above).
        const hostOf = (url) => {
          if (!url) return '';
          try { return new URL(url).host.toLowerCase(); }
          catch { return ''; }
        };
        const seenKeys = new Set();
        const eligibleChannels = [];
        let collapsedDupes = 0;
        for (const channel of channels) {
          if (usedSourceIds.has(parseInt(channel.source_id))) continue;
          if (usedChannelIds.has(channel.id)) continue;
          const host = hostOf(channel.source_url || channel.url);
          const key = `${(channel.name || '').toLowerCase().trim()}::${host}`;
          if (seenKeys.has(key)) { collapsedDupes++; continue; }
          seenKeys.add(key);
          eligibleChannels.push(channel);
        }
        if (collapsedDupes > 0) {
          logger.info(`Auto-fill: Collapsed ${collapsedDupes} duplicate (name,host) channels for "${event.event_name}"`);
        }

        if (eligibleChannels.length === 0) {
          exhaustedEvents.add(event.event_id);
          continue;
        }

        // Test channels in parallel batches (test top 6 at a time, prioritized by score)
        const batchSize = 6;
        for (let i = 0; i < eligibleChannels.length && !foundForThisEvent; i += batchSize) {
          if (foundChannels.length >= maxStreams) {
            break;
          }

          const batch = eligibleChannels.slice(i, i + batchSize);
          logger.info(`Auto-fill: Testing batch of ${batch.length} channels in parallel for "${event.event_name}"`);

          // Test all channels in batch simultaneously
          const testPromises = batch.map(async (channel) => {
            try {
              logger.info(`Auto-fill: Testing channel ${channel.name} (score: ${channel.relevanceScore}) for event ${event.event_name}`);
              const result = await testChannel(channel);

              // Check quality requirement
              if (minHeight > 0 && result.height < minHeight) {
                logger.info(`Auto-fill: ✗ Channel ${channel.name} quality too low: ${result.height}p < ${minHeight}p`);
                return { channel, success: false, reason: 'quality' };
              }

              logger.info(`Auto-fill: ✓ Channel ${channel.name} is WORKING! (${result.height}p)`);
              return { channel, success: true, result };
            } catch (error) {
              logger.info(`Auto-fill: ✗ Channel ${channel.name} failed: ${error.message}`);
              return { channel, success: false, reason: 'error', error: error.message };
            }
          });

          const results = await Promise.all(testPromises);

          // Mark all tested channels as used
          for (const r of results) {
            usedChannelIds.add(r.channel.id);
          }

          // Find the best working channel from this batch (highest score that works)
          const workingChannels = results
            .filter(r => r.success)
            .sort((a, b) => b.channel.relevanceScore - a.channel.relevanceScore);

          if (workingChannels.length > 0) {
            const best = workingChannels[0];
            const channel = best.channel;

            const payload = {
              id: channel.id,
              name: channel.name,
              logo: channel.logo,
              url: channel.url,
              sourceId: channel.source_id,
              sourceName: channel.source_name,
              sourceType: channel.source_type,
              sourceUrl: channel.source_url,
              sourceUsername: channel.source_username,
              sourcePassword: channel.source_password,
              sourceMac: channel.source_mac,
              espnEventId: event.event_id,
              espnEventName: event.event_name,
              quality: best.result.height
            };

            foundChannels.push(payload);

            // Stream this channel to the client immediately so the UI can
            // fill the slot without waiting for the remaining slots.
            writeLine({ type: 'channel', channel: payload });

            // Mark source and event as used
            usedSourceIds.add(parseInt(channel.source_id));
            usedEventIds.add(event.event_id);
            foundForThisEvent = true;
          }
        }

        // If we tested all channels and found nothing, mark event as exhausted
        if (!foundForThisEvent) {
          exhaustedEvents.add(event.event_id);
        }
      }
    }

    logger.info(`Auto-fill: Completed - Found ${foundChannels.length} working channels after ${maxPasses} passes`);

    writeLine({
      type: 'done',
      total: foundChannels.length,
      message: foundChannels.length === 0
        ? (minHeight > 0 ? `No streams found meeting ${minHeight}p quality requirement` : 'No working streams found')
        : `Found ${foundChannels.length} working stream${foundChannels.length !== 1 ? 's' : ''}`
    });
    return res.end();

  } catch (error) {
    logger.error('Auto-fill streams failed:', error);
    // Headers are already sent at this point, so we stream the error too.
    writeLine({ type: 'error', error: error.message });
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;
