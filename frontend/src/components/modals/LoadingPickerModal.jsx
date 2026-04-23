import React from 'react';

export function LoadingPickerModal({ isOpen, onClose, backgroundLoadings }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full">
        <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-100">Background Loads ({backgroundLoadings.size})</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
          {Array.from(backgroundLoadings.values()).map((loading) => (
            <div
              key={loading.sessionId}
              className="bg-slate-800 rounded-lg p-4 border border-slate-700 hover:border-slate-600 transition-colors"
            >
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-blue-400 animate-spin flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>

                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-100 mb-1">{loading.sourceName}</div>
                  <div className="text-sm text-slate-400 break-words">{loading.status || 'Processing...'}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-slate-800 px-6 py-3 border-t border-slate-700 text-xs text-slate-400">
          These sources are loading in the background. Close this modal to continue working.
        </div>
      </div>
    </div>
  );
}
