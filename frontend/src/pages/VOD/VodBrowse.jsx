import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import vodService from '../../services/vodService';
import PosterFallback from './PosterFallback';

/**
 * VodBrowse — shared poster-grid browse page used for both
 * `kind="movie"` and `kind="series"`. The two tabs in the sidebar
 * both mount this component with their respective `kind`.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  HEADER: title + total count + restore-from-bg-enrichment chip │
 *   │  TOOLBAR: search · sort · source filter · category filter│
 *   ├──────────────────────────────────────────────────────────┤
 *   │  POSTER GRID — 6-column desktop, responsive down to 2    │
 *   │  Each card: poster · title · year · rating chip          │
 *   │  Unenriched rows show a slate placeholder + provider title│
 *   ├──────────────────────────────────────────────────────────┤
 *   │  PAGINATION footer                                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Selecting a poster opens VodDetail (separate route in App.js).
 * For now we surface it via an `onOpen(id)` callback so the page
 * stays presentation-only and the parent owns navigation.
 */

const PAGE_SIZE = 30;
// First-paint skeleton count — matches a 6-col grid x ~3 rows so the
// page never looks empty during the initial 200-400ms fetch.
const SKELETON_COUNT = 18;

const SORT_OPTIONS = [
  { id: 'recent', label: 'Recently added' },
  { id: 'title',  label: 'Title A→Z' },
  { id: 'rating', label: 'Rating' }
];

// Rating chip — instrument-readout aesthetic. A 0-10 mini-meter
// strip runs along the chip's bottom edge, filling proportionally
// to the rating. Color tier (emerald 8+, amber 7-7.9, slate <7)
// flows from one accent through star + meter + border + glow so
// the eye learns to scan one shape and read tier peripherally.
// When `enriched` is false, the rating is the provider's
// unverified value (often a bogus 10.0) — we drop into slate
// regardless of score and the tooltip flags it as "unverified".
const FmtRating = ({ rating, enriched = true }) => {
  if (rating == null) return null;
  const r = Number(rating);
  // PostgreSQL NUMERIC comes back as a STRING from pg-node, so "0.0"
  // is truthy in JS and the chip would render a meaningless ★0.0.
  // Filter explicitly on the parsed number being > 0.
  if (!Number.isFinite(r) || r <= 0) return null;

  const tier = !enriched ? 'unknown'
    : r >= 8 ? 'great'
    : r >= 7 ? 'good'
    : 'ok';

  const styles = {
    great:   { star: 'text-emerald-300', num: 'text-emerald-50',  meter: 'bg-emerald-400', border: 'border-emerald-500/40', glow: 'shadow-[0_0_10px_-2px_rgba(16,185,129,0.45)]' },
    good:    { star: 'text-amber-300',   num: 'text-amber-50',    meter: 'bg-amber-400',   border: 'border-amber-500/40',   glow: '' },
    ok:      { star: 'text-slate-300',   num: 'text-slate-100',   meter: 'bg-slate-400',   border: 'border-slate-700/80',   glow: '' },
    unknown: { star: 'text-slate-400',   num: 'text-slate-200',   meter: 'bg-slate-500',   border: 'border-slate-700/80',   glow: '' }
  }[tier];

  const meterPct = Math.min(100, Math.max(0, (r / 10) * 100));
  const tooltip = enriched
    ? `IMDb rating · ${r.toFixed(1)}`
    : `Provider rating · ${r.toFixed(1)} (unverified)`;

  return (
    <span
      title={tooltip}
      className={`relative inline-flex items-center gap-1.5 h-6 px-2 rounded-md border bg-slate-950/90 font-mono text-[12px] font-bold tabular-nums leading-none overflow-hidden ${styles.border} ${styles.glow}`}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className={`w-3 h-3 ${styles.star}`}>
        <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
      </svg>
      <span className={styles.num}>{r.toFixed(1)}</span>
      <span
        aria-hidden
        className={`absolute left-0 bottom-0 h-[2px] ${styles.meter}`}
        style={{ width: `${meterPct}%` }}
      />
    </span>
  );
};

