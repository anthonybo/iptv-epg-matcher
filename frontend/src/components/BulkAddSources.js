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

// Translate raw backend stage names into plain-English labels the user can
// actually read. Unknown stages fall through to the status label (Loading etc.).
const STAGE_LABELS = {
  starting: 'Connecting to server',
  init: 'Connecting to server',
  checking_cache: 'Checking cache',
  cache_check: 'Checking cache',
  loading_channels: 'Downloading channel list',
  loading_xtream: 'Downloading channel list',
  loading_stalker: 'Downloading channel list',
  parsing_channels: 'Parsing channels',
  channels_loaded: 'Channels loaded',
  loading_epg: 'Loading guide data',
  loading_epg_source: 'Loading guide data',
  processing_epg: 'Matching guide data',
  finalizing: 'Saving to database',
  persisting: 'Saving to database',
  complete: 'Done',
};

const stageLabel = (state) => {
  if (state.stage && STAGE_LABELS[state.stage]) return STAGE_LABELS[state.stage];
  if (state.stage) {
    // Pretty-print unknown snake_case/dashed stages: "loading_channels" -> "Loading channels"
    const pretty = state.stage.replace(/[_-]+/g, ' ').trim();
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }
  return statusMeta[state.status]?.label || 'Working';
};

const formatElapsed = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
};

const STALL_SOFT_MS = 10000;  // shimmer + "Still working"
const STALL_HARD_MS = 60000;  // amber notice promoting the message

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

