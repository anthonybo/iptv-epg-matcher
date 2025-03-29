// routes/debug.js
/**
 * Debug Routes - handles debug endpoints
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getSession } = require('../utils/storageUtils');

/**
 * GET /api/debug/storage
 * Gets information about all active sessions
 */
router.get('/storage', (req, res) => {
  // This endpoint is for development only
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  
  const { storage } = require('../utils/storageUtils');
  
  // Count sessions and channels
  const sessionCount = Object.keys(storage).length;
  let totalChannels = 0;
  let totalEpgSources = 0;
  
  Object.values(storage).forEach(session => {
    if (session.channels) totalChannels += session.channels.length;
    if (session.epgSources) totalEpgSources += Object.keys(session.epgSources).length;
  });
  
  // Return summary (not the full data to avoid huge responses)
  res.json({
    sessionCount,
    totalChannels,
    totalEpgSources,
    sessionIds: Object.keys(storage),
    memoryUsage: process.memoryUsage()
  });
});

/**
 * GET /api/debug/logs
 * Gets recent application logs
 */
router.get('/logs', (req, res) => {
  // This endpoint is for development only
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  
  const { limit = 100 } = req.query;
  
  try {
    const logPath = require('path').join(__dirname, '../logs/app.log');
    const logs = require('fs')
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-parseInt(limit))
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return { raw: line };
        }
      });
    
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/debug/epg-channels/:sessionId
 * Lists all available channel IDs in the EPG sources
 */
router.get('/epg-channels/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { search } = req.query;
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const { epgSources } = session;
    const results = {};
    
    // Analyze each EPG source
    Object.keys(epgSources).forEach(sourceKey => {
      const source = epgSources[sourceKey];
      
      // Gather channel data
      const channelSamples = [];
      const programRefSamples = [];
      
      // Check if the source has channels
      if (source.channels && Array.isArray(source.channels)) {
        // Get channel IDs
        const channelIds = source.channels
          .filter(ch => ch.$ && ch.$.id)
          .map(ch => {
            // Get display name if available
            const displayName = ch['display-name'] 
              ? (typeof ch['display-name'][0] === 'string' 
                  ? ch['display-name'][0] 
                  : (ch['display-name'][0]._ || ch.$.id))
              : ch.$.id;
            
            return {
              id: ch.$.id,
              displayName
            };
          });
        
        // Filter by search term if provided
        const filteredChannels = search 
          ? channelIds.filter(ch => 
              ch.id.toLowerCase().includes(search.toLowerCase()) || 
              ch.displayName.toLowerCase().includes(search.toLowerCase()))
          : channelIds;
        
        // Add to samples
        filteredChannels.slice(0, 100).forEach(ch => channelSamples.push(ch));
      }
      
      // Check if the source has programs
      if (source.programs && Array.isArray(source.programs)) {
        // Get program channel references
        const programRefs = new Set();
        source.programs.forEach(p => {
          if (p.$ && p.$.channel) {
            programRefs.add(p.$.channel);
          }
        });
        
        // Filter by search term if provided
        const filteredRefs = search
          ? Array.from(programRefs).filter(ref => ref.toLowerCase().includes(search.toLowerCase()))
          : Array.from(programRefs);
        
        // Add to samples
        filteredRefs.slice(0, 100).forEach(ref => programRefSamples.push(ref));
      }
      
      results[sourceKey] = {
        channelCount: source.channels ? source.channels.length : 0,
        programCount: source.programs ? source.programs.length : 0,
        channelSamples,
        programRefSamples
      };
    });
    
    res.json(results);
  });

  /**
 * GET /api/debug/epg-dump/:sessionId
 * Dumps detailed information about the EPG sources for debugging
 */
