/**
 * EPG Service - handles parsing and processing of EPG data
 */
const xml2js = require('xml2js');
const sax = require('sax');
const logger = require('../utils/logger');
const fetch = require('node-fetch');
const { fetchURL } = require('../utils/fetchUtils');
const cacheService = require('../services/cacheService');
const { 
  getEpgSourceCachePath,
  isCacheValid,
  getCacheRemainingHours,
  readJsonFromFile
} = require('../services/cacheService');
const { 
  EXTERNAL_EPG_URLS, 
  PRIORITY_EPG_SOURCES, 
  MAX_EPG_SOURCES, 
  CACHE_DIR,
  EPG_CACHE_TTL_HOURS = 24
} = require('../config/constants');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const zlib = require('zlib');
const crypto = require('crypto');
const configService = require('../services/configService');
const { PassThrough } = require('stream');
const util = require('util');
const epgStreamParser = require('../utils/epgStreamParser');

/**
 * Parses EPG XML content into structured data
 * 
 * @param {string} epgContent - EPG XML content
 * @returns {Promise<Object>} Parsed EPG data
 */
function parseEPG(epgContent) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(epgContent, (err, result) => {
            if (err) {
                logger.error('Failed to parse EPG', { error: err.message });
                return reject(err);
            }

            if (!result || !result.tv) {
                logger.error('Invalid EPG XML structure, missing tv element');
                return reject(new Error('Invalid EPG XML structure'));
            }

            const channels = result.tv.channel || [];
            const programs = result.tv.programme || [];

            logger.info(`Parsed EPG: ${channels.length} channels, ${programs.length} programs`);

            // Log some sample data to help with debugging
            if (channels.length > 0) {
                logger.debug(`First channel sample: ${JSON.stringify(channels[0]).substring(0, 500)}`);
            }

            if (programs.length > 0) {
                logger.debug(`First program sample: ${JSON.stringify(programs[0]).substring(0, 500)}`);
            }

            // Build the channel map for faster lookups
            const channelMap = {};

            // Process channels for easier matching
            channels.forEach(channel => {
                if (!channel.$ || !channel.$.id) return;

                const originalId = channel.$.id;

                // Add the original ID
                channelMap[originalId] = channel;

                // Add lowercase version
                channelMap[originalId.toLowerCase()] = channel;

                // Add snake_case version
                const snakeCase = originalId.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '');
                channelMap[snakeCase] = channel;

                // Add version without 'hd' at the end
                if (originalId.toLowerCase().endsWith('hd')) {
                    const noHdId = originalId.toLowerCase().slice(0, -2).trim();
                    channelMap[noHdId] = channel;

                    // Also add snake_case without HD
                    const snakeCaseNoHd = snakeCase.replace(/_?hd$/, '');
                    channelMap[snakeCaseNoHd] = channel;
                }

                // Add versions from display-name
                if (channel['display-name'] && Array.isArray(channel['display-name'])) {
                    channel['display-name'].forEach(name => {
                        let displayName;

                        if (typeof name === 'string') {
                            displayName = name;
                        } else if (name._ && typeof name._ === 'string') {
                            displayName = name._;
                        }

                        if (displayName) {
                            // Original display name
                            channelMap[displayName.trim()] = channel;

                            // Lowercase
                            channelMap[displayName.toLowerCase().trim()] = channel;

                            // Snake case
                            channelMap[displayName.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '')] = channel;

                            // No spaces
                            channelMap[displayName.toLowerCase().replace(/\s+/g, '')] = channel;

                            // Without HD suffix
                            if (displayName.toLowerCase().endsWith('hd')) {
                                channelMap[displayName.toLowerCase().slice(0, -2).trim()] = channel;
                            }
                        }
                    });
                }

                // Handle special formats like Travel.US.-.East.us
                if (originalId.includes('.')) {
                    // Split by dots and create simplified versions
                    const parts = originalId.split('.');
                    if (parts.length > 1) {
                        // First part only (e.g., "Travel" from "Travel.US.-.East.us")
                        channelMap[parts[0].toLowerCase()] = channel;

                        // First and second parts (e.g., "Travel.US" from "Travel.US.-.East.us")
                        if (parts.length > 1) {
                            channelMap[`${parts[0]}.${parts[1]}`.toLowerCase()] = channel;
                        }
                    }
                }
            });

            // Build a program map for faster lookup
            const programMap = {};
            programs.forEach(program => {
                if (!program.$ || !program.$.channel) return;

                const channelId = program.$.channel;
                if (!programMap[channelId]) {
                    programMap[channelId] = [];
                }
                programMap[channelId].push(program);
            });

            // Handle US channel prefixes and other common patterns
            const allKeys = Object.keys(channelMap);
            const newMappings = {};

            allKeys.forEach(key => {
                // US prefix variations
                if (key.toLowerCase().startsWith('us')) {
                    const withoutPrefix = key.replace(/^us[|\s_-]*/i, '');
                    if (withoutPrefix && withoutPrefix !== key) {
                        newMappings[withoutPrefix] = channelMap[key];

                        // Also try without HD suffix if present
                        if (withoutPrefix.toLowerCase().endsWith('hd')) {
                            const withoutHd = withoutPrefix.slice(0, -2).trim();
                            newMappings[withoutHd] = channelMap[key];
                        }
                    }
                }

                // Channel/Ch variations
                if (key.toLowerCase().includes('channel')) {
                    newMappings[key.toLowerCase().replace(/channel/g, 'ch')] = channelMap[key];
                }

                if (key.toLowerCase().includes('ch ')) {
                    newMappings[key.toLowerCase().replace(/ch(\s|$)/g, 'channel$1')] = channelMap[key];
                }
            });

            // Add the new mappings
            Object.keys(newMappings).forEach(key => {
                channelMap[key] = newMappings[key];
            });

            logger.debug(`Generated ${Object.keys(channelMap).length} channel ID mappings`);
            logger.debug(`Generated ${Object.keys(programMap).length} program channel mappings`);

            resolve({
                channels: channels,
                programs: programs,
                channelMap: channelMap,
                programMap: programMap
            });
        });
    });
}

/**
 * Search for channels across all EPG sources with improved error handling
 * 
 * @param {Object} epgSources - Collection of EPG sources
 * @param {string} searchTerm - Term to search for
 * @returns {Object} Search results grouped by source
 */
function searchChannelsAcrossSources(epgSources, searchTerm) {
    // Initialize result object
    const term = searchTerm.toLowerCase();
    const results = {
        searchTerm,
        sources: {}
    };

    // CRITICAL FIX: Ensure epgSources exists and is an object
    if (!epgSources || typeof epgSources !== 'object') {
        logger.error(`searchChannelsAcrossSources called with invalid epgSources: ${typeof epgSources}`);
        return results; // Return empty results instead of crashing
    }

    const sourceCount = Object.keys(epgSources).length;
    logger.info(`Searching for channels matching "${searchTerm}" across ${sourceCount} EPG sources`);

    // If no sources available, log and return empty results
    if (sourceCount === 0) {
        logger.warn(`No EPG sources available to search`);
        return results;
    }

    // Create search tokens from the term (handle partial matching better)
    const searchTokens = createSearchTokens(term);
    logger.info(`Created search tokens: ${searchTokens.join(', ')}`);

    // Search in each EPG source
    Object.keys(epgSources).forEach(sourceKey => {
        // Get the source and verify it exists
        const source = epgSources[sourceKey];
        if (!source) {
            logger.warn(`Source ${sourceKey} is undefined or null`);
            return; // Skip this source
        }

        // Debug log to track which sources are being processed
        logger.debug(`Searching in source: ${sourceKey}`);

        const matches = [];

        // Create a set for unique channel IDs to avoid duplicates
        const processedChannelIds = new Set();

        // First, search in all channels if available
        if (source.channels && Array.isArray(source.channels)) {
            // Debug log to confirm we're searching through channels
            logger.debug(`Source ${sourceKey} has ${source.channels.length} channels to search`);

            source.channels.forEach(channel => {
                if (!channel.$ || !channel.$.id) return;
                if (processedChannelIds.has(channel.$.id)) return;

                let isMatch = false;
                let matchType = [];
                let matchScore = 0;

                // Check channel ID against tokens
                const channelId = channel.$.id.toLowerCase();

                // Check for exact match first (highest score)
                if (channelId === term) {
                    isMatch = true;
                    matchType.push(`exact_id_match`);
                    matchScore = 1.0;  // Perfect match
                }
                // Check for partial ID matches
                else {
                    for (const token of searchTokens) {
                        if (channelId.includes(token)) {
                            isMatch = true;
                            matchType.push(`id:${token}`);
                            // Calculate token relevance (how much of the ID it matches)
                            matchScore = Math.max(matchScore, token.length / channelId.length);
                        }
                    }
                }

                // Check display names against tokens
                const displayNames = [];
                if (channel['display-name'] && Array.isArray(channel['display-name'])) {
                    channel['display-name'].forEach(name => {
                        let displayName = null;
                        let lang = null;

                        if (typeof name === 'string') {
                            displayName = name;
                        } else if (name && name._) {
                            displayName = name._;
                            lang = name.$ && name.$.lang ? name.$.lang : null;
                        }

                        if (displayName) {
                            displayNames.push({
                                name: displayName,
                                lang: lang
                            });

                            const displayNameLower = displayName.toLowerCase();

                            // Check for exact name match
                            if (displayNameLower === term) {
                                isMatch = true;
                                matchType.push(`exact_name_match`);
                                matchScore = Math.max(matchScore, 0.95);  // Almost perfect match
                            }
                            // Check for partial name matches
                            else {
                                for (const token of searchTokens) {
                                    if (displayNameLower.includes(token)) {
                                        isMatch = true;
                                        matchType.push(`display-name:${token}`);
                                        // Calculate token relevance (how much of the name it matches)
                                        matchScore = Math.max(matchScore, token.length / displayNameLower.length * 0.9);
                                    }
                                }
                            }
                        }
                    });
                }

                // Bonus for matching both ID and name
                if (matchType.some(t => t.startsWith('id:')) &&
                    matchType.some(t => t.startsWith('display-name:'))) {
                    matchScore = Math.min(1.0, matchScore + 0.1); // Cap at 1.0
                }

                // Special case for "us.XXX Network" format
                if (term.match(/^us\.[a-zA-Z]+\s+network$/i)) {
                    const networkName = term.replace(/^us\./i, '').toLowerCase();

                    // Check if channel id or name contains the network name
                    if (channelId.includes(networkName.replace(/\s+/g, '')) ||
                        displayNames.some(dn => dn.name.toLowerCase().includes(networkName))) {
                        matchScore = Math.min(1.0, matchScore + 0.2); // Significant boost
                        matchType.push(`network_name_match:${networkName}`);
                    }
                }

                // Special case for sports teams - expand to match more channels
                // More lenient matching for sports content (especially MLB)
                if (term.includes('mlb') || term.includes('baseball') || term.includes('nationals')) {
                    // Lower the threshold for sports channels
                    if (matchScore > 0.1) {  // Very lenient threshold
                        isMatch = true;
                        matchType.push(`sports_content`);
                    }
                }

                // IMPORTANT: Make matching more lenient overall
                // Consider any match with a score above a very low threshold
                if (matchScore > 0.05) {
                    isMatch = true;
                }

                if (isMatch) {
                    processedChannelIds.add(channel.$.id);

                    // Count programs for this channel
                    let programCount = 0;
                    if (source.programMap && source.programMap[channel.$.id]) {
                        programCount = source.programMap[channel.$.id].length;
                    } else if (source.programs) {
                        programCount = source.programs.filter(p => p.$ && p.$.channel === channel.$.id).length;
                    }

                    // Get channel icon if available
                    let icon = null;
                    if (channel.icon && Array.isArray(channel.icon)) {
                        channel.icon.forEach(iconObj => {
                            if (iconObj && iconObj.$) {
                                icon = iconObj.$.src;
                            }
                        });
                    }

                    matches.push({
                        id: channel.$.id,
                        displayNames,
                        matchType,
                        programCount,
                        icon,
                        sourceType: 'channel-element',
                        score: matchScore  // Store relevance score
                    });

                    logger.info(`Found match in ${sourceKey}: ${channel.$.id} (score: ${matchScore.toFixed(2)}, types: ${matchType.join(', ')})`);
                }
            });
        } else {
            // Log when a source has no channels to search
            logger.debug(`Source ${sourceKey} has no channels array or it's empty`);
        }

        // Add to results if we found matches
        if (matches.length > 0) {
            // Sort by score first, then by program count
            matches.sort((a, b) => {
                if (Math.abs(b.score - a.score) > 0.1) {
                    return b.score - a.score;  // Higher scores first
                }
                return b.programCount - a.programCount;  // More programs next
            });

            results.sources[sourceKey] = {
                matchCount: matches.length,
                matches: matches
            };
        } else {
            // Log when no matches were found in a source
            logger.debug(`No matches found in source ${sourceKey} for term "${term}"`);
        }
    });

    // Log overall results
    const totalMatches = Object.values(results.sources).reduce((sum, source) => sum + source.matchCount, 0);
    logger.info(`Found ${totalMatches} total matches across ${Object.keys(results.sources).length} sources for term "${searchTerm}"`);

    return results;
}

/**
 * Specialized search function for MLB teams
 * Uses very lenient matching to find any relevant content
 * 
 * @param {Object} epgSources - Collection of EPG sources
 * @param {string} teamName - MLB team name
 * @returns {Object} Search results
 */
