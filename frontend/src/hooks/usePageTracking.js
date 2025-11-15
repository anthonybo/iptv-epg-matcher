import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Custom hook for tracking page views
 * Automatically sends page view on mount and heartbeats every 30 seconds
 * @param {string} pageName - Name of the current page
 */
export function usePageTracking(pageName) {
  const { token, isAuthenticated } = useAuth();
  const heartbeatIntervalRef = useRef(null);
  const sessionIdRef = useRef(null);

  useEffect(() => {
    console.log('[usePageTracking] Effect triggered:', { isAuthenticated, hasToken: !!token, pageName });

    if (!isAuthenticated || !token || !pageName) {
      console.log('[usePageTracking] Skipping - not ready:', { isAuthenticated, hasToken: !!token, pageName });
      return;
    }

    // Generate or get session ID
    if (!sessionIdRef.current) {
      sessionIdRef.current = sessionStorage.getItem('metrics_session_id');
      if (!sessionIdRef.current) {
        sessionIdRef.current = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        sessionStorage.setItem('metrics_session_id', sessionIdRef.current);
      }
      console.log('[usePageTracking] Session ID:', sessionIdRef.current);
    }

    // Track page view
    const trackPageView = async () => {
      try {
        const baseUrl = window.location.hostname === 'localhost'
          ? 'http://localhost:5001'
          : window.location.origin;

        console.log('[usePageTracking] Tracking page view:', pageName);

        const response = await fetch(`${baseUrl}/api/metrics/page-view`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            page: pageName
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[usePageTracking] Failed to track page view:', response.status, errorText);
        } else {
          console.log('[usePageTracking] Successfully tracked page view:', pageName);
        }
      } catch (error) {
        console.error('[usePageTracking] Failed to track page view:', error);
      }
    };

    // Track initial page view
    trackPageView();

    // Send heartbeat every 2 minutes to keep session active (reduced from 30s to reduce load)
    heartbeatIntervalRef.current = setInterval(trackPageView, 120000);

    // Cleanup on unmount
    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    };
  }, [pageName, token, isAuthenticated]);
}
