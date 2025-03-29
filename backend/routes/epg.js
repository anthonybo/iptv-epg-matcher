/**
 * EPG Routes - handles EPG-related endpoints
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getSession } = require('../utils/storageUtils');
// const { parseEPG, findProgramsForChannel, loadExternalEPG } = require('../services/epgService');
// const { parseEPG, findProgramsForChannel, findProgramsForSpecificChannel, loadExternalEPG } = require('../services/epgService');
const { parseEPG, findProgramsForChannel, findProgramsForSpecificChannel, searchChannelsAcrossSources, loadExternalEPG } = require('../services/epgService');


/**
 * GET /api/epg/:sessionId/search
 * Searches for channels matching a term across all EPG sources
 */
router.get('/:sessionId/search', (req, res) => {
    const { sessionId } = req.params;
    const { term } = req.query;

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    if (!term || term.length < 2) {
        return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }

    const session = getSession(sessionId);
    if (!session) {
        logger.error('Session not found', { sessionId });
        return res.status(404).json({ error: 'Session not found' });
    }

    const { epgSources } = session;
    const searchResults = searchChannelsAcrossSources(epgSources, term);

    res.json(searchResults);
});

/**
* GET /api/epg/:sessionId/channel/:sourceKey/:channelId
* Gets program data for a specific channel from a specific source
*/
router.get('/:sessionId/channel/:sourceKey/:channelId', (req, res) => {
    const { sessionId, sourceKey, channelId } = req.params;

    if (!sessionId || !sourceKey || !channelId) {
        return res.status(400).json({ error: 'Session ID, source key, and channel ID are required' });
    }

    const session = getSession(sessionId);
    if (!session) {
        logger.error('Session not found', { sessionId });
        return res.status(404).json({ error: 'Session not found' });
    }

    const { epgSources } = session;

    if (!epgSources[sourceKey]) {
        return res.status(404).json({ error: `EPG source '${sourceKey}' not found` });
    }

    const programData = findProgramsForSpecificChannel(epgSources[sourceKey], channelId);

    res.json(programData);
});

/**
 * GET /api/epg/:sessionId
 * Gets program data for a specific channel
 */
router.get('/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { channelId } = req.query;

    if (!sessionId || !channelId) {
        return res.status(400).json({ error: 'Missing sessionId or channelId' });
    }

    const session = getSession(sessionId);
    if (!session) {
        logger.error('Session not found', { sessionId });
        return res.status(404).json({ error: 'Session not found' });
    }

    const { epgSources } = session;
    const programData = findProgramsForChannel(epgSources, channelId);

    logger.debug('Sending EPG data', {
        sessionId,
        channelId,
        programCount: programData.programs.length,
        hasCurrentProgram: !!programData.currentProgram
    });

    res.json(programData);
});

/**
 * GET /api/epg/:sessionId/sources
 * Gets a list of available EPG sources for a session
 */
router.get('/:sessionId/sources', (req, res) => {
    const { sessionId } = req.params;

    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const epgSources = session.epgSources || {};
    const sourceNames = Object.keys(epgSources);

    res.json({
        sources: sourceNames,
        count: sourceNames.length
    });
});

/**
 * GET /api/epg/debug/:sessionId
 * Debug endpoint to check EPG data
 */
router.get('/debug/:sessionId', (req, res) => {
    const { sessionId } = req.params;

    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const { epgSources } = session;
    const sourcesInfo = {};

    // Get info about each EPG source
    Object.keys(epgSources).forEach(sourceKey => {
        const source = epgSources[sourceKey];
        const channelCount = source.channels ? source.channels.length : 0;
        const programCount = source.programs ? source.programs.length : 0;

        // Get sample channel IDs and structure
        const channelSamples = source.channels
            ? source.channels.slice(0, 5).map(ch => ({
                id: ch.$ ? ch.$.id : 'unknown',
                name: ch['display-name'] ? ch['display-name'][0] : 'unknown',
                alternativeIds: ch.alternativeIds || []
            }))
            : [];

        // Get sample program channel references
        const programSamples = source.programs
            ? source.programs.slice(0, 5).map(p => ({
                channel: p.$ ? p.$.channel : 'unknown',
                title: p.title ? p.title[0] : 'unknown',
                start: p.$ ? p.$.start : 'unknown'
            }))
            : [];

        sourcesInfo[sourceKey] = {
            channelCount,
            programCount,
            channelSamples,
            programSamples
        };
    });

    res.json(sourcesInfo);
});

/**
 * GET /api/epg/debug-search/:sessionId
 * Debug endpoint to search for channels across all EPG sources
 */
