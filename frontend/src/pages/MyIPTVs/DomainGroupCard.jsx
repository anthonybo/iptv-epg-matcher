import React, { useState, useEffect } from 'react';
import SourceCard from './SourceCard';
import { getAccountHealth, getAccountLabel, healthDotClasses } from './utils';

const DomainGroupCard = ({ group, sourceRefreshStatus, ...cardProps }) => {
  const [activeId, setActiveId] = useState(group.sources[0]?.id);

  useEffect(() => {
    if (!group.sources.find((s) => s.id === activeId)) {
      setActiveId(group.sources[0]?.id);
    }
  }, [group.sources, activeId]);

  const active = group.sources.find((s) => s.id === activeId) || group.sources[0];
  if (!active) return null;

  const counts = group.sources.reduce(
    (acc, s) => {
      const h = getAccountHealth(s, sourceRefreshStatus[s.id]);
      acc[h] = (acc[h] || 0) + 1;
      return acc;
    },
    {}
  );
  const totalChannels = group.sources.reduce((sum, s) => sum + (s.channel_count || 0), 0);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/40 overflow-hidden md:col-span-2 lg:col-span-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 bg-slate-900/50 border-b border-slate-700/80">
        <div className="flex items-center gap-3 min-w-0">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-blue-500/20 text-blue-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-100 truncate">{group.domain}</h3>
            <div className="text-xs text-slate-400 flex items-center gap-3 flex-wrap">
              <span className="uppercase tracking-wide">{group.type}</span>
              <span>{group.sources.length} account{group.sources.length === 1 ? '' : 's'}</span>
              <span>{totalChannels.toLocaleString()} total channels</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {counts.ok ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <span className={`w-2 h-2 rounded-full ${healthDotClasses.ok}`} /> {counts.ok} working
            </span>
          ) : null}
          {counts.warn ? (
            <span className="inline-flex items-center gap-1.5 text-amber-300">
              <span className={`w-2 h-2 rounded-full ${healthDotClasses.warn}`} /> {counts.warn} warning
            </span>
          ) : null}
          {counts.error ? (
            <span className="inline-flex items-center gap-1.5 text-red-300">
              <span className={`w-2 h-2 rounded-full ${healthDotClasses.error}`} /> {counts.error} failed
            </span>
          ) : null}
          {counts.unknown ? (
            <span className="inline-flex items-center gap-1.5 text-slate-400">
              <span className={`w-2 h-2 rounded-full ${healthDotClasses.unknown}`} /> {counts.unknown} unknown
            </span>
          ) : null}
          {counts.loading ? (
            <span className="inline-flex items-center gap-1.5 text-blue-300">
              <span className={`w-2 h-2 rounded-full ${healthDotClasses.loading}`} /> {counts.loading} loading
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto px-3 pt-3 pb-0 border-b border-slate-700/60">
        {group.sources.map((src) => {
          const health = getAccountHealth(src, sourceRefreshStatus[src.id]);
          const isActive = src.id === active.id;
          return (
            <button
              key={src.id}
              type="button"
              onClick={() => setActiveId(src.id)}
              className={`inline-flex items-center gap-2 px-3 py-2 text-sm rounded-t-lg border-b-2 whitespace-nowrap transition-colors ${
                isActive
                  ? 'border-blue-400 bg-slate-800/80 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
              title={getAccountLabel(src)}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${healthDotClasses[health]}`} />
              <span className="max-w-[12rem] truncate">{getAccountLabel(src)}</span>
            </button>
          );
        })}
      </div>

      <div className="p-2">
        <SourceCard
          key={active.id}
          source={active}
          refreshStatus={sourceRefreshStatus[active.id]}
          {...cardProps}
        />
      </div>
    </div>
  );
};

export default DomainGroupCard;