function searchForMlbTeam(epgSources, teamName) {
    const results = {
        searchTerm: `MLB ${teamName}`,
        sources: {}
    };

    logger.info(`MLB team specialized search for: ${teamName}`);

    // Generate team variations
    let teamTokens = [];

    // Split into words for more flexible matching
    const words = teamName.split(/(?=[A-Z])|[\s_-]/); // Split on spaces, underscores, hyphens, and capital letters
    const city = words[0].toLowerCase();
    const mascot = words.slice(1).join(' ').toLowerCase();

    teamTokens = [
        teamName.toLowerCase(),
        city,
        mascot,
        `${city} ${mascot}`,
        `nbc ${city}`,
        `${city} sports`,
        `${mascot}`,
        `baseball ${city}`,
        `mlb ${city}`
    ];

    // Special cases for common team names
    const teamMappings = {
        'washington': ['nationals', 'nats', 'washington nationals', 'nbc washington', 'masn'],
        'losangeles': ['dodgers', 'angels', 'la', 'sportsnet'],
        'newyork': ['yankees', 'mets', 'nyy', 'nym', 'yes network'],
        'boston': ['red sox', 'nesn'],
        'chicago': ['cubs', 'white sox', 'marquee'],
        'stlouis': ['cardinals', 'cards', 'st louis', 'bally midwest'],
        // Add more as needed
    };

    // Add team-specific mappings
    for (const [key, variations] of Object.entries(teamMappings)) {
        if (teamName.toLowerCase().includes(key)) {
            teamTokens.push(...variations);
        }
    }

    logger.info(`MLB team tokens: ${teamTokens.join(', ')}`);

    // Search in each EPG source with very lenient matching
    Object.keys(epgSources).forEach(sourceKey => {
        const source = epgSources[sourceKey];
        const matches = [];
        const processedChannelIds = new Set();

        if (source.channels && Array.isArray(source.channels)) {
            source.channels.forEach(channel => {
                if (!channel.$ || !channel.$.id) return;
                if (processedChannelIds.has(channel.$.id)) return;

                let isMatch = false;
                let matchScore = 0;
                let matchReason = [];

                // Check channel ID
                const channelId = channel.$.id.toLowerCase();
                for (const token of teamTokens) {
                    if (channelId.includes(token)) {
                        isMatch = true;
                        matchScore = Math.max(matchScore, 0.7);
                        matchReason.push(`id:${token}`);
                    }
                }

                // Check display names
                if (channel['display-name'] && Array.isArray(channel['display-name'])) {
                    channel['display-name'].forEach(name => {
                        let displayName = null;

                        if (typeof name === 'string') {
                            displayName = name;
                        } else if (name && name._) {
                            displayName = name._;
                        }

                        if (displayName) {
                            const displayNameLower = displayName.toLowerCase();

                            for (const token of teamTokens) {
                                if (displayNameLower.includes(token)) {
                                    isMatch = true;
                                    matchScore = Math.max(matchScore, 0.8);
                                    matchReason.push(`name:${token}`);
                                }
                            }
                        }
                    });
                }

                // Include sports/regional networks with high score
                const sportsNetworks = ['espn', 'fox sports', 'nbc sports', 'bally', 'masn', 'nesn', 'yes', 'sportsnet', 'mlb network'];
                for (const network of sportsNetworks) {
                    if (channelId.includes(network) ||
                        (channel['display-name'] && Array.isArray(channel['display-name']) &&
                            channel['display-name'].some(n => typeof n === 'string' ?
                                n.toLowerCase().includes(network) :
                                (n && n._ && n._.toLowerCase().includes(network))))) {
                        isMatch = true;
                        matchScore = Math.max(matchScore, 0.5);
                        matchReason.push(`sports_network:${network}`);
                    }
                }

                if (isMatch) {
                    processedChannelIds.add(channel.$.id);

                    // Count programs
                    let programCount = 0;
                    if (source.programMap && source.programMap[channel.$.id]) {
                        programCount = source.programMap[channel.$.id].length;
                    }

                    // Get display names
                    const displayNames = [];
                    if (channel['display-name'] && Array.isArray(channel['display-name'])) {
                        channel['display-name'].forEach(name => {
                            let displayName = null;
                            let lang = null;

                            if (typeof name === 'string') {
                                displayName = name;
                            } else if (name && name._) {
                                displayName = name._;
                                lang = name.$ && name.$.lang ? name.$.lang : null;
                            }

                            if (displayName) {
                                displayNames.push({
                                    name: displayName,
                                    lang
                                });
                            }
                        });
                    }

                    // Get icon
                    let icon = null;
                    if (channel.icon && Array.isArray(channel.icon)) {
                        channel.icon.forEach(iconObj => {
                            if (iconObj && iconObj.$) {
                                icon = iconObj.$.src;
                            }
                        });
                    }

                    matches.push({
                        id: channel.$.id,
                        displayNames,
                        matchType: matchReason,
                        programCount,
                        icon,
                        score: matchScore
                    });

                    logger.info(`MLB search found match in ${sourceKey}: ${channel.$.id} (score: ${matchScore.toFixed(2)}, reasons: ${matchReason.join(', ')})`);
                }
            });
        }

        if (matches.length > 0) {
            // Sort by most relevant first
            matches.sort((a, b) => {
                if (Math.abs(b.score - a.score) > 0.1) {
                    return b.score - a.score;
                }
                return b.programCount - a.programCount;
            });

            results.sources[sourceKey] = {
                matchCount: matches.length,
                matches: matches
            };
        }
    });

    const totalMatches = Object.values(results.sources).reduce((sum, source) => sum + source.matchCount, 0);
    logger.info(`MLB team search found ${totalMatches} total matches across ${Object.keys(results.sources).length} sources`);

    return results;
}

/**
 * Creates search tokens from a search term for better partial matching
 * Enhanced for sports content, especially MLB teams
 * 
 * @param {string} term - Original search term
 * @returns {Array} Array of search tokens
 */
function createSearchTokens(term) {
    // Start with the original term
    const tokens = [term];

    // Remove common prefixes (US|, CA|, etc.)
    const withoutPrefix = term.replace(/^[a-z]{2}\|\s*/i, '');
    if (withoutPrefix !== term) {
        tokens.push(withoutPrefix);
    }

    // Remove HD/UHD/4K suffixes
    const withoutSuffix = term.replace(/\s+(?:hd|uhd|4k|sd)$/i, '');
    if (withoutSuffix !== term) {
        tokens.push(withoutSuffix);
    }

    // Handle MLB format variations
    if (term.toLowerCase().includes('mlb') ||
        term.toLowerCase().includes('baseball')) {

        // Convert MLB-TeamName.us to more searchable formats
        if (term.includes('-')) {
            const teamName = term.split('-')[1].split('.')[0];
            tokens.push(teamName);
            tokens.push(`mlb ${teamName}`);
            tokens.push(`baseball ${teamName}`);
        }

        // Extract team name without league prefix
        const teamName = term.toLowerCase()
            .replace(/^.*?mlb[\s-]+/i, '')
            .replace(/^.*?baseball\s+/i, '')
            .replace(/\s+(?:hd|uhd|4k|sd)$/i, '')
            .replace(/\.us$/i, '');
        tokens.push(teamName);

        // Add city name and team name separately for sports teams
        const teamParts = teamName.split(/\s+/);
        if (teamParts.length >= 2) {
            // City name (usually first part)
            tokens.push(teamParts[0]);

            // Team name (usually remaining parts)
            const mascot = teamParts.slice(1).join(' ');
            tokens.push(mascot);
        }

        // Specific handling for MLB teams with multiple name formats
        const mlbTeamVariations = {
            'washington nationals': ['nationals', 'washington', 'nats', 'washington nats'],
            'los angeles dodgers': ['dodgers', 'la dodgers', 'los angeles'],
            'new york yankees': ['yankees', 'ny yankees', 'new york', 'nyy'],
            'boston red sox': ['red sox', 'boston', 'sox'],
            // Add more team variations as needed
        };

        // Add team-specific variations if we have them
        Object.entries(mlbTeamVariations).forEach(([teamKey, variations]) => {
            if (teamName.includes(teamKey) || variations.some(v => teamName.includes(v))) {
                tokens.push(...variations);
            }
        });
    }

    // Split by spaces for individual words
    const words = term.split(/\s+/);
    tokens.push(...words.filter(word => word.length > 2));

    // Split by common separators like dashes and dots
    const parts = term.split(/[-_.]/);
    if (parts.length > 1) {
        tokens.push(...parts.filter(part => part.length > 2));
    }

    // Handle channel name formats with dots (e.g., Travel.US.-.East.us)
    if (term.includes('.')) {
        // Just get the main name part
        const mainName = term.split('.')[0];
        tokens.push(mainName);
    }

    // Remove duplicates and very short tokens
    return [...new Set(tokens)]
        .filter(token => token.length > 2)
        .map(token => token.toLowerCase());
}

/**
 * Find programs for a specific channel from a specific source
 * 
 * @param {Object} source - EPG source
 * @param {string} channelId - Channel ID
 * @returns {Object} Program data
 */
function findProgramsForSpecificChannel(source, channelId) {
    const programs = [];
    const now = new Date();
    let currentProgram = null;

    logger.info(`Finding programs for specific channel ${channelId}`);

    // Try to find channel info
    let channelInfo = null;
    if (source.channels && Array.isArray(source.channels)) {
        const channel = source.channels.find(ch => ch.$ && ch.$.id === channelId);
        if (channel) {
            // Get display names
            const displayNames = [];
            if (channel['display-name'] && Array.isArray(channel['display-name'])) {
                channel['display-name'].forEach(name => {
                    let displayName = null;
                    let lang = null;

                    if (typeof name === 'string') {
                        displayName = name;
                    } else if (name && name._) {
                        displayName = name._;
                        lang = name.$ && name.$.lang ? name.$.lang : null;
                    }

                    if (displayName) {
                        displayNames.push({
                            name: displayName,
                            lang: lang
                        });
                    }
                });
            }

            // Get icon
            let icon = null;
            if (channel.icon && Array.isArray(channel.icon)) {
                channel.icon.forEach(iconObj => {
                    if (iconObj && iconObj.$) {
                        icon = iconObj.$.src;
                    }
                });
            }

            channelInfo = {
                id: channel.$.id,
                displayNames,
                icon
            };
        }
    }

    // Get programs from program map if available
    if (source.programMap && source.programMap[channelId]) {
        logger.info(`Found ${source.programMap[channelId].length} programs in program map for channel ${channelId}`);
        processPrograms(source.programMap[channelId], programs, now);
    }
    // Otherwise search in all programs
    else if (source.programs && Array.isArray(source.programs)) {
        const channelPrograms = source.programs.filter(p => p.$ && p.$.channel === channelId);
        logger.info(`Found ${channelPrograms.length} programs by searching for channel ${channelId}`);
        processPrograms(channelPrograms, programs, now);
    }

    // Sort programs by start time
    programs.sort((a, b) => a.start - b.start);

    // Find current program
    for (const program of programs) {
        if (program.start <= now && program.stop >= now) {
            currentProgram = program;
            break;
        }
    }

    return {
        channelInfo,
        currentProgram,
        programCount: programs.length,
        programs: programs.slice(0, 24) // Return a full day of programs
    };
}

/**
 * Process programs from EPG data
 * 
 * @param {Array} programList - List of programs to process
 * @param {Array} programsArray - Array to add processed programs to
 * @param {Date} now - Current time
 */
function processPrograms(programList, programsArray, now) {
    programList.forEach(program => {
        try {
            // Make sure we have start/stop times
            if (!program.$ || !program.$.start || !program.$.stop) {
                return;
            }

            // Parse the start and stop times
            let start, stop;

            try {
                // For the format like "20250327060000 -0400"
                if (program.$.start.match(/\d{14} [+-]\d{4}/)) {
                    start = new Date(program.$.start.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}) ([+-]\d{4})/,
                        '$1-$2-$3T$4:$5:$6$7'));
                } else {
                    start = new Date(program.$.start);
                }

                if (program.$.stop.match(/\d{14} [+-]\d{4}/)) {
                    stop = new Date(program.$.stop.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}) ([+-]\d{4})/,
                        '$1-$2-$3T$4:$5:$6$7'));
                } else {
                    stop = new Date(program.$.stop);
                }
            } catch (e) {
                logger.warn(`Failed to parse program dates: ${e.message}`);
                return;
            }

            // Skip invalid dates
            if (isNaN(start.getTime()) || isNaN(stop.getTime())) {
                logger.warn(`Invalid date format: start=${program.$.start}, stop=${program.$.stop}`);
                return;
            }

            // Extract title and description
            let title = 'Unknown';
            let desc = '';
            let categories = [];
            let icon = null;

            // Get title
            if (program.title && program.title.length > 0) {
                for (const titleObj of program.title) {
                    if (typeof titleObj === 'string') {
                        title = titleObj;
                        break;
                    } else if (titleObj && titleObj._) {
                        title = titleObj._;
                        break;
                    }
                }
            }

            // Get description
            if (program.desc && program.desc.length > 0) {
                for (const descObj of program.desc) {
                    if (typeof descObj === 'string') {
                        desc = descObj;
                        break;
                    } else if (descObj && descObj._) {
                        desc = descObj._;
                        break;
                    }
                }
            }

            // Get categories
            if (program.category && Array.isArray(program.category)) {
                program.category.forEach(cat => {
                    if (typeof cat === 'string') {
                        categories.push({ name: cat });
                    } else if (cat && cat._) {
                        categories.push({
                            name: cat._,
                            lang: cat.$ && cat.$.lang ? cat.$.lang : null
                        });
                    }
                });
            }

            // Get icon
            if (program.icon && Array.isArray(program.icon)) {
                for (const iconObj of program.icon) {
                    if (iconObj && iconObj.$ && iconObj.$.src) {
                        icon = iconObj.$.src;
                        break;
                    }
                }
            }

            const programInfo = {
                start,
                stop,
                title,
                desc,
                categories,
                icon
            };

            programsArray.push(programInfo);
        } catch (e) {
            logger.error(`Error processing program: ${e.message}`, { error: e });
        }
    });
}

/**
 * Find EPG program data for a channel with improved error handling
 * 
 * @param {Object} epgSources - Collection of EPG sources
 * @param {string} channelId - Channel ID to find programs for
 * @returns {Object} Object containing program data
 */
