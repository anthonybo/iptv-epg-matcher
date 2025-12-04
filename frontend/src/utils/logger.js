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

    // Start auto-flush
    if (this.enabled) {
      setInterval(() => this.flush(), this.flushInterval);
      this.setupGlobalErrorHandlers();
    }
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

    // Catch global errors
    window.addEventListener('error', (event) => {
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
   * Check if message should be filtered (known non-critical errors)
   */
  shouldFilter(message) {
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
      // mpegts.js TS demuxer sync errors - happens during buffering/stream switching
      // These are noisy but non-critical (stream usually recovers)
      /sync_byte\s*=\s*\d+,\s*not\s*0x47/i,
      /\[TSDemuxer\].*sync_byte/i,
      // mpegts.js internal errors that don't affect playback
      /\[MSEController\].*buffer/i,
      /\[IOController\].*abort/i
    ];
    return filterPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Add log entry to queue
   */
  log(level, message, context = {}) {
    if (!this.enabled) return;

    // Filter out known non-critical errors
    if (level === 'error' && this.shouldFilter(message)) {
      // Still log to console in dev for debugging, but don't send to backend
      if (process.env.NODE_ENV === 'development' && this.originalConsole) {
        this.originalConsole.log('[Logger] Filtered:', message);
      }
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

      const response = await fetch(`http://localhost:5001${this.endpoint}`, {
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
