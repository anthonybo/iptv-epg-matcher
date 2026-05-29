/**
 * Login Component — "broadcast power-on" control surface.
 *
 * Aesthetic: signing in is switching on the transmitter. A cinematic
 * signal field (drifting gradient-mesh glows, scanlines, a slow scan-
 * sweep) sits behind a glass control card wearing the app's chyron
 * language — a live "ON AIR" chip, mono technical labels, cyan focus
 * glow. The card powers on with a staggered reveal.
 *
 * All auth wiring is unchanged: useAuth().login, onSwitchToRegister,
 * sessionId, error state, loading spinner, autoComplete. Animations
 * respect prefers-reduced-motion.
 */
import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

const STYLES = `
  @keyframes lg-drift-a {
    0%,100% { transform: translate3d(0,0,0) scale(1); }
    50%     { transform: translate3d(6%, -4%, 0) scale(1.12); }
  }
  @keyframes lg-drift-b {
    0%,100% { transform: translate3d(0,0,0) scale(1.05); }
    50%     { transform: translate3d(-7%, 5%, 0) scale(0.92); }
  }
  @keyframes lg-drift-c {
    0%,100% { transform: translate3d(0,0,0) scale(1); }
    50%     { transform: translate3d(4%, 6%, 0) scale(1.1); }
  }
  /* Slow vertical scan-sweep across the whole field */
  @keyframes lg-scan {
    0%   { transform: translateY(-30%); opacity: 0; }
    8%   { opacity: 0.55; }
    92%  { opacity: 0.55; }
    100% { transform: translateY(130vh); opacity: 0; }
  }
  /* Staggered power-on reveal for card rows */
  @keyframes lg-rise {
    0%   { opacity: 0; transform: translateY(14px); filter: blur(6px); }
    100% { opacity: 1; transform: translateY(0);    filter: blur(0);   }
  }
  @keyframes lg-card-in {
    0%   { opacity: 0; transform: translateY(24px) scale(0.985); }
    100% { opacity: 1; transform: translateY(0)    scale(1);     }
  }
  @keyframes lg-pulse {
    0%   { transform: scale(1);   opacity: 0.7; }
    70%  { transform: scale(2.6); opacity: 0;   }
    100% { transform: scale(2.6); opacity: 0;   }
  }
  /* Button sheen sweep on hover */
  @keyframes lg-sheen {
    0%   { transform: translateX(-130%) skewX(-18deg); }
    100% { transform: translateX(230%)  skewX(-18deg); }
  }
  /* Title gradient shimmer */
  @keyframes lg-shimmer {
    0%,100% { background-position: 0% 50%; }
    50%     { background-position: 100% 50%; }
  }

  .lg-stagger > * { opacity: 0; animation: lg-rise 620ms cubic-bezier(0.22,1,0.36,1) forwards; }
  .lg-stagger > *:nth-child(1) { animation-delay: 160ms; }
  .lg-stagger > *:nth-child(2) { animation-delay: 240ms; }
  .lg-stagger > *:nth-child(3) { animation-delay: 320ms; }
  .lg-stagger > *:nth-child(4) { animation-delay: 400ms; }
  .lg-stagger > *:nth-child(5) { animation-delay: 480ms; }
  .lg-stagger > *:nth-child(6) { animation-delay: 560ms; }

  .lg-input {
    transition: border-color 180ms ease, box-shadow 220ms ease, background-color 180ms ease;
  }
  .lg-input:focus {
    border-color: rgba(34,211,238,0.65);
    box-shadow: 0 0 0 3px rgba(34,211,238,0.14), 0 0 22px -6px rgba(34,211,238,0.5);
    background-color: rgba(15,23,42,0.85);
  }
  .lg-submit { position: relative; overflow: hidden; transition: transform 120ms ease, box-shadow 220ms ease, filter 180ms ease; }
  .lg-submit:hover:not(:disabled)  { filter: brightness(1.08); box-shadow: 0 14px 40px -12px rgba(34,211,238,0.6); }
  .lg-submit:active:not(:disabled) { transform: translateY(1px) scale(0.992); }
  .lg-submit:hover:not(:disabled) .lg-sheen { animation: lg-sheen 820ms ease; }

  .lg-link { position: relative; }
  .lg-link::after {
    content: ''; position: absolute; left: 0; bottom: -2px; height: 1px; width: 100%;
    background: currentColor; transform: scaleX(0); transform-origin: right;
    transition: transform 240ms ease;
  }
  .lg-link:hover::after { transform: scaleX(1); transform-origin: left; }

  @media (prefers-reduced-motion: reduce) {
    .lg-stagger > *, .lg-card, .lg-blob, .lg-scanbeam, .lg-title, .lg-sheen, .lg-pulse-ring {
      animation: none !important;
    }
    .lg-stagger > * { opacity: 1 !important; }
  }
`;

