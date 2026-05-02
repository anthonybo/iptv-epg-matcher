import React, { useMemo, useState, useCallback } from 'react';
import useTrendingChannels from '../../hooks/useTrendingChannels';

/**
 * Trending TV Channels modal.
 *
 * Shows the live composite ranking of "what's getting attention right
 * now" worldwide — sourced from YouTube concurrent viewers, Twitch
 * restream viewer counts, Reddit comment velocity, and Bluesky firehose
 * mentions. Polls every 30s while open.
 *
 * Click a channel to add it to multi-view via the existing search-by-
 * name flow (the parent injects `onPick` which calls into
 * useStreamSearch.searchByName).
 */
const REGION_OPTIONS = [
  { id: '', label: 'All' },
  { id: 'US', label: 'US' },
  { id: 'UK', label: 'UK' },
  { id: 'AU', label: 'AU' },
  { id: 'IN', label: 'IN' },
  { id: 'MENA', label: 'MENA' },
  { id: 'CN', label: 'CN' },
  { id: 'JP', label: 'JP' },
  { id: 'DE', label: 'DE' },
  { id: 'FR', label: 'FR' },
  { id: 'BR', label: 'BR' },
  { id: 'INTL', label: 'Global' },
];

const CATEGORY_OPTIONS = [
  { id: '', label: 'All' },
  { id: 'news', label: 'News' },
  { id: 'sports', label: 'Sports' },
  { id: 'finance', label: 'Finance' },
  { id: 'entertainment', label: 'Entertainment' },
  { id: 'weather', label: 'Weather' },
];

function formatRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function SignalBadge({ name, raw }) {
  const palette = {
    youtube: 'bg-red-900/40 text-red-200 border-red-800',
    twitch: 'bg-purple-900/40 text-purple-200 border-purple-800',
    reddit: 'bg-orange-900/40 text-orange-200 border-orange-800',
    bluesky: 'bg-sky-900/40 text-sky-200 border-sky-800',
  }[name] || 'bg-slate-800 text-slate-300 border-slate-700';

  let display = '';
  if (name === 'youtube' && raw != null) {
    display = raw >= 1000 ? `${(raw / 1000).toFixed(1)}k` : `${raw}`;
  } else if (name === 'twitch' && raw != null) {
    display = raw >= 1000 ? `${(raw / 1000).toFixed(1)}k` : `${raw}`;
  } else if (name === 'reddit' && raw != null) {
    display = `${raw.toFixed(1)}/m`;
  } else if (name === 'bluesky' && raw != null) {
    display = raw.toFixed(1);
  }

  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded border ${palette}`}>
      <span>{name}</span>
      {display && <span className="opacity-80 normal-case tracking-normal">{display}</span>}
    </span>
  );
}

const TrendingModal = ({ isOpen, onClose, onPick }) => {
  const [region, setRegion] = useState('');
  const [category, setCategory] = useState('');
  // The id of the channel whose Add button has been clicked but whose
  // /search-channel pipeline hasn't finished yet. Drives the per-row
  // spinner — without it, clicking Add looks like nothing happened
  // because finding a working stream can take 10+ seconds (ffprobe on
  // candidate channels).
  const [addingId, setAddingId] = useState(null);
  const { channels, generatedAt, sourcesActive, sourcesEnabled, stale, loading, error, refresh } =
    useTrendingChannels({
      enabled: isOpen,
      region: region || null,
      category: category || null,
      limit: 50,
    });

  const handlePick = useCallback(async (channel) => {
    if (addingId) return; // ignore double-clicks while one is in flight
    setAddingId(channel.id);
    try {
      const ok = await Promise.resolve(onPick && onPick(channel));
      if (ok) onClose();
    } finally {
      setAddingId(null);
    }
  }, [addingId, onPick, onClose]);

  const sourceChips = useMemo(() => {
    const enabled = new Set(sourcesEnabled);
    const active = new Set(sourcesActive);
    return ['youtube', 'twitch', 'reddit', 'bluesky'].map((name) => ({
      name,
      enabled: enabled.has(name),
      active: active.has(name),
    }));
  }, [sourcesActive, sourcesEnabled]);

  const missingPaidSources = useMemo(() => {
    const enabled = new Set(sourcesEnabled);
    const out = [];
    if (!enabled.has('youtube')) out.push('YOUTUBE_API_KEY');
    if (!enabled.has('twitch')) out.push('TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET');
    return out;
  }, [sourcesEnabled]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
      <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-700">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-slate-100 flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                </span>
                Trending Now
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Composite live signal · YouTube concurrent + Twitch restreams + Reddit velocity + Bluesky mentions
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 transition-colors"
              aria-label="Close"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Filters */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-500 uppercase tracking-wider mr-1">Region</span>
              {REGION_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setRegion(opt.id)}
                  className={`px-2 py-1 text-[11px] font-medium rounded transition ${
                    region === opt.id
                      ? 'bg-indigo-900/60 text-indigo-200 border border-indigo-700'
                      : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="w-px h-5 bg-slate-700 mx-1" />
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-500 uppercase tracking-wider mr-1">Category</span>
              {CATEGORY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setCategory(opt.id)}
                  className={`px-2 py-1 text-[11px] font-medium rounded transition ${
                    category === opt.id
                      ? 'bg-emerald-900/60 text-emerald-200 border border-emerald-700'
                      : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Source / freshness strip */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {sourceChips.map((s) => (
              <span
                key={s.name}
                title={s.enabled ? (s.active ? 'Contributing this tick' : 'Enabled, no data this tick') : 'Disabled (missing API key)'}
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded border ${
                  s.active
                    ? 'bg-emerald-900/40 text-emerald-200 border-emerald-700'
                    : s.enabled
                      ? 'bg-slate-800 text-slate-500 border-slate-700'
                      : 'bg-slate-900 text-slate-600 border-slate-800'
                }`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.active ? 'bg-emerald-400' : s.enabled ? 'bg-slate-500' : 'bg-slate-700'}`} />
                {s.name}
              </span>
            ))}
            <span className="ml-auto text-[11px] text-slate-500">
              {loading && !generatedAt ? 'Loading…' : (
                <>
                  Updated {formatRelative(generatedAt)}
                  {stale && <span className="text-amber-400 ml-1">(stale)</span>}
                  <button
                    onClick={refresh}
                    className="ml-2 text-indigo-300 hover:text-indigo-200 underline-offset-2 hover:underline"
                  >
                    refresh
                  </button>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {missingPaidSources.length > 0 && (
            <div className="mb-3 mx-2 p-3 rounded-lg border border-amber-800/60 bg-amber-950/30">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 mt-0.5 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-xs text-amber-200/90 leading-relaxed">
                  <div className="font-semibold text-amber-100">Limited signal — only {sourcesEnabled.length} of 4 sources are enabled</div>
                  <div className="mt-1">
                    Add <code className="px-1 py-0.5 rounded bg-amber-900/60 text-amber-100 font-mono text-[11px]">{missingPaidSources.join('</code>, <code className="px-1 py-0.5 rounded bg-amber-900/60 text-amber-100 font-mono text-[11px]">')}</code> to <code className="px-1 py-0.5 rounded bg-amber-900/60 text-amber-100 font-mono text-[11px]">backend/.env</code> and restart to unlock {!sourcesEnabled.includes('youtube') && 'YouTube concurrent-viewer counts'}{!sourcesEnabled.includes('youtube') && !sourcesEnabled.includes('twitch') && ' and '}{!sourcesEnabled.includes('twitch') && 'Twitch restream viewer counts'}.
                  </div>
                  <div className="mt-1 text-amber-400/70">
                    Without them, ranking leans on Bluesky firehose mentions + Reddit comment velocity — which skew toward whatever's being talked about (often news/politics).
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="my-4 p-3 rounded-lg border border-rose-800 bg-rose-950/40 text-rose-300 text-sm">
              {error}
            </div>
          )}

          {!error && channels.length === 0 && !loading && (
            <div className="text-center py-12">
              <p className="text-slate-400">No channels currently trending in this filter</p>
              <p className="text-sm text-slate-500 mt-1">
                Try a different region/category, or wait for the next refresh
              </p>
            </div>
          )}

          {channels.length > 0 && (
            <ol className="divide-y divide-slate-800">
              {channels.map((c, i) => (
                <li
                  key={c.id}
                  className="group flex items-center gap-3 px-3 py-2.5 hover:bg-slate-800/40 rounded-lg transition"
                >
                  <span className={`flex-shrink-0 w-7 text-right font-mono text-xs ${i < 3 ? 'text-amber-300' : 'text-slate-500'}`}>
                    {i + 1}
                  </span>

                  {/* Score bar */}
                  <div className="flex-shrink-0 w-12 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-rose-500 to-amber-400"
                      style={{ width: `${Math.min(100, Math.round((c.score || 0) * 100))}%` }}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-100 truncate">{c.name}</span>
                      {c.region && (
                        <span className="text-[10px] font-mono text-slate-500 uppercase">{c.region}</span>
                      )}
                      {c.category && (
                        <span className="text-[10px] text-slate-500">· {c.category}</span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {Object.entries(c.signals || {}).map(([name, sig]) => (
                        <SignalBadge key={name} name={name} raw={sig?.raw} />
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => handlePick(c)}
                    disabled={Boolean(addingId)}
                    className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${
                      addingId === c.id
                        ? 'border-indigo-500 bg-indigo-900/60 text-indigo-100 cursor-wait'
                        : addingId
                          ? 'border-slate-700 bg-slate-800/40 text-slate-500 cursor-not-allowed'
                          : 'border-indigo-700 bg-indigo-900/30 text-indigo-200 hover:bg-indigo-900/60 opacity-90 group-hover:opacity-100'
                    }`}
                  >
                    {addingId === c.id ? (
                      <>
                        <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Finding…
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-700 bg-slate-900/60">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Ranking is a derived "live attention" proxy across public real-time signals — not Nielsen.
            Channels without an IPTV match in your sources will fall back to a search; if no working stream is found you'll get a toast.
          </p>
        </div>
      </div>
    </div>
  );
};

export default TrendingModal;
