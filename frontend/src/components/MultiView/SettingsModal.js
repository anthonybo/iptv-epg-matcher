import React from 'react';
import LocationSelector from '../LocationSelector';

const SettingsModal = ({
  isOpen,
  onClose,
  streams,
  autoFillSettings,
  setAutoFillSettings
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl max-w-md w-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-slate-100">Multi-View Settings</h2>
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
            Configure auto-fill behavior for quick stream population
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Max Slots Setting */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Max Auto-Fill Slots
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="9"
                value={autoFillSettings.maxSlots}
                onChange={(e) => setAutoFillSettings(prev => ({ ...prev, maxSlots: parseInt(e.target.value) }))}
                className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
              <span className="w-8 text-center text-lg font-bold text-emerald-400">
                {autoFillSettings.maxSlots}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              When you click a sport, auto-fill will add up to {autoFillSettings.maxSlots} stream{autoFillSettings.maxSlots !== 1 ? 's' : ''} total
            </p>
          </div>

          {/* Quick Presets */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Quick Presets
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[2, 4, 6, 9].map((num) => (
                <button
                  key={num}
                  onClick={() => setAutoFillSettings(prev => ({ ...prev, maxSlots: num }))}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                    autoFillSettings.maxSlots === num
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
                  }`}
                >
                  {num} slots
                </button>
              ))}
            </div>
          </div>

          {/* Avoid Duplicate Sources */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-slate-300">
                Avoid Duplicate Sources
              </label>
              <p className="text-xs text-slate-500">
                Use different IPTV sources for each stream
              </p>
            </div>
            <button
              onClick={() => setAutoFillSettings(prev => ({ ...prev, avoidDuplicateSources: !prev.avoidDuplicateSources }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoFillSettings.avoidDuplicateSources ? 'bg-emerald-600' : 'bg-slate-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoFillSettings.avoidDuplicateSources ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Avoid Duplicate Events */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-slate-300">
                Avoid Duplicate Events
              </label>
              <p className="text-xs text-slate-500">
                Don't add the same game/event twice
              </p>
            </div>
            <button
              onClick={() => setAutoFillSettings(prev => ({ ...prev, avoidDuplicateEvents: !prev.avoidDuplicateEvents }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoFillSettings.avoidDuplicateEvents ? 'bg-emerald-600' : 'bg-slate-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoFillSettings.avoidDuplicateEvents ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Minimum Quality Setting */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Minimum Stream Quality
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[
                { value: 0, label: 'Any' },
                { value: 480, label: '480p' },
                { value: 720, label: '720p' },
                { value: 1080, label: '1080p' }
              ].map((quality) => (
                <button
                  key={quality.value}
                  onClick={() => setAutoFillSettings(prev => ({ ...prev, minQuality: quality.value }))}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                    autoFillSettings.minQuality === quality.value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
                  }`}
                >
                  {quality.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {[
                { value: 1440, label: '1440p (2K)' },
                { value: 2160, label: '2160p (4K)' },
                { value: 4320, label: '4320p (8K)' }
              ].map((quality) => (
                <button
                  key={quality.value}
                  onClick={() => setAutoFillSettings(prev => ({ ...prev, minQuality: quality.value }))}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                    autoFillSettings.minQuality === quality.value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
                  }`}
                >
                  {quality.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {autoFillSettings.minQuality === 0
                ? 'Accept any stream quality'
                : `Only accept streams ${autoFillSettings.minQuality}p or higher`
              }
            </p>
          </div>

          {/* Location Setting for Local News */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Your Location
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Used for finding local news channels
            </p>
            <LocationSelector compact={false} showLabel={true} className="w-full" />
          </div>

          {/* Current Status */}
          <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                Currently: {streams.length} stream{streams.length !== 1 ? 's' : ''} active
                {streams.length < autoFillSettings.maxSlots && (
                  <span className="text-emerald-400 ml-1">
                    ({autoFillSettings.maxSlots - streams.length} slot{autoFillSettings.maxSlots - streams.length !== 1 ? 's' : ''} available)
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700 bg-slate-900/50">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm font-semibold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
