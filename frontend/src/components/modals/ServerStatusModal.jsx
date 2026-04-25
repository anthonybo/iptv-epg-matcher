import React, { useState, useEffect } from 'react';
import SessionManager from '../../utils/sessionManager';
import { API_BASE_URL } from '../../config';

const resolveApiBase = () => {
  if (API_BASE_URL) {
    return API_BASE_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:5001`;
  }

  return '';
};

export function ServerStatusModal({ isOpen, onClose }) {
  const [isChecking, setIsChecking] = useState(false);
  const [statusData, setStatusData] = useState(null);
  const [isReloadingEpg, setIsReloadingEpg] = useState(false);

  useEffect(() => {
    if (isOpen && !statusData) {
      checkServerStatus();
    }
  }, [isOpen, statusData]);

  const forceReloadEpg = async () => {
    if (window.confirm('Force reload EPG sources from the server configuration? This will add all configured EPG sources to your session.')) {
      setIsReloadingEpg(true);
      try {
        const sessionId = SessionManager.getSessionId();
        if (!sessionId) {
          alert('Error: No session ID available');
          return;
        }

        const baseUrl = resolveApiBase();
        const initResponse = await fetch(`${baseUrl}/api/epg/init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sessionId })
        });

        if (!initResponse.ok) {
          throw new Error(`Failed to initialize EPG: ${initResponse.status}`);
        }

        await fetch(`${baseUrl}/api/epg/${sessionId}/sources?_t=${Date.now()}`);
        alert('Successfully triggered EPG source reload.');
        const event = new CustomEvent('epgSourcesUpdated', { detail: null });
        window.dispatchEvent(event);
      } catch (error) {
        console.error('[EPG Reload] Error:', error);
        alert(`Error reloading EPG sources: ${error.message}`);
      } finally {
        setIsReloadingEpg(false);
      }
    }
  };

  const checkServerStatus = async () => {
    setIsChecking(true);
    try {
      const baseUrl = resolveApiBase();
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) {
        const data = await response.json();
        setStatusData(data);
      } else {
        console.error('Failed to fetch server status:', response.status);
      }
    } catch (error) {
      console.error('Error checking server status:', error);
    } finally {
      setIsChecking(false);
    }
  };

  const triggerCleanup = async () => {
    if (window.confirm('Are you sure you want to trigger server cleanup?')) {
      setIsChecking(true);
      try {
        const baseUrl = resolveApiBase();
        const response = await fetch(`${baseUrl}/api/status/cleanup`, { method: 'POST' });
        if (response.ok) {
          const result = await response.json();
          alert(`Cleanup complete. Removed ${result.sessionsDiff} sessions.`);
          checkServerStatus();
        }
      } catch (error) {
        console.error('Error triggering cleanup:', error);
      } finally {
        setIsChecking(false);
      }
    }
  };

  const formatMemory = (memoryObj) => {
    if (!memoryObj) return 'N/A';
    return Object.entries(memoryObj)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full">
        <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-slate-100">Server Status</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {isChecking && !statusData ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="inline-block w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-3"></div>
                <p className="text-sm text-slate-400">Checking server status...</p>
              </div>
            </div>
          ) : statusData ? (
            <div className="space-y-4">
              <dl className="space-y-3 text-slate-300">
                <div className="flex justify-between border-b border-slate-800 pb-2">
                  <dt className="font-medium text-slate-400">Uptime</dt>
                  <dd className="text-slate-100">{Math.floor(statusData.uptime / 60)} minutes</dd>
                </div>
                <div className="flex justify-between border-b border-slate-800 pb-2">
                  <dt className="font-medium text-slate-400">Memory</dt>
                  <dd className="text-right text-slate-100 text-sm">{formatMemory(statusData.memory)}</dd>
                </div>
                <div className="flex justify-between border-b border-slate-800 pb-2">
                  <dt className="font-medium text-slate-400">Sessions</dt>
                  <dd className="text-slate-100">{statusData.sessions.count}</dd>
                </div>
                {statusData.sessions.oldest && (
                  <div className="flex justify-between border-b border-slate-800 pb-2">
                    <dt className="font-medium text-slate-400">Oldest Session</dt>
                    <dd className="text-slate-100">{new Date(statusData.sessions.oldest.lastAccessed).toLocaleTimeString()}</dd>
                  </div>
                )}
              </dl>

              <div className="flex gap-2 pt-4">
                <button
                  type="button"
                  onClick={triggerCleanup}
                  disabled={isChecking}
                  className="flex-1 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isChecking ? 'Working…' : 'Cleanup Sessions'}
                </button>
                <button
                  type="button"
                  onClick={forceReloadEpg}
                  disabled={isReloadingEpg}
                  className="flex-1 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isReloadingEpg ? 'Loading…' : 'Force Reload EPG'}
                </button>
              </div>

              <div className="text-xs text-slate-500 text-center pt-2">
                Last checked: {new Date(statusData.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-400">
              Failed to load server status
            </div>
          )}
        </div>

        <div className="bg-slate-800 px-6 py-4 border-t border-slate-700 flex gap-3 justify-end">
          <button
            onClick={checkServerStatus}
            disabled={isChecking}
            className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-60"
          >
            {isChecking ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