// No-rating placeholder — same chip silhouette so the corner stays
// visually consistent across the grid, but evacuated of color so
// real ratings dominate. Mono caps "NR" reads as a deliberate
// state, not a missing element.
const FmtRatingPlaceholder = () => (
  <span
    title="No rating available"
    className="relative inline-flex items-center justify-center h-6 min-w-[2.5rem] px-2 rounded-md border border-slate-800/60 bg-slate-950/60 font-mono text-[10px] font-bold uppercase tracking-[0.18em] leading-none text-slate-600"
  >
    NR
  </span>
);

// PosterFallback now lives in its own module (./PosterFallback) so
// the detail page can render the same designed empty state when its
// hero poster is missing.

const PosterCard = ({ item, onOpen, kind }) => {
  const hasPoster = Boolean(item.poster_url);
  return (
    <button
      type="button"
      onClick={() => onOpen?.(item)}
      className="group/card text-left flex flex-col gap-1.5 focus:outline-none"
    >
      <div className="relative aspect-[2/3] rounded-md overflow-hidden border border-slate-800 bg-slate-900/60 transition group-hover/card:border-cyan-500/40 group-hover/card:shadow-[0_0_0_3px_rgba(34,211,238,0.06)]">
        {/* Fallback always sits behind the img so it remains visible
            if the image is hidden by onError (broken Cinemeta URL,
            CORS, etc.) or hasn't loaded yet. */}
        <PosterFallback kind={kind} title={item.title} year={item.year} />

        {hasPoster && (
          <img
            src={item.poster_url}
            alt={item.title || 'poster'}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        )}

        {/* Enrichment indicator — emerald dot when canonical row
            has IMDb/Cinemeta data, slate when still bare provider info. */}
        {item.enriched && (
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]" title="Enriched" />
        )}
        {/* Source count badge when this title appears on multiple sources */}
        {(item.source_count > 1 || (item.sources && item.sources.length > 1)) && (
          <span className="absolute top-1.5 left-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/20 text-cyan-100">
            ×{item.source_count || item.sources.length}
          </span>
        )}
        <FmtRatingOverlay rating={item.rating} enriched={item.enriched} />
      </div>
      <div className="space-y-0.5 px-0.5">
        <div className="text-[12.5px] font-semibold text-slate-100 truncate group-hover/card:text-cyan-200 transition" title={item.title}>
          {item.title}
        </div>
        {item.year && (
          <div className="font-mono text-[10px] tabular-nums text-slate-500">
            {item.year}
          </div>
        )}
      </div>
    </button>
  );
};

// Bottom-right corner overlay. Includes a soft corner-radial scrim
// so the chip reads cleanly on light AND dark posters — the scrim
// only darkens the bottom-right wedge, leaving the rest of the
// poster artwork untouched. Always renders something (real chip or
// NR placeholder) so the corner stays predictable while scanning.
const FmtRatingOverlay = ({ rating, enriched = true }) => {
  const r = Number(rating);
  const hasRating = rating != null && Number.isFinite(r) && r > 0;
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-20 w-28 rounded-br-md"
        style={{
          background:
            'radial-gradient(ellipse 85% 85% at 100% 100%, rgba(2,6,23,0.78) 0%, rgba(2,6,23,0.35) 45%, transparent 75%)'
        }}
      />
      <span className="absolute bottom-1.5 right-1.5">
        {hasRating ? <FmtRating rating={r} enriched={enriched} /> : <FmtRatingPlaceholder />}
      </span>
    </>
  );
};

