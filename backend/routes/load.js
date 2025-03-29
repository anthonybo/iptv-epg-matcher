/**
 * Load Route - handles loading channels and EPG data
 */
const { EXTERNAL_EPG_URLS } = require('../config/constants');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { getCacheKey, createSession } = require('../utils/storageUtils');
const { fetchURL } = require('../utils/fetchUtils');
const { parseM3U, loadXtreamM3U } = require('../services/m3uService');
const { loadXtreamEPG, loadAllExternalEPGs } = require('../services/epgService');
const {
    isCacheValid,
    readCache,
    writeCache,
    readEpgSourcesCache,  
    getChannelsCachePath,
    getEpgSourcesCachePath
} = require('../services/cacheService');

// Set up upload middleware
const upload = multer({ dest: 'uploads/' });

/**
 * POST /api/load
 * Loads channels and EPG data from various sources
 * With completely rewritten cache/reload logic
 */
router.post('/', upload.fields([{ name: 'm3u' }, { name: 'epg' }]), async (req, res) => {
    try {
      logger.info('Loading channels and EPG sources', { body: req.body, files: req.files });
      const { m3uUrl, epgUrl, xtreamUsername, xtreamPassword, xtreamServer, forceUpdate } = req.body;
      logger.debug('Force update flag', { forceUpdate: !!forceUpdate });
      
      // Generate cache key for this request
      const cacheKey = getCacheKey(xtreamUsername, xtreamPassword, xtreamServer);
      const cacheChannelsFile = getChannelsCachePath(cacheKey);
      const cacheEpgSourcesFile = getEpgSourcesCachePath(cacheKey);
      
      let channels = null;
      let epgSources = {};
      let m3uContent = null;
      let loadFreshEpgSources = false;
  
      // --- DETERMINE IF WE NEED TO LOAD FRESH DATA ---
      
      // First check if we should try to use cache at all
      const shouldTryCache = !forceUpdate && 
                            isCacheValid(cacheChannelsFile) && 
                            isCacheValid(cacheEpgSourcesFile);
      
      // Try loading channels from cache if appropriate
      if (shouldTryCache) {
        logger.info('Attempting to load data from cache');
        
        try {
          // Load channels from cache
          channels = readCache(cacheChannelsFile);
          if (!channels || !Array.isArray(channels) || channels.length === 0) {
            logger.warn('Invalid or empty channels cache, will reload channels');
            channels = null;
          } else {
            logger.info(`Successfully loaded ${channels.length} channels from cache`);
          }
          
          // Try to load EPG sources from cache
          const cachedEpgSources = readEpgSourcesCache(cacheEpgSourcesFile);
          
          // Check if we got valid EPG sources
          if (cachedEpgSources && 
              typeof cachedEpgSources === 'object' && 
              Object.keys(cachedEpgSources).length > 0) {
            
            // Improved critical source handling
            const criticalSources = ['epgshare01']; // Only require one critical source
            const hasCriticalSource = criticalSources.some(critical => 
              Object.keys(cachedEpgSources).some(key => key.toLowerCase().includes(critical))
            );
            
            // Determine if we have enough sources
            const hasEnoughSources = Object.keys(cachedEpgSources).length >= 2;
            
            if (hasCriticalSource && hasEnoughSources) {
              // We have valid EPG sources with critical sources included
              epgSources = cachedEpgSources;
              logger.info(`Successfully loaded ${Object.keys(epgSources).length} EPG sources from cache, including critical sources`);
              
              // If strongepg was expected but not loaded, log a note but don't force a reload
              const hasStrongEpg = Object.keys(cachedEpgSources).some(key => 
                key.toLowerCase().includes('strongepg')
              );
              
              if (!hasStrongEpg) {
                logger.info(`Note: strongepg source not loaded from cache, but continuing with available sources`);
              }
            } else {
              // Missing critical sources or not enough sources, need to reload
              logger.warn(`EPG cache has insufficient sources (critical source: ${hasCriticalSource}, source count: ${Object.keys(cachedEpgSources).length}), will reload EPG data`);
              loadFreshEpgSources = true;
            }
          } else {
            // Invalid or empty EPG sources cache
            logger.warn('Invalid or empty EPG sources cache, will reload EPG data');
            loadFreshEpgSources = true;
          }
        } catch (e) {
          logger.error('Failed to read or parse cache files', { error: e.message, stack: e.stack });
          channels = null; // Force fetching new data
          loadFreshEpgSources = true; // Force fetching new EPG data
        }
      } else {
        logger.info('Cache is invalid or force update enabled, loading fresh data');
        channels = null;
        loadFreshEpgSources = true;
      }
  
      // --- LOAD FRESH CHANNEL DATA IF NEEDED ---
      
      if (!channels) {
        logger.info('Loading fresh channel data');
        
        // Load from Xtream API
        if (xtreamUsername && xtreamPassword && xtreamServer) {
          const baseUrl = xtreamServer.endsWith('/') ? xtreamServer : `${xtreamServer}/`;
          
          // Load M3U content
          m3uContent = await loadXtreamM3U(baseUrl, xtreamUsername, xtreamPassword);
          
          // If we need to load EPG sources, get the Xtream EPG as well
          if (loadFreshEpgSources) {
            logger.info('Loading EPG from Xtream');
            const xtreamEPG = await loadXtreamEPG(baseUrl, xtreamUsername, xtreamPassword);
            if (xtreamEPG) {
              epgSources['XTREAM'] = xtreamEPG;
              logger.info('Successfully loaded Xtream EPG data');
            }
          }
        } 
        // Load from M3U URL
        else if (m3uUrl) {
          m3uContent = (await fetchURL(m3uUrl)).toString('utf8');
        } 
        // Load from uploaded M3U file
        else if (req.files && req.files.m3u) {
          m3uContent = fs.readFileSync(req.files.m3u[0].path, 'utf8');
          logger.info('Loaded M3U from file');
        } 
        // No valid source
        else {
          throw new Error('No M3U source provided');
        }
  
        // Parse M3U content to get channels
        channels = parseM3U(m3uContent, logger);
        logger.info('M3U parsed successfully', { channelCount: channels.length });
  
        // Log sample group titles for debugging
        const sampleGroupTitles = channels.slice(0, 10).map(ch => ch.groupTitle);
        logger.debug('Sample groupTitles', { sampleGroupTitles });
        
        // Cache the channels data
        try {
          // Cache only necessary channel data to reduce size
          writeCache(cacheChannelsFile, channels.map(ch => ({
            tvgId: ch.tvgId,
            name: ch.name,
            groupTitle: ch.groupTitle,
            url: ch.url
          })));
          logger.info(`Cached ${channels.length} channels to ${cacheChannelsFile}`);
        } catch (e) {
          logger.error(`Failed to write channels cache: ${e.message}`, { stack: e.stack });
        }
      }
  
      // --- LOAD FRESH EPG DATA IF NEEDED ---
      
      if (loadFreshEpgSources) {
        logger.info('Loading external EPG sources - this may take a while');
        
        // Use the enhanced function to load EPG sources
        const externalEpgSources = await loadAllExternalEPGs();
        
        // Validate the returned sources
        if (externalEpgSources && 
            typeof externalEpgSources === 'object' && 
            Object.keys(externalEpgSources).length > 0) {
          
          // Add external sources to any already loaded sources (like Xtream)
          epgSources = { ...epgSources, ...externalEpgSources };
          logger.info(`Successfully loaded ${Object.keys(externalEpgSources).length} external EPG sources`);
          
          // Cache the EPG sources
          try {
            // Only cache if we have sources
            if (Object.keys(epgSources).length > 0) {
              writeCache(cacheEpgSourcesFile, epgSources);
              logger.info(`Cached ${Object.keys(epgSources).length} EPG sources to ${cacheEpgSourcesFile}`);
            } else {
              logger.warn('No EPG sources to cache');
            }
          } catch (e) {
            logger.error(`Failed to write EPG sources cache: ${e.message}`, { stack: e.stack });
          }
        } else {
          logger.warn('Failed to load any external EPG sources');
        }
      }
  
      // Validate that we have channels
      if (!channels || !channels.length) {
        logger.error('No channels parsed from M3U');
        return res.status(500).json({ error: 'Failed to parse M3U channels' });
      }
  
      // Create a new session
      const sessionId = createSession({ 
        channels, 
        epgSources, 
        m3uContent, 
        xtreamUsername, 
        xtreamPassword, 
        xtreamServer 
      });
  
      // Generate category counts
      const categoryCounts = channels.reduce((acc, ch) => {
        const groupTitle = ch.groupTitle || 'Uncategorized';
        acc[groupTitle] = (acc[groupTitle] || 0) + 1;
        return acc;
      }, {});
      
      const categories = Object.entries(categoryCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      logger.debug('Extracted categories', { 
        categoryCount: categories.length, 
        categories: categories.slice(0, 10) 
      });
  
      // Prepare response with limited channels (pagination)
      const limitedChannels = channels.slice(0, 1000);
      const response = {
        sessionId,
        channels: limitedChannels,
        totalChannels: channels.length,
        categories,
        epgSources: Object.keys(epgSources || {}),
        status: Object.keys(epgSources || {}).length > 0 ? 'success' : 'no_epg',
        message: Object.keys(epgSources || {}).length > 0 
          ? 'Channels loaded successfully with EPG data' 
          : 'Channels loaded, but no EPG sources available'
      };
  
      // Log detailed info about loaded EPG sources
      if (Object.keys(epgSources).length > 0) {
        const sourceInfo = Object.keys(epgSources).map(key => {
          const source = epgSources[key];
          return {
            key,
            channelCount: source.channels ? source.channels.length : 0,
            programCount: source.programs ? source.programs.length : 0,
            channelMapSize: source.channelMap ? Object.keys(source.channelMap).length : 0,
            programMapSize: source.programMap ? Object.keys(source.programMap).length : 0
          };
        });
        logger.info('EPG sources loaded:', { sourceInfo });
      }
  
      // Log response size for debugging
      const responseSize = Buffer.byteLength(JSON.stringify(response), 'utf8');
      logger.info(`Sending response: ${responseSize} bytes`, { 
        sessionId, 
        channelCount: limitedChannels.length, 
        categoryCount: categories.length, 
        epgSourceCount: response.epgSources.length 
      });
  
      // Clean up uploaded files
      if (req.files && req.files.m3u) fs.unlinkSync(req.files.m3u[0].path);
      if (req.files && req.files.epg) fs.unlinkSync(req.files.epg[0].path);
  
      res.json(response);
    } catch (error) {
      logger.error('Load failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: error.message });
    }
  });

module.exports = router;