function findProgramsForChannel(epgSources, channelId) {
    // CRITICAL FIX: Add null/undefined check
    if (!epgSources || typeof epgSources !== 'object') {
        logger.error(`findProgramsForChannel called with invalid epgSources: ${typeof epgSources}`);
        return {
            currentProgram: null,
            programs: []
        };
    }

    // Log details about the call
    logger.info(`Looking for exact channel ID: ${channelId}`);

    // Check if we're dealing with an exact ID that might be in format source.channelId
    const exactSourceMatch = channelId.match(/^([a-zA-Z0-9]+)\.(.+)$/);

    // Early exact match check - prioritize exact ID matches before fuzzy matching
    if (Object.keys(epgSources).length > 0) {
        let exactMatch = null;

        // If the channel ID has a source prefix, try to match directly in that source
        if (exactSourceMatch) {
            const [_, sourcePrefix, actualId] = exactSourceMatch;

            // Loop through all sources to find the one with a matching prefix
            Object.keys(epgSources).forEach(sourceKey => {
                // Skip if we already found an exact match
                if (exactMatch) return;

                const source = epgSources[sourceKey];
                if (!source) return; // Skip invalid sources

                const sourceKeyLower = sourceKey.toLowerCase();

                // Check if this source matches the prefix
                if (sourceKeyLower.includes(sourcePrefix.toLowerCase())) {
                    // Look for exact channel ID in this source
                    const channel = source.channels?.find(ch =>
                        ch.$ && ch.$.id && ch.$.id.toLowerCase() === actualId.toLowerCase()
                    );

                    if (channel) {
                        logger.info(`Found exact match for ${channelId} in source matching prefix ${sourcePrefix}`);
                        exactMatch = {
                            sourceKey,
                            channelId: channel.$.id
                        };
                    }
                }
            });
        }

        // If no match found yet, look for exact match in all sources
        if (!exactMatch) {
            Object.keys(epgSources).forEach(sourceKey => {
                // Skip if we already found an exact match
                if (exactMatch) return;

                const source = epgSources[sourceKey];
                if (!source) return; // Skip invalid sources

                // Check channel map for direct matches first (most efficient)
                if (source.channelMap && source.channelMap[channelId]) {
                    logger.info(`Found exact match for ${channelId} in channel map of ${sourceKey}`);
                    exactMatch = {
                        sourceKey,
                        channelId: source.channelMap[channelId].$.id
                    };
                }
                // Then check all channels as fallback
                else if (source.channels) {
                    const channel = source.channels.find(ch =>
                        ch.$ && ch.$.id && ch.$.id === channelId
                    );

                    if (channel) {
                        logger.info(`Found exact match for ${channelId} in channels of ${sourceKey}`);
                        exactMatch = {
                            sourceKey,
                            channelId: channel.$.id
                        };
                    }
                }
            });
        }

        // If we found an exact match, use it
        if (exactMatch) {
            return findProgramsForSpecificChannel(
                epgSources[exactMatch.sourceKey],
                exactMatch.channelId
            );
        }
    }

    // If we reach here, no exact match was found, proceed with fuzzy matching

    // Check if this is a direct search or looking for a known ID
    if (channelId.includes(' ') || channelId.includes('.')) {
        // This is likely a search term rather than a direct ID
        logger.info(`Treating '${channelId}' as a search term`);

        // Get search results
        const searchResults = searchChannelsAcrossSources(epgSources, channelId);
        const allMatches = [];

        // Flatten search results for processing
        Object.keys(searchResults.sources).forEach(sourceKey => {
            const source = searchResults.sources[sourceKey];
            source.matches.forEach(match => {
                allMatches.push({
                    sourceKey,
                    channelId: match.id,
                    programCount: match.programCount,
                    displayName: match.displayNames.length > 0 ? match.displayNames[0].name : match.id,
                    score: match.score || 0  // Add a score property for better ranking
                });
            });
        });

        // If no matches, return empty result
        if (allMatches.length === 0) {
            logger.warn(`No matches found for '${channelId}'`);
            return {
                currentProgram: null,
                programs: []
            };
        }

        // Sort by relevance score first, then by program count
        allMatches.sort((a, b) => {
            // If scores differ significantly, use them
            if (Math.abs(b.score - a.score) > 0.3) {
                return b.score - a.score;
            }
            // Otherwise fall back to program count
            return b.programCount - a.programCount;
        });

        // Take the best match
        const bestMatch = allMatches[0];
        logger.info(`Using best match: ${bestMatch.displayName} (${bestMatch.channelId}) from source ${bestMatch.sourceKey} with score ${bestMatch.score}`);

        // Get programs for the best match
        const programData = findProgramsForSpecificChannel(
            epgSources[bestMatch.sourceKey],
            bestMatch.channelId
        );

        // Format result for backward compatibility
        return {
            currentProgram: programData.currentProgram,
            programs: programData.programs,

            // Add new fields for more context
            channelInfo: programData.channelInfo,
            sourceKey: bestMatch.sourceKey,
            otherMatches: allMatches.slice(1).map(match => ({
                sourceKey: match.sourceKey,
                channelId: match.channelId,
                displayName: match.displayName,
                programCount: match.programCount,
                score: match.score
            }))
        };
    }
    // Direct channel ID lookup
    else {
        logger.info(`Looking for exact channel ID: ${channelId}`);

        // No EPG sources available
        if (Object.keys(epgSources).length === 0) {
            logger.warn(`No EPG sources available for channel ID: ${channelId}`);
            return {
                currentProgram: null,
                programs: []
            };
        }

        // Check each source
        const results = [];

        Object.keys(epgSources).forEach(sourceKey => {
            const source = epgSources[sourceKey];
            if (!source) return; // Skip invalid sources

            // Check if this source has the channel
            let hasExactMatch = false;

            // First check channel map (most efficient)
            if (source.channelMap && source.channelMap[channelId]) {
                hasExactMatch = true;
            }
            // Then check all channels
            else if (source.channels) {
                hasExactMatch = source.channels.some(ch => ch.$ && ch.$.id === channelId);
            }
            // Finally check program channels
            else if (source.programs) {
                hasExactMatch = source.programs.some(p => p.$ && p.$.channel === channelId);
            }

            if (hasExactMatch) {
                const programData = findProgramsForSpecificChannel(source, channelId);

                if (programData.programs.length > 0) {
                    results.push({
                        sourceKey,
                        programData,
                        isExactMatch: true,
                        score: 1.0  // Exact matches get highest score
                    });
                }
            }

            // Try alternative IDs for this channel - perform a targeted search
            // to find close matches without doing a full search
            if (!hasExactMatch && source.channelMap) {
                // Try normalized versions of the ID
                const normalizedIds = [
                    channelId.toLowerCase(),
                    channelId.toLowerCase().replace(/[^a-z0-9]/g, ''),
                    channelId.toLowerCase().replace(/\s+/g, ''),
                    channelId.toLowerCase().replace(/\s+/g, '_'),
                    // Handle special prefixes
                    channelId.toLowerCase().startsWith('us') ?
                        channelId.toLowerCase().replace(/^us[|\s_-]*/, '') : channelId.toLowerCase(),
                    // Handle .us suffix
                    channelId.toLowerCase().endsWith('.us') ?
                        channelId.toLowerCase().slice(0, -3) : channelId.toLowerCase() + '.us'
                ];

                for (const normId of normalizedIds) {
                    if (source.channelMap[normId]) {
                        const altChannelId = source.channelMap[normId].$.id;
                        const programData = findProgramsForSpecificChannel(source, altChannelId);

                        if (programData.programs.length > 0) {
                            results.push({
                                sourceKey,
                                programData,
                                isExactMatch: false,
                                score: 0.9  // High but not perfect score for normalized matches
                            });
                            break;  // Found a match, no need to try more variants
                        }
                    }
                }
            }
        });

        // No results found
        if (results.length === 0) {
            // As a last resort, try a fuzzy search
            logger.warn(`No direct matches found for channel ID: ${channelId}, trying fuzzy search`);

            // Create search tokens from the ID
            const searchTokens = channelId.split(/[._-\s]/).filter(token => token.length > 2);
            if (searchTokens.length > 0) {
                const fuzzySearchTerm = searchTokens.join(' ');
                return findProgramsForChannel(epgSources, fuzzySearchTerm);
            }

            logger.warn(`No programs found for channel ID: ${channelId}`);
            return {
                currentProgram: null,
                programs: []
            };
        }

        // Sort by exact match first, then by program count
        results.sort((a, b) => {
            if (a.isExactMatch !== b.isExactMatch) {
                return a.isExactMatch ? -1 : 1;  // Exact matches first
            }
            if (a.score !== b.score) {
                return b.score - a.score;  // Higher scores first
            }
            return b.programData.programs.length - a.programData.programs.length;  // More programs next
        });

        // Use the best match
        const bestResult = results[0];
        logger.info(`Selected best match for ${channelId} from source ${bestResult.sourceKey} (exact match: ${bestResult.isExactMatch})`);

        return {
            currentProgram: bestResult.programData.currentProgram,
            programs: bestResult.programData.programs,
            channelInfo: bestResult.programData.channelInfo,
            sourceKey: bestResult.sourceKey,
            otherMatches: results.slice(1).map(result => ({
                sourceKey: result.sourceKey,
                channelId: channelId,
                programCount: result.programData.programs.length,
                isExactMatch: result.isExactMatch,
                score: result.score
            }))
        };
    }
}

/**
 * Loads an external EPG source with efficient caching
 * 
 * @param {string} url - URL of the EPG source
 * @returns {Promise<Object|null>} Parsed EPG data or null if failed
 */
async function loadExternalEPG(url) {
    try {
        // Check cache directly first using cacheService
        const cachedData = cacheService.readEpgSourceCache(url);
        
        if (cachedData) {
            logger.info(`Using cached EPG data for ${url}`);
            return cachedData;
        }
        
        // Use loadSingleEpgSource but with a special flag to avoid recursion
        return await loadSingleEpgSource(url, { forceRefresh: true, _internal: true });
    } catch (error) {
        logger.error(`Error loading external EPG from ${url}`, { error: error.message, stack: error.stack });
        return null;
    }
}

/**
 * Load EPG data from a single source URL with improved error handling
 * @param {string} url - Source URL
 * @param {Object} options - Additional options
 * @param {boolean} [options.forceRefresh=false] - Force fresh load even if cached
 * @param {number} [options.maxChannelsToProcess=0] - Maximum channels to process (0 = unlimited)
 * @param {Function} [options.onProgress] - Progress callback
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @returns {Promise<Object>} The loaded EPG data
 */
async function loadSingleEpgSource(url, options = {}) {
    const context = { source: url };
    try {
        logger.info(`Loading EPG from source: ${url}`, context);
        logger.debug(`EPG load options: ${JSON.stringify({
            forceRefresh: options.forceRefresh,
            maxChannelsToProcess: options.maxChannelsPerSource
        })}`, context);

        // Generate a unique ID for this source
        const sourceId = createSourceId(url);
        context.sourceId = sourceId;
        
        // Ensure cache directories exist
        const cachePath = getCachePath();
        const sourceDir = path.join(cachePath, sourceId);
        
        if (!fs.existsSync(sourceDir)) {
            logger.debug(`Creating cache directory for source: ${sourceDir}`, context);
            fs.mkdirSync(sourceDir, { recursive: true });
        }
        
        // Also ensure the chunks directory exists
        const chunksDir = path.join(sourceDir, 'chunks');
        if (!fs.existsSync(chunksDir)) {
            logger.debug(`Creating chunks directory: ${chunksDir}`, context);
            fs.mkdirSync(chunksDir, { recursive: true });
        }

        // Use streaming parse for EPG loads to handle large files better
        logger.info(`Starting streaming parse of EPG source: ${url}`, context);
        const result = await streamingParseEPG(url, sourceId, options);
        
        if (!result) {
            logger.error(`Failed to load EPG from source: ${url} - No result returned`, context);
            throw new Error(`Failed to load EPG from source: ${url}`);
        }
        
        logger.info(`Successfully loaded EPG from source: ${url}`, {
            ...context,
            channelCount: result.channels ? result.channels.length : 0,
            programCount: result.totalPrograms || 0
        });
        
        return result;
    } catch (error) {
        logger.error(`Error loading EPG from source: ${url} - ${error.message}`, {
            ...context,
            error: error.stack
        });
        throw error;
    }
}

/**
 * Invalidate cache file if it's in the wrong format
 * @param {string} url - URL of the EPG source
 * @param {string} cacheFile - Path to the cache file
 */
function invalidateCache(url, cacheFile) {
    try {
        if (fs.existsSync(cacheFile)) {
            logger.info(`Invalidating cache file for ${url} due to format issues: ${cacheFile}`);
            fs.unlinkSync(cacheFile);
            
            // Also try to remove any associated directory in the chunked cache
            const urlHash = crypto.createHash('md5').update(url).digest('hex');
            const cacheDir = path.join(path.dirname(cacheFile), urlHash.replace(/[^a-z0-9]/gi, '_').toLowerCase());
            if (fs.existsSync(cacheDir) && fs.statSync(cacheDir).isDirectory()) {
                try {
                    // Remove directory and all contents
                    fs.rmSync(cacheDir, { recursive: true, force: true });
                    logger.info(`Removed associated cache directory: ${cacheDir}`);
                } catch (dirErr) {
                    logger.warn(`Could not remove cache directory ${cacheDir}: ${dirErr.message}`);
                }
            }
        }
    } catch (err) {
        logger.warn(`Error invalidating cache for ${url}: ${err.message}`);
    }
}

/**
 * Load EPG data from all configured external URLs
 * @param {Object} options - Options for loading EPG data
 * @param {boolean} [options.forceRefresh=false] - Force refresh of EPG data
 * @param {number} [options.maxChannelsPerSource=0] - Maximum channels to load per source (0 = unlimited)
 * @returns {Promise<Array>} - Array of EPG sources with data
 */
