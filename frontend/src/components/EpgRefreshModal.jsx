import React, { useState } from 'react';

const EpgRefreshModal = ({ isOpen, onClose, progress }) => {
  const [isMinimized, setIsMinimized] = useState(false);

  if (!isOpen) return null;

  const { sources = [], currentSource, totalSources, status, error, currentMessage, progressInfo, currentSourceName } = progress;

  // Find the source that's currently being refreshed
  const activeSource = sources.find(s => s.status === 'refreshing');
  const displaySourceName = activeSource?.name || currentSourceName || null;

  const toggleMinimize = () => {
    setIsMinimized(!isMinimized);
  };

  // Minimized floating indicator
  if (isMinimized) {
    return (
      <div
        onClick={toggleMinimize}
        className="fixed bottom-6 left-6 z-50 bg-gray-800 rounded-lg shadow-2xl border border-gray-700 cursor-pointer hover:shadow-xl transition-shadow"
        style={{ minWidth: '320px' }}
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {status !== 'complete' && (
                <div className="animate-spin">
                  <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
              )}
              {status === 'complete' && (
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
              )}
              <span className="text-sm font-medium text-gray-100">
                {status === 'complete' ? 'Refresh Complete' : 'Refreshing EPG Sources'}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleMinimize();
              }}
              className="text-gray-400 hover:text-gray-200 transition-colors"
              title="Expand"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
          </div>

          {totalSources > 0 && (
            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-2">
                <span>Progress</span>
                <span className="font-medium">Source {currentSource} of {totalSources}</span>
              </div>
              {progressInfo && (
                <div className="text-xs text-blue-400 font-semibold mb-2">
                  {progressInfo}
                </div>
              )}
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${((currentSource - 1) / totalSources * 100)}%` }}
                />
              </div>
            </div>
          )}

          {status === 'polling' && (
            <div className="text-xs text-gray-400 mt-2">
              EPG parser is running (downloading & processing sources)...
            </div>
          )}

          {status === 'complete' && !error && (
            <div className="text-xs text-green-400 mt-2 flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              Successfully refreshed!
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 mt-2">
              {error}
            </div>
          )}

          {status === 'complete' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="mt-3 w-full px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-500 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <h2 className="text-xl font-semibold text-gray-100">
            Refreshing EPG Sources
          </h2>
          <div className="flex items-center gap-2">
            {status !== 'complete' && (
              <button
                onClick={toggleMinimize}
                className="text-gray-400 hover:text-gray-200 transition-colors"
                title="Minimize"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4" />
                </svg>
              </button>
            )}
            {status === 'complete' && (
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-200 transition-colors"
                title="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          {/* Overall Progress */}
          {totalSources > 0 && (
            <div className="mb-5">
              <div className="flex justify-between text-sm font-medium text-gray-300 mb-2">
                <span>Overall Progress</span>
                <span className="text-blue-400">{currentSource} / {totalSources} sources</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2.5">
                <div
                  className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${(currentSource / totalSources) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Status Message */}
          {status === 'starting' && (
            <div className="flex items-center gap-3 p-4 bg-blue-900/30 border border-blue-700/50 rounded-lg mb-4">
              <div className="animate-spin">
                <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
              <span className="text-blue-200">Starting EPG refresh...</span>
            </div>
          )}

          {status === 'refreshing' && (
            <div className="flex items-start gap-3 p-4 bg-blue-900/30 border border-blue-700/50 rounded-lg mb-4">
              <div className="animate-spin flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-blue-200 font-medium">
                  {currentMessage || (currentSource && totalSources
                    ? `Processing source ${currentSource} of ${totalSources}...`
                    : 'Downloading and processing EPG sources...')}
                </div>
                {currentSource && totalSources && (
                  <div className="text-blue-300 text-sm mt-1">
                    Source {currentSource} of {totalSources}
                  </div>
                )}
              </div>
            </div>
          )}

          {status === 'polling' && (
            <div className="flex items-center gap-3 p-4 bg-yellow-900/30 border border-yellow-700/50 rounded-lg mb-4">
              <div className="animate-spin">
                <svg className="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="text-yellow-200 font-medium">Python EPG parser is running...</div>
                <div className="text-yellow-300 text-xs mt-1">Downloading and processing EPG sources (this may take 5-15 minutes for large files)</div>
              </div>
            </div>
          )}

          {status === 'complete' && !error && (
            <div className="flex items-center gap-3 p-4 bg-green-900/30 border border-green-700/50 rounded-lg mb-4">
              <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-green-200">EPG sources refreshed successfully!</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-3 p-4 bg-red-900/30 border border-red-700/50 rounded-lg mb-4">
              <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span className="text-red-200">{error}</span>
            </div>
          )}

          {/* Sources List */}
          {sources.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Sources ({sources.length})</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                {sources.map((source, index) => (
                  <div
                    key={source.id || index}
                    className={`flex items-start gap-3 p-3 rounded-lg border ${
                      source.enabled === false
                        ? 'bg-gray-800 border-gray-700 opacity-60'
                        : source.status === 'complete'
                        ? 'bg-green-900/30 border-green-700/50'
                        : source.status === 'refreshing'
                        ? 'bg-blue-900/30 border-blue-700/50'
                        : source.status === 'error' || source.status === 'failed'
                        ? 'bg-red-900/30 border-red-700/50'
                        : 'bg-gray-800 border-gray-700'
                    }`}
                  >
                    {/* Status Icon */}
                    {source.status === 'disabled' && (
                      <svg className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                    )}
                    {source.status === 'complete' && source.enabled !== false && (
                      <svg className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {source.status === 'refreshing' && source.enabled !== false && (
                      <div className="animate-spin flex-shrink-0 mt-0.5">
                        <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      </div>
                    )}
                    {(source.status === 'error' || source.status === 'failed') && source.enabled !== false && (
                      <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                    {(!source.status || source.status === 'pending') && source.enabled !== false && (
                      <div className="w-5 h-5 rounded-full border-2 border-gray-600 flex-shrink-0 mt-0.5" />
                    )}

                    {/* Source Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-sm font-medium text-gray-100 break-words">
                          {source.name}
                        </div>
                        {source.enabled === false && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-700 text-gray-300">
                            Disabled
                          </span>
                        )}
                        {source.verified === false && source.enabled !== false && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300">
                            Unverified
                          </span>
                        )}
                      </div>
                      {source.url && (
                        <div className="text-xs text-gray-400 break-all mt-1 leading-relaxed">
                          {source.url}
                        </div>
                      )}
                      {source.notes && (
                        <div className="text-xs text-gray-400 mt-1 italic">
                          {source.notes}
                        </div>
                      )}
                      {source.status === 'complete' && source.channels !== undefined && (
                        <div className="text-xs text-green-300 mt-1.5 font-medium">
                          {source.channels?.toLocaleString()} channels • {source.programs?.toLocaleString()} programs
                        </div>
                      )}
                      {source.error && (
                        <div className="text-xs text-red-300 mt-1.5 break-words">
                          {source.error}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {status === 'complete' && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-700 flex-shrink-0">
            <button
              onClick={onClose}
              className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors font-medium shadow-sm"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default EpgRefreshModal;