const BulkAddSources = ({ onSourceCompleted, onAllDone, onBulkProgressChange }) => {
  const [rawText, setRawText] = useState('');
  const [defaultPortal, setDefaultPortal] = useState('');
  const [parsed, setParsed] = useState(null);
  const [phase, setPhase] = useState('edit'); // 'edit' | 'running' | 'finished'
  const [entryStates, setEntryStates] = useState([]);
  // 1Hz "now" tick so elapsed timers and stall detection re-render without
  // each row owning its own interval.
  const [now, setNow] = useState(() => Date.now());
  const eventSourcesRef = useRef([]);
  const completedNotifiedRef = useRef(false);
  const queueRef = useRef({ pending: [], active: 0 });

  useEffect(() => () => {
    eventSourcesRef.current.forEach((es) => {
      try { es.close(); } catch (_err) { /* ignore */ }
    });
    eventSourcesRef.current = [];
  }, []);

  // Pulse `now` once a second while any row is running so timers/stall cues
  // stay live. Stops on its own once everything is terminal.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

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

  // Bridge bulk-add state into the parent's background-loadings tracker so:
  //   1) the floating progress bubble at the bottom-right of the app
  //      appears while a bulk-add is in flight,
  //   2) the parent keeps the modal mounted (under the
  //      `backgroundLoadings.size > 0` condition) when the user clicks X,
  //   3) closing the modal therefore doesn't kill in-flight EventSources
  //      OR drop the queue — the loop keeps pumping the remaining queued
  //      sources because BulkAddSources stays alive.
  // Without this, closing the modal mid-bulk silently discarded the queue
  // (only the 2 in-flight sources finished; the other 34 evaporated).
  //
  // The callback is stashed in a ref so the effect's dep array only
  // contains the actual data values. Including the callback prop
  // directly caused an infinite render loop: parent passes a fresh
  // arrow on every render → effect re-fires → effect calls back into
  // parent → parent re-renders → new arrow → loop. Reading via ref
  // makes the effect insensitive to callback identity changes.
  const onBulkProgressChangeRef = useRef(onBulkProgressChange);
  useEffect(() => {
    onBulkProgressChangeRef.current = onBulkProgressChange;
  }, [onBulkProgressChange]);

  useEffect(() => {
    const cb = onBulkProgressChangeRef.current;
    if (!cb) return;
    const isActive = phase === 'running' && entryStates.length > 0;
    cb({
      isActive,
      phase,
      total: entryStates.length,
      done: doneCount,
      failed: failedCount,
      loading: activeCount,
      queued: waitingCount,
    });
  }, [phase, entryStates.length, doneCount, failedCount, activeCount, waitingCount]);

  const updateEntry = (idx, patch) => {
    setEntryStates((prev) => {
      if (!prev[idx]) return prev;
      const current = prev[idx];
      // "Meaningful" = user-visible change; bumps lastUpdatedAt so stall detection
      // resets. Heartbeat-only events (no stage/progress/message/count change)
      // don't reset the clock.
      const meaningful =
        (patch.status !== undefined && patch.status !== current.status)
        || (patch.stage !== undefined && patch.stage !== current.stage)
        || (patch.message !== undefined && patch.message !== current.message)
        || (patch.progress !== undefined && patch.progress !== current.progress)
        || (patch.channelCount !== undefined && patch.channelCount !== current.channelCount);
      const next = prev.slice();
      next[idx] = {
        ...current,
        ...patch,
        ...(meaningful ? { lastUpdatedAt: Date.now() } : {}),
      };
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
    const startedAt = Date.now();
    // Stamp startedAt via a direct state merge so stall/elapsed math has a
    // baseline even before the first SSE event lands.
    setEntryStates((prev) => {
      if (!prev[idx]) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], startedAt, lastUpdatedAt: startedAt };
      return next;
    });
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
  const [checkingExisting, setCheckingExisting] = useState(false);
  // Bumps whenever a new parse starts so a slow in-flight getUserSources call
  // from the previous click can't clobber a fresh preview when it finally returns.
  const parseTokenRef = useRef(0);

  const handleParse = () => {
    setParsing(true);
    // Phase 1: synchronous regex parse. Renders immediately — no waiting on
    // the existing-sources HTTP call (which can queue behind backend DB work
    // during a bulk load and make Parse feel stuck).
    const result = parseBulkSources(rawText, { defaultPortal });
    const token = parseTokenRef.current + 1;
    parseTokenRef.current = token;
    setParsed({
      ...result,
      entries: result.entries.map((entry) => ({
        ...entry,
        alreadyExists: false,
        existingSource: null,
        selected: true,
      })),
    });
    setParsing(false);

    // Phase 2: background existing-source check. When it lands, merge the
    // alreadyExists / existingSource flags and flip selected off for dupes —
    // unless a newer parse has started in the meantime.
    setCheckingExisting(true);
    iptvSourcesService.getUserSources()
      .then((existing) => {
        if (parseTokenRef.current !== token) return;
        setParsed((prev) => {
          if (!prev) return prev;
          const nextEntries = prev.entries.map((entry) => {
            const match = matchExisting(entry, existing);
            return {
              ...entry,
              alreadyExists: Boolean(match),
              existingSource: match || null,
              // Only flip selected off for freshly-discovered duplicates. If
              // the user manually toggled a row while we were waiting, respect
              // that — only auto-override the initial default-true state.
              selected: match ? false : entry.selected,
            };
          });
          return { ...prev, entries: nextEntries };
        });
      })
      .catch(() => {
        // Non-fatal — everything just stays marked as New.
      })
      .finally(() => {
        if (parseTokenRef.current === token) setCheckingExisting(false);
      });
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
              {checkingExisting && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="inline-flex items-center gap-1.5 text-slate-500">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Checking existing…
                  </span>
                </>
              )}
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
    const active = state.status === 'queuing' || state.status === 'loading';
    const terminal = state.status === 'done' || state.status === 'failed';
    // Live elapsed while active; frozen final duration once terminal (captured
    // via the last meaningful update, which for done/failed is the final transition).
    const elapsed = state.startedAt
      ? (terminal && state.lastUpdatedAt ? state.lastUpdatedAt - state.startedAt : now - state.startedAt)
      : 0;
    const sinceUpdate = state.lastUpdatedAt ? now - state.lastUpdatedAt : 0;
    const stalled = active && sinceUpdate >= STALL_SOFT_MS;
    const stalledHard = active && sinceUpdate >= STALL_HARD_MS;
    const stageText = state.status === 'done'
      ? 'Done'
      : state.status === 'failed'
        ? 'Failed'
        : stageLabel(state);

    const barWidth = state.status === 'done' ? 100
      : state.status === 'failed' ? 0
      : pct;

    return (
      <div
        key={idx}
        className={`rounded-lg border px-4 py-3 space-y-2 transition-colors ${
          state.status === 'done' ? 'border-emerald-500/20 bg-emerald-500/5'
          : state.status === 'failed' ? 'border-red-500/30 bg-red-500/5'
          : stalledHard ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-slate-800 bg-slate-900/40'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className={typeBadge(state.entry.type)}>
              {state.entry.type === 'xtream' ? 'Xtream' : 'Stalker'}
            </span>
            <span className="text-sm text-slate-200 truncate">{describeEntry(state.entry)}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {state.channelCount > 0 && state.status !== 'failed' && (
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {state.channelCount.toLocaleString()} ch
              </span>
            )}
            {active && typeof state.progress === 'number' && (
              <span className="text-[11px] font-mono tabular-nums text-slate-400">
                {Math.round(pct)}%
              </span>
            )}
            {(active || terminal) && state.startedAt && (
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {formatElapsed(elapsed)}
              </span>
            )}
            <span className={`text-xs font-semibold ${meta.text}`}>
              {state.status === 'done' && state.channelCount
                ? `Done · ${state.channelCount.toLocaleString()} channels`
                : stageText}
            </span>
          </div>
        </div>

        <div className="relative w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${meta.bar}`}
            style={{ width: `${barWidth}%` }}
          />
          {stalled && active && (
            <div
              className="absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse"
              aria-hidden
            />
          )}
        </div>

        {state.status === 'failed' && state.error && (
          <div className="text-xs text-red-400 break-words">{state.error}</div>
        )}
        {state.status !== 'failed' && state.message && !stalledHard && (
          <div className="text-xs text-slate-500 truncate">{state.message}</div>
        )}
        {stalledHard && (
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="truncate">
              Still working on <span className="font-semibold">{stageText.toLowerCase()}</span>
              {' · this can take a few minutes on larger providers'}
            </span>
          </div>
        )}
        {stalled && !stalledHard && state.message && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="inline-block w-1 h-1 rounded-full bg-slate-500 animate-pulse" />
            <span className="truncate">{state.message} · still working</span>
          </div>
        )}
      </div>
    );
  };

  // Wall-clock span: from the earliest row start to the latest row finish.
  // Computed once per render — entryStates re-renders on every tick while running.
  const wallClock = (() => {
    const withStart = entryStates.filter((s) => s.startedAt);
    if (withStart.length === 0) return null;
    const earliest = Math.min(...withStart.map((s) => s.startedAt));
    if (phase === 'finished') {
      const latest = Math.max(...withStart.map((s) => s.lastUpdatedAt || s.startedAt));
      return latest - earliest;
    }
    return now - earliest;
  })();

  const renderProgressPanel = () => (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">
            {phase === 'finished' ? 'All Done' : 'Loading Sources'}
            {wallClock !== null && (
              <span className="ml-2 text-sm font-mono tabular-nums text-slate-500 font-normal">
                {formatElapsed(wallClock)}
              </span>
            )}
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
