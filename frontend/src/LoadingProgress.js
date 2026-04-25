// LoadingProgress.js - New component for streaming updates
import React, { useEffect, useState, useRef } from 'react';
import { API_BASE_URL } from './config';
import SessionManager from './utils/sessionManager';

/**
 * LoadingProgress component to display streaming updates from the server
 * @param {Object} props Component properties
 * @param {string} props.sessionId Session ID to connect to for updates
 * @param {Function} props.onComplete Callback when processing is complete
 * @param {Function} props.onChannelsAvailable Callback when channels are available
 * @param {Function} props.onEpgSourceAvailable Callback when an EPG source is available
 * @returns {JSX.Element} Loading progress UI with detailed steps
 */
const LoadingProgress = ({
    sessionId,
    onComplete = () => {},
    onChannelsAvailable = () => {},
    onEpgSourceAvailable = () => {},
    onCancel = null
}) => {
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState('Connecting to server...');
    const [error, setError] = useState(null);
    const [logs, setLogs] = useState([]);
    const [hasFailed, setHasFailed] = useState(false);
    const eventSourceRef = useRef(null);
    const logsEndRef = useRef(null);

    // Auto-scroll logs to bottom when new entries are added
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    useEffect(() => {
        // Get session ID from props or from storage
        const currentSessionId = sessionId || SessionManager.getSessionId();
        
        if (!currentSessionId) {
            setError('No session ID available. Please refresh the page.');
            return;
        }
        
        console.log(`[LoadingProgress] Setting up SSE connection for session: ${currentSessionId}`);
        addLog(`Setting up event stream for session: ${currentSessionId}`);
        
        // Set up event source for Server-Sent Events
        const resolveApiBase = () => {
            if (API_BASE_URL) {
                return API_BASE_URL;
            }

            if (typeof window !== 'undefined') {
                return `${window.location.protocol}//${window.location.hostname}:5001`;
            }

            return '';
        };

        const baseUrl = resolveApiBase();
        const evtSource = new EventSource(`${baseUrl}/api/stream-updates/${currentSessionId}`);
        eventSourceRef.current = evtSource;
        
        const handleEvent = (eventType, rawData) => {
            try {
                const payload = rawData ? JSON.parse(rawData) : {};
                const data = { ...payload, type: eventType };
                handleEventData(data);
            } catch (err) {
                console.error('[LoadingProgress] Error parsing SSE message:', err, rawData);
                addLog(`Error parsing server message: ${err.message}`);
            }
        };

        // Event handler for when connection opens
        evtSource.onopen = () => {
            console.log('[LoadingProgress] SSE Connection opened');
            addLog('Connected to server event stream');
            setStatus('Connected to server, waiting for updates...');
        };
        
        // Event handler for connection errors
        evtSource.onerror = (e) => {
            console.error('[LoadingProgress] SSE Connection error:', e);
            addLog('Error connecting to server event stream');
            
            // Provide more detailed error information
            if (navigator.onLine === false) {
                setError('Your device appears to be offline. Please check your internet connection.');
            } else {
                setError('Connection to server lost or failed. The server might be busy processing large data. Please wait a moment and refresh the page if needed.');
            }
            
            // Add a reconnection attempt after a short delay
            setTimeout(() => {
                if (eventSourceRef.current) {
                    console.log('[LoadingProgress] Attempting to reconnect...');
                    addLog('Attempting to reconnect to server...');
                    
                    // Close existing connection
                    eventSourceRef.current.close();
                    
                    // Create a new connection
                    const newEvtSource = new EventSource(`${baseUrl}/api/stream-updates/${currentSessionId}`);
                    eventSourceRef.current = newEvtSource;
                    
                    newEvtSource.onopen = evtSource.onopen;
                    newEvtSource.onerror = evtSource.onerror;
                    const newNamedEvents = ['progress', 'complete', 'error', 'channels_available', 'channels-available', 'epg_source_available', 'epg-source-available', 'register'];
                    newNamedEvents.forEach(eventType => {
                        newEvtSource.addEventListener(eventType, (event) => handleEvent(eventType, event.data));
                    });
                    newEvtSource.onmessage = (event) => handleEvent('message', event.data);
                }
            }, 5000);
        };

        const namedEvents = ['progress', 'complete', 'error', 'channels_available', 'channels-available', 'epg_source_available', 'epg-source-available', 'register'];
        namedEvents.forEach(eventType => {
            evtSource.addEventListener(eventType, (event) => handleEvent(eventType, event.data));
        });
        evtSource.onmessage = (event) => handleEvent('message', event.data);
        
        // Cleanup function to close the event source when unmounting
        return () => {
            console.log('[LoadingProgress] Closing SSE connection');
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, [sessionId]);

    const toNumericProgress = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
    };

    const updateProgress = (data) => {
        // Check if this is actually an error based on the message or stage
        const isError = data.stage?.includes('error') ||
                       data.message?.toLowerCase().includes('error') ||
                       data.message?.toLowerCase().includes('failed');

        if (isError) {
            setError(data.message || 'An error occurred during processing');
            setHasFailed(true);
            addLog(`Error: ${data.message}`);
            return;
        }

        const numericProgress =
            data.progress !== undefined
                ? toNumericProgress(data.progress)
                : data.percentage !== undefined
                    ? toNumericProgress(data.percentage)
                    : data.percent !== undefined
                        ? toNumericProgress(data.percent)
                        : progress; // retain previous if nothing provided

        setProgress(numericProgress);
        setStatus(data.message || data.stage || 'Processing...');
        addLog(data.message || data.stage || 'Progress update received');
    };

    // Handle different types of event data
    const handleEventData = (data) => {
        console.log('[LoadingProgress] Received event data:', data);
        
        // Handle different event types
        switch (data.type) {
            case 'progress':
                updateProgress(data);
                break;
                
            case 'complete':
                // Processing complete
                setProgress(100);
                setStatus('Processing complete!');
                addLog('Processing complete');
                
                // Close the event source
                if (eventSourceRef.current) {
                    eventSourceRef.current.close();
                }
                
                // Call the onComplete callback
                if (onComplete && typeof onComplete === 'function') {
                    onComplete(data.data);
                }
                break;
                
            case 'error':
                // Processing error
                console.log('[LoadingProgress] Error event received:', data);
                const errorMsg = data.message || 'An error occurred during processing';
                setError(errorMsg);
                setHasFailed(true);
                setStatus(errorMsg); // Also update status to show error
                addLog(`Error: ${data.message}`);

                // Close the event source
                if (eventSourceRef.current) {
                    eventSourceRef.current.close();
                }
                break;
                
            case 'channels-available':
            case 'channels_available':
                // Channels are available
                addLog(`Channels available: ${data.channelCount || data.count || 0} channels`);
                
                // Call the onChannelsAvailable callback
                if (onChannelsAvailable && typeof onChannelsAvailable === 'function') {
                    onChannelsAvailable(data.data);
                }
                break;
                
            case 'epg-source-available':
            case 'epg_source_available':
                // EPG source is available
                addLog(`EPG source available: ${data.url || 'Unknown URL'}`);
                
                // Call the onEpgSourceAvailable callback
                if (onEpgSourceAvailable && typeof onEpgSourceAvailable === 'function') {
                    onEpgSourceAvailable(data.data);
                }
                break;
                
            case 'message':
                // Default (unnamed) SSE events come through as "message"
                // Check if this is actually an error message
                if (data.stage && data.stage.includes('error')) {
                    // This is an error message
                    console.log('[LoadingProgress] Error detected in message event:', data);
                    const errorMsg = data.message || 'An error occurred during processing';
                    setError(errorMsg);
                    setHasFailed(true);
                    setStatus(errorMsg);
                    addLog(`Error: ${data.message}`);

                    // Close the event source
                    if (eventSourceRef.current) {
                        eventSourceRef.current.close();
                    }
                } else if (data.message && (data.message.toLowerCase().includes('error:') || data.message.toLowerCase().startsWith('error '))) {
                    // Message contains "Error:" or starts with "Error "
                    console.log('[LoadingProgress] Error detected in message text:', data);
                    const errorMsg = data.message;
                    setError(errorMsg);
                    setHasFailed(true);
                    setStatus(errorMsg);
                    addLog(`Error: ${data.message}`);

                    // Close the event source
                    if (eventSourceRef.current) {
                        eventSourceRef.current.close();
                    }
                } else if (data.progress !== undefined || data.percentage !== undefined || data.percent !== undefined) {
                    updateProgress(data);
                } else if (data.stage) {
                    if (data.stage === 'complete') {
                        updateProgress({ ...data, progress: 100 });
                    } else {
                        addLog(data.message || `Stage update: ${data.stage}`);
                        setStatus(data.message || data.stage);
                    }
                } else if (data.message) {
                    addLog(data.message);
                    if (data.message.toLowerCase().includes('completed')) {
                        updateProgress({ ...data, progress: 100 });
                        setStatus(data.message);

                        // Close the event source
                        if (eventSourceRef.current) {
                            eventSourceRef.current.close();
                        }

                        // Call the onComplete callback
                        if (onComplete && typeof onComplete === 'function') {
                            onComplete(data);
                        }
                    }
                } else {
                    addLog('Received server message event');
                }
                break;

            default:
                // Unknown event type
                addLog(`Unknown event type: ${data.type}`);
                console.warn('[LoadingProgress] Unknown event type:', data);
        }
    };

    // Add a log entry
    const addLog = (message) => {
        const timestamp = new Date().toISOString().slice(11, 19);
        setLogs(prevLogs => [...prevLogs, `[${timestamp}] ${message}`]);
    };

    return (
        <div
            style={{
                background: 'linear-gradient(135deg, #1e293b, #0f172a)',
                color: '#e2e8f0',
                borderRadius: '16px',
                padding: '24px',
                margin: '24px 0',
                boxShadow: '0 30px 60px rgba(15, 23, 42, 0.35)',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                maxWidth: '900px'
            }}
        >
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
                <div>
                    <div style={{ fontSize: '14px', opacity: 0.7 }}>Session</div>
                    <div style={{ fontSize: '16px', fontWeight: 600 }}>{sessionId || SessionManager.getSessionId() || 'Unknown session'}</div>
                </div>
                <div style={{
                    minWidth: '120px',
                    background: (hasFailed || error) ? 'rgba(220, 38, 38, 0.15)' : 'rgba(15, 118, 110, 0.15)',
                    border: (hasFailed || error) ? '1px solid rgba(248, 113, 113, 0.45)' : '1px solid rgba(45, 212, 191, 0.35)',
                    color: (hasFailed || error) ? '#fca5a5' : '#5eead4',
                    padding: '6px 14px',
                    borderRadius: '40px',
                    fontSize: '13px',
                    fontWeight: '600',
                    textAlign: 'center'
                }}>
                    {(hasFailed || error) ? 'Failed' : `${progress.toFixed(0)}% complete`}
                </div>
            </header>

            <div style={{
                background: 'rgba(15, 23, 42, 0.6)',
                borderRadius: '12px',
                padding: '18px',
                marginBottom: '20px',
                border: '1px solid rgba(148, 163, 184, 0.25)'
            }}>
                <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px' }}>{status}</div>
                <div style={{
                    position: 'relative',
                    height: '10px',
                    borderRadius: '999px',
                    background: 'rgba(148, 163, 184, 0.25)'
                }}>
                    <div
                        style={{
                            width: `${progress}%`,
                            height: '100%',
                            borderRadius: '999px',
                            background: (hasFailed || error)
                                ? 'linear-gradient(90deg, #ef4444, #dc2626)'
                                : 'linear-gradient(90deg, #22d3ee, #38bdf8)',
                            transition: 'width 250ms ease'
                        }}
                    />
                </div>
            </div>

            {(error || hasFailed) && (
                <div>
                    <div style={{
                        background: 'rgba(254, 226, 226, 0.15)',
                        border: '1px solid rgba(248, 113, 113, 0.45)',
                        color: '#fecaca',
                        padding: '12px 16px',
                        borderRadius: '10px',
                        marginBottom: '12px'
                    }}>
                        {error ? `Error: ${error}` : 'An error occurred during processing'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '18px' }}>
                        <button
                            onClick={() => {
                                if (eventSourceRef.current) {
                                    eventSourceRef.current.close();
                                }
                                if (onCancel && typeof onCancel === 'function') {
                                    onCancel();
                                }
                            }}
                            disabled={!onCancel}
                            style={{
                                background: onCancel ? 'linear-gradient(90deg, #ef4444, #dc2626)' : '#6b7280',
                                color: 'white',
                                padding: '10px 24px',
                                borderRadius: '10px',
                                border: 'none',
                                fontWeight: '600',
                                fontSize: '14px',
                                cursor: onCancel ? 'pointer' : 'not-allowed',
                                opacity: onCancel ? 1 : 0.6,
                                transition: 'all 0.2s ease'
                            }}
                            onMouseEnter={(e) => onCancel && (e.target.style.transform = 'scale(1.05)')}
                            onMouseLeave={(e) => onCancel && (e.target.style.transform = 'scale(1)')}
                        >
                            Close and Try Again
                        </button>
                    </div>
                </div>
            )}

            <section style={{
                background: 'rgba(15, 23, 42, 0.55)',
                borderRadius: '12px',
                padding: '18px',
                border: '1px solid rgba(148, 163, 184, 0.25)'
            }}>
                <div style={{
                    fontSize: '13px',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'rgba(226, 232, 240, 0.65)',
                    marginBottom: '12px'
                }}>
                    Processing Logs
                </div>
                <div
                    style={{
                        maxHeight: '220px',
                        overflowY: 'auto',
                        fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                        fontSize: '12px',
                        lineHeight: 1.6,
                        background: 'rgba(15, 23, 42, 0.55)',
                        borderRadius: '10px',
                        padding: '12px 14px',
                        border: '1px solid rgba(148, 163, 184, 0.15)'
                    }}
                >
                    {logs.map((log, index) => (
                        <div key={index} style={{ marginBottom: '6px', color: 'rgba(226, 232, 240, 0.85)' }}>
                            {log}
                        </div>
                    ))}
                    <div ref={logsEndRef} />
                </div>
            </section>
        </div>
    );
};

export default LoadingProgress;
