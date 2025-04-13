const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { getSession, updateSessionData } = require('../utils/sessionStorage');
const { saveJsonToFile, readJsonFromFile, getSessionStats, cleanupSessions } = require('../utils/storageUtils');
const epgService = require('../services/epgService');
const cacheService = require('../services/cacheService');
const configService = require('../services/configService');

// Add logging middleware for this router
router.use((req, res, next) => {
    // Add logger to req if not already present
    if (!req.logger) {
        req.logger = logger;
    }
    next();
});

// In the /channels endpoint 
router.get('/channels/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
    logger.error('Invalid session ID provided', { sessionId });
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  
  // ...existing code...
});

/**
 * GET /api/status
 * Returns information about the server's status
 */
router.get('/status', (req, res) => {
    const stats = getSessionStats();
    
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        memory: stats.memoryUsage,
        sessions: {
            count: stats.sessionCount,
            oldest: stats.oldestSession
        }
    });
});

/**
 * POST /api/status/cleanup
 * Manually triggers a session cleanup
 */
router.post('/status/cleanup', (req, res) => {
    const beforeStats = getSessionStats();
    
    // Run the cleanup function
    cleanupSessions();
    
    // Get stats after cleanup
    const afterStats = getSessionStats();
    
    res.json({
        success: true,
        before: beforeStats,
        after: afterStats,
        sessionsDiff: beforeStats.sessionCount - afterStats.sessionCount
    });
});

/**
 * GET /api/session/:id
 * Get session information
 */
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    logger.debug(`Session info request for: ${sessionId}`);
    
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.debug(`Invalid session format: ${sessionId}`);
        return res.status(404).json({ valid: false, error: 'Invalid session format' });
    }
    
    // Check if session exists in memory storage
    const session = getSession(sessionId);
    
    if (session) {
        logger.debug(`Session found: ${sessionId}`);
        return res.status(200).json({ 
            valid: true,
            session: {
                id: sessionId,
                channelCount: session.channels ? session.channels.length : 0,
                categoryCount: session.categories ? session.categories.length : 0,
                created: session.createdAt || new Date().toISOString(),
                lastAccessed: session.lastAccessed || new Date().toISOString()
            }
        });
    } else {
        // Check in app.locals.sessions as fallback
        const app = req.app;
        if (app && app.locals && app.locals.sessions && app.locals.sessions[sessionId]) {
            logger.debug(`Session found in app.locals: ${sessionId}`);
            const appSession = app.locals.sessions[sessionId];
            return res.status(200).json({ 
                valid: true,
                session: {
                    id: sessionId,
                    channelCount: appSession.channels ? appSession.channels.length : 0,
                    categoryCount: appSession.categories ? appSession.categories.length : 0,
                    created: appSession.created || new Date().toISOString(),
                    lastAccessed: appSession.lastAccessed || new Date().toISOString()
                }
            });
        }
        
        logger.debug(`Session not found but has valid format: ${sessionId}`);
        return res.status(200).json({ valid: true, created: false });
    }
});

/**
 * GET /api/status/session/:sessionId
 * Returns simple validation status for a session ID
 */
router.get('/status/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    logger.debug(`Session validity check for: ${sessionId}`);
    
    // Very simple session check - just verify it's not empty or invalid format
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        logger.debug(`Invalid session format: ${sessionId}`);
        return res.status(404).json({ valid: false, error: 'Invalid session format' });
    }
    
    // Check if session exists in memory storage
    const stats = getSessionStats();
    const exists = stats.sessions && stats.sessions.includes(sessionId);
    
    if (exists) {
        logger.debug(`Session found: ${sessionId}`);
        return res.status(200).json({ valid: true });
    } else {
        // Even if the session doesn't exist yet, we'll consider it valid
        // as long as it has a valid format, so the frontend can create it
        logger.debug(`Session not found but has valid format: ${sessionId}`);
        return res.status(200).json({ valid: true, created: false });
    }
});

/**
 * POST /api/session/register
 * Register a session without loading channels/EPG
 */
router.post('/api/session/register', (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        logger.error('Invalid session ID provided for registration');
        return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    
    logger.info(`Registering session: ${sessionId}`);
    
    // Add session to application storage
    const app = req.app;
    if (!app.locals.sessions) {
        app.locals.sessions = {};
    }
    
    // Create session if it doesn't exist
    if (!app.locals.sessions[sessionId]) {
        app.locals.sessions[sessionId] = {
            id: sessionId,
            created: new Date(),
            lastAccessed: new Date(),
            clients: [],
            channels: [],
            categories: []
        };
        logger.info(`Created new session: ${sessionId}`);
    } else {
        // Update last accessed time
        app.locals.sessions[sessionId].lastAccessed = new Date();
        logger.info(`Updated existing session: ${sessionId}`);
    }
    
    return res.status(200).json({ 
        success: true, 
        sessionId, 
        message: 'Session registered successfully' 
    });
});

/**
 * POST /api/session/create
 * Create a new session and return the session ID
 */
router.post('/api/session/create', (req, res) => {
    // Generate a unique session ID
    const sessionId = 'session_' + Math.random().toString(36).substring(2, 15);
    logger.info(`Creating new session: ${sessionId}`);
    
    // Add session to application storage
    const app = req.app;
    if (!app.locals.sessions) {
        app.locals.sessions = {};
    }
    
    app.locals.sessions[sessionId] = {
        id: sessionId,
        created: new Date(),
        lastAccessed: new Date(),
        clients: [],
        channels: [],
        categories: []
    };
    
    return res.status(200).json({ 
        success: true, 
        sessionId, 
        message: 'Session created successfully' 
    });
});

