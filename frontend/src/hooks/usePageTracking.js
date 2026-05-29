import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import logger from '../utils/logger';
import { getToken, refreshAuthToken } from '../utils/authToken';

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

    // Track page view. Reads the freshest token from storage (not the
    // closured `token`) so a heartbeat after a refresh elsewhere picks
    // up the new token. On 401, attempts one silent refresh + retry so
    // the weekly token expiry doesn't spew 401s from the 2-min
    // heartbeat. This is background telemetry — a refresh failure just
    // stops quietly; the user-facing redirect is owned by apiClient/SSE.
    const baseUrl = window.location.hostname === 'localhost' ? '' : window.location.origin;
    const postPageView = async (authToken) =>
      fetch(`${baseUrl}/api/metrics/page-view`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ sessionId: sessionIdRef.current, page: pageName })
      });

    const trackPageView = async () => {
      try {
        let authToken = getToken() || token;
        let response = await postPageView(authToken);

        if (response.status === 401) {
          const refreshed = await refreshAuthToken();
          if (refreshed) {
            response = await postPageView(refreshed);
          }
        }

        if (!response.ok) {
          console.warn('[usePageTracking] page view not tracked:', response.status);
        }
      } catch (error) {
        console.warn('[usePageTracking] page view tracking error:', error?.message || error);
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