async function loadAllExternalEPGs(session = null, options = {}) {
    // Default options
    const defaultOptions = {
        forceRefresh: false,
        maxChannelsPerSource: 0 // 0 means no limit
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    logger.info(`Loading all external EPGs with options: ${JSON.stringify(mergedOptions)}`);
    
    // Get list of EPG sources from config
    let epgSources = [];
    try {
        const config = await configService.getConfig();
        epgSources = config.epgSources || [];
        
        // If no sources in config, use constants
        if (!epgSources || epgSources.length === 0) {
            const constants = require('../config/constants');
            if (constants && constants.EXTERNAL_EPG_URLS && constants.EXTERNAL_EPG_URLS.length > 0) {
                logger.info(`No EPG sources in config, using ${constants.EXTERNAL_EPG_URLS.length} sources from constants`);
                epgSources = constants.EXTERNAL_EPG_URLS;
            }
        }
    } catch (error) {
        logger.error(`Error loading EPG sources from config: ${error.message}`);
        
        // Fallback to constants
        try {
            const constants = require('../config/constants');
            if (constants && constants.EXTERNAL_EPG_URLS) {
                logger.info(`Using ${constants.EXTERNAL_EPG_URLS.length} sources from constants as fallback`);
                epgSources = constants.EXTERNAL_EPG_URLS;
            }
        } catch (fallbackError) {
            logger.error(`Failed to load fallback EPG sources: ${fallbackError.message}`);
        }
    }
    
    if (!epgSources || epgSources.length === 0) {
        logger.warn('No EPG sources configured');
        return [];
    }
    
    logger.info(`Found ${epgSources.length} EPG sources to load`);
    
    // Load each source in parallel
    const results = await Promise.all(
        epgSources.map(async (sourceUrl) => {
            try {
                logger.info(`Loading EPG data from ${sourceUrl}`);
                return await loadSingleEpgSource(sourceUrl, mergedOptions);
            } catch (error) {
                logger.error(`Failed to load EPG from ${sourceUrl}: ${error.message}`);
                return {
                    url: sourceUrl,
                    error: error.message,
                    success: false
                };
            }
        })
    );
    
    logger.info(`Completed loading all external EPGs, got ${results.length} results`);
    return results;
}

/**
 * Enhanced version of loadAllExternalEPGs with progress reporting
 * @param {Object} session - Session object for progress reporting
 * @param {Object} options - Options for loading EPG data
 * @returns {Promise<Array>} - Array of EPG sources with data
 */
async function loadAllExternalEPGsEnhanced(session = null, options = {}) {
    // Default options
    const defaultOptions = {
        forceRefresh: false,
        maxChannelsPerSource: 0, // No limit by default
        onProgress: (progress) => {
            // Default progress handler does nothing
            logger.debug(`Progress update (no handler): ${JSON.stringify(progress)}`);
        }
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    logger.info(`Loading all external EPGs (enhanced) with options: ${JSON.stringify({
        ...mergedOptions,
        onProgress: mergedOptions.onProgress ? 'Function defined' : 'No function'
    })}`);
    
    // Get list of EPG sources from config
    const { epgSources = [] } = await configService.getConfig();
    
    if (!epgSources || epgSources.length === 0) {
        logger.warn('No EPG sources configured');
        mergedOptions.onProgress({
            stage: 'complete',
            percent: 100,
            message: 'No EPG sources configured',
            details: { sources: 0 }
        });
        return [];
    }
    
    logger.info(`Found ${epgSources.length} EPG sources to load`);
    
    // Report initial progress
    mergedOptions.onProgress({
        stage: 'start',
        percent: 0,
        message: `Starting EPG load process for ${epgSources.length} sources`,
        details: {
            totalSources: epgSources.length,
            currentSource: 0
        }
    });
    
    // Load sources sequentially to avoid overwhelming the system
    const results = [];
    for (let i = 0; i < epgSources.length; i++) {
        const sourceUrl = epgSources[i];
        try {
            // Report progress for this source
            mergedOptions.onProgress({
                stage: 'loading',
                percent: Math.floor((i / epgSources.length) * 100),
                message: `Loading EPG source ${i + 1} of ${epgSources.length}: ${sourceUrl}`,
                details: {
                    totalSources: epgSources.length,
                    currentSource: i + 1,
                    sourceUrl
                }
            });
            
            logger.info(`Loading EPG data from ${sourceUrl} (${i + 1}/${epgSources.length})`);
            
            // Create a progress handler for this specific source
            const sourceProgressHandler = (progress) => {
                // Adjust the overall percent to fit within this source's allotment
                const sourcePercent = progress.percent || 0;
                const overallPercent = Math.floor((i + sourcePercent / 100) / epgSources.length * 100);
                
                mergedOptions.onProgress({
                    stage: progress.stage || 'loading',
                    percent: overallPercent,
                    message: progress.message || `Processing source ${i + 1}/${epgSources.length}`,
                    details: {
                        ...progress.details,
                        currentSource: i + 1,
                        totalSources: epgSources.length,
                        sourceUrl,
                        sourcePercent
                    }
                });
            };
            
            // Load this source with progress reporting
            const result = await loadSingleEpgSource(sourceUrl, {
                ...mergedOptions,
                onProgress: sourceProgressHandler
            });
            
            results.push(result);
        } catch (error) {
            logger.error(`Failed to load EPG from ${sourceUrl}: ${error.message}`);
            results.push({
                url: sourceUrl,
                error: error.message,
                success: false
            });
            
            // Report error but continue with other sources
            mergedOptions.onProgress({
                stage: 'error',
                percent: Math.floor((i / epgSources.length) * 100),
                message: `Error loading source ${i + 1}/${epgSources.length}: ${error.message}`,
                details: {
                    error: error.message,
                    sourceUrl,
                    currentSource: i + 1,
                    totalSources: epgSources.length
                }
            });
        }
    }
    
    // Report final progress
    mergedOptions.onProgress({
        stage: 'complete',
        percent: 100,
        message: `Completed loading ${results.length} EPG sources`,
        details: {
            totalSources: epgSources.length,
            completedSources: results.length,
            successCount: results.filter(r => r.success).length
        }
    });
    
    logger.info(`Completed loading all external EPGs (enhanced), got ${results.length} results`);
    return results;
}

/**
 * Load EPG data from an Xtream API source
 * @param {string} baseUrl - Base URL of the Xtream API
 * @param {string} username - Xtream API username
 * @param {string} password - Xtream API password
 * @param {Object} options - Options for loading EPG data
 * @returns {Promise<Object>} - Object containing EPG data
 */
async function loadXtreamEPG(baseUrl, username, password, options = {}) {
    const defaultOptions = {
        forceRefresh: false,
        maxChannelsToProcess: 0, // No limit by default
        onProgress: (progress) => {
            logger.debug(`XtreamEPG Progress: ${JSON.stringify(progress)}`);
        }
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    logger.info(`Loading Xtream EPG from ${baseUrl} with options: ${JSON.stringify({
        ...mergedOptions,
        onProgress: mergedOptions.onProgress ? 'Function defined' : 'No function',
        password: '********' // Don't log the actual password
    })}`);
    
    try {
        // Normalize the base URL to ensure it has a trailing slash
        const normalizedUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        
        // Create a unique identifier for this Xtream source for caching
        const sourceId = `xtream_${Buffer.from(`${normalizedUrl}_${username}_${password}`).toString('base64')}`;
        
        // Check for existing cache
        const cacheFile = path.join(__dirname, '../cache', `${sourceId.replace(/[\/\\?%*:|"<>]/g, '_')}_channels.json`);
        
        if (!mergedOptions.forceRefresh && fs.existsSync(cacheFile)) {
            try {
                const cacheStats = fs.statSync(cacheFile);
                const cacheAge = Date.now() - cacheStats.mtimeMs;
                const cacheTtlMs = 24 * 60 * 60 * 1000; // 24 hours
                
                if (cacheAge < cacheTtlMs) {
                    logger.info(`Using cached Xtream data from ${cacheFile}, age: ${Math.round(cacheAge / 1000 / 60)} minutes`);
                    
                    mergedOptions.onProgress({
                        stage: 'cache',
                        percent: 10,
                        message: 'Found cached Xtream data',
                        details: {
                            cacheFile,
                            cacheAge: Math.round(cacheAge / 1000 / 60)
                        }
                    });
                    
                    // Read cached data
                    const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                    
                    mergedOptions.onProgress({
                        stage: 'complete',
                        percent: 100,
                        message: `Loaded ${cachedData.length} channels from Xtream cache`,
                        details: {
                            channelCount: cachedData.length,
                            fromCache: true
                        }
                    });
                    
                    return {
                        url: `${normalizedUrl}`,
                        channels: cachedData,
                        lastUpdated: new Date(cacheStats.mtimeMs).toISOString(),
                        fromCache: true,
                        success: true
                    };
                }
                
                logger.info(`Cached Xtream data expired (${Math.round(cacheAge / 1000 / 60)} minutes old)`);
            } catch (cacheError) {
                logger.warn(`Error reading Xtream cache: ${cacheError.message}, will fetch fresh data`);
            }
        }
        
        // Report progress
        mergedOptions.onProgress({
            stage: 'connecting',
            percent: 15,
            message: 'Connecting to Xtream API',
            details: {
                baseUrl: normalizedUrl
            }
        });
        
        // Fetch channels from Xtream API
        const apiUrl = `${normalizedUrl}player_api.php?username=${username}&password=${password}&action=get_live_streams`;
        logger.info(`Fetching channels from Xtream API: ${apiUrl}`);
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'EPG-Matcher/1.0'
            },
            timeout: 30000 // 30 second timeout
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }
        
        // Parse JSON response
        const channelsData = await response.json();
        
        if (!Array.isArray(channelsData)) {
            throw new Error('Invalid response format from Xtream API, expected array');
        }
        
        mergedOptions.onProgress({
            stage: 'processing',
            percent: 50,
            message: `Processing ${channelsData.length} channels from Xtream API`,
            details: {
                rawChannelCount: channelsData.length
            }
        });
        
        // Process channel data into our format
        const channels = channelsData.map(channel => ({
            id: `xtream_${channel.stream_id}`,
            name: channel.name || `Channel ${channel.stream_id}`,
            logo: channel.stream_icon || null,
            group: channel.category_name || 'Uncategorized',
            url: `${normalizedUrl}${channel.stream_type}/${username}/${password}/${channel.stream_id}`,
            epgChannelId: channel.epg_channel_id || null,
            streamType: channel.stream_type || 'live',
            added: channel.added || new Date().toISOString(),
            categoryId: channel.category_id || 0,
            customSid: channel.custom_sid || null,
            tvArchive: channel.tv_archive || 0,
            directSource: channel.direct_source || null,
            tvArchiveDuration: channel.tv_archive_duration || 0
        }));
        
        // Apply channel limit if specified
        let filteredChannels = channels;
        if (mergedOptions.maxChannelsToProcess > 0 && channels.length > mergedOptions.maxChannelsToProcess) {
            logger.warn(`Limiting Xtream channels to ${mergedOptions.maxChannelsToProcess} (from ${channels.length})`);
            filteredChannels = channels.slice(0, mergedOptions.maxChannelsToProcess);
            
            mergedOptions.onProgress({
                stage: 'limiting',
                percent: 70,
                message: `Limiting to ${mergedOptions.maxChannelsToProcess} channels`,
                details: {
                    originalCount: channels.length,
                    limitedCount: filteredChannels.length,
                    limit: mergedOptions.maxChannelsToProcess
                }
            });
        }
        
        // Remove duplicate channels by checking for unique IDs
        const uniqueChannels = [];
        const seenIds = new Set();
        for (const channel of filteredChannels) {
            if (!seenIds.has(channel.id)) {
                uniqueChannels.push(channel);
                seenIds.add(channel.id);
            }
        }
        
        logger.info(`Filtered ${channels.length} M3U entries to ${uniqueChannels.length} unique channels`);
        
        // Cache the channels to disk
        try {
            fs.writeFileSync(cacheFile, JSON.stringify(uniqueChannels, null, 2));
            logger.info(`Saved ${uniqueChannels.length} channels to cache: ${cacheFile}`);
        } catch (writeError) {
            logger.error(`Failed to write Xtream cache: ${writeError.message}`);
        }
        
        mergedOptions.onProgress({
            stage: 'complete',
            percent: 100,
            message: `Successfully parsed ${uniqueChannels.length} channels from Xtream`,
            details: {
                channelCount: uniqueChannels.length,
                fromCache: false
            }
        });
        
        return {
            url: `${normalizedUrl}`,
            channels: uniqueChannels,
            lastUpdated: new Date().toISOString(),
            fromCache: false,
            success: true
        };
    } catch (error) {
        logger.error(`Error loading Xtream EPG: ${error.message}`);
        
        mergedOptions.onProgress({
            stage: 'error',
            percent: 0,
            message: `Error: ${error.message}`,
            details: {
                error: error.message,
                baseUrl
            }
        });
        
        return {
            url: baseUrl,
            error: error.message,
            channels: [],
            success: false
        };
    }
}

/**
 * Create a test EPG source with random data for development purposes
 * @param {number} channelCount - Number of test channels to create
 * @param {Object} options - Options for creating test data
 * @returns {Object} - Object containing test EPG data
 */
function createTestEpgSource(channelCount = 50, options = {}) {
    const channels = [];
    const genres = ['News', 'Sports', 'Entertainment', 'Movies', 'Kids', 'Music', 'Documentary', 'Science', 'Lifestyle'];
    const countries = ['US', 'UK', 'CA', 'AU', 'DE', 'FR', 'JP', 'BR', 'ES', 'IT'];
    
    logger.info(`Creating test EPG source with ${channelCount} channels`);
    
    // Create random channels
    for (let i = 0; i < channelCount; i++) {
        const channelId = `test_channel_${i + 1}`;
        const genre = genres[Math.floor(Math.random() * genres.length)];
        const country = countries[Math.floor(Math.random() * countries.length)];
        
        channels.push({
            id: channelId,
            name: `Test Channel ${i + 1}`,
            logo: `https://via.placeholder.com/150?text=Ch${i+1}`,
            group: genre,
            url: `#test_channel_${i + 1}`,
            epgChannelId: channelId,
            country: country,
            language: 'English',
            categories: [genre],
            programs: generateTestPrograms(channelId, 24) // 24 hours of test programs
        });
    }
    
    return {
        url: 'test://epg.source',
        name: 'Test EPG Source',
        description: 'Generated test data for development',
        channels: channels,
        lastUpdated: new Date().toISOString(),
        fromCache: false,
        success: true
    };
}

/**
 * Generate test program data for a channel
 * @private
 * @param {string} channelId - Channel ID to generate programs for
 * @param {number} hours - Number of hours of programming to generate
 * @returns {Array} - Array of program objects
 */
function generateTestPrograms(channelId, hours) {
    const programs = [];
    const now = new Date();
    const startTime = new Date(now);
    startTime.setHours(0, 0, 0, 0); // Start at beginning of day
    
    const programTitles = [
        'Morning News', 'Documentary', 'Movie: Action Heroes', 
        'Cooking Show', 'Science Hour', 'Sports Highlights',
        'Kids Cartoon', 'Evening News', 'Late Night Show',
        'Weather Update', 'Reality TV', 'Music Videos',
        'Nature Documentary', 'History Special', 'Comedy Hour'
    ];
    
    // Standard program durations in minutes
    const durations = [30, 60, 90, 120];
    
    let currentTime = new Date(startTime);
    const endDay = new Date(startTime);
    endDay.setHours(endDay.getHours() + hours);
    
    while (currentTime < endDay) {
        // Get random program details
        const titleIndex = Math.floor(Math.random() * programTitles.length);
        const durationIndex = Math.floor(Math.random() * durations.length);
        const duration = durations[durationIndex]; // in minutes
        
        const startTimeStr = currentTime.toISOString();
        const endTime = new Date(currentTime);
        endTime.setMinutes(endTime.getMinutes() + duration);
        const endTimeStr = endTime.toISOString();
        
        // Create program object
        programs.push({
            id: `${channelId}_prog_${programs.length + 1}`,
            title: programTitles[titleIndex],
            start: startTimeStr,
            stop: endTimeStr,
            description: `This is a test program description for ${programTitles[titleIndex]}`,
            category: getRandomCategory(),
            rating: Math.floor(Math.random() * 5) + 1,
            length: duration * 60, // length in seconds
            channelId: channelId
        });
        
        // Move current time forward
        currentTime = new Date(endTime);
    }
    
    return programs;
}

/**
 * Get a random program category for test data
 * @private
 * @returns {string} - Random category name
 */
function getRandomCategory() {
    const categories = [
        'News', 'Documentary', 'Movie', 'Series', 'Sports', 
        'Kids', 'Music', 'Arts', 'Education', 'Entertainment'
    ];
    return categories[Math.floor(Math.random() * categories.length)];
}

/**
 * Generate a summary of all EPG data in the system
 * @param {Array} epgSources - Array of EPG source objects
 * @returns {Object} - Summary statistics of EPG data
 */
function generateEpgSummary(epgSources = []) {
    logger.info(`Generating EPG summary for ${epgSources.length} sources`);
    
    // Initialize summary object
    const summary = {
        totalSources: epgSources.length,
        totalChannels: 0,
        totalPrograms: 0,
        categories: {},
        countries: {},
        languages: {},
        channelsPerSource: {},
        programsPerSource: {},
        sourcesWithMostChannels: [],
        channelsWithMostPrograms: [],
        programTimespan: {
            earliest: null,
            latest: null,
            daysSpan: 0
        }
    };
    
    // Track the earliest and latest program dates across all sources
    let earliestDate = null;
    let latestDate = null;
    
    // Process each source
    epgSources.forEach(source => {
        if (!source || !source.channels) {
            return; // Skip invalid sources
        }
        
        const sourceId = source.url || 'unknown';
        const channelCount = source.channels.length || 0;
        summary.totalChannels += channelCount;
        summary.channelsPerSource[sourceId] = channelCount;
        
        let programCount = 0;
        
        // Process each channel in the source
        source.channels.forEach(channel => {
            if (!channel) return;
            
            // Count programs
            const channelPrograms = channel.programs || [];
            programCount += channelPrograms.length;
            
            // Track channel with program count
            if (channelPrograms.length > 0) {
                summary.channelsWithMostPrograms.push({
                    channelId: channel.id,
                    channelName: channel.name || channel.id,
                    sourceUrl: sourceId,
                    programCount: channelPrograms.length
                });
            }
            
            // Process each program for date range
            channelPrograms.forEach(program => {
                if (!program) return;
                
                // Track program timespan
                if (program.start) {
                    const startDate = new Date(program.start);
                    if (!isNaN(startDate.getTime())) {
                        if (!earliestDate || startDate < earliestDate) {
                            earliestDate = startDate;
                        }
                    }
                }
                
                if (program.stop) {
                    const endDate = new Date(program.stop);
                    if (!isNaN(endDate.getTime())) {
                        if (!latestDate || endDate > latestDate) {
                            latestDate = endDate;
                        }
                    }
                }
                
                // Count categories
                if (program.category) {
                    const category = program.category;
                    summary.categories[category] = (summary.categories[category] || 0) + 1;
                }
            });
            
            // Count channel metadata
            if (channel.country) {
                const country = channel.country;
                summary.countries[country] = (summary.countries[country] || 0) + 1;
            }
            
            if (channel.language) {
                const language = channel.language;
                summary.languages[language] = (summary.languages[language] || 0) + 1;
            }
            
            // Count categories from channel
            if (channel.categories && Array.isArray(channel.categories)) {
                channel.categories.forEach(category => {
                    if (category) {
                        summary.categories[category] = (summary.categories[category] || 0) + 1;
                    }
                });
            }
        });
        
        // Add program count for this source
        summary.programsPerSource[sourceId] = programCount;
        summary.totalPrograms += programCount;
        
        // Track source with channel count
        summary.sourcesWithMostChannels.push({
            url: sourceId,
            name: source.name || sourceId,
            channelCount: channelCount,
            programCount: programCount
        });
    });
    
    // Calculate program timespan
    if (earliestDate && latestDate) {
        summary.programTimespan.earliest = earliestDate.toISOString();
        summary.programTimespan.latest = latestDate.toISOString();
        
        // Calculate days span
        const timeDiff = latestDate.getTime() - earliestDate.getTime();
        summary.programTimespan.daysSpan = Math.ceil(timeDiff / (1000 * 3600 * 24));
    }
    
    // Sort results
    summary.sourcesWithMostChannels.sort((a, b) => b.channelCount - a.channelCount);
    summary.channelsWithMostPrograms.sort((a, b) => b.programCount - a.programCount);
    
    // Limit the arrays to top 10
    summary.sourcesWithMostChannels = summary.sourcesWithMostChannels.slice(0, 10);
    summary.channelsWithMostPrograms = summary.channelsWithMostPrograms.slice(0, 10);
    
    // Convert categories, countries, languages to sorted arrays
    summary.categoriesList = Object.entries(summary.categories)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20); // Top 20 categories
    
    summary.countriesList = Object.entries(summary.countries)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20); // Top 20 countries
    
    summary.languagesList = Object.entries(summary.languages)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20); // Top 20 languages
    
    logger.info(`EPG summary generated: ${summary.totalSources} sources, ${summary.totalChannels} channels, ${summary.totalPrograms} programs`);
    
    return summary;
}

