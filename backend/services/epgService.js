/**
 * EPG Service - handles parsing and processing of EPG data
 */
const xml2js = require('xml2js');
const zlib = require('zlib');
const logger = require('../config/logger');
const { fetchURL } = require('../utils/fetchUtils');
const { EXTERNAL_EPG_URLS } = require('../config/constants');

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
                if (channel['display-name']) {
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
 * Loads EPG data from an external URL
 * 
 * @param {string} url - URL to load EPG from
 * @returns {Promise<Object>} Parsed EPG data
 */
async function loadExternalEPG(url) {
    try {
        const epgBuffer = await fetchURL(url);
        const epgData = url.endsWith('.gz')
            ? zlib.gunzipSync(epgBuffer).toString('utf8')
            : epgBuffer.toString('utf8');

        const parsedEPG = await parseEPG(epgData);

        if (parsedEPG.channels.length > 0) {
            logger.info(`Loaded ${parsedEPG.channels.length} channels and ${parsedEPG.programs.length} programs from ${url}`);

            // Log channel ID samples for matching
            if (parsedEPG.channels.length > 0) {
                const channelIdSamples = parsedEPG.channels.slice(0, 5).map(ch => ch.$ ? ch.$.id : 'unknown');
                logger.info(`Sample channel IDs from ${url}: ${channelIdSamples.join(', ')}`);
            }

            // Log program channel reference samples
            if (parsedEPG.programs.length > 0) {
                const programRefSamples = parsedEPG.programs.slice(0, 5).map(p => p.$ ? p.$.channel : 'unknown');
                logger.info(`Sample program channel refs from ${url}: ${programRefSamples.join(', ')}`);
            }

            return parsedEPG;
        }

        logger.warn(`No channels found in EPG from ${url}`);
        return null;
    } catch (e) {
        logger.warn(`Failed to load EPG from ${url}`, { error: e.message });
        return null;
    }
}

/**
 * Loads EPG data more efficiently with source prioritization
 * Modified to ensure at least some sources are loaded
 * 
 * @returns {Promise<Object>} Object with EPG sources keyed by URL
 */
async function loadAllExternalEPGs() {
    const epgSources = {};
    const failedSources = [];
    const prioritySources = ['strongepg', 'epgshare01']; // Add your critical sources here

    logger.info(`Starting to load ${EXTERNAL_EPG_URLS.length} EPG sources`);

    // First pass: Try to load priority sources
    for (const url of EXTERNAL_EPG_URLS) {
        // Check if this is a priority source
        const isPriority = prioritySources.some(name => url.includes(name));
        if (!isPriority) continue; // Skip non-priority sources on first pass

        logger.info(`Loading priority EPG source: ${url}`);
        try {
            // Add detailed timing logging
            const startTime = Date.now();
            logger.info(`Fetching EPG data from ${url}`);

            const epgBuffer = await fetchURL(url);

            if (!epgBuffer || epgBuffer.length === 0) {
                logger.error(`Received empty buffer from ${url}`);
                failedSources.push({ url, reason: 'Empty buffer' });
                continue;
            }

            logger.info(`Fetched ${epgBuffer.length} bytes from ${url} in ${Date.now() - startTime}ms`);

            // Handle gzipped content
            let epgContent;
            try {
                if (url.endsWith('.gz')) {
                    logger.info(`Unzipping EPG data from ${url}`);
                    epgContent = zlib.gunzipSync(epgBuffer).toString('utf8');
                    logger.info(`Unzipped to ${epgContent.length} bytes`);
                } else {
                    epgContent = epgBuffer.toString('utf8');
                }
            } catch (e) {
                logger.error(`Failed to process EPG data from ${url}`, { error: e.message, stack: e.stack });
                failedSources.push({ url, reason: `Unzip error: ${e.message}` });
                continue;
            }

            // Basic XML validation
            if (!epgContent.includes('<?xml') || !epgContent.includes('<tv')) {
                logger.error(`Invalid XML structure in EPG from ${url}`);
                failedSources.push({ url, reason: 'Invalid XML structure' });
                continue;
            }

            // Parse EPG
            logger.info(`Parsing EPG data from ${url}`);
            const parseStartTime = Date.now();

            try {
                const parsedEPG = await parseEPG(epgContent);
                logger.info(`Parsed EPG in ${Date.now() - parseStartTime}ms`);

                if (parsedEPG.channels.length > 0) {
                    epgSources[url] = parsedEPG;
                    logger.info(`Successfully loaded EPG from ${url}:`, {
                        channelCount: parsedEPG.channels.length,
                        programCount: parsedEPG.programs.length,
                        channelMapSize: Object.keys(parsedEPG.channelMap).length,
                        programMapSize: Object.keys(parsedEPG.programMap).length
                    });
                } else {
                    logger.warn(`No channels found in EPG from ${url}`);
                    failedSources.push({ url, reason: 'No channels found' });
                }
            } catch (e) {
                logger.error(`Failed to parse EPG from ${url}`, { error: e.message, stack: e.stack });
                failedSources.push({ url, reason: `Parse error: ${e.message}` });
            }
        } catch (e) {
            logger.error(`Failed to load EPG from ${url}`, { error: e.message, stack: e.stack });
            failedSources.push({ url, reason: `Fetch error: ${e.message}` });
        }
    }

    // Check if we need to load more sources
    const maxSources = 3; // Maximum number of sources to load

    // Second pass: Load additional sources if needed
    if (Object.keys(epgSources).length < maxSources) {
        // How many more sources we need
        const remainingSlots = maxSources - Object.keys(epgSources).length;
        logger.info(`Loaded ${Object.keys(epgSources).length} priority sources, loading up to ${remainingSlots} more`);

        // Try loading additional sources
        for (const url of EXTERNAL_EPG_URLS) {
            // Skip already loaded sources
            if (url in epgSources) continue;

            // Stop if we've loaded enough sources
            if (Object.keys(epgSources).length >= maxSources) {
                logger.info(`Reached maximum of ${maxSources} EPG sources, stopping to conserve memory`);
                break;
            }

            logger.info(`Loading additional EPG source: ${url}`);
            try {
                const startTime = Date.now();
                logger.info(`Fetching EPG data from ${url}`);

                const epgBuffer = await fetchURL(url);

                if (!epgBuffer || epgBuffer.length === 0) {
                    logger.error(`Received empty buffer from ${url}`);
                    failedSources.push({ url, reason: 'Empty buffer' });
                    continue;
                }

                logger.info(`Fetched ${epgBuffer.length} bytes from ${url} in ${Date.now() - startTime}ms`);

                // Handle gzipped content
                let epgContent;
                try {
                    if (url.endsWith('.gz')) {
                        logger.info(`Unzipping EPG data from ${url}`);
                        epgContent = zlib.gunzipSync(epgBuffer).toString('utf8');
                        logger.info(`Unzipped to ${epgContent.length} bytes`);
                    } else {
                        epgContent = epgBuffer.toString('utf8');
                    }
                } catch (e) {
                    logger.error(`Failed to process EPG data from ${url}`, { error: e.message, stack: e.stack });
                    failedSources.push({ url, reason: `Unzip error: ${e.message}` });
                    continue;
                }

                // Basic XML validation
                if (!epgContent.includes('<?xml') || !epgContent.includes('<tv')) {
                    logger.error(`Invalid XML structure in EPG from ${url}`);
                    failedSources.push({ url, reason: 'Invalid XML structure' });
                    continue;
                }

                // Parse EPG
                logger.info(`Parsing EPG data from ${url}`);
                const parseStartTime = Date.now();

                try {
                    const parsedEPG = await parseEPG(epgContent);
                    logger.info(`Parsed EPG in ${Date.now() - parseStartTime}ms`);

                    if (parsedEPG.channels.length > 0) {
                        epgSources[url] = parsedEPG;
                        logger.info(`Successfully loaded EPG from ${url}:`, {
                            channelCount: parsedEPG.channels.length,
                            programCount: parsedEPG.programs.length,
                            channelMapSize: Object.keys(parsedEPG.channelMap).length,
                            programMapSize: Object.keys(parsedEPG.programMap).length
                        });
                    } else {
                        logger.warn(`No channels found in EPG from ${url}`);
                        failedSources.push({ url, reason: 'No channels found' });
                    }
                } catch (e) {
                    logger.error(`Failed to parse EPG from ${url}`, { error: e.message, stack: e.stack });
                    failedSources.push({ url, reason: `Parse error: ${e.message}` });
                }
            } catch (e) {
                logger.error(`Failed to load EPG from ${url}`, { error: e.message, stack: e.stack });
                failedSources.push({ url, reason: `Fetch error: ${e.message}` });
            }
        }
    }

    // Final summary
    const successCount = Object.keys(epgSources).length;
    logger.info(`Loaded ${successCount} EPG sources successfully. ${failedSources.length} sources failed.`);
    if (failedSources.length > 0) {
        logger.info(`Failed sources: ${JSON.stringify(failedSources)}`);
    }

    // Return even if empty (calling code must handle this)
    return epgSources;
}

/**
* Loads a single EPG source to allow for better error handling
* 
* @param {string} url - URL of the EPG source
* @returns {Promise<Object|null>} Parsed EPG data or null if failed
*/
async function loadSingleEpgSource(url) {
    const startTime = Date.now();
    logger.info(`Fetching EPG data from ${url}`);

    try {
        const epgBuffer = await fetchURL(url);

        if (!epgBuffer || epgBuffer.length === 0) {
            logger.error(`Received empty buffer from ${url}`);
            return null;
        }

        logger.info(`Fetched ${epgBuffer.length} bytes from ${url} in ${Date.now() - startTime}ms`);

        // Handle gzipped content
        let epgContent;
        try {
            if (url.endsWith('.gz')) {
                logger.info(`Unzipping EPG data from ${url}`);
                epgContent = zlib.gunzipSync(epgBuffer).toString('utf8');
                logger.info(`Unzipped to ${epgContent.length} bytes`);
            } else {
                epgContent = epgBuffer.toString('utf8');
            }
        } catch (e) {
            logger.error(`Failed to process EPG data from ${url}`, { error: e.message });
            return null;
        }

        // Basic XML validation
        if (!epgContent.includes('<?xml') || !epgContent.includes('<tv')) {
            logger.error(`Invalid XML structure in EPG from ${url}`);
            return null;
        }

        // Parse EPG
        logger.info(`Parsing EPG data from ${url}`);
        const parseStartTime = Date.now();
        const parsedEPG = await parseEPG(epgContent);
        logger.info(`Parsed EPG in ${Date.now() - parseStartTime}ms`);

        if (!parsedEPG || parsedEPG.channels.length === 0) {
            logger.warn(`No channels found in EPG from ${url}`);
            return null;
        }

        // Log channel ID samples for debugging
        if (parsedEPG.channels.length > 0) {
            const channelIdSamples = parsedEPG.channels.slice(0, 5).map(ch => ch.$ ? ch.$.id : 'unknown');
            logger.info(`Sample channel IDs from ${url}: ${channelIdSamples.join(', ')}`);
        }

        // Log program count details
        logger.info(`Successfully loaded EPG from ${url}:`, {
            channelCount: parsedEPG.channels.length,
            programCount: parsedEPG.programs.length,
            channelMapSize: Object.keys(parsedEPG.channelMap).length,
            programMapSize: Object.keys(parsedEPG.programMap).length
        });

        return parsedEPG;
    } catch (e) {
        logger.error(`Error loading EPG source ${url}`, { error: e.message, stack: e.stack });
        return null;
    }
}

/**
* Special mapping for sports channels
* Helps match M3U channels with EPG data for sports
* 
* @param {string} channelName - Original channel name
* @returns {Array} Array of potential EPG IDs to match against
*/
function generateSportsEpgMappings(channelName) {
    const nameLower = channelName.toLowerCase();
    const mappings = [];

    // Extract team name from common patterns
    // US| MLB LOS ANGELES ANGELS HD -> los angeles angels
    let teamName = nameLower.replace(/^us\|\s*mlb\s*/i, '').replace(/\s*hd$/i, '');

    // Add the clean team name
    mappings.push(teamName);

    // MLB-specific mappings
    if (nameLower.includes('mlb') || nameLower.includes('baseball')) {
        // Add without MLB prefix
        mappings.push(teamName.replace(/^mlb[\s-]+/i, ''));

        // Add with different formats
        mappings.push(`mlb ${teamName}`);
        mappings.push(`baseball ${teamName}`);

        // Special case for channel IDs with dash format
        if (channelName.includes('-')) {
            const parts = channelName.split('-');
            if (parts.length >= 2) {
                mappings.push(parts[1].split('.')[0]); // MLB-WashingtonNationals.us -> WashingtonNationals
                mappings.push(parts[1].replace(/\..*$/, '')); // Remove any domain suffix
            }
        }

        // Handle city + team name format (Los Angeles Angels)
        const cityTeamMatch = teamName.match(/^(.*?)\s+(.*?)$/);
        if (cityTeamMatch) {
            const [_, city, team] = cityTeamMatch;
            // Add just the team name (Angels)
            mappings.push(team);
            // Add just the city (Los Angeles)
            mappings.push(city);
            // Add different separators
            mappings.push(`${city}-${team}`);
            mappings.push(`${city}.${team}`);
        }

        // Team-specific mappings
        if (nameLower.includes('nationals') || nameLower.includes('washington')) {
            mappings.push('washington');
            mappings.push('nationals');
            mappings.push('washington nationals');
            mappings.push('nats');
            mappings.push('washington nats');
            mappings.push('MLB Washington Nationals');
        }
    }

    // Remove duplicates
    return [...new Set(mappings)];
}

/**
 * Enhanced version of loadAllExternalEPGs with better error handling and logging
 * 
 * @returns {Promise<Object>} Object with EPG sources keyed by URL
 */
async function loadAllExternalEPGsEnhanced() {
    const epgSources = {};

    for (const url of EXTERNAL_EPG_URLS) {
        logger.info(`Starting to load EPG from ${url}`);

        try {
            // Add detailed timing logging
            const startTime = Date.now();
            logger.info(`Fetching EPG data from ${url}`);

            const epgBuffer = await fetchURL(url);
            logger.info(`Fetched ${epgBuffer.length} bytes from ${url} in ${Date.now() - startTime}ms`);

            // Handle gzipped content
            let epgContent;
            try {
                if (url.endsWith('.gz')) {
                    logger.info(`Unzipping EPG data from ${url}`);
                    epgContent = zlib.gunzipSync(epgBuffer).toString('utf8');
                    logger.info(`Unzipped to ${epgContent.length} bytes`);
                } else {
                    epgContent = epgBuffer.toString('utf8');
                }
            } catch (e) {
                logger.error(`Failed to process EPG data from ${url}`, { error: e.message, stack: e.stack });
                continue;
            }

            // Basic XML validation
            if (!epgContent.includes('<?xml') || !epgContent.includes('<tv')) {
                logger.error(`Invalid XML structure in EPG from ${url}`);
                continue;
            }

            // Parse EPG
            logger.info(`Parsing EPG data from ${url}`);
            const parseStartTime = Date.now();
            const parsedEPG = await parseEPG(epgContent);
            logger.info(`Parsed EPG in ${Date.now() - parseStartTime}ms`);

            if (parsedEPG.channels.length > 0) {
                epgSources[url] = parsedEPG;
                logger.info(`Successfully loaded EPG from ${url}:`, {
                    channelCount: parsedEPG.channels.length,
                    programCount: parsedEPG.programs.length,
                    channelMapSize: Object.keys(parsedEPG.channelMap).length,
                    programMapSize: Object.keys(parsedEPG.programMap).length
                });

                // Log channel ID samples for matching
                if (parsedEPG.channels.length > 0) {
                    const channelIdSamples = parsedEPG.channels.slice(0, 5).map(ch => ch.$ ? ch.$.id : 'unknown');
                    logger.info(`Sample channel IDs from ${url}: ${channelIdSamples.join(', ')}`);

                    // Check specifically for Travel Channel
                    const travelChannels = parsedEPG.channels.filter(ch => {
                        if (!ch.$ || !ch.$.id) return false;

                        // Check ID
                        if (ch.$.id.toLowerCase().includes('travel')) return true;

                        // Check display names
                        if (ch['display-name']) {
                            for (const name of ch['display-name']) {
                                const displayName = typeof name === 'string' ? name : (name && name._ ? name._ : '');
                                if (displayName.toLowerCase().includes('travel')) return true;
                            }
                        }

                        return false;
                    });

                    if (travelChannels.length > 0) {
                        logger.info(`Found ${travelChannels.length} travel-related channels in ${url}:`, {
                            channels: travelChannels.map(ch => ({
                                id: ch.$.id,
                                names: ch['display-name'] ? ch['display-name'].map(n => typeof n === 'string' ? n : (n && n._ ? n._ : 'unknown')) : []
                            }))
                        });
                    } else {
                        logger.warn(`No travel-related channels found in ${url}`);
                    }
                }

                // Check for program data specifically for travel channels
                const travelProgramCounts = {};
                const travelRelatedIds = Object.keys(parsedEPG.channelMap).filter(id =>
                    id.toLowerCase().includes('travel')
                );

                if (travelRelatedIds.length > 0) {
                    logger.info(`Found ${travelRelatedIds.length} travel-related channel IDs in channel map for ${url}`);

                    travelRelatedIds.forEach(id => {
                        const channel = parsedEPG.channelMap[id];
                        if (channel && channel.$ && channel.$.id) {
                            const channelId = channel.$.id;
                            const programs = parsedEPG.programMap[channelId] || [];
                            travelProgramCounts[channelId] = programs.length;
                        }
                    });

                    logger.info(`Travel channel program counts in ${url}:`, travelProgramCounts);
                } else {
                    logger.warn(`No travel-related channel IDs found in channel map for ${url}`);
                }

                // Log program channel reference samples
                if (parsedEPG.programs.length > 0) {
                    const programRefSamples = parsedEPG.programs.slice(0, 5).map(p => p.$ ? p.$.channel : 'unknown');
                    logger.info(`Sample program channel refs from ${url}: ${programRefSamples.join(', ')}`);

                    // Count programs per channel
                    const programsPerChannel = {};
                    parsedEPG.programs.forEach(p => {
                        if (p.$ && p.$.channel) {
                            programsPerChannel[p.$.channel] = (programsPerChannel[p.$.channel] || 0) + 1;
                        }
                    });

                    const channelsWithPrograms = Object.keys(programsPerChannel).length;
                    const topChannels = Object.entries(programsPerChannel)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10);

                    logger.info(`${channelsWithPrograms} channels have program data in ${url}`);
                    logger.info(`Top 10 channels by program count in ${url}:`, {
                        topChannels: topChannels.map(([id, count]) => ({ id, count }))
                    });
                }
            } else {
                logger.warn(`No channels found in EPG from ${url}`);
            }
        } catch (e) {
            logger.error(`Failed to load EPG from ${url}`, { error: e.message, stack: e.stack });
        }
    }

    // Final summary
    logger.info(`Loaded ${Object.keys(epgSources).length} EPG sources`);
    Object.keys(epgSources).forEach(url => {
        logger.info(`Source ${url} data summary:`, {
            channels: epgSources[url].channels.length,
            programs: epgSources[url].programs.length,
            channelMapEntries: Object.keys(epgSources[url].channelMap).length,
            programMapEntries: Object.keys(epgSources[url].programMap).length
        });
    });

    return epgSources;
}

