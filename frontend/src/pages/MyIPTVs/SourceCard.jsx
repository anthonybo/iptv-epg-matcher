import React, { useState } from 'react';
import EditCredentialsModal from './EditCredentialsModal';

const SourceCard = ({ source, onEdit, onDelete, onViewChannels, onRefreshAccountInfo, onEditCredentials, onTestStreams, refreshStatus }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [nickname, setNickname] = useState(source.nickname || source.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
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

  const handleTest = async () => {
    if (!onTestStreams) return;
    setIsTesting(true);
    try {
      await onTestStreams(source.id);
    } catch (error) {
      console.error('Error testing streams:', error);
    } finally {
      setIsTesting(false);
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
              <>
                <button
                  onClick={handleRefresh}
                  disabled={isRefreshing || isTesting}
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
                <button
                  onClick={handleTest}
                  disabled={isRefreshing || isTesting}
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-emerald-400 transition-opacity disabled:opacity-50"
                  title="Test stream connectivity"
                >
                  {isTesting ? (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                </button>
              </>
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

        {/* Server Location */}
        {source.server_country && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-slate-300">
              {source.server_city ? `${source.server_city}, ` : ''}{source.server_country}
            </span>
          </div>
        )}

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

        {/* Last Refresh Status Section */}
        {(source.last_refresh_attempt || source.failure_count > 0) && (
          <div className="border-t border-slate-700/50 pt-3 mt-3 space-y-2">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Last Refresh</div>

            {source.last_refresh_attempt && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-slate-500">Time:</span>
                <span className="font-medium text-slate-300">
                  {new Date(source.last_refresh_attempt).toLocaleString()}
                </span>
                {source.last_refresh_duration_ms && (
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    source.last_refresh_duration_ms > 120000 ? 'bg-red-500/30 text-red-300 border border-red-500/40' :
                    source.last_refresh_duration_ms > 60000 ? 'bg-amber-500/30 text-amber-300 border border-amber-500/40' :
                    'bg-blue-500/30 text-blue-300 border border-blue-500/40'
                  }`}>
                    {source.last_refresh_duration_ms >= 60000
                      ? `${(source.last_refresh_duration_ms / 60000).toFixed(1)}m`
                      : `${(source.last_refresh_duration_ms / 1000).toFixed(1)}s`
                    }
                  </span>
                )}
              </div>
            )}

            {source.last_refresh_status && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-slate-500">Status:</span>
                <span className={`font-medium ${source.last_refresh_status === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {source.last_refresh_status === 'success' ? 'Success' : 'Failed'}
                </span>
              </div>
            )}

            {source.last_refresh_error && (
              <div className="flex items-start gap-2 text-sm text-slate-400">
                <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1">
                  <span className="text-slate-500">Error:</span>
                  <p className="text-red-400 font-medium mt-1 text-xs leading-relaxed break-words">
                    {source.last_refresh_error}
                  </p>
                </div>
              </div>
            )}

            {/* Failure tracking */}
            {source.failure_count > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-700/30 space-y-2">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="text-slate-500">Failures:</span>
                  <span className={`font-medium ${source.failure_count >= 5 ? 'text-red-400' : source.failure_count >= 3 ? 'text-amber-400' : 'text-slate-300'}`}>
                    {source.failure_count} {source.failure_count === 1 ? 'time' : 'times'}
                  </span>
                  {source.last_failure_time && (
                    <span className="text-slate-500 text-xs">
                      (last: {new Date(source.last_failure_time).toLocaleDateString()})
                    </span>
                  )}
                </div>
                {(source.last_successful_refresh || source.last_refreshed) && (
                  <div className="flex items-center gap-2 text-sm text-slate-400">
                    <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-slate-500">Last success:</span>
                    <span className="font-medium text-emerald-400">
                      {new Date(source.last_successful_refresh || source.last_refreshed).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            )}
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

      {showEditCredentials && (
        <EditCredentialsModal
          sourceId={source.id}
          credentials={credentials}
          onChange={setCredentials}
          onSubmit={handleSaveCredentials}
          onClose={() => setShowEditCredentials(false)}
        />
      )}
    </div>
  );
};

export default SourceCard;