const Login = ({ onSwitchToRegister, sessionId }) => {
  const { login } = useAuth();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!usernameOrEmail || !password) {
      setError('Please enter both username/email and password');
      return;
    }

    setLoading(true);
    try {
      const result = await login(usernameOrEmail, password, sessionId);
      if (!result.success) {
        setError(result.error || 'Login failed');
      }
      // On success, AuthContext updates and App.js re-renders.
    } catch (err) {
      setError('An unexpected error occurred');
      console.error('[Login] Error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-4"
      style={{ background: 'radial-gradient(140% 120% at 50% -10%, #0b1326 0%, #060912 55%, #03050b 100%)' }}
    >
      <style>{STYLES}</style>

      {/* ── Atmospheric signal field ───────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Drifting gradient-mesh glows */}
        <div
          className="lg-blob absolute -left-[12%] top-[6%] h-[42rem] w-[42rem] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(34,211,238,0.22) 0%, transparent 65%)',
            filter: 'blur(36px)', animation: 'lg-drift-a 22s ease-in-out infinite'
          }}
        />
        <div
          className="lg-blob absolute -right-[14%] top-[24%] h-[46rem] w-[46rem] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(99,102,241,0.20) 0%, transparent 65%)',
            filter: 'blur(40px)', animation: 'lg-drift-b 26s ease-in-out infinite'
          }}
        />
        <div
          className="lg-blob absolute bottom-[-18%] left-[28%] h-[40rem] w-[40rem] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(245,158,11,0.10) 0%, transparent 70%)',
            filter: 'blur(44px)', animation: 'lg-drift-c 30s ease-in-out infinite'
          }}
        />

        {/* Scanline texture */}
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage: 'repeating-linear-gradient(0deg, rgba(148,163,184,0.05) 0px, rgba(148,163,184,0.05) 1px, transparent 1px, transparent 3px)'
          }}
        />
        {/* Slow scan-sweep beam */}
        <div
          className="lg-scanbeam absolute inset-x-0 top-0 h-40"
          style={{
            background: 'linear-gradient(180deg, transparent, rgba(34,211,238,0.10) 45%, rgba(34,211,238,0.18) 50%, rgba(34,211,238,0.10) 55%, transparent)',
            animation: 'lg-scan 9s linear infinite'
          }}
        />
        {/* Vignette */}
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)' }}
        />
      </div>

      {/* ── Control card ───────────────────────────────────────── */}
      <div
        className="lg-card relative w-full max-w-md"
        style={{ animation: 'lg-card-in 560ms cubic-bezier(0.22,1,0.36,1) both' }}
      >
        <div
          className="relative overflow-hidden rounded-2xl border p-8"
          style={{
            borderColor: 'rgba(34,211,238,0.18)',
            background: 'linear-gradient(180deg, rgba(15,23,42,0.78) 0%, rgba(3,6,15,0.86) 100%)',
            backdropFilter: 'blur(18px) saturate(140%)',
            WebkitBackdropFilter: 'blur(18px) saturate(140%)',
            boxShadow: '0 1px 0 rgba(255,255,255,0.05) inset, 0 30px 80px -30px rgba(0,0,0,0.8), 0 0 0 1px rgba(148,163,184,0.06)'
          }}
        >
          {/* Top hairline accent */}
          <div
            className="absolute inset-x-0 top-0 h-px"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(34,211,238,0.7), transparent)' }}
          />

          <div className="lg-stagger">
            {/* ON AIR chip */}
            <div className="mb-6 flex items-center justify-between">
              <span
                className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1"
                style={{
                  borderColor: 'rgba(244,63,94,0.4)', background: 'rgba(244,63,94,0.10)',
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace'
                }}
              >
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inset-0 rounded-full" style={{ background: 'rgb(244,63,94)', boxShadow: '0 0 8px rgb(244,63,94)' }} />
                  <span className="lg-pulse-ring absolute inset-0 rounded-full" style={{ border: '1px solid rgb(244,63,94)', animation: 'lg-pulse 1.8s ease-out infinite' }} />
                </span>
                <span className="text-[10px] font-semibold tracking-[0.22em] text-rose-200">ON AIR</span>
              </span>
              <span
                className="text-[10px] tracking-[0.2em] text-slate-500"
                style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
              >
                CH&nbsp;01 · SIGN-IN
              </span>
            </div>

            {/* Wordmark + title */}
            <div className="mb-7">
              <div className="mb-4 flex items-center gap-3">
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-xl border"
                  style={{ borderColor: 'rgba(34,211,238,0.3)', background: 'rgba(34,211,238,0.08)' }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgb(34,211,238)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                    <polyline points="17 2 12 7 7 2"></polyline>
                  </svg>
                </span>
                <span
                  className="text-[11px] font-medium uppercase tracking-[0.28em] text-slate-400"
                  style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
                >
                  IPTV&nbsp;Guru
                </span>
              </div>
              <h1
                className="lg-title text-[2.6rem] font-extrabold leading-[1.04]"
                style={{
                  fontFamily: '"Bricolage Grotesque", system-ui, sans-serif',
                  letterSpacing: '-0.02em',
                  background: 'linear-gradient(100deg, #e2e8f0 0%, #67e8f9 45%, #a5b4fc 70%, #e2e8f0 100%)',
                  backgroundSize: '220% 100%',
                  WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
                  animation: 'lg-shimmer 7s ease-in-out infinite'
                }}
              >
                Welcome back.
              </h1>
              <p className="mt-2 text-sm text-slate-400">Power on your live-TV control room.</p>
            </div>

            {/* Error */}
            {error && (
              <div
                className="mb-5 flex items-start gap-2 rounded-xl border px-4 py-3"
                style={{ borderColor: 'rgba(244,63,94,0.4)', background: 'rgba(244,63,94,0.10)' }}
                role="alert"
              >
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M10.3 4l-7 12a2 2 0 001.7 3h14a2 2 0 001.7-3l-7-12a2 2 0 00-3.4 0z" />
                </svg>
                <p className="text-sm text-rose-200">{error}</p>
              </div>
            )}

            {/* Form (one stagger child wrapping the fields + button) */}
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Username */}
              <div>
                <label
                  htmlFor="usernameOrEmail"
                  className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400"
                  style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
                >
                  Username or Email
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </span>
                  <input
                    id="usernameOrEmail"
                    type="text"
                    value={usernameOrEmail}
                    onChange={(e) => setUsernameOrEmail(e.target.value)}
                    className="lg-input w-full rounded-xl border bg-slate-900/55 py-3 pl-10 pr-4 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                    style={{ borderColor: 'rgba(51,65,85,0.8)' }}
                    placeholder="you@channel.tv"
                    autoComplete="username"
                    disabled={loading}
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label
                  htmlFor="password"
                  className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400"
                  style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
                >
                  Password
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </span>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="lg-input w-full rounded-xl border bg-slate-900/55 py-3 pl-10 pr-11 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                    style={{ borderColor: 'rgba(51,65,85,0.8)' }}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-500 transition-colors hover:text-cyan-300"
                  >
                    {showPassword ? (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 4.2A9.6 9.6 0 0112 4c5 0 9 4 10 8a12 12 0 01-2.2 3.2M6.1 6.1A12 12 0 002 12c1 4 5 8 10 8 1.5 0 2.9-.3 4.1-.9" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8-10-8-10-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="lg-submit mt-1 w-full rounded-xl px-4 py-3.5 text-sm font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-cyan-400/70 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
                style={{ background: 'linear-gradient(100deg, #22d3ee 0%, #38bdf8 45%, #6366f1 100%)', boxShadow: '0 10px 30px -12px rgba(34,211,238,0.55)' }}
              >
                {/* sheen */}
                <span
                  className="lg-sheen pointer-events-none absolute inset-y-0 -left-1/3 w-1/3"
                  style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)' }}
                />
                <span className="relative z-10">
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-5 w-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Tuning in…
                    </span>
                  ) : (
                    'Go Live'
                  )}
                </span>
              </button>
            </form>

            {/* Footer */}
            <div className="mt-7 space-y-4 text-center">
              <p className="text-sm text-slate-400">
                New here?{' '}
                <button
                  onClick={onSwitchToRegister}
                  className="lg-link font-semibold text-cyan-300 transition-colors hover:text-cyan-200"
                  disabled={loading}
                >
                  Create an account
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
