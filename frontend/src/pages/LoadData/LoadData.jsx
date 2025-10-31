import React, { useState, useRef, useEffect } from 'react';
import { loadChannelsAndEpg } from '../../services/api';
import { setupSSE } from '../../services/SSEService';
import { getSessionId } from '../../services/sessionService';
import { useNavigate } from 'react-router-dom';

const LoadData = () => {
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [processingStage, setProcessingStage] = useState('starting');
  const [currentSessionId, setCurrentSessionId] = useState(getSessionId());
  const [activeTab, setActiveTab] = useState('xtream');
  
  const eventSourceRef = useRef(null);
  const navigate = useNavigate();

  const tabButtonClasses = (tab) => {
    const isActive = activeTab === tab;
    const isBlocked = loading && activeTab !== tab;

    return [
      'flex-1 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-150',
      'focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-900',
      isActive
        ? 'bg-blue-500/20 text-blue-100 shadow-inner ring-1 ring-inset ring-blue-400/60'
        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60',
      isBlocked ? 'cursor-not-allowed opacity-60' : ''
    ].join(' ');
  };

  const inputClasses = 'w-full rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60';
  const helpTextClasses = 'text-xs text-slate-400 leading-relaxed';
  const stageLabel = (processingStage || 'starting').replace(/_/g, ' ');

  // Listen for SSE completion event
  useEffect(() => {
    const handleCompletion = (event) => {
      console.log('SSE Complete event received', event.detail);
      if (event.detail && event.detail.sessionId) {
        // Update UI with session ID
        setCurrentSessionId(event.detail.sessionId);
        
        // Navigate to channels after a delay
        setTimeout(() => {
          const finalSessionId = getSessionId();
          console.log(`Navigating to channels with final session ID: ${finalSessionId}`);
          if (finalSessionId) {
            navigate('/channels');
          } else {
            console.error('No session available for navigation after completion');
          }
        }, 800);
      }
    };
    
    window.addEventListener('sseComplete', handleCompletion);
    return () => window.removeEventListener('sseComplete', handleCompletion);
  }, [navigate]);

  // Listen for session change events
  useEffect(() => {
    const handleSessionChange = (event) => {
      console.log('Session change event received', event.detail);
      setCurrentSessionId(event.detail.sessionId);
    };
    
    window.addEventListener('sessionChange', handleSessionChange);
    return () => window.removeEventListener('sessionChange', handleSessionChange);
  }, []);

  const handleSubmit = async (e, submissionType = 'xtream') => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProgress(0);
    setProcessingStage(submissionType === 'epg' ? 'loading_epg' : 'starting');
    
    try {
      // Close any existing SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      
      console.log('Starting load process with form data', {
        xtreamUsername, xtreamPassword, xtreamServer
      });
      
      // Load data and get session ID
      const result = await loadChannelsAndEpg({
        m3uUrl,
        epgUrl,
        xtreamUsername,
        xtreamPassword,
        xtreamServer,
        forceUpdate: false
      });
      
      const { sessionId } = result;
      console.log(`Load request completed with session ID: ${sessionId}`);
      
      if (!sessionId) {
        throw new Error('No session ID returned from server');
      }
      
      // Update UI with new session ID
      setCurrentSessionId(sessionId);
      
      // Set up SSE connection for progress updates
      eventSourceRef.current = setupSSE(sessionId);
      
      // Listen for progress updates
      const handleMessage = (event) => {
        if (event.detail && event.detail.data) {
          const data = event.detail.data;
          if (data.progress !== undefined) {
            setProgress(data.progress);
          }
          if (data.stage) {
            setProcessingStage(data.stage);
          }
        }
      };
      
      window.addEventListener('sseMessage', handleMessage);
      
      // Cleanup function to remove event listeners
      return () => {
        window.removeEventListener('sseMessage', handleMessage);
      };
      
    } catch (error) {
      console.error('Error loading data:', error);
      setError(`Error: ${error.message || 'Unknown error occurred'}`);
      setLoading(false);
    }
  };

  const handleXtreamSubmit = (e) => handleSubmit(e, 'xtream');
  const handleEpgSubmit = (e) => handleSubmit(e, 'epg');

  return (
    <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-5xl flex-col gap-8 px-4 py-12">
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-blue-400/70">Setup</p>
        <h1 className="text-3xl font-semibold text-slate-100">Load IPTV Data</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-slate-400">
          Connect to your provider, then manage EPG sources independently for a streamlined configuration.
        </p>
      </header>

      <section className="rounded-3xl border border-slate-800/70 bg-slate-900/70 p-8 shadow-2xl shadow-slate-950/50 backdrop-blur">
        <div className="mb-8 flex items-center gap-2 border-b border-slate-800/70 pb-2">
          <button
            type="button"
            className={tabButtonClasses('xtream')}
            onClick={() => setActiveTab('xtream')}
            disabled={loading && activeTab !== 'xtream'}
          >
            Xtream Login
          </button>
          <button
            type="button"
            className={tabButtonClasses('epg')}
            onClick={() => setActiveTab('epg')}
            disabled={loading && activeTab !== 'epg'}
          >
            EPG Sources
          </button>
        </div>

        {activeTab === 'xtream' && (
          <form onSubmit={handleXtreamSubmit} className="space-y-8">
            <div className="grid gap-6 md:grid-cols-2">
              <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-slate-200">Xtream Username</span>
                <input
                  type="text"
                  value={xtreamUsername}
                  onChange={(e) => setXtreamUsername(e.target.value)}
                  placeholder="Enter Xtream username"
                  disabled={loading}
                  className={inputClasses}
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-slate-200">Xtream Password</span>
                <input
                  type="password"
                  value={xtreamPassword}
                  onChange={(e) => setXtreamPassword(e.target.value)}
                  placeholder="Enter Xtream password"
                  disabled={loading}
                  className={inputClasses}
                />
              </label>
              <label className="md:col-span-2 flex flex-col gap-2">
                <span className="text-sm font-semibold text-slate-200">Xtream Server URL</span>
                <input
                  type="text"
                  value={xtreamServer}
                  onChange={(e) => setXtreamServer(e.target.value)}
                  placeholder="http://example.com:25461"
                  disabled={loading}
                  className={inputClasses}
                />
              </label>
            </div>

            <div className="flex items-center gap-4 text-xs uppercase tracking-[0.4em] text-slate-500">
              <span className="hidden h-px flex-1 bg-gradient-to-r from-transparent via-slate-700/70 to-transparent sm:block" />
              Playlist Options
              <span className="hidden h-px flex-1 bg-gradient-to-r from-transparent via-slate-700/70 to-transparent sm:block" />
            </div>

            <label className="flex flex-col gap-3">
              <span className="text-sm font-semibold text-slate-200">M3U URL (Optional)</span>
              <input
                type="text"
                value={m3uUrl}
                onChange={(e) => setM3uUrl(e.target.value)}
                placeholder="Enter playlist URL if provided by your provider"
                disabled={loading}
                className={inputClasses}
              />
              <p className={helpTextClasses}>
                Include your provider&apos;s M3U URL if you prefer to load channels from a playlist.
              </p>
            </label>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-all duration-150 hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Processing…' : 'Load Xtream Data'}
              </button>
            </div>
          </form>
        )}

        {activeTab === 'epg' && (
          <form onSubmit={handleEpgSubmit} className="space-y-8">
            <label className="flex flex-col gap-3">
              <span className="text-sm font-semibold text-slate-200">EPG URL</span>
              <input
                type="text"
                value={epgUrl}
                onChange={(e) => setEpgUrl(e.target.value)}
                placeholder="Enter XMLTV or gzipped EPG URL"
                disabled={loading}
                className={inputClasses}
              />
              <p className={helpTextClasses}>
                Manage your guide data independently. You can refresh your sources at any time.
              </p>
            </label>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 via-blue-500 to-blue-700 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-all duration-150 hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Processing…' : 'Load EPG Sources'}
              </button>
            </div>
          </form>
        )}

        {loading && (
          <div className="mt-10 space-y-4 rounded-2xl border border-slate-800/70 bg-slate-900/80 p-6">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/80">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 via-blue-500 to-blue-600 transition-[width] duration-150"
                style={{ width: `${Math.min(Math.max(progress, 6), 100)}%` }}
              ></div>
            </div>
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
              <span className="text-slate-400">Processing</span>
              <span className="text-blue-200">{stageLabel} · {Math.round(progress)}%</span>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-8 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-200">
            {error}
          </div>
        )}

        <div className="mt-8 rounded-2xl border border-slate-800/70 bg-slate-900/60 p-4 text-xs text-slate-400">
          <span className="font-semibold text-slate-200">Current session ID:</span>{' '}
          {currentSessionId || 'None'}
        </div>
      </section>
    </div>
  );
};

export default LoadData;
