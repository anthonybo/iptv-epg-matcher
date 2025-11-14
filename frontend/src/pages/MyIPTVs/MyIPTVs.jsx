import React, { useState, useEffect } from 'react';
import iptvSourcesService from '../../services/iptvSourcesService';
import Configuration from '../../Configuration';

/**
 * Source card component
 */
const SourceCard = ({ source, onEdit, onDelete, onViewChannels, onRefreshAccountInfo, onEditCredentials, refreshStatus }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [nickname, setNickname] = useState(source.nickname || source.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showEditCredentials, setShowEditCredentials] = useState(false);
  const [credentials, setCredentials] = useState({
    url: source.url || '',
    username: source.username || '',
    password: source.password || ''
  });

  const handleSaveNickname = async () => {
    if (nickname.trim() && nickname !== source.nickname) {
      await onEdit(source.id, nickname.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSaveNickname();
    } else if (e.key === 'Escape') {
      setNickname(source.nickname || source.name);
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    await onDelete(source.id);
    setShowDeleteConfirm(false);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefreshAccountInfo(source.id);
    } catch (error) {
      console.error('Error refreshing account info:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSaveCredentials = async () => {
    try {
      await onEditCredentials(source.id, credentials);
      setShowEditCredentials(false);
    } catch (error) {
      console.error('Error updating credentials:', error);
    }
  };

  return (
    <div className="group relative rounded-xl border border-slate-700 bg-slate-800/50 p-5 hover:border-slate-600 hover:bg-slate-800/70 transition-all">
      {/* Refresh Status Badge */}
      {refreshStatus && (
        <div className="absolute -top-2 -right-2 z-10">
          {refreshStatus === 'loading' && (
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-500 border-2 border-slate-900 shadow-lg">
              <svg className="w-4 h-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
          )}
          {refreshStatus === 'success' && (
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-emerald-500 border-2 border-slate-900 shadow-lg animate-bounce">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          )}
          {refreshStatus === 'error' && (
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-500 border-2 border-slate-900 shadow-lg animate-pulse">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
          )}
        </div>
      )}

      {/* Source icon */}
      <div className="mb-3 inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-500/20 text-blue-300">
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      </div>

      {/* Name/Nickname */}
      {isEditing ? (
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onBlur={handleSaveNickname}
          onKeyDown={handleKeyDown}
          className="w-full rounded-lg border border-blue-500 bg-slate-900 px-3 py-1.5 text-base font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60 mb-2"
          autoFocus
        />
      ) : (
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-base font-semibold text-slate-100 flex-1 truncate">
            {source.nickname || source.name}
          </h3>
          <div className="flex items-center gap-1">
            {(source.type === 'xtream' || source.type === 'stalker') && (
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-blue-400 transition-opacity disabled:opacity-50"
                title="Refresh channels and account info"
              >
                {isRefreshing ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
              </button>
            )}
            {source.type === 'xtream' && (
              <button
                onClick={() => setShowEditCredentials(true)}
                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-amber-400 transition-opacity"
                title="Edit credentials"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setIsEditing(true)}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-200 transition-opacity"
              title="Edit nickname"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Source details */}
      <div className="space-y-1.5 mb-4">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="font-medium text-slate-100">{source.channel_count || 0}</span>
          <span>channels</span>
        </div>

        <div className="flex items-center gap-2 text-sm text-slate-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <span className="truncate">{source.type}</span>
        </div>

        <div className="flex items-start gap-2 text-sm text-slate-400">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span className="truncate flex-1" title={source.url}>{source.url}</span>
        </div>

        {source.username && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span className="truncate">{source.username}</span>
          </div>
        )}

        {source.password && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <span className="truncate">{source.password}</span>
          </div>
        )}

        {/* Account Info Section */}
        {(source.exp_date || source.max_connections || source.account_status) && (
          <div className="border-t border-slate-700/50 pt-3 mt-3 space-y-2">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Account Info</div>

            {source.exp_date && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-slate-500">Expires:</span>
                <span className="font-medium text-slate-300">
                  {source.exp_date === 'null' || !source.exp_date ? 'Unlimited' : new Date(parseInt(source.exp_date) * 1000).toLocaleDateString()}
                </span>
              </div>
            )}

            {source.account_status && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-slate-500">Status:</span>
                <span className={`font-medium ${source.account_status === 'Active' ? 'text-green-400' : 'text-red-400'}`}>
                  {source.account_status}
                </span>
              </div>
            )}

            {(source.active_connections !== null && source.active_connections !== undefined) && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <span className="text-slate-500">Connections:</span>
                <span className="font-medium text-slate-300">
                  {source.active_connections} / {source.max_connections || '?'}
                </span>
              </div>
            )}

            {source.is_trial === 1 && (
              <div className="flex items-center gap-2 text-sm">
                <svg className="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="font-medium text-yellow-400">Trial Account</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {!showDeleteConfirm ? (
          <>
            <button
              onClick={() => onViewChannels(source)}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/30 px-3 py-2 text-sm font-medium text-blue-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              View Channels
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800 hover:bg-red-500/20 hover:border-red-500/40 px-3 py-2 text-slate-400 hover:text-red-300 transition-colors"
              title="Delete source"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleDelete}
              className="flex-1 inline-flex items-center justify-center rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-400/30 px-3 py-2 text-sm font-medium text-red-100 transition-colors"
            >
              Confirm Delete
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="flex-1 inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition-colors"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {/* Edit Credentials Modal */}
      {showEditCredentials && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full">
            {/* Modal Header */}
            <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-xl font-semibold text-slate-100">Edit Credentials</h3>
              <button
                onClick={() => setShowEditCredentials(false)}
                className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveCredentials();
              }}
              className="p-6 space-y-4"
            >
              <div>
                <label htmlFor={`url-${source.id}`} className="block text-sm font-medium text-slate-300 mb-2">
                  Server URL
                </label>
                <input
                  id={`url-${source.id}`}
                  type="url"
                  name="url"
                  autoComplete="url"
                  value={credentials.url}
                  onChange={(e) => setCredentials({ ...credentials, url: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                  placeholder="http://example.com:8080"
                  required
                />
              </div>

              <div>
                <label htmlFor={`username-${source.id}`} className="block text-sm font-medium text-slate-300 mb-2">
                  Username
                </label>
                <input
                  id={`username-${source.id}`}
                  type="text"
                  name="username"
                  autoComplete="username"
                  value={credentials.username}
                  onChange={(e) => setCredentials({ ...credentials, username: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                  placeholder="username"
                />
              </div>

              <div>
                <label htmlFor={`password-${source.id}`} className="block text-sm font-medium text-slate-300 mb-2">
                  Password
                </label>
                <input
                  id={`password-${source.id}`}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={credentials.password}
                  onChange={(e) => setCredentials({ ...credentials, password: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                  placeholder="password"
                />
              </div>

              {/* Modal Footer */}
              <div className="bg-slate-800 px-6 py-4 -mx-6 -mb-6 border-t border-slate-700 flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setShowEditCredentials(false)}
                  className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white font-medium transition-colors"
                >
                  Save & Refresh
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * My IPTVs management page
 */
const MyIPTVs = ({
  onSourcesUpdated,
  onViewChannels: onViewChannelsProp,
  onLoad,
  loadingError,
  backgroundLoadings,
  setBackgroundLoadings,
  showLoadingPicker,
  setShowLoadingPicker,
  showAddModal,
  setShowAddModal
}) => {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({ current: 0, total: 0 });
  const [sourceRefreshStatus, setSourceRefreshStatus] = useState({}); // Track status per source: { sourceId: 'loading' | 'success' | 'error' }

  // Load sources on mount
  useEffect(() => {
    loadSources();
  }, []);

  const loadSources = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await iptvSourcesService.getUserSources();
      setSources(data);
    } catch (err) {
      console.error('Error loading sources:', err);
      setError('Failed to load IPTV sources');
    } finally {
      setLoading(false);
    }
  };

  const handleEditNickname = async (sourceId, nickname) => {
    try {
      await iptvSourcesService.updateSourceNickname(sourceId, nickname);
      // Update local state
      setSources(prev => prev.map(s => s.id === sourceId ? { ...s, nickname } : s));
      if (onSourcesUpdated) onSourcesUpdated();
    } catch (err) {
      console.error('Error updating nickname:', err);
      alert('Failed to update nickname');
    }
  };

  const handleDelete = async (sourceId) => {
    try {
      await iptvSourcesService.deleteSource(sourceId);
      // Remove from local state
      setSources(prev => prev.filter(s => s.id !== sourceId));
      if (onSourcesUpdated) onSourcesUpdated();
    } catch (err) {
      console.error('Error deleting source:', err);
      alert('Failed to delete source');
    }
  };

  const handleViewChannels = (source) => {
    if (onViewChannelsProp) {
      onViewChannelsProp(source);
    }
  };

  const handleRefreshAccountInfo = async (sourceId) => {
    try {
      const result = await iptvSourcesService.refreshAccountInfo(sourceId);

      // Show success message with channel count
      if (result.success) {
        setNotification({
          type: 'success',
          message: `Successfully refreshed! Loaded ${result.channelCount} channels and ${result.categoryCount} categories.`
        });
        setTimeout(() => setNotification(null), 5000);
      }

      // Reload sources to get updated data
      await loadSources();
      if (onSourcesUpdated) onSourcesUpdated();
    } catch (err) {
      console.error('Error refreshing source:', err);
      const errorMsg = err.response?.data?.error || 'Failed to refresh source data';
      setNotification({
        type: 'error',
        message: errorMsg
      });
      setTimeout(() => setNotification(null), 5000);
    }
  };

  const handleRefreshAll = async () => {
    if (isRefreshingAll || sources.length === 0) return;

    setIsRefreshingAll(true);
    setRefreshProgress({ current: 0, total: sources.length });

    // Initialize all sources as loading
    const initialStatus = {};
    sources.forEach(source => {
      initialStatus[source.id] = 'loading';
    });
    setSourceRefreshStatus(initialStatus);

    const startTime = Date.now();

    // Refresh all sources in parallel using Promise.allSettled
    const refreshPromises = sources.map(async (source) => {
      try {
        const result = await iptvSourcesService.refreshAccountInfo(source.id);

        // Update status to success
        setSourceRefreshStatus(prev => ({ ...prev, [source.id]: 'success' }));
        setRefreshProgress(prev => ({ ...prev, current: prev.current + 1 }));

        return { sourceId: source.id, status: 'success', result };
      } catch (err) {
        console.error(`Error refreshing source ${source.id}:`, err);

        // Update status to error
        setSourceRefreshStatus(prev => ({ ...prev, [source.id]: 'error' }));
        setRefreshProgress(prev => ({ ...prev, current: prev.current + 1 }));

        return { sourceId: source.id, status: 'error', error: err.message };
      }
    });

    // Wait for all refreshes to complete
    const results = await Promise.allSettled(refreshPromises);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    // Count successes and failures
    let successCount = 0;
    let failCount = 0;

    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value.status === 'success') {
        successCount++;
      } else {
        failCount++;
      }
    });

    // Reload sources to get updated data
    await loadSources();
    if (onSourcesUpdated) onSourcesUpdated();

    setIsRefreshingAll(false);
    setRefreshProgress({ current: 0, total: 0 });

    // Show final summary with timing
    setNotification({
      type: failCount === 0 ? 'success' : 'warning',
      message: `Refresh complete in ${duration}s! ${successCount} succeeded${failCount > 0 ? `, ${failCount} failed` : ''}.`
    });
    setTimeout(() => {
      setNotification(null);
      setSourceRefreshStatus({}); // Clear status indicators
    }, 8000);
  };

  const handleEditCredentials = async (sourceId, credentials) => {
    try {
      // Update credentials
      await iptvSourcesService.updateSourceCredentials(sourceId, credentials);

      // Show success notification
      setNotification({
        type: 'success',
        message: 'Credentials updated successfully! Refreshing channels...'
      });
      setTimeout(() => setNotification(null), 5000);

      // Refresh account info to fetch new channels with updated credentials
      await handleRefreshAccountInfo(sourceId);
    } catch (err) {
      console.error('Error updating credentials:', err);
      const errorMsg = err.response?.data?.error || 'Failed to update credentials';
      setNotification({
        type: 'error',
        message: errorMsg
      });
      setTimeout(() => setNotification(null), 5000);
      throw err; // Re-throw so SourceCard can handle it
    }
  };

  return (
    <div className="space-y-6">
      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 rounded-lg border px-4 py-3 shadow-lg max-w-md ${
          notification.type === 'success'
            ? 'bg-green-900/90 border-green-700 text-green-100'
            : 'bg-red-900/90 border-red-700 text-red-100'
        }`}>
          <div className="flex items-start gap-3">
            {notification.type === 'success' ? (
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <div className="flex-1">
              <p className="text-sm font-medium">{notification.message}</p>
            </div>
            <button
              onClick={() => setNotification(null)}
              className="text-current opacity-70 hover:opacity-100 transition-opacity"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold text-slate-100 mb-2">My IPTV Sources</h2>
          <p className="text-sm text-slate-400">
            Manage your IPTV sources and click on one to view its channels
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefreshAll}
            disabled={isRefreshingAll || sources.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/20 px-4 py-2.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-500/60 transition-all shadow-lg shadow-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRefreshingAll ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {refreshProgress.current}/{refreshProgress.total}
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh All
              </>
            )}
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/20 px-4 py-2.5 text-sm font-semibold text-blue-100 hover:bg-blue-500/30 hover:border-blue-500/60 transition-all shadow-lg shadow-blue-900/20"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add IPTV Source
          </button>
        </div>
      </header>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mb-3"></div>
            <p className="text-sm text-slate-400">Loading sources...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-200 mb-1">Error</h3>
              <p className="text-sm text-red-100/80">{error}</p>
            </div>
            <button
              onClick={loadSources}
              className="text-sm text-red-300 hover:text-red-200 underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && sources.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/30 p-12 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 text-slate-500 mb-4">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-200 mb-2">No IPTV sources yet</h3>
          <p className="text-sm text-slate-400 mb-4">Add an IPTV source to get started</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/20 px-4 py-2.5 text-sm font-medium text-blue-100 hover:bg-blue-500/30 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add IPTV Source
          </button>
        </div>
      )}

      {/* Sources grid */}
      {!loading && !error && sources.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              onEdit={handleEditNickname}
              onDelete={handleDelete}
              onViewChannels={handleViewChannels}
              onRefreshAccountInfo={handleRefreshAccountInfo}
              onEditCredentials={handleEditCredentials}
              refreshStatus={sourceRefreshStatus[source.id]}
            />
          ))}
        </div>
      )}

      {/* Add Source Modal - Keep mounted to preserve loading state */}
      {/* Only render when there are background loadings OR modal is explicitly shown */}
      {(showAddModal || backgroundLoadings.size > 0) && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 transition-opacity duration-200 ${showAddModal ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
          <div className={`bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col transition-transform duration-200 ${showAddModal ? 'scale-100' : 'scale-95'}`}>
          {/* Modal Header */}
          <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-xl font-semibold text-slate-100">Add IPTV Source</h3>
            <button
              onClick={() => setShowAddModal(false)}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Modal Content */}
          <div className="flex-1 overflow-y-auto p-6">
            <Configuration
              onLoad={async (data) => {
                await onLoad(data);
                setShowAddModal(false);
                setBackgroundLoadings(new Map()); // Clear all background loadings on completion
                await loadSources();
                if (onSourcesUpdated) onSourcesUpdated();
                // Note: handleLoad will switch to 'channels' tab, but App.js will handle staying on myiptvs
              }}
              error={loadingError}
              allowedTabs={['xtream', 'stalker']}
              onLoadingChange={(isLoading, sessionId, status, variant) => {
                // Track loading state even when modal is closed
                if (isLoading && sessionId) {
                  // Extract source name from status message if possible
                  let sourceName = 'IPTV Source';
                  if (status) {
                    // Try to extract portal URL or server from status
                    const portalMatch = status.match(/portal[:\s]+([^\s,]+)/i);
                    const serverMatch = status.match(/server[:\s]+([^\s,]+)/i);
                    if (portalMatch) sourceName = portalMatch[1];
                    else if (serverMatch) sourceName = serverMatch[1];
                  }

                  setBackgroundLoadings(prev => {
                    const next = new Map(prev);
                    next.set(sessionId, { sessionId, status, variant, sourceName });
                    return next;
                  });
                } else if (sessionId) {
                  // Remove this session from background loadings
                  setBackgroundLoadings(prev => {
                    const next = new Map(prev);
                    next.delete(sessionId);
                    return next;
                  });
                }
              }}
            />
          </div>
        </div>
      </div>
      )}
    </div>
  );
};

export default MyIPTVs;
