
import React, { useEffect, useState } from 'react';
import Dropzone from 'react-dropzone';
import axios from 'axios';
import LoadingProgress from './LoadingProgress';
import SessionManager from './utils/sessionManager';
import { API_BASE_URL } from './config';
import { registerSession } from './services/SSEService';

const statusStyles = {
  info: 'border-blue-500/40 bg-blue-500/15 text-blue-200',
  success: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  error: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
};

const Configuration = ({
  onLoad,
  error,
  allowedTabs = ['xtream', 'epg'],
  initialTab,
  heading,
  description,
  showFooter = true,
  showSummaryButton = true,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [m3uFile, setM3uFile] = useState(null);
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState('info');
  const [processingSessionId, setProcessingSessionId] = useState(null);

  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');

  const normalizedTabs = Array.isArray(allowedTabs) && allowedTabs.length ? allowedTabs : ['xtream', 'epg'];
  const allowedTabKey = normalizedTabs.join('|');
  const [activeTab, setActiveTab] = useState(() => {
    if (initialTab && normalizedTabs.includes(initialTab)) {
      return initialTab;
    }
    return normalizedTabs[0] || 'xtream';
  });

  const isEpgAllowed = normalizedTabs.includes('epg');
  const isXtreamAllowed = normalizedTabs.includes('xtream');
  const isEpgOnly = isEpgAllowed && !isXtreamAllowed;

  useEffect(() => {
    const preferredTab = initialTab && normalizedTabs.includes(initialTab)
      ? initialTab
      : normalizedTabs[0] || 'xtream';

    setActiveTab((prev) => {
      if (prev && normalizedTabs.includes(prev)) {
        return prev;
      }
      return preferredTab;
    });
  }, [allowedTabKey, initialTab, normalizedTabs]);

  useEffect(() => {
    let storedUsername = localStorage.getItem('xtreamUsername');
    let storedPassword = localStorage.getItem('xtreamPassword');
    let storedServer = localStorage.getItem('xtreamServer');

    if (!storedUsername && !storedPassword && !storedServer) {
      try {
        const oldCredentials = JSON.parse(localStorage.getItem('xtreamCredentials') || '{}');
        if (oldCredentials.server || oldCredentials.username || oldCredentials.password) {
          storedUsername = oldCredentials.username || '';
          storedPassword = oldCredentials.password || '';
          storedServer = oldCredentials.server || '';

          localStorage.setItem('xtreamUsername', storedUsername);
          localStorage.setItem('xtreamPassword', storedPassword);
          localStorage.setItem('xtreamServer', storedServer);
          localStorage.removeItem('xtreamCredentials');
        }
      } catch (migrationError) {
        console.error('Error parsing old credentials format:', migrationError);
      }
    }

    if (storedUsername) setXtreamUsername(storedUsername);
    if (storedPassword) setXtreamPassword(storedPassword);
    if (storedServer) setXtreamServer(storedServer);
  }, []);

  const saveCredentials = () => {
    try {
      localStorage.setItem('xtreamUsername', xtreamUsername);
      localStorage.setItem('xtreamPassword', xtreamPassword);
      localStorage.setItem('xtreamServer', xtreamServer);
    } catch (storageError) {
      console.error('Error saving credentials:', storageError);
    }
  };

  const setStatusMessage = (message, variant = 'info') => {
    setStatus(message);
    setStatusVariant(variant);
  };

  const submitLoadRequest = async ({ startMessage, successMessage, prepareFormData }) => {
    try {
      setStatusMessage(startMessage || 'Initializing...', 'info');
      setIsLoading(true);

      const sessionId = await SessionManager.init();
      if (!sessionId) {
        throw new Error('Failed to create or validate session');
      }

      setProcessingSessionId(sessionId);

      try {
        await registerSession(sessionId);
      } catch (registrationError) {
        console.warn('Failed to register session before load:', registrationError);
      }

      const formData = new FormData();
      formData.append('sessionId', sessionId);

      if (typeof prepareFormData === 'function') {
        prepareFormData(formData);
      }

      const response = await axios.post(`${API_BASE_URL}/api/load`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      if (response.data?.success) {
        setStatusMessage(successMessage || 'Processing started on server', 'success');
      } else {
        throw new Error(response.data?.error || 'Unknown error');
      }
    } catch (loadError) {
      console.error('Error loading data:', loadError);
      setIsLoading(false);
      setProcessingSessionId(null);
      setStatusMessage(`Error: ${loadError.response?.data?.error || loadError.message}`, 'error');
    }
  };

  const handleXtreamLoad = async () => {
    const hasXtreamCredentials = Boolean(xtreamServer && xtreamUsername && xtreamPassword);
    const hasPlaylist = Boolean(m3uUrl || m3uFile);

    if (!hasXtreamCredentials && !hasPlaylist) {
      setStatusMessage('Provide Xtream credentials or an M3U source to continue.', 'error');
      return;
    }

    if (hasXtreamCredentials) {
      saveCredentials();
    }

    await submitLoadRequest({
      startMessage: hasXtreamCredentials ? 'Connecting to Xtream server...' : 'Uploading playlist...',
      successMessage: 'Channels are loading. Sit tight!',
      prepareFormData: (formData) => {
        if (hasXtreamCredentials) {
          formData.append('xtreamUsername', xtreamUsername);
          formData.append('xtreamPassword', xtreamPassword);
          formData.append('xtreamServer', xtreamServer);
        }

        if (m3uUrl) {
          formData.append('m3uUrl', m3uUrl.trim());
        }

        if (m3uFile) {
          formData.append('m3uFile', m3uFile);
        }
      },
    });
  };

  const handleEpgLoad = async () => {
    if (!epgUrl) {
      setStatusMessage('Enter an EPG URL before loading.', 'error');
      return;
    }

    await submitLoadRequest({
      startMessage: 'Fetching EPG data...',
      successMessage: 'EPG sources are loading.',
      prepareFormData: (formData) => {
        formData.append('epgUrl', epgUrl.trim());
      },
    });
  };

  const handleProcessComplete = (data) => {
    setIsLoading(false);
    setProcessingSessionId(null);
    setStatusMessage('Processing complete', 'success');
    if (onLoad) {
      onLoad(data);
    }
  };

  const handleChannelsAvailable = (data) => {
    const channelCount = data?.channelCount || 0;
    setStatusMessage(`${channelCount} channels loaded`, 'success');
    if (onLoad) {
      onLoad(data);
    }
  };

  const handleEpgSourceAvailable = (data) => {
    setStatusMessage(`EPG source loaded: ${data?.url || 'Unknown source'}`, 'info');
  };

  const loadEpgSummary = async () => {
    try {
      setStatusMessage('Loading EPG summary...', 'info');
      const response = await axios.get(`${API_BASE_URL}/api/epg-summary`);
      if (onLoad) {
        onLoad(response.data);
      }
      setStatusMessage('EPG summary loaded', 'success');
    } catch (summaryError) {
      console.error('Error loading EPG summary:', summaryError);
      setStatusMessage(`Error loading EPG summary: ${summaryError.message}`, 'error');
    }
  };

  const effectiveHeading = heading || (isEpgOnly ? 'Load EPG Sources' : 'Configuration');
  const effectiveDescription = description || (isEpgOnly
    ? 'Load or refresh guide data without touching your channel list.'
    : 'Load channels with your Xtream credentials or playlist, then handle guide data in its own space.');

  const tabButtonClasses = (tab) => {
    const isActive = activeTab === tab;
    return [
      'flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-150',
      'focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950',
      isActive
        ? 'bg-blue-500/20 text-blue-100 shadow-inner ring-1 ring-inset ring-blue-400/60'
        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70',
      isLoading && !isActive ? 'cursor-not-allowed opacity-60' : '',
    ].join(' ');
  };

  const inputClasses = 'w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60';

  if (isLoading && processingSessionId) {
    return (
      <LoadingProgress
        sessionId={processingSessionId}
        onComplete={handleProcessComplete}
        onChannelsAvailable={handleChannelsAvailable}
        onEpgSourceAvailable={handleEpgSourceAvailable}
      />
    );
  }

  const guidanceSteps = isEpgOnly
    ? [
        'Paste a new XMLTV or gzipped URL.',
        'Load the source to fetch the latest guide data.',
        'Use the summary panel to confirm imported sources.',
        'Return to Channels or Player to match listings.',
      ]
    : [
        'Enter Xtream credentials or point to an M3U playlist.',
        'Load channels and let the progress screen finish.',
        'Open the EPG tab to add or refresh guide data.',
        'Match channels with guide entries and export what you need.',
      ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 text-slate-100">
      {error && (
        <div className="mb-6 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm font-medium text-rose-200">
          <span className="font-semibold text-rose-100">Error:</span> {error}
        </div>
      )}

      <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-8 shadow-2xl shadow-slate-950/40 backdrop-blur">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-blue-400/70">Configuration</p>
          <h2 className="text-3xl font-semibold text-slate-100">{effectiveHeading}</h2>
          <p className="max-w-2xl text-sm text-slate-400">{effectiveDescription}</p>
        </header>

        {status && (
          <div className={`mt-6 rounded-2xl border px-4 py-3 text-sm font-medium ${statusStyles[statusVariant] || statusStyles.info}`}>
            {status}
          </div>
        )}

        {normalizedTabs.length > 1 && (
          <div className="mt-8 flex items-center gap-2 border-b border-slate-800/70 pb-2">
            {isXtreamAllowed && (
              <button
                type="button"
                className={tabButtonClasses('xtream')}
                onClick={() => setActiveTab('xtream')}
                disabled={isLoading && activeTab !== 'xtream'}
              >
                Xtream Login
              </button>
            )}
            {isEpgAllowed && (
              <button
                type="button"
                className={tabButtonClasses('epg')}
                onClick={() => setActiveTab('epg')}
                disabled={isLoading && activeTab !== 'epg'}
              >
                EPG Sources
              </button>
            )}
          </div>
        )}

        {isXtreamAllowed && activeTab === 'xtream' && (
          <div className="mt-8 space-y-10">
            <section className="space-y-4">
              <h3 className="text-lg font-semibold text-slate-100">Provider Credentials</h3>
              <div className="grid gap-6 md:grid-cols-2">
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Server URL</span>
                  <input
                    type="text"
                    placeholder="http://example.com:8080"
                    value={xtreamServer}
                    onChange={(e) => setXtreamServer(e.target.value)}
                    disabled={isLoading}
                    className={inputClasses}
                  />
                </label>
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Username</span>
                  <input
                    type="text"
                    placeholder="Your Xtream username"
                    value={xtreamUsername}
                    onChange={(e) => setXtreamUsername(e.target.value)}
                    disabled={isLoading}
                    className={inputClasses}
                  />
                </label>
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Password</span>
                  <input
                    type="password"
                    placeholder="Your Xtream password"
                    value={xtreamPassword}
                    onChange={(e) => setXtreamPassword(e.target.value)}
                    disabled={isLoading}
                    className={inputClasses}
                  />
                </label>
              </div>
              <p className="text-xs text-slate-400">
                Credentials stay in your browser&apos;s storage so you can reload quickly next time.
              </p>
            </section>

            <section className="space-y-4">
              <h3 className="text-lg font-semibold text-slate-100">Playlist Options (Optional)</h3>
              <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-slate-200">M3U URL</span>
                <input
                  type="text"
                  placeholder="https://example.com/playlist.m3u"
                  value={m3uUrl}
                  onChange={(e) => setM3uUrl(e.target.value)}
                  disabled={isLoading}
                  className={inputClasses}
                />
                <p className="text-xs text-slate-400">
                  Provide a playlist URL if you want to load channels from an M3U feed instead of Xtream.
                </p>
              </label>

              <Dropzone onDrop={(acceptedFiles) => setM3uFile(acceptedFiles[0])} disabled={isLoading}>
                {({ getRootProps, getInputProps }) => {
                  const dropzoneClasses = [
                    'w-full rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-all duration-150',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                    isLoading
                      ? 'cursor-not-allowed border-slate-800/60 bg-slate-900/50 opacity-60'
                      : 'cursor-pointer border-slate-700 bg-slate-900/60 hover:-translate-y-0.5 hover:border-blue-400/70 hover:bg-slate-900',
                  ].join(' ');

                  return (
                    <section {...getRootProps({ className: dropzoneClasses })}>
                      <input {...getInputProps()} />
                      {m3uFile ? (
                        <div className="flex flex-col items-center gap-2 text-sm">
                          <span className="font-semibold text-slate-200">Selected file</span>
                          <span className="rounded-full bg-slate-900/70 px-3 py-1 text-xs font-medium text-blue-200">
                            {m3uFile.name}
                          </span>
                          <span className="text-xs text-slate-500">Drop or click to replace the file.</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-sm text-slate-300">
                          <span className="font-semibold">Drop M3U file here or click to browse</span>
                          <span className="text-xs text-slate-500">
                            We upload it securely when you start loading.
                          </span>
                        </div>
                      )}
                    </section>
                  );
                }}
              </Dropzone>
            </section>

            <div className="flex justify-end">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleXtreamLoad}
                disabled={isLoading}
              >
                {isLoading ? 'Processing…' : 'Load Xtream Channels'}
              </button>
            </div>
          </div>
        )}

        {isEpgAllowed && activeTab === 'epg' && (
          <div className="mt-8 space-y-8">
            <section className="space-y-3">
              <h3 className="text-lg font-semibold text-slate-100">EPG Source</h3>
              <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-slate-200">EPG URL</span>
                <input
                  type="text"
                  placeholder="https://example.com/guide.xml or .gz"
                  value={epgUrl}
                  onChange={(e) => setEpgUrl(e.target.value)}
                  disabled={isLoading}
                  className={inputClasses}
                />
                <p className="text-xs text-slate-400">
                  Use a direct XMLTV or gzipped URL. You can refresh it any time without reloading channels.
                </p>
              </label>
            </section>

            <div className="flex justify-end">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 via-blue-500 to-blue-700 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleEpgLoad}
                disabled={isLoading}
              >
                {isLoading ? 'Processing…' : 'Load EPG Sources'}
              </button>
            </div>
          </div>
        )}

        {showFooter && (
          <footer className="mt-10 flex flex-col gap-6 lg:flex-row">
            <div className="flex-1 rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 shadow-inner shadow-slate-950/30">
              <h3 className="text-lg font-semibold text-slate-100">Getting Started</h3>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm text-slate-400">
                {guidanceSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            {isEpgAllowed && showSummaryButton && (
              <button
                type="button"
                onClick={loadEpgSummary}
                disabled={isLoading}
                className="self-start rounded-2xl bg-gradient-to-r from-amber-500 via-amber-600 to-orange-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-amber-900/30 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                EPG Summary
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
};

export default Configuration;
