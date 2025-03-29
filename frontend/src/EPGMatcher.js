import React, { useState, useEffect } from 'react';
import axios from 'axios';

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
    // State management
    const [epgSearch, setEpgSearch] = useState('');
    const [epgData, setEpgData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [suggestedIds, setSuggestedIds] = useState([]);
    const [searchResults, setSearchResults] = useState([]);
    const [error, setError] = useState(null);
    const [debugMode, setDebugMode] = useState(false);
    const [epgSources, setEpgSources] = useState([]);
    const [alternateMatches, setAlternateMatches] = useState([]);
    const [currentSource, setCurrentSource] = useState(null);
    const [channelInfo, setChannelInfo] = useState(null);
    const [selectedEpgId, setSelectedEpgId] = useState(null);
    const [resultSortMethod, setResultSortMethod] = useState('programCount'); // 'programCount', 'name', 'source'
    const [resultFilter, setResultFilter] = useState('');
    const [statusType, setStatusType] = useState('info'); // 'info', 'success', 'error', 'warning'

    // Initialize component and fetch EPG sources
    useEffect(() => {
        if (sessionId) {
            // Extract loaded sources from storage if available
            try {
                axios.get(`http://localhost:5001/api/epg/${sessionId}/sources`)
                    .then(response => {
                        if (response.data && response.data.sources) {
                            setEpgSources(response.data.sources);
                        }
                    })
                    .catch(() => {
                        // Sources endpoint doesn't exist, use placeholder
                        setEpgSources(['Default EPG Source']);
                    });
            } catch (error) {
                console.log('EPG sources API error');
            }
        }
    }, [sessionId]);

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
        if (sessionId && matchedChannels[selectedChannel.tvgId]) {
            fetchEpgData(matchedChannels[selectedChannel.tvgId]);
        } else {
            fetchEpgData(selectedChannel.tvgId);
        }
    }, [sessionId, selectedChannel, matchedChannels]);

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

    // Search for EPG channels
    const searchEpgChannels = async (searchTerm) => {
        if (!sessionId || !searchTerm.trim()) return;

        setLoading(true);
        setError(null);

        try {
            console.log(`Searching for EPG channels: ${searchTerm}`);
            const response = await axios.get(`http://localhost:5001/api/epg/${sessionId}/search?term=${encodeURIComponent(searchTerm)}`);
            console.log('EPG Search response:', response.data);

            if (response.data && response.data.sources) {
                // Flatten the results for easier display
                const results = [];

                Object.keys(response.data.sources).forEach(sourceKey => {
                    const source = response.data.sources[sourceKey];
                    source.matches.forEach(match => {
                        // Get the most appropriate display name
                        let displayName = match.id;
                        if (match.displayNames && match.displayNames.length > 0) {
                            // Prefer English names if available
                            const englishName = match.displayNames.find(n => n.lang === 'en');
                            if (englishName) {
                                displayName = englishName.name;
                            } else {
                                displayName = match.displayNames[0].name;
                            }
                        }

                        results.push({
                            id: match.id,
                            name: displayName,
                            sourceKey: sourceKey,
                            icon: match.icon,
                            programCount: match.programCount || 0
                        });
                    });
                });

                // Sort by program count (most programs first)
                results.sort((a, b) => b.programCount - a.programCount);

                setSearchResults(results);

                if (results.length === 0) {
                    setError(`No channels found matching "${searchTerm}"`);
                }
            } else {
                setSearchResults([]);
                setError(`No results found for "${searchTerm}"`);
            }
        } catch (error) {
            console.error('Error searching EPG channels:', error);
            setError(`Error searching EPG channels: ${error.message}`);
            setSearchResults([]);
        } finally {
            setLoading(false);
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

    // Fetch EPG data for a channel ID
    // Function to fetch EPG data with better validation
    const fetchEpgData = async (epgId) => {
        if (!sessionId || !epgId) return;

        setLoading(true);
        setError(null);
        setSearchResults([]);

        try {
            console.log(`Fetching EPG data for ID: ${epgId}`);
            const response = await axios.get(`http://localhost:5001/api/epg/${sessionId}?channelId=${encodeURIComponent(epgId)}`);
            console.log('EPG Data response:', response.data);

            if (response.data) {
                // Validate that the EPG data matches what we requested
                let isValidMatch = true;
                let mismatchReason = '';

                // Check if the channel info exists and has the right ID
                if (response.data.channelInfo) {
                    const channelInfo = response.data.channelInfo;

                    // If the EPG ID uses the format "source.name", extract the actual ID part
                    const epgIdParts = epgId.match(/^([a-zA-Z0-9]+)\.(.+)$/);
                    const actualEpgId = epgIdParts ? epgIdParts[2] : epgId;

                    // Check if the returned channel ID matches what we requested
                    // Consider both exact match and normalized versions
                    const channelId = channelInfo.id;
                    const normalizedRequestedId = actualEpgId.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const normalizedReturnedId = channelId.toLowerCase().replace(/[^a-z0-9]/g, '');

                    // Check if IDs match exactly or in normalized form
                    if (channelId !== actualEpgId &&
                        normalizedReturnedId !== normalizedRequestedId) {

                        // Additional validation for network names
                        if (actualEpgId.toLowerCase().includes('network') &&
                            !channelId.toLowerCase().includes('network')) {

                            // Extract network name from EPG ID
                            const networkName = actualEpgId.replace(/network$/i, '').trim().toLowerCase();

                            // If the channel doesn't contain the network name, it's likely a mismatch
                            if (!channelId.toLowerCase().includes(networkName) &&
                                !channelInfo.displayNames.some(dn =>
                                    dn.name && dn.name.toLowerCase().includes(networkName))) {

                                isValidMatch = false;
                                mismatchReason = `Requested "${epgId}" but got "${channelId}" which doesn't appear to be the same network`;
                            }
                        }
                        // If names don't match at all, warn about potential mismatch
                        else if (!channelId.toLowerCase().includes(actualEpgId.toLowerCase()) &&
                            !actualEpgId.toLowerCase().includes(channelId.toLowerCase())) {

                            isValidMatch = false;
                            mismatchReason = `Requested "${epgId}" but got "${channelId}"`;
                        }
                    }
                }

                // Handle mismatch if detected
                if (!isValidMatch) {
                    setError(`Potential EPG mismatch: ${mismatchReason}. The data shown may be for a different channel than requested.`);
                    setStatusType('warning');

                    // Still set the data, but warn the user
                    setEpgData(response.data);
                } else {
                    // Set data normally
                    setEpgData(response.data);
                }

                // Check if we have any program data
                const hasPrograms = response.data.programs && response.data.programs.length > 0;
                const hasCurrentProgram = response.data.currentProgram != null;

                if (!hasPrograms && !hasCurrentProgram) {
                    if (isValidMatch) {
                        setError(`No EPG data found for ID: ${epgId}. Try matching with a different ID.`);
                    }
                }

                // If there are other matches, show them to the user
                if (response.data.otherMatches && response.data.otherMatches.length > 0) {
                    setAlternateMatches(response.data.otherMatches);
                } else {
                    setAlternateMatches([]);
                }

                // Set source information if available
                if (response.data.sourceKey) {
                    setCurrentSource(response.data.sourceKey);
                }

                // Set channel info if available
                if (response.data.channelInfo) {
                    setChannelInfo(response.data.channelInfo);
                }
            } else {
                setEpgData(null);
                setError(`No EPG data returned for ID: ${epgId}`);
            }
        } catch (error) {
            console.error('Error fetching EPG data:', error);
            setError(`Error fetching EPG data: ${error.message}`);
            setEpgData(null);
        } finally {
            setLoading(false);
        }
    };

    // Switch to an alternate match
    const switchToAlternateMatch = async (match) => {
        if (!match.sourceKey || !match.channelId) return;

        setLoading(true);
        setError(null);

        try {
            console.log(`Switching to alternate channel: ${match.channelId} from source ${match.sourceKey}`);
            const response = await axios.get(`http://localhost:5001/api/epg/${sessionId}/channel/${match.sourceKey}/${encodeURIComponent(match.channelId)}`);
            console.log('EPG Data response:', response.data);

            if (response.data) {
                setEpgData({
                    currentProgram: response.data.currentProgram,
                    programs: response.data.programs,
                    channelInfo: response.data.channelInfo,
                    sourceKey: match.sourceKey
                });

                // Update state
                setCurrentSource(match.sourceKey);
                if (response.data.channelInfo) {
                    setChannelInfo(response.data.channelInfo);
                }

                // Call the match handler with the new channel ID
                if (selectedChannel) {
                    onEpgMatch(selectedChannel.tvgId, match.channelId);
                }
            } else {
                setError(`No EPG data returned for channel ${match.channelId}`);
            }
        } catch (error) {
            console.error('Error fetching alternate channel:', error);
            setError(`Error fetching alternate channel: ${error.message}`);
        } finally {
            setLoading(false);
        }
    };

    /**
     * Handle matching a channel with EPG data
     * Enhanced to update the matchedChannels in the session on the server
     */
    const handleMatch = (epgId) => {
        if (!selectedChannel || !epgId) return;

        // Store the selected ID
        setSelectedEpgId(epgId);

        // Update the search field to show the selected ID
        setEpgSearch(epgId);

        // Call the parent component's match handler
        onEpgMatch(selectedChannel.tvgId, epgId);

        // IMPORTANT NEW CODE: Update the matched channels in the session
        // This ensures the streaming component can find the right channel
        if (sessionId) {
            try {
                // Send the match to the server to update the session
                axios.post(`http://localhost:5001/api/epg/${sessionId}/match`, {
                    channelId: selectedChannel.tvgId,
                    epgId: epgId
                }).then(response => {
                    console.log('Updated matched channels in session', response.data);
                }).catch(error => {
                    console.error('Failed to update matched channels in session', error);
                });
            } catch (error) {
                console.error('Error updating matched channels in session', error);
            }
        }

        // Re-fetch EPG data with the new ID
        fetchEpgData(epgId);

        // Clear search results
        setSearchResults([]);
    };

    // Sort search results based on selected method
    const sortedSearchResults = () => {
        if (!searchResults.length) return [];

        // Filter results first if there's a filter active
        let filtered = searchResults;
        if (resultFilter) {
            const filterLower = resultFilter.toLowerCase();
            filtered = searchResults.filter(result =>
                result.name.toLowerCase().includes(filterLower) ||
                result.id.toLowerCase().includes(filterLower) ||
                result.sourceKey.toLowerCase().includes(filterLower)
            );
        }

        // Then sort them
        return [...filtered].sort((a, b) => {
            switch (resultSortMethod) {
                case 'name':
                    return a.name.localeCompare(b.name);
                case 'source':
                    return a.sourceKey.localeCompare(b.sourceKey);
                case 'programCount':
                default:
                    return b.programCount - a.programCount;
            }
        });
    };

    // Format date for display
    const formatDate = (dateString) => {
        if (!dateString) return 'Unknown';
        try {
            const date = new Date(dateString);
            return date.toLocaleString();
        } catch (e) {
            return 'Invalid date';
        }
    };

    // Toggle debug mode
    const toggleDebug = () => {
        setDebugMode(!debugMode);
    };

    return (
        <div className="epg-matcher" style={{
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
                    <div><strong>Session ID:</strong> {sessionId || 'None'}</div>
                    <div><strong>EPG Sources:</strong> {epgSources.length > 0 ? epgSources.join(', ') : 'None detected'}</div>
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

            {selectedChannel ? (
                <>
                    {/* Current Channel Info Card */}
                    <div className="current-channel-info" style={{
                        marginBottom: '20px',
                        padding: '15px',
                        backgroundColor: '#f5f8ff',
                        borderRadius: '8px',
                        border: '1px solid #e6eeff'
                    }}>
                        <h4 style={{
                            margin: '0 0 10px 0',
                            color: '#1a73e8',
                            fontWeight: '500'
                        }}>{selectedChannel.name}</h4>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
                            <div>
                                <span style={{ color: '#666', fontSize: '13px' }}>Channel ID:</span>
                                <div style={{ fontWeight: '500' }}>{selectedChannel.tvgId}</div>
                            </div>
                            <div>
                                <span style={{ color: '#666', fontSize: '13px' }}>Group:</span>
                                <div style={{ fontWeight: '500' }}>{selectedChannel.groupTitle}</div>
                            </div>
                            {matchedChannels[selectedChannel.tvgId] && (
                                <div>
                                    <span style={{ color: '#666', fontSize: '13px' }}>Matched EPG ID:</span>
                                    <div style={{ fontWeight: '500', color: '#0b8043' }}>{matchedChannels[selectedChannel.tvgId]}</div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* EPG Matching Section */}
                    <div className="epg-match" style={{ marginBottom: '20px' }}>
                        <h4 style={{
                            margin: '0 0 15px 0',
                            color: '#333',
                            fontWeight: '500',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}>
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                            Match with EPG Source
                        </h4>

                        {/* Search field with match button */}
                        <div style={{ marginBottom: '20px' }}>
                            <div style={{
                                display: 'flex',
                                marginBottom: '10px',
                                gap: '10px'
                            }}>
                                <div style={{ flex: 1, position: 'relative' }}>
                                    <svg
                                        style={{
                                            position: 'absolute',
                                            left: '10px',
                                            top: '50%',
                                            transform: 'translateY(-50%)',
                                            color: '#666'
                                        }}
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="16"
                                        height="16"
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
                                    <input
                                        type="text"
                                        placeholder="Search for EPG ID..."
                                        value={epgSearch}
                                        onChange={(e) => setEpgSearch(e.target.value)}
                                        style={{
                                            width: '100%',
                                            padding: '10px 10px 10px 35px',
                                            borderRadius: '6px',
                                            border: '1px solid #ddd',
                                            fontSize: '14px',
                                            transition: 'border-color 0.2s ease',
                                            outline: 'none'
                                        }}
                                        onFocus={(e) => e.target.style.borderColor = '#1a73e8'}
                                        onBlur={(e) => e.target.style.borderColor = '#ddd'}
                                    />
                                </div>
                                <button
                                    onClick={searchEpgIds}
                                    disabled={!epgSearch.trim() || loading}
                                    style={{
                                        padding: '10px 16px',
                                        backgroundColor: !epgSearch.trim() || loading ? '#e0e0e0' : '#1a73e8',
                                        color: !epgSearch.trim() || loading ? '#999' : 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: !epgSearch.trim() || loading ? 'not-allowed' : 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '5px',
                                        fontSize: '14px',
                                        fontWeight: '500',
                                        transition: 'background-color 0.2s ease'
                                    }}
                                >
                                    {loading ? (
                                        <>
                                            <span className="loading-spinner" style={{
                                                display: 'inline-block',
                                                width: '16px',
                                                height: '16px',
                                                border: '2px solid rgba(255,255,255,0.3)',
                                                borderRadius: '50%',
                                                borderTopColor: 'white',
                                                animation: 'spin 1s linear infinite'
                                            }}></span>
                                            <span>Searching...</span>
                                        </>
                                    ) : (
                                        <>
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <circle cx="11" cy="11" r="8"></circle>
                                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                            </svg>
                                            <span>Search</span>
                                        </>
                                    )}
                                </button>
                                <button
                                    onClick={() => handleMatch(selectedEpgId || epgSearch)}
                                    disabled={(!epgSearch.trim() && !selectedEpgId) || loading}
                                    style={{
                                        padding: '10px 16px',
                                        backgroundColor: (!epgSearch.trim() && !selectedEpgId) || loading ? '#e0e0e0' : '#0b8043',
                                        color: (!epgSearch.trim() && !selectedEpgId) || loading ? '#999' : 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: (!epgSearch.trim() && !selectedEpgId) || loading ? 'not-allowed' : 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '5px',
                                        fontSize: '14px',
                                        fontWeight: '500',
                                        transition: 'background-color 0.2s ease'
                                    }}
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                                    </svg>
                                    <span>Match</span>
                                </button>
                            </div>
                        </div>

                        {/* Search results section */}
                        {searchResults.length > 0 && (
                            <div style={{
                                marginBottom: '20px',
                                backgroundColor: '#f9f9f9',
                                padding: '15px',
                                borderRadius: '8px',
                                border: '1px solid #eee'
                            }}>
                                <div style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '15px'
                                }}>
                                    <h5 style={{ margin: 0, fontWeight: '500' }}>Search Results: {searchResults.length} matches</h5>

                                    {/* Sort and filter controls */}
                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                        <div style={{ position: 'relative' }}>
                                            <svg
                                                style={{
                                                    position: 'absolute',
                                                    left: '7px',
                                                    top: '50%',
                                                    transform: 'translateY(-50%)',
                                                    color: '#666'
                                                }}
                                                xmlns="http://www.w3.org/2000/svg"
                                                width="14"
                                                height="14"
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
                                            <input
                                                type="text"
                                                placeholder="Filter results..."
                                                value={resultFilter}
                                                onChange={(e) => setResultFilter(e.target.value)}
                                                style={{
                                                    padding: '5px 5px 5px 25px',
                                                    borderRadius: '4px',
                                                    border: '1px solid #ddd',
                                                    fontSize: '12px',
                                                    width: '130px'
                                                }}
                                            />
                                        </div>
                                        <select
                                            value={resultSortMethod}
                                            onChange={(e) => setResultSortMethod(e.target.value)}
                                            style={{
                                                padding: '5px 8px',
                                                borderRadius: '4px',
                                                border: '1px solid #ddd',
                                                fontSize: '12px',
                                                background: 'white'
                                            }}
                                        >
                                            <option value="programCount">Sort by programs</option>
                                            <option value="name">Sort by name</option>
                                            <option value="source">Sort by source</option>
                                        </select>
                                    </div>
                                </div>

                                {/* Enhanced results listing with virtualization for large results */}
                                <div style={{
                                    maxHeight: '300px',
                                    overflowY: 'auto',
                                    borderRadius: '4px',
                                    backgroundColor: 'white',
                                    border: '1px solid #eee'
                                }}>
                                    {sortedSearchResults().map((result, index) => (
                                        <div key={`search_${index}`} style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            padding: '10px 15px',
                                            borderBottom: index < sortedSearchResults().length - 1 ? '1px solid #f0f0f0' : 'none',
                                            backgroundColor: index % 2 === 0 ? '#fbfbfb' : 'white',
                                            transition: 'background-color 0.1s ease'
                                        }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{
                                                    fontWeight: '500',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}>{result.name}</div>
                                                <div style={{
                                                    fontSize: '12px',
                                                    color: '#666',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '8px',
                                                    flexWrap: 'wrap',
                                                    marginTop: '3px'
                                                }}>
                                                    <div style={{
                                                        padding: '2px 6px',
                                                        backgroundColor: '#f0f0f0',
                                                        borderRadius: '4px',
                                                        fontSize: '11px',
                                                        color: '#333'
                                                    }}>
                                                        {result.sourceKey}
                                                    </div>
                                                    <div style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '3px'
                                                    }}>
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                                            <line x1="16" y1="2" x2="16" y2="6"></line>
                                                            <line x1="8" y1="2" x2="8" y2="6"></line>
                                                            <line x1="3" y1="10" x2="21" y2="10"></line>
                                                        </svg>
                                                        {result.programCount > 0 ? `${result.programCount} programs` : 'No programs'}
                                                    </div>
                                                </div>
                                                <div style={{
                                                    fontSize: '11px',
                                                    color: '#888',
                                                    marginTop: '3px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}>
                                                    ID: {result.id}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleMatch(result.id)}
                                                style={{
                                                    padding: '6px 12px',
                                                    backgroundColor: '#1a73e8',
                                                    color: 'white',
                                                    border: 'none',
                                                    borderRadius: '4px',
                                                    cursor: 'pointer',
                                                    fontSize: '12px',
                                                    fontWeight: '500',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '4px',
                                                    minWidth: '80px',
                                                    justifyContent: 'center',
                                                    transition: 'background-color 0.2s ease'
                                                }}
                                                onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#0d66d0'}
                                                onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#1a73e8'}
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="9 10 4 15 9 20"></polyline>
                                                    <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
                                                </svg>
                                                Use This
                                            </button>
                                        </div>
                                    ))}
                                    {sortedSearchResults().length === 0 && (
                                        <div style={{
                                            padding: '15px',
                                            textAlign: 'center',
                                            color: '#666',
                                            fontSize: '14px'
                                        }}>
                                            No matches found with your filter
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Error message */}
                        {error && (
                            <div style={{
                                padding: '12px 15px',
                                backgroundColor: '#fff8f7',
                                borderRadius: '6px',
                                marginBottom: '15px',
                                border: '1px solid #fddcd7',
                                color: '#d93025',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '10px'
                            }}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ minWidth: '18px', marginTop: '2px' }}>
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="12" y1="8" x2="12" y2="12"></line>
                                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                                </svg>
                                <p style={{ margin: 0 }}>{error}</p>
                            </div>
                        )}

                        {/* Suggested EPG IDs */}
                        {suggestedIds.length > 0 && (
                            <div className="suggested-ids" style={{ marginBottom: '20px' }}>
                                <h5 style={{
                                    margin: '0 0 10px 0',
                                    fontWeight: '500',
                                    fontSize: '14px',
                                    color: '#666',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '5px'
                                }}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10"></circle>
                                        <line x1="12" y1="16" x2="12" y2="12"></line>
                                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                                    </svg>
                                    Suggested EPG IDs:
                                </h5>
                                <div style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '8px',
                                    maxWidth: '100%'
                                }}>
                                    {suggestedIds.map((suggestion) => (
                                        <button
                                            key={`suggest_${suggestion.id}`}
                                            onClick={() => handleMatch(suggestion.id)}
                                            style={{
                                                padding: '6px 12px',
                                                backgroundColor: '#f5f5f5',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                cursor: 'pointer',
                                                fontSize: '12px',
                                                color: '#333',
                                                transition: 'all 0.2s ease'
                                            }}
                                            onMouseOver={(e) => {
                                                e.currentTarget.style.backgroundColor = '#e8e8e8';
                                                e.currentTarget.style.borderColor = '#ccc';
                                            }}
                                            onMouseOut={(e) => {
                                                e.currentTarget.style.backgroundColor = '#f5f5f5';
                                                e.currentTarget.style.borderColor = '#ddd';
                                            }}
                                        >
                                            {suggestion.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* EPG Data Section */}
                    <div className="epg-data" style={{ marginBottom: '20px' }}>
                        <h4 style={{
                            margin: '0 0 15px 0',
                            color: '#333',
                            fontWeight: '500',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}>
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                            EPG Data
                        </h4>

                        {/* Alternative matches section - now scrollable */}
                        {alternateMatches.length > 0 && (
                            <div style={{
                                marginBottom: '20px',
                                padding: '15px',
                                backgroundColor: '#f0f7ff',
                                borderRadius: '8px',
                                border: '1px solid #d0e3ff'
                            }}>
                                <h5 style={{
                                    margin: '0 0 10px 0',
                                    fontWeight: '500',
                                    color: '#1a73e8',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '5px'
                                }}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="4" y1="21" x2="4" y2="14"></line>
                                        <line x1="4" y1="10" x2="4" y2="3"></line>
                                        <line x1="12" y1="21" x2="12" y2="12"></line>
                                        <line x1="12" y1="8" x2="12" y2="3"></line>
                                        <line x1="20" y1="21" x2="20" y2="16"></line>
                                        <line x1="20" y1="12" x2="20" y2="3"></line>
                                        <line x1="1" y1="14" x2="7" y2="14"></line>
                                        <line x1="9" y1="8" x2="15" y2="8"></line>
                                        <line x1="17" y1="16" x2="23" y2="16"></line>
                                    </svg>
                                    Alternative Matches ({alternateMatches.length})
                                </h5>
                                <p style={{
                                    fontSize: '13px',
                                    color: '#444',
                                    margin: '0 0 10px 0'
                                }}>
                                    Other possible matches from different EPG sources. Click one to switch.
                                </p>

                                {/* Scrollable container for alternate matches */}
                                <div style={{
                                    maxHeight: '150px',
                                    overflowY: 'auto',
                                    padding: '5px',
                                    background: 'rgba(255,255,255,0.5)',
                                    borderRadius: '6px'
                                }}>
                                    <div style={{
                                        display: 'flex',
                                        flexWrap: 'wrap',
                                        gap: '8px',
                                        maxWidth: '100%'
                                    }}>
                                        {alternateMatches.map((match, index) => (
                                            <button
                                                key={`alt_${index}`}
                                                onClick={() => switchToAlternateMatch(match)}
                                                style={{
                                                    padding: '8px 12px',
                                                    backgroundColor: 'white',
                                                    border: '1px solid #c2d7ff',
                                                    borderRadius: '6px',
                                                    cursor: 'pointer',
                                                    fontSize: '13px',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    alignItems: 'flex-start',
                                                    transition: 'all 0.2s ease',
                                                    minWidth: '150px',
                                                    textAlign: 'left'
                                                }}
                                                onMouseOver={(e) => {
                                                    e.currentTarget.style.backgroundColor = '#f5f9ff';
                                                    e.currentTarget.style.borderColor = '#a1c3ff';
                                                }}
                                                onMouseOut={(e) => {
                                                    e.currentTarget.style.backgroundColor = 'white';
                                                    e.currentTarget.style.borderColor = '#c2d7ff';
                                                }}
                                            >
                                                <span style={{ fontWeight: '500' }}>{match.displayName || match.channelId}</span>
                                                <span style={{
                                                    fontSize: '11px',
                                                    marginTop: '3px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '4px',
                                                    color: '#666'
                                                }}>
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                                        <line x1="16" y1="2" x2="16" y2="6"></line>
                                                        <line x1="8" y1="2" x2="8" y2="6"></line>
                                                        <line x1="3" y1="10" x2="21" y2="10"></line>
                                                    </svg>
                                                    {match.programCount} programs
                                                </span>
                                                <span style={{
                                                    fontSize: '11px',
                                                    padding: '2px 6px',
                                                    backgroundColor: '#f0f0f0',
                                                    borderRadius: '4px',
                                                    marginTop: '5px'
                                                }}>
                                                    {match.sourceKey}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {epgData ? (
                            <div>
                                {/* Channel info section */}
                                {epgData.channelInfo && (
                                    <div className="channel-info" style={{
                                        background: '#e8f5e9',
                                        padding: '15px',
                                        borderRadius: '8px',
                                        marginBottom: '15px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '15px',
                                        border: '1px solid #c8e6c9'
                                    }}>
                                        {epgData.channelInfo.icon && (
                                            <img
                                                src={epgData.channelInfo.icon}
                                                alt="Channel Logo"
                                                style={{
                                                    maxWidth: '60px',
                                                    maxHeight: '60px',
                                                    border: '1px solid #ddd',
                                                    borderRadius: '6px',
                                                    padding: '2px',
                                                    background: 'white'
                                                }}
                                            />
                                        )}
                                        <div>
                                            <h5 style={{ margin: '0 0 5px 0', color: '#2e7d32' }}>
                                                {epgData.channelInfo.displayNames && epgData.channelInfo.displayNames.length > 0
                                                    ? epgData.channelInfo.displayNames[0].name
                                                    : epgData.channelInfo.id}
                                            </h5>
                                            <div style={{
                                                fontSize: '13px',
                                                color: '#444',
                                                display: 'flex',
                                                flexWrap: 'wrap',
                                                gap: '10px'
                                            }}>
                                                <div>
                                                    <strong>Source:</strong> {currentSource}
                                                </div>
                                                <div>
                                                    <strong>Channel ID:</strong> {epgData.channelInfo.id}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="current-program" style={{
                                    background: '#f0f9ff',
                                    padding: '15px',
                                    borderRadius: '8px',
                                    marginBottom: '15px',
                                    border: '1px solid #d3e5ff'
                                }}>
                                    <h5 style={{
                                        margin: '0 0 10px 0',
                                        color: '#1a73e8',
                                        fontWeight: '500',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '5px'
                                    }}>
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <circle cx="12" cy="12" r="10"></circle>
                                            <polyline points="12 6 12 12 16 14"></polyline>
                                        </svg>
                                        Current Program
                                    </h5>
                                    {epgData.currentProgram ? (
                                        <>
                                            <p style={{
                                                fontWeight: '500',
                                                margin: '0 0 8px 0',
                                                fontSize: '16px'
                                            }}>{epgData.currentProgram.title}</p>
                                            <p style={{
                                                margin: '0 0 10px 0',
                                                fontSize: '14px',
                                                color: '#444',
                                                lineHeight: '1.4'
                                            }}>{epgData.currentProgram.desc || 'No description available'}</p>
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                fontSize: '12px',
                                                color: '#666',
                                                gap: '5px'
                                            }}>
                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <circle cx="12" cy="12" r="10"></circle>
                                                    <polyline points="12 6 12 12 16 14"></polyline>
                                                </svg>
                                                {formatDate(epgData.currentProgram.start)} - {formatDate(epgData.currentProgram.stop)}
                                            </div>
                                        </>
                                    ) : (
                                        <p style={{
                                            color: '#666',
                                            margin: 0
                                        }}>No current program information available. Try matching with another EPG ID.</p>
                                    )}
                                </div>

                                <div className="upcoming-programs">
                                    <h5 style={{
                                        margin: '0 0 10px 0',
                                        color: '#333',
                                        fontWeight: '500',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '5px'
                                    }}>
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                                        </svg>
                                        Upcoming Programs
                                    </h5>
                                    {epgData.programs && epgData.programs.length > 0 ? (
                                        <ul style={{
                                            listStyle: 'none',
                                            padding: '5px',
                                            margin: 0,
                                            backgroundColor: '#f9f9f9',
                                            borderRadius: '8px',
                                            border: '1px solid #eee',
                                            maxHeight: '300px',
                                            overflowY: 'auto'
                                        }}>
                                            {epgData.programs.map((program, index) => (
                                                <li key={`program_${index}`} style={{
                                                    padding: '10px',
                                                    margin: '5px 0',
                                                    borderBottom: index < epgData.programs.length - 1 ? '1px solid #f0f0f0' : 'none',
                                                    backgroundColor: index % 2 === 0 ? 'white' : '#f9f9f9',
                                                    borderRadius: '6px'
                                                }}>
                                                    <div style={{
                                                        fontWeight: '500',
                                                        marginBottom: '3px',
                                                        color: '#333'
                                                    }}>{program.title}</div>
                                                    <div style={{
                                                        fontSize: '12px',
                                                        color: '#666',
                                                        marginBottom: '5px',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '4px'
                                                    }}>
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                            <circle cx="12" cy="12" r="10"></circle>
                                                            <polyline points="12 6 12 12 16 14"></polyline>
                                                        </svg>
                                                        {formatDate(program.start)} - {formatDate(program.stop)}
                                                    </div>
                                                    {program.desc && (
                                                        <p style={{
                                                            margin: 0,
                                                            fontSize: '13px',
                                                            color: '#555',
                                                            lineHeight: '1.3'
                                                        }}>{program.desc.substring(0, 120)}{program.desc.length > 120 ? '...' : ''}</p>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <p style={{ color: '#666' }}>No upcoming programs available. Try matching with another EPG ID.</p>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div style={{
                                padding: '25px',
                                borderRadius: '8px',
                                backgroundColor: '#f5f5f5',
                                textAlign: 'center',
                                color: '#666',
                                border: '1px dashed #ddd'
                            }}>
                                <p style={{ margin: 0 }}>No EPG data available for this channel. Try matching with an EPG ID from the suggestions above.</p>
                            </div>
                        )}
                    </div>

                    <div className="epg-troubleshooting" style={{
                        marginTop: '20px',
                        padding: '15px',
                        backgroundColor: '#fffde7',
                        borderRadius: '8px',
                        border: '1px solid #fff9c4'
                    }}>
                        <h5 style={{
                            marginTop: 0,
                            color: '#f57c00',
                            fontWeight: '500',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px'
                        }}>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="8" x2="12" y2="12"></line>
                                <line x1="12" y1="16" x2="12.01" y2="16"></line>
                            </svg>
                            EPG Data Troubleshooting
                        </h5>
                        <p style={{
                            margin: '0 0 10px 0',
                            fontSize: '14px',
                            color: '#555'
                        }}>If you're not seeing any EPG data for any channels, there might be an issue with the EPG sources:</p>
                        <ol style={{
                            paddingLeft: '25px',
                            margin: '10px 0',
                            fontSize: '14px',
                            color: '#555'
                        }}>
                            <li>Try searching with different terms (e.g., full channel name, partial name, without "HD")</li>
                            <li>Check if different EPG sources have different naming conventions</li>
                            <li>Look at sample channel IDs in the debug mode to see available formats</li>
                            <li>Try matching with IDs from any of the suggestions</li>
                        </ol>
                    </div>
                </>
            ) : (
                <div style={{
                    padding: '30px',
                    textAlign: 'center',
                    borderRadius: '8px',
                    backgroundColor: '#f5f5f5',
                    color: '#666',
                    border: '1px dashed #ddd'
                }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '15px', color: '#999' }}>
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="16" y1="2" x2="16" y2="6"></line>
                        <line x1="8" y1="2" x2="8" y2="6"></line>
                        <line x1="3" y1="10" x2="21" y2="10"></line>
                    </svg>
                    <p style={{ margin: 0, fontSize: '16px' }}>Select a channel to view and match EPG data</p>
                </div>
            )}
        </div>
    );
};

export default EPGMatcher;