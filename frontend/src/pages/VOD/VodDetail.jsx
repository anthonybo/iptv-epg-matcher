import React, { useEffect, useMemo, useRef, useState } from 'react';
import vodService from '../../services/vodService';
import PosterFallback from './PosterFallback';

/**
 * VodDetail — single movie OR single series detail page. Triggered
 * from VodBrowse by clicking a poster. Shows:
 *
 *   - Backdrop hero with poster + title + year + rating + cast
 *   - Overview synopsis (canonical from TMDB when enriched)
 *   - Sources strip — every account that carries this title
 *   - For SERIES: lazy-loaded seasons + episodes (per-season tabs)
 *   - Big PLAY button that streams via /api/vod-stream/...
 *
 * Player is intentionally a vanilla HTML5 <video> element. VOD
 * files are mp4/mkv, served via the proxy with range support, and
 * the browser handles seeking + audio tracks natively. No mpegts.js
 * needed here (unlike live MPEG-TS).
 */

const SourceChip = ({ source, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={source.source_nickname || source.source_name}
    className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border font-mono text-[10.5px] uppercase tracking-[0.14em] transition ${
      active
        ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
        : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200 hover:border-slate-700'
    }`}
  >
    <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-cyan-400' : 'bg-slate-600'}`} />
    {(source.source_nickname || source.source_name || '').slice(0, 20)}
  </button>
);

const StreamPlayer = ({ src, poster }) => {
  const videoRef = useRef(null);
  // The user's Play-button click is a valid user gesture for autoplay,
  // but the <video> wasn't reaching .play() automatically — they had
  // to click the native controls a second time. Kicking off play() in
  // an effect tied to src removes that second click.
  useEffect(() => {
    if (!videoRef.current || !src) return;
    const p = videoRef.current.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  }, [src]);

  if (!src) return null;
  return (
    <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-slate-800 bg-black">
      <video
        ref={videoRef}
        key={src}
        src={src}
        poster={poster || undefined}
        controls
        playsInline
        autoPlay
        preload="metadata"
        className="w-full h-full"
      />
    </div>
  );
};

const SeasonTabs = ({ seasons, activeSeason, onPickSeason }) => (
  <div className="flex items-center gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
    {seasons.map((s) => (
      <button
        key={s.season_number}
        type="button"
        onClick={() => onPickSeason(s.season_number)}
        className={`flex-shrink-0 h-8 px-3 rounded-md border font-mono text-[11px] font-bold uppercase tracking-[0.16em] transition ${
          activeSeason === s.season_number
            ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
            : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200 hover:border-slate-700'
        }`}
      >
        S{String(s.season_number).padStart(2, '0')}
        <span className="ml-1.5 font-normal text-slate-500 tabular-nums">{s.episodes.length}</span>
      </button>
    ))}
  </div>
);

const EpisodeRow = ({ episode, onPlay, playing }) => (
  <button
    type="button"
    onClick={() => onPlay(episode)}
    className={`group/ep w-full flex items-stretch gap-3 p-2 rounded-md border transition text-left ${
      playing
        ? 'border-cyan-500/40 bg-cyan-500/[0.08]'
        : 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/60'
    }`}
  >
    <div className="flex-shrink-0 w-32 aspect-video rounded overflow-hidden bg-slate-950 border border-slate-800 relative">
      {episode.still_url ? (
        <img src={episode.still_url} alt="" className="w-full h-full object-cover"
             onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-slate-700">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6">
            <polygon points="10 8 16 12 10 16 10 8" />
          </svg>
        </div>
      )}
      <span className="absolute top-1 left-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] px-1 py-0.5 rounded bg-slate-950/80 text-slate-300">
        E{String(episode.episode_number || 0).padStart(2, '0')}
      </span>
    </div>
    <div className="flex-1 min-w-0 py-0.5">
      <div className="text-[13px] font-semibold text-slate-100 truncate group-hover/ep:text-cyan-200 transition">
        {episode.title || `Episode ${episode.episode_number}`}
      </div>
      {episode.overview && (
        <div className="mt-1 text-[11.5px] text-slate-400 line-clamp-2 leading-relaxed">
          {episode.overview}
        </div>
      )}
      {episode.runtime_secs && (
        <div className="mt-1 font-mono text-[10px] tabular-nums text-slate-600">
          {Math.round(episode.runtime_secs / 60)} min
        </div>
      )}
    </div>
  </button>
);