/**
 * Loads EPG data from an Xtream provider
 * 
 * @param {string} baseUrl - Xtream base URL
 * @param {string} username - Xtream username
 * @param {string} password - Xtream password
 * @returns {Promise<Object>} Parsed EPG data
 */
async function loadXtreamEPG(baseUrl, username, password) {
    try {
        const xtreamEpgUrl = `${baseUrl}xmltv.php?username=${username}&password=${password}`;
        const epgContent = (await fetchURL(xtreamEpgUrl)).toString('utf8');
        const xtreamEPG = await parseEPG(epgContent);

        if (xtreamEPG.channels.length > 0) {
            logger.info(`Loaded ${xtreamEPG.channels.length} channels and ${xtreamEPG.programs.length} programs from XTREAM EPG`);
            return xtreamEPG;
        }

        logger.warn('No channels found in XTREAM EPG');
        return null;
    } catch (e) {
        logger.warn('No EPG from XTREAM, proceeding without it', { error: e.message });
        return null;
    }
}

/**
 * Create a test EPG source with popular channels for testing
 * 
 * @returns {Object} A test EPG source with channel and program data
 */
function createTestEpgSource() {
    const now = new Date();

    // Create timestamps for programs
    const startTime1 = new Date(now);
    startTime1.setHours(startTime1.getHours() - 1);

    const endTime1 = new Date(now);
    endTime1.setMinutes(endTime1.getMinutes() + 30);

    const startTime2 = new Date(endTime1);
    const endTime2 = new Date(startTime2);
    endTime2.setHours(endTime2.getHours() + 1);

    // Format dates for EPG
    const formatDate = (date) => {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0] + ' +0000';
    };

    // Common US channels
    const channels = [
        { $: { id: 'travel_channel' }, 'display-name': ['Travel Channel'] },
        { $: { id: 'Travel.US.-.East.us' }, 'display-name': ['Travel US - East'] },
        { $: { id: 'history_channel' }, 'display-name': ['History Channel'] },
        { $: { id: 'discovery' }, 'display-name': ['Discovery Channel'] },
        { $: { id: 'national_geographic' }, 'display-name': ['National Geographic'] },
        { $: { id: 'cnn' }, 'display-name': ['CNN'] },
        { $: { id: 'hbo' }, 'display-name': ['HBO'] },
        { $: { id: 'espn' }, 'display-name': ['ESPN'] },
        { $: { id: 'fox_news' }, 'display-name': ['Fox News'] },
        { $: { id: 'nbc' }, 'display-name': ['NBC'] },
        { $: { id: 'abc' }, 'display-name': ['ABC'] }
    ];

    // Sample programs
    const programs = [];

    // Create programs for each channel
    channels.forEach(channel => {
        programs.push({
            $: {
                channel: channel.$.id,
                start: formatDate(startTime1),
                stop: formatDate(endTime1)
            },
            title: [`${channel['display-name'][0]} Morning Show`],
            desc: [`Morning program on ${channel['display-name'][0]}`]
        });

        programs.push({
            $: {
                channel: channel.$.id,
                start: formatDate(endTime1),
                stop: formatDate(endTime2)
            },
            title: [`${channel['display-name'][0]} Afternoon Special`],
            desc: [`Afternoon special program on ${channel['display-name'][0]}`]
        });
    });

    // Build channel map and program map
    const channelMap = {};
    const programMap = {};

    channels.forEach(channel => {
        channelMap[channel.$.id] = channel;
        channelMap[channel.$.id.toLowerCase()] = channel;
        channelMap[channel['display-name'][0]] = channel;
        channelMap[channel['display-name'][0].toLowerCase()] = channel;
        channelMap[channel['display-name'][0].toLowerCase().replace(/\s+/g, '_')] = channel;

        // Special case for Travel Channel with HD suffix
        if (channel.$.id === 'travel_channel' || channel.$.id === 'Travel.US.-.East.us') {
            channelMap['travel_channel_hd'] = channel;
            channelMap['travelhd'] = channel;
            channelMap['travelchannel'] = channel;
            channelMap['travel'] = channel;
        }
    });

    programs.forEach(program => {
        if (!programMap[program.$.channel]) {
            programMap[program.$.channel] = [];
        }
        programMap[program.$.channel].push(program);
    });

    return {
        channels,
        programs,
        channelMap,
        programMap,
        isTestSource: true
    };
}

module.exports = {
    parseEPG,
    findProgramsForChannel,
    findProgramsForSpecificChannel,
    searchChannelsAcrossSources,
    loadExternalEPG,
    loadAllExternalEPGs,
    loadAllExternalEPGsEnhanced,
    loadXtreamEPG,
    createTestEpgSource,
    processPrograms
};