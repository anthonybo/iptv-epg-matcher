/**
 * EventCard - Displays a single sports event with optional live score
 *
 * Extracted as a separate component to follow React best practices:
 * - Components should be defined at the top level, not inside other components
 * - This prevents recreation on every parent render
 * - Uses React.memo to prevent unnecessary re-renders
 */

import React, { memo } from 'react';

// League color mapping - defined outside component
const LEAGUE_COLORS = {
  // Football
  'NFL': 'bg-purple-500/20 text-purple-300',
  'NCAAF': 'bg-purple-500/20 text-purple-300',
  'College Football': 'bg-purple-500/20 text-purple-300',
  // Basketball
  'NBA': 'bg-orange-500/20 text-orange-300',
  'NCAAB': 'bg-orange-500/20 text-orange-300',
  'WNBA': 'bg-orange-500/20 text-orange-300',
  'WCAAB': 'bg-orange-500/20 text-orange-300',
  // Hockey
  'NHL': 'bg-blue-500/20 text-blue-300',
  // Soccer
  'Premier League': 'bg-emerald-500/20 text-emerald-300',
  'MLS': 'bg-emerald-500/20 text-emerald-300',
  'La Liga': 'bg-emerald-500/20 text-emerald-300',
  'Bundesliga': 'bg-emerald-500/20 text-emerald-300',
  'Serie A': 'bg-emerald-500/20 text-emerald-300',
  'Ligue 1': 'bg-emerald-500/20 text-emerald-300',
  'Champions League': 'bg-emerald-500/20 text-emerald-300',
  'Europa League': 'bg-emerald-500/20 text-emerald-300',
  'Liga MX': 'bg-emerald-500/20 text-emerald-300',
  // Combat
  'UFC': 'bg-red-500/20 text-red-300',
  // Golf
  'PGA': 'bg-teal-500/20 text-teal-300',
  // Tennis
  'ATP': 'bg-yellow-500/20 text-yellow-300',
  'WTA': 'bg-yellow-500/20 text-yellow-300',
  // Baseball
  'MLB': 'bg-indigo-500/20 text-indigo-300',
  'College Baseball': 'bg-indigo-500/20 text-indigo-300',
  // Racing
  'Formula 1': 'bg-pink-500/20 text-pink-300',
  'NASCAR': 'bg-pink-500/20 text-pink-300',
  'IndyCar': 'bg-pink-500/20 text-pink-300',
};

const DEFAULT_LEAGUE_COLOR = 'bg-slate-500/20 text-slate-300';

function getLeagueColor(leagueName) {
  return LEAGUE_COLORS[leagueName] || DEFAULT_LEAGUE_COLOR;
}

function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function formatDate(isoString) {
  const date = new Date(isoString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  } else if (date.toDateString() === tomorrow.toDateString()) {
    return 'Tomorrow';
  } else {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
}

const EventCard = memo(function EventCard({
  event,
  isLive,
  score,
  inMultiview,
  onClick
}) {
  const hasScore = score && (score.home_score !== null || score.away_score !== null);
  const isGameLive = score?.is_live;

  const borderColor = inMultiview
    ? 'border-red-500/30 bg-red-500/5 hover:border-red-500/50'
    : isLive || isGameLive
      ? 'border-green-500/30 bg-green-500/5 hover:border-green-500/50'
      : 'border-slate-800/70 bg-slate-950/40 hover:border-slate-700';

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border p-4 text-left transition-all hover:scale-[1.02] hover:shadow-lg ${borderColor}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-xs font-semibold text-slate-300">
              {event.sport_type}
            </span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getLeagueColor(event.league_name)}`}>
              {event.league_name}
            </span>
            {inMultiview && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-medium text-red-300">
                <span className="h-2 w-2 rounded-full bg-red-400"></span>
                ACTIVE
              </span>
            )}
            {(isLive || isGameLive) && !inMultiview && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2.5 py-0.5 text-xs font-medium text-green-300">
                <span className="h-2 w-2 rounded-full bg-green-400"></span>
                LIVE
              </span>
            )}
            {/* Game clock/status for live games */}
            {score?.game_clock && (
              <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                {score.game_clock}
              </span>
            )}
          </div>

          {/* Show score display for live/finished games */}
          {hasScore ? (
            <div className="mb-2">
              {/* Teams with scores */}
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-sm font-medium ${score.away_score > score.home_score ? 'text-green-400' : 'text-slate-200'}`}>
                      {event.away_team}
                    </span>
                    <span className={`text-lg font-bold ${score.away_score > score.home_score ? 'text-green-400' : 'text-slate-200'}`}>
                      {score.away_score ?? '-'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-medium ${score.home_score > score.away_score ? 'text-green-400' : 'text-slate-200'}`}>
                      {event.home_team}
                    </span>
                    <span className={`text-lg font-bold ${score.home_score > score.away_score ? 'text-green-400' : 'text-slate-200'}`}>
                      {score.home_score ?? '-'}
                    </span>
                  </div>
                </div>
              </div>
              {/* Game status */}
              {score.game_status && score.game_status !== 'Scheduled' && (
                <div className="mt-1 text-xs text-slate-400">
                  {score.game_status}
                </div>
              )}
            </div>
          ) : (
            <h3 className="mb-1 text-base font-semibold text-slate-100">
              {event.event_name}
            </h3>
          )}

          <div className="flex items-center gap-3 text-sm text-slate-400">
            <div className="flex items-center gap-1.5">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{formatDate(event.event_start)} at {formatTime(event.event_start)}</span>
            </div>
          </div>
        </div>
        <svg className="h-5 w-5 flex-shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>
    </button>
  );
});

export default EventCard;
