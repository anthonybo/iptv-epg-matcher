import React from 'react';
import Modal from './Modal';

/**
 * Status badge component for overall health
 */
const StatusBadge = ({ status }) => {
  const configs = {
    healthy: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-400', label: 'Healthy' },
    partial: { bg: 'bg-yellow-500/20', border: 'border-yellow-500/40', text: 'text-yellow-400', label: 'Partial' },
    degraded: { bg: 'bg-orange-500/20', border: 'border-orange-500/40', text: 'text-orange-400', label: 'Degraded' },
    failing: { bg: 'bg-red-500/20', border: 'border-red-500/40', text: 'text-red-400', label: 'Failing' },
    unknown: { bg: 'bg-slate-500/20', border: 'border-slate-500/40', text: 'text-slate-400', label: 'Unknown' }
  };

  const config = configs[status] || configs.unknown;

  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${config.bg} ${config.border} ${config.text} border`}>
      {config.label}
    </span>
  );
};

/**
 * Individual test result row
 */
const TestResultRow = ({ result }) => {
  const statusIcon = result.status === 'passed' ? (
    <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ) : (
    <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg ${result.status === 'passed' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
      <div className="mt-0.5">{statusIcon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-200 truncate">{result.channelName}</span>
          {result.resolution && (
            <span className="text-xs bg-slate-700 px-2 py-0.5 rounded text-slate-300">{result.resolution}</span>
          )}
        </div>
        <div className="text-sm text-slate-400">{result.category}</div>
        {result.error && (
          <div className="text-sm text-red-400 mt-1">{result.error}</div>
        )}
        {result.responseTime && (
          <div className="text-xs text-slate-500 mt-1">{result.responseTime}ms</div>
        )}
      </div>
    </div>
  );
};

/**
 * Error breakdown chart
 */
const ErrorBreakdown = ({ breakdown, total }) => {
  if (total === 0) return null;

  const errorTypes = [
    { key: 'auth', label: 'Auth (401/403)', color: 'bg-red-500' },
    { key: 'timeout', label: 'Timeout', color: 'bg-yellow-500' },
    { key: 'connection', label: 'Connection', color: 'bg-orange-500' },
    { key: 'notFound', label: 'Not Found (404)', color: 'bg-purple-500' },
    { key: 'noVideo', label: 'No Video', color: 'bg-blue-500' },
    { key: 'other', label: 'Other', color: 'bg-slate-500' }
  ];

  const activeErrors = errorTypes.filter(e => breakdown[e.key] > 0);

  if (activeErrors.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-slate-300">Error Breakdown</h4>
      <div className="space-y-1">
        {activeErrors.map(({ key, label, color }) => (
          <div key={key} className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${color}`}></div>
            <span className="text-sm text-slate-400 flex-1">{label}</span>
            <span className="text-sm font-medium text-slate-300">{breakdown[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Stream Diagnostics Modal
 * Shows detailed stream health information for troubleshooting
 */
const StreamDiagnosticsModal = ({ isOpen, onClose, diagnostics, sourceName }) => {
  if (!diagnostics) return null;

  const passRate = diagnostics.tested > 0
    ? Math.round((diagnostics.passed / diagnostics.tested) * 100)
    : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Stream Health Diagnostics"
      size="xl"
    >
      <div className="space-y-6 max-h-[70vh] overflow-y-auto">
        {/* Header Summary */}
        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-100">{sourceName}</h3>
              <p className="text-sm text-slate-400">Stream connectivity test results</p>
            </div>
            <StatusBadge status={diagnostics.overallStatus} />
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-slate-100">{diagnostics.tested}</div>
              <div className="text-xs text-slate-400">Tested</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-emerald-400">{diagnostics.passed}</div>
              <div className="text-xs text-slate-400">Passed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">{diagnostics.failed}</div>
              <div className="text-xs text-slate-400">Failed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-slate-100">{passRate}%</div>
              <div className="text-xs text-slate-400">Pass Rate</div>
            </div>
          </div>
        </div>

        {/* Server Location */}
        {diagnostics.serverLocation && (
          <div className="bg-slate-800 rounded-xl p-4">
            <h4 className="text-sm font-medium text-slate-300 mb-2">Server Location</h4>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="text-slate-200">
                {diagnostics.serverLocation.city && `${diagnostics.serverLocation.city}, `}
                {diagnostics.serverLocation.country}
              </span>
            </div>
            {diagnostics.overallStatus === 'failing' && diagnostics.errorBreakdown?.auth > 0 && (
              <p className="text-sm text-yellow-400 mt-2">
                If using a VPN, try connecting to: <strong>{diagnostics.serverLocation.city || diagnostics.serverLocation.country}</strong>
              </p>
            )}
          </div>
        )}

        {/* Suggestions */}
        {diagnostics.suggestions && diagnostics.suggestions.length > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
            <h4 className="text-sm font-medium text-yellow-400 mb-2 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Troubleshooting Suggestions
            </h4>
            <ul className="space-y-1">
              {diagnostics.suggestions.map((suggestion, idx) => (
                <li key={idx} className="text-sm text-slate-300">{suggestion}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Error Breakdown */}
        {diagnostics.failed > 0 && (
          <div className="bg-slate-800 rounded-xl p-4">
            <ErrorBreakdown breakdown={diagnostics.errorBreakdown} total={diagnostics.failed} />
          </div>
        )}

        {/* Individual Test Results */}
        <div className="bg-slate-800 rounded-xl p-4">
          <h4 className="text-sm font-medium text-slate-300 mb-3">Test Results</h4>
          <div className="space-y-2">
            {diagnostics.results.map((result, idx) => (
              <TestResultRow key={idx} result={result} />
            ))}
          </div>
        </div>

        {/* Note about sample size */}
        <p className="text-xs text-slate-500 text-center">
          Note: This test checks a random sample of {diagnostics.tested} channels.
          Results may vary as some channels are naturally offline at different times.
        </p>
      </div>
    </Modal>
  );
};

export default StreamDiagnosticsModal;
