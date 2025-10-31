import React from 'react';

const LabelValueRow = ({ label, value, onCopy }) => (
  <div className="flex flex-col gap-2 rounded-2xl border border-slate-800/70 bg-slate-900/60 p-4 shadow-inner shadow-slate-950/20">
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">{label}</span>
      <button
        type="button"
        onClick={() => onCopy(value)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy
      </button>
    </div>
    <div className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
      {value}
    </div>
  </div>
);

const ResultView = ({ result, onCopyToClipboard, onBackToPlayer }) => {
  if (!result) {
    return (
      <section className="px-6 py-12">
        <div className="mb-6 inline-flex items-center gap-3 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          XTREAM Credentials
        </div>

        <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-10 text-center shadow-2xl shadow-slate-950/40">
          <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto mb-6 h-16 w-16 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <h3 className="text-lg font-semibold text-slate-100">No results yet</h3>
          <p className="mt-2 text-sm text-slate-400">
            Match channels with EPG data and generate credentials to see results here.
          </p>
          <button
            type="button"
            onClick={onBackToPlayer}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition hover:bg-blue-500"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polygon points="10 8 16 12 10 16 10 8"></polygon>
            </svg>
            Go to Player & Matcher
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6 px-6 py-12">
      <div className="inline-flex items-center gap-3 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        New XTREAM Credentials
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LabelValueRow label="Server URL" value={result.xtreamUrl} onCopy={onCopyToClipboard} />
        <LabelValueRow label="EPG URL" value={result.xtreamEpgUrl} onCopy={onCopyToClipboard} />
        <LabelValueRow label="Username" value={result.xtreamUsername} onCopy={onCopyToClipboard} />
        <LabelValueRow label="Password" value={result.xtreamPassword} onCopy={onCopyToClipboard} />
      </div>

      {result.notes && (
        <div className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-100">
          <h4 className="mb-2 text-sm font-semibold uppercase tracking-[0.25em] text-amber-200">Notes</h4>
          <p className="text-slate-100">{result.notes}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => onCopyToClipboard(`${result.xtreamUrl}
${result.xtreamUsername}
${result.xtreamPassword}`)}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
        >
          Copy all credentials
        </button>
        <button
          type="button"
          onClick={onBackToPlayer}
          className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-100 transition hover:bg-blue-500/20"
        >
          Return to Player
        </button>
      </div>
    </section>
  );
};

export default ResultView;