router.get('/epg-dump/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { search } = req.query;
    const limit = parseInt(req.query.limit || 100);
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const { epgSources } = session;
    const results = {};
    
    // Analyze each EPG source
    Object.keys(epgSources).forEach(sourceKey => {
      const source = epgSources[sourceKey];
      
      // Initialize this source's results
      results[sourceKey] = {
        summary: {
          channelCount: source.channels ? source.channels.length : 0,
          programCount: source.programs ? source.programs.length : 0,
          channelMapCount: source.channelMap ? Object.keys(source.channelMap).length : 0,
          programMapCount: source.programMap ? Object.keys(source.programMap).length : 0
        },
        channels: [],
        programs: [],
        channelMapSample: {},
        programMapSample: {}
      };
      
      // Get channel samples
      if (source.channels && Array.isArray(source.channels)) {
        // Filter channels by search term if provided
        let filteredChannels = source.channels;
        if (search) {
          const searchLower = search.toLowerCase();
          filteredChannels = source.channels.filter(ch => {
            // Check channel ID
            if (ch.$ && ch.$.id && ch.$.id.toLowerCase().includes(searchLower)) {
              return true;
            }
            
            // Check display names
            if (ch['display-name']) {
              return ch['display-name'].some(name => {
                if (typeof name === 'string') {
                  return name.toLowerCase().includes(searchLower);
                } else if (name && name._) {
                  return name._.toLowerCase().includes(searchLower);
                }
                return false;
              });
            }
            
            return false;
          });
        }
        
        // Add the filtered channels to the results
        results[sourceKey].channels = filteredChannels.slice(0, limit).map(ch => {
          const displayNames = ch['display-name'] ? 
            ch['display-name'].map(name => {
              if (typeof name === 'string') return name;
              if (name && name._) return name._;
              return 'Unknown';
            }) : [];
          
          return {
            id: ch.$ ? ch.$.id : 'unknown',
            displayNames
          };
        });
      }
      
      // Get program samples for channels matching search
      if (source.programs && Array.isArray(source.programs) && search) {
        const searchLower = search.toLowerCase();
        
        // First, find channel IDs that match the search
        const matchingChannelIds = new Set();
        if (source.channels) {
          source.channels.forEach(ch => {
            if (ch.$ && ch.$.id) {
              // Check channel ID
              if (ch.$.id.toLowerCase().includes(searchLower)) {
                matchingChannelIds.add(ch.$.id);
              }
              
              // Check display names
              if (ch['display-name']) {
                ch['display-name'].forEach(name => {
                  if ((typeof name === 'string' && name.toLowerCase().includes(searchLower)) ||
                      (name && name._ && name._.toLowerCase().includes(searchLower))) {
                    matchingChannelIds.add(ch.$.id);
                  }
                });
              }
            }
          });
        }
        
        // Find programs for matching channels
        const matchingPrograms = source.programs.filter(prog => 
          prog.$ && prog.$.channel && matchingChannelIds.has(prog.$.channel)
        );
        
        // Add program samples to results
        results[sourceKey].programs = matchingPrograms.slice(0, limit).map(prog => {
          let title = 'Unknown';
          if (prog.title) {
            title = typeof prog.title[0] === 'string' ? prog.title[0] : 
              (prog.title[0] && prog.title[0]._ ? prog.title[0]._ : 'Unknown');
          }
          
          return {
            channelId: prog.$ ? prog.$.channel : 'unknown',
            start: prog.$ ? prog.$.start : 'unknown',
            stop: prog.$ ? prog.$.stop : 'unknown',
            title
          };
        });
      }
      
      // Get channel map samples
      if (source.channelMap && typeof source.channelMap === 'object') {
        const channelMapKeys = Object.keys(source.channelMap);
        
        // Filter keys by search term if provided
        let filteredKeys = channelMapKeys;
        if (search) {
          const searchLower = search.toLowerCase();
          filteredKeys = channelMapKeys.filter(key => key.toLowerCase().includes(searchLower));
        }
        
        // Add sample keys to results
        filteredKeys.slice(0, limit).forEach(key => {
          const channel = source.channelMap[key];
          results[sourceKey].channelMapSample[key] = channel.$ ? channel.$.id : 'unknown';
        });
      }
      
      // Get program map samples
      if (source.programMap && typeof source.programMap === 'object') {
        const programMapKeys = Object.keys(source.programMap);
        
        // Filter keys by search term if provided
        let filteredKeys = programMapKeys;
        if (search) {
          const searchLower = search.toLowerCase();
          filteredKeys = programMapKeys.filter(key => key.toLowerCase().includes(searchLower));
        }
        
        // Add sample keys and program counts to results
        filteredKeys.slice(0, limit).forEach(key => {
          const programs = source.programMap[key];
          results[sourceKey].programMapSample[key] = programs ? programs.length : 0;
        });
      }
    });
    
    // Set appropriate headers for large responses
    res.set('Content-Type', 'application/json');
    res.json(results);
  });
  
  /**
   * GET /api/debug/epg-channel-list/:sessionId
   * Get a list of all channels in all EPG sources
   */
  router.get('/epg-channel-list/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { source } = req.query;
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const { epgSources } = session;
    const results = {};
    
    // Use specific source or all sources
    const sourceKeys = source ? [source] : Object.keys(epgSources);
    
    sourceKeys.forEach(sourceKey => {
      if (!epgSources[sourceKey]) {
        results[sourceKey] = { error: 'Source not found' };
        return;
      }
      
      const source = epgSources[sourceKey];
      const channels = [];
      
      // Collect all channels
      if (source.channels && Array.isArray(source.channels)) {
        source.channels.forEach(ch => {
          if (!ch.$ || !ch.$.id) return;
          
          // Get display names
          const displayNames = [];
          if (ch['display-name']) {
            ch['display-name'].forEach(name => {
              if (typeof name === 'string') {
                displayNames.push(name);
              } else if (name && name._) {
                displayNames.push(name._);
              }
            });
          }
          
          channels.push({
            id: ch.$.id,
            displayNames,
            hasProgramData: source.programMap && source.programMap[ch.$.id] ? true : false,
            programCount: source.programMap && source.programMap[ch.$.id] ? source.programMap[ch.$.id].length : 0
          });
        });
      }
      
      // Sort channels by ID for easier browsing
      channels.sort((a, b) => a.id.localeCompare(b.id));
      
      results[sourceKey] = {
        channelCount: channels.length,
        channels
      };
    });
    
    res.json(results);
  });
  
  /**
 * GET /api/debug/epg-channel-search/:sessionId/:term
 * Search for channels in all EPG sources
 */
