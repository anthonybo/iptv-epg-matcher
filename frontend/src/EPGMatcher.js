import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import EpgDataLoader from './EpgDataLoader';

/**
 * Enhanced EPGMatcher component for matching channels with EPG data
 * Modern UI with improved handling of large datasets
 * 
 * @param {Object} props Component properties
 * @param {string} props.sessionId Current session ID
 * @param {Object} props.selectedChannel The currently selected channel
 * @param {Function} props.onEpgMatch Callback when EPG is matched
 * @param {Object} props.matchedChannels Current matched channels
 * @returns {JSX.Element} EPGMatcher component
 */
const EPGMatcher = ({ sessionId, selectedChannel, onEpgMatch, matchedChannels = {} }) => {
    const [session, setSession] = useState(sessionId);
    const [epgSearch, setEpgSearch] = useState("");
    const [searchResults, setSearchResults] = useState([]);
    const [epgSources, setEpgSources] = useState([]);
    const [epgData, setEpgData] = useState(null);
    const [resultSortMethod, setResultSortMethod] = useState("match");
    const [selectedEpgId, setSelectedEpgId] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [searching, setSearching] = useState(false);
    const [searchStatus, setSearchStatus] = useState("");
    const [showSourcesInfo, setShowSourcesInfo] = useState(false);
    const [debugMode, setDebugMode] = useState(false);
    const [sourceInfo, setSourceInfo] = useState(null);
    const [currentProgram, setCurrentProgram] = useState(null);
    const [status, setStatus] = useState("");
    const [statusType, setStatusType] = useState("info");
    const [resultFilter, setResultFilter] = useState("");
    const [suggestedIds, setSuggestedIds] = useState([]);
    const [loadingEpgSources, setLoadingEpgSources] = useState(false);
    const [currentSource, setCurrentSource] = useState(null);

    // Function to find the current program from a list of programs
    const findCurrentProgram = (programs) => {
        if (!programs || !Array.isArray(programs) || programs.length === 0) {
            return null;
        }
        
        const now = new Date();
        
        // Find a program that is currently airing
        return programs.find(program => {
            try {
                const startTime = new Date(program.start);
                const endTime = new Date(program.stop);
                
                // Check if current time is between start and end
                return startTime <= now && endTime >= now;
            } catch (error) {
                console.error('Error checking if program is current:', error, program);
                return false;
            }
        });
    };

    // Create a function to ensure we have a valid unified session
    const ensureUnifiedSession = async () => {
        if (!sessionId) {
            console.log('No session ID, creating a new unified session...');
            try {
                const response = await fetch('/api/session/create-and-register', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`Failed to create session: ${response.status} ${response.statusText}`);
                }
                
                const data = await response.json();
                console.log('Created new unified session:', data);
                
                // Update the session ID in parent component if onEpgMatch is available
                if (onEpgMatch) {
                    onEpgMatch(null, { sessionId: data.sessionId });
                }
                
                // Return the new session ID
                return data.sessionId;
            } catch (error) {
                console.error('Error creating unified session:', error);
                setError(`Failed to create EPG session: ${error.message}`);
                return null;
            }
        }
        
        return sessionId;
    };

    // Handle safe close of sources dropdown to prevent unnecessary renders
    const handleToggleSourcesInfo = () => {
        setShowSourcesInfo(prev => !prev);
    };

    // Fetch available EPG sources
    const fetchEpgSources = useCallback(async () => {
        if (!session) {
            console.log("No session ID provided for EPG sources");
            return;
        }

        setLoadingEpgSources(true);
        try {
            console.log('Fetching EPG sources for session:', session);
            const response = await fetch(`http://localhost:5001/api/epg/${session}/sources?_t=${Date.now()}`);
            
            if (!response.ok) {
                console.log('Failed to load EPG sources, initializing session...');
                await loadEpgData();
                return;
            }
            
            const data = await response.json();
            
            // Check if sources is an array property or direct array
            const sourcesToUse = data.sources || data;
            
            if (Array.isArray(sourcesToUse) && sourcesToUse.length > 0) {
                console.log('Loaded EPG sources directly:', sourcesToUse);
                setEpgSources(sourcesToUse);
            } else {
                console.log('No EPG sources found in response:', data);
                    await loadEpgData();
            }
        } catch (error) {
            console.error('Error fetching EPG sources:', error);
            await loadEpgData();
        } finally {
            setLoadingEpgSources(false);
        }
    }, [session]);
    
    // Function to load EPG data from sources
    const loadEpgData = async () => {
        if (!session) {
            const newSessionId = await ensureUnifiedSession();
            if (!newSessionId) {
                throw new Error('Failed to create session for EPG loading');
            }
        }
        
        setStatus('Loading EPG data sources...');
        
        try {
            // First try to load EPG sources from the server
            const sourcesResponse = await fetch(`http://localhost:5001/api/epg/${session}/sources?_t=${Date.now()}`);
            
            if (!sourcesResponse.ok) {
                // If that fails, try to initialize the EPG session
                console.log('No EPG sources found, initializing EPG session first...');
                
                // First try simple initialization without loading everything
                const initResponse = await fetch(`http://localhost:5001/api/epg/init`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                    body: JSON.stringify({ sessionId: session })
                });
                
                if (!initResponse.ok) {
                    throw new Error(`Failed to initialize EPG session: ${initResponse.status} ${initResponse.statusText}`);
                }
                
                console.log('EPG session initialized, loading sources...');
                
                // Now try to fetch sources again
                const sourcesRetryResponse = await fetch(`http://localhost:5001/api/epg/${session}/sources?_t=${Date.now()}`);
                
                if (!sourcesRetryResponse.ok) {
                    throw new Error(`Failed to load EPG sources after initialization: ${sourcesRetryResponse.status} ${sourcesRetryResponse.statusText}`);
                }
                
                const sourcesData = await sourcesRetryResponse.json();
                
                if (sourcesData && sourcesData.sources) {
                    console.log('Loaded EPG sources after initialization:', sourcesData.sources);
                    setEpgSources(sourcesData.sources);
                    return sourcesData.sources;
                }
            } else {
                // We got sources directly
                const sourcesData = await sourcesResponse.json();
                
                if (sourcesData && sourcesData.sources) {
                    console.log('Loaded EPG sources directly:', sourcesData.sources);
                    setEpgSources(sourcesData.sources);
                    return sourcesData.sources;
                }
            }
            
            // If we reach here, we couldn't load sources the standard way - try one more approach
            console.log('Attempting to load EPG data directly...');
            
            // Try to load a specific source to trigger the backend to initialize
            const loadResponse = await fetch(`http://localhost:5001/api/epg/${session}/load`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    source: {
                        url: 'all',
                        forceRefresh: false,
                        maxChannels: 0 // No limit
                    }
                })
            });
            
            if (!loadResponse.ok) {
                throw new Error(`Failed to load EPG data: ${loadResponse.status} ${loadResponse.statusText}`);
            }
            
            const loadData = await loadResponse.json();
            console.log('EPG data load response:', loadData);
            
            // Try to get sources one more time
            const sourcesAfterLoadResponse = await fetch(`http://localhost:5001/api/epg/${session}/sources?_t=${Date.now()}`);
            
            if (!sourcesAfterLoadResponse.ok) {
                throw new Error(`Still failed to load EPG sources: ${sourcesAfterLoadResponse.status} ${sourcesAfterLoadResponse.statusText}`);
            }
            
            const sourcesAfterLoadData = await sourcesAfterLoadResponse.json();
            
            if (sourcesAfterLoadData && sourcesAfterLoadData.sources) {
                console.log('Loaded EPG sources after direct load:', sourcesAfterLoadData.sources);
                setEpgSources(sourcesAfterLoadData.sources);
                return sourcesAfterLoadData.sources;
            }
            
            throw new Error('Failed to load EPG sources despite multiple attempts');
        } catch (error) {
            console.error('Error loading EPG data:', error);
            setError(`Error loading EPG data: ${error.message}`);
            throw error; // Re-throw to allow caller to handle
        } finally {
            setStatus('');
        }
    };

    useEffect(() => {
        // Reset polling count and fetch immediately when session changes
        if (session) {
            console.log("Session changed, fetching EPG sources once");
            fetchEpgSources();
        }
        
        // Clear any previous debounce timers
        return () => {
            if (window.epgSourceDebounceTimer) {
                clearTimeout(window.epgSourceDebounceTimer);
            }
        };
    }, [session, fetchEpgSources]);

    // Add event to allow manual refreshing with debounce
    useEffect(() => {
        const triggerEpgSourceFetch = () => {
            if (window.epgSourceDebounceTimer) {
                clearTimeout(window.epgSourceDebounceTimer);
            }
            
            if (!loadingEpgSources) {
                window.epgSourceDebounceTimer = setTimeout(() => {
                    console.log("Debounced EPG source fetch triggered");
        fetchEpgSources();
                }, 2000); // Increased debounce to 2 seconds
            }
        };
        
        window.addEventListener('refreshEpgSources', triggerEpgSourceFetch);
        
        return () => {
            window.removeEventListener('refreshEpgSources', triggerEpgSourceFetch);
            if (window.epgSourceDebounceTimer) {
                clearTimeout(window.epgSourceDebounceTimer);
            }
        };
    }, [fetchEpgSources, loadingEpgSources]);

    // Safely format EPG sources for display in UI
    const safeFormattedEpgSources = useMemo(() => {
        if (!Array.isArray(epgSources)) {
            console.warn('EPG sources is not an array:', epgSources);
            return [];
        }
        
        try {
            // Create a Map for strict deduplication
            const uniqueSourcesMap = new Map();
            const total = epgSources.length;
            let valid = 0, duplicates = 0, invalid = 0;
            
            // Process each source with validation
            epgSources.forEach(source => {
                if (!source || typeof source !== 'object') {
                    invalid++;
                    return;
                }
                
                const sourceUrl = source.url ? source.url.toLowerCase().trim() : '';
                const sourceName = source.name ? source.name.toLowerCase().trim() : '';
                
                if (!sourceUrl && !sourceName) {
                    invalid++;
                    return;
                }
                
                // Use composite key for strong deduplication
                const uniqueKey = `${sourceName}|${sourceUrl}`;
                
                if (!uniqueSourcesMap.has(uniqueKey)) {
                    valid++;
                    uniqueSourcesMap.set(uniqueKey, {
                        key: `source-${uniqueSourcesMap.size}`,
                        name: source.name || 'Unnamed Source',
                        url: sourceUrl || null,
                        channelCount: typeof source.channelCount === 'number' ? source.channelCount : null
                    });
                } else {
                    duplicates++;
                }
            });
            
            const uniqueSources = Array.from(uniqueSourcesMap.values());
            console.log(`EPG Sources: Total=${total}, Valid=${valid}, Duplicates=${duplicates}, Invalid=${invalid}, Unique=${uniqueSources.length}`);
            
            // Cap sources to display
            const MAX_DISPLAYED_SOURCES = 20;
            const displayedSources = uniqueSources.slice(0, MAX_DISPLAYED_SOURCES);
            
            if (uniqueSources.length > MAX_DISPLAYED_SOURCES) {
                displayedSources.push({
                    key: 'source-more',
                    name: `+ ${uniqueSources.length - MAX_DISPLAYED_SOURCES} more sources`,
                    url: null,
                    channelCount: null,
                    isPlaceholder: true
                });
            }
            
            return displayedSources;
        } catch (error) {
            console.error('Error deduplicating EPG sources:', error);
            return [];
        }
    }, [epgSources]);

    /**
     * When channel changes, update search term and generate suggestions
     * Fixed to properly store matchedChannels in the session
     */
    useEffect(() => {
        if (!selectedChannel) return;

        // Clean up channel name for better matching
        let channelName = selectedChannel.name;
        // Remove provider prefixes like "US| " 
        channelName = channelName.replace(/^[A-Z]+\|\s+/i, '');
        // Set initial search term
        setEpgSearch(channelName);

        // Generate EPG ID suggestions based on channel name
        generateEpgIdSuggestions(channelName);

        // Check if we already have a match for this channel
        if (session && matchedChannels[selectedChannel.tvgId]) {
            fetchEpgData(matchedChannels[selectedChannel.tvgId]);
        } else {
            fetchEpgData(selectedChannel.tvgId);
        }
    }, [session, selectedChannel, matchedChannels]);

    // Generate potential EPG IDs from channel name
    const generateEpgIdSuggestions = (channelName) => {
        if (!channelName) return;

        // Create normalized versions of the channel name
        const baseName = channelName.toLowerCase();
        const cleanedName = baseName.replace(/^[a-z]{2}\|\s+/i, ''); // Remove country prefix
        const cleanedNoHD = cleanedName.replace(/\s+(?:hd|uhd|4k|sd)$/i, ''); // Remove quality suffix
        const snakeCase = cleanedNoHD.replace(/\s+/g, '_').replace(/[^\w_]/g, '');

        // Extract individual words for better matching
        const words = cleanedNoHD.split(/\s+/).filter(word => word.length > 3);

        // Create suggestions
        const suggestions = [
            // Original name and ID
            { id: channelName, name: channelName },
            { id: selectedChannel.tvgId, name: `Original ID: ${selectedChannel.tvgId}` },

            // Cleaned versions
            { id: cleanedName, name: `${cleanedName} (no prefix)` },
            { id: cleanedNoHD, name: `${cleanedNoHD} (no HD)` },

            // Snake case variations
            { id: snakeCase, name: `${snakeCase} (snake_case)` },
            { id: `${snakeCase}.us`, name: `${snakeCase}.us (with US domain)` },

            // Words only (for partial matching)
            ...words.map(word => ({ id: word, name: `Word only: ${word}` }))
        ];

        // For US content, add more variation suggestions
        if (baseName.includes('us|')) {
            suggestions.push({ id: `US: ${cleanedNoHD}`, name: `US: ${cleanedNoHD}` });

            // Different domain variations
            suggestions.push({ id: `${cleanedNoHD.replace(/\s+/g, '')}.us`, name: `${cleanedNoHD.replace(/\s+/g, '')}.us` });
            suggestions.push({ id: `${cleanedNoHD.replace(/\s+/g, '.')}.us`, name: `${cleanedNoHD.replace(/\s+/g, '.')}.us` });

            // Try with different separators
            suggestions.push({ id: cleanedNoHD.replace(/\s+/g, '-'), name: `${cleanedNoHD.replace(/\s+/g, '-')} (with hyphens)` });
            suggestions.push({ id: cleanedNoHD.replace(/\s+/g, '.'), name: `${cleanedNoHD.replace(/\s+/g, '.')} (with dots)` });
        }

        // Filter unique suggestions by ID
        const uniqueSuggestions = suggestions.filter((suggestion, index, self) =>
            index === self.findIndex(s => s.id === suggestion.id)
        );

        setSuggestedIds(uniqueSuggestions);
    };

    // Search for channels in the EPG database using the session
    const searchEpgChannels = async (term) => {
        // Don't search if no term provided
        if (!term || term.trim().length < 2) {
            setSearchStatus('Please enter at least 2 characters to search');
            return;
        }
        
        setSearching(true);
        setSearchStatus(`Searching for "${term}"...`);
        setSearchResults([]);

        try {
            // Ensure we have a session first
            if (!session) {
                const newSessionId = await ensureUnifiedSession();
                setSession(newSessionId);
            }

            // Load EPG sources if needed
            await loadEpgData();

            // First try the session-based search endpoint
            try {
                console.log(`Searching EPG channels with term: "${term}" in session ${session}`);
                const response = await axios.get(
                    `http://localhost:5001/api/epg/${session}/search?term=${encodeURIComponent(term)}&_t=${Date.now()}`
                );
                
                console.log('EPG search response:', response.data);
                
                if (response.data && Array.isArray(response.data.results)) {
                    const results = response.data.results;
                    
                    // Format and store the search results
                    setSearchResults(results.map(result => ({
                        id: result.id || result.channelId || '',
                        name: result.name || result.channelName || result.display_name || '',
                        icon: result.icon || result.logo || '',
                        source_name: result.source_name || 'Unknown',
                        source_id: result.source_id || '',
                        programCount: result.programCount || 0
                    })));
                    
                    if (results.length === 0) {
                        setSearchStatus(`No results found for "${term}"`);
                    } else {
                        setSearchStatus(`Found ${results.length} results for "${term}"`);
                    }
                } else {
                    // Handle invalid response format
                    console.warn('Invalid search response format:', response.data);
                    setSearchStatus(`Error: Unexpected response format`);
                    setSearchResults([]);
                    
                    // Still try the debug endpoint
                    throw new Error('Invalid search response format');
                }
            } catch (error) {
                console.error('Error searching EPG channels in session:', error);
                
                // Then try the debug API as fallback
                try {
                    console.log(`Falling back to debug search with term: "${term}"`);
                    const debugResponse = await axios.get(
                        `http://localhost:5001/api/debug/search-epg?term=${encodeURIComponent(term)}&_t=${Date.now()}`
                    );
                    
                    console.log('Debug search response:', debugResponse.data);
                    
                    if (debugResponse.data && Array.isArray(debugResponse.data.results)) {
                        const results = debugResponse.data.results;
                        
                        // Format and store the search results
                        setSearchResults(results.map(result => ({
                            id: result.id || result.channelId || '',
                            name: result.name || result.channelName || result.display_name || '',
                            icon: result.icon || result.logo || '',
                            source_name: result.source_name || 'Unknown',
                            source_id: result.source_id || '',
                            programCount: result.programCount || 0
                        })));
                        
                        if (results.length === 0) {
                            setSearchStatus(`No results found for "${term}" (debug search)`);
                        } else {
                            setSearchStatus(`Found ${results.length} results for "${term}" (debug search)`);
                        }
                    } else {
                        setSearchStatus(`No results found for "${term}". Try another search.`);
                        setSearchResults([]);
                    }
                } catch (fallbackError) {
                    console.error('Error in fallback debug search:', fallbackError);
                    setSearchStatus(`Error searching: ${error.message}`);
                }
            }
        } catch (error) {
            console.error('Error searching EPG channels:', error);
            setSearchStatus(`Error: ${error.message}`);
        } finally {
            setSearching(false);
        }
    };

    // Search for matching EPG IDs based on search term
    const searchEpgIds = () => {
        if (!epgSearch.trim()) {
            setSearchResults([]);
            return;
        }

        // Use the new search endpoint
        searchEpgChannels(epgSearch);
    };

    // Fetch EPG data for a specific channel ID
    const fetchEpgData = async (epgId) => {
        setLoading(true);
        setError(null);
        
        // Ensure we always have a string channelId, regardless of input format
        let channelId;
        if (epgId === null || epgId === undefined) {
            setError('Invalid EPG ID provided');
            setLoading(false);
            return;
        } else if (typeof epgId === 'object') {
            // Extract ID from object, with multiple fallbacks
            channelId = epgId.epgId || epgId.id || '';
            console.log(`Extracted channel ID from object: ${channelId}`, epgId);
        } else {
            // Convert to string if it's a primitive value
            channelId = String(epgId);
        }
        
        if (!channelId) {
            setError('Invalid EPG ID provided: No channel ID found');
            setLoading(false);
            return;
        }
        
        console.log(`Fetching EPG data for ID: ${channelId}`);
        
        try {
            const url = `http://localhost:5001/api/epg/${session}/?channelId=${encodeURIComponent(channelId)}`;
            console.log(`Making EPG data request to: ${url}`);
            
            const response = await axios.get(url);
            
            console.log('EPG Data response status:', response.status);
            console.log('EPG Data response headers:', response.headers);
            
            if (response.data && response.data.success) {
                console.log('EPG Data response:', response.data);
                setEpgData(response.data);
                
                // Extract source information
                if (response.data.sources && Array.isArray(response.data.sources)) {
                    setEpgSources(response.data.sources);
                }
                
                // Find current program
                const programs = response.data.programs || [];
                const currentProgram = findCurrentProgram(programs);
                setCurrentProgram(currentProgram);
                
                // Set source information for the current channel
                if (response.data.channel && response.data.channel.source_name) {
                    setSourceInfo({
                        name: response.data.channel.source_name,
                        id: response.data.channel.source_id,
                        programCount: programs.length
                    });
                }
                
                setError(null);
            } else {
                console.error('EPG Data error response:', response.data);
                const errorMsg = response.data?.error || 'Failed to fetch EPG data';
                setError(errorMsg);
                setEpgData(null);
                
                // Log more detailed error information
                if (response.data) {
                    console.error('EPG error details:', {
                        error: response.data.error,
                        channelId,
                        success: response.data.success,
                        message: response.data.message,
                    });
                }
            }
        } catch (error) {
            console.error('Error fetching EPG data:', error);
            let errorMessage = `Error: ${error.message}`;
            
            // Add more details for axios errors
            if (error.response) {
                errorMessage += ` (Status: ${error.response.status})`;
                console.error('EPG error response data:', error.response.data);
            }
            
            setError(errorMessage);
            setEpgData(null);
        } finally {
            setLoading(false);
        }
    };

    // Handle EPG match selection
    const handleMatch = (result) => {
        if (!result) return;
        
        console.log('Handling match with result:', result);
        
        // Format the EPG channel info with all required properties
        const epgChannel = {
            id: result.id || result.channelId || '',
            name: result.name || result.channelName || '',
            icon: result.icon || result.logo || null,
            source_name: result.source_name || result.sourceName || 'Unknown',
            source_id: result.sourceId || result.source_id || ''
        };
        
        console.log('Formatted EPG channel:', epgChannel);
        
        // Set the selected EPG ID for UI highlighting
        setSelectedEpgId(epgChannel.id);
        
        // Update matched channels if a channel is selected
        if (selectedChannel && onEpgMatch) {
            try {
                // Format the M3U channel info with all required properties
                const m3uChannel = {
                    id: selectedChannel.tvgId || selectedChannel.id || '',
                    name: selectedChannel.name || '',
                    logo: selectedChannel.logo || selectedChannel.tvgLogo || null,
                    url: selectedChannel.url || '',
                    group: selectedChannel.groupTitle || selectedChannel.group || ''
                };
                
                console.log('Formatted M3U channel:', m3uChannel);
                
                // Detailed logging for debugging
                console.log('Matching channels with full details:', { 
                    epgChannel: epgChannel,
                    m3uChannel: m3uChannel,
                    selectedChannel: selectedChannel
                });
                
                // Call the match endpoint on the backend
                axios.post(`http://localhost:5001/api/epg/${session}/match`, {
                    epgChannel,
                    m3uChannel
                })
                .then(response => {
                    console.log('Match saved:', response.data);
                    
                    // Clear search results
                    setSearchResults([]);
                    setSearchStatus('');
                    
                    // Update status
                    setStatus(`Successfully matched ${m3uChannel.name} to ${epgChannel.name} from ${epgChannel.source_name || 'unknown source'}`);
                    setStatusType('success');
                })
                .catch(error => {
                    console.error('Error saving match:', error.response || error);
                    const errorDetails = error.response?.data?.error || error.message;
                    console.error('Match error details:', errorDetails);
                    
                    setStatus(`Failed to match: ${errorDetails}`);
                    setStatusType('error');
                });
                
                // Call the callback to update the parent component with all properties
                onEpgMatch(m3uChannel.id, {
                    epgId: epgChannel.id,
                    epgName: epgChannel.name,
                    epgIcon: epgChannel.icon,
                    sourceName: epgChannel.source_name,
                    sourceId: epgChannel.source_id
                });
            } catch (error) {
                console.error('Error updating matched channels in session', error);
                setStatus(`Failed to match: ${error.message}`);
                setStatusType('error');
            }
        }

        // Re-fetch EPG data with the new ID
        fetchEpgData(epgChannel.id);
    };

    // Sort search results based on selected method
    const sortedSearchResults = () => {
        if (!searchResults || !searchResults.length) return [];

        // Filter results first if there's a filter active
        let filtered = searchResults;
        if (resultFilter && resultFilter.trim() !== '') {
            const filterLower = resultFilter.toLowerCase().trim();
            filtered = searchResults.filter(result => {
                // Build a comprehensive search text from all available fields
                const searchableText = [
                    // Channel info
                    result.channelName || result.name || '',
                    result.channelId || result.id || '',
                    // Source info
                    result.sourceId || result.source || '',
                    // Program info
                    result.title || '',
                    result.desc || result.description || '',
                    // Categories as a string
                    Array.isArray(result.categories) 
                        ? result.categories.map(c => typeof c === 'string' ? c : c.name || '').join(' ')
                        : ''
                ].join(' ').toLowerCase();
                
                // Check if any token in the filter matches
                const filterTokens = filterLower.split(/\s+/);
                return filterTokens.every(token => searchableText.includes(token));
            });
        }

        // Sort the filtered results
        return filtered.sort((a, b) => {
            if (resultSortMethod === 'name') {
                return (a.channelName || a.name || '').localeCompare(b.channelName || b.name || '');
            } else if (resultSortMethod === 'programs') {
                return (b.programCount || 0) - (a.programCount || 0);
            } else if (resultSortMethod === 'match' || resultSortMethod === 'score') {
                // If we have explicit scores, use them
                if (typeof b.score === 'number' && typeof a.score === 'number') {
                    return b.score - a.score;
                }
                // Otherwise sort by proximity of the search term to channel name
                const searchLower = epgSearch.toLowerCase();
                const aName = (a.channelName || a.name || '').toLowerCase();
                const bName = (b.channelName || b.name || '').toLowerCase();
                
                // Exact match gets highest priority
                if (aName === searchLower && bName !== searchLower) return -1;
                if (bName === searchLower && aName !== searchLower) return 1;
                
                // Starts with gets second priority
                if (aName.startsWith(searchLower) && !bName.startsWith(searchLower)) return -1;
                if (bName.startsWith(searchLower) && !aName.startsWith(searchLower)) return 1;
                
                // Contains gets third priority
                if (aName.includes(searchLower) && !bName.includes(searchLower)) return -1;
                if (bName.includes(searchLower) && !aName.includes(searchLower)) return 1;
                
                // Default to alphabetical
                return aName.localeCompare(bName);
            }
            return 0;
        });
    };

    // Handle search form submission
    const handleSearchSubmit = (e) => {
        e.preventDefault();
        if (epgSearch.trim()) {
            searchEpgChannels(epgSearch);
        }
    };

    // Format date for display
    const formatDate = (dateString) => {
        if (!dateString) return 'Unknown';
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                console.error('Invalid date string:', dateString);
                return 'Invalid Date';
            }
            
            // Format as "Apr 13, 2025"
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
        } catch (e) {
            console.error('Error formatting date:', e, dateString);
            return 'Invalid date';
        }
    };

    // Format time for display (e.g., "8:30 PM")
    const formatTime = (dateString) => {
        if (!dateString) return 'Unknown';
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                console.error('Invalid time string:', dateString);
                return 'Invalid Time';
            }
            
            // Format as "8:30 PM"
            return date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } catch (e) {
            console.error('Error formatting time:', e, dateString);
            return 'Invalid time';
        }
    };

    // Toggle debug mode
    const toggleDebug = () => {
        setDebugMode(!debugMode);
    };

    // Specialized component for safely rendering EPG sources
    const EpgSourcesDisplay = ({ sources, onClose }) => {
        // Safety check - make sure sources is an array
        const safeSources = Array.isArray(sources) ? sources : [];
        const sourceCount = safeSources.length;
        
        return (
            <div style={{
                padding: '10px',
                backgroundColor: '#f9f9f9',
                borderRadius: '4px',
                color: '#666',
                fontSize: '13px',
                maxHeight: '300px',
                overflowY: 'auto',
                position: 'relative'
            }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '10px'
                }}>
                    <h3 style={{ margin: 0, fontSize: '16px' }}>
                        {sourceCount} EPG Sources
                    </h3>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '16px'
                        }}
                    >
                        ×
                    </button>
                </div>
                
                {sourceCount === 0 ? (
                    <div>No EPG sources found</div>
                ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr>
                                <th style={{ textAlign: 'left', padding: '5px' }}>ID</th>
                                <th style={{ textAlign: 'left', padding: '5px' }}>Name</th>
                            </tr>
                        </thead>
                        <tbody>
                            {safeSources.map((source, index) => (
                                <tr key={source.id || index} style={{ 
                                    borderBottom: '1px solid #eee',
                                    backgroundColor: index % 2 === 0 ? '#f5f5f5' : 'white'
                                }}>
                                    <td style={{ padding: '5px' }}>{source.id}</td>
                                    <td style={{ padding: '5px' }}>{source.name}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        );
    };

    // Debug component for EPG troubleshooting - Completely rewritten for better data handling
    const EpgDebugPanel = ({ sessionId, epgSources }) => {
        const [showDebug, setShowDebug] = useState(false);
        
        if (!showDebug) {
            return (
                <div 
                    onClick={() => setShowDebug(true)}
                    style={{
                        padding: '8px 15px',
                        backgroundColor: '#f0f0f0',
                        borderRadius: '4px',
                        margin: '15px 0',
                        cursor: 'pointer',
                        fontSize: '12px',
                        color: '#666',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '5px'
                    }}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path>
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                    Show EPG Debug Info
                </div>
            );
        }
        
        return (
            <div style={{
                padding: '15px',
                backgroundColor: '#f8f9fa',
                border: '1px solid #ddd',
                borderRadius: '6px',
                margin: '15px 0',
                fontSize: '13px'
            }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '10px'
                }}>
                    <h4 style={{
                        margin: '0 0 10px 0',
                        color: '#333',
                        fontWeight: '500',
                        fontSize: '14px'
                    }}>EPG Debug Information</h4>
                    <button
                        onClick={() => setShowDebug(false)}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#666',
                            padding: '0',
                            display: 'flex',
                            alignItems: 'center'
                        }}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                
                <div style={{
                    backgroundColor: '#fff',
                    padding: '10px',
                    borderRadius: '4px',
                    marginBottom: '10px',
                    border: '1px solid #eee'
                }}>
                    <p style={{ margin: '0 0 5px 0', fontWeight: '500' }}>Session ID:</p>
                    <code style={{
                        display: 'block',
                        padding: '5px',
                        backgroundColor: '#f5f5f5',
                        borderRadius: '3px',
                        fontSize: '12px',
                        overflowX: 'auto'
                    }}>{typeof sessionId === 'string' ? sessionId : 'No session ID available'}</code>
                </div>
                
                <div style={{
                    backgroundColor: '#fff',
                    padding: '10px',
                    borderRadius: '4px',
                    border: '1px solid #eee'
                }}>
                    <p style={{ margin: '0 0 5px 0', fontWeight: '500' }}>
                        EPG Sources ({Array.isArray(epgSources) ? epgSources.length : 0}):
                    </p>
                    
                    <div style={{ maxHeight: '200px', overflow: 'auto' }}>
                        <EpgSourcesDisplay 
                            sources={safeFormattedEpgSources} 
                            onClose={() => {}} // No-op since this is just a display
                        />
                    </div>
                    
                    <div style={{
                        marginTop: '10px',
                        display: 'flex',
                        gap: '10px',
                        justifyContent: 'flex-end'
                    }}>
                        <button
                            onClick={async () => {
                                try {
                                    const initResponse = await axios.post(`http://localhost:5001/api/epg/init`, {
                                        sessionId: session
                                    });
                                    console.log('EPG session re-initialization response:', initResponse.data);
                                    alert('EPG session reinitialized. Check console for details.');
                                    
                                    // Re-fetch sources
                                    const sourcesResponse = await axios.get(`http://localhost:5001/api/epg/${session}/sources?_t=${Date.now()}`);
                                    if (sourcesResponse.data && sourcesResponse.data.sources) {
                                        console.log('Reloaded EPG sources:', sourcesResponse.data.sources);
                                        window.dispatchEvent(new CustomEvent('epgSourcesUpdated', { detail: sourcesResponse.data.sources }));
                                    }
                                } catch (error) {
                                    console.error('Error reinitializing EPG session:', error);
                                    alert(`Error: ${error.message}`);
                                }
                            }}
                            style={{
                                padding: '5px 10px',
                                backgroundColor: '#f5f5f5',
                                border: '1px solid #ddd',
                                borderRadius: '4px',
                                fontSize: '12px',
                                cursor: 'pointer'
                            }}
                        >
                            Reinitialize EPG Session
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    // Helper component for EPG data loading button
    const EpgDataLoader = ({ sessionId, onSuccess }) => {
        const [loading, setLoading] = useState(false);
        const [error, setError] = useState(null);
        
        const loadEpgData = async () => {
            if (!sessionId) {
                setError("No session ID available");
                return;
            }
            
            setLoading(true);
            setError(null);
            
            try {
                console.log('Manually loading EPG channel data from sources...');
                
                // First ensure the EPG session is initialized
                const initResponse = await fetch('/api/epg/init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId })
                });
                
                if (!initResponse.ok) {
                    throw new Error(`Failed to initialize EPG session: ${initResponse.status}`);
                }
                
                // Now load the EPG data
                const loadResponse = await fetch(`/api/epg/${sessionId}/load-data`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        loadAll: true, 
                        maxSources: 5,
                        memoryEfficient: true  // Add memory optimization option
                    })
                });
                
                if (!loadResponse.ok) {
                    throw new Error(`Failed to load EPG data: ${loadResponse.status}`);
                }
                
                const result = await loadResponse.json();
                console.log('EPG data load result:', result);
                
                if (onSuccess && typeof onSuccess === 'function') {
                    onSuccess();
                }
            } catch (err) {
                console.error('Error loading EPG data:', err);
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };
        
        return (
            <div style={{
                margin: '20px 0',
                padding: '15px',
                backgroundColor: '#e3f2fd',
                borderRadius: '8px',
                border: '1px solid #90caf9',
                textAlign: 'center'
            }}>
                <h4 style={{ margin: '0 0 10px 0', color: '#1565c0' }}>EPG Data Required</h4>
                <p style={{ margin: '0 0 15px 0' }}>
                    Your EPG sources are registered but have 0 channels loaded. You need to load EPG data before searching.
                </p>
                <button
                    onClick={loadEpgData}
                    disabled={loading}
                    style={{
                        padding: '10px 20px',
                        backgroundColor: '#1976d2',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        fontSize: '16px',
                        fontWeight: 'bold'
                    }}
                >
                    {loading ? 'Loading EPG Data...' : 'Load EPG Data From Sources'}
                </button>
                {error && (
                    <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>
                )}
                <p style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
                    This will download and parse 5 EPG sources (may take a few minutes)
                </p>
            </div>
        );
    };

    // Component to display the EPG program data
    const EpgProgramDisplay = () => {
        if (!epgData || !epgData.channel) return null;
        
        const { channel, programs } = epgData;
        
        return (
            <div style={{
                marginTop: '20px',
                border: '1px solid #e0e0e0',
                borderRadius: '8px',
                overflow: 'hidden'
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '12px',
                    backgroundColor: '#f5f5f5',
                    borderBottom: '1px solid #e0e0e0'
                }}>
                    {channel.icon && (
                        <img 
                            src={channel.icon} 
                            alt={channel.name} 
                            style={{
                                width: '32px',
                                height: '32px',
                                marginRight: '10px',
                                objectFit: 'contain'
                            }}
                            onError={(e) => { e.target.style.display = 'none' }}
                        />
                    )}
                    <div>
                        <h3 style={{ margin: '0 0 4px 0', fontWeight: '500' }}>{channel.name}</h3>
                        <div style={{ fontSize: '12px', color: '#666' }}>
                            Source: {channel.source_name || 'Unknown'} • ID: {channel.id}
                        </div>
                    </div>
                </div>
                
                {currentProgram && (
                    <div style={{
                        padding: '12px',
                        backgroundColor: '#e3f2fd',
                        borderBottom: '1px solid #bbdefb'
                    }}>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: '6px'
                        }}>
                            <h4 style={{ margin: 0, fontWeight: '500', color: '#1565c0' }}>
                                {currentProgram.title}
                                <span style={{
                                    marginLeft: '8px',
                                    fontSize: '11px',
                                    padding: '2px 6px',
                                    backgroundColor: '#1976d2',
                                    color: 'white',
                                    borderRadius: '10px',
                                    verticalAlign: 'middle'
                                }}>
                                    ON NOW
                                </span>
                            </h4>
                            <div style={{ fontSize: '13px', color: '#1976d2', fontWeight: '500' }}>
                                {formatTime(currentProgram.start)} - {formatTime(currentProgram.stop)}
                            </div>
                        </div>
                        {currentProgram.description && (
                            <div style={{ fontSize: '13px', color: '#333' }}>
                                {currentProgram.description}
                            </div>
                        )}
                    </div>
                )}
                
                {programs && programs.length > 0 ? (
                    <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                        {programs.map((program, index) => {
                            const isCurrentProgram = currentProgram && program.id === currentProgram.id;
                            if (isCurrentProgram && currentProgram) {
                                // Skip current program as it's already displayed above
                                return null;
                            }
                            
                            return (
                                <div 
                                    key={program.id || index} 
                                    style={{
                                        padding: '10px 12px',
                                        borderBottom: index < programs.length - 1 ? '1px solid #eee' : 'none',
                                        backgroundColor: index % 2 === 0 ? '#fafafa' : 'white',
                                        display: 'flex'
                                    }}
                                >
                                    <div style={{ width: '100px', flexShrink: 0 }}>
                                        <div style={{ fontSize: '13px', fontWeight: '500' }}>
                                            {formatTime(program.start)}
                                        </div>
                                        <div style={{ fontSize: '11px', color: '#666' }}>
                                            {formatDate(program.start)}
                                        </div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: '400' }}>
                                            {program.title}
                                        </div>
                                        {program.description && (
                                            <div style={{ 
                                                fontSize: '12px', 
                                                color: '#666',
                                                marginTop: '4px',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                display: '-webkit-box',
                                                WebkitLineClamp: 2,
                                                WebkitBoxOrient: 'vertical'
                                            }}>
                                                {program.description}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                        No program data available for this channel
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="epg-matcher-container" style={{
            marginTop: '20px',
            padding: '20px',
            border: '1px solid rgba(0, 0, 0, 0.1)',
            borderRadius: '8px',
            backgroundColor: '#ffffff',
            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.05)'
        }}>
            {/* Header with toggle buttons */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '15px',
                borderBottom: '1px solid #eee',
                paddingBottom: '10px'
            }}>
                <h3 style={{ margin: 0, color: '#333', fontWeight: '500' }}>EPG Information</h3>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                        onClick={toggleDebug}
                        style={{
                            padding: '6px 12px',
                            fontSize: '12px',
                            backgroundColor: debugMode ? '#6200ee' : '#f5f5f5',
                            color: debugMode ? 'white' : '#333',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease'
                        }}
                    >
                        {debugMode ? 'Hide Debug' : 'Debug'}
                    </button>
                </div>
            </div>

            {/* Show program data if available after a match */}
            {epgData && <EpgProgramDisplay />}

            {/* Error message */}
            {error && (
                <div style={{
                    padding: '15px',
                    marginBottom: '20px',
                    backgroundColor: '#ffebee',
                    borderRadius: '4px',
                    border: '1px solid #ffcdd2',
                    color: '#c62828'
                }}>
                    {error}
                </div>
            )}

            {/* Add prominent EPG Data Loader if needed */}
            {epgSources.length > 0 && 
             epgSources.every(source => !source.channelCount || source.channelCount === 0) && (
                <EpgDataLoader 
                    sessionId={session} 
                    onSuccess={fetchEpgSources}
                />
            )}

            {/* Search Form */}
            <div style={{
                marginBottom: '20px',
                padding: '15px',
                backgroundColor: '#f5f5f5',
                borderRadius: '8px'
            }}>
                <form onSubmit={handleSearchSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <input
                            type="text"
                            value={epgSearch}
                            onChange={(e) => setEpgSearch(e.target.value)}
                            placeholder="Search EPG channels..."
                            style={{
                                flex: 1,
                                padding: '10px 12px',
                                fontSize: '14px',
                                border: '1px solid #ddd',
                                borderRadius: '4px',
                                outline: 'none'
                            }}
                        />
                        <button
                            type="submit"
                            disabled={loading || !epgSearch.trim()}
                            style={{
                                padding: '10px 15px',
                                backgroundColor: '#1976d2',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: (loading || !epgSearch.trim()) ? 'not-allowed' : 'pointer',
                                fontSize: '14px',
                                fontWeight: '500',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px'
                            }}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                            {loading ? 'Searching...' : 'Search'}
                        </button>
                    </div>
                    
                    {suggestedIds.length > 0 && (
                        <div style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '5px',
                            marginTop: '5px'
                        }}>
                            <span style={{ fontSize: '12px', color: '#666', marginRight: '5px' }}>Suggestions:</span>
                            {suggestedIds.slice(0, 5).map((suggestion, index) => (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={() => {
                                        setEpgSearch(suggestion.id);
                                        searchEpgChannels(suggestion.id);
                                    }}
                                    style={{
                                        padding: '4px 8px',
                                        backgroundColor: '#e0e0e0',
                                        border: 'none',
                                        borderRadius: '12px',
                                        fontSize: '12px',
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    {suggestion.id}
                                </button>
                            ))}
                        </div>
                    )}
                </form>
            </div>

            {/* Search Results */}
            {searching ? (
                <div style={{ textAlign: 'center', padding: '20px' }}>
                    <div style={{ fontSize: '24px', marginBottom: '10px' }}>⏳</div>
                    <p>Searching EPG data...</p>
                </div>
            ) : searchResults && searchResults.length > 0 ? (
                <div style={{ marginBottom: '20px' }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '10px'
                    }}>
                        <h4 style={{ margin: 0 }}>Search Results</h4>
                        <span style={{ fontSize: '13px', color: '#666' }}>
                            {searchResults.length} matches found
                        </span>
                    </div>

                    {/* Add Filter and Sort Controls */}
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '10px',
                        backgroundColor: '#f5f5f5',
                        padding: '8px 12px',
                        borderRadius: '4px'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <label htmlFor="result-filter" style={{ fontSize: '13px', color: '#444' }}>Filter:</label>
                            <input
                                id="result-filter"
                                type="text"
                                value={resultFilter}
                                onChange={(e) => setResultFilter(e.target.value)}
                                placeholder="Filter results..."
                                style={{
                                    padding: '6px 8px',
                                    border: '1px solid #ddd',
                                    borderRadius: '4px',
                                    fontSize: '13px',
                                    width: '180px'
                                }}
                            />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <label htmlFor="result-sort" style={{ fontSize: '13px', color: '#444' }}>Sort by:</label>
                            <select
                                id="result-sort"
                                value={resultSortMethod}
                                onChange={(e) => setResultSortMethod(e.target.value)}
                                style={{
                                    padding: '6px 8px',
                                    border: '1px solid #ddd',
                                    borderRadius: '4px',
                                    fontSize: '13px',
                                    backgroundColor: 'white'
                                }}
                            >
                                <option value="match">Best Match</option>
                                <option value="name">Channel Name</option>
                                <option value="programs">Program Count</option>
                            </select>
                        </div>
                    </div>

                    <div style={{
                        maxHeight: '300px',
                        overflowY: 'auto',
                        border: '1px solid #eee',
                        borderRadius: '4px'
                    }}>
                        {sortedSearchResults().length > 0 ? (
                            sortedSearchResults().map((result, index) => (
                                <div
                                    key={index}
                                    style={{
                                        padding: '10px',
                                        borderBottom: index < sortedSearchResults().length - 1 ? '1px solid #eee' : 'none',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        backgroundColor: index % 2 === 0 ? '#f9f9f9' : 'white'
                                    }}
                                >
                                    <div>
                                        <div style={{ fontWeight: '500' }}>{result.channelName || result.name || result.channelId}</div>
                                        <div style={{ fontSize: '12px', color: '#666' }}>
                                            {result.sourceId || result.source} · ID: {result.channelId || result.id}
                                        </div>
                                        {result.title && (
                                            <div style={{ fontSize: '12px', color: '#006064', marginTop: '3px' }}>
                                                Current: {result.title}
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => handleMatch(result)}
                                        style={{
                                            padding: '6px 12px',
                                            backgroundColor: '#4caf50',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontSize: '13px'
                                        }}
                                    >
                                        Use This
                                    </button>
                                </div>
                            ))
                        ) : (
                            <div style={{ padding: '15px', textAlign: 'center', color: '#666' }}>
                                No results match your filter criteria
                            </div>
                        )}
                    </div>
                </div>
            ) : searchStatus ? (
                <div style={{
                    padding: '15px',
                    backgroundColor: '#fff3e0',
                    borderRadius: '4px',
                    marginBottom: '20px',
                    border: '1px solid #ffe0b2'
                }}>
                    <p style={{ margin: 0, color: '#e65100' }}>{searchStatus}</p>
                </div>
            ) : null}

            {/* Debug Panel (Collapsible) */}
            {debugMode && (
                <div style={{
                    padding: '12px',
                    background: '#f7f7f7',
                    borderRadius: '6px',
                    marginBottom: '15px',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    border: '1px solid #e0e0e0'
                }}>
                    <strong>Debug Info:</strong>
                    <div><strong>Session ID:</strong> {session || 'None'}</div>
                    <div><strong>EPG Sources:</strong> {safeFormattedEpgSources.length > 0 
                        ? `${safeFormattedEpgSources.length} unique sources (deduplicated from ${epgSources.length})` 
                        : 'None detected'}</div>
                    <div><strong>Selected Channel:</strong> {selectedChannel ? selectedChannel.name : 'None'}</div>
                    <div><strong>Channel ID:</strong> {selectedChannel ? selectedChannel.tvgId : 'None'}</div>
                    <div><strong>Current Source:</strong> {currentSource || 'None'}</div>
                    <div><strong>Matched EPG ID:</strong> {selectedChannel && matchedChannels[selectedChannel.tvgId] ? matchedChannels[selectedChannel.tvgId] : 'Not matched'}</div>
                    {epgData && (
                        <>
                            <div><strong>EPG Data:</strong></div>
                            <pre style={{ fontSize: '10px' }}>{JSON.stringify(epgData, null, 2)}</pre>
                        </>
                    )}
                </div>
            )}
            
            {/* Add the debug panel at the bottom */}
            <details style={{marginTop: '20px', border: '1px solid #ccc', borderRadius: '4px', padding: '10px'}}>
                <summary style={{fontWeight: 'bold', cursor: 'pointer'}}>EPG Debug Information</summary>
                <EpgDebugPanel sessionId={session} />
            </details>
        </div>
    );
};

export default EPGMatcher;