import React, { useState, useRef, useEffect } from 'react';
import { loadChannelsAndEpg } from '../../services/api';
import { setupSSE } from '../../services/SSEService';
import { getSessionId } from '../../services/sessionService';
import { useNavigate } from 'react-router-dom';
import iptvSourcesService from '../../services/iptvSourcesService';

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
  const [userSources, setUserSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loadSuccess, setLoadSuccess] = useState(false);

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

  // Load user sources on mount if authenticated
  useEffect(() => {
    const loadUserSources = async () => {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        setIsAuthenticated(false);
        return;
      }

      setIsAuthenticated(true);
      setLoadingSources(true);

      try {
        const sources = await iptvSourcesService.getUserSources();
        setUserSources(sources);
      } catch (err) {
        console.error('Error loading user sources:', err);
        // If unauthorized, user is not authenticated
        if (err.response?.status === 401) {
          setIsAuthenticated(false);
        }
      } finally {
        setLoadingSources(false);
      }
    };

    loadUserSources();
  }, []);

  // Listen for SSE completion event
  useEffect(() => {
    const handleCompletion = async (event) => {
      console.log('SSE Complete event received', event.detail);
      if (event.detail && event.detail.sessionId) {
        // Update UI with session ID
        setCurrentSessionId(event.detail.sessionId);
        setLoadSuccess(true);

        // Reload sources if authenticated
        if (isAuthenticated) {
          try {
            const sources = await iptvSourcesService.getUserSources();
            setUserSources(sources);
          } catch (err) {
            console.error('Error reloading sources:', err);
          }
        }

        // Navigate to channels after a delay
        setTimeout(() => {
          const finalSessionId = getSessionId();
          console.log(`Navigating to channels with final session ID: ${finalSessionId}`);
          if (finalSessionId) {
            navigate('/channels');
          } else {
            console.error('No session available for navigation after completion');
          }
        }, 2000); // Increased delay to show success message
      }
    };

    window.addEventListener('sseComplete', handleCompletion);
    return () => window.removeEventListener('sseComplete', handleCompletion);
  }, [navigate, isAuthenticated]);

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
        <div className="flex items-center justify-between">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-blue-400/70">Setup</p>
            <h1 className="text-3xl font-semibold text-slate-100">Load IPTV Data</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-slate-400">
              Connect to your provider, then manage EPG sources independently for a streamlined configuration.
            </p>
          </div>
          {/* Navigation links */}
          <div className="flex items-center gap-3">
            <a
              href="/my-iptvs"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:border-slate-600 hover:text-slate-100 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              My IPTVs
            </a>
            <a
              href="/channels"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:border-slate-600 hover:text-slate-100 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Channels
            </a>
          </div>
        </div>
      </header>

      {/* Success message */}
      {loadSuccess && (
        <div className="rounded-xl border border-green-500/40 bg-green-500/10 p-4 shadow-lg animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-green-200 mb-1">Source loaded successfully!</h3>
              <p className="text-sm text-green-100/80">
                {isAuthenticated ? (
                  <>Your IPTV source has been added to your collection. <a href="/my-iptvs" className="underline font-medium hover:text-green-100">Manage all sources</a> or load another source below.</>
                ) : (
                  <>Your IPTV source has been loaded. Redirecting to channels...</>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* User's Current Sources */}
      {isAuthenticated && userSources.length > 0 && (
        <div className="rounded-xl border border-blue-500/40 bg-blue-500/10 p-6 shadow-lg">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-blue-100 mb-1">Your IPTV Sources</h3>
              <p className="text-sm text-blue-200/70">
                You have {userSources.length} source{userSources.length !== 1 ? 's' : ''} in your collection. Load another below to add more.
              </p>
            </div>
            <a
              href="/my-iptvs"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/30 px-3 py-1.5 text-sm font-medium text-blue-100 transition-colors"
            >
              Manage
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </a>
          </div>

          {/* Sources list */}
          <div className="space-y-2">
            {userSources.slice(0, 3).map((source) => (
              <div
                key={source.id}
                className="flex items-center gap-3 rounded-lg border border-blue-400/20 bg-blue-500/5 p-3"
              >
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex-shrink-0">
                  {source.priority}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-100 truncate">
                    {source.nickname || source.name}
                  </p>
                  <p className="text-xs text-slate-400 truncate">
                    {source.type} · {source.channel_count || 0} channels
                  </p>
                </div>
                {source.is_active === 1 ? (
                  <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
              </div>
            ))}
            {userSources.length > 3 && (
              <a
                href="/my-iptvs"
                className="block text-center text-sm text-blue-300 hover:text-blue-200 py-2"
              >
                + {userSources.length - 3} more source{userSources.length - 3 !== 1 ? 's' : ''}
              </a>
            )}
          </div>
        </div>
      )}

      {/* Info banner for authenticated users */}
      {isAuthenticated && userSources.length === 0 && !loadingSources && (
        <div className="rounded-xl border border-blue-500/40 bg-blue-500/10 p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-blue-200 mb-1">Multi-IPTV Support Enabled</h3>
              <p className="text-sm text-blue-100/80">
                Load your first IPTV source below. Each source you load will be added to your collection, and you can manage priorities on the <a href="/my-iptvs" className="underline font-medium hover:text-blue-100">My IPTVs</a> page.
              </p>
            </div>
          </div>
        </div>
      )}

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