router.get('/epg-channel-search/:sessionId/:term', (req, res) => {
    const { sessionId, term } = req.params;
    
    if (!term || term.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const { epgSources } = session;
    const results = {
      term,
      matches: {}
    };
    
    // Search in all EPG sources
    Object.keys(epgSources).forEach(sourceKey => {
      const source = epgSources[sourceKey];
      const matches = [];
      
      // Search in channels
      if (source.channels && Array.isArray(source.channels)) {
        source.channels.forEach(ch => {
          if (!ch.$ || !ch.$.id) return;
          
          let isMatch = false;
          const searchMatches = [];
          
          // Check channel ID
          if (ch.$.id.toLowerCase().includes(term.toLowerCase())) {
            isMatch = true;
            searchMatches.push(`ID: ${ch.$.id}`);
          }
          
          // Check display names
          if (ch['display-name']) {
            ch['display-name'].forEach(name => {
              let displayName;
              if (typeof name === 'string') {
                displayName = name;
              } else if (name && name._) {
                displayName = name._;
              }
              
              if (displayName && displayName.toLowerCase().includes(term.toLowerCase())) {
                isMatch = true;
                searchMatches.push(`Name: ${displayName}`);
              }
            });
          }
          
          if (isMatch) {
            const displayNames = [];
            if (ch['display-name']) {
              ch['display-name'].forEach(name => {
                if (typeof name === 'string') {
                  displayNames.push(name);
                } else if (name && name._) {
                  displayNames.push(name._);
                }
              });
            }
            
            matches.push({
              id: ch.$.id,
              displayNames,
              searchMatches,
              hasProgramData: source.programMap && source.programMap[ch.$.id] ? true : false,
              programCount: source.programMap && source.programMap[ch.$.id] ? source.programMap[ch.$.id].length : 0
            });
          }
        });
      }
      
      // Search in channelMap keys
      if (source.channelMap) {
        const mapMatches = [];
        Object.keys(source.channelMap).forEach(key => {
          if (key.toLowerCase().includes(term.toLowerCase())) {
            const channel = source.channelMap[key];
            if (channel && channel.$) {
              mapMatches.push({
                key,
                channelId: channel.$.id
              });
            }
          }
        });
        
        if (mapMatches.length > 0) {
          results[sourceKey] = {
            ...results[sourceKey],
            mapMatches
          };
        }
      }
      
      results.matches[sourceKey] = {
        matchCount: matches.length,
        matches: matches.slice(0, 100) // Limit results
      };
    });
    
    res.json(results);
  });

  /**
 * POST /api/debug/add-test-epg/:sessionId
 * Adds a test EPG source with popular channels for testing
 */
router.post('/add-test-epg/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
      const testSource = createTestEpgSource();
      session.epgSources = session.epgSources || {};
      session.epgSources['TEST_SOURCE'] = testSource;
      
      updateSession(sessionId, session);
      
      res.json({
        status: 'success',
        message: 'Test EPG source added successfully',
        channelCount: testSource.channels.length,
        programCount: testSource.programs.length
      });
    } catch (error) {
      logger.error('Failed to add test EPG source', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to add test EPG source: ' + error.message });
    }
  });
  
  /**
 * GET /api/debug/search-channels/:sessionId/:term
 * Searches for channels containing the term in their ID or display name
 */