/**
 * Search for programs across all EPG sources matching a search term
 * @param {Array} epgSources - Array of EPG sources to search
 * @param {string} searchTerm - The search term to look for
 * @param {Object} options - Search options
 * @param {number} [options.limit=100] - Maximum number of results to return
 * @param {boolean} [options.includeFuture=true] - Whether to include future programs
 * @param {boolean} [options.includePast=false] - Whether to include past programs
 * @returns {Array} - Array of matching programs with channel info
 */
function searchEpg(epgSources, searchTerm, options = {}) {
    const defaultOptions = {
        limit: 100,
        includeFuture: true,
        includePast: false,
        categoryFilter: null,
        channelFilter: null
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    logger.info(`Searching EPG for '${searchTerm}' with options: ${JSON.stringify(mergedOptions)}`);
    
    if (!searchTerm || searchTerm.trim().length === 0) {
        logger.warn('Empty search term provided for EPG search');
        return [];
    }
    
    if (!epgSources || !Array.isArray(epgSources) || epgSources.length === 0) {
        logger.warn('No EPG sources provided for search');
        return [];
    }
    
    // Create search tokens for the term
    const searchTokens = createSearchTokens(searchTerm);
    const now = new Date();
    const results = [];
    
    // Search through all sources and their channels
    for (const source of epgSources) {
        if (!source || !source.channels || !Array.isArray(source.channels)) {
            continue;
        }
        
        // Iterate through each channel in the source
        for (const channel of source.channels) {
            // Handle case where channel has no programs array
            if (!channel) continue;
            
            // Check if channel name matches search term - add channel-level match
            const channelName = channel.name || channel.id || '';
            const channelNameTokens = createSearchTokens(channelName);
            const channelMatches = searchTokens.some(token => 
                channelNameTokens.includes(token) || 
                channelName.toLowerCase().includes(token)
            );
            
            if (channelMatches) {
                results.push({
                    channelId: channel.id || 'unknown',
                    channelName: channelName,
                    channelLogo: channel.icon || channel.logo || null,
                    sourceUrl: source.url || 'unknown',
                    sourceName: source.name || source.url || 'Unknown Source',
                    title: `Channel: ${channelName}`,
                    category: 'Channel',
                    isChannel: true,
                    highlight: searchTerm
                });
                
                // Check if we've reached the limit
                if (results.length >= mergedOptions.limit) {
                    logger.info(`EPG search limit of ${mergedOptions.limit} reached`);
                    return results;
                }
            }
            
            // Skip program search if no programs array
            if (!channel.programs || !Array.isArray(channel.programs)) {
                continue;
            }
            
            // Apply channel filter if specified
            if (mergedOptions.channelFilter && 
                channel.id !== mergedOptions.channelFilter &&
                channel.name !== mergedOptions.channelFilter) {
                continue;
            }
            
            // Iterate through each program in the channel
            for (const program of channel.programs) {
                if (!program || !program.title) {
                    continue;
                }
                
                // Check program time criteria
                const startTime = program.start ? new Date(program.start) : null;
                const endTime = program.stop ? new Date(program.stop) : null;
                
                if (startTime) {
                    // Skip past programs if not including past
                    if (!mergedOptions.includePast && endTime && endTime < now) {
                        continue;
                    }
                    
                    // Skip future programs if not including future
                    if (!mergedOptions.includeFuture && startTime > now) {
                        continue;
                    }
                }
                
                // Apply category filter if specified
                if (mergedOptions.categoryFilter && 
                    program.category !== mergedOptions.categoryFilter) {
                    continue;
                }
                
                // Check if program matches the search term
                let matches = false;
                
                // Check program title
                const titleTokens = createSearchTokens(program.title);
                if (searchTokens.some(token => titleTokens.includes(token))) {
                    matches = true;
                }
                
                // Check program description if not matched by title
                if (!matches && program.description) {
                    const descTokens = createSearchTokens(program.description);
                    if (searchTokens.some(token => descTokens.includes(token))) {
                        matches = true;
                    }
                }
                
                // Add to results if matched
                if (matches) {
                    results.push({
                        channelId: channel.id,
                        channelName: channel.name || channel.id,
                        channelLogo: channel.icon || channel.logo || null,
                        sourceUrl: source.url || 'unknown',
                        sourceName: source.name || source.url || 'Unknown Source',
                        program: {
                            ...program,
                            channelId: channel.id
                        }
                    });
                    
                    // Check if we've reached the limit
                    if (results.length >= mergedOptions.limit) {
                        logger.info(`EPG search limit of ${mergedOptions.limit} reached`);
                        return results;
                    }
                }
            }
        }
    }
    
    // Sort results by start time
    results.sort((a, b) => {
        // First sort channels to the top
        if (a.isChannel && !b.isChannel) return -1;
        if (!a.isChannel && b.isChannel) return 1;
        
        // For programs, sort by start time
        if (!a.program || !a.program.start) return 1;
        if (!b.program || !b.program.start) return -1;
        
        const aStart = new Date(a.program.start);
        const bStart = new Date(b.program.start);
        
        return aStart - bStart;
    });
    
    logger.info(`EPG search for '${searchTerm}' returned ${results.length} results`);
    return results;
}

/**
 * Create search tokens from a search term
 * @param {string} term - The search term to tokenize
 * @returns {Array} - Array of normalized search tokens
 */
function createSearchTokens(term) {
    if (!term || typeof term !== 'string') {
        return [];
    }
    
    // Convert to lowercase and remove special characters
    const normalized = term.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Split into tokens and filter out short tokens
    return normalized.split(' ')
        .filter(token => token.length > 1)
        .map(token => token.trim());
}

/**
 * Search for MLB team games in EPG data
 * @param {Array} epgSources - Array of EPG sources to search
 * @param {string} teamName - MLB team name to search for
 * @param {Object} options - Search options
 * @returns {Array} - Array of matching programs with channel info
 */
function searchForMlbTeam(epgSources, teamName, options = {}) {
    const defaultOptions = {
        limit: 100,
        includeFuture: true,
        includePast: false,
        daysAhead: 7,
        daysBehind: 1
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    logger.info(`Searching for MLB team "${teamName}" with options: ${JSON.stringify(mergedOptions)}`);
    
    if (!teamName || teamName.trim().length === 0) {
        logger.warn('Empty team name provided for MLB team search');
        return [];
    }
    
    if (!epgSources || !Array.isArray(epgSources) || epgSources.length === 0) {
        logger.warn('No EPG sources provided for MLB team search');
        return [];
    }
    
    // Normalize team name and create search patterns
    const normalizedTeamName = teamName.toLowerCase().trim();
    
    // MLB team nicknames and alternative names
    const mlbTeams = {
        'yankees': ['ny yankees', 'new york yankees', 'nyy'],
        'red sox': ['boston red sox', 'bos'],
        'rays': ['tampa bay rays', 'tampa bay', 'tb rays', 'tb'],
        'blue jays': ['toronto blue jays', 'tor', 'toronto'],
        'orioles': ['baltimore orioles', 'bal', 'baltimore'],
        'guardians': ['cleveland guardians', 'cleveland', 'cle'],
        'tigers': ['detroit tigers', 'detroit', 'det'],
        'royals': ['kansas city royals', 'kansas city', 'kc'],
        'twins': ['minnesota twins', 'minnesota', 'min'],
        'white sox': ['chicago white sox', 'chw', 'chi white sox'],
        'astros': ['houston astros', 'houston', 'hou'],
        'angels': ['los angeles angels', 'la angels', 'laa'],
        'athletics': ['oakland athletics', 'oakland', 'oak', 'a\'s'],
        'mariners': ['seattle mariners', 'seattle', 'sea'],
        'rangers': ['texas rangers', 'texas', 'tex'],
        'braves': ['atlanta braves', 'atlanta', 'atl'],
        'marlins': ['miami marlins', 'miami', 'mia'],
        'mets': ['new york mets', 'ny mets', 'nym'],
        'phillies': ['philadelphia phillies', 'philadelphia', 'phi'],
        'nationals': ['washington nationals', 'washington', 'wsh', 'was'],
        'cubs': ['chicago cubs', 'chc', 'chi cubs'],
        'reds': ['cincinnati reds', 'cincinnati', 'cin'],
        'brewers': ['milwaukee brewers', 'milwaukee', 'mil'],
        'pirates': ['pittsburgh pirates', 'pittsburgh', 'pit'],
        'cardinals': ['st louis cardinals', 'st. louis cardinals', 'st louis', 'stl'],
        'diamondbacks': ['arizona diamondbacks', 'arizona', 'ari', 'd-backs', 'dbacks'],
        'rockies': ['colorado rockies', 'colorado', 'col'],
        'dodgers': ['los angeles dodgers', 'la dodgers', 'lad'],
        'padres': ['san diego padres', 'san diego', 'sd'],
        'giants': ['san francisco giants', 'san francisco', 'sf']
    };
    
    // Find which MLB team we're searching for
    let targetTeam = null;
    let teamVariations = [];
    
    // Check if the normalized team name is a key in mlbTeams
    if (mlbTeams[normalizedTeamName]) {
        targetTeam = normalizedTeamName;
        teamVariations = [normalizedTeamName, ...mlbTeams[normalizedTeamName]];
    } else {
        // Check if the normalized team name is in any of the team variations
        for (const [team, variations] of Object.entries(mlbTeams)) {
            if (variations.includes(normalizedTeamName)) {
                targetTeam = team;
                teamVariations = [team, ...variations];
                break;
            }
        }
    }
    
    // If we didn't find a match to a known MLB team, still try to search for the term
    if (!targetTeam) {
        logger.warn(`Unknown MLB team "${teamName}", will search for exact term`);
        teamVariations = [normalizedTeamName];
    } else {
        logger.info(`Identified "${teamName}" as MLB team "${targetTeam}"`);
    }
    
    // Set up date ranges
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(now.getDate() + mergedOptions.daysAhead);
    
    const pastDate = new Date();
    pastDate.setDate(now.getDate() - mergedOptions.daysBehind);
    
    const results = [];
    
    // Search for MLB games in the EPG data
    for (const source of epgSources) {
        if (!source || !source.channels || !Array.isArray(source.channels)) {
            continue;
        }
        
        for (const channel of source.channels) {
            if (!channel || !channel.programs || !Array.isArray(channel.programs)) {
                continue;
            }
            
            for (const program of channel.programs) {
                if (!program || !program.title) {
                    continue;
                }
                
                // Check program time criteria
                const startTime = program.start ? new Date(program.start) : null;
                const endTime = program.stop ? new Date(program.stop) : null;
                
                if (startTime) {
                    // Skip past programs if not including past
                    if (!mergedOptions.includePast && endTime && endTime < pastDate) {
                        continue;
                    }
                    
                    // Skip future programs if not including future
                    if (!mergedOptions.includeFuture && startTime > futureDate) {
                        continue;
                    }
                }
                
                // Check if it's a baseball/MLB program
                const isMlbProgram = isMlbProgramTitle(program.title);
                if (!isMlbProgram) {
                    continue;
                }
                
                // Check if the program contains our team name
                const programTitle = program.title.toLowerCase();
                const programDesc = program.description ? program.description.toLowerCase() : '';
                
                let teamMatch = false;
                for (const variation of teamVariations) {
                    if (programTitle.includes(variation) || programDesc.includes(variation)) {
                        teamMatch = true;
                        break;
                    }
                }
                
                if (teamMatch) {
                    results.push({
                        channelId: channel.id,
                        channelName: channel.name || channel.id,
                        channelLogo: channel.logo || null,
                        sourceUrl: source.url || 'unknown',
                        sourceName: source.name || source.url || 'Unknown Source',
                        program: {
                            ...program,
                            channelId: channel.id
                        }
                    });
                    
                    // Check if we've reached the limit
                    if (results.length >= mergedOptions.limit) {
                        logger.info(`MLB team search limit of ${mergedOptions.limit} reached`);
                        break;
                    }
                }
            }
            
            if (results.length >= mergedOptions.limit) {
                break;
            }
        }
        
        if (results.length >= mergedOptions.limit) {
            break;
        }
    }
    
    // Sort results by start time
    results.sort((a, b) => {
        if (!a.program.start) return 1;
        if (!b.program.start) return -1;
        
        const aStart = new Date(a.program.start);
        const bStart = new Date(b.program.start);
        
        return aStart - bStart;
    });
    
    logger.info(`MLB team search for "${teamName}" returned ${results.length} results`);
    return results;
}

/**
 * Check if a program title appears to be an MLB broadcast
 * @private
 * @param {string} title - Program title to check
 * @returns {boolean} - Whether the title appears to be an MLB broadcast
 */
function isMlbProgramTitle(title) {
    if (!title) return false;
    
    const lowerTitle = title.toLowerCase();
    
    // Keywords indicating baseball broadcasts
    const baseballKeywords = [
        'mlb', 'baseball', 'major league baseball',
        'world series', 'playoffs', 'alds', 'alcs', 'nlds', 'nlcs',
        'all-star game', 'all star game',
        'spring training', 'wild card'
    ];
    
    // Check for these keywords
    for (const keyword of baseballKeywords) {
        if (lowerTitle.includes(keyword)) {
            return true;
        }
    }
    
    // Check for common game patterns like "Team vs Team" or "Team at Team"
    const gamePatterns = [' vs ', ' vs. ', ' at ', ' @ '];
    if (gamePatterns.some(pattern => lowerTitle.includes(pattern))) {
        return true;
    }
    
    return false;
}

/**
 * Load EPG data from a single source URL
 * @param {string} url - URL of the EPG source
 * @param {Object} options - Loading options
 * @param {boolean} [options.forceRefresh=false] - Force refresh of EPG data
 * @param {number} [options.maxChannelsToProcess=0] - Maximum channels to process (0 = unlimited)
 * @param {Function} [options.onProgress] - Progress callback function
 * @returns {Promise<Object>} - Object containing EPG data
 */
async function loadSingleEpgSource(url, options = {}) {
    // Default options
    const defaultOptions = {
        forceRefresh: false,
        maxChannelsToProcess: 0, // 0 means no limit
        onProgress: (progress) => {
            logger.debug(`Progress update: ${JSON.stringify(progress)}`);
        }
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    logger.info(`Loading EPG data from ${url} with options: ${JSON.stringify({
        ...mergedOptions,
        onProgress: mergedOptions.onProgress ? 'Function defined' : 'No function'
    })}`);
    
    try {
        // Progress reporting
        mergedOptions.onProgress({
            stage: 'start',
            percent: 0,
            message: `Starting EPG load from ${url}`,
            details: { url }
        });
        
        // Special handling for Xtream API URLs
        if (url.includes('/player_api.php') || url.match(/https?:\/\/[^\/]+\/c\//) || url.includes('username=') && url.includes('password=')) {
            logger.info(`Detected Xtream API URL: ${url}`);
            mergedOptions.onProgress({
                stage: 'detect',
                percent: 5,
                message: 'Detected Xtream API URL',
                details: { url, type: 'xtream' }
            });
            
            // Extract username and password from the URL if present
            let username = '';
            let password = '';
            let baseUrl = '';
            
            if (url.includes('username=') && url.includes('password=')) {
                // Extract from query parameters
                const urlObj = new URL(url);
                username = urlObj.searchParams.get('username') || '';
                password = urlObj.searchParams.get('password') || '';
                
                // Remove username and password from the URL for the base URL
                urlObj.searchParams.delete('username');
                urlObj.searchParams.delete('password');
                baseUrl = urlObj.origin + urlObj.pathname;
            } else if (url.match(/https?:\/\/[^\/]+\/c\//)) {
                // Extract from URL path format: http://domain.com/c/username/password/...
                const parts = url.split('/');
                const domainIndex = parts.findIndex(part => part.includes(':'));
                if (domainIndex > 0 && parts.length > domainIndex + 3) {
                    username = parts[domainIndex + 2];
                    password = parts[domainIndex + 3];
                    baseUrl = parts.slice(0, domainIndex + 2).join('/');
                }
            }
            
            if (username && password && baseUrl) {
                logger.info(`Loading Xtream EPG with credentials from ${baseUrl}`);
                return loadXtreamEPG(baseUrl, username, password, mergedOptions);
            } else {
                logger.warn(`Could not extract Xtream credentials from URL: ${url}`);
            }
        }
        
        // For test purposes, if URL is 'test://epg', return test data
        if (url === 'test://epg') {
            logger.info('Generating test EPG data');
            mergedOptions.onProgress({
                stage: 'complete',
                percent: 100,
                message: 'Generated test EPG data',
                details: { type: 'test' }
            });
            return createTestEpgSource(100, mergedOptions);
        }
        
        // Create a unique ID for this source based on URL
        const sourceId = crypto.createHash('md5').update(url).digest('hex');
        
        // Define cache locations
        const cachePath = path.join(__dirname, '../cache');
        const chunkPath = path.join(cachePath, sourceId.replace(/[^a-z0-9]/gi, '_').toLowerCase());
        
        // Ensure cache directories exist
        if (!fs.existsSync(cachePath)) {
            logger.info(`Creating EPG cache directory: ${cachePath}`);
            fs.mkdirSync(cachePath, { recursive: true });
        }
        
        // Check for cached EPG data that's still valid
        if (!mergedOptions.forceRefresh) {
            try {
                // Check for metadata cache file
                const metadataFile = path.join(cachePath, `${sourceId}_metadata.json`);
                const channelsFile = path.join(cachePath, `${sourceId}_channels.json`);
                
                if (fs.existsSync(metadataFile) && fs.existsSync(channelsFile)) {
                    // Read metadata to check cache freshness
                    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
                    const lastUpdated = new Date(metadata.lastUpdated || 0);
                    const cacheAge = Date.now() - lastUpdated.getTime();
                    const cacheTtlMs = 24 * 60 * 60 * 1000; // 24 hours default
                    
                    if (cacheAge < cacheTtlMs) {
                        logger.info(`Using cached EPG data for ${url}, age: ${Math.round(cacheAge / 1000 / 60)} minutes`);
                        
                        mergedOptions.onProgress({
                            stage: 'cache',
                            percent: 10,
                            message: 'Found valid cached EPG data',
                            details: {
                                cacheAge: Math.round(cacheAge / 1000 / 60),
                                lastUpdated: metadata.lastUpdated
                            }
                        });
                        
                        // Read cached channels
                        const channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8'));
                        
                        // Filter channels if a limit is specified
                        let filteredChannels = channels;
                        if (mergedOptions.maxChannelsToProcess > 0 && channels.length > mergedOptions.maxChannelsToProcess) {
                            logger.info(`Limiting channels to ${mergedOptions.maxChannelsToProcess} from ${channels.length}`);
                            filteredChannels = channels.slice(0, mergedOptions.maxChannelsToProcess);
                            
                            mergedOptions.onProgress({
                                stage: 'limiting',
                                percent: 80,
                                message: `Limiting to ${mergedOptions.maxChannelsToProcess} channels`,
                                details: {
                                    originalCount: channels.length,
                                    limitedCount: filteredChannels.length
                                }
                            });
                        }
                        
                        mergedOptions.onProgress({
                            stage: 'complete',
                            percent: 100,
                            message: `Loaded ${filteredChannels.length} channels from cache`,
                            details: {
                                channelCount: filteredChannels.length,
                                fromCache: true
                            }
                        });
                        
                        return {
                            url,
                            channels: filteredChannels,
                            lastUpdated: metadata.lastUpdated,
                            fromCache: true,
                            cached: true,
                            success: true
                        };
                    } else {
                        logger.info(`Cached EPG data for ${url} has expired (${Math.round(cacheAge / 1000 / 60)} minutes old)`);
                    }
                }
            } catch (cacheError) {
                logger.warn(`Error reading cached EPG data: ${cacheError.message}`);
            }
        }
        
        // If we got here, we need to fetch the EPG data
        mergedOptions.onProgress({
            stage: 'downloading',
            percent: 20,
            message: `Downloading EPG data from ${url}`,
            details: { url }
        });
        
        // Use the streaming parser to handle the EPG data
        const result = await parseEPG(url, {
            maxChannelsToProcess: mergedOptions.maxChannelsToProcess,
            onProgress: (progress) => {
                // Transform progress to include overall context
                const overallPercent = 20 + (progress.percent || 0) * 0.75; // 20-95%
                mergedOptions.onProgress({
                    stage: progress.stage || 'processing',
                    percent: Math.min(95, Math.round(overallPercent)),
                    message: progress.message || `Processing EPG data from ${url}`,
                    details: {
                        ...progress.details,
                        url
                    }
                });
            }
        });
        
        if (!result || !result.channels) {
            throw new Error(`Failed to parse EPG data from ${url}`);
        }
        
        // Filter channels if a limit is specified
        let filteredChannels = result.channels;
        if (mergedOptions.maxChannelsToProcess > 0 && result.channels.length > mergedOptions.maxChannelsToProcess) {
            logger.info(`Limiting channels to ${mergedOptions.maxChannelsToProcess} from ${result.channels.length}`);
            filteredChannels = result.channels.slice(0, mergedOptions.maxChannelsToProcess);
            
            mergedOptions.onProgress({
                stage: 'limiting',
                percent: 92,
                message: `Limiting to ${mergedOptions.maxChannelsToProcess} channels`,
                details: {
                    originalCount: result.channels.length,
                    limitedCount: filteredChannels.length
                }
            });
        }
        
        // Cache the parsed data
        try {
            // Ensure the chunks directory exists
            if (!fs.existsSync(chunkPath)) {
                fs.mkdirSync(chunkPath, { recursive: true });
            }
            
            // Create metadata
            const metadata = {
                url,
                lastUpdated: new Date().toISOString(),
                channelCount: filteredChannels.length,
                programCount: result.programCount || 0
            };
            
            // Write metadata file
            fs.writeFileSync(
                path.join(cachePath, `${sourceId}_metadata.json`),
                JSON.stringify(metadata, null, 2)
            );
            
            // Write channels file
            fs.writeFileSync(
                path.join(cachePath, `${sourceId}_channels.json`),
                JSON.stringify(filteredChannels, null, 2)
            );
            
            logger.info(`Cached EPG data for ${url} with ${filteredChannels.length} channels`);
        } catch (cacheError) {
            logger.warn(`Error caching EPG data: ${cacheError.message}`);
        }
        
        mergedOptions.onProgress({
            stage: 'complete',
            percent: 100,
            message: `Successfully loaded ${filteredChannels.length} channels from ${url}`,
            details: {
                channelCount: filteredChannels.length,
                url,
                fromCache: false
            }
        });
        
        return {
            url,
            channels: filteredChannels,
            lastUpdated: new Date().toISOString(),
            fromCache: false,
            success: true
        };
    } catch (error) {
        logger.error(`Error loading EPG from ${url}: ${error.message}`);
        
        mergedOptions.onProgress({
            stage: 'error',
            percent: 0,
            message: `Error: ${error.message}`,
            details: {
                error: error.message,
                url
            }
        });
        
        return {
            url,
            error: error.message,
            channels: [],
            success: false
        };
    }
}

/**
 * Parse EPG data from a URL or file
 * @param {string} source - URL or file path to parse
 * @param {Object} options - Parsing options
 * @param {number} [options.maxChannelsToProcess=0] - Maximum channels to process (0 = unlimited)
 * @param {Function} [options.onProgress] - Progress callback function
 * @returns {Promise<Object>} - Object containing parsed EPG data
 */
async function parseEPG(source, options = {}) {
    const zlib = require('zlib');
    const fs = require('fs');
    const fetch = require('node-fetch');
    const xml2js = require('xml2js');
    const path = require('path');
    const { getCachePath } = require('../utils/cacheUtils');
    const epgStreamParser = require('../utils/epgStreamParser');
    
    // Default options
    const defaultOptions = {
        forceRefresh: false,
        maxChannelsToProcess: 0, // 0 means no limit
        onProgress: (progress) => {
            logger.debug(`Progress update: ${JSON.stringify(progress)}`);
        }
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    try {
        logger.info(`Parsing EPG data from ${source}`);
        
        // Load constants for XML size limits
        const constants = require('../config/constants');
        const MAX_XML_SIZE = (constants.XML_MAX_SIZE_MB || 500) * 1024 * 1024; // Default to 500MB if not set
        
        // Report starting progress
        mergedOptions.onProgress({
            stage: 'start',
            percent: 0,
            message: `Starting EPG parse from ${source}`,
            details: { source }
        });
        
        // Check if source is a URL or file
        const isUrl = source.startsWith('http://') || source.startsWith('https://');
        
        // Use streaming approach for all parsing to avoid memory issues
        if (isUrl) {
            // Download from URL with streaming approach
            mergedOptions.onProgress({
                stage: 'download',
                percent: 5,
                message: `Downloading EPG data from ${source}`,
                details: { source }
            });
            
            // Check if the URL ends with .gz to determine if it's gzipped
            const isGzipped = source.toLowerCase().endsWith('.gz');
            
            // Use streaming download and parse
            return await epgStreamParser.downloadAndParseEpg(source, progress => {
                // Map the progress from epgStreamParser to our format
                mergedOptions.onProgress({
                    stage: progress.stage || 'download',
                    percent: progress.percent || 10,
                    message: progress.message || 'Downloading and parsing EPG data',
                    details: { ...progress.details, source }
                });
            });
        } else {
            // Read from file system with streaming approach
            mergedOptions.onProgress({
                stage: 'read',
                percent: 5,
                message: `Reading EPG data from file: ${source}`,
                details: { source }
            });
            
            // Check if file exists
            if (!fs.existsSync(source)) {
                throw new Error(`EPG file not found: ${source}`);
            }
            
            // Check if file is gzipped
            const isGzipped = source.toLowerCase().endsWith('.gz');
            
            // Use streaming parse directly from file
            return await epgStreamParser.parseEpgStream(source, isGzipped);
        }
    } catch (error) {
        logger.error(`Error parsing EPG data from ${source}: ${error.message}`);
        throw error;
    }
}

/**
 * Create a unique ID for a source URL
 */
function createSourceId(source) {
    if (!source) return 'unknown_source';
    
    // Use crypto to create a hash of the source URL
    return crypto.createHash('md5').update(source).digest('hex');
}

/**
 * Get the cache base path
 */
function getCachePath() {
    const constants = require('../config/constants');
    const cachePath = constants.CACHE_DIR || path.join(__dirname, '../cache');
    
    // Ensure the base cache directory exists
    if (!fs.existsSync(cachePath)) {
        fs.mkdirSync(cachePath, { recursive: true });
    }
    
    return cachePath;
}

/**
 * Stream and parse an EPG source with chunking for memory efficiency
 */
async function streamingParseEPG(sourceUrl, sourceId, options = {}) {
    const constants = require('../config/constants');
    const context = { sourceUrl, sourceId };
    
    try {
        logger.info(`Starting streaming parse of EPG from ${sourceUrl}`, context);
        
        // Default options
        const mergedOptions = {
            forceRefresh: options.forceRefresh || false,
            maxChannelsPerSource: options.maxChannelsPerSource || constants.MAX_CHANNELS_PER_SOURCE || 5000,
            onProgress: options.onProgress || (() => {}),
            signal: options.signal
        };
        
        // Create source ID and set up paths
        const cachePath = getCachePath();
        const sourceDir = path.join(cachePath, sourceId);
        const channelsPath = path.join(sourceDir, 'channels.json');
        const metadataPath = path.join(sourceDir, 'metadata.json');
        const chunksDir = path.join(sourceDir, 'chunks');
        
        // Ensure directories exist
        if (!fs.existsSync(sourceDir)) {
            fs.mkdirSync(sourceDir, { recursive: true });
        }
        if (!fs.existsSync(chunksDir)) {
            fs.mkdirSync(chunksDir, { recursive: true });
        }
        
        // Check for valid cached version (if not forcing refresh)
        if (!mergedOptions.forceRefresh) {
            try {
                // Check if metadata and channels files exist
                if (fs.existsSync(metadataPath) && fs.existsSync(channelsPath)) {
                    // Read metadata
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    const lastUpdated = new Date(metadata.lastUpdated);
                    const now = new Date();
                    
                    // Check if cache is still valid (default 24 hours)
                    const cacheTimeMs = (constants.CACHE_TIME_HOURS || 24) * 60 * 60 * 1000;
                    if ((now - lastUpdated) < cacheTimeMs) {
                        logger.info(`Using cached EPG data for ${sourceUrl}, last updated ${lastUpdated.toISOString()}`, context);
                        
                        // Read channels data
                        const channelsData = JSON.parse(fs.readFileSync(channelsPath, 'utf8'));
                        if (Array.isArray(channelsData.channels)) {
                            // Return cached data
                            return {
                                channels: channelsData.channels,
                                totalPrograms: channelsData.totalPrograms || 0,
                                lastUpdated: metadata.lastUpdated,
                                fromCache: true
                            };
                        } else {
                            logger.warn(`Invalid channels structure in cache for ${sourceUrl}`, context);
                        }
                    } else {
                        logger.info(`Cached EPG data for ${sourceUrl} is expired, refreshing`, context);
                    }
                }
            } catch (cacheError) {
                logger.warn(`Error reading cache for ${sourceUrl}: ${cacheError.message}`, {
                    ...context,
                    error: cacheError.stack
                });
            }
        } else {
            logger.info(`Force refresh requested for EPG data from ${sourceUrl}`, context);
        }
        
        // If we get here, we need to fetch and parse the EPG data
        // Initialize parsing state
        const channels = [];
        let totalPrograms = 0;
        let currentChannel = null;
        let programBuffer = [];
        let channelCount = 0;
        let programCount = 0;
        
        // Initialize XML parser with event handlers
        const parser = new xml2js.Parser({
            explicitArray: false,
            trim: true,
            mergeAttrs: true
        });
        
        // Define XML processing events
        const onChannel = (channel) => {
            if (channels.length >= mergedOptions.maxChannelsPerSource && mergedOptions.maxChannelsPerSource > 0) {
                return; // Skip if we reached the limit
            }
            
            try {
                // Process channel data
                if (channel && channel.id) {
                    currentChannel = {
                        id: channel.id,
                        name: channel.display_name || channel.id,
                        icon: channel.icon?.src || '',
                        programs: []
                    };
                    channels.push(currentChannel);
                    channelCount++;
                    
                    // Log progress periodically
                    if (channelCount % 100 === 0) {
                        logger.debug(`Processed ${channelCount} channels from ${sourceUrl}`, context);
                        mergedOptions.onProgress({
                            stage: 'channels',
                            percent: 45 + Math.min(channelCount / 500 * 10, 10),
                            message: `Processed ${channelCount} channels`,
                            details: { channelCount, sourceUrl }
                        });
                    }
                }
            } catch (channelError) {
                logger.warn(`Error processing channel: ${channelError.message}`, context);
            }
        };
        
        const onProgram = (program) => {
            if (!currentChannel || (mergedOptions.maxChannelsPerSource > 0 && 
                channels.length > mergedOptions.maxChannelsPerSource)) {
                return; // Skip if no channel or beyond limit
            }
            
            try {
                // Process program data
                if (program && program.start && program.channel) {
                    programBuffer.push(program);
                    programCount++;
                    totalPrograms++;
                    
                    // Chunk programs to disk periodically to save memory
                    const chunkThreshold = constants.CHUNKING_THRESHOLD || 100;
                    if (programBuffer.length >= chunkThreshold) {
                        // Save programs to disk
                        const channelId = currentChannel.id;
                        const chunkPath = path.join(chunksDir, `${channelId}_${Date.now()}.json`);
                        fs.writeFileSync(chunkPath, JSON.stringify(programBuffer));
                        
                        // Clear buffer
                        programBuffer = [];
                        
                        // Force garbage collection occasionally
                        if (global.gc && programCount % (constants.FORCE_GC_AFTER_PROGRAMS || 100000) === 0) {
                            global.gc();
                        }
                    }
                    
                    // Log progress periodically
                    if (programCount % 10000 === 0) {
                        logger.debug(`Processed ${programCount} programs from ${sourceUrl}`, context);
                        mergedOptions.onProgress({
                            stage: 'programs',
                            percent: 55 + Math.min(programCount / 10000 * 5, 35),
                            message: `Processed ${programCount} programs across ${channelCount} channels`,
                            details: { programCount, channelCount, sourceUrl }
                        });
                    }
                }
            } catch (programError) {
                logger.warn(`Error processing program: ${programError.message}`, context);
            }
        };
        
        // Stream parsing with improved error handling
        try {
            // Improved options for fetching
            const fetchOptions = {
                headers: {
                    'User-Agent': 'EPG-Matcher/1.0',
                    'Accept': 'application/xml, text/xml, */*',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 180000, // 3 minute timeout
                signal: mergedOptions.signal || AbortSignal.timeout(180000) // Allow external abort or timeout
            };
            
            // Fetch the XML data
            logger.info(`Fetching EPG data from ${sourceUrl}`, context);
            const response = await fetch(sourceUrl, fetchOptions);
            
            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
            }
            
            // Check if response is gzipped
            const contentEncoding = response.headers.get('content-encoding');
            const contentType = response.headers.get('content-type');
            const isGzipped = contentEncoding === 'gzip' || 
                            contentType === 'application/gzip' || 
                            sourceUrl.endsWith('.gz');
            
            // Get content as a buffer first to check headers
            const buffer = await response.buffer();
            
            // Check for gzip magic numbers (0x1F, 0x8B) at start of buffer
            const hasGzipHeader = buffer.length >= 2 && buffer[0] === 0x1F && buffer[1] === 0x8B;
            
            // Choose decompression or direct parsing
            let xmlStream;
            if (isGzipped || hasGzipHeader) {
                logger.info(`Decompressing gzipped EPG data from ${sourceUrl}`, context);
                // Create a pass-through stream and pipe through gunzip
                const passThrough = new PassThrough();
                passThrough.end(buffer);
                
                try {
                    // Create gunzip stream with error handling
                    const gunzip = zlib.createGunzip()
                        .on('error', (err) => {
                            logger.error(`Gunzip error for ${sourceUrl}: ${err.message}`, {
                                ...context,
                                error: err.stack
                            });
                            
                            // Try to read as plain text as fallback
                            try {
                                const plainText = buffer.toString('utf8');
                                if (plainText.includes('<?xml') || plainText.includes('<tv>')) {
                                    logger.warn(`Falling back to plain text parsing for ${sourceUrl}`, context);
                                    const textStream = new PassThrough();
                                    textStream.end(plainText);
                                    xmlStream = textStream;
                                }
                            } catch (textErr) {
                                logger.error(`Failed to parse as plain text: ${textErr.message}`, context);
                                throw err; // Re-throw original error
                            }
                        });
                    
                    xmlStream = passThrough.pipe(gunzip);
                } catch (gzipError) {
                    logger.error(`Failed to setup gzip decompression: ${gzipError.message}`, context);
                    throw gzipError;
                }
            } else {
                // Not gzipped, use buffer directly
                logger.info(`Parsing uncompressed EPG data from ${sourceUrl}`, context);
                const bufferStream = new PassThrough();
                bufferStream.end(buffer);
                xmlStream = bufferStream;
            }
            
            // Create XML reader
            const xmlReader = new xml2js.Parser({
                explicitArray: false,
                trim: true,
                mergeAttrs: true
            });
            
            // Parse XML stream
            logger.info(`Parsing XML stream from ${sourceUrl}`, context);

            // Use a simplified approach with xml2js without XmlStream
            const xmlData = await new Promise((resolve, reject) => {
                // Instead of collecting all chunks and converting to a single string,
                // use streaming XML parsing to avoid memory issues
                try {
                    logger.info(`Using streaming XML parser for large EPG data from ${sourceUrl}`);
                    const saxParser = require('sax').createStream(true);
                    
                    // Create a structure to hold the parsed data
                    const result = { tv: { channel: [], programme: [] } };
                    let currentElement = null;
                    let currentData = {};
                    let elementStack = [];
                    
                    // Handle XML parsing events
                    saxParser.on('opentag', (node) => {
                        // Start of XML element
                        currentElement = node.name;
                        elementStack.push({ name: currentElement, data: {} });
                        
                        if (currentElement === 'channel') {
                            currentData = { $: { id: node.attributes.id } };
                        } else if (currentElement === 'programme') {
                            currentData = { 
                                $: { 
                                    channel: node.attributes.channel,
                                    start: node.attributes.start,
                                    stop: node.attributes.stop
                                } 
                            };
                        }
                    });
                    
                    saxParser.on('closetag', (tagName) => {
                        // End of XML element
                        if (tagName === 'channel') {
                            result.tv.channel.push(currentData);
                            if (result.tv.channel.length % 1000 === 0) {
                                logger.debug(`Parsed ${result.tv.channel.length} channels from ${sourceUrl}`);
                            }
                        } else if (tagName === 'programme') {
                            result.tv.programme.push(currentData);
                            if (result.tv.programme.length % 10000 === 0) {
                                logger.debug(`Parsed ${result.tv.programme.length} programs from ${sourceUrl}`);
                                // Force garbage collection on large files
                                if (global.gc && result.tv.programme.length % 100000 === 0) {
                                    logger.info(`Forcing garbage collection after parsing ${result.tv.programme.length} programs`);
                                    global.gc();
                                }
                            }
                        }
                        
                        elementStack.pop();
                        if (elementStack.length > 0) {
                            currentElement = elementStack[elementStack.length - 1].name;
                        } else {
                            currentElement = null;
                        }
                    });
                    
                    saxParser.on('text', (text) => {
                        // Handle text content between tags
                        if (text.trim() && currentElement) {
                            // Add text content to current element
                            if (currentElement === 'display-name' && elementStack.length > 1 && elementStack[elementStack.length - 2].name === 'channel') {
                                currentData['display-name'] = text.trim();
                            } else if (currentElement === 'title' && elementStack.length > 1 && elementStack[elementStack.length - 2].name === 'programme') {
                                currentData.title = text.trim();
                            } else if (currentElement === 'desc' && elementStack.length > 1 && elementStack[elementStack.length - 2].name === 'programme') {
                                currentData.desc = text.trim();
                            }
                        }
                    });
                    
                    saxParser.on('error', (err) => {
                        logger.error(`XML parsing error for ${sourceUrl}: ${err.message}`, { ...context, error: err });
                        reject(err);
                    });
                    
                    saxParser.on('end', () => {
                        logger.info(`Finished parsing XML stream from ${sourceUrl}: ${result.tv.channel.length} channels, ${result.tv.programme.length} programs`);
                        resolve(result);
                    });
                    
                    // Start processing the XML data
                    xmlStream.pipe(saxParser);
                    
                } catch (err) {
                    logger.error(`Failed to create SAX parser: ${err.message}`, { ...context, error: err });
                    reject(err);
                }
            });

            try {
                // Since we're using streaming parser, xmlData is already the parsed result
                const result = xmlData;
                
                // Process channels
                if (result?.tv?.channel) {
                    const channelsArray = Array.isArray(result.tv.channel) ? 
                        result.tv.channel : [result.tv.channel];
                    
                    channelsArray.forEach(channel => {
                        if (channels.length >= mergedOptions.maxChannelsPerSource && 
                            mergedOptions.maxChannelsPerSource > 0) {
                            return; // Skip if we reached the limit
                        }
                        
                        try {
                            // Process channel data
                            if (channel && channel.id) {
                                const newChannel = {
                                    id: channel.id,
                                    name: channel.display_name || channel.id,
                                    icon: channel.icon?.src || '',
                                    programs: [] // Initialize an empty programs array for the channel
                                };
                                channels.push(newChannel);
                                currentChannel = newChannel; // Keep track of current channel
                                channelCount++;
                                
                                // Log progress periodically
                                if (channelCount % 100 === 0) {
                                    logger.debug(`Processed ${channelCount} channels from ${sourceUrl}`, context);
                                    mergedOptions.onProgress({
                                        stage: 'channels',
                                        percent: 45 + Math.min(channelCount / 500 * 10, 10),
                                        message: `Processed ${channelCount} channels`,
                                        details: { channelCount, sourceUrl }
                                    });
                                }
                            }
                        } catch (channelError) {
                            logger.warn(`Error processing channel: ${channelError.message}`, context);
                        }
                    });
                }
                
                // Process programs and store them in the channels
                if (result?.tv?.programme) {
                    const programsArray = Array.isArray(result.tv.programme) ?
                        result.tv.programme : [result.tv.programme];
                    
                    // Create a map of channels for easier lookup
                    const channelMap = {};
                    channels.forEach(ch => channelMap[ch.id] = ch);
                    
                    // Process programs
                    programsArray.forEach(program => {
                        if (program && program.start && program.channel) {
                            const channelId = program.channel;
                            const channel = channelMap[channelId];
                            
                            // Skip if channel not found or beyond limit
                            if (!channel || (mergedOptions.maxChannelsPerSource > 0 && 
                                channels.length > mergedOptions.maxChannelsPerSource)) {
                                return;
                            }
                            
                            try {
                                // Format the program object
                                const formattedProgram = {
                                    title: program.title || 'Untitled',
                                    start: program.start,
                                    stop: program.stop,
                                    description: program.desc || '',
                                    category: program.category || [],
                                    channelId: channelId
                                };
                                
                                // Add program to channel's programs array
                                channel.programs.push(formattedProgram);
                                
                                // Also add to program buffer for disk storage
                                programBuffer.push(program);
                                programCount++;
                                totalPrograms++;
                                
                                // Chunk programs to disk periodically to save memory
                                const chunkThreshold = constants.CHUNKING_THRESHOLD || 100;
                                if (programBuffer.length >= chunkThreshold) {
                                    // Save programs to disk
                                    const chunkPath = path.join(chunksDir, `${channelId}_${Date.now()}.json`);
                                    fs.writeFileSync(chunkPath, JSON.stringify(programBuffer));
                                    
                                    // Clear buffer
                                    programBuffer = [];
                                    
                                    // Force garbage collection occasionally
                                    if (global.gc && programCount % (constants.FORCE_GC_AFTER_PROGRAMS || 100000) === 0) {
                                        global.gc();
                                    }
                                }
                                
                                // Log progress periodically
                                if (programCount % 10000 === 0) {
                                    logger.debug(`Processed ${programCount} programs from ${sourceUrl}`, context);
                                    mergedOptions.onProgress({
                                        stage: 'programs',
                                        percent: 55 + Math.min(programCount / 10000 * 5, 35),
                                        message: `Processed ${programCount} programs across ${channelCount} channels`,
                                        details: { programCount, channelCount, sourceUrl }
                                    });
                                }
                            } catch (programError) {
                                logger.warn(`Error processing program: ${programError.message}`, context);
                            }
                        }
                    });
                }
                
                // Save any remaining programs
                if (programBuffer.length > 0) {
                    const channelId = "remaining";
                    const chunkPath = path.join(chunksDir, `${channelId}_${Date.now()}.json`);
                    fs.writeFileSync(chunkPath, JSON.stringify(programBuffer));
                    programBuffer = [];
                }
                
                // Save metadata
                const metadata = {
                    lastUpdated: new Date().toISOString(),
                    sourceUrl,
                    channelCount,
                    programCount: totalPrograms
                };
                fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
                
                // Save channels summary (without programs)
                const channelsData = {
                    channels: channels.map(c => ({ ...c, programs: [] })),
                    totalPrograms: totalPrograms
                };
                fs.writeFileSync(channelsPath, JSON.stringify(channelsData, null, 2));
                
                logger.info(`Completed parsing EPG data from ${sourceUrl}: ${channelCount} channels, ${totalPrograms} programs`, context);
                mergedOptions.onProgress({
                    stage: 'complete',
                    percent: 100,
                    message: `Completed parsing EPG data: ${channelCount} channels, ${totalPrograms} programs`,
                    details: { channelCount, programCount: totalPrograms, sourceUrl }
                });
                
                // Return the final result
                return {
                    channels: channels, // Keep all program data
                    totalPrograms,
                    lastUpdated: metadata.lastUpdated,
                    fromCache: false
                };
            } catch (parseError) {
                logger.error(`Failed to parse XML data from ${sourceUrl}: ${parseError.message}`, {
                    ...context,
                    error: parseError.stack
                });
                throw parseError;
            }
        } catch (streamError) {
            logger.error(`Streaming error for ${sourceUrl}: ${streamError.message}`, {
                ...context,
                error: streamError.stack
            });
            throw streamError;
        }
    } catch (error) {
        logger.error(`Failed to stream parse EPG from ${sourceUrl}: ${error.message}`, {
            ...context,
            error: error.stack
        });
        throw error;
    }
}

/**
 * Get all loaded EPG sources
 * @returns {Object} Object containing all loaded EPG sources
 */
function getLoadedSources() {
    // Check if we have sources in the global scope
    if (global._loadedEpgSources && Object.keys(global._loadedEpgSources).length > 0) {
        return global._loadedEpgSources;
    }
    
    // Check for sources in module.exports._loadedSources
    if (typeof module.exports._loadedSources !== 'undefined' && 
        Object.keys(module.exports._loadedSources).length > 0) {
        return module.exports._loadedSources;
    }
    
    // Try to find any loaded sources from the entire global scope
    if (global.epgSources && Object.keys(global.epgSources).length > 0) {
        return global.epgSources;
    }
    
    // Access loaded sources from loadAllExternalEPGs function's results
    if (global._epgCache && Object.keys(global._epgCache).length > 0) {
        return global._epgCache;
    }
    
    // If we've logged 3844 channels, they must be somewhere...
    // Look in all the places they might be stored
    for (const key of Object.keys(global)) {
        // Look for objects that might contain our EPG sources
        if (global[key] && typeof global[key] === 'object') {
            // Check if this object has channels array or sources with channels
            if (global[key].channels && Array.isArray(global[key].channels)) {
                return { 'found-source': global[key] };
            }
            
            // Look one level deeper
            for (const subKey of Object.keys(global[key])) {
                if (global[key][subKey] && typeof global[key][subKey] === 'object') {
                    if (global[key][subKey].channels && Array.isArray(global[key][subKey].channels)) {
                        const source = {};
                        source[subKey] = global[key][subKey];
                        return source;
                    }
                }
            }
        }
    }
    
    // Add reference to global epg data for next time
    if (!global._epgDataSources) {
        global._epgDataSources = {};
    }
    
    // Return empty object if no sources found
    return global._epgDataSources;
}

/**
 * Get all loaded channels from any available source
 * @returns {Array} Array of all loaded channels
 */
function getAllLoadedChannels() {
    const sources = getLoadedSources();
    let allChannels = [];

    if (sources && Object.keys(sources).length > 0) {
        // Extract channels from each source
        for (const sourceKey in sources) {
            const source = sources[sourceKey];
            
            if (source && source.channels && Array.isArray(source.channels)) {
                // Format channels with source information
                const formattedChannels = source.channels.map(ch => {
                    if (!ch.$ || !ch.$.id) return null;
                    
                    // Extract display name
                    let displayName = ch.$.id;
                    let iconUrl = null;
                    
                    if (ch['display-name'] && Array.isArray(ch['display-name'])) {
                        for (const name of ch['display-name']) {
                            if (typeof name === 'string') {
                                displayName = name;
                                break;
                            } else if (name && name._) {
                                displayName = name._;
                                break;
                            }
                        }
                    }
                    
                    // Extract icon
                    if (ch.icon && Array.isArray(ch.icon)) {
                        for (const icon of ch.icon) {
                            if (icon && icon.$ && icon.$.src) {
                                iconUrl = icon.$.src;
                                break;
                            }
                        }
                    }
                    
                    // Return formatted channel
                    return {
                        id: ch.$.id,
                        channelId: ch.$.id,
                        channelName: displayName,
                        name: displayName,
                        icon: iconUrl,
                        source: sourceKey,
                        hasPrograms: source.programMap && source.programMap[ch.$.id] ? true : false,
                        programCount: source.programMap && source.programMap[ch.$.id] ? source.programMap[ch.$.id].length : 0
                    };
                }).filter(Boolean);
                
                allChannels = allChannels.concat(formattedChannels);
            }
        }
    }
    
    // Try to find channels directly in the global scope
    if (allChannels.length === 0 && global._allChannels && Array.isArray(global._allChannels)) {
        return global._allChannels;
    }
    
    // Cache the results for next time
    global._allChannels = allChannels;
    
    return allChannels;
}

// Add to module exports
module.exports = {
    parseEPG,
    loadExternalEPG,
    loadAllExternalEPGs,
    loadAllExternalEPGsEnhanced,
    loadXtreamEPG,
    loadSingleEpgSource,
    getEpgSummary: generateEpgSummary,
    createTestEpgSource,
    searchEpg,
    searchChannelsAcrossSources,
    findProgramsForChannel,
    getLoadedSources,
    getAllLoadedChannels,
};