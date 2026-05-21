import React from 'react';

/**
 * PosterFallback — designed empty state for VOD tiles that have no
 * artwork (or whose poster URL 404s at load time). Rendered as a
 * positioned overlay BEHIND the <img>, so it remains visible when
 * the image is hidden via onError or hasn't yet loaded.
 *
 * Visual concept: editorial archive specimen card. Title is the
 * hero, accented by a hash-derived 4-tone palette (cyan/violet/
 * amber/emerald) so each card has a quiet identity in the grid
 * rather than reading as a generic placeholder. Soft radial
 * vignette + thin top marker + vertical pull-quote spine echo
 * Criterion Collection title cards / Library of Congress catalog
 * entries.
 *
 * Used by both the grid (VodBrowse) and the single-item detail
 * page (VodDetail) so the missing-artwork aesthetic is consistent
 * across the app.
 */
const PosterFallback = ({ kind, title, year }) => {
  // Deterministic identity per title — same hash drives the accent
  // color AND the archive code so each card reads as a unique
  // catalog entry rather than a generic empty state.
  const hash = (title || '').split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
  const archiveId = '0x' + Math.abs(hash).toString(16).toUpperCase().slice(0, 4).padStart(4, '0');

  // 14% vignette opacity (up from 8%) so the tint actually reads on
  // the lifted slate-900 surface instead of being absorbed into the
  // background. Vignette repositioned top-right to create diagonal
  // flow with the top-left marker stripe.
  const tones = [
    { bar: 'bg-cyan-400',    spine: 'bg-cyan-400/70',    bullet: 'bg-cyan-400',    vignette: 'rgba(34,211,238,0.14)' },
    { bar: 'bg-violet-400',  spine: 'bg-violet-400/70',  bullet: 'bg-violet-400',  vignette: 'rgba(167,139,250,0.14)' },
    { bar: 'bg-amber-400',   spine: 'bg-amber-400/70',   bullet: 'bg-amber-400',   vignette: 'rgba(251,191,36,0.14)' },
    { bar: 'bg-emerald-400', spine: 'bg-emerald-400/70', bullet: 'bg-emerald-400', vignette: 'rgba(52,211,153,0.14)' }
  ][Math.abs(hash) % 4];

  return (
    <div
      className="
        absolute inset-0 rounded-md overflow-hidden
        bg-gradient-to-br from-slate-900 via-slate-900/95 to-slate-950
        shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.5)]
      "
    >
      {/* Cardstock grain — barely-visible white dot pattern on a
          14px raster. Gives the surface material texture so it reads
          as printed paper rather than a flat dark fill. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at center, rgba(255,255,255,0.045) 1px, transparent 1.2px)',
          backgroundSize: '14px 14px'
        }}
      />

      {/* Accent vignette — soft tinted glow radiating from the
          top-right corner. Diagonally balances the top-left marker
          stripe so the eye traces across the card. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at 100% 0%, ${tones.vignette} 0%, transparent 60%)`
        }}
      />

      {/* Top marker — short colored stripe over a full-width hairline
          divider. Reads as a typographic accent (Criterion-spine
          style) rather than structural chrome. */}
      <div className={`absolute top-0 left-0 h-[2px] w-2/5 ${tones.bar}`} />
      <div className="absolute top-[2px] inset-x-0 h-px bg-slate-800/60" />

      {/* Content stack. Insets keep the title, kicker, and archive
          code clear of the overlays PosterCard layers on top: ×N
          source-count badge (top-left), enrichment LED (top-right),
          and NR rating chip (bottom-right). */}
      <div className="relative h-full flex flex-col px-3.5 pt-7 pb-3">
        <div className="flex items-center justify-between font-mono text-[8.5px] uppercase tracking-[0.24em] text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className={`w-[5px] h-[5px] rounded-full ${tones.bullet}`} />
            {kind === 'series' ? 'TV Series' : 'Feature'}
          </span>
          {year && <span className="tabular-nums text-slate-600">{year}</span>}
        </div>

        {/* Title — the art. 3px vertical accent spine gives it the
            gravity of a pull-quote; centered vertically so short
            titles feel composed while long titles fill via line-clamp. */}
        <div className="flex-1 flex items-center my-3 min-h-0">
          <div className="flex items-stretch gap-2.5 w-full">
            <div className={`w-[3px] flex-shrink-0 rounded-full ${tones.spine}`} />
            <h3
              className="text-[19px] font-bold text-slate-50 leading-[1.08] line-clamp-5"
              style={{ letterSpacing: '-0.015em' }}
              title={title}
            >
              {title || 'Untitled'}
            </h3>
          </div>
        </div>

        {/* Footer — archive code with a short hairline above mirroring
            the top divider, for top-bottom balance like a printed
            catalog card. */}
        <div className="space-y-1.5">
          <div className="h-px w-10 bg-slate-800/60" />
          <div className="font-mono text-[8.5px] uppercase tracking-[0.22em] text-slate-600 tabular-nums">
            {archiveId}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PosterFallback;
