import React, { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../utils/apiClient';
import { parseBulkSources, describeEntry } from '../utils/bulkSourceParser';
import { registerSession } from '../services/SSEService';
import iptvSourcesService from '../services/iptvSourcesService';

const inputClasses =
  'w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60';

const typeBadge = (type) => {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold';
  if (type === 'xtream') return `${base} bg-blue-500/20 text-blue-200 border border-blue-500/40`;
  return `${base} bg-purple-500/20 text-purple-200 border border-purple-500/40`;
};

const typeRailClass = (type, active) => {
  if (type === 'xtream') {
    return active
      ? 'bg-gradient-to-b from-blue-400 via-blue-500 to-blue-600'
      : 'bg-blue-500/30';
  }
  return active
    ? 'bg-gradient-to-b from-purple-400 via-purple-500 to-purple-600'
    : 'bg-purple-500/25';
};

const normalizeHost = (url) => {
  try { return new URL(url).host.toLowerCase(); } catch { return String(url || '').toLowerCase(); }
};

const normalizeMac = (mac) => String(mac || '').replace(/[:-]/g, '').toUpperCase();

const matchExisting = (entry, sources) => {
  if (!entry || !Array.isArray(sources) || sources.length === 0) return null;
  const targetHost = normalizeHost(entry.server);
  if (entry.type === 'xtream') {
    return sources.find((s) =>
      s.type === 'xtream'
      && normalizeHost(s.url) === targetHost
      && String(s.username || '') === String(entry.username || '')
    ) || null;
  }
  if (entry.type === 'stalker') {
    return sources.find((s) =>
      s.type === 'stalker'
      && normalizeHost(s.url) === targetHost
      && normalizeMac(s.mac_address) === normalizeMac(entry.mac)
    ) || null;
  }
  return null;
};

const formatExpDate = (expDate) => {
  if (!expDate || expDate === 'null') return null;
  const seconds = parseInt(expDate, 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toLocaleDateString();
};

const statusMeta = {
  pending: { label: 'Queued', bar: 'bg-slate-600', text: 'text-slate-400' },
  queuing: { label: 'Starting…', bar: 'bg-blue-500', text: 'text-blue-300' },
  loading: { label: 'Loading', bar: 'bg-blue-500', text: 'text-blue-300' },
  done: { label: 'Done', bar: 'bg-emerald-500', text: 'text-emerald-300' },
  failed: { label: 'Failed', bar: 'bg-red-500', text: 'text-red-300' },
};

// Cap how many loads run concurrently on the backend. Each load hammers the
// channel table with 500-row INSERT batches; running too many at once hits
// Postgres `statement_timeout` and starves unrelated queries (/api/epg/init etc.).
const MAX_CONCURRENT = 2;

const createSession = async () => {
  const res = await apiClient.post('/session/create');
  const sessionId = res?.data?.sessionId;
  if (!sessionId) throw new Error('Failed to create session');
  return sessionId;
};

const submitEntry = async (entry) => {
  const sessionId = await createSession();
  try {
    await registerSession(sessionId);
  } catch (_err) {
    // Non-fatal — SSE registration isn't required for the backend to process.
  }

  const formData = new FormData();
  formData.append('sessionId', sessionId);
  if (entry.type === 'xtream') {
    formData.append('xtreamServer', entry.server);
    formData.append('xtreamUsername', entry.username);
    formData.append('xtreamPassword', entry.password);
  } else {
    formData.append('portalUrl', entry.server);
    formData.append('macAddress', entry.mac);
  }

  const response = await apiClient.post('/load', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  if (!response?.data?.success) {
    throw new Error(response?.data?.error || 'Load request was rejected');
  }
  return sessionId;
};

const BulkAddSources = ({ onSourceCompleted, onAllDone }) => {
  const [rawText, setRawText] = useState('');
  const [defaultPortal, setDefaultPortal] = useState('');
  const [parsed, setParsed] = useState(null);
  const [phase, setPhase] = useState('edit'); // 'edit' | 'running' | 'finished'
  const [entryStates, setEntryStates] = useState([]);
  const eventSourcesRef = useRef([]);
  const completedNotifiedRef = useRef(false);
  const queueRef = useRef({ pending: [], active: 0 });

  useEffect(() => () => {
    eventSourcesRef.current.forEach((es) => {
      try { es.close(); } catch (_err) { /* ignore */ }
    });
    eventSourcesRef.current = [];
  }, []);

  const hasPreview = parsed && (parsed.entries.length > 0 || parsed.errors.length > 0);
  const preview = useMemo(() => parsed?.entries || [], [parsed]);

  const doneCount = entryStates.filter((s) => s.status === 'done').length;
  const failedCount = entryStates.filter((s) => s.status === 'failed').length;
  const activeCount = entryStates.filter((s) => s.status === 'queuing' || s.status === 'loading').length;
  const waitingCount = entryStates.filter((s) => s.status === 'pending').length;
  const allTerminal = phase === 'running' && entryStates.length > 0 && activeCount === 0 && waitingCount === 0;

  useEffect(() => {
    if (allTerminal && !completedNotifiedRef.current) {
      completedNotifiedRef.current = true;
      setPhase('finished');
      if (onAllDone) onAllDone({ done: doneCount, failed: failedCount, total: entryStates.length });
    }
  }, [allTerminal, doneCount, failedCount, entryStates.length, onAllDone]);

  const updateEntry = (idx, patch) => {
    setEntryStates((prev) => {
      if (!prev[idx]) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const finalizeEntry = (idx, es, patch) => {
    try { es.close(); } catch (_err) { /* ignore */ }
    eventSourcesRef.current = eventSourcesRef.current.filter((x) => x !== es);
    updateEntry(idx, patch);
    if (patch.status === 'done' && patch.sessionId && onSourceCompleted) {
      try { onSourceCompleted(patch.sessionId); } catch (_err) { /* ignore */ }
    }
    releaseSlot();
  };

  const releaseSlot = () => {
    queueRef.current.active = Math.max(0, queueRef.current.active - 1);
    pumpQueue();
  };

  const pumpQueue = () => {
    while (
      queueRef.current.active < MAX_CONCURRENT
      && queueRef.current.pending.length > 0
    ) {
      const next = queueRef.current.pending.shift();
      queueRef.current.active += 1;
      // Fire-and-forget; startEntry handles its own error path and calls releaseSlot.
      startEntry(next.idx, next.entry);
    }
  };

  const startEntry = async (idx, entry) => {
    updateEntry(idx, { status: 'queuing', message: 'Creating session…' });
    try {
      const sessionId = await submitEntry(entry);
      updateEntry(idx, { status: 'loading', sessionId, message: 'Load started', progress: 1 });
      subscribeProgress(idx, sessionId);
    } catch (err) {
      updateEntry(idx, {
        status: 'failed',
        error: err?.response?.data?.error || err?.message || 'Unknown error',
      });
      releaseSlot();
    }
  };

  const subscribeProgress = (idx, sessionId) => {
    let es;
    try {
      es = new EventSource(`/api/stream-updates/${sessionId}`);
    } catch (_err) {
      updateEntry(idx, { status: 'failed', error: 'EventSource unsupported' });
      return;
    }
    eventSourcesRef.current.push(es);

    const safeParse = (raw) => {
      try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
    };

    // Backend emits events through a mix of code paths:
    //   - detailedProgressService.js emits `percentage` (not `progress`)
    //   - some paths write `event: <type>\n` (named); the legacy sendSSEUpdate
    //     in sseUtils.js writes ONLY `data: ...\n\n` (unnamed)
    // Unnamed frames only fire onmessage, so we can't rely on addEventListener
    // for `complete`/`error` — onmessage has to be the canonical router.
    const getProgressNumber = (data) => {
      if (typeof data?.progress === 'number') return data.progress;
      if (typeof data?.percentage === 'number') return data.percentage;
      return null;
    };

    const applyProgress = (data) => {
      const patch = {};
      const n = getProgressNumber(data);
      if (n !== null) patch.progress = Math.max(0, n);
      if (typeof data.stage === 'string') patch.stage = data.stage;
      if (typeof data.message === 'string') patch.message = data.message;
      const nextChannelCount = data.channelCount ?? data.totalChannels;
      if (typeof nextChannelCount === 'number' && nextChannelCount > 0) patch.channelCount = nextChannelCount;
      if (Object.keys(patch).length > 0) updateEntry(idx, patch);
    };

    const handleComplete = (data) => {
      const n = getProgressNumber(data);
      finalizeEntry(idx, es, {
        status: 'done',
        progress: n !== null ? Math.max(n, 100) : 100,
        stage: 'complete',
        message: data.message || 'Complete',
        channelCount: data.channelCount || data.totalChannels,
        sessionId,
      });
    };

    const handleErrorEvent = (data) => {
      finalizeEntry(idx, es, {
        status: 'failed',
        error: data.message || data.error || 'Load failed',
        sessionId,
      });
    };

    const handleChannelsAvailable = (data) => {
      const channels = data.channelCount || data.totalChannels;
      updateEntry(idx, {
        stage: 'channels_loaded',
        ...(typeof channels === 'number' && channels > 0 ? { channelCount: channels } : {}),
        progress: Math.max(getProgressNumber(data) ?? 30, 30),
        message: channels ? `${channels.toLocaleString()} channels loaded` : 'Channels loaded',
      });
    };

    const routeByType = (data) => {
      const type = data?.type;
      if (type === 'complete') { handleComplete(data); return; }
      if (type === 'error') { handleErrorEvent(data); return; }
      if (type === 'channels_available' || type === 'channels-available') { handleChannelsAvailable(data); return; }
      // Fall through: everything else (progress, heartbeat, message, stage-only frames)
      // gets applied as a progress update if it carries any useful fields.
      applyProgress(data);
    };

    // onmessage catches unnamed SSE frames (the legacy broadcast path).
    es.onmessage = (e) => routeByType(safeParse(e.data));
    // Named listeners catch the direct-write paths that DO set event: <type>.
    es.addEventListener('progress', (e) => applyProgress(safeParse(e.data)));
    es.addEventListener('channels_available', (e) => handleChannelsAvailable(safeParse(e.data)));
    es.addEventListener('channels-available', (e) => handleChannelsAvailable(safeParse(e.data)));
    es.addEventListener('complete', (e) => handleComplete(safeParse(e.data)));
    es.addEventListener('error', (e) => handleErrorEvent(safeParse(e.data)));
    // Connection-level errors (e.g. transient network) don't mark the entry failed —
    // backend may still be processing and a reconnect will pick up the next event.
  };

  const [parsing, setParsing] = useState(false);

  const handleParse = async () => {
    setParsing(true);
    try {
      const result = parseBulkSources(rawText, { defaultPortal });
      let existing = [];
      try {
        existing = await iptvSourcesService.getUserSources();
      } catch (_err) {
        // Fall back to treating everything as new if we can't read current sources.
      }
      const enriched = result.entries.map((entry) => {
        const match = matchExisting(entry, existing);
        return {
          ...entry,
          alreadyExists: Boolean(match),
          existingSource: match || null,
          selected: !match,
        };
      });
      setParsed({ ...result, entries: enriched });
    } finally {
      setParsing(false);
    }
  };

  const setAllSelection = (mode) => {
    setParsed((prev) => {
      if (!prev) return prev;
      const nextEntries = prev.entries.map((entry) => {
        if (mode === 'all') return { ...entry, selected: true };
        if (mode === 'none') return { ...entry, selected: false };
        // 'new' — select only entries that don't already exist.
        return { ...entry, selected: !entry.alreadyExists };
      });
      return { ...prev, entries: nextEntries };
    });
  };

  const toggleEntry = (index) => {
    setParsed((prev) => {
      if (!prev) return prev;
      const nextEntries = prev.entries.map((entry, i) => (
        i === index ? { ...entry, selected: !entry.selected } : entry
      ));
      return { ...prev, entries: nextEntries };
    });
  };

  const handleReparse = () => {
    eventSourcesRef.current.forEach((es) => {
      try { es.close(); } catch (_err) { /* ignore */ }
    });
    eventSourcesRef.current = [];
    queueRef.current = { pending: [], active: 0 };
    completedNotifiedRef.current = false;
    setParsed(null);
    setEntryStates([]);
    setPhase('edit');
  };

  const handleRemove = (index) => {
    setParsed((prev) => {
      if (!prev) return prev;
      return { ...prev, entries: prev.entries.filter((_, i) => i !== index) };
    });
  };

  const handleSubmit = () => {
    const selected = preview.filter((entry) => entry.selected);
    if (!selected.length) return;
    completedNotifiedRef.current = false;
    const initial = selected.map((entry) => ({
      entry,
      status: 'pending',
      progress: 0,
      stage: null,
      message: selected.length > MAX_CONCURRENT ? 'Waiting for open slot…' : '',
      channelCount: 0,
      error: null,
      sessionId: null,
    }));
    setEntryStates(initial);
    setPhase('running');

    queueRef.current = {
      pending: selected.map((entry, idx) => ({ idx, entry })),
      active: 0,
    };
    pumpQueue();
  };

  const renderEditPanel = () => (
    <section className="space-y-4">
      <h3 className="text-lg font-semibold text-slate-100">Bulk Add Sources</h3>
      <p className="text-sm text-slate-400">
        Paste any mix of Xtream accounts, MAG/Stalker portals, or bulk MAC lists. Each line is auto-detected.
      </p>
      <ul className="list-disc pl-5 text-xs text-slate-400 space-y-1">
        <li><code className="text-slate-300">http://host:port/get.php?username=X&amp;password=Y&amp;type=m3u_plus</code></li>
        <li>
          A server URL followed by labeled creds, one per line:
          <code className="block text-slate-300 mt-1">
            Portal: http://host:8080<br />
            Username: alice | Password: hunter2<br />
            Username: bob | Password: sw0rdf1sh
          </code>
        </li>
        <li>
          Column-style list — server, user:pass, then any trailing metadata:
          <code className="block text-slate-300 mt-1">
            canal-pro.xyz:8080    alice:hunter2    0/3    Active<br />
            canal-pro.xyz:8080    bob:sw0rdf1sh    1/3    Active
          </code>
        </li>
        <li>Stalker block with <code className="text-slate-300">Real/Portal/Mac ➤</code> lines</li>
        <li><code className="text-slate-300">[MAC] ✔ 00:1A:79:XX:XX:XX</code> (uses default portal below)</li>
      </ul>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-slate-200">Default Portal URL (optional)</span>
        <input
          type="text"
          placeholder="http://z1mac.com:8080/c/"
          value={defaultPortal}
          onChange={(e) => setDefaultPortal(e.target.value)}
          className={inputClasses}
        />
        <span className="text-xs text-slate-500">
          Used for MACs that appear without a portal URL (e.g. <code>[MAC] ✔ ...</code> lines).
        </span>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-slate-200">Sources</span>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={12}
          placeholder={'http://server1/get.php?username=u1&password=p1&type=m3u_plus\nhttp://server1/get.php?username=u2&password=p2&type=m3u_plus\n\nPortal ➤ http://portal/c/\nMac ➤ 00:1A:79:AA:BB:CC\n\n[MAC] ✔ 00:1A:79:11:22:33'}
          className={`${inputClasses} font-mono`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleParse}
          disabled={parsing || !rawText.trim()}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {parsing ? 'Parsing…' : 'Parse'}
        </button>
        {hasPreview && (
          <button
            type="button"
            onClick={handleReparse}
            className="text-sm text-slate-400 hover:text-slate-200 underline"
          >
            Clear preview
          </button>
        )}
      </div>
    </section>
  );

  const renderPreviewRow = (entry, i) => {
    const { alreadyExists, selected, existingSource, type } = entry;
    const expDate = alreadyExists ? formatExpDate(existingSource?.exp_date) : null;
    const channelCount = alreadyExists ? (existingSource?.channel_count || 0) : 0;

    return (
      <div
        key={`${type}-${i}`}
        role="button"
        tabIndex={0}
        onClick={() => toggleEntry(i)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggleEntry(i);
          }
        }}
        className={`relative flex items-stretch gap-0 rounded-lg border transition-colors duration-150 cursor-pointer select-none overflow-hidden group ${
          selected
            ? 'border-slate-700 bg-slate-900/60 hover:border-slate-600'
            : alreadyExists
              ? 'border-slate-800/70 bg-slate-900/30 opacity-70 hover:opacity-90 hover:border-amber-500/30'
              : 'border-slate-800/70 bg-slate-900/30 opacity-60 hover:opacity-90 hover:border-slate-700'
        }`}
      >
        <span className={`w-1 shrink-0 transition-colors duration-150 ${typeRailClass(type, selected)}`} />

        <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3">
          <span
            aria-hidden
            className={`shrink-0 flex items-center justify-center w-5 h-5 rounded-md border transition-all duration-150 ${
              selected
                ? 'bg-blue-500 border-blue-400 shadow-[0_0_0_3px_rgba(59,130,246,0.15)]'
                : 'bg-slate-900 border-slate-600 group-hover:border-slate-400'
            }`}
          >
            {selected && (
              <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 10.5l3.5 3.5L15 7" />
              </svg>
            )}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`text-xs font-semibold tracking-[0.12em] uppercase ${
                type === 'xtream' ? 'text-blue-300/80' : 'text-purple-300/80'
              }`}>
                {type === 'xtream' ? 'Xtream' : 'Stalker'}
              </span>
              <span className="text-slate-100 text-sm font-semibold truncate">
                {type === 'xtream' ? entry.username : entry.mac}
              </span>
            </div>
            <div className="text-xs text-slate-400 truncate font-mono">{entry.server}</div>
          </div>

          <div className="shrink-0 flex flex-col items-end gap-0.5 text-right">
            {alreadyExists ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase text-amber-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  Already added
                </span>
                <span className="text-[11px] text-slate-500">
                  {channelCount.toLocaleString()} ch
                  {expDate ? ` · exp ${expDate}` : ''}
                </span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase text-emerald-300/90">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                New
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleRemove(i);
            }}
            className="shrink-0 -mr-1 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800/80 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Remove from list"
            aria-label="Remove from list"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  const renderPreview = () => {
    const total = preview.length;
    const existingCount = preview.filter((e) => e.alreadyExists).length;
    const newCount = total - existingCount;
    const selectedCount = preview.filter((e) => e.selected).length;
    const canSubmit = selectedCount > 0;

    const filterButton = (mode, label) => {
      const isActive =
        (mode === 'all' && selectedCount === total && total > 0)
        || (mode === 'none' && selectedCount === 0)
        || (mode === 'new' && selectedCount === newCount && preview.every((e) => e.selected === !e.alreadyExists));
      return (
        <button
          type="button"
          onClick={() => setAllSelection(mode)}
          className={`px-3 py-1.5 text-xs font-semibold tracking-wide transition-colors ${
            isActive
              ? 'bg-slate-800 text-slate-100 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.25)]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {label}
        </button>
      );
    };

    return (
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h4 className="text-base font-semibold text-slate-100">Preview</h4>
            <div className="mt-1 flex items-center gap-3 text-xs tracking-wide">
              <span className="text-emerald-300/90">
                <span className="font-semibold text-emerald-200">{newCount}</span> new
              </span>
              {existingCount > 0 && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-amber-300/90">
                    <span className="font-semibold text-amber-200">{existingCount}</span> already added
                  </span>
                </>
              )}
              <span className="text-slate-700">·</span>
              <span className="text-slate-500">
                <span className="font-semibold text-slate-300">{total}</span> total
              </span>
            </div>
          </div>

          <div className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900/60 overflow-hidden divide-x divide-slate-800">
            {filterButton('new', 'Only new')}
            {filterButton('all', 'All')}
            {filterButton('none', 'None')}
          </div>
        </div>

        {existingCount > 0 && (
          <p className="text-xs text-slate-500 leading-relaxed">
            Already-added accounts are unchecked by default. Re-checking one will re-download its channels and refresh account info.
          </p>
        )}

        {parsed?.errors?.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100 space-y-1">
            {parsed.errors.map((err, i) => (
              <div key={i}>
                <span className="font-semibold">Line {err.line}:</span> {err.reason}
                <div className="text-amber-300/80 truncate">{err.text}</div>
              </div>
            ))}
          </div>
        )}

        {total > 0 && (
          <div className="space-y-1.5">
            {preview.map(renderPreviewRow)}
          </div>
        )}

        {total > 0 && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="text-xs text-slate-500">
              {canSubmit
                ? `${selectedCount} of ${total} selected`
                : 'Nothing selected — check at least one source to continue'}
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/40 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:brightness-90"
            >
              {canSubmit
                ? `Add ${selectedCount} Source${selectedCount === 1 ? '' : 's'}`
                : 'Add Sources'}
            </button>
          </div>
        )}
      </section>
    );
  };

  const renderProgressRow = (state, idx) => {
    const meta = statusMeta[state.status] || statusMeta.pending;
    const pct = typeof state.progress === 'number' ? Math.min(100, Math.max(0, state.progress)) : 0;
    return (
      <div key={idx} className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className={typeBadge(state.entry.type)}>
              {state.entry.type === 'xtream' ? 'Xtream' : 'Stalker'}
            </span>
            <span className="text-sm text-slate-200 truncate">{describeEntry(state.entry)}</span>
          </div>
          <span className={`text-xs font-semibold ${meta.text}`}>
            {state.status === 'done'
              ? `Done · ${state.channelCount ? state.channelCount.toLocaleString() + ' channels' : 'OK'}`
              : state.status === 'failed'
                ? 'Failed'
                : state.stage || meta.label}
          </span>
        </div>
        <div className="relative w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${meta.bar}`}
            style={{ width: `${state.status === 'done' ? 100 : state.status === 'failed' ? 0 : pct}%` }}
          />
        </div>
        {state.status === 'failed' && state.error && (
          <div className="text-xs text-red-400 break-words">{state.error}</div>
        )}
        {state.status !== 'failed' && state.message && (
          <div className="text-xs text-slate-500 truncate">{state.message}</div>
        )}
      </div>
    );
  };

  const renderProgressPanel = () => (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">
            {phase === 'finished' ? 'All Done' : 'Loading Sources'}
          </h3>
          {phase === 'running' && (
            <p className="text-xs text-slate-500 mt-0.5">
              Running up to {MAX_CONCURRENT} at a time to avoid overloading the server.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-300">{doneCount} done</span>
          {failedCount > 0 && <span className="text-red-300">{failedCount} failed</span>}
          {activeCount > 0 && <span className="text-blue-300">{activeCount} loading</span>}
          {waitingCount > 0 && <span className="text-slate-400">{waitingCount} queued</span>}
          <span className="text-slate-500">/ {entryStates.length} total</span>
        </div>
      </div>

      <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
        {entryStates.map(renderProgressRow)}
      </div>

      {phase === 'finished' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleReparse}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700"
          >
            Add more
          </button>
        </div>
      )}
    </section>
  );

  return (
    <div className="mt-8 space-y-8">
      {phase === 'edit' && renderEditPanel()}
      {phase === 'edit' && hasPreview && renderPreview()}
      {(phase === 'running' || phase === 'finished') && renderProgressPanel()}
    </div>
  );
};

export default BulkAddSources;
