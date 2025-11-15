import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Custom hook for real-time metrics via SSE
 * @returns {Object} { metrics, isConnected, error }
 */
export function useMetrics() {
  const { token, isAuthenticated } = useAuth();
  const [metrics, setMetrics] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      setError('Not authenticated - please log in');
      return;
    }

    const connectToMetricsStream = () => {
      try {
        // Use current origin for API URL (works for both dev and production)
        const baseUrl = window.location.hostname === 'localhost'
          ? 'http://localhost:5001'
          : window.location.origin;
        const url = `${baseUrl}/api/metrics/stream?token=${encodeURIComponent(token)}`;

        console.log('[useMetrics] Connecting to metrics stream...');

        const eventSource = new EventSource(url);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          console.log('[useMetrics] Connected to metrics stream');
          setIsConnected(true);
          setError(null);
        };

        eventSource.onmessage = (event) => {
          try {
            // Skip heartbeat messages
            if (event.data.startsWith(':heartbeat')) {
              return;
            }

            const data = JSON.parse(event.data);
            setMetrics(data);
          } catch (err) {
            console.error('[useMetrics] Error parsing metrics:', err);
          }
        };

        eventSource.onerror = (err) => {
          console.error('[useMetrics] EventSource error:', err);
          setIsConnected(false);
          setError('Connection error');

          // Close current connection
          eventSource.close();

          // Attempt to reconnect after 5 seconds
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }

          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('[useMetrics] Attempting to reconnect...');
            connectToMetricsStream();
          }, 5000);
        };
      } catch (err) {
        console.error('[useMetrics] Setup error:', err);
        setError(err.message);
      }
    };

    connectToMetricsStream();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [token, isAuthenticated]);

  return { metrics, isConnected, error };
}