router.get('/debug-search/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { query } = req.query;

    if (!sessionId || !query) {
        return res.status(400).json({ error: 'Missing session ID or search query' });
    }

    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const { epgSources } = session;
    const results = {};

    // Search for channels matching the query
    Object.keys(epgSources).forEach(sourceKey => {
        const source = epgSources[sourceKey];
        results[sourceKey] = {
            channelMatches: [],
            programMatches: []
        };

        // Search in channel map if available
        if (source.channelMap) {
            const matchingKeys = Object.keys(source.channelMap).filter(key =>
                key.toLowerCase().includes(query.toLowerCase())
            );

            // Get unique channel IDs
            const uniqueChannelIds = [...new Set(matchingKeys.map(key => source.channelMap[key].$.id))];

            results[sourceKey].channelMatches = uniqueChannelIds.map(id => {
                const channel = source.channels.find(ch => ch.$ && ch.$.id === id);
                return {
                    id: id,
                    displayName: channel && channel['display-name'] ?
                        (typeof channel['display-name'][0] === 'string' ?
                            channel['display-name'][0] :
                            channel['display-name'][0]._ || id) :
                        id
                };
            });
        }

        // Search for programs with matching channel IDs
        if (source.programMap) {
            results[sourceKey].channelMatches.forEach(channel => {
                const programs = source.programMap[channel.id] || [];
                if (programs.length > 0) {
                    results[sourceKey].programMatches.push({
                        channelId: channel.id,
                        programCount: programs.length,
                        sample: programs.slice(0, 3).map(p => ({
                            title: p.title ? (typeof p.title[0] === 'string' ? p.title[0] : p.title[0]._ || 'Unknown') : 'Unknown',
                            start: p.$.start,
                            stop: p.$.stop
                        }))
                    });
                }
            });
        }
    });

    res.json(results);
});

/**
 * POST /api/epg/import/:sessionId
 * Imports EPG data from URL
 */
router.post('/import/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { epgUrl } = req.body;

    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (!epgUrl) {
        return res.status(400).json({ error: 'EPG URL is required' });
    }

    try {
        logger.info(`Importing EPG data from ${epgUrl}`);

        const epgData = await loadExternalEPG(epgUrl);
        if (!epgData) {
            return res.status(500).json({ error: 'Failed to load EPG data' });
        }

        // Add this EPG source to the session
        session.epgSources = session.epgSources || {};
        session.epgSources['imported'] = epgData;

        res.json({
            status: 'success',
            message: 'EPG data imported successfully',
            stats: {
                channelCount: epgData.channels.length,
                programCount: epgData.programs.length
            }
        });
    } catch (error) {
        logger.error(`Error importing EPG data: ${error.message}`, { stack: error.stack });
        res.status(500).json({ error: `Failed to import EPG data: ${error.message}` });
    }
});

/**
 * POST /api/epg/:sessionId/match
 * Updates the matched channels in the session
 * Add this to your epg.js routes file
 */
router.post('/:sessionId/match', (req, res) => {
    const { sessionId } = req.params;
    const { channelId, epgId } = req.body;

    if (!sessionId || !channelId || !epgId) {
        return res.status(400).json({ error: 'Missing required parameters: sessionId, channelId, epgId' });
    }

    const session = getSession(sessionId);
    if (!session) {
        logger.error('Session not found', { sessionId });
        return res.status(404).json({ error: 'Session not found' });
    }

    // Initialize matchedChannels if it doesn't exist
    if (!session.matchedChannels) {
        session.matchedChannels = {};
    }

    // Update the matched channel
    session.matchedChannels[channelId] = epgId;
    
    // Save the updated session
    updateSession(sessionId, { matchedChannels: session.matchedChannels });

    logger.info(`Updated matched channel in session: ${channelId} -> ${epgId}`, { 
        sessionId, 
        channelId, 
        epgId, 
        matchCount: Object.keys(session.matchedChannels).length 
    });

    // Return the updated matched channels
    res.json({
        status: 'success',
        message: 'Matched channel updated',
        matchedChannels: session.matchedChannels
    });
});

/**
 * GET /api/epg/:sessionId/matches
 * Gets the current matched channels in the session
 * Add this to your epg.js routes file
 */
router.get('/:sessionId/matches', (req, res) => {
    const { sessionId } = req.params;

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    const session = getSession(sessionId);
    if (!session) {
        logger.error('Session not found', { sessionId });
        return res.status(404).json({ error: 'Session not found' });
    }

    // Return the current matched channels
    res.json({
        matchedChannels: session.matchedChannels || {},
        count: session.matchedChannels ? Object.keys(session.matchedChannels).length : 0
    });
});

module.exports = router;