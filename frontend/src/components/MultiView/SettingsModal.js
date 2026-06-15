import React, { useCallback, useEffect, useRef, useState } from 'react';
import LocationSelector from '../LocationSelector';

// ─── Static option metadata ────────────────────────────────────────────

const QUALITY_TIERS = [
  { value: 0,    label: 'Any',    sub: '—'   },
  { value: 480,  label: '480p',   sub: 'SD'  },
  { value: 720,  label: '720p',   sub: 'HD'  },
  { value: 1080, label: '1080p',  sub: 'FHD' },
  { value: 1440, label: '1440p',  sub: '2K'  },
  { value: 2160, label: '2160p',  sub: '4K'  },
  { value: 4320, label: '4320p',  sub: '8K'  }
];

const PLAYER_OPTIONS = [
  {
    value: 'mpegts-player',
    title: 'mpegts.js',
    subtitle: 'Raw TS · MSE',
    description:
      'Direct MPEG-TS over MSE. Lowest latency and the fastest channel switch in the grid.',
    tags: ['Low latency', 'Direct TS', 'Default']
  },
  {
    value: 'hls-stream',
    title: 'hls.js',
    subtitle: 'ffmpeg → HLS · hls.js',
    description:
      'Backend remuxes upstream into a live HLS playlist; hls.js plays it. Self-recovering, native on iOS Safari.',
    tags: ['iOS native', 'Auto-recover', '+~2s buffer']
  }
];

const SECTIONS = [
  { id: 'autofill', label: 'Auto-fill',   mark: '01' },
  { id: 'playback', label: 'Playback',    mark: '02' },
  { id: 'display',  label: 'Display',     mark: '03' },
  { id: 'location', label: 'Location',    mark: '04' }
];

// ─── Small, presentation-only sub-components ───────────────────────────

const SectionHeader = ({ mark, title, subtitle }) => (
  <div className="flex items-end gap-4 pb-3 border-b border-slate-800/60">
    <span className="text-[10px] font-mono text-slate-700 tabular-nums">§ {mark}</span>
    <div className="flex-1 min-w-0">
      <h3 className="text-base font-semibold text-slate-100 tracking-tight">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
  </div>
);

const Field = ({ label, hint, children }) => (
  <div>
    <label className="block text-sm font-medium text-slate-200 mb-2">{label}</label>
    {children}
    {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
  </div>
);

const Toggle = ({ active, onToggle, label, hint }) => (
  <button
    type="button"
    onClick={onToggle}
    className={`group flex items-center justify-between gap-4 p-4 rounded-xl border text-left transition w-full ${
      active
        ? 'border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10'
        : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 hover:border-slate-700'
    }`}
    aria-pressed={active}
  >
    <div className="min-w-0 flex-1">
      <div className={`text-sm font-medium ${active ? 'text-emerald-100' : 'text-slate-200'}`}>
        {label}
      </div>
      {hint && (
        <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
      )}
    </div>
    <div
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        active ? 'bg-emerald-500' : 'bg-slate-800'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          active ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </div>
  </button>
);

// ─── Modal ─────────────────────────────────────────────────────────────

const SettingsModal = ({
  isOpen,
  streams,
  autoFillSettings,
  setAutoFillSettings
}) => {
  const [activeSection, setActiveSection] = useState('autofill');
  const sectionRefs = useRef({});
  const scrollContainerRef = useRef(null);

  // Single setter for any partial update.
  const setSetting = useCallback(
    (patch) => setAutoFillSettings((prev) => ({ ...prev, ...patch })),
    [setAutoFillSettings]
  );

  // Scroll-spy: highlight the section the user is currently looking at.
  // The rootMargin puts the active band roughly between 30%–45% from
  // the top of the scroll viewport so a section "activates" as it
  // crosses into view, not when it's already left.
  useEffect(() => {
    if (!isOpen) return;
    const root = scrollContainerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.filter((e) => e.isIntersecting);
        if (intersecting.length === 0) return;
        // Pick the topmost — when several short sections fit the active
        // band at once, last-fires-wins gives wrong results.
        const top = intersecting.reduce((acc, cur) =>
          cur.boundingClientRect.top < acc.boundingClientRect.top ? cur : acc
        );
        setActiveSection(top.target.id);
      },
      { root, rootMargin: '-30% 0px -55% 0px', threshold: 0 }
    );
    SECTIONS.forEach(({ id }) => {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [isOpen]);

  const scrollToSection = useCallback((id) => {
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (!isOpen) return null;

  const activePlayer = PLAYER_OPTIONS.find((p) => p.value === autoFillSettings.playerType)
    || PLAYER_OPTIONS[0];
  const slotsOpen = Math.max(0, autoFillSettings.maxSlots - streams.length);

  return (
    <div
      className="relative flex-1 min-h-0 grid grid-rows-[1fr_auto] bg-slate-950"
      style={{
        backgroundImage:
          'radial-gradient(ellipse 600px 400px at top left, rgba(16,185,129,0.06) 0%, transparent 70%), radial-gradient(ellipse 600px 400px at bottom right, rgba(99,102,241,0.05) 0%, transparent 70%)'
      }}
    >
        {/* BODY: section rail + scrollable content. Drawer width ≥520
            keeps the two-column layout readable. */}
        <div className="grid grid-cols-[160px_1fr] overflow-hidden min-h-0">
          {/* Left rail */}
          <nav className="border-r border-slate-800/60 px-4 py-6 overflow-y-auto">
            <div className="text-[10px] uppercase tracking-[0.3em] text-slate-600 font-mono mb-3 px-2">
              Sections
            </div>
            <ul className="space-y-1">
              {SECTIONS.map((s) => {
                const isActive = activeSection === s.id;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => scrollToSection(s.id)}
                      className={`w-full flex items-center gap-3 px-2 py-2 rounded-md text-left transition ${
                        isActive
                          ? 'bg-slate-800/80 text-slate-100'
                          : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/60'
                      }`}
                    >
                      <span
                        className={`text-[10px] font-mono tabular-nums ${
                          isActive ? 'text-emerald-400' : 'text-slate-700'
                        }`}
                      >
                        {s.mark}
                      </span>
                      <span className="text-sm font-medium">{s.label}</span>
                      {isActive && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Live state read-out — anchored in the nav so it's always
                visible while you're tweaking settings up top. */}
            <div className="mt-8 p-3 rounded-lg border border-slate-800/60 bg-slate-900/40">
              <div className="text-[10px] uppercase tracking-[0.25em] text-slate-600 font-mono">
                Live state
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-3xl font-mono tabular-nums text-emerald-400 leading-none">
                  {streams.length}
                </span>
                <span className="text-sm text-slate-500 font-mono leading-none">
                  / {autoFillSettings.maxSlots}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                stream{streams.length !== 1 ? 's' : ''} active
              </div>
              {slotsOpen > 0 && (
                <div className="mt-2 text-[11px] text-emerald-400/80">
                  +{slotsOpen} slot{slotsOpen !== 1 ? 's' : ''} open
                </div>
              )}
            </div>

            <div className="mt-3 p-3 rounded-lg border border-slate-800/60 bg-slate-900/40">
              <div className="text-[10px] uppercase tracking-[0.25em] text-slate-600 font-mono">
                Player
              </div>
              <div className="mt-2 text-sm text-slate-200 font-medium">
                {activePlayer.title}
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                {activePlayer.subtitle}
              </div>
            </div>
          </nav>

          {/* Scrollable content */}
          <div
            ref={scrollContainerRef}
            className="overflow-y-auto px-8 py-6 space-y-10 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-800 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-slate-700"
          >
            {/* ─── 01 · AUTO-FILL ─────────────────────────────────── */}
            <section
              id="autofill"
              ref={(el) => { sectionRefs.current.autofill = el; }}
              className="space-y-6 scroll-mt-2"
            >
              <SectionHeader
                mark="01"
                title="Auto-fill"
                subtitle="Behaviour when populating the grid from a sport, an event, or 'find any'."
              />

              {/* Max slots */}
              <Field
                label="Max auto-fill slots"
                hint={`Auto-fill stops after ${autoFillSettings.maxSlots} stream${autoFillSettings.maxSlots !== 1 ? 's' : ''} total.`}
              >
                <div className="flex items-center gap-5">
                  <input
                    type="range"
                    min="1"
                    max="9"
                    value={autoFillSettings.maxSlots}
                    onChange={(e) => setSetting({ maxSlots: parseInt(e.target.value, 10) })}
                    className="flex-1 h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-emerald-500 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgba(16,185,129,0.18)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110"
                  />
                  <div className="min-w-[3.5rem] text-right">
                    <span className="text-3xl font-mono tabular-nums text-emerald-400 leading-none">
                      {autoFillSettings.maxSlots}
                    </span>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-1.5">
                  {[2, 4, 6, 9].map((num) => {
                    const active = autoFillSettings.maxSlots === num;
                    return (
                      <button
                        key={num}
                        type="button"
                        onClick={() => setSetting({ maxSlots: num })}
                        className={`px-3 py-1.5 rounded-md text-xs font-mono tabular-nums transition border ${
                          active
                            ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                            : 'border-slate-800 bg-transparent text-slate-500 hover:bg-slate-900 hover:text-slate-300'
                        }`}
                      >
                        {num}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* Two toggles side by side — was awkwardly stacked before */}
              <div className="grid grid-cols-2 gap-3">
                <Toggle
                  active={autoFillSettings.avoidDuplicateSources}
                  onToggle={() =>
                    setSetting({ avoidDuplicateSources: !autoFillSettings.avoidDuplicateSources })
                  }
                  label="Avoid duplicate sources"
                  hint="Different IPTV providers per stream"
                />
                <Toggle
                  active={autoFillSettings.avoidDuplicateEvents}
                  onToggle={() =>
                    setSetting({ avoidDuplicateEvents: !autoFillSettings.avoidDuplicateEvents })
                  }
                  label="Avoid duplicate events"
                  hint="Don't add the same game twice"
                />
              </div>

              {/* Quality tier ladder — single horizontal row */}
              <Field
                label="Minimum stream quality"
                hint={
                  autoFillSettings.minQuality === 0
                    ? 'Accept any quality.'
                    : `Reject streams below ${autoFillSettings.minQuality}p.`
                }
              >
                <div className="grid grid-cols-7 gap-1">
                  {QUALITY_TIERS.map((q) => {
                    const active = autoFillSettings.minQuality === q.value;
                    return (
                      <button
                        key={q.value}
                        type="button"
                        onClick={() => setSetting({ minQuality: q.value })}
                        className={`relative px-2 py-2.5 rounded-md text-center transition border ${
                          active
                            ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-200'
                            : 'border-slate-800 bg-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-200 hover:border-slate-700'
                        }`}
                      >
                        <div className="text-xs font-mono font-semibold tabular-nums">
                          {q.label}
                        </div>
                        <div
                          className={`text-[10px] font-mono mt-0.5 tracking-wider ${
                            active ? 'text-indigo-400/90' : 'text-slate-600'
                          }`}
                        >
                          {q.sub}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Field>
            </section>

            {/* ─── 02 · PLAYBACK ──────────────────────────────────── */}
            <section
              id="playback"
              ref={(el) => { sectionRefs.current.playback = el; }}
              className="space-y-5 scroll-mt-2"
            >
              <SectionHeader
                mark="02"
                title="Playback"
                subtitle="Engine that renders each multi-view tile."
              />

              <div className="grid grid-cols-2 gap-3">
                {PLAYER_OPTIONS.map((opt) => {
                  const active = autoFillSettings.playerType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSetting({ playerType: opt.value })}
                      className={`group relative text-left p-5 rounded-xl border transition overflow-hidden ${
                        active
                          ? 'border-emerald-500/50 bg-emerald-500/5'
                          : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 hover:border-slate-700'
                      }`}
                      aria-pressed={active}
                    >
                      {active && (
                        <span className="absolute top-3 right-3 inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                          active
                        </span>
                      )}
                      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 font-mono">
                        {opt.subtitle}
                      </div>
                      <div
                        className={`mt-1.5 text-xl font-semibold tracking-tight ${
                          active ? 'text-emerald-200' : 'text-slate-100'
                        }`}
                      >
                        {opt.title}
                      </div>
                      <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                        {opt.description}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {opt.tags.map((tag) => (
                          <span
                            key={tag}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${
                              active
                                ? 'bg-emerald-500/10 text-emerald-300/80 border-emerald-500/20'
                                : 'bg-slate-800/60 text-slate-500 border-slate-800'
                            }`}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Switching restarts every active stream. HLS adds ~2s latency vs raw TS but
                recovers from upstream blips without rotating to a different source.
              </p>
            </section>

            {/* ─── 03 · DISPLAY ───────────────────────────────────── */}
            <section
              id="display"
              ref={(el) => { sectionRefs.current.display = el; }}
              className="space-y-5 scroll-mt-2"
            >
              <SectionHeader
                mark="03"
                title="Display"
                subtitle="On-screen overlays and chrome."
              />

              <Toggle
                active={autoFillSettings.showLiveScoresTicker}
                onToggle={() =>
                  setSetting({ showLiveScoresTicker: !autoFillSettings.showLiveScoresTicker })
                }
                label="Live scores ticker"
                hint="Scrolling sports ticker at the bottom of the screen"
              />

              {/* Commercial auto-skip — server-side audio-fingerprint
                  detection. The backend learns repeated ad creatives by
                  cross-channel/cross-time repetition and mutes a tile when
                  its audio matches a confirmed ad. High precision: it only
                  mutes ads it has already learned, so detection improves the
                  more you watch. */}
              <Toggle
                active={Boolean(autoFillSettings.commercialAutoSkip)}
                onToggle={() =>
                  setSetting({ commercialAutoSkip: !autoFillSettings.commercialAutoSkip })
                }
                label="Commercial auto-skip"
                hint="Server-side audio-fingerprint detection. Mutes a tile when its audio matches a learned ad; the AD chip's Undo restores it. Learns ads by repetition, so it gets better over time."
              />
              {autoFillSettings.commercialAutoSkip && (
                <div className="ml-4 pl-3 border-l border-slate-800/80">
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Each visible IPTV tile is analyzed upstream (one extra
                    connection per channel). A brand-new ad isn't muted on its
                    first airing — it's catalogued once it repeats, then muted
                    on later airings. Shared across all your channels.
                  </p>
                </div>
              )}
            </section>

            {/* ─── 04 · LOCATION ──────────────────────────────────── */}
            <section
              id="location"
              ref={(el) => { sectionRefs.current.location = el; }}
              className="space-y-5 scroll-mt-2 pb-2"
            >
              <SectionHeader
                mark="04"
                title="Location"
                subtitle="Used to find local news channels and regional broadcasts."
              />
              <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/40">
                <LocationSelector compact={false} showLabel={true} className="w-full" />
              </div>
            </section>
          </div>
        </div>

        {/* FOOTER — live read-out only. Closing is handled by the
            DrawerShell's minimize/close buttons in the header. */}
        <footer className="px-4 py-2.5 border-t border-slate-800/60 bg-slate-950/60 flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {streams.length}/{autoFillSettings.maxSlots} slots
          </span>
          <span className="text-slate-700">·</span>
          <span>{activePlayer.title}</span>
          <span className="text-slate-700">·</span>
          <span>Ticker {autoFillSettings.showLiveScoresTicker ? 'on' : 'off'}</span>
        </footer>
    </div>
  );
};

export default React.memo(SettingsModal);
