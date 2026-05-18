import React, { useCallback, useEffect, useState } from 'react';
import { getFingerprintStats } from '../../utils/adFingerprintStore';

/**
 * CommercialDetectionPanel — dashboard surface for the commercial-
 * detection learning data. Shows how big the hotlist has grown,
 * which channels have been calibrated, and how close the user is to
 * the per-user storage budget. The backend warns + auto-prunes once
 * the budget is exceeded; this panel mostly exists to make the
 * usage visible so the user is never surprised.
 */
const REFRESH_INTERVAL_MS = 30_000;

const formatBytes = (bytes) => {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const formatRelative = (ts) => {
  if (!ts) return '—';
  const ageMs = Date.now() - ts;
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

const Bar = ({ ratio, warnRatio = 0.8, label }) => {
  const pct = Math.min(100, Math.round((ratio || 0) * 100));
  const over = ratio >= 1;
  const warn = ratio >= warnRatio;
  const color = over ? 'bg-rose-400' : warn ? 'bg-amber-300' : 'bg-emerald-400';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">
        <span>{label}</span>
        <span className={over ? 'text-rose-300' : warn ? 'text-amber-200' : 'text-slate-400'}>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
        <div className={`h-full ${color} transition-[width] duration-300`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const CommercialDetectionPanel = () => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getFingerprintStats();
      if (s) setStats(s);
      else setError('Unable to load stats');
      setLoading(false);
    } catch (e) {
      setError(e.message || 'Failed to load stats');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (loading) {
    return (
      <div className="text-center py-8 text-slate-500 text-sm">
        Loading commercial-detection stats…
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="text-center py-8 text-slate-500 text-sm">
        {error || 'No stats available yet'}
      </div>
    );
  }

  const overall = (
    <div className="grid grid-cols-3 gap-3">
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">Hotlist size</div>
        <div className="mt-1 text-2xl font-bold text-slate-100 font-mono tabular-nums">{stats.rows}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">commercials learned</div>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">Storage</div>
        <div className="mt-1 text-2xl font-bold text-slate-100 font-mono tabular-nums">{formatBytes(stats.bytes)}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">of {formatBytes(stats.maxBytes)}</div>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">Channels</div>
        <div className="mt-1 text-2xl font-bold text-slate-100 font-mono tabular-nums">{stats.channels}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">{stats.newestAt ? `newest ${formatRelative(stats.newestAt)}` : '—'}</div>
      </div>
    </div>
  );

  const budget = (
    <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
          Per-user budget
        </span>
        {stats.bytesRatio >= 1 || stats.rowsRatio >= 1 ? (
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-rose-300">
            ⚠ Pruning oldest
          </span>
        ) : stats.bytesRatio >= stats.warnRatio || stats.rowsRatio >= stats.warnRatio ? (
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-amber-300">
            Approaching limit
          </span>
        ) : (
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-400">
            Healthy
          </span>
        )}
      </div>
      <Bar ratio={stats.rowsRatio} warnRatio={stats.warnRatio} label={`Rows · ${stats.rows} / ${stats.maxRows}`} />
      <Bar ratio={stats.bytesRatio} warnRatio={stats.warnRatio} label={`Bytes · ${formatBytes(stats.bytes)} / ${formatBytes(stats.maxBytes)}`} />
    </div>
  );

  const topChannels = stats.byChannel?.length > 0 && (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
          By channel
        </span>
        <span className="text-[10px] text-slate-500">{stats.byChannel.length} {stats.byChannel.length === 1 ? 'channel' : 'channels'}</span>
      </div>
      <div className="max-h-64 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgb(51_65_85)_transparent]">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-slate-950/95 backdrop-blur-sm text-[9px] font-mono uppercase tracking-[0.18em] text-slate-600">
            <tr>
              <th className="text-left px-3 py-1.5">Channel</th>
              <th className="text-right px-3 py-1.5">Rows</th>
              <th className="text-right px-3 py-1.5">Bytes</th>
              <th className="text-right px-3 py-1.5">Newest</th>
            </tr>
          </thead>
          <tbody>
            {stats.byChannel.map((c) => (
              <tr key={c.channelId} className="border-t border-slate-800/40 hover:bg-slate-800/40 transition">
                <td className="px-3 py-1.5 font-mono text-[11px] text-slate-300 truncate max-w-[200px]" title={c.channelId}>
                  {c.channelId}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-300">{c.rows}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-400">{formatBytes(c.bytes)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-[10px] text-slate-500">{formatRelative(c.newestAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {overall}
      {budget}
      {topChannels}
    </div>
  );
};

export default CommercialDetectionPanel;