/**
 * POST /api/session/create-and-register
 * Create a new session and register it with all services
 */
router.post('/session/create-and-register', (req, res) => {
    // Generate a unique session ID
    const sessionId = 'session_' + Math.random().toString(36).substring(2, 15);
    logger.info(`Creating new unified session: ${sessionId}`);
    
    // Add session to application storage
    const app = req.app;
    if (!app.locals.sessions) {
        app.locals.sessions = {};
    }
    
    // Create session in app.locals
    app.locals.sessions[sessionId] = {
        id: sessionId,
        created: new Date(),
        lastAccessed: new Date(),
        clients: [],
        channels: [],
        categories: []
    };
    
    // Also register with sessionStorage if available
    try {
        const { updateSessionData } = require('../utils/sessionStorage');
        updateSessionData(sessionId, {
            created: new Date(),
            lastAccessed: new Date()
        });
    } catch (error) {
        logger.warn(`Could not register session with sessionStorage: ${error.message}`);
    }
    
    // Also register with epg sessionService
    try {
        const sessionService = require('../services/sessionService');
        sessionService.createSession(sessionId);
    } catch (error) {
        logger.warn(`Could not register session with sessionService: ${error.message}`);
    }
    
    return res.status(200).json({ 
        success: true, 
        sessionId, 
        message: 'Session created and registered with all services' 
    });
});

// Add a new endpoint for EPG summary statistics
router.get('/epg-summary', async (req, res) => {
    try {
        logger.info('API: Request for EPG summary statistics received');
        
        // Get all cached EPG sources
        const epgSources = [];
        const cacheDir = path.join(__dirname, '../cache');
        const files = await fs.readdir(cacheDir);
        
        // Find EPG source cache files
        const sourceFiles = files.filter(file => file.startsWith('epg_source_') && file.endsWith('.json'));
        
        // Load each source and add to the array
        for (const file of sourceFiles) {
            try {
                const filePath = path.join(cacheDir, file);
                const source = await cacheService.readCache(filePath);
                if (source && source.url) {
                    epgSources.push(source);
                }
            } catch (error) {
                logger.error(`Error reading cached EPG source: ${file}`, error);
            }
        }
        
        // Generate the summary
        const summary = epgService.generateEpgSummary(epgSources);
        
        // Add timestamp and cache info
        summary.timestamp = new Date().toISOString();
        summary.cacheInfo = {
            sourceFiles: sourceFiles.length,
            cacheDirectory: cacheDir
        };
        
        logger.info(`API: EPG summary generated with ${summary.totalSources} sources, ${summary.totalChannels} channels, and ${summary.totalPrograms} programs`);
        res.json(summary);
    } catch (error) {
        logger.error('API: Error generating EPG summary', error);
        res.status(500).json({ error: 'Error generating EPG summary', message: error.message });
    }
});

/**
 * GET /api/epg/search
 * Search for programs across all loaded EPG sources
 */
router.get('/epg/search', async (req, res) => {
    try {
        const { query, limit = 100 } = req.query;
        
        if (!query || query.length < 2) {
            return res.status(400).json({ 
                error: 'Invalid search query', 
                message: 'Search query must be at least 2 characters long'
            });
        }
        
        logger.info(`API: EPG search request received for: "${query}"`, { 
            query, requestedLimit: limit 
        });
        
        // Get cached EPG sources or load them
        let epgSources = [];
        try {
            // First try loading from constants
            const constants = require('../config/constants');
            const options = {
                maxChannelsPerSource: 0, // No limit
                forceRefresh: false
            };
            
            logger.debug(`Loading EPG sources for search`);
            const epgResult = await epgService.loadAllExternalEPGs(null, options);
            
            if (epgResult && Array.isArray(epgResult) && epgResult.length > 0) {
                epgSources = epgResult;
                logger.info(`Loaded ${epgSources.length} EPG sources for search`);
            } else {
                logger.warn(`No EPG sources found for search`);
            }
        } catch (loadError) {
            logger.error(`Error loading EPG sources for search: ${loadError.message}`, { 
                error: loadError.stack 
            });
        }
        
        if (epgSources.length === 0) {
            return res.status(404).json({ 
                error: 'No EPG data available', 
                message: 'No EPG sources were loaded for searching' 
            });
        }
        
        // Format sources for search
        const searchableSources = epgSources.filter(src => src && src.channels && src.channels.length > 0)
            .map(src => ({
                url: src.url || "Unknown",
                channels: src.channels || []
            }));
            
        if (searchableSources.length === 0) {
            return res.status(404).json({
                error: 'No EPG data available for search',
                message: 'EPG sources were found but no channel data is available'
            });
        }
        
        // Perform the search
        const searchOptions = {
            caseSensitive: false,
            includeDescription: true,
            limit: parseInt(limit, 10) || 100
        };
        
        const term = query; // Match the parameter name used by searchEpg
        const searchResults = await epgService.searchEpg(term, searchableSources, searchOptions);
        
        logger.info(`API: EPG search for "${query}" completed with ${searchResults.length} results`);
        
        return res.json({
            query,
            timestamp: new Date().toISOString(),
            results: searchResults,
            sourceCount: searchableSources.length,
            channelCount: searchableSources.reduce((sum, src) => sum + (src.channels?.length || 0), 0),
            matches: searchResults.length
        });
    } catch (error) {
        logger.error(`API: Error searching EPG data: ${error.message}`, { 
            error: error.stack 
        });
        res.status(500).json({ 
            error: 'Error performing EPG search', 
            message: error.message 
        });
    }
});

module.exports = router;