
import React, { useEffect, useState, useRef } from 'react';
import Dropzone from 'react-dropzone';
import apiClient from './utils/apiClient';
import LoadingProgress from './LoadingProgress';
import SessionManager from './utils/sessionManager';
import { API_BASE_URL } from './config';
import { registerSession } from './services/SSEService';
import BulkAddSources from './components/BulkAddSources';

const statusStyles = {
  info: 'border-blue-500/40 bg-blue-500/15 text-blue-200',
  success: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  error: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
};

// ─── Provider-card sub-components ──────────────────────────────────
// All module-level so they don't re-create on every Configuration
// render. Self-contained state for UI affordances (paste-flash,
// eye-toggle, fallback drawer); the "real" data lives in the parent.

const ICONS = {
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <circle cx="12" cy="8" r="3.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 20c1.5-3.5 4.2-5 7-5s5.5 1.5 7 5" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <circle cx="8" cy="14" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 12L21 3m-3 0l3 3m-7 4l3 3" />
    </svg>
  ),
  portal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.93 19.07a10 10 0 010-14.14M19.07 4.93a10 10 0 010 14.14M8.46 16.46a5 5 0 010-7.07M15.54 7.54a5 5 0 010 7.07" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
  mac: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path strokeLinecap="round" d="M7 12h10M9 9v6M15 9v6" />
    </svg>
  ),
  eyeOn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  eyeOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 6.1A9.5 9.5 0 0112 6c6 0 9.5 6.5 9.5 6.5a14.7 14.7 0 01-3.4 4M6.1 6.6A14.7 14.7 0 002.5 12s3.5 7 9.5 7c1.5 0 2.9-.3 4.1-.8M9.9 9.9a3 3 0 104.2 4.2" />
    </svg>
  ),
  clipboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  )
};

// Sky for Xtream, violet for Stalker. Centralised so every part of
// the card pulls from a single source of truth.
const PROVIDER_THEMES = {
  xtream: {
    label: 'Xtream',
    spineGrad: 'from-sky-300/70 via-sky-400/20 to-transparent',
    spineSolid: 'bg-sky-300',
    spineGlow: 'rgba(56,189,248,0.55)',
    moduleTile: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    accentText: 'text-sky-300',
    accentRing: 'focus-within:border-sky-500/40 focus-within:shadow-[0_0_0_3px_rgba(56,189,248,0.08)]'
  },
  stalker: {
    label: 'Stalker',
    spineGrad: 'from-violet-300/70 via-violet-400/20 to-transparent',
    spineSolid: 'bg-violet-300',
    spineGlow: 'rgba(167,139,250,0.55)',
    moduleTile: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
    accentText: 'text-violet-300',
    accentRing: 'focus-within:border-violet-500/40 focus-within:shadow-[0_0_0_3px_rgba(167,139,250,0.08)]'
  }
};

/** Pure URL parser — returns `{ ok, host, port, protocol }` or null. */
const parseProviderUrl = (raw) => {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.match(/^https?:\/\//i) ? trimmed : `http://${trimmed}`);
    if (!u.host) return null;
    return {
      ok: true,
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      protocol: u.protocol.replace(':', '')
    };
  } catch {
    return null;
  }
};

/** Format MAC for display: strip non-hex, group into 6 colon-separated
 *  pairs, uppercased. Returns possibly-partial display while typing. */
const formatMacDisplay = (raw) => {
  const hex = (raw || '').toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12);
  const pairs = [];
  for (let i = 0; i < hex.length; i += 2) pairs.push(hex.slice(i, i + 2));
  return pairs.join(':');
};

const isValidMac = (raw) => {
  const hex = (raw || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return hex.length === 12;
};

/**
 * IconTile — 28×28 slate tile with a faint border, hosting one of
 * the ICONS svgs. Used as a label affordance to the left of each
 * input field so the form reads as a rack of modules.
 */
const IconTile = ({ icon, color = 'slate', size = 'md' }) => {
  const COLORS = {
    slate:  'border-slate-800 bg-slate-900 text-slate-400',
    sky:    'border-sky-500/30 bg-sky-500/10 text-sky-300',
    violet: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
    cyan:   'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
  };
  const SIZES = {
    sm: { box: 'w-6 h-6', svg: 'w-3 h-3' },
    md: { box: 'w-7 h-7', svg: 'w-3.5 h-3.5' },
    lg: { box: 'w-9 h-9', svg: 'w-4 h-4' }
  };
  const s = SIZES[size] || SIZES.md;
  return (
    <span className={`flex-shrink-0 ${s.box} inline-flex items-center justify-center rounded-md border ${COLORS[color] || COLORS.slate}`}>
      <span className={s.svg}>{ICONS[icon]}</span>
    </span>
  );
};

/**
 * PasteButton — small ghost button at the right of an input. Reads
 * navigator.clipboard, calls onPaste(text), flashes "Pasted" for
 * ~1.2s on success.
 */
const PasteButton = ({ onPaste, disabled }) => {
  const [flashed, setFlashed] = useState(false);
  const handle = async (e) => {
    e.preventDefault();
    if (disabled) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onPaste?.(text.trim());
        setFlashed(true);
        setTimeout(() => setFlashed(false), 1200);
      }
    } catch {
      /* user denied / unsupported */
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={disabled}
      title="Paste from clipboard"
      className={`inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[10px] font-mono uppercase tracking-[0.16em] transition ${
        flashed
          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
          : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:border-slate-700'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {flashed ? (
        <>
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Pasted
        </>
      ) : (
        <>
          <span className="w-2.5 h-2.5">{ICONS.clipboard}</span>
          Paste
        </>
      )}
    </button>
  );
};

/**
 * EyeToggle — sits absolutely inside the password input's right
 * edge. Slate when masked, cyan-tinted when revealed.
 */
const EyeToggle = ({ visible, onToggle, disabled }) => (
  <button
    type="button"
    tabIndex={-1}
    onClick={(e) => { e.preventDefault(); onToggle(); }}
    disabled={disabled}
    title={visible ? 'Hide password' : 'Show password'}
    className={`absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-6 h-6 rounded transition ${
      visible
        ? 'text-cyan-300 hover:bg-cyan-500/10'
        : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
    } disabled:opacity-40 disabled:cursor-not-allowed`}
  >
    <span className="w-3.5 h-3.5">{visible ? ICONS.eyeOn : ICONS.eyeOff}</span>
  </button>
);

/**
 * ProviderCard — the credential-form wrapper. Colored spine on the
 * top edge + LED, mono caps section header, optional "RESTORED"
 * status chip on the right when fields are pre-filled.
 */
const ProviderCard = ({ kind, restored, onClearRestored, children }) => {
  const theme = PROVIDER_THEMES[kind] || PROVIDER_THEMES.xtream;
  return (
    <div className="relative rounded-xl border border-slate-800/80 bg-slate-950 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_8px_24px_-12px_rgba(0,0,0,0.6)]">
      {/* Top-edge identity spine */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${theme.spineGrad}`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute left-4 top-0 h-px w-6 ${theme.spineSolid}`}
        style={{ boxShadow: `0 0 8px ${theme.spineGlow}` }}
      />

      {/* Header — module marker + restored chip */}
      <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b border-slate-800/60">
        <div className="flex items-center gap-2.5">
          <IconTile icon={kind === 'stalker' ? 'portal' : 'globe'} color={kind === 'stalker' ? 'violet' : 'sky'} />
          <div className="leading-tight">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-slate-500">
              Provider Credentials
            </div>
            <div className={`mt-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] ${theme.accentText}`}>
              {theme.label}
            </div>
          </div>
        </div>
        {restored && (
          <button
            type="button"
            onClick={onClearRestored}
            title="Clear the saved credentials"
            className="group inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-cyan-500/30 bg-cyan-500/[0.06] text-cyan-200 hover:bg-cyan-500/10 hover:border-cyan-500/40 transition"
          >
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300" />
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em]">
              Restored
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-400/60 group-hover:text-cyan-300 transition">
              · Clear
            </span>
          </button>
        )}
      </header>

      {/* Body */}
      <div className="p-4 space-y-3">{children}</div>

      {/* Footer note */}
      <div className="px-4 py-2 border-t border-slate-800/60 bg-slate-900/30">
        <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-2.5 h-2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c0 3.5-2.5 6.5-6 7.5C2.5 17.5 0 14.5 0 11V5l6-2 6 2v6z" transform="translate(6, 0)" />
          </svg>
          Credentials persist locally in this browser only
        </div>
      </div>
    </div>
  );
};

/**
 * FieldRow — icon tile + label + input + (optional) right adornment +
 * inline validation row. The pattern every credentials field uses.
 */
const FieldRow = ({
  icon,
  iconColor = 'slate',
  label,
  hint,
  validationOk,
  validationMessage,
  validationTone = 'emerald',
  rightAdornment,
  inputRef,
  className = '',
  inputClassName = '',
  ...inputProps
}) => {
  const showValidation = validationMessage != null;
  const validTone = {
    emerald: { text: 'text-emerald-300', dot: 'bg-emerald-400' },
    rose:    { text: 'text-rose-300',    dot: 'bg-rose-400' },
    slate:   { text: 'text-slate-500',   dot: 'bg-slate-500' }
  }[validationTone] || { text: 'text-slate-500', dot: 'bg-slate-500' };

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex items-center gap-2.5">
        <IconTile icon={icon} color={iconColor} />
        <div className="min-w-0 flex-1">
          <label className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-slate-500 block">
            {label}
          </label>
          <div className="relative mt-0.5 flex items-center gap-2">
            <div className={`relative flex-1 rounded-md border border-slate-800 bg-slate-900/70 transition focus-within:border-cyan-500/40 focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.06)] ${inputClassName}`}>
              <input
                ref={inputRef}
                {...inputProps}
                className="w-full bg-transparent px-3 py-2 pr-8 font-mono text-[12.5px] text-slate-100 placeholder:text-slate-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
              {/* Right adornment INSIDE the input (eye toggle, etc.) */}
              {rightAdornment && (
                <div className="absolute inset-y-0 right-0 flex items-center pr-1">
                  {rightAdornment}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Validation / hint row — always reserves space when shown so
          the form doesn't jump as the user types. */}
      {(showValidation || hint) && (
        <div className="pl-[2.375rem] flex items-center gap-1.5 min-h-[14px]">
          {showValidation ? (
            <>
              <span className={`inline-flex h-1.5 w-1.5 rounded-full ${validTone.dot}`} />
              <span className={`font-mono text-[10px] tabular-nums ${validTone.text}`}>
                {validationMessage}
              </span>
            </>
          ) : (
            <span className="font-mono text-[10px] text-slate-600 truncate">{hint}</span>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * M3UFallback — collapsible footer band. At rest it's a thin slate
 * strip with a "+ Add an M3U fallback" toggle; expanded it shows
 * the URL field + the dropzone in a compact card. M3U is the
 * SECONDARY path on the Xtream tab; demoting it visually reflects
 * that priority.
 */
const M3UFallback = ({ m3uUrl, setM3uUrl, m3uFile, setM3uFile, disabled, Dropzone, hasContent }) => {
  // Auto-open if the user has previously entered an M3U URL or
  // picked a file (so a returning user doesn't have to re-discover
  // the drawer to see what's stored).
  const [open, setOpen] = useState(hasContent);
  return (
    <div className="rounded-md border border-slate-800/80 bg-slate-900/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-900/70 transition text-left"
      >
        <svg
          className={`flex-shrink-0 w-3 h-3 text-slate-500 transition ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
          M3U Fallback
        </span>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-slate-600">
          {hasContent ? '· configured' : '· optional — use a playlist URL or file instead'}
        </span>
        {hasContent && (
          <span className="ml-auto inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-800/60 space-y-2 mv-anim-palette-in">
          <div className="flex items-center gap-2">
            <IconTile icon="globe" color="slate" size="sm" />
            <input
              type="text"
              placeholder="https://example.com/playlist.m3u"
              value={m3uUrl}
              onChange={(e) => setM3uUrl(e.target.value)}
              disabled={disabled}
              className="flex-1 rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 font-mono text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-cyan-500/40 focus:outline-none disabled:opacity-50"
            />
          </div>
          <Dropzone onDrop={(acceptedFiles) => setM3uFile(acceptedFiles[0])} disabled={disabled}>
            {({ getRootProps, getInputProps }) => {
              const cls = [
                'flex items-center gap-2.5 px-3 py-2 rounded-md border border-dashed transition',
                disabled
                  ? 'border-slate-800 bg-slate-900/40 cursor-not-allowed opacity-50'
                  : 'border-slate-700 bg-slate-900/40 hover:border-cyan-500/40 hover:bg-slate-900/60 cursor-pointer'
              ].join(' ');
              return (
                <div {...getRootProps({ className: cls })}>
                  <input {...getInputProps()} />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-3.5 h-3.5 text-slate-500 flex-shrink-0">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.9 5 5 0 019.55-1.65A4.5 4.5 0 0118 16M12 11v6m0-6l-3 3m3-3l3 3" />
                  </svg>
                  {m3uFile ? (
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-300">Loaded</span>
                      <span className="font-mono text-[11px] text-slate-300 truncate">{m3uFile.name}</span>
                      <span className="font-mono text-[9.5px] text-slate-600">· click to replace</span>
                    </div>
                  ) : (
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-slate-500">
                      Drop M3U file here or click to browse
                    </span>
                  )}
                </div>
              );
            }}
          </Dropzone>
        </div>
      )}
    </div>
  );
};