const VodDetail = ({ kind, id, onBack }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [activeSourceId, setActiveSourceId] = useState(null);
  const [playingEpisodeStreamId, setPlayingEpisodeStreamId] = useState(null);
  const [streamSrc, setStreamSrc] = useState(null);
  const [trailerYtId, setTrailerYtId] = useState(null);
  // True while we're firing an on-demand enrichment for this row.
  const [enriching, setEnriching] = useState(false);
  const enrichTriedRef = useRef(false);
  // Series-only state
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [activeSeason, setActiveSeason] = useState(null);

  // Initial fetch — single canonical row + sources list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    enrichTriedRef.current = false;
    const fetcher = kind === 'movie' ? vodService.getMovie : vodService.getSeries;
    fetcher(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        const first = (d.sources || [])[0];
        if (first) setActiveSourceId(first.source_id);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.response?.data?.error || e.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind, id]);

  // On-demand enrichment: when the detail loads and the row hasn't
  // been enriched yet, kick off the lookup immediately instead of
  // making the user wait for the background worker's turn. Re-fetch
  // the detail once enrichment completes to swap in the rich data.
  useEffect(() => {
    if (loading || !data) return undefined;
    const row = (kind === 'movie' ? data.movie : data.series) || {};
    if (row.enriched_at) return undefined;
    if (enrichTriedRef.current) return undefined;
    enrichTriedRef.current = true;
    let cancelled = false;
    setEnriching(true);
    const enricher = kind === 'movie' ? vodService.enrichMovie : vodService.enrichSeries;
    enricher(id)
      .then((res) => {
        if (cancelled || !res?.ok) {
          if (!cancelled) setEnriching(false);
          return;
        }
        // Re-fetch the detail to get the enriched fields.
        const fetcher = kind === 'movie' ? vodService.getMovie : vodService.getSeries;
        return fetcher(id).then((d2) => {
          if (cancelled) return;
          setData(d2);
          setEnriching(false);
        });
      })
      .catch(() => { if (!cancelled) setEnriching(false); });
    return () => { cancelled = true; };
  }, [loading, data, kind, id]);

  // Series episode lazy-fetch when the active source changes.
  useEffect(() => {
    if (kind !== 'series' || !data || !activeSourceId) return undefined;
    let cancelled = false;
    setEpisodesLoading(true);
    setEpisodesError(null);
    vodService.getSeriesEpisodes(id, { sourceId: activeSourceId })
      .then((d) => {
        if (cancelled) return;
        const list = d.seasons || [];
        setSeasons(list);
        if (list.length > 0) setActiveSeason(list[0].season_number);
        setEpisodesLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setEpisodesError(e.response?.data?.error || e.message);
        setEpisodesLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind, id, activeSourceId, data]);

  const activeSource = useMemo(() => {
    if (!data) return null;
    return (data.sources || []).find((s) => s.source_id === activeSourceId) || (data.sources || [])[0] || null;
  }, [data, activeSourceId]);

  const handlePlayMovie = () => {
    if (!activeSource) return;
    setStreamSrc(vodService.buildMovieStreamUrl(activeSource.movie_stream_id));
  };

  const handlePlayEpisode = (episode) => {
    if (!episode.episode_stream_id) return;
    setPlayingEpisodeStreamId(episode.episode_stream_id);
    setStreamSrc(vodService.buildEpisodeStreamUrl(episode.episode_stream_id));
  };

  if (loading) {
    return (
      <div className="px-6 py-20 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600">
        Loading {kind}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-6 py-10">
        <div className="px-4 py-3 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 font-mono text-[12px]">
          {error}
        </div>
      </div>
    );
  }
  if (!data) return null;

  // Defensive: an older API response or unenriched-with-no-sources
  // path could leave .movie/.series unset. Falling back to {} keeps
  // optional chain reads (row.backdrop_url, row.genres, …) from
  // crashing the whole page.
  const row = (kind === 'movie' ? data.movie : data.series) || {};
  const sources = data.sources || [];
  const activeSeasonRow = seasons.find((s) => s.season_number === activeSeason) || null;

  return (
    <div className="relative">
      {/* Backdrop hero */}
      {row.backdrop_url && (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-72 pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(2,6,23,0.4) 0%, rgba(2,6,23,1) 90%), url(${row.backdrop_url})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
      )}

      <div className="relative px-6 py-6 max-w-[1200px] mx-auto">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-slate-400 hover:text-slate-100 transition"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to library
        </button>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Poster — fallback layered BEHIND the <img> so it shows
              through when the image is missing OR 404s mid-load. Same
              designed empty state used in the grid for consistency. */}
          <div className="flex-shrink-0 w-40 md:w-56">
            <div className="relative w-full aspect-[2/3] rounded-lg overflow-hidden border border-slate-800 shadow-lg">
              <PosterFallback
                kind={kind}
                title={row.title}
                year={row.year}
              />
              {row.poster_url && (
                <img
                  src={row.poster_url}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
            </div>
          </div>

          {/* Metadata */}
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500 mb-1 flex items-center gap-2">
                <span>{kind === 'movie' ? 'Movie' : 'TV Series'}</span>
                {row.enriched_at && <span className="text-emerald-400">· enriched</span>}
                {enriching && !row.enriched_at && (
                  <span className="text-cyan-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    Looking up metadata…
                  </span>
                )}
              </div>
              <h1 className="text-3xl font-bold text-slate-100 leading-tight">{row.title}</h1>
              <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] tabular-nums text-slate-400 flex-wrap">
                {row.year && <span>{row.year}</span>}
                {Number(row.runtime_secs) > 0 && (
                  <>
                    <span className="text-slate-700">·</span>
                    <span>{Math.round(Number(row.runtime_secs) / 60)} min</span>
                  </>
                )}
                {Number(row.rating_tmdb) > 0 && (
                  <>
                    <span className="text-slate-700">·</span>
                    <span className="text-amber-300">★ {Number(row.rating_tmdb).toFixed(1)}</span>
                  </>
                )}
                {Array.isArray(row.genres) && row.genres.length > 0 && (
                  <>
                    <span className="text-slate-700">·</span>
                    <span className="truncate">{row.genres.join(' · ')}</span>
                  </>
                )}
              </div>
            </div>

            {!row.overview && !enriching && !row.enriched_at && (
              <p className="text-[12px] text-slate-500 italic max-w-3xl">
                No description available — this title isn't on IMDb yet.
              </p>
            )}

            {row.overview && (
              <p className="text-[13px] text-slate-300 leading-relaxed max-w-3xl">
                {row.overview}
              </p>
            )}

            {row.director && (
              <div className="text-[11.5px] text-slate-400">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600 mr-2">Director</span>
                {row.director}
              </div>
            )}

            {Array.isArray(row.cast_json) && row.cast_json.length > 0 && (
              <div className="text-[11.5px] text-slate-400">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600 mr-2">Cast</span>
                {row.cast_json.slice(0, 8).map((c) => c.name).join(' · ')}
              </div>
            )}

            {/* Source chips */}
            {sources.length > 0 && (
              <div className="pt-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600 mb-1.5">
                  Available on {sources.length} source{sources.length === 1 ? '' : 's'}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {sources.map((s) => (
                    <SourceChip
                      key={s.movie_stream_id || s.series_source_id}
                      source={s}
                      active={s.source_id === activeSourceId}
                      onClick={() => setActiveSourceId(s.source_id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Actions row — Play + Trailer */}
            {(kind === 'movie' && activeSource) || row.trailer_youtube_id ? (
              <div className="pt-3 flex items-center gap-2 flex-wrap">
                {kind === 'movie' && activeSource && (
                  <button
                    type="button"
                    onClick={() => { setTrailerYtId(null); handlePlayMovie(); }}
                    className="inline-flex items-center gap-2 h-10 px-5 rounded-md border border-emerald-500/50 bg-emerald-500/[0.12] text-emerald-100 hover:bg-emerald-500/20 hover:border-emerald-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_18px_-4px_rgba(16,185,129,0.5)] transition"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <polygon points="6 4 20 12 6 20 6 4" />
                    </svg>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">Play</span>
                  </button>
                )}
                {row.trailer_youtube_id && (
                  <button
                    type="button"
                    onClick={() => { setStreamSrc(null); setTrailerYtId(row.trailer_youtube_id); }}
                    className="inline-flex items-center gap-2 h-10 px-4 rounded-md border border-slate-700 bg-slate-900/60 text-slate-200 hover:text-slate-100 hover:border-slate-600 hover:bg-slate-900 transition"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                      <rect x="3" y="6" width="14" height="12" rx="2" />
                      <path d="M17 9l4-2v10l-4-2" />
                    </svg>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]">Trailer</span>
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* Player area — trailer iframe takes precedence when active,
            stream player otherwise. Single shared region so switching
            between Play and Trailer never doubles up the UI. */}
        {trailerYtId ? (
          <div className="mt-6">
            <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-slate-800 bg-black">
              <iframe
                key={trailerYtId}
                title="Trailer"
                src={`https://www.youtube-nocookie.com/embed/${trailerYtId}?autoplay=1&rel=0&modestbranding=1`}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                className="absolute inset-0 w-full h-full"
                frameBorder="0"
              />
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setTrailerYtId(null)}
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 hover:text-slate-200 transition"
              >
                Close trailer
              </button>
            </div>
          </div>
        ) : streamSrc ? (
          <div className="mt-6">
            <StreamPlayer src={streamSrc} poster={row.backdrop_url || row.poster_url} />
          </div>
        ) : null}

        {/* SERIES — seasons + episodes */}
        {kind === 'series' && (
          <div className="mt-8 space-y-3">
            <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">
              Episodes
            </h2>
            {episodesLoading ? (
              <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600">
                Loading episodes from provider…
              </div>
            ) : episodesError ? (
              <div className="px-3 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 font-mono text-[11px]">
                {episodesError}
              </div>
            ) : seasons.length === 0 ? (
              <div className="py-6 font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600 text-center">
                No episodes returned by provider
              </div>
            ) : (
              <>
                <SeasonTabs
                  seasons={seasons}
                  activeSeason={activeSeason}
                  onPickSeason={setActiveSeason}
                />
                {activeSeasonRow && (
                  <div className="space-y-2 mt-2">
                    {activeSeasonRow.episodes.map((ep) => (
                      <EpisodeRow
                        key={ep.episode_stream_id || `${ep.episode_number}-${ep.provider_episode_id}`}
                        episode={ep}
                        playing={ep.episode_stream_id === playingEpisodeStreamId}
                        onPlay={handlePlayEpisode}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default VodDetail;
