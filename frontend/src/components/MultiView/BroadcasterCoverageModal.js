import React, { useEffect, useMemo, useState, useCallback } from 'react';

/**
 * Broadcaster coverage debug/inspection modal.
 *
 * Shows every broadcaster code ESPN has emitted across the live_events
 * table (the universe of "what we get") cross-referenced with the
 * static alias table (`broadcasterAliases.js`) and the runtime stats
 * table (`broadcaster_match_stats`). Sorted so the most actionable
 * gaps surface first:
 *
 *   1. Codes with NO alias mapping (verbatim passthrough — likely
 *      false positives)
 *   2. Codes that always fail when searched
 *   3. Codes that sometimes fail
 *   4. Codes that always succeed (informational)
 *   5. Codes never searched yet
 *
 * Lets the user understand at a glance: are we missing aliases? Are
 * the aliases we have actually finding channels? Or are we just out
 * of luck on certain broadcasters because the user's IPTV catalog
 * doesn't carry them?
 */

function getToken() {
  return (
    localStorage.getItem('auth_token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('token')
  );
}

function statusKindOf(row) {
  if (!row.is_aliased) return 'unaliased';
  if (row.search_count === 0) return 'untested';
  if (row.fail_count === row.search_count) return 'always-fails';
  if (row.fail_count > 0) return 'sometimes-fails';
  return 'works';
}

const STATUS_PALETTE = {
  unaliased:        'bg-rose-900/40    text-rose-200    border-rose-700',
  'always-fails':   'bg-rose-900/40    text-rose-200    border-rose-700',
  'sometimes-fails':'bg-amber-900/40   text-amber-200   border-amber-700',
  untested:         'bg-slate-800      text-slate-400   border-slate-700',
  works:            'bg-emerald-900/40 text-emerald-200 border-emerald-700'
};

const STATUS_LABEL = {
  unaliased:        'No alias',
  'always-fails':   'Always fails',
  'sometimes-fails':'Sometimes fails',
  untested:         'Untested',
  works:            'Works'
};

function fmtPct(n) {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return '—';
  }
}