/**
 * PrimaryLoadButton — the GO button at the footer. Emerald with
 * inner glow when enabled; flat slate outline when disabled.
 * Matches the Parse button in BulkAddSources visually so the app's
 * primary-action vocabulary stays consistent.
 */
const PrimaryLoadButton = ({ label, onClick, disabled, loading }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled || loading}
    className={`inline-flex items-center gap-2 h-10 px-5 rounded-md border transition ${
      loading
        ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200 cursor-wait'
        : disabled
          ? 'border-slate-800 bg-slate-900/40 text-slate-700 cursor-not-allowed'
          : 'border-emerald-500/50 bg-emerald-500/[0.12] text-emerald-100 hover:bg-emerald-500/20 hover:border-emerald-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_18px_-4px_rgba(16,185,129,0.5)]'
    }`}
  >
    {loading ? (
      <>
        <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">Loading…</span>
      </>
    ) : (
      <>
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">{label}</span>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
      </>
    )}
  </button>
);

/**
 * XtreamPanel — the Xtream Login tab body. A single Provider Card
 * holds the credential trio (Server URL · Username · Password) with
 * icon-tile labels, inline URL validation, and a paste/eye toggle
 * pair on the relevant fields. Below the card, the M3U fallback
 * lives in a collapsible single-row drawer so the primary path
 * (credentials → Load) gets visual priority.
 */
