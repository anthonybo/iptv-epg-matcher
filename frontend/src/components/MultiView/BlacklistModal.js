import React from 'react';

const BlacklistModal = ({
  isOpen,
  onClose,
  blacklistedChannels,
  onRemoveFromBlacklist
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-slate-100">Blacklisted Channels</h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            These channels will be excluded from random stream searches
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {blacklistedChannels.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-16 h-16 mx-auto text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              <p className="text-slate-400">No blacklisted channels</p>
              <p className="text-sm text-slate-500 mt-1">
                Click the ban icon on a stream to blacklist it
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {blacklistedChannels.map((channelName, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700 hover:border-slate-600 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <svg className="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                    <span className="text-sm text-slate-200 truncate">{channelName}</span>
                  </div>
                  <button
                    onClick={() => onRemoveFromBlacklist(channelName)}
                    className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-700 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/40 transition-colors"
                  >
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700 bg-slate-900/50">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm font-semibold rounded-lg border border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default BlacklistModal;
