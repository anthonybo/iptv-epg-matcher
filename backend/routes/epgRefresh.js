/**
 * EPG Refresh Routes - handles refreshing individual or all EPG sources
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(authMiddleware);

/**
 * POST /api/epg-refresh/source
 * Refresh a single EPG source
 */
router.post('/source', async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?.id;

    if (!url) {
      return res.status(400).json({ error: 'EPG source URL is required' });
    }

    logger.info(`[EPG REFRESH] User ${userId} requesting refresh of single source: ${url}`);

    // Import the EPG service
    const { loadSingleEpgSource } = require('../services/epgService');
    const crypto = require('crypto');

    // Load the EPG data
    const result = await loadSingleEpgSource(url, {
      forceRefresh: true, // Force fresh download
      maxChannelsPerSource: 0 // No limit
    });

    // Check if we actually got any data
    const channelCount = result.channels?.length || 0;
    const programCount = result.totalPrograms || 0;

    if (channelCount === 0 && programCount === 0) {
      logger.warn(`[EPG REFRESH] EPG source loaded but returned no data: ${url}`);
      return res.status(400).json({
        success: false,
        error: 'EPG source loaded but contained no channels or programs. The URL may be invalid or the file may be empty.'
      });
    }

    logger.info(`[EPG REFRESH] Successfully loaded EPG from ${url}: ${channelCount} channels, ${programCount} programs`);

    // Save to database (PostgreSQL)
    logger.info(`[EPG REFRESH] Saving EPG data to PostgreSQL database...`);
    const epgDatabaseService = require('../services/epgDatabaseService');

    // Generate source ID from URL
    const sourceId = crypto.createHash('md5').update(url).digest('hex');

    // Get source name from user_epg_sources if it's a user source
    let sourceName = url.split('/').pop(); // Default to filename
    try {
      const iptvDatabaseService = require('../services/iptvDatabase');
      const iptvDb = await iptvDatabaseService.connect();
      const userSource = await new Promise((resolve, reject) => {
        iptvDb.get('SELECT name FROM user_epg_sources WHERE url = ?', [url], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (userSource) {
        sourceName = userSource.name;
      }
    } catch (err) {
      logger.debug(`Could not look up user source name: ${err.message}`);
    }

    // Add or update source
    await epgDatabaseService.saveSource({
      id: sourceId,
      name: sourceName,
      url: url,
      file_path: null
    });

    // Transform and save channels
    const savedChannelIds = new Set();
    if (result.channels && result.channels.length > 0) {
      const dbChannels = result.channels.map(ch => {
        savedChannelIds.add(ch.id); // Track which channel IDs we're saving
        return {
          id: ch.id,
          sourceId: sourceId,
          name: ch.name,
          icon: ch.icon || null
        };
      });

      logger.info(`[EPG REFRESH] Saving ${dbChannels.length} channels to PostgreSQL...`);
      logger.info(`[EPG REFRESH] Sample channel IDs: ${Array.from(savedChannelIds).slice(0, 5).join(', ')}`);
      await epgDatabaseService.saveChannels(dbChannels);
    }

    // Transform and save programs from programMap
    let totalSavedPrograms = 0;
    logger.info(`[EPG REFRESH] Checking for programs to save. programMap exists: ${!!result.programMap}, keys: ${result.programMap ? Object.keys(result.programMap).length : 0}`);

    if (result.programMap) {
      const programMapKeys = Object.keys(result.programMap);
      logger.info(`[EPG REFRESH] Sample programMap keys: ${programMapKeys.slice(0, 5).join(', ')}`);
    }

    if (result.programMap && Object.keys(result.programMap).length > 0) {
      // Flatten programMap into array of programs
      const allPrograms = [];
      let skippedChannels = 0;

      for (const [channelId, programs] of Object.entries(result.programMap)) {
        // Only save programs for channels that exist in our saved channels
        if (!savedChannelIds.has(channelId)) {
          skippedChannels++;
          logger.debug(`[EPG REFRESH] Skipping programs for non-existent channel: ${channelId}`);
          continue;
        }

        if (Array.isArray(programs)) {
          programs.forEach(prog => {
            allPrograms.push({
              id: `${channelId}_${prog.start}`,
              channelId: channelId,
              title: prog.title || 'Untitled',
              description: prog.description || null,
              start: prog.start,
              stop: prog.stop,
              category: prog.category || null
            });
          });
        }
      }

      if (skippedChannels > 0) {
        logger.info(`[EPG REFRESH] Skipped ${skippedChannels} channels with no matching channel entry`);
      }

      if (allPrograms.length > 0) {
        logger.info(`[EPG REFRESH] Saving ${allPrograms.length} programs to PostgreSQL...`);
        await epgDatabaseService.savePrograms(allPrograms);
        totalSavedPrograms = allPrograms.length;
      } else {
        logger.warn(`[EPG REFRESH] No programs to save after filtering`);
      }
    } else {
      logger.warn(`[EPG REFRESH] programMap is empty or undefined`);
    }

    // Update source statistics
    await epgDatabaseService.updateSourceStats(sourceId, channelCount, programCount);
    logger.info(`[EPG REFRESH] Database updated successfully`);

    // Mark user EPG source as verified if it successfully loaded data
    if (channelCount > 0 && userId) {
      try {
        const iptvDatabaseService = require('../services/iptvDatabase');
        const iptvDb = await iptvDatabaseService.connect();
        await new Promise((resolve, reject) => {
          iptvDb.run(
            'UPDATE user_epg_sources SET verified = 1 WHERE url = ? AND user_id = ?',
            [url, userId],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        logger.info(`[EPG REFRESH] Marked user EPG source as verified: ${url}`);
      } catch (verifyErr) {
        logger.warn(`[EPG REFRESH] Could not mark source as verified: ${verifyErr.message}`);
      }
    }

    return res.json({
      success: true,
      message: `Successfully loaded and saved ${channelCount} channels and ${programCount} programs`,
      channelCount,
      programCount
    });
  } catch (error) {
    logger.error(`[EPG REFRESH] Error refreshing EPG source: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
