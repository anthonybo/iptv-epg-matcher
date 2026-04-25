import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';

/**
 * PageActivityPanel - Shows which pages users are currently viewing
 */
const PageActivityPanel = () => {
  const { token } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const fetchSessions = async () => {
      try {
        const baseUrl = window.location.hostname === 'localhost'
          ? ''
          : window.location.origin;

        console.log('[PageActivityPanel] Fetching sessions from:', `${baseUrl}/api/metrics/sessions/active`);

        const response = await fetch(`${baseUrl}/api/metrics/sessions/active`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[PageActivityPanel] Failed to fetch sessions:', response.status, errorText);
          throw new Error('Failed to fetch sessions');
        }

        const data = await response.json();
        console.log('[PageActivityPanel] Received sessions:', data);
        setSessions(data.sessions || []);
      } catch (err) {
        console.error('[PageActivityPanel] Error fetching sessions:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchSessions();

    // Refresh every 30 seconds (reduced from 10s to reduce load)
    const interval = setInterval(fetchSessions, 30000);

    return () => clearInterval(interval);
  }, [token]);

  const formatPageName = (page) => {
    const names = {
      'dashboard': 'Dashboard',
      'guide': 'TV Guide',
      'channels': 'Channels',
      'iptv-editor': 'IPTV Editor',
      'player': 'Player',
      'liveevents': 'Live Events',
      'multi-view': 'Multi-View',
      'configuration': 'Configuration',
      'epg': 'EPG Sources',
      'publish': 'Publish'
    };
    return names[page] || page;
  };

  // Count users by page
  const getPageCounts = () => {
    const counts = {};
    sessions.forEach(session => {
      const page = session.currentPage || 'Unknown';
      counts[page] = (counts[page] || 0) + 1;
    });

    return Object.entries(counts)
      .map(([page, count]) => ({
        page,
        displayName: formatPageName(page),
        count
      }))
      .sort((a, b) => b.count - a.count);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const pageCounts = getPageCounts();

  if (pageCounts.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        No active page sessions
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {pageCounts.map((item, idx) => (
        <div
          key={idx}
          className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50 border border-slate-700/50"
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-500/20 text-blue-400 font-bold text-lg">
              {item.count}
            </div>
            <div>
              <div className="text-slate-200 font-medium">{item.displayName}</div>
              <div className="text-xs text-slate-500">
                {item.count === 1 ? '1 user' : `${item.count} users`}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-slate-400">
              {Math.round((item.count / sessions.length) * 100)}%
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default PageActivityPanel;