const VodBrowse = ({ kind, onOpen }) => {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const [sourceId, setSourceId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const [items, setItems] = useState([]);
  // `cursor` is the opaque base64 token the server returns. null means
  // "load page 1 from scratch". Bumped only by the IntersectionObserver
  // when the user reaches the bottom of the loaded set.
  const [cursor, setCursor] = useState(null);
  // `nextCursor` is what the server told us to use NEXT. When we hit
  // the sentinel we promote it to `cursor` to trigger the fetch.
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [categories, setCategories] = useState([]);
  const requestSeqRef = useRef(0);
  const sentinelRef = useRef(null);

  // Debounce search input.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset when filters change — clear cursor + items so the next fetch
  // is a fresh first-page load.
  useEffect(() => {
    setCursor(null);
    setNextCursor(null);
    setItems([]);
    setHasMore(false);
  }, [kind, debouncedSearch, sort, sourceId, categoryId]);

  // Fetch categories ONCE per kind.
  useEffect(() => {
    let cancelled = false;
    vodService.getCategories(kind).then((data) => {
      if (cancelled) return;
      setCategories(data.categories || []);
    }).catch(() => {/* non-fatal */});
    return () => { cancelled = true; };
  }, [kind]);

  // Cursor-paginated fetch. cursor === null → fresh load (replace);
  // cursor set → append. The server tells us whether there's more and
  // gives us the next cursor.
  //
  // AbortController per effect run so a superseding fetch (filter
  // changes, debounce flush) cancels the previous HTTP request — not
  // just the result handler. Without this, axios calls pile up on the
  // backend; for the TV-series page with 300k series_sources this
  // meant 6+ identical queries running concurrently on the DB and
  // contending with each other.
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    if (cursor == null) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    const fetcher = kind === 'movie' ? vodService.getMovies : vodService.getSeriesList;
    fetcher({
      search: debouncedSearch,
      sourceId: sourceId || undefined,
      categoryId: categoryId || undefined,
      cursor,
      pageSize: PAGE_SIZE,
      sort,
      signal: controller.signal
    })
      .then((data) => {
        if (requestSeqRef.current !== seq) return; // stale
        const incoming = kind === 'movie' ? (data.movies || []) : (data.series || []);
        setItems((prev) => {
          if (cursor == null) return incoming;
          // Defensive dedup on append: even with the group-level cursor
          // filter, an exact updated_at collision between two groups
          // could surface a row that's already on screen. Drop those
          // before React notices.
          const seenIds = new Set(prev.map((it) => it.id));
          return [...prev, ...incoming.filter((it) => it.id && !seenIds.has(it.id))];
        });
        setHasMore(Boolean(data.hasMore));
        setNextCursor(data.nextCursor || null);
        setLoading(false);
        setLoadingMore(false);
      })
      .catch((err) => {
        if (requestSeqRef.current !== seq) return;
        // Aborts surface as either CanceledError (axios) or DOMException
        // with name='AbortError'. Neither is a real error — just the
        // next request taking over. Stay silent.
        if (err?.name === 'CanceledError' || err?.name === 'AbortError'
            || err?.code === 'ERR_CANCELED') {
          return;
        }
        setError(err.response?.data?.error || err.message || 'Failed to load');
        setLoading(false);
        setLoadingMore(false);
      });

    return () => controller.abort();
  }, [kind, debouncedSearch, sort, sourceId, categoryId, cursor]);

  // Infinite scroll — when the sentinel scrolls into view (with a
  // 400px pre-load margin so the next batch is requested before the
  // user actually reaches the bottom), promote nextCursor → cursor.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return undefined;
    if (!hasMore || !nextCursor || loading || loadingMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setCursor(nextCursor);
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, nextCursor, loading, loadingMore]);

  const enrichedCount = items.filter((i) => i.enriched).length;

  // Source list extracted from the categories list (categories are
  // sub-grouped per source, so a unique source-id+name set falls
  // out of them).
  const sources = useMemo(() => {
    const map = new Map();
    categories.forEach((c) => {
      if (!map.has(c.source_id)) {
        map.set(c.source_id, {
          id: c.source_id,
          name: c.source_nickname || c.source_name
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [categories]);

  // Categories filtered by selected source.
  const visibleCategories = useMemo(() => {
    if (!sourceId) return categories;
    return categories.filter((c) => c.source_id === parseInt(sourceId, 10));
  }, [categories, sourceId]);

  return (
    <div className="px-6 py-6 max-w-[1600px] mx-auto">
      {/* ── HEADER ───────────────────────────────────────────── */}
      <header className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500 mb-1">
            VOD Library · {kind === 'movie' ? 'Movies' : 'TV Series'}
          </div>
          <h1 className="text-2xl font-bold text-slate-100">
            {kind === 'movie' ? 'Movies' : 'TV Series'}
            {items.length > 0 && (
              <span className="ml-3 font-mono text-base tabular-nums text-slate-500 font-normal">
                {items.length.toLocaleString()}
                {hasMore && <span className="text-slate-700">+</span>}
              </span>
            )}
          </h1>
        </div>
        {/* Live enrichment count — visible signal that the enrichment
            worker is filling in metadata in the background. */}
        {enrichedCount > 0 && items.length > 0 && (
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            <span className="text-emerald-400 tabular-nums">{enrichedCount}</span>
            <span className="text-slate-700"> / </span>
            <span className="tabular-nums">{items.length}</span> loaded enriched
          </div>
        )}
      </header>

      {/* ── TOOLBAR ──────────────────────────────────────────── */}
      <div className="mb-5 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${kind === 'movie' ? 'movies' : 'series'}…`}
            className="w-full pl-9 pr-3 py-2 rounded-md border border-slate-800 bg-slate-900/60 text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/40 focus:outline-none focus:shadow-[0_0_0_3px_rgba(34,211,238,0.06)] font-mono text-[12.5px]"
          />
        </div>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="h-9 px-2 rounded-md border border-slate-800 bg-slate-900/60 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-cyan-500/40"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>

        {sources.length > 1 && (
          <select
            value={sourceId}
            onChange={(e) => { setSourceId(e.target.value); setCategoryId(''); }}
            className="h-9 px-2 rounded-md border border-slate-800 bg-slate-900/60 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-cyan-500/40"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {visibleCategories.length > 0 && sourceId && (
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-9 px-2 rounded-md border border-slate-800 bg-slate-900/60 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-cyan-500/40 max-w-[260px] truncate"
          >
            <option value="">All categories</option>
            {visibleCategories.map((c) => (
              <option key={c.id} value={c.provider_category_id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* ── BODY ─────────────────────────────────────────────── */}
      {loading && items.length === 0 ? (
        // Skeleton placeholders — render the grid shell immediately so
        // the page never looks blank during the initial fetch. The
        // shimmer is a CSS-only animated gradient; no JS work, no
        // layout shift when the real cards swap in.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="relative aspect-[2/3] rounded-md overflow-hidden border border-slate-800/60 bg-slate-900/40">
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-slate-900/0 via-slate-800/30 to-slate-900/0" />
              </div>
              <div className="h-3 w-3/4 rounded bg-slate-900/60 animate-pulse" />
              <div className="h-2 w-1/3 rounded bg-slate-900/40 animate-pulse" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="px-4 py-3 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 font-mono text-[12px]">
          {error}
        </div>
      ) : items.length === 0 ? (
        <EmptyState kind={kind} hasSearch={Boolean(debouncedSearch)} />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {items.map((item) => (
              <PosterCard key={item.id} item={item} kind={kind} onOpen={onOpen} />
            ))}
          </div>

          {/* Infinite-scroll sentinel — invisible 1px marker that the
              IntersectionObserver effect watches for entering the
              viewport (plus a 300px pre-load margin), bumping page and
              triggering the next fetch. */}
          {hasMore && <div ref={sentinelRef} aria-hidden className="h-1 w-full" />}

          {loadingMore && (
            <div className="mt-6 py-3 flex items-center justify-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-slate-500">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              Loading more…
            </div>
          )}

          {!hasMore && !loading && items.length > 0 && (
            <div className="mt-8 mb-4 text-center font-mono text-[10px] uppercase tracking-[0.24em] text-slate-700">
              End of results · {items.length.toLocaleString()} {kind === 'movie' ? 'movies' : 'series'}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const EmptyState = ({ kind, hasSearch }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} className="w-12 h-12 text-slate-700 mb-3">
      {kind === 'series' ? (
        <>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4M8 12h8" />
        </>
      ) : (
        <>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M2 8h20M2 16h20M7 4v16M17 4v16" />
        </>
      )}
    </svg>
    <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">
      {hasSearch ? 'No matches' : `No ${kind === 'movie' ? 'movies' : 'series'} ingested yet`}
    </div>
    {!hasSearch && (
      <div className="text-[12px] text-slate-600 max-w-md">
        Add an Xtream or Stalker IPTV source from the My IPTVs page — VOD is
        ingested automatically on the next refresh, alongside live channels.
      </div>
    )}
  </div>
);

export default VodBrowse;