router.get('/search-channels/:sessionId/:term', (req, res) => {
    const { sessionId, term } = req.params;
    
    if (!term || term.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const { epgSources } = session;
    const searchTerm = term.toLowerCase();
    const results = {};
    
    // Search in each EPG source
    Object.keys(epgSources).forEach(sourceKey => {
      const source = epgSources[sourceKey];
      const channelMatches = [];
      
      // Create sets for unique channel IDs to avoid duplicates
      const matchedChannelIds = new Set();
      
      // First check program channel attributes
      if (source.programs && Array.isArray(source.programs)) {
        source.programs.forEach(program => {
          if (program.$ && program.$.channel && 
              program.$.channel.toLowerCase().includes(searchTerm) &&
              !matchedChannelIds.has(program.$.channel)) {
            
            matchedChannelIds.add(program.$.channel);
            channelMatches.push({
              id: program.$.channel,
              type: 'program-channel-reference',
              programCount: source.programs.filter(p => p.$ && p.$.channel === program.$.channel).length
            });
          }
        });
      }
      
      // Then check channel elements
      if (source.channels && Array.isArray(source.channels)) {
        source.channels.forEach(channel => {
          if (!channel.$ || !channel.$.id) return;
          
          let matches = false;
          const matchDetails = [];
          
          // Check ID
          if (channel.$.id.toLowerCase().includes(searchTerm)) {
            matches = true;
            matchDetails.push(`ID: ${channel.$.id}`);
          }
          
          // Check display names
          if (channel['display-name'] && Array.isArray(channel['display-name'])) {
            channel['display-name'].forEach(name => {
              const displayName = typeof name === 'string' ? name : 
                                 (name && name._ ? name._ : null);
              
              if (displayName && displayName.toLowerCase().includes(searchTerm)) {
                matches = true;
                matchDetails.push(`Display Name: ${displayName}`);
              }
            });
          }
          
          if (matches && !matchedChannelIds.has(channel.$.id)) {
            matchedChannelIds.add(channel.$.id);
            
            // Get display names
            const displayNames = [];
            if (channel['display-name']) {
              channel['display-name'].forEach(name => {
                if (typeof name === 'string') {
                  displayNames.push(name);
                } else if (name && name._) {
                  displayNames.push(name._);
                }
              });
            }
            
            // Count programs for this channel
            const programCount = source.programs ? 
              source.programs.filter(p => p.$ && p.$.channel === channel.$.id).length : 0;
            
            channelMatches.push({
              id: channel.$.id,
              type: 'channel-element',
              displayNames,
              programCount,
              matchDetails
            });
          }
        });
      }
      
      results[sourceKey] = {
        channelCount: channelMatches.length,
        channels: channelMatches
      };
    });
    
    res.json({
      term: searchTerm,
      sourcesSearched: Object.keys(epgSources).length,
      results
    });
  });
  

module.exports = router;