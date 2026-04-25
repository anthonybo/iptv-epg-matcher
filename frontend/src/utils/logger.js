/**
 * Frontend Logger - Tracks errors and events, sends them to backend
 * Provides Sentry-like functionality for self-hosted error tracking
 */

class FrontendLogger {
  constructor() {
    this.endpoint = '/api/logs/frontend';
    this.queue = [];
    this.flushInterval = 5000; // Flush every 5 seconds
    this.maxQueueSize = 50;
    this.enabled = process.env.NODE_ENV !== 'test';

    // Rate limiting for repeated errors (prevents "Script error" spam)
    this.errorCounts = new Map(); // message -> { count, lastLogged }
    this.errorThrottleMs = 10000; // Only log same error once per 10 seconds
    this.errorThrottleMax = 5; // After 5 occurrences, throttle more aggressively

    // Start auto-flush
    if (this.enabled) {
      setInterval(() => this.flush(), this.flushInterval);
      this.setupGlobalErrorHandlers();

      // Clean up old error counts every minute
      setInterval(() => {
        const now = Date.now();
        for (const [key, data] of this.errorCounts.entries()) {
          if (now - data.lastLogged > 60000) {
            this.errorCounts.delete(key);
          }
        }
      }, 60000);
    }
  }

  /**
   * Check if an error should be throttled
   * Returns true if the error should be suppressed
   */
  shouldThrottleError(message) {
    const key = message || 'unknown';
    const now = Date.now();
    const data = this.errorCounts.get(key);

    if (!data) {
      this.errorCounts.set(key, { count: 1, lastLogged: now });
      return false; // First occurrence, don't throttle
    }

    data.count++;
    const timeSinceLastLog = now - data.lastLogged;

    // If error has occurred many times, throttle more aggressively
    const throttleTime = data.count > this.errorThrottleMax
      ? this.errorThrottleMs * 3 // 30 seconds for repeated errors
      : this.errorThrottleMs;    // 10 seconds normally

    if (timeSinceLastLog < throttleTime) {
      return true; // Throttle this error
    }

    // Enough time has passed, log it again
    data.lastLogged = now;
    return false;
  }

  /**
   * Identify mpegts.js post-teardown races so we can drop them.
   *
   * After destroy() nulls the library's internal controllers, pending async
   * callbacks (SourceBuffer updateend, stats reporters, etc.) still fire
   * against those refs. They always surface as
   *   "Cannot read properties of null (reading '<something>')"
   * thrown from inside mpegts.js itself. Known variants we've seen:
   *   - reading 'notifyBufferedPositionChanged' (_onMSEUpdateEnd)
   *   - reading 'currentURL' (_reportStatisticsInfo)
   * Rather than enumerate every future variant, catch any null-deref whose
   * stack or filename originates in mpegts.js. User code calling into a
   * destroyed player would throw from the caller's stack frames, not from
   * inside the library, so this won't hide bugs outside the library itself.
   */
  isMpegtsTeardownRace(message, stack, filename) {
    const text = `${message || ''} ${stack || ''}`;
    const insideMpegts = (filename && /mpegts\.js/i.test(filename)) || /mpegts\.js/i.test(stack || '');
    if (insideMpegts && /Cannot read propert(?:y|ies) of null/i.test(message || '')) {
      return true;
    }
    // Also keep the earlier method-name heuristics for minified stacks where
    // the filename was stripped but the handler name survived.
    if (/notifyBufferedPositionChanged/i.test(text)) return true;
    if (/_onMSEUpdateEnd|_onSourceBufferUpdateEnd|_reportStatisticsInfo/i.test(text)) return true;
    return false;
  }

  /**
   * Setup global error handlers and intercept console methods
   */
  setupGlobalErrorHandlers() {
    // Store original console methods
    const originalConsole = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
      info: console.info.bind(console)
    };

    // Keep original console available
    window._originalConsole = originalConsole;
    this.originalConsole = originalConsole;

    // Flag to prevent infinite loops - shared across all logger methods
    this.isLogging = false;

    // Intercept console.log
    console.log = (...args) => {
      originalConsole.log(...args);
      if (!this.isLogging && !args.some(a => String(a).includes('[Logger]'))) {
        this.isLogging = true;
        try {
          this.info(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
        } finally {
          this.isLogging = false;
        }
      }
    };

    // Intercept console.error
    console.error = (...args) => {
      originalConsole.error(...args);
      if (!this.isLogging && !args.some(a => String(a).includes('[Logger]'))) {
        this.isLogging = true;
        try {
          const message = args.map(a => {
            if (a instanceof Error) return a.message;
            if (typeof a === 'object') return JSON.stringify(a);
            return String(a);
          }).join(' ');

          const stack = args.find(a => a instanceof Error)?.stack;
          this.error(message, stack ? { stack } : {});
        } finally {
          this.isLogging = false;
        }
      }
    };

    // Intercept console.warn
    console.warn = (...args) => {
      originalConsole.warn(...args);
      if (!this.isLogging && !args.some(a => String(a).includes('[Logger]'))) {
        this.isLogging = true;
        try {
          this.warn(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
        } finally {
          this.isLogging = false;
        }
      }
    };

    // Intercept console.info
    console.info = (...args) => {
      originalConsole.info(...args);
      if (!this.isLogging && !args.some(a => String(a).includes('[Logger]'))) {
        this.isLogging = true;
        try {
          this.info(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
        } finally {
          this.isLogging = false;
        }
      }
    };

    // Catch unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.error('Unhandled Promise Rejection', {
        reason: event.reason?.message || event.reason,
        stack: event.reason?.stack
      });
    });

    // Catch global errors - with throttling to prevent spam from repeated errors
    window.addEventListener('error', (event) => {
      const errorKey = event.message || 'Script error';
      const stack = event.error?.stack || '';

      // Drop the mpegts.js post-teardown race entirely. When a player is
      // destroyed, Chrome can still fire one final SourceBuffer 'updateend'
      // whose handler touches a nulled internal ref — cosmetic, happens
      // after the player is gone. Not worth logging or shipping to the
      // backend on every channel change.
      //
      // preventDefault() marks the error as handled so Chrome also skips
      // the red "Uncaught TypeError" line in DevTools.
      if (this.isMpegtsTeardownRace(event.message, stack, event.filename)) {
        event.preventDefault();
        return;
      }

      // Throttle repeated errors (especially "Script error" from mpegts.js)
      if (this.shouldThrottleError(errorKey)) {
        return; // Skip logging this repeated error
      }

      this.error('Global Error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack
      });
    });
  }

  /**
   * Get user context
   */
  getUserContext() {
    try {
      // Try to get user from token
      const token = localStorage.getItem('auth_token');
      if (token) {
        // Decode JWT (basic decode, no verification needed for logging)
        const payload = JSON.parse(atob(token.split('.')[1]));
        return {
          userId: payload.userId,
          username: payload.username,
          email: payload.email
        };
      }
    } catch (e) {
      // Ignore decode errors
    }
    return { userId: null, username: 'anonymous' };
  }

  /**
   * Get browser context
   */
  getBrowserContext() {
    return {
      userAgent: navigator.userAgent,
      url: window.location.href,
      referrer: document.referrer,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Check if message should be filtered from BACKEND logging only
   * These messages still appear in browser console, just not sent to backend
   */
  shouldFilterFromBackend(message) {
    const filterPatterns = [
      // AC-3/EAC-3 codec not supported by browser MSE - video plays fine, just no audio
      /audio\/mp4;codecs=ac-3/i,
      /audio\/mp4;codecs=ec-3/i,
      /The type provided.*is unsupported/i,
      // Early-EOF is normal when switching/stopping streams
      /Fetch stream meet Early-EOF/i,
      /UnrecoverableEarlyEof/i,
      // Vite dev server connection issues (dev only)
      /vite.*server connection lost/i,
      /vite.*polling for restart/i,
      // mpegts.js TS demuxer sync errors - extremely noisy (thousands per minute)
      /sync_byte\s*=\s*\d+,\s*not\s*0x47/i
    ];
    return filterPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Add log entry to queue
   */
  log(level, message, context = {}) {
    if (!this.enabled) return;

    // Only filter the most extreme noise from backend logging
    // Other messages still go to backend for debugging
    if (this.shouldFilterFromBackend(message)) {
      return;
    }

    const entry = {
      level,
      message,
      context: {
        ...context,
        user: this.getUserContext(),
        browser: this.getBrowserContext()
      }
    };

    this.queue.push(entry);

    // Auto-flush if queue is full
    if (this.queue.length >= this.maxQueueSize) {
      this.flush();
    }
  }

  /**
   * Log an error
   */
  error(message, context = {}) {
    this.log('error', message, context);
    // Use original console to avoid infinite loop
    if (process.env.NODE_ENV === 'development' && this.originalConsole) {
      this.originalConsole.error('[Logger]', message, context);
    }
  }

  /**
   * Log a warning
   */
  warn(message, context = {}) {
    this.log('warn', message, context);
    if (process.env.NODE_ENV === 'development' && this.originalConsole) {
      this.originalConsole.warn('[Logger]', message, context);
    }
  }

  /**
   * Log info
   */
  info(message, context = {}) {
    this.log('info', message, context);
    if (process.env.NODE_ENV === 'development' && this.originalConsole) {
      this.originalConsole.log('[Logger]', message, context);
    }
  }

  /**
   * Log a performance metric
   */
  performance(metric, value, unit = 'ms') {
    this.log('performance', `${metric}: ${value}${unit}`, { metric, value, unit });
  }

  /**
   * Log a user action
   */
  action(actionName, details = {}) {
    this.log('action', actionName, { action: actionName, ...details });
  }

  /**
   * Flush logs to backend
   */
  async flush() {
    if (this.queue.length === 0) return;

    const logs = [...this.queue];
    this.queue = [];

    try {
      const token = localStorage.getItem('token');
      const headers = {
        'Content-Type': 'application/json'
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${this.endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ logs })
      });

      if (!response.ok) {
        this.originalConsole.error('Failed to send logs, status:', response.status);
      } else {
        this.originalConsole.log(`[Logger] Sent ${logs.length} logs to backend`);
      }
    } catch (error) {
      // Silent fail - don't want logging to break the app
      this.originalConsole.error('Failed to send logs to backend:', error);
      // Don't put logs back - just drop them to avoid infinite growth
    }
  }

  /**
   * Manually flush logs (useful before navigation)
   */
  async forceFlush() {
    await this.flush();
  }
}

// Create singleton instance
const logger = new FrontendLogger();

// Expose globally for easy access
window.logger = logger;

export default logger;