const XtreamPanel = ({
  xtreamServer, xtreamUsername, xtreamPassword,
  setXtreamServer, setXtreamUsername, setXtreamPassword,
  m3uUrl, setM3uUrl, m3uFile, setM3uFile,
  isLoading, onLoad, Dropzone
}) => {
  // Detect "restored from localStorage" — we infer it from the
  // initial mount state: if any field is pre-filled when the panel
  // first renders, the user is returning. The chip is dismissible
  // and never reappears until next mount.
  const initialFilledRef = useRef(
    Boolean((xtreamServer || '').trim() || (xtreamUsername || '').trim() || (xtreamPassword || '').trim())
  );
  const [restored, setRestored] = useState(initialFilledRef.current);
  const [passwordVisible, setPasswordVisible] = useState(false);

  const clearRestored = () => {
    setXtreamServer(''); setXtreamUsername(''); setXtreamPassword('');
    setRestored(false);
  };

  // URL validation — show a parsed host:port preview when valid, a
  // rose hint when content is present but malformed.
  const urlParsed = parseProviderUrl(xtreamServer);
  const urlInvalid = xtreamServer.trim().length > 0 && !urlParsed;

  const canLoad = Boolean(
    !isLoading
    && xtreamServer.trim()
    && xtreamUsername.trim()
    && xtreamPassword
  );

  return (
    <div className="mt-6 space-y-4">
      <ProviderCard
        kind="xtream"
        restored={restored}
        onClearRestored={clearRestored}
      >
        {/* Server URL */}
        <FieldRow
          icon="globe"
          iconColor="sky"
          label="Server URL"
          type="text"
          placeholder="http://example.com:8080"
          value={xtreamServer}
          onChange={(e) => setXtreamServer(e.target.value)}
          disabled={isLoading}
          spellCheck={false}
          autoComplete="off"
          validationMessage={
            urlParsed ? `${urlParsed.host}:${urlParsed.port} · ${urlParsed.protocol}`
            : urlInvalid ? 'Looks malformed — expected http://host:port'
            : null
          }
          validationTone={urlParsed ? 'emerald' : urlInvalid ? 'rose' : 'slate'}
          hint="Paste the URL your provider gave you. Port defaults to 80/443."
        />
        {/* Paste affordance is rendered as a sibling row beneath since
            embedding inside the input would crowd the validation. */}
        <div className="pl-[2.375rem] -mt-0.5 flex justify-end">
          <PasteButton
            disabled={isLoading}
            onPaste={(text) => {
              // Try to auto-extract URL + credentials when the user
              // pastes an M3U-style URL like
              //   http://host/get.php?username=X&password=Y&type=...
              // — saves them from manually splitting it.
              const trimmed = text.trim();
              try {
                const u = new URL(trimmed);
                const user = u.searchParams.get('username');
                const pass = u.searchParams.get('password');
                if (user || pass) {
                  setXtreamServer(`${u.protocol}//${u.host}`);
                  if (user) setXtreamUsername(user);
                  if (pass) setXtreamPassword(pass);
                  return;
                }
              } catch { /* not a URL with auth — just fall through */ }
              setXtreamServer(trimmed);
            }}
          />
        </div>

        {/* Username */}
        <FieldRow
          icon="user"
          iconColor="slate"
          label="Username"
          type="text"
          placeholder="Your Xtream username"
          value={xtreamUsername}
          onChange={(e) => setXtreamUsername(e.target.value)}
          disabled={isLoading}
          autoComplete="username"
          hint=""
        />

        {/* Password */}
        <FieldRow
          icon="key"
          iconColor="slate"
          label="Password"
          type={passwordVisible ? 'text' : 'password'}
          placeholder="Your Xtream password"
          value={xtreamPassword}
          onChange={(e) => setXtreamPassword(e.target.value)}
          disabled={isLoading}
          autoComplete="current-password"
          rightAdornment={
            <EyeToggle
              visible={passwordVisible}
              onToggle={() => setPasswordVisible((v) => !v)}
              disabled={isLoading}
            />
          }
          hint=""
        />
      </ProviderCard>

      {/* M3U fallback — collapsed drawer at the bottom of the panel.
          The Xtream tab's primary affordance is the credentials
          above; M3U is the alternative path. */}
      <M3UFallback
        m3uUrl={m3uUrl}
        setM3uUrl={setM3uUrl}
        m3uFile={m3uFile}
        setM3uFile={setM3uFile}
        disabled={isLoading}
        Dropzone={Dropzone}
        hasContent={Boolean((m3uUrl || '').trim() || m3uFile)}
      />

      {/* Footer action band — Test connection (placeholder) on the
          left, primary Load button on the right. */}
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/60">
        <button
          type="button"
          disabled
          title="Coming soon — quick credentials check without a full load"
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-slate-800 bg-slate-900/40 text-slate-600 cursor-not-allowed"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
            Test connection · soon
          </span>
        </button>

        <PrimaryLoadButton
          label="Load Xtream Channels"
          loading={isLoading}
          disabled={!canLoad}
          onClick={onLoad}
        />
      </div>
    </div>
  );
};

/**
 * StalkerPanel — twin of XtreamPanel for the MAG/Stalker tab. Same
 * Provider Card chrome with a violet spine + LED. The MAC field
 * normalises display (uppercase + colons every 2 chars) and shows
 * a green LED once the value resolves to 6 hex octets.
 */
const StalkerPanel = ({
  stalkerPortalUrl, stalkerMacAddress,
  setStalkerPortalUrl, setStalkerMacAddress,
  isLoading, onLoad
}) => {
  const initialFilledRef = useRef(
    Boolean((stalkerPortalUrl || '').trim() || (stalkerMacAddress || '').trim())
  );
  const [restored, setRestored] = useState(initialFilledRef.current);

  const clearRestored = () => {
    setStalkerPortalUrl(''); setStalkerMacAddress('');
    setRestored(false);
  };

  const urlParsed = parseProviderUrl(stalkerPortalUrl);
  const urlInvalid = stalkerPortalUrl.trim().length > 0 && !urlParsed;
  const macDisplay = formatMacDisplay(stalkerMacAddress);
  const macValid = isValidMac(stalkerMacAddress);
  const macHasContent = stalkerMacAddress.trim().length > 0;

  const canLoad = Boolean(!isLoading && stalkerPortalUrl.trim() && macValid);

  return (
    <div className="mt-6 space-y-4">
      <ProviderCard
        kind="stalker"
        restored={restored}
        onClearRestored={clearRestored}
      >
        {/* Portal URL */}
        <FieldRow
          icon="portal"
          iconColor="violet"
          label="Portal URL"
          type="text"
          placeholder="http://portal.url/stalker_portal/"
          value={stalkerPortalUrl}
          onChange={(e) => setStalkerPortalUrl(e.target.value)}
          disabled={isLoading}
          spellCheck={false}
          autoComplete="off"
          validationMessage={
            urlParsed ? `${urlParsed.host}:${urlParsed.port} · ${urlParsed.protocol}`
            : urlInvalid ? 'Looks malformed — expected http://host:port/'
            : null
          }
          validationTone={urlParsed ? 'emerald' : urlInvalid ? 'rose' : 'slate'}
          hint="The portal endpoint your MAG box would normally connect to."
        />

        {/* MAC Address */}
        <FieldRow
          icon="mac"
          iconColor="violet"
          label="MAC Address"
          type="text"
          placeholder="00:1A:79:XX:XX:XX"
          value={macDisplay}
          onChange={(e) => setStalkerMacAddress(e.target.value)}
          disabled={isLoading}
          spellCheck={false}
          autoComplete="off"
          maxLength={17}
          validationMessage={
            macValid ? 'Valid MAC · 6 octets'
            : macHasContent ? `Incomplete · ${macDisplay.replace(/:/g, '').length}/12 hex chars`
            : null
          }
          validationTone={macValid ? 'emerald' : macHasContent ? 'rose' : 'slate'}
          hint="Paste any format — we'll normalise to UPPER:CASE:WITH:COLONS."
        />
      </ProviderCard>

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/60">
        <button
          type="button"
          disabled
          title="Coming soon — quick portal handshake test"
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-slate-800 bg-slate-900/40 text-slate-600 cursor-not-allowed"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
            Test connection · soon
          </span>
        </button>

        <PrimaryLoadButton
          label="Load MAG/Stalker Channels"
          loading={isLoading}
          disabled={!canLoad}
          onClick={onLoad}
        />
      </div>
    </div>
  );
};

const Configuration = ({
  onLoad,
  error,
  allowedTabs = ['xtream', 'epg'],
  initialTab,
  heading,
  description,
  showFooter = true,
  showSummaryButton = true,
  onLoadingChange, // Callback when loading state changes: (isLoading, sessionId, status, variant)
  onSourceCompleted, // Callback fired when a bulk-added source finishes loading (sessionId)
  embedded = false, // When true, strips the outer card wrapper, heading block, and footer —
                    // used when Configuration is rendered inside a parent modal that has its own chrome.
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [m3uFile, setM3uFile] = useState(null);
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState('info');
  const [processingSessionId, setProcessingSessionId] = useState(null);

  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamServer, setXtreamServer] = useState('');

  const [stalkerPortalUrl, setStalkerPortalUrl] = useState('');
  const [stalkerMacAddress, setStalkerMacAddress] = useState('');

  const normalizedTabs = Array.isArray(allowedTabs) && allowedTabs.length ? allowedTabs : ['xtream', 'stalker', 'epg'];
  const allowedTabKey = normalizedTabs.join('|');
  const [activeTab, setActiveTab] = useState(() => {
    if (initialTab && normalizedTabs.includes(initialTab)) {
      return initialTab;
    }
    return normalizedTabs[0] || 'xtream';
  });

  const isEpgAllowed = normalizedTabs.includes('epg');
  const isXtreamAllowed = normalizedTabs.includes('xtream');
  const isStalkerAllowed = normalizedTabs.includes('stalker');
  const isBulkAllowed = normalizedTabs.includes('bulk');
  const isEpgOnly = isEpgAllowed && !isXtreamAllowed && !isStalkerAllowed && !isBulkAllowed;

  useEffect(() => {
    const preferredTab = initialTab && normalizedTabs.includes(initialTab)
      ? initialTab
      : normalizedTabs[0] || 'xtream';

    setActiveTab((prev) => {
      if (prev && normalizedTabs.includes(prev)) {
        return prev;
      }
      return preferredTab;
    });
  }, [allowedTabKey, initialTab, normalizedTabs]);

  useEffect(() => {
    let storedUsername = localStorage.getItem('xtreamUsername');
    let storedPassword = localStorage.getItem('xtreamPassword');
    let storedServer = localStorage.getItem('xtreamServer');

    if (!storedUsername && !storedPassword && !storedServer) {
      try {
        const oldCredentials = JSON.parse(localStorage.getItem('xtreamCredentials') || '{}');
        if (oldCredentials.server || oldCredentials.username || oldCredentials.password) {
          storedUsername = oldCredentials.username || '';
          storedPassword = oldCredentials.password || '';
          storedServer = oldCredentials.server || '';

          localStorage.setItem('xtreamUsername', storedUsername);
          localStorage.setItem('xtreamPassword', storedPassword);
          localStorage.setItem('xtreamServer', storedServer);
          localStorage.removeItem('xtreamCredentials');
        }
      } catch (migrationError) {
        console.error('Error parsing old credentials format:', migrationError);
      }
    }

    if (storedUsername) setXtreamUsername(storedUsername);
    if (storedPassword) setXtreamPassword(storedPassword);
    if (storedServer) setXtreamServer(storedServer);

    // Load Stalker credentials
    const storedPortalUrl = localStorage.getItem('stalkerPortalUrl');
    const storedMacAddress = localStorage.getItem('stalkerMacAddress');
    if (storedPortalUrl) setStalkerPortalUrl(storedPortalUrl);
    if (storedMacAddress) setStalkerMacAddress(storedMacAddress);
  }, []);

  // Track previous loading state to avoid infinite loops
  const prevLoadingState = useRef({ isLoading: false, processingSessionId: null, status: '', statusVariant: 'info' });

  // Notify parent component when loading state changes
  useEffect(() => {
    const prev = prevLoadingState.current;
    const hasChanged =
      prev.isLoading !== isLoading ||
      prev.processingSessionId !== processingSessionId ||
      prev.status !== status ||
      prev.statusVariant !== statusVariant;

    if (hasChanged && onLoadingChange) {
      onLoadingChange(isLoading, processingSessionId, status, statusVariant);
      prevLoadingState.current = { isLoading, processingSessionId, status, statusVariant };
    }
  }, [isLoading, processingSessionId, status, statusVariant, onLoadingChange]);

  const saveCredentials = () => {
    try {
      localStorage.setItem('xtreamUsername', xtreamUsername);
      localStorage.setItem('xtreamPassword', xtreamPassword);
      localStorage.setItem('xtreamServer', xtreamServer);
    } catch (storageError) {
      console.error('Error saving credentials:', storageError);
    }
  };

  const saveStalkerCredentials = () => {
    try {
      localStorage.setItem('stalkerPortalUrl', stalkerPortalUrl);
      localStorage.setItem('stalkerMacAddress', stalkerMacAddress);
    } catch (storageError) {
      console.error('Error saving Stalker credentials:', storageError);
    }
  };

  const setStatusMessage = (message, variant = 'info') => {
    setStatus(message);
    setStatusVariant(variant);
  };

  const submitLoadRequest = async ({ startMessage, successMessage, prepareFormData }) => {
    try {
      setStatusMessage(startMessage || 'Initializing...', 'info');
      setIsLoading(true);

      const sessionId = await SessionManager.init();
      if (!sessionId) {
        throw new Error('Failed to create or validate session');
      }

      setProcessingSessionId(sessionId);

      try {
        await registerSession(sessionId);
      } catch (registrationError) {
        console.warn('Failed to register session before load:', registrationError);
      }

      const formData = new FormData();
      formData.append('sessionId', sessionId);

      if (typeof prepareFormData === 'function') {
        prepareFormData(formData);
      }

      const response = await apiClient.post('/load', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      if (response.data?.success) {
        setStatusMessage(successMessage || 'Processing started on server', 'success');
      } else {
        throw new Error(response.data?.error || 'Unknown error');
      }
    } catch (loadError) {
      console.error('Error loading data:', loadError);
      setIsLoading(false);
      setProcessingSessionId(null);
      setStatusMessage(`Error: ${loadError.response?.data?.error || loadError.message}`, 'error');
    }
  };

  const handleXtreamLoad = async () => {
    const hasXtreamCredentials = Boolean(xtreamServer && xtreamUsername && xtreamPassword);
    const hasPlaylist = Boolean(m3uUrl || m3uFile);

    if (!hasXtreamCredentials && !hasPlaylist) {
      setStatusMessage('Provide Xtream credentials or an M3U source to continue.', 'error');
      return;
    }

    if (hasXtreamCredentials) {
      saveCredentials();
    }

    await submitLoadRequest({
      startMessage: hasXtreamCredentials ? 'Connecting to Xtream server...' : 'Uploading playlist...',
      successMessage: 'Channels are loading. Sit tight!',
      prepareFormData: (formData) => {
        if (hasXtreamCredentials) {
          formData.append('xtreamUsername', xtreamUsername);
          formData.append('xtreamPassword', xtreamPassword);
          formData.append('xtreamServer', xtreamServer);
        }

        if (m3uUrl) {
          formData.append('m3uUrl', m3uUrl.trim());
        }

        if (m3uFile) {
          formData.append('m3uFile', m3uFile);
        }
      },
    });
  };

  const handleStalkerLoad = async () => {
    if (!stalkerPortalUrl || !stalkerMacAddress) {
      setStatusMessage('Provide both Portal URL and MAC address to continue.', 'error');
      return;
    }

    saveStalkerCredentials();

    await submitLoadRequest({
      startMessage: 'Connecting to MAG/Stalker portal...',
      successMessage: 'Channels are loading from Stalker portal!',
      prepareFormData: (formData) => {
        formData.append('portalUrl', stalkerPortalUrl.trim());
        formData.append('macAddress', stalkerMacAddress.trim());
      },
    });
  };

  const handleEpgLoad = async () => {
    if (!epgUrl) {
      setStatusMessage('Enter an EPG URL before loading.', 'error');
      return;
    }

    try {
      setStatusMessage('Adding EPG source...', 'info');
      setIsLoading(true);

      // Extract name from URL or use a default
      let name = 'Custom EPG Source';
      try {
        const urlObj = new URL(epgUrl.trim());
        const pathParts = urlObj.pathname.split('/');
        const filename = pathParts[pathParts.length - 1];
        if (filename) {
          name = filename.replace(/\.(xml|gz)$/gi, '');
        }
      } catch (urlError) {
        console.warn('Could not parse URL for name:', urlError);
      }

      const response = await apiClient.post('/user-epg-sources', {
        url: epgUrl.trim(),
        name,
        enabled: true,
        verified: false,
        notes: 'Added via web interface'
      });

      if (response.data.success) {
        setStatusMessage('EPG source added successfully!', 'success');
        setEpgUrl(''); // Clear the input

        // Force refresh by dispatching event with timestamp to bust cache
        window.dispatchEvent(new CustomEvent('epgSourcesUpdated', {
          detail: { timestamp: Date.now() }
        }));

        // Also call the parent's onLoadingChange callback to force a re-render
        if (onLoadingChange) {
          onLoadingChange(false, null, 'EPG source added', 'success');
        }
      } else {
        setStatusMessage(response.data.error || 'Failed to add EPG source', 'error');
      }
    } catch (error) {
      console.error('Error adding EPG source:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Failed to add EPG source';

      // If it already exists, show a friendlier message and refresh the list
      if (error.response?.status === 409) {
        setStatusMessage('This EPG source already exists in your list.', 'info');
        // Trigger EPG sources update event to show it
        window.dispatchEvent(new CustomEvent('epgSourcesUpdated'));
      } else {
        setStatusMessage(errorMessage, 'error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleProcessComplete = (data) => {
    setIsLoading(false);
    setProcessingSessionId(null);
    setStatusMessage('Processing complete', 'success');
    if (onLoad) {
      onLoad(data);
    }
  };

  const handleChannelsAvailable = (data) => {
    const channelCount = data?.channelCount || 0;
    setStatusMessage(`${channelCount} channels loaded`, 'success');
    if (onLoad) {
      onLoad(data);
    }
  };

  const handleEpgSourceAvailable = (data) => {
    setStatusMessage(`EPG source loaded: ${data?.url || 'Unknown source'}`, 'info');
  };

  const loadEpgSummary = async () => {
    try {
      setStatusMessage('Loading EPG summary...', 'info');
      const response = await axios.get(`${API_BASE_URL}/api/epg-summary`);
      if (onLoad) {
        onLoad(response.data);
      }
      setStatusMessage('EPG summary loaded', 'success');
    } catch (summaryError) {
      console.error('Error loading EPG summary:', summaryError);
      setStatusMessage(`Error loading EPG summary: ${summaryError.message}`, 'error');
    }
  };

  const effectiveHeading = heading || (isEpgOnly ? 'Load EPG Sources' : 'Configuration');
  const effectiveDescription = description || (isEpgOnly
    ? 'Load or refresh guide data without touching your channel list.'
    : 'Load channels with your Xtream credentials or playlist, then handle guide data in its own space.');

  const tabButtonClasses = (tab) => {
    const isActive = activeTab === tab;
    return [
      'flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-150',
      'focus:outline-none focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-2 focus:ring-offset-slate-950',
      isActive
        ? 'bg-blue-500/20 text-blue-100 shadow-inner ring-1 ring-inset ring-blue-400/60'
        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70',
      isLoading && !isActive ? 'cursor-not-allowed opacity-60' : '',
    ].join(' ');
  };

  const inputClasses = 'w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60';

  if (isLoading && processingSessionId) {
    return (
      <LoadingProgress
        sessionId={processingSessionId}
        onComplete={handleProcessComplete}
        onChannelsAvailable={handleChannelsAvailable}
        onEpgSourceAvailable={handleEpgSourceAvailable}
        onCancel={() => {
          // Reset loading state so user can fix their input
          setIsLoading(false);
          setProcessingSessionId(null);
          setStatus('');
        }}
      />
    );
  }

  const guidanceSteps = isEpgOnly
    ? [
        'Paste a new XMLTV or gzipped URL.',
        'Load the source to fetch the latest guide data.',
        'Use the summary panel to confirm imported sources.',
        'Return to Channels or Player to match listings.',
      ]
    : [
        'Enter Xtream/Stalker credentials or point to an M3U playlist.',
        'Load channels and let the progress screen finish.',
        'Open the EPG tab to add or refresh guide data.',
        'Match channels with guide entries and export what you need.',
      ];

  const outerWrapperClass = embedded
    ? 'text-slate-100'
    : 'mx-auto max-w-6xl px-4 py-12 text-slate-100';
  const panelWrapperClass = embedded
    ? ''
    : 'rounded-3xl border border-slate-800/70 bg-slate-950/70 p-8 shadow-2xl shadow-slate-950/40';

  return (
    <div className={outerWrapperClass}>
      {error && (
        <div className="mb-6 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm font-medium text-rose-200">
          <span className="font-semibold text-rose-100">Error:</span> {error}
        </div>
      )}

      <div className={panelWrapperClass}>
        {!embedded && (
          <header className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-blue-400/70">Configuration</p>
            <h2 className="text-3xl font-semibold text-slate-100">{effectiveHeading}</h2>
            <p className="max-w-2xl text-sm text-slate-400">{effectiveDescription}</p>
          </header>
        )}

        {status && (
          <div className={`${embedded ? '' : 'mt-6'} rounded-2xl border px-4 py-3 text-sm font-medium ${statusStyles[statusVariant] || statusStyles.info}`}>
            {status}
          </div>
        )}

        {normalizedTabs.length > 1 && (
          <div className={`${embedded ? 'mt-2' : 'mt-8'} flex items-center gap-2 border-b border-slate-800/70 pb-2`}>

            {isXtreamAllowed && (
              <button
                type="button"
                className={tabButtonClasses('xtream')}
                onClick={() => setActiveTab('xtream')}
                disabled={isLoading && activeTab !== 'xtream'}
              >
                Xtream Login
              </button>
            )}
            {isStalkerAllowed && (
              <button
                type="button"
                className={tabButtonClasses('stalker')}
                onClick={() => setActiveTab('stalker')}
                disabled={isLoading && activeTab !== 'stalker'}
              >
                MAG/Stalker
              </button>
            )}
            {isBulkAllowed && (
              <button
                type="button"
                className={tabButtonClasses('bulk')}
                onClick={() => setActiveTab('bulk')}
                disabled={isLoading && activeTab !== 'bulk'}
              >
                Bulk Add
              </button>
            )}
            {isEpgAllowed && (
              <button
                type="button"
                className={tabButtonClasses('epg')}
                onClick={() => setActiveTab('epg')}
                disabled={isLoading && activeTab !== 'epg'}
              >
                EPG Sources
              </button>
            )}
          </div>
        )}

        {isXtreamAllowed && activeTab === 'xtream' && (
          <XtreamPanel
            xtreamServer={xtreamServer}
            xtreamUsername={xtreamUsername}
            xtreamPassword={xtreamPassword}
            setXtreamServer={setXtreamServer}
            setXtreamUsername={setXtreamUsername}
            setXtreamPassword={setXtreamPassword}
            m3uUrl={m3uUrl}
            setM3uUrl={setM3uUrl}
            m3uFile={m3uFile}
            setM3uFile={setM3uFile}
            isLoading={isLoading}
            onLoad={handleXtreamLoad}
            Dropzone={Dropzone}
          />
        )}

        {isStalkerAllowed && activeTab === 'stalker' && (
          <StalkerPanel
            stalkerPortalUrl={stalkerPortalUrl}
            stalkerMacAddress={stalkerMacAddress}
            setStalkerPortalUrl={setStalkerPortalUrl}
            setStalkerMacAddress={setStalkerMacAddress}
            isLoading={isLoading}
            onLoad={handleStalkerLoad}
          />
        )}

        {isBulkAllowed && activeTab === 'bulk' && (
          <BulkAddSources
            onSourceCompleted={(sessionId) => {
              if (onSourceCompleted) onSourceCompleted(sessionId);
            }}
            onAllDone={({ done, failed, total }) => {
              const message = failed
                ? `${done} of ${total} sources loaded (${failed} failed).`
                : `Loaded ${done} source${done === 1 ? '' : 's'}.`;
              setStatusMessage(message, failed ? 'info' : 'success');
              if (onLoad) {
                onLoad({ bulk: true, done, failed, total });
              }
            }}
            onBulkProgressChange={(progress) => {
              if (!onLoadingChange) return;
              // Bridge bulk-add state into the parent's background-loadings
              // tracker via a synthetic 'bulk-add' sessionId. The parent
              // keeps the modal mounted while the entry is present, so
              // closing the modal during a bulk-add just minimizes it
              // (the floating loading bubble re-opens to the bulk-add tab).
              if (progress.isActive) {
                const status =
                  `${progress.done} done · ${progress.loading} loading · ` +
                  `${progress.queued} queued / ${progress.total} total`;
                onLoadingChange(true, 'bulk-add', status, 'info');
              } else {
                // Bulk-add finished (or hasn't started); remove the entry so
                // the modal can fully close when the user dismisses it.
                onLoadingChange(false, 'bulk-add', null, null);
              }
            }}
          />
        )}

        {isEpgAllowed && activeTab === 'epg' && (
          <div className="mt-8 space-y-8">
            <section className="space-y-3">
              <h3 className="text-lg font-semibold text-slate-100">EPG Source</h3>
              <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-slate-200">EPG URL</span>
                <input
                  type="text"
                  placeholder="https://example.com/guide.xml or .gz"
                  value={epgUrl}
                  onChange={(e) => setEpgUrl(e.target.value)}
                  disabled={isLoading}
                  className={inputClasses}
                />
                <p className="text-xs text-slate-400">
                  Use a direct XMLTV or gzipped URL. You can refresh it any time without reloading channels.
                </p>
              </label>
            </section>

            <div className="flex justify-end">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 via-blue-500 to-blue-700 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleEpgLoad}
                disabled={isLoading}
              >
                {isLoading ? 'Processing…' : 'Load EPG Sources'}
              </button>
            </div>
          </div>
        )}

        {!embedded && showFooter && (
          <footer className="mt-10 flex flex-col gap-6 lg:flex-row">
            <div className="flex-1 rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 shadow-inner shadow-slate-950/30">
              <h3 className="text-lg font-semibold text-slate-100">Getting Started</h3>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm text-slate-400">
                {guidanceSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            {isEpgAllowed && showSummaryButton && (
              <button
                type="button"
                onClick={loadEpgSummary}
                disabled={isLoading}
                className="self-start rounded-2xl bg-gradient-to-r from-amber-500 via-amber-600 to-orange-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-amber-900/30 transition-all hover:shadow-xl hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                EPG Summary
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
};

export default Configuration;
