import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

/**
 * AiMatchingPanel — dashboard control + telemetry for AI-assisted
 * live-event channel matching.
 *
 *   • Runtime kill switch (POST /api/ai-matching/toggle)
 *   • LLM readiness + flag state
 *   • Aggregates (calls, overrides, agreement %, errors, latency) so you
 *     can confirm the feature is actually doing something
 *   • Recent-decisions feed
 *
 * Polls GET /api/ai-matching/status every 15s. Self-contained panel
 * (renders its own card) so it can sit as a full-width dashboard row.
 */

const baseUrl = () => (window.location.hostname === 'localhost' ? '' : window.location.origin);

const Stat = ({ label, value, hint, accent = 'slate' }) => {
  const accents = {
    slate: 'text-slate-200',
    green: 'text-green-300',
    cyan: 'text-cyan-300',
    amber: 'text-amber-300',
    red: 'text-red-300',
  };
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${accents[accent] || accents.slate}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
};

const Toggle = ({ on, busy, onClick }) => (
  <button
    onClick={onClick}
    disabled={busy}
    role="switch"
    aria-checked={on}
    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
      on ? 'bg-green-500/80' : 'bg-slate-700'
    } ${busy ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
    title={on ? 'Disable AI matching' : 'Enable AI matching'}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
  </button>
);

const fmtAgo = (ts) => {
  if (!ts) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};

const outcomeStyle = (o) => {
  if (o === 'ok' || o === 'cache_hit') return 'text-green-400';
  if (o === 'llm_null' || o === 'error') return 'text-red-400';
  if (o === 'not_ready') return 'text-amber-400';
  return 'text-slate-500';
};

const AiMatchingPanel = () => {
  const { token } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${baseUrl()}/api/ai-matching/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 15000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const toggle = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl()}/api/ai-matching/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: !status?.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus((s) => ({ ...s, enabled: data.enabled }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      fetchStatus();
    }
  };

  const setWebSearchProvider = async (provider) => {
    try {
      const res = await fetch(`${baseUrl()}/api/ai-matching/web-search-provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus((s) => ({ ...s, webSearch: data.webSearch }));
    } catch (err) {
      setError(err.message);
    } finally {
      fetchStatus();
    }
  };

  const agg = status?.aggregates;
  const recent = status?.recent || [];
  const ws = status?.webSearch;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-2xl opacity-70">🧠</span>
          <div>
            <h3 className="text-lg font-semibold text-slate-200">AI Channel Matching</h3>
            <div className="mt-0.5 flex items-center gap-3 text-[11px]">
              <span className={status?.llmReady ? 'text-green-400' : 'text-amber-400'}>
                ● LLM {status?.llmReady ? `ready (${status.providerCount} avail)` : 'unavailable'}
              </span>
              {agg?.lastCallAt && <span className="text-slate-500">last call {fmtAgo(agg.lastCallAt)}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-mono uppercase tracking-wider ${status?.enabled ? 'text-green-400' : 'text-slate-500'}`}>
            {status?.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <Toggle on={Boolean(status?.enabled)} busy={busy} onClick={toggle} />
        </div>
      </div>

      {error && <div className="mb-3 text-xs text-red-400">Status error: {error}</div>}

      {!status?.enabled && (
        <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
          AI matching is off — live-event searches use the standard fuzzy scorer only. Flip the switch to let the AI
          re-rank candidates (so a NASCAR race won't auto-play "Anthony Bourdain Parts Unknown") and resolve broadcasters
          for team-less events like racing.
        </div>
      )}

      {/* Aggregates (last 7 days) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="Calls (7d)" value={agg?.totalCalls ?? '—'} hint={agg ? `${agg.pickerCalls} pick · ${agg.broadcasterCalls} bcast` : ''} accent="cyan" />
        <Stat label="Overrides" value={agg?.overrides ?? '—'} hint="AI changed top pick" accent="green" />
        <Stat label="Agreement" value={agg?.agreementRate != null ? `${agg.agreementRate}%` : '—'} hint="AI = scorer top" />
        <Stat label="Errors" value={agg?.errorCalls ?? '—'} hint="rate-limit / fail" accent={agg?.errorCalls ? 'red' : 'slate'} />
        <Stat label="Avg latency" value={agg?.avgLatencyMs != null ? `${agg.avgLatencyMs}ms` : '—'} accent="amber" />
      </div>

      {/* Web-search source selector — which backend resolves broadcasters /
          breaking events. 'Auto' smart-picks the healthiest available. */}
      {ws && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">Web search source</span>
            <span className="text-[10px] text-slate-600">used for current broadcasters & breaking news</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Auto */}
            <button
              onClick={() => setWebSearchProvider('auto')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider border transition ${
                ws.preference === 'auto'
                  ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                  : 'border-slate-700 bg-slate-800/40 text-slate-400 hover:text-slate-200'
              }`}
              title="Smart-pick the healthiest available backend"
            >
              Auto
            </button>
            {(ws.providers || []).map((p) => {
              const selected = ws.preference === p.id;
              const disabled = !p.available;
              return (
                <button
                  key={p.id}
                  onClick={() => !disabled && setWebSearchProvider(p.id)}
                  disabled={disabled}
                  title={
                    !p.available ? `${p.label}: no API key`
                    : p.rateLimited ? `${p.label}: rate-limited (will retry / fall back)`
                    : `${p.label}: ${p.ok} ok${p.fails ? `, ${p.fails} fails` : ''}`
                  }
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider border transition ${
                    disabled ? 'border-slate-800 bg-slate-900/40 text-slate-600 cursor-not-allowed'
                    : selected ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                    : 'border-slate-700 bg-slate-800/40 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    !p.available ? 'bg-slate-600' : p.rateLimited ? 'bg-amber-400' : 'bg-green-400'
                  }`} />
                  {p.label}
                </button>
              );
            })}
          </div>
          {ws.preference === 'auto' && (ws.autoOrder?.length > 0) && (
            <div className="mt-1.5 text-[10px] text-slate-600">
              Auto order: {ws.autoOrder.join(' → ')} (skips rate-limited)
            </div>
          )}
        </div>
      )}

      {/* Recent decisions */}
      <div className="mt-5">
        <div className="mb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">Recent decisions</div>
        {recent.length === 0 ? (
          <div className="text-xs text-slate-600 py-3">No AI calls recorded yet. Enable the feature, then run a live-event search.</div>
        ) : (
          <div className="space-y-1.5">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-slate-800/40 border border-slate-700/40 text-xs">
                <div className="min-w-0 flex items-center gap-2">
                  <span className={`font-mono uppercase text-[9px] px-1.5 py-0.5 rounded ${r.feature === 'picker' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-purple-500/15 text-purple-300'}`}>
                    {r.feature}
                  </span>
                  <span className="truncate text-slate-300" title={r.query || ''}>
                    {r.query || `${r.league_name || ''} ${r.sport_type || ''}`.trim() || '(event)'}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 text-slate-500">
                  {r.feature === 'picker' && r.changed_outcome && <span className="text-green-400">re-ranked</span>}
                  {r.latency_ms != null && <span className="tabular-nums">{r.latency_ms}ms</span>}
                  <span className={`font-mono uppercase text-[9px] ${outcomeStyle(r.outcome)}`}>{r.outcome}</span>
                  <span className="tabular-nums w-14 text-right">{fmtAgo(r.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AiMatchingPanel;
