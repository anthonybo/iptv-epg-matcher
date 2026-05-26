import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * BreakingModal — drawer that surfaces real-time real-world events
 * (fires, police pursuits, weather emergencies, breaking news, big
 * sports moments) synthesized by the backend's LLM pipeline from
 * Reddit / Bluesky / sports-event signals, with channel hints already
 * resolved against the user's IPTV catalog.
 *
 * Each event shows:
 *   • Type icon + colour rail (fire = rose, chase = amber, sport = cyan,
 *     weather = sky, politics = violet, breaking = slate)
 *   • Title + summary + location
 *   • Up to 4 matched channels from the user's sources — clicking a
 *     channel chip plays it in multi-view via the parent's onPick.
 *   • Confidence pill (high / med / low) + source-link icon
 *
 * Refresh: cached 15 min server-side; the "↻" header button forces a
 * fresh synthesis (one extra LLM call). The "Why these?" affordance
 * pops the underlying Reddit thread permalinks for transparency.
 */
const BreakingModal = ({
  isOpen,
  onPick,
  onAfterPick,
  onStatusChange,
  autoFocusRef = null
}) => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({ source: null, cachedAt: null, elapsedMs: null });
  const [pickingKey, setPickingKey] = useState(null);
  const [expandedEventIdx, setExpandedEventIdx] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Per-source progress streamed from the backend SSE pipeline. Each
  // source moves through 'pending' → 'loading' → 'ok' | 'err'. The
  // 'stage' captures where the pipeline is overall.
  const [stage, setStage] = useState('idle'); // idle | sources | synthesis | matching | done
  const [sourceStatus, setSourceStatus] = useState({
    reddit: { state: 'pending', count: null, ms: null, error: null },
    gdelt:  { state: 'pending', count: null, ms: null, error: null }
  });
  // EventSource ref so we can close it on unmount / re-fetch.
  const esRef = useRef(null);

  const headerRef = useRef(null);

  useEffect(() => {
    if (autoFocusRef) autoFocusRef.current = { focus: () => headerRef.current?.focus() };
  }, [autoFocusRef]);

  const fetchEvents = useCallback(({ force = false } = {}) => {
    // Tear down any in-flight stream before starting a new one.
    if (esRef.current) {
      try { esRef.current.close(); } catch (_) {}
      esRef.current = null;
    }
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setElapsedSec(0);
    setStage('sources');
    setSourceStatus({
      reddit: { state: 'pending', count: null, ms: null, error: null },
      gdelt:  { state: 'pending', count: null, ms: null, error: null }
    });

    const t0 = Date.now();
    const tick = setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 1000);

    // EventSource doesn't accept Authorization headers — fish the JWT
    // out of storage and ride along as a query param, same way the
    // VOD stream endpoints carry auth.
    const token =
      localStorage.getItem('auth_token') ||
      sessionStorage.getItem('token') ||
      localStorage.getItem('token');
    const qs = new URLSearchParams();
    if (force) qs.set('force', '1');
    if (token) qs.set('token', token);
    const url = `/api/breaking-events/stream${qs.toString() ? `?${qs.toString()}` : ''}`;

    const es = new EventSource(url, { withCredentials: false });
    esRef.current = es;

    const finish = () => {
      clearInterval(tick);
      setLoading(false);
      setRefreshing(false);
      if (esRef.current === es) {
        try { es.close(); } catch (_) {}
        esRef.current = null;
      }
    };

    const setSrc = (source, patch) => {
      setSourceStatus((prev) => ({ ...prev, [source]: { ...prev[source], ...patch } }));
    };

    es.addEventListener('cache_hit', () => {
      setStage('done');
    });
    es.addEventListener('source_start', (ev) => {
      const d = JSON.parse(ev.data);
      setSrc(d.source, { state: 'loading' });
    });
    es.addEventListener('source_ok', (ev) => {
      const d = JSON.parse(ev.data);
      setSrc(d.source, { state: 'ok', count: d.count, ms: d.ms });
    });
    es.addEventListener('source_err', (ev) => {
      const d = JSON.parse(ev.data);
      setSrc(d.source, { state: 'err', error: d.error, ms: d.ms });
    });
    es.addEventListener('synthesis_start', () => {
      setStage('synthesis');
    });
    es.addEventListener('synthesis_ok', () => {
      // synthesis done; matching is next (very fast). Stay on synthesis
      // visually because the user doesn't need a separate stage flash.
    });
    es.addEventListener('matching_start', () => setStage('matching'));
    es.addEventListener('matching_ok', () => setStage('matching'));

    es.addEventListener('complete', (ev) => {
      const data = JSON.parse(ev.data);
      setEvents(Array.isArray(data.events) ? data.events : []);
      setMeta({
        source: data.source || null,
        cachedAt: data.cachedAt || null,
        elapsedMs: data.elapsedMs || null
      });
      setStage('done');
      finish();
    });

    es.addEventListener('error', (ev) => {
      // Two flavours: a server-emitted 'error' event with a payload,
      // OR a transport error (es.readyState === CLOSED). For the
      // transport case we'd see no `data`.
      let msg = 'Connection lost — try Refresh.';
      try {
        if (ev?.data) {
          const d = JSON.parse(ev.data);
          if (d?.error) msg = d.error;
        }
      } catch (_) {}
      setError(msg);
      finish();
    });
  }, []);

  // First load when the drawer opens.
  useEffect(() => {
    if (!isOpen) return;
    fetchEvents();
  }, [isOpen, fetchEvents]);

  // Tear down the SSE on unmount / when the drawer closes — otherwise
  // it keeps streaming in the background and holds a connection slot.
  useEffect(() => () => {
    if (esRef.current) {
      try { esRef.current.close(); } catch (_) {}
      esRef.current = null;
    }
  }, []);

  // Status reporting to the dock chip.
  useEffect(() => {
    if (!onStatusChange) return;
    if (loading)        onStatusChange({ kind: 'working', text: 'Synthesizing…' });
    else if (refreshing) onStatusChange({ kind: 'working', text: 'Refreshing…' });
    else if (error)     onStatusChange({ kind: 'error', text: 'Error' });
    else if (events.length > 0) {
      const tag = meta.source === 'llm' ? 'AI' : meta.source === 'fallback' ? 'raw' : '';
      onStatusChange({ kind: 'idle', text: `${events.length} live${tag ? ` · ${tag}` : ''}` });
    } else {
      onStatusChange({ kind: 'idle', text: 'Quiet' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, refreshing, error, events.length, meta.source]);

  const handlePickChannel = useCallback(async (event, channel) => {
    if (!onPick || !channel) return;
    const key = `${event.title}::${channel.sourceId}::${channel.id}`;
    setPickingKey(key);
    try {
      const ok = await onPick({
        // Full resolved-channel payload — addToMultiview needs `url`
        // and uses `sourceId` to look up auth from iptv_sources.
        id:         channel.id,
        sourceId:   channel.sourceId,
        name:       channel.name,
        url:        channel.url || null,
        logo:       channel.logo || null,
        sourceType: channel.sourceType || null,
        sourceName: channel.sourceName,
        // searchQuery is what find-alternative falls back to when the
        // stream dies. For breaking events the user already picked a
        // specific channel BRAND (KCBS, KTLA, ESPN…) and they want a
        // working variant of THAT channel — not a search for the event
        // title (which would never match an IPTV channel name).
        //
        // Normalize the brand hint by stripping channel-position
        // numbers — the LLM emits things like "KCAL 9" or "FOX 11 LA"
        // but the catalog usually has "US | CBS Los Angeles (KCAL)" or
        // "FOX LA" with the number embedded in the call letters
        // ("KCAL-9", "WFLA11") or omitted entirely. Token-based search
        // for "KCAL 9" misses every variant that doesn't have those
        // two tokens adjacent. Stripping the bare digit gives much
        // higher recall.
        searchQuery: stripChannelNumber(channel.matched_hint || channel.name)
      });
      if (ok && onAfterPick) onAfterPick();
    } finally {
      setPickingKey(null);
    }
  }, [onPick, onAfterPick]);

  if (!isOpen) return null;

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 pt-3 pb-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Active now
          </span>
          {meta.source && (
            <span className={`px-1.5 py-px rounded-sm font-mono text-[9px] tracking-[0.06em] ${
              meta.source === 'llm'
                ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30'
                : 'bg-slate-800/80 text-slate-500 ring-1 ring-slate-700/40'
            }`}>
              {meta.source === 'llm' ? 'AI · ' + (meta.elapsedMs ? `${meta.elapsedMs}ms` : '') : meta.source === 'fallback' ? 'RAW' : 'EMPTY'}
            </span>
          )}
        </div>
        <button
          ref={headerRef}
          type="button"
          onClick={() => fetchEvents({ force: true })}
          disabled={loading || refreshing}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-[0.14em] transition ${
            loading || refreshing
              ? 'bg-cyan-500/10 text-cyan-300 cursor-wait'
              : 'text-slate-400 hover:text-cyan-200 hover:bg-cyan-500/10'
          }`}
          title="Force a fresh LLM synthesis"
        >
          <svg className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 1 3 6.7M3 21v-6h6" />
          </svg>
          Refresh
        </button>
      </div>

      {/* ─── Body ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-3 [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
        {loading && events.length === 0 && (
          <SpinnerBlock
            label={
              stage === 'synthesis' ? 'Synthesizing with LLM…' :
              stage === 'matching'  ? 'Matching channels…' :
              'Reading the live signals…'
            }
            elapsedSec={elapsedSec}
            sourceStatus={sourceStatus}
            stage={stage}
            hint={elapsedSec > 8 && stage === 'sources'
              ? 'Reddit + GDELT can take ~25s when rate-limited. Cached 15 min after.'
              : null}
          />
        )}

        {error && (
          <div className="m-2 px-3 py-2 rounded-lg bg-rose-500/[0.06] ring-1 ring-rose-500/25 text-xs text-rose-200 font-mono">
            {error}
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <HelperBlock>
            <p className="text-slate-300">Nothing on the radar.</p>
            <p className="mt-1 text-[11px] text-slate-500">
              The synthesizer runs every 15 minutes against r/news, r/breakingnews,
              r/PublicFreakout, r/policechase, r/wildfires, r/weather and the major
              sports subs. Try Refresh to force a new pull.
            </p>
          </HelperBlock>
        )}

        {events.length > 0 && (
          <ul className="space-y-1.5">
            {events.map((event, idx) => (
              <EventRow
                key={`${idx}::${event.title}`}
                event={event}
                idx={idx}
                isExpanded={expandedEventIdx === idx}
                onToggleExpand={() => setExpandedEventIdx((curr) => (curr === idx ? null : idx))}
                onPickChannel={handlePickChannel}
                pickingKey={pickingKey}
              />
            ))}
          </ul>
        )}
      </div>

      {/* ─── Footer ───────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
        <span className="font-mono normal-case tracking-normal text-[11px] text-slate-500 truncate">
          {meta.cachedAt ? `Updated ${formatAge(meta.cachedAt)} ago` : 'Live signals · 15-min cache'}
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <kbd className="px-1 py-px rounded border border-slate-800 bg-slate-900 font-mono text-[9px] text-slate-500 normal-case tracking-normal">Esc</kbd>
          <span className="text-slate-700 normal-case tracking-normal">min</span>
        </span>
      </div>
    </div>
  );
};

/* ────────── Event Row ─────────────────────────────────────────────── */

const TYPE_THEME = {
  fire:       { rail: 'from-rose-400 to-red-500',    glyph: '🔥', ring: 'ring-rose-500/35',  label: 'FIRE' },
  chase:      { rail: 'from-amber-400 to-orange-500', glyph: '🚓', ring: 'ring-amber-500/35', label: 'CHASE' },
  weather:    { rail: 'from-sky-400 to-blue-500',     glyph: '🌪', ring: 'ring-sky-500/35',   label: 'WEATHER' },
  disaster:   { rail: 'from-rose-500 to-orange-600',  glyph: '⚠', ring: 'ring-rose-500/35',  label: 'DISASTER' },
  protest:    { rail: 'from-violet-400 to-fuchsia-500',glyph: '✊', ring: 'ring-violet-500/35',label: 'PROTEST' },
  breaking:   { rail: 'from-cyan-400 to-sky-500',     glyph: '📢', ring: 'ring-cyan-500/35',  label: 'BREAKING' },
  sport:      { rail: 'from-emerald-400 to-green-500',glyph: '🏆', ring: 'ring-emerald-500/35',label: 'SPORT' },
  politics:   { rail: 'from-indigo-400 to-violet-500',glyph: '🏛', ring: 'ring-indigo-500/35',label: 'POLITICS' },
  other:      { rail: 'from-slate-400 to-slate-500',  glyph: '•',  ring: 'ring-slate-500/35', label: 'OTHER' }
};

const EventRow = ({ event, idx, isExpanded, onToggleExpand, onPickChannel, pickingKey }) => {
  const theme = TYPE_THEME[event.type] || TYPE_THEME.other;
  const channels = event.channels || [];
  const hasChannels = channels.length > 0;
  const confTone =
    event.confidence === 'high'   ? 'text-emerald-300'
  : event.confidence === 'medium' ? 'text-amber-300'
  :                                 'text-slate-500';

  return (
    <li>
      <div className="relative flex items-stretch gap-2 rounded-lg overflow-hidden bg-slate-900/40 ring-1 ring-slate-800/60 hover:ring-slate-700/80 transition">
        {/* Left rail — type color */}
        <span className={`relative w-[3px] flex-shrink-0 self-stretch bg-gradient-to-b ${theme.rail}`} />

        {/* Body */}
        <div className="flex-1 min-w-0 py-2 pr-2">
          {/* Title row */}
          <div className="flex items-start gap-2">
            <span className="text-[14px] leading-none flex-shrink-0 mt-0.5">{theme.glyph}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[12px] font-semibold text-slate-100 leading-tight">
                  {event.title}
                </span>
                <span className={`flex-shrink-0 inline-flex items-center px-1 py-px rounded-sm font-mono text-[8.5px] tracking-[0.12em] ring-1 ${theme.ring} text-slate-200 bg-white/[0.04]`}>
                  {theme.label}
                </span>
                <span className={`flex-shrink-0 font-mono text-[8.5px] tracking-[0.12em] uppercase ${confTone}`} title={`Confidence: ${event.confidence}`}>
                  · {event.confidence}
                </span>
              </div>
              {event.location && (
                <div className="mt-0.5 text-[10px] text-slate-500 font-mono">
                  {event.location}
                </div>
              )}
              {event.summary && (
                <div className="mt-1 text-[11px] text-slate-400 leading-snug line-clamp-2">
                  {event.summary}
                </div>
              )}
            </div>
          </div>

          {/* Hint chips — every hint is clickable. If the resolver
              matched the hint to a catalog channel, clicking plays
              that exact channel (chip shows catalog name). If no match
              was found, clicking falls back to a brand-search for the
              hint (chip shows the hint name with a `?` badge). This
              ensures the user can always act on every hint, even when
              their catalog doesn't carry that brand. */}
          <div className="mt-2 flex flex-wrap gap-1">
            {(event.channel_hints || []).map((hint, hi) => {
              // Match this hint to a resolved channel if possible.
              const channel = channels.find((c) => c.matched_hint === hint);
              const key = `${event.title}::${hint}`;
              const isPicking = pickingKey === key || (channel && pickingKey === `${event.title}::${channel.sourceId}::${channel.id}`);

              const handleClick = () => {
                if (channel) {
                  onPickChannel(event, channel);
                } else {
                  // No catalog match — fall through with the hint as a
                  // brand-search query. The parent's onPick uses
                  // searchByName which handles brand lookup against any
                  // source.
                  onPickChannel(event, {
                    id: null,
                    sourceId: null,
                    name: hint,
                    sourceName: null,
                    matched_hint: hint
                  });
                }
              };

              return (
                <button
                  key={`${key}-${hi}`}
                  type="button"
                  onClick={handleClick}
                  disabled={isPicking || !!pickingKey}
                  className={`group/chip inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium ring-1 transition ${
                    isPicking
                      ? 'bg-cyan-500/15 text-cyan-200 ring-cyan-500/40 cursor-wait'
                      : pickingKey
                      ? 'opacity-40 cursor-not-allowed bg-slate-900/60 ring-slate-800 text-slate-500'
                      : channel
                      ? 'bg-cyan-500/[0.08] ring-cyan-500/30 text-cyan-100 hover:bg-cyan-500/20 hover:ring-cyan-400/50'
                      : 'bg-slate-900/60 ring-slate-700/60 text-slate-300 hover:bg-slate-800/80 hover:ring-slate-600/80 hover:text-slate-100'
                  }`}
                  title={channel
                    ? `Play ${channel.name} (matched "${hint}")`
                    : `Search "${hint}" — not in your catalog yet`}
                >
                  <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 opacity-70 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
                  </svg>
                  <span className="truncate max-w-[160px]">{channel ? channel.name : hint}</span>
                  {!channel && (
                    <span className="font-mono text-[8px] text-slate-500 leading-none ml-0.5" title="No catalog match — click to search">
                      ?
                    </span>
                  )}
                </button>
              );
            })}
            {(event.channel_hints || []).length === 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-mono text-slate-600 bg-slate-900/40 ring-1 ring-slate-800/60">
                no channel hints
              </span>
            )}
            {event.sources?.length > 0 && (
              <button
                type="button"
                onClick={onToggleExpand}
                className="ml-auto text-[9px] font-mono uppercase tracking-[0.14em] text-slate-600 hover:text-slate-300 transition px-1"
                title="Show sources"
              >
                {isExpanded ? 'less' : 'why?'}
              </button>
            )}
          </div>

          {/* Expanded: source links + full hint list */}
          {isExpanded && (
            <div className="mt-2 pt-2 border-t border-slate-800/60 space-y-1.5">
              {event.channel_hints?.length > 0 && (
                <div className="text-[10px] text-slate-500 font-mono">
                  All hints: {event.channel_hints.join(' · ')}
                </div>
              )}
              {Array.isArray(event.sources) && event.sources.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[9px] font-mono uppercase tracking-[0.14em] text-slate-600">Sources</div>
                  {event.sources.slice(0, 3).map((url, i) => (
                    <a
                      key={i}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[10.5px] text-slate-400 hover:text-cyan-200 underline-offset-2 hover:underline truncate"
                    >
                      ↗ {url.replace(/^https?:\/\//, '')}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
};

/* ────────── Subcomponents ─────────────────────────────────────────── */

const HelperBlock = ({ children }) => (
  <div className="mx-2 mt-2 px-3 py-3 rounded-lg bg-slate-900/40 ring-1 ring-slate-800/70 text-xs text-slate-400 leading-relaxed">
    {children}
  </div>
);

const SpinnerBlock = ({ label, elapsedSec = 0, hint = null, sourceStatus = null, stage = null }) => (
  <div className="px-3 py-8 flex flex-col items-center gap-3 text-slate-400">
    <div className="relative w-10 h-10">
      <div className="absolute inset-0 rounded-full border-2 border-slate-800" />
      <div className="absolute inset-0 rounded-full border-2 border-t-transparent animate-spin border-cyan-400" />
    </div>
    <div className="flex items-baseline gap-2 text-xs font-mono tracking-tight text-slate-500">
      <span>{label}</span>
      {elapsedSec > 0 && (
        <span className="text-cyan-400/80 tabular-nums">{elapsedSec}s</span>
      )}
    </div>

    {/* Per-source progress — live updates as each upstream settles.
        Once the LLM stage starts, the source rows lock to their final
        state so the user can still see "Reddit ✓ 50 / GDELT ✗ 429" while
        the LLM is doing its thing. */}
    {sourceStatus && (
      <div className="w-full max-w-xs grid grid-cols-2 gap-1.5 mt-1">
        <SourceProgressRow label="Reddit" status={sourceStatus.reddit} />
        <SourceProgressRow label="GDELT"  status={sourceStatus.gdelt}  />
      </div>
    )}
    {stage && stage !== 'sources' && (
      <div className="flex items-center gap-1.5 mt-0.5">
        <PipelineStageDot label="Sources"   active={stage === 'sources'}   done={stage !== 'sources'} />
        <PipelineConnector />
        <PipelineStageDot label="Synthesis" active={stage === 'synthesis'} done={stage === 'matching' || stage === 'done'} />
        <PipelineConnector />
        <PipelineStageDot label="Channels"  active={stage === 'matching'}  done={stage === 'done'} />
      </div>
    )}

    {hint && (
      <p className="max-w-xs text-center text-[10.5px] leading-snug text-slate-500/80 px-2">
        {hint}
      </p>
    )}
  </div>
);

const SourceProgressRow = ({ label, status }) => {
  const state = status?.state || 'pending';
  const tone =
    state === 'ok'      ? 'text-emerald-300 ring-emerald-500/30 bg-emerald-500/5' :
    state === 'err'     ? 'text-rose-300    ring-rose-500/30    bg-rose-500/5'    :
    state === 'loading' ? 'text-amber-300   ring-amber-500/30   bg-amber-500/5'   :
                          'text-slate-500   ring-slate-800/80   bg-slate-900/40';
  const trailing =
    state === 'ok'      ? <span className="font-mono tabular-nums">{status.count} <span className="text-slate-500">· {Math.round((status.ms || 0) / 100) / 10}s</span></span> :
    state === 'err'     ? <span className="font-mono truncate max-w-[80px]" title={status.error}>{shortenErr(status.error)}</span> :
    state === 'loading' ? <DotSpinner /> :
                          <span className="font-mono text-slate-600">pending</span>;
  return (
    <div className={`flex items-center justify-between gap-2 h-6 px-2 rounded-sm ring-1 ${tone}`}>
      <span className="font-mono text-[9.5px] uppercase tracking-[0.18em]">{label}</span>
      <span className="text-[10px] leading-none">{trailing}</span>
    </div>
  );
};

const PipelineStageDot = ({ label, active, done }) => (
  <span className={`inline-flex items-center gap-1 font-mono text-[8.5px] uppercase tracking-[0.16em] ${
    active ? 'text-cyan-200' : done ? 'text-emerald-300' : 'text-slate-600'
  }`}>
    <span className={`w-1 h-1 rounded-full ${
      active ? 'bg-cyan-300 animate-pulse' : done ? 'bg-emerald-400' : 'bg-slate-700'
    }`} />
    {label}
  </span>
);

const PipelineConnector = () => (
  <span aria-hidden className="w-3 h-px bg-slate-800" />
);

const DotSpinner = () => (
  <span className="inline-block w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
);

const shortenErr = (msg) => {
  if (!msg) return 'err';
  const m = String(msg).match(/\b(429|408|5\d{2})\b/);
  if (m) return m[1] === '429' ? '429 rate' : m[1];
  return String(msg).slice(0, 12);
};

/**
 * Strip a trailing channel-position number from a brand hint so the
 * downstream find-alternative search hits more variants.
 *
 *   "KCAL 9"       → "KCAL"
 *   "FOX 11 LA"    → "FOX LA"
 *   "ABC7 LA"      → "ABC LA"          (digits glued to letters too)
 *   "ESPN 2"       → "ESPN 2"          (kept — the 2 is part of the channel ID)
 *   "FOX NEWS"     → "FOX NEWS"        (no numbers, untouched)
 *
 * Heuristic: numbers immediately following CALL letters (KXXX) act as
 * a channel-position; numbers attached to *brand* names (ESPN 2, FS1,
 * CBS Sports 1) are part of the brand and must be preserved. We only
 * strip a bare number when it appears between a call-letter token
 * (KXXX or KXXXX or WXXX or WXXXX) and either end-of-string or a
 * location token.
 */
function stripChannelNumber(s) {
  if (!s) return s;
  return String(s)
    // "KCAL 9" / "KCAL-9" → "KCAL"; "KCAL 9 LA" → "KCAL LA"
    .replace(/\b([KW][A-Z]{2,4})[-\s]+\d{1,3}\b/g, '$1')
    // "FOX 11 LA" / "ABC 7 LA" → "FOX LA"
    .replace(/\b(FOX|ABC|NBC|CBS|PBS|CW|MY)\s+\d{1,3}\b/gi, '$1')
    // "ABC7" / "FOX13" (glued) → "ABC" / "FOX"
    .replace(/\b(FOX|ABC|NBC|CBS|PBS|CW|MY)\d{1,3}\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAge(ts) {
  if (!ts) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}

export default React.memo(BreakingModal);