const BroadcasterCoverageModal = ({ isOpen, onTestCode, onStatusChange }) => {
  const [data, setData] = useState({ rows: [], summary: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [textFilter, setTextFilter] = useState('');
  // Whichever broadcaster_code is being tested right now (drives the
  // per-row spinner / cancel button) plus the AbortController bound
  // to that fetch — clicking Cancel calls .abort() which propagates
  // through to the backend search-channel route via the request's
  // 'close' event (see clientGone in searchChannel.js).
  // Only one test in flight at a time.
  const [testing, setTesting] = useState(null); // { code, controller } | null

  // Two callers:
  //   - Row's Test button: passes (broadcaster_code, row.aliases) so
  //     the search expands to the entire family and one click finds
  //     any channel from the broadcaster's variants.
  //   - Alias chip: passes (alias) only — strict literal-substring
  //     test for that specific alias.
  const handleTest = useCallback(async (code, aliases) => {
    if (!onTestCode || testing) return;
    const controller = new AbortController();
    setTesting({ code, controller });
    try {
      await Promise.resolve(onTestCode(code, controller.signal, aliases));
    } finally {
      setTesting(null);
    }
  }, [onTestCode, testing]);

  const handleCancelTest = useCallback(() => {
    if (testing?.controller) {
      console.log(`[BroadcasterCoverage] Cancel clicked for "${testing.code}"`);
      testing.controller.abort();
    } else {
      console.warn('[BroadcasterCoverage] Cancel clicked but no controller in flight');
    }
  }, [testing]);

  const fetchData = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setError('Authentication required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/live-events/broadcaster-coverage', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await resp.json();
      if (!resp.ok || !json.success) throw new Error(json?.error || `HTTP ${resp.status}`);
      setData({ rows: json.rows || [], summary: json.summary || null });
    } catch (err) {
      console.error('[BroadcasterCoverage] fetch failed', err);
      setError(err.message || 'Failed to load coverage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) fetchData();
  }, [isOpen, fetchData]);

  const counts = useMemo(() => {
    const out = { all: data.rows.length, unaliased: 0, 'always-fails': 0, 'sometimes-fails': 0, untested: 0, works: 0 };
    for (const r of data.rows) out[statusKindOf(r)] += 1;
    return out;
  }, [data.rows]);

  const filtered = useMemo(() => {
    const q = textFilter.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (statusFilter !== 'all' && statusKindOf(r) !== statusFilter) return false;
      if (q) {
        const haystack = `${r.broadcaster_code} ${r.sport_type || ''} ${r.league_name || ''} ${(r.aliases || []).join(' ')}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [data.rows, statusFilter, textFilter]);

  // Report live status to the dock chip. Don't depend on
  // `onStatusChange` — its identity churns every render and would
  // loop with the resulting setStatus side-effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onStatusChange) return;
    if (loading) onStatusChange({ kind: 'working', text: 'Loading…' });
    else if (error) onStatusChange({ kind: 'error', text: 'Error' });
    else {
      const unaliased = data.summary?.unaliased_codes || 0;
      if (unaliased > 0) onStatusChange({ kind: 'warn', text: `${unaliased} unaliased` });
      else onStatusChange({ kind: 'idle', text: `${data.rows.length} codes` });
    }
  }, [loading, error, data]);

  if (!isOpen) return null;

  const s = data.summary;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
        {/* Sub-header: summary + filters */}
        <div className="flex-shrink-0 px-4 py-3 border-b border-slate-800/60 space-y-3">
          <p className="text-[10.5px] text-slate-500 leading-snug">
            Every broadcaster code ESPN has emitted, cross-checked against our alias table + runtime match stats.
            Sorted by &ldquo;most actionable to fix&rdquo; first.
          </p>

          {s && (
            <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
              <Stat label="Total codes" value={s.total_codes} />
              <Stat label="Aliased" value={s.aliased_codes} tone="emerald" />
              <Stat label="Unaliased" value={s.unaliased_codes} tone={s.unaliased_codes > 0 ? 'rose' : 'slate'} />
              <Stat label="Searched" value={s.searched} />
              <Stat label="Ever failed" value={s.ever_failed} tone={s.ever_failed > 0 ? 'amber' : 'slate'} />
              <Stat label="Always failed" value={s.always_failed} tone={s.always_failed > 0 ? 'rose' : 'slate'} />
              <Stat label="Catalog entries" value={s.catalog_size} />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {[
              { id: 'all',              label: `All (${counts.all})` },
              { id: 'unaliased',        label: `Unaliased (${counts.unaliased})` },
              { id: 'always-fails',     label: `Always fails (${counts['always-fails']})` },
              { id: 'sometimes-fails',  label: `Sometimes fails (${counts['sometimes-fails']})` },
              { id: 'untested',         label: `Untested (${counts.untested})` },
              { id: 'works',            label: `Works (${counts.works})` }
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setStatusFilter(opt.id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition ${
                  statusFilter === opt.id
                    ? 'bg-indigo-900/60 text-indigo-200 border border-indigo-700'
                    : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
            <input
              type="text"
              placeholder="Filter by code, sport, or alias…"
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              className="ml-2 px-2 py-1 text-[11px] rounded bg-slate-800 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-600 w-56"
            />
            <span className="ml-auto">
              <button
                onClick={fetchData}
                disabled={loading}
                className="text-[11px] text-indigo-300 hover:text-indigo-200 hover:underline disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 p-3 rounded-lg border border-rose-800 bg-rose-950/40 text-rose-300 text-sm">
              {error}
            </div>
          )}

          {!error && !loading && filtered.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              {data.rows.length === 0 ? 'No broadcaster data yet — fetch some live events first.' : 'No rows match the current filter.'}
            </div>
          )}

          {filtered.length > 0 && (
            <table className="w-full text-xs">
              <thead className="bg-slate-900 sticky top-0 z-10">
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Sport / League</th>
                  <th className="px-3 py-2">Aliases</th>
                  <th className="px-3 py-2 text-right">Events</th>
                  <th className="px-3 py-2 text-right">Searches</th>
                  <th className="px-3 py-2 text-right">Match-via-this</th>
                  <th className="px-3 py-2 text-right">Fails</th>
                  <th className="px-3 py-2 text-right">Fail %</th>
                  <th className="px-3 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.map((r, i) => {
                  const kind = statusKindOf(r);
                  return (
                    <tr key={`${r.broadcaster_code}|${r.sport_type}|${r.league_name}|${i}`} className="hover:bg-slate-800/40">
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border ${STATUS_PALETTE[kind]}`}>
                          {STATUS_LABEL[kind]}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-100">{r.broadcaster_code}</td>
                      <td className="px-3 py-2 text-slate-400">
                        {r.sport_type || '—'}
                        {r.league_name ? <span className="text-slate-600"> · {r.league_name}</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        {r.is_aliased ? (
                          <div className="flex flex-wrap gap-1">
                            {(r.aliases || []).map((a, j) => {
                              // Each alias is itself a brand-search
                              // target — clicking it runs the same
                              // pipeline as the row's Test button but
                              // for that specific alias substring.
                              // Useful when a broadcaster expands to
                              // several aliases (e.g. ESPN+ → ESPN+,
                              // ESPNPLUS, ESPN PLUS) and you want to
                              // verify which form actually exists in
                              // your IPTV catalog.
                              const isThisLoading = testing?.code === a;
                              const isOtherLoading = Boolean(testing) && !isThisLoading;
                              if (isThisLoading) {
                                return (
                                  <span
                                    key={j}
                                    className="inline-flex items-center font-mono text-[10px] rounded border border-indigo-500 bg-indigo-900/60 text-indigo-100 overflow-hidden"
                                  >
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5">
                                      <svg className="animate-spin w-2.5 h-2.5" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                                      </svg>
                                      {a}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={(ev) => { ev.stopPropagation(); handleCancelTest(); }}
                                      title="Cancel this search"
                                      className="px-1.5 py-0.5 border-l border-indigo-500/60 bg-rose-900/40 text-rose-200 hover:bg-rose-900/70 transition"
                                    >
                                      ✕
                                    </button>
                                  </span>
                                );
                              }
                              return (
                                <button
                                  key={j}
                                  type="button"
                                  onClick={(ev) => { ev.stopPropagation(); handleTest(a); }}
                                  disabled={isOtherLoading}
                                  title={`Search the IPTV catalog for "${a}" specifically (this exact alias)`}
                                  className={`font-mono text-[10px] px-1.5 py-0.5 rounded border transition ${
                                    isOtherLoading
                                      ? 'border-slate-700 bg-slate-800/40 text-slate-600 cursor-not-allowed'
                                      : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-indigo-600 hover:bg-indigo-900/30 hover:text-indigo-200'
                                  }`}
                                >
                                  {a}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-rose-300 italic">verbatim (no mapping)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">{r.event_count}</td>
                      <td className="px-3 py-2 text-right text-slate-300">{r.search_count}</td>
                      <td className="px-3 py-2 text-right text-slate-300">{r.match_via_this_count}</td>
                      <td className="px-3 py-2 text-right text-slate-300">{r.fail_count}</td>
                      <td className="px-3 py-2 text-right">
                        {r.fail_rate == null ? (
                          <span className="text-slate-600">—</span>
                        ) : (
                          <span className={r.fail_rate > 0.5 ? 'text-rose-300 font-semibold' : r.fail_rate > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                            {fmtPct(r.fail_rate)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* Per-row Test button: runs the search-channel
                            pipeline against the broadcaster code as
                            a brand-style query. Returns a working
                            channel if the alias resolves to one in the
                            user's IPTV catalog — exercises the same
                            code path a ticker click on a game with
                            this broadcaster would take, without
                            needing a live event. While in flight the
                            button toggles to Cancel so the user can
                            abort a slow ffprobe loop. */}
                        {testing?.code === r.broadcaster_code ? (
                          <button
                            onClick={handleCancelTest}
                            title="Cancel this search"
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded border border-rose-700 bg-rose-900/40 text-rose-200 hover:bg-rose-900/60 transition"
                          >
                            <svg className="animate-spin w-3 h-3 mr-0.5" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                            </svg>
                            Cancel
                          </button>
                        ) : (
                          <button
                            // Pass the full alias list so the backend
                            // OR's every variant into the SQL filter.
                            // Clicking Test on a row whose canonical
                            // code (e.g. "MLB.TV") doesn't appear in
                            // the catalog still finds the family
                            // ("MLB Network") via the alias list.
                            onClick={() => handleTest(r.broadcaster_code, r.aliases)}
                            disabled={Boolean(testing)}
                            title={`Search the IPTV catalog for any of: ${(r.aliases || []).join(', ')} — adds the first working channel to multi-view`}
                            className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded border transition ${
                              testing
                                ? 'border-slate-700 bg-slate-800/40 text-slate-500 cursor-not-allowed'
                                : 'border-indigo-700 bg-indigo-900/30 text-indigo-200 hover:bg-indigo-900/60'
                            }`}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Test
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-4 py-2.5 border-t border-slate-800/60 bg-slate-900/40 text-[10.5px] text-slate-500 leading-relaxed">
          <strong className="text-slate-400">Legend:</strong>
          {' '}<em className="text-rose-300">Unaliased</em> = code passes verbatim.
          {' '}<em className="text-rose-300">Always fails</em> = every search returned nothing.
          {' '}<em className="text-amber-300">Sometimes fails</em> = mixed.
          {' '}<em>Untested</em> = never searched yet.
          {' '}<em className="text-emerald-300">Works</em> = at least one success, no failures.
        </div>
    </div>
  );
};

const STAT_TONES = {
  emerald: 'bg-emerald-900/40 text-emerald-200 border-emerald-800',
  amber:   'bg-amber-900/40   text-amber-200   border-amber-800',
  rose:    'bg-rose-900/40    text-rose-200    border-rose-800',
  slate:   'bg-slate-800      text-slate-300   border-slate-700'
};

function Stat({ label, value, tone = 'slate' }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 px-2 py-1 rounded border ${STAT_TONES[tone] || STAT_TONES.slate}`}>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-[10px] uppercase tracking-wider opacity-80">{label}</span>
    </span>
  );
}

export default React.memo(BroadcasterCoverageModal);
