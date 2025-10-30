import React, { useState, useEffect } from 'react';
import Dropzone from 'react-dropzone';
import axios from 'axios';
import LoadingProgress from './LoadingProgress';
import SessionManager from './utils/sessionManager';
import { API_BASE_URL } from './config';
import { registerSession } from './services/SSEService';
import './Configuration.css';

const Configuration = ({
  onLoad,
  error,
  allowedTabs = ['xtream', 'epg'],
  initialTab,
  heading,
  description,
  showFooter = true,
  showSummaryButton = true
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
    const preferredTab = (initialTab && normalizedTabs.includes(initialTab)) ? initialTab : (normalizedTabs[0] || 'xtream');
    setActiveTab(prev => {
      if (prev && normalizedTabs.includes(prev)) {
        return prev;
      }
      return preferredTab;
    });
  }, [allowedTabKey, initialTab]);

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
          'Content-Type': 'multipart/form-data'
        }
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
      }
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
      }
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

  return (
    <div className="configuration-container">
      {error && (
        <div className="config-alert config-alert--error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {isLoading && processingSessionId ? (
        <LoadingProgress
          sessionId={processingSessionId}
          onComplete={handleProcessComplete}
          onChannelsAvailable={handleChannelsAvailable}
          onEpgSourceAvailable={handleEpgSourceAvailable}
        />
      ) : (
        <div className="config-card">
          <div className="config-header">
            <h2>{effectiveHeading}</h2>
            <p>{effectiveDescription}</p>
          </div>

          {status && (
            <div className={`config-status config-status--${statusVariant}`}>
              {status}
            </div>
          )}

          {normalizedTabs.length > 1 && (
            <div className="tab-header">
              {isXtreamAllowed && (
                <button
                  type="button"
                  className={`tab-button ${activeTab === 'xtream' ? 'active' : ''}`}
                  onClick={() => setActiveTab('xtream')}
                  disabled={isLoading}
                >
                  Xtream Login
                </button>
              )}
              {isEpgAllowed && (
                <button
                  type="button"
                  className={`tab-button ${activeTab === 'epg' ? 'active' : ''}`}
                  onClick={() => setActiveTab('epg')}
                  disabled={isLoading}
                >
                  EPG Sources
                </button>
              )}
            </div>
          )}

          {isXtreamAllowed && activeTab === 'xtream' && (
            <div className="tab-panel">
              <div className="config-section">
                <h3 className="section-title">Provider Credentials</h3>
                <div className="form-grid">
                  <div className="form-field">
                    <label>Server URL</label>
                    <input
                      type="text"
                      placeholder="http://example.com:8080"
                      value={xtreamServer}
                      onChange={(e) => setXtreamServer(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="form-field">
                    <label>Username</label>
                    <input
                      type="text"
                      placeholder="Your Xtream username"
                      value={xtreamUsername}
                      onChange={(e) => setXtreamUsername(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="form-field">
                    <label>Password</label>
                    <input
                      type="password"
                      placeholder="Your Xtream password"
                      value={xtreamPassword}
                      onChange={(e) => setXtreamPassword(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                </div>
                <p className="section-hint">
                  Credentials stay in your browser&apos;s storage so you can reload quickly next time.
                </p>
              </div>

              <div className="config-section">
                <h3 className="section-title">Playlist Options (Optional)</h3>
                <div className="form-grid">
                  <div className="form-field full-width">
                    <label>M3U URL</label>
                    <input
                      type="text"
                      placeholder="https://example.com/playlist.m3u"
                      value={m3uUrl}
                      onChange={(e) => setM3uUrl(e.target.value)}
                      disabled={isLoading}
                    />
                    <div className="field-help">
                      Provide a playlist URL if you want to load channels from an M3U feed instead of Xtream.
                    </div>
                  </div>
                </div>

                <Dropzone onDrop={(acceptedFiles) => setM3uFile(acceptedFiles[0])} disabled={isLoading}>
                  {({ getRootProps, getInputProps }) => {
                    const rootProps = getRootProps({
                      className: `upload-dropzone${isLoading ? ' upload-dropzone--disabled' : ''}`
                    });
                    return (
                      <section {...rootProps}>
                        <input {...getInputProps()} />
                        {m3uFile ? (
                          <div className="upload-dropzone__content">
                            <span className="upload-dropzone__label">Selected file</span>
                            <span className="upload-dropzone__value">{m3uFile.name}</span>
                            <span className="upload-dropzone__hint">Drop or click to replace the file.</span>
                          </div>
                        ) : (
                          <div className="upload-dropzone__content">
                            <span className="upload-dropzone__label">Drop M3U file here or click to browse</span>
                            <span className="upload-dropzone__hint">We upload it securely when you start loading.</span>
                          </div>
                        )}
                      </section>
                    );
                  }}
                </Dropzone>
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleXtreamLoad}
                  disabled={isLoading}
                >
                  {isLoading ? 'Processing...' : 'Load Xtream Channels'}
                </button>
              </div>
            </div>
          )}

          {isEpgAllowed && activeTab === 'epg' && (
            <div className="tab-panel">
              <div className="config-section">
                <h3 className="section-title">EPG Source</h3>
                <div className="form-grid">
                  <div className="form-field full-width">
                    <label>EPG URL</label>
                    <input
                      type="text"
                      placeholder="https://example.com/guide.xml or .gz"
                      value={epgUrl}
                      onChange={(e) => setEpgUrl(e.target.value)}
                      disabled={isLoading}
                    />
                    <div className="field-help">
                      Use a direct XMLTV or gzipped URL. You can refresh it any time without reloading channels.
                    </div>
                  </div>
                </div>
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleEpgLoad}
                  disabled={isLoading}
                >
                  {isLoading ? 'Processing...' : 'Load EPG Sources'}
                </button>
              </div>
            </div>
          )}

          {showFooter && (
            <div className="config-footer">
              <div className="info-card">
                <h3>Getting Started</h3>
                {isEpgOnly ? (
                  <ol>
                    <li>Paste a new XMLTV or gzipped URL.</li>
                    <li>Load the source to fetch the latest guide data.</li>
                    <li>Use the summary panel to confirm the imported sources.</li>
                    <li>Return to Channels or Player to match listings.</li>
                  </ol>
                ) : (
                  <ol>
                    <li>Enter Xtream credentials or point to an M3U playlist.</li>
                    <li>Load channels and let the progress screen finish.</li>
                    <li>Open the EPG tab to add or refresh guide data.</li>
                    <li>Match channels with guide entries and export what you need.</li>
                  </ol>
                )}
              </div>
              {isEpgAllowed && showSummaryButton && (
                <button type="button" className="summary-button" onClick={loadEpgSummary} disabled={isLoading}>
                  EPG Summary
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Configuration;
