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
    onEpgSourceAvailable = () => {}
}) => {
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState('Connecting to server...');
    const [error, setError] = useState(null);
    const [logs, setLogs] = useState([]);
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
        const evtSource = new EventSource(`${API_BASE_URL}/api/events/${currentSessionId}`);
        eventSourceRef.current = evtSource;
        
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
                    const newEvtSource = new EventSource(`${API_BASE_URL}/api/events/${currentSessionId}`);
                    eventSourceRef.current = newEvtSource;
                    
                    // Set up handlers for the new connection
                    newEvtSource.onopen = evtSource.onopen;
                    newEvtSource.onmessage = evtSource.onmessage;
                    newEvtSource.onerror = evtSource.onerror;
                }
            }, 5000);
        };
        
        // Event handler for incoming messages
        evtSource.onmessage = (e) => {
            try {
                // Parse the incoming data
                const data = JSON.parse(e.data);
                handleEventData(data);
            } catch (err) {
                console.error('[LoadingProgress] Error parsing SSE message:', err, e.data);
                addLog(`Error parsing server message: ${err.message}`);
            }
        };
        
        // Cleanup function to close the event source when unmounting
        return () => {
            console.log('[LoadingProgress] Closing SSE connection');
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, [sessionId]);

    // Handle different types of event data
    const handleEventData = (data) => {
        console.log('[LoadingProgress] Received event data:', data);
        
        // Handle different event types
        switch (data.type) {
            case 'progress':
                // Update progress percentage
                setProgress(data.percentage || 0);
                setStatus(data.message || 'Processing...');
                addLog(data.message || 'Progress update received');
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
                setError(data.message || 'An error occurred during processing');
                addLog(`Error: ${data.message}`);
                
                // Close the event source
                if (eventSourceRef.current) {
                    eventSourceRef.current.close();
                }
                break;
                
            case 'channels-available':
                // Channels are available
                addLog(`Channels available: ${data.count} channels`);
                
                // Call the onChannelsAvailable callback
                if (onChannelsAvailable && typeof onChannelsAvailable === 'function') {
                    onChannelsAvailable(data.data);
                }
                break;
                
            case 'epg-source-available':
                // EPG source is available
                addLog(`EPG source available: ${data.url || 'Unknown URL'}`);
                
                // Call the onEpgSourceAvailable callback
                if (onEpgSourceAvailable && typeof onEpgSourceAvailable === 'function') {
                    onEpgSourceAvailable(data.data);
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
        <div className="loading-progress">
            <h3>{status}</h3>
            
            {/* Progress bar */}
            <div className="progress-bar-container">
                <div 
                    className="progress-bar" 
                    style={{ width: `${progress}%` }}
                ></div>
                <div className="progress-text">{progress.toFixed(0)}%</div>
            </div>
            
            {/* Error message */}
            {error && (
                <div className="error-message">
                    <p>Error: {error}</p>
                </div>
            )}
            
            {/* Logs */}
            <div className="logs-container">
                <h4>Processing Logs</h4>
                <div className="logs">
                    {logs.map((log, index) => (
                        <div key={index} className="log-entry">{log}</div>
                    ))}
                    <div ref={logsEndRef} />
                </div>
            </div>
        </div>
    );
};

export default LoadingProgress;