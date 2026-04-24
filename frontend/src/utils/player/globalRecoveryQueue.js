/**
 * Process-wide recovery rate limiter used by every IPTVPlayer instance.
 *
 * In multi-view we can end up with 4+ players all trying to recover at
 * once. Without a shared gate we'd melt the backend (and the user's
 * network card) with retry bursts, so we keep a single queue on
 * `window.iptvRecoveryQueue` that every player checks before kicking
 * off a recovery attempt.
 *
 *   - activeRecoveries / maxConcurrentRecoveries: only N recoveries at once
 *   - globalRecoveryCount inside a 30s window: hard cap across all streams
 *   - globalPaused: emergency brake when the 30s cap is tripped
 *
 * The counters reset automatically when the 30s window expires.
 */

const GLOBAL_WINDOW_MS = 30000;
const MAX_GLOBAL_RECOVERIES = 16;

export function ensureRecoveryQueue() {
  if (typeof window.iptvRecoveryQueue === 'undefined') {
    window.iptvRecoveryQueue = {
      lastRecoveryTime: 0,
      activeRecoveries: 0,
      maxConcurrentRecoveries: 2,
      pendingRecoveries: [],
      maxPendingRecoveries: 10,
      globalRecoveryCount: 0,
      globalRecoveryWindowStart: 0,
      globalPaused: false
    };
  }
  return window.iptvRecoveryQueue;
}

/**
 * Returns true if the caller is allowed to start a recovery, false if
 * the global limit is tripped and the caller should abort.
 *
 * @param {(level: string, message: string) => void} [log] optional logger
 */
export function checkGlobalRecoveryLimits(log) {
  const queue = ensureRecoveryQueue();
  const now = Date.now();

  if (now - queue.globalRecoveryWindowStart > GLOBAL_WINDOW_MS) {
    queue.globalRecoveryCount = 0;
    queue.globalRecoveryWindowStart = now;
    queue.globalPaused = false;
  }

  queue.globalRecoveryCount++;

  if (queue.globalRecoveryCount > MAX_GLOBAL_RECOVERIES) {
    queue.globalPaused = true;
    if (log) {
      log(
        'error',
        `Global recovery limit exceeded (${queue.globalRecoveryCount} in 30s) - pausing all recoveries`
      );
    }
    return false;
  }

  return true;
}
