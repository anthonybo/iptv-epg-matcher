/**
 * LiveScoresTicker - Scrolling banner for live sports scores
 *
 * Uses JavaScript-controlled scrolling instead of CSS animation to:
 * - Preserve scroll position across data updates
 * - Allow smooth pausing without animation reset
 * - Update scores via DOM manipulation without affecting scroll
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, memo } from 'react';
import apiClient from '../utils/apiClient';

// Sport-specific colors - defined outside component
const SPORT_COLORS = {
  'Football': 'border-purple-500/40 bg-purple-500/20',
  'Basketball': 'border-orange-500/40 bg-orange-500/20',
  'Hockey': 'border-blue-500/40 bg-blue-500/20',
  'Soccer': 'border-emerald-500/40 bg-emerald-500/20',
  'Baseball': 'border-indigo-500/40 bg-indigo-500/20',
  'MMA': 'border-red-500/40 bg-red-500/20',
  'Golf': 'border-teal-500/40 bg-teal-500/20',
  'Tennis': 'border-yellow-500/40 bg-yellow-500/20',
  'Racing': 'border-pink-500/40 bg-pink-500/20',
};

const DEFAULT_COLOR = 'border-slate-500/40 bg-slate-500/20';

function getColorClass(sportType) {
  return SPORT_COLORS[sportType] || DEFAULT_COLOR;
}

// Render a single score item to HTML string (for DOM injection)
function renderScoreItem(score, clickable = false) {
  const colorClass = getColorClass(score.sport_type);
  const clickableClass = clickable ? 'cursor-pointer hover:brightness-125 transition-all' : '';
  const liveIndicator = score.is_live
    ? '<span class="h-1.5 w-1.5 rounded-full bg-red-500"></span>'
    : '';
  const clockDisplay = score.game_clock
    ? `<span class="text-slate-500" data-clock="true">${score.game_clock}</span>`
    : '';

  return `
    <div class="flex-shrink-0 flex items-center gap-2 rounded border px-3 py-1.5 text-xs ${colorClass} ${clickableClass}" data-event-id="${score.event_id}">
      ${liveIndicator}
      <span class="text-slate-400">${score.league_name}</span>
      <span class="text-slate-200">${score.away_team}</span>
      <span class="font-bold text-slate-100" data-score="true">${score.away_score ?? '-'} - ${score.home_score ?? '-'}</span>
      <span class="text-slate-200">${score.home_team}</span>
      ${clockDisplay}
    </div>
  `;
}

function LiveScoresTicker({ position = 'bottom', updateInterval = 60000, onEventClick }) {
  // Only track loading state for initial render - everything else uses refs
  const [isLoading, setIsLoading] = useState(true);
  const [hasScores, setHasScores] = useState(false);

  // All mutable state stored in refs to avoid re-renders
  const isMountedRef = useRef(true);
  const containerRef = useRef(null);
  const contentRef = useRef(null);
  const scrollPositionRef = useRef(0);
  const isPausedRef = useRef(false);
  const isVisibleRef = useRef(true);
  const animationFrameRef = useRef(null);
  const lastTimeRef = useRef(0);
  const scoresRef = useRef([]);
  const contentWidthRef = useRef(0);
  const needsRenderRef = useRef(false); // Flag to indicate DOM render needed after ref available
  const onEventClickRef = useRef(onEventClick);

  // Keep callback ref updated
  onEventClickRef.current = onEventClick;

  // Scroll speed in pixels per second
  const SCROLL_SPEED = 50;

  // Update score values in the DOM without re-rendering
  const updateScoreDisplay = useCallback((newScores) => {
    if (!contentRef.current) return;

    const scoreMap = new Map(newScores.map(s => [s.event_id, s]));

    // Update all score elements (both original and duplicate sets)
    const scoreElements = contentRef.current.querySelectorAll('[data-event-id]');
    scoreElements.forEach(el => {
      const eventId = el.getAttribute('data-event-id');
      const score = scoreMap.get(eventId);
      if (score) {
        const scoreEl = el.querySelector('[data-score]');
        if (scoreEl) {
          const newText = `${score.away_score ?? '-'} - ${score.home_score ?? '-'}`;
          if (scoreEl.textContent !== newText) {
            scoreEl.textContent = newText;
          }
        }
        const clockEl = el.querySelector('[data-clock]');
        if (clockEl && score.game_clock) {
          if (clockEl.textContent !== score.game_clock) {
            clockEl.textContent = score.game_clock;
          }
        }
      }
    });
  }, []);

  // Render scores to DOM (only called on initial load or when score count changes significantly)
  const renderScoresToDOM = useCallback((scores) => {
    if (!contentRef.current) {
      // Ref not available yet, mark for later render
      needsRenderRef.current = true;
      return false;
    }

    // Generate HTML for scores (duplicated for seamless loop)
    const isClickable = !!onEventClickRef.current;
    const scoresHtml = scores.map(s => renderScoreItem(s, isClickable)).join('');
    contentRef.current.innerHTML = scoresHtml + scoresHtml;

    // Measure content width after render
    requestAnimationFrame(() => {
      if (contentRef.current) {
        // Half the width since we duplicated the content
        contentWidthRef.current = contentRef.current.scrollWidth / 2;
      }
    });

    needsRenderRef.current = false;
    return true;
  }, []);

  // Animation loop using requestAnimationFrame
  const animate = useCallback((currentTime) => {
    if (!isMountedRef.current) return;

    // Calculate delta time
    if (lastTimeRef.current === 0) {
      lastTimeRef.current = currentTime;
    }
    const deltaTime = (currentTime - lastTimeRef.current) / 1000; // Convert to seconds
    lastTimeRef.current = currentTime;

    // Only scroll if not paused and visible
    if (!isPausedRef.current && isVisibleRef.current && contentRef.current) {
      scrollPositionRef.current += SCROLL_SPEED * deltaTime;

      // Reset position when we've scrolled through half the content (seamless loop)
      if (contentWidthRef.current > 0 && scrollPositionRef.current >= contentWidthRef.current) {
        scrollPositionRef.current = scrollPositionRef.current - contentWidthRef.current;
      }

      // Apply transform
      contentRef.current.style.transform = `translateX(-${scrollPositionRef.current}px)`;
    }

    // Continue animation loop
    animationFrameRef.current = requestAnimationFrame(animate);
  }, []);

  // Fetch scores from API
  const fetchScores = useCallback(async (isInitial = false) => {
    if (!isMountedRef.current) return;

    try {
      const response = await apiClient.get('/live-scores');
      if (!isMountedRef.current) return;

      if (response.data.success) {
        const newScores = response.data.scores || [];
        const previousCount = scoresRef.current.length;
        scoresRef.current = newScores;

        if (isInitial) {
          // First load - update state first, then render will happen in useLayoutEffect
          // This ensures the contentRef is available when we try to render
          setHasScores(newScores.length > 0);
          setIsLoading(false);
          // Mark that we need to render once ref is available
          needsRenderRef.current = true;
        } else if (Math.abs(newScores.length - previousCount) > 3) {
          // Significant change in score count - re-render DOM
          // Preserve scroll position relative to content
          const scrollRatio = contentWidthRef.current > 0
            ? scrollPositionRef.current / contentWidthRef.current
            : 0;
          renderScoresToDOM(newScores);
          // Restore scroll position proportionally
          requestAnimationFrame(() => {
            if (contentWidthRef.current > 0) {
              scrollPositionRef.current = scrollRatio * contentWidthRef.current;
            }
          });
        } else {
          // Minor update - just update the text via DOM manipulation
          updateScoreDisplay(newScores);
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error('Error fetching live scores:', err);
        if (isInitial) {
          setIsLoading(false);
        }
      }
    }
  }, [renderScoresToDOM, updateScoreDisplay]);

  // Initialize and start animation
  useEffect(() => {
    isMountedRef.current = true;

    // Fetch initial scores
    fetchScores(true);

    // Start animation loop
    animationFrameRef.current = requestAnimationFrame(animate);

    // Set up polling interval
    const intervalId = setInterval(() => {
      fetchScores(false);
    }, updateInterval);

    // Cleanup
    return () => {
      isMountedRef.current = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      clearInterval(intervalId);
      // Reset refs for next mount
      scrollPositionRef.current = 0;
      lastTimeRef.current = 0;
      contentWidthRef.current = 0;
      scoresRef.current = [];
      needsRenderRef.current = false;
    };
  }, [animate, fetchScores, updateInterval]);

  // After DOM is ready, check if we need to render scores that were fetched before ref was available
  useLayoutEffect(() => {
    if (needsRenderRef.current && scoresRef.current.length > 0 && contentRef.current) {
      renderScoresToDOM(scoresRef.current);
    }
  });

  // Event handlers - update refs directly, no state changes
  const handleMouseEnter = useCallback(() => {
    isPausedRef.current = true;
    // Update the PAUSED indicator in DOM directly
    const pausedEl = document.getElementById('ticker-paused-indicator');
    if (pausedEl) pausedEl.style.display = 'block';
  }, []);

  const handleMouseLeave = useCallback(() => {
    isPausedRef.current = false;
    // Reset delta time to prevent jump
    lastTimeRef.current = 0;
    // Hide the PAUSED indicator
    const pausedEl = document.getElementById('ticker-paused-indicator');
    if (pausedEl) pausedEl.style.display = 'none';
  }, []);

  const handleToggleVisibility = useCallback(() => {
    isVisibleRef.current = !isVisibleRef.current;
    // Update visibility via DOM
    const tickerBody = document.getElementById('ticker-body');
    const toggleBtn = document.getElementById('ticker-toggle-btn');
    if (tickerBody) {
      if (isVisibleRef.current) {
        tickerBody.classList.remove(position === 'top' ? '-translate-y-full' : 'translate-y-full');
        tickerBody.classList.add('translate-y-0');
      } else {
        tickerBody.classList.remove('translate-y-0');
        tickerBody.classList.add(position === 'top' ? '-translate-y-full' : 'translate-y-full');
      }
    }
    if (toggleBtn) {
      toggleBtn.textContent = isVisibleRef.current ? 'Hide' : `Scores (${scoresRef.current.length})`;
    }
  }, [position]);

  const handleRefresh = useCallback(() => {
    fetchScores(false);
  }, [fetchScores]);

  // Handle click on score item (event delegation)
  const handleContentClick = useCallback((e) => {
    if (!onEventClickRef.current) return;

    // Find the score item element (could click on a child span)
    const scoreItem = e.target.closest('[data-event-id]');
    if (!scoreItem) return;

    const eventId = scoreItem.getAttribute('data-event-id');
    if (!eventId) return;

    // Find the score data from our ref
    const score = scoresRef.current.find(s => s.event_id === eventId);
    if (score) {
      onEventClickRef.current(score);
    }
  }, []);

  // Don't render if loading or no scores
  if (isLoading) {
    return (
      <div className={`fixed left-0 right-0 z-[60] bg-slate-900/95 border-slate-800 ${position === 'top' ? 'top-0 border-b' : 'bottom-0 border-t'}`}>
        <div className="flex items-center h-12 px-4">
          <span className="text-sm text-slate-400">Loading scores...</span>
        </div>
      </div>
    );
  }

  if (!hasScores) {
    return null;
  }

  const positionClass = position === 'top' ? 'top-0 border-b' : 'bottom-0 border-t';

  return (
    <div
      id="ticker-body"
      ref={containerRef}
      className={`fixed left-0 right-0 z-[60] bg-slate-900/95 border-slate-800 transition-transform duration-300 ${positionClass} translate-y-0`}
    >
      {/* Toggle button */}
      <button
        id="ticker-toggle-btn"
        onClick={handleToggleVisibility}
        className={`absolute ${position === 'top' ? '-bottom-7' : '-top-7'} left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200 z-[61]`}
      >
        Hide
      </button>

      <div
        className="flex items-center h-12"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Label */}
        <div className="flex-shrink-0 flex items-center gap-2 px-3 border-r border-slate-800">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
          <span className="text-xs font-bold text-slate-200">LIVE</span>
        </div>

        {/* Scrolling container */}
        <div className="flex-1 overflow-hidden">
          <div
            ref={contentRef}
            className="inline-flex gap-3 px-4 whitespace-nowrap"
            style={{ willChange: 'transform' }}
            onClick={handleContentClick}
          />
        </div>

        {/* Paused indicator */}
        <span
          id="ticker-paused-indicator"
          className="text-xs text-slate-500 px-2"
          style={{ display: 'none' }}
        >
          PAUSED
        </span>

        {/* Refresh button */}
        <button
          onClick={handleRefresh}
          className="flex-shrink-0 p-2 text-slate-400 hover:text-slate-200"
          title="Refresh scores"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default memo(LiveScoresTicker);
