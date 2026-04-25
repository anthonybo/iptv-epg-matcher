import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';

/**
 * ActiveSessionsPanel - Shows active users (both from page sessions and stream viewers)
 * Props:
 *   - streams: Array of active streams from metrics
 */
const ActiveSessionsPanel = ({ streams = [] }) => {
  const { token } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;

    const fetchSessions = async () => {
      try {
        const baseUrl = window.location.hostname === 'localhost'
          ? ''
          : window.location.origin;

        const response = await fetch(`${baseUrl}/api/metrics/sessions/active`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch sessions');
        }

        const data = await response.json();
        setSessions(data.sessions || []);
        setError(null);
      } catch (err) {
        console.error('[ActiveSessionsPanel] Error fetching sessions:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchSessions();

    // Refresh every 10 seconds
    const interval = setInterval(fetchSessions, 10000);

    return () => clearInterval(interval);
  }, [token]);

  const formatDuration = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const formatPageName = (page) => {
    const names = {
      'dashboard': 'Dashboard',
      'guide': 'TV Guide',
      'channels': 'Channels',
      'iptv-editor': 'IPTV Editor',
      'player': 'Player',
      'live-events': 'Live Events',
      'multi-view': 'Multi-View',
      'configuration': 'Configuration'
    };
    return names[page] || page;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 text-red-400">
        Failed to load sessions: {error}
      </div>
    );
  }

  // Combine sessions and stream viewers into unique users
  const getActiveUsers = () => {
    const userMap = new Map();

    // Add users from page sessions
    sessions.forEach(session => {
      const key = session.userName || session.ip;
      if (!userMap.has(key)) {
        userMap.set(key, {
          userName: session.userName,
          ip: session.ip,
          activity: formatPageName(session.currentPage),
          lastSeen: session.lastSeen,
          duration: session.duration,
          type: 'browsing'
        });
      }
    });

    // Add users from active streams
    streams.forEach(stream => {
      const key = stream.user || stream.ip;
      const activityText = stream.type === 'stream'
        ? `Watching: ${stream.channel}`
        : `External Player: ${stream.channel}`;

      if (!userMap.has(key)) {
        userMap.set(key, {
          userName: stream.user,
          ip: stream.ip,
          activity: activityText,
          lastSeen: Date.now(),
          duration: stream.duration,
          type: stream.type === 'stream' ? 'streaming' : 'external'
        });
      } else {
        // User exists, update with streaming activity if not already set
        const existing = userMap.get(key);
        if (existing.type === 'browsing') {
          existing.activity = activityText;
          existing.type = stream.type === 'stream' ? 'streaming' : 'external';
        }
      }
    });

    return Array.from(userMap.values());
  };

  const activeUsers = getActiveUsers();

  if (activeUsers.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        No active users
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {activeUsers.map((user, idx) => (
        <div
          key={idx}
          className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 hover:bg-slate-800/70 transition-colors"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${
                user.type === 'streaming' ? 'bg-blue-500' :
                user.type === 'external' ? 'bg-purple-500' :
                'bg-green-500'
              }`}></div>
              <span className="text-slate-200 font-medium">
                {user.userName || 'Anonymous'}
              </span>
            </div>
            <div className="mt-1 text-sm text-slate-400">
              {user.activity}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {user.ip} • {user.duration ? `Active for ${formatDuration(user.duration)}` : 'Active now'}
            </div>
          </div>
          <div className="text-right text-xs text-slate-500">
            {user.lastSeen && (
              <>
                <div>Last seen:</div>
                <div className="text-slate-400">{formatTimestamp(user.lastSeen)}</div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ActiveSessionsPanel;
