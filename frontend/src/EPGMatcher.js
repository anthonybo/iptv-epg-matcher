import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import apiClient from './utils/apiClient';
import StatusDisplay from './StatusDisplay';

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
const EPGMatcher = ({ sessionId, selectedChannel, onEpgMatch, matchedChannels = {}, compactMode = false }) => {
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
    const [dummyEpgAdded, setDummyEpgAdded] = useState(false);
    const [addedToGuide, setAddedToGuide] = useState(false);

    // Reset dummy EPG and add to guide state when channel changes
    useEffect(() => {
        setDummyEpgAdded(false);
        setAddedToGuide(false);
    }, [selectedChannel?.id]);

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
        // Try both tvgId and id as the channel identifier
        const channelIdentifier = selectedChannel.tvgId || selectedChannel.id;
        const matchedEpgId = channelIdentifier ? matchedChannels[channelIdentifier] : null;

        console.log('[EPGMatcher] Channel changed:', {
            channelId: channelIdentifier,
            matchedEpgId: matchedEpgId,
            hasSession: !!session
        });

        if (session && matchedEpgId) {
            fetchEpgData(matchedEpgId);
        } else if (channelIdentifier) {
            fetchEpgData(channelIdentifier);
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
                        programCount: result.programCount || 0,
                        currentProgram: result.currentProgram || result.current_program || null,
                        title: result.title || (result.currentProgram && result.currentProgram.title) || null
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
                            programCount: result.programCount || 0,
                            currentProgram: result.currentProgram || result.current_program || null,
                            title: result.title || (result.currentProgram && result.currentProgram.title) || null
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

    // Handle creating a dummy EPG match
    const handleDummyEpgMatch = async () => {
        if (!selectedChannel) return;

        console.log('Creating dummy EPG match for channel:', selectedChannel);

        // Set loading state
        setLoading(true);
        setStatus('Adding channel with dummy EPG...');
        setStatusType('info');

        // Create a dummy EPG channel with the channel's name as the ID
        const dummyEpgChannel = {
            id: `dummy_${selectedChannel.id || selectedChannel.tvgId || Date.now()}`,
            name: selectedChannel.name,
            icon: selectedChannel.logo || selectedChannel.tvgLogo || null,
            source_name: 'Dummy EPG',
            source_id: 'dummy'
        };

        // Format the M3U channel
        // IMPORTANT: Use channel.id (actual database ID like xtream_541950) NOT tvgId (EPG hint)
        const m3uChannel = {
            id: selectedChannel.id || selectedChannel.tvgId || '',
            name: selectedChannel.name || '',
            logo: selectedChannel.logo || selectedChannel.tvgLogo || null,
            url: selectedChannel.url || '',
            group: selectedChannel.groupTitle || selectedChannel.group || ''
        };

        console.log('Creating dummy match:', { dummyEpgChannel, m3uChannel });

        try {
            // Call the match endpoint with useDummyEpg=true (using apiClient for auth token)
            const response = await apiClient.post(`/epg/${session}/match`, {
                epgChannel: dummyEpgChannel,
                m3uChannel: m3uChannel,
                useDummyEpg: true
            });

            console.log('Dummy match saved:', response.data);

            // Update status with success message
            setStatus(`✓ Successfully added "${m3uChannel.name}" with dummy EPG! Go to IPTV Editor to see it.`);
            setStatusType('success');
            setDummyEpgAdded(true);

            // Clear search
            setSearchResults([]);
            setSearchStatus('');
            setEpgSearch('');

            // DON'T call onEpgMatch callback - it would trigger a duplicate match
            // The channel is already saved to the database, just update UI state if needed
        } catch (error) {
            console.error('Error creating dummy match:', error.response || error);
            setStatus(`Failed to add dummy EPG: ${error.response?.data?.error || error.message}`);
            setStatusType('error');
        } finally {
            setLoading(false);
        }
    };

    // Handle adding channel to Guide/IPTV Editor
    const handleAddToGuide = async () => {
        if (!selectedChannel) return;

        console.log('Adding channel to Guide:', selectedChannel);

        // Check if there's EPG data available
        if (!epgData || !epgData.channel) {
            setStatus('Please match this channel to an EPG source first, or use "Use Dummy EPG" to add without EPG data.');
            setStatusType('error');
            return;
        }

        // Set loading state
        setLoading(true);
        setStatus('Adding channel to Guide...');
        setStatusType('info');

        // Format the EPG channel from current EPG data
        const epgChannel = {
            id: epgData.channel.id || epgData.channel.channelId || '',
            name: epgData.channel.name || epgData.channel.channelName || '',
            icon: epgData.channel.icon || epgData.channel.logo || null,
            source_name: epgData.channel.source_name || epgData.channel.sourceName || 'Unknown',
            source_id: epgData.channel.source_id || epgData.channel.sourceId || ''
        };

        // Format the M3U channel
        // IMPORTANT: Use channel.id (actual database ID like xtream_541950) NOT tvgId (EPG hint)
        const m3uChannel = {
            id: selectedChannel.id || selectedChannel.tvgId || '',
            name: selectedChannel.name || '',
            logo: selectedChannel.logo || selectedChannel.tvgLogo || null,
            url: selectedChannel.url || '',
            group: selectedChannel.groupTitle || selectedChannel.group || '',
            sourceId: selectedChannel.sourceId || null
        };

        console.log('Adding to Guide:', { epgChannel, m3uChannel, selectedChannelDebug: selectedChannel });

        try {
            // Call the match endpoint to save (using apiClient for auth token)
            const response = await apiClient.post(`/epg/${session}/match`, {
                epgChannel: epgChannel,
                m3uChannel: m3uChannel,
                useDummyEpg: false
            });

            console.log('Channel added to Guide:', response.data);

            // Update status with success message
            setStatus(`✓ Successfully added "${m3uChannel.name}" to Guide! Check IPTV Editor to see it.`);
            setStatusType('success');
            setAddedToGuide(true);

        } catch (error) {
            console.error('Error adding channel to Guide:', error.response || error);
            setStatus(`Failed to add to Guide: ${error.response?.data?.error || error.message}`);
            setStatusType('error');
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

                // Call the match endpoint on the backend (using apiClient for auth token)
                apiClient.post(`/epg/${session}/match`, {
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

                // DON'T call onEpgMatch callback - it would trigger a duplicate match
                // The match is already saved to the database by the API call above
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
            <div className="relative max-h-[300px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
                <div className="mb-4 flex items-center justify-between">
                    <h3 className="m-0 text-base font-semibold text-slate-100">
                        {sourceCount} EPG Sources
                    </h3>
                    <button
                        onClick={onClose}
                        className="cursor-pointer border-none bg-transparent text-xl text-slate-400 transition hover:text-slate-100"
                    >
                        ×
                    </button>
                </div>

                {sourceCount === 0 ? (
                    <div className="text-slate-500">No EPG sources found</div>
                ) : (
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="border-b border-slate-800">
                                <th className="p-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">ID</th>
                                <th className="p-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Name</th>
                            </tr>
                        </thead>
                        <tbody>
                            {safeSources.map((source, index) => (
                                <tr
                                    key={source.id || index}
                                    className={`border-b border-slate-800/50 ${index % 2 === 0 ? 'bg-slate-950/40' : 'bg-slate-900/40'}`}
                                >
                                    <td className="p-2 text-slate-300">{source.id}</td>
                                    <td className="p-2 text-slate-300">{source.name}</td>
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
                    className="my-4 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-4 py-2 text-xs text-slate-400 transition hover:border-slate-600 hover:bg-slate-900 hover:text-slate-200"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path>
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                    Show EPG Debug Info
                </div>
            );
        }

        return (
            <div className="my-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
                <div className="mb-4 flex items-center justify-between">
                    <h4 className="mb-0 text-sm font-medium text-slate-100">EPG Debug Information</h4>
                    <button
                        onClick={() => setShowDebug(false)}
                        className="flex cursor-pointer items-center border-none bg-transparent p-0 text-slate-400 transition hover:text-slate-100"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>

                <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <p className="mb-2 font-medium text-slate-300">Session ID:</p>
                    <code className="block overflow-x-auto rounded bg-slate-950/80 p-2 text-xs text-slate-400">
                        {typeof sessionId === 'string' ? sessionId : 'No session ID available'}
                    </code>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <p className="mb-2 font-medium text-slate-300">
                        EPG Sources ({Array.isArray(epgSources) ? epgSources.length : 0}):
                    </p>

                    <div className="max-h-[200px] overflow-auto">
                        <EpgSourcesDisplay
                            sources={safeFormattedEpgSources}
                            onClose={() => {}} // No-op since this is just a display
                        />
                    </div>

                    <div className="mt-3 flex justify-end gap-3">
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
                            className="cursor-pointer rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs transition hover:border-slate-600 hover:bg-slate-900 hover:text-slate-100"
                        >
                            Reinitialize EPG Session
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    // Component to display the EPG program data
    const EpgProgramDisplay = () => {
        if (!epgData || !epgData.channel) return null;

        const { channel, programs } = epgData;

        return (
            <div className={compactMode ? "flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40" : "mt-6 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40"}>
                <div className="flex flex-shrink-0 items-center border-b border-slate-800 bg-slate-900/60 p-4">
                    {channel.icon && (
                        <img
                            src={channel.icon}
                            alt={channel.name}
                            className="mr-3 h-8 w-8 object-contain"
                            onError={(e) => { e.target.style.display = 'none' }}
                        />
                    )}
                    <div>
                        <h3 className="mb-1 font-medium text-slate-100">{channel.name}</h3>
                        <div className="text-xs text-slate-500">
                            Source: {channel.source_name || 'Unknown'} • ID: {channel.id}
                        </div>
                    </div>
                </div>

                {currentProgram && (
                    <div className="flex-shrink-0 border-b border-emerald-500/30 bg-emerald-500/10 p-4">
                        <div className="mb-2 flex justify-between">
                            <h4 className="m-0 font-medium text-emerald-100">
                                {currentProgram.title}
                                <span className="ml-2 inline-block rounded-full bg-emerald-500 px-2 py-0.5 align-middle text-[11px] text-white">
                                    ON NOW
                                </span>
                            </h4>
                            <div className="text-sm font-medium text-emerald-200">
                                {formatTime(currentProgram.start)} - {formatTime(currentProgram.stop)}
                            </div>
                        </div>
                        {currentProgram.description && (
                            <div className="text-sm text-emerald-100/90">
                                {currentProgram.description}
                            </div>
                        )}
                    </div>
                )}

                {programs && programs.length > 0 ? (
                    <div className={compactMode ? "flex-1 overflow-y-auto" : "max-h-[300px] overflow-y-auto"}>
                        {programs.map((program, index) => {
                            const isCurrentProgram = currentProgram && program.id === currentProgram.id;
                            if (isCurrentProgram && currentProgram) {
                                // Skip current program as it's already displayed above
                                return null;
                            }

                            return (
                                <div
                                    key={program.id || index}
                                    className={`flex border-b border-slate-800/50 p-3 ${index % 2 === 0 ? 'bg-slate-950/40' : 'bg-slate-900/40'}`}
                                >
                                    <div className="w-24 flex-shrink-0">
                                        <div className="text-sm font-medium text-slate-300">
                                            {formatTime(program.start)}
                                        </div>
                                        <div className="text-xs text-slate-500">
                                            {formatDate(program.start)}
                                        </div>
                                    </div>
                                    <div className="flex-1">
                                        <div className="font-normal text-slate-200">
                                            {program.title}
                                        </div>
                                        {program.description && (
                                            <div className="mt-1 line-clamp-2 text-xs text-slate-400">
                                                {program.description}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="p-6 text-center text-slate-500">
                        No program data available for this channel
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className={compactMode ? "epg-matcher-container flex h-full flex-col overflow-hidden p-3" : "epg-matcher-container mt-6 rounded-2xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl backdrop-blur"}>
            {/* Header - Hidden in compact mode */}
            {!compactMode && (
                <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
                    <h3 className="m-0 text-xl font-semibold text-slate-100">EPG Information</h3>
                </div>
            )}

            {/* Show program data if available after a match */}
            {epgData && <EpgProgramDisplay />}

            {/* Error message */}
            {error && (
                <div className={compactMode ? "mb-3" : "mb-6"}>
                    <StatusDisplay message={error} type="error" />
                </div>
            )}

            {/* Status message (success/info/warning) */}
            {status && statusType !== 'error' && (
                <div className={compactMode ? "mb-3" : "mb-6"}>
                    <StatusDisplay message={status} type={statusType} />
                </div>
            )}

            {/* Search Form - Hidden in compact mode (already watching a channel) */}
            {!compactMode && (
            <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-inner">
                <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                        <input
                            type="text"
                            value={epgSearch}
                            onChange={(e) => setEpgSearch(e.target.value)}
                            placeholder="Search EPG channels..."
                            className="flex-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-500"
                        />
                        <button
                            type="submit"
                            disabled={loading || !epgSearch.trim()}
                            className="inline-flex items-center gap-2 rounded-lg border border-teal-500/60 bg-teal-500/20 px-4 py-2 text-sm font-semibold text-teal-100 transition hover:border-teal-400 hover:bg-teal-500/30 focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-800/60 disabled:text-slate-500"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                            {loading ? 'Searching...' : 'Search'}
                        </button>
                    </div>

                    {/* Add to Guide Button */}
                    {epgData && epgData.channel && (
                        <div className="flex items-center gap-3 pt-3 border-t border-slate-800">
                            <div className="flex-1 text-xs text-slate-400">
                                Channel has EPG data. Add it to your Guide/IPTV Editor.
                            </div>
                            <button
                                type="button"
                                onClick={handleAddToGuide}
                                disabled={!selectedChannel || loading || addedToGuide}
                                className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 ${
                                    addedToGuide
                                        ? 'border-green-500/60 bg-green-500/20 text-green-100 cursor-default'
                                        : 'border-emerald-500/60 bg-emerald-500/20 text-emerald-100 hover:border-emerald-400 hover:bg-emerald-500/30 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-800/60 disabled:text-slate-500'
                                }`}
                                title={addedToGuide ? "Channel added! Check IPTV Editor" : "Add this channel with its EPG data to your Guide"}
                            >
                                {loading ? (
                                    <>
                                        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Adding...
                                    </>
                                ) : addedToGuide ? (
                                    <>
                                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                        </svg>
                                        Added to Guide!
                                    </>
                                ) : (
                                    <>
                                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                                        </svg>
                                        Add to Guide
                                    </>
                                )}
                            </button>
                        </div>
                    )}

                    {/* Use Dummy EPG Button */}
                    <div className="flex items-center gap-3 pt-3 border-t border-slate-800">
                        <div className="flex-1 text-xs text-slate-400">
                            Can't find a match? Add this channel with dummy EPG data instead.
                        </div>
                        <button
                            type="button"
                            onClick={handleDummyEpgMatch}
                            disabled={!selectedChannel || loading || dummyEpgAdded}
                            className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 ${
                                dummyEpgAdded
                                    ? 'border-green-500/60 bg-green-500/20 text-green-100 cursor-default'
                                    : 'border-purple-500/60 bg-purple-500/20 text-purple-100 hover:border-purple-400 hover:bg-purple-500/30 focus:ring-purple-500 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-800/60 disabled:text-slate-500'
                            }`}
                            title={dummyEpgAdded ? "Channel added! Check IPTV Editor" : "Add channel with dummy EPG (shows channel name as program info)"}
                        >
                            {loading ? (
                                <>
                                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Adding...
                                </>
                            ) : dummyEpgAdded ? (
                                <>
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    Added!
                                </>
                            ) : (
                                <>
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                    </svg>
                                    Use Dummy EPG
                                </>
                            )}
                        </button>
                    </div>

                    {suggestedIds.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="mr-2 text-xs text-slate-500">Suggestions:</span>
                            {suggestedIds.slice(0, 5).map((suggestion, index) => (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={() => {
                                        setEpgSearch(suggestion.id);
                                        searchEpgChannels(suggestion.id);
                                    }}
                                    className="cursor-pointer whitespace-nowrap rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900 hover:text-white"
                                >
                                    {suggestion.id}
                                </button>
                            ))}
                        </div>
                    )}
                </form>
            </div>
            )}

            {/* Search Results - Hidden in compact mode */}
            {!compactMode && (searching ? (
                <div className="py-5 text-center">
                    <div className="mb-2 text-2xl">⏳</div>
                    <p className="text-slate-400">Searching EPG data...</p>
                </div>
            ) : searchResults && searchResults.length > 0 ? (
                <div className="mb-5">
                    <div className="mb-3 flex items-center justify-between">
                        <h4 className="m-0 text-lg font-semibold text-slate-100">Search Results</h4>
                        <span className="text-sm text-slate-400">
                            {searchResults.length} {searchResults.length === 1 ? 'match' : 'matches'} found
                        </span>
                    </div>

                    {/* Filter and Sort Controls */}
                    <div className="mb-3 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                        <div className="flex items-center gap-2">
                            <label htmlFor="result-filter" className="text-sm font-medium text-slate-400">Filter:</label>
                            <input
                                id="result-filter"
                                type="text"
                                value={resultFilter}
                                onChange={(e) => setResultFilter(e.target.value)}
                                placeholder="Filter results..."
                                className="w-48 rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-500"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <label htmlFor="result-sort" className="text-sm font-medium text-slate-400">Sort by:</label>
                            <select
                                id="result-sort"
                                value={resultSortMethod}
                                onChange={(e) => setResultSortMethod(e.target.value)}
                                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-500"
                            >
                                <option value="match">Best Match</option>
                                <option value="name">Channel Name</option>
                                <option value="programs">Program Count</option>
                            </select>
                        </div>
                    </div>

                    <div className="max-h-[400px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/40 shadow-sm">
                        {sortedSearchResults().length > 0 ? (
                            sortedSearchResults().map((result, index) => (
                                <div
                                    key={index}
                                    className={`flex items-center justify-between gap-4 p-3 transition-colors ${
                                        index < sortedSearchResults().length - 1 ? 'border-b border-slate-800/50' : ''
                                    } ${index % 2 === 0 ? 'bg-slate-950/40' : 'bg-slate-900/40'} hover:bg-slate-800/50`}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium text-slate-100">
                                            {result.channelName || result.name || result.channelId}
                                        </div>
                                        <div className="mt-0.5 flex items-center gap-2 text-sm text-slate-400">
                                            <span className="inline-flex items-center rounded bg-teal-500/20 px-2 py-0.5 text-xs font-medium text-teal-200">
                                                {result.source_name || 'Unknown Source'}
                                            </span>
                                            <span className="text-slate-700">·</span>
                                            <span className="truncate text-slate-500">ID: {result.channelId || result.id}</span>
                                        </div>
                                        {(result.title || result.currentProgram) && (
                                            <div className="mt-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1">
                                                <div className="flex items-start gap-1.5">
                                                    <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                    </svg>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-xs font-medium text-emerald-200">
                                                            Currently Playing:
                                                        </div>
                                                        <div className="truncate text-sm font-medium text-emerald-100">
                                                            {result.currentProgram?.title || result.title}
                                                        </div>
                                                        {result.currentProgram?.start && result.currentProgram?.stop && (
                                                            <div className="mt-0.5 text-xs text-emerald-200/80">
                                                                {new Date(result.currentProgram.start).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} - {new Date(result.currentProgram.stop).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => handleMatch(result)}
                                        className="flex-shrink-0 rounded-md border border-emerald-500/60 bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:border-emerald-400 hover:bg-emerald-500/30 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    >
                                        Use This
                                    </button>
                                </div>
                            ))
                        ) : (
                            <div className="p-4 text-center text-slate-500">
                                No results match your filter criteria
                            </div>
                        )}
                    </div>
                </div>
            ) : searchStatus ? (
                <div className="mb-6">
                    <StatusDisplay message={searchStatus} type="warning" />
                </div>
            ) : null)}

            {/* Debug Panel (Collapsible) - Hidden in compact mode */}
            {!compactMode && debugMode && (
                <div className="mb-4 max-h-[200px] overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/60 p-3 font-mono text-xs">
                    <strong className="text-slate-200">Debug Info:</strong>
                    <div className="text-slate-400"><strong className="text-slate-300">Session ID:</strong> {session || 'None'}</div>
                    <div className="text-slate-400"><strong className="text-slate-300">EPG Sources:</strong> {safeFormattedEpgSources.length > 0
                        ? `${safeFormattedEpgSources.length} unique sources (deduplicated from ${epgSources.length})`
                        : 'None detected'}</div>
                    <div className="text-slate-400"><strong className="text-slate-300">Selected Channel:</strong> {selectedChannel ? selectedChannel.name : 'None'}</div>
                    <div className="text-slate-400"><strong className="text-slate-300">Channel ID:</strong> {selectedChannel ? selectedChannel.tvgId : 'None'}</div>
                    <div className="text-slate-400"><strong className="text-slate-300">Current Source:</strong> {currentSource || 'None'}</div>
                    <div className="text-slate-400"><strong className="text-slate-300">Matched EPG ID:</strong> {selectedChannel && matchedChannels[selectedChannel.tvgId] ? matchedChannels[selectedChannel.tvgId] : 'Not matched'}</div>
                    {epgData && (
                        <>
                            <div className="text-slate-300"><strong>EPG Data:</strong></div>
                            <pre className="text-[10px] text-slate-400">{JSON.stringify(epgData, null, 2)}</pre>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default EPGMatcher;