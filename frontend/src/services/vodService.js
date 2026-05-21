import apiClient from '../utils/apiClient';
import { getAuthToken } from '../utils/streamAuth';

/**
 * vodService — thin client wrapper around the /api/vod and
 * /api/vod-stream routes. The pages talk to this so the URL
 * surface only lives in one place.
 */

/**
 * GET /api/vod/categories?kind=movie|series
 * Returns categories grouped per source, server-side ordered.
 */
async function getCategories(kind) {
  const r = await apiClient.get('/vod/categories', { params: { kind } });
  return r.data;
}

/**
 * Paginated movie browse. opts: { search, sourceId, categoryId, page, pageSize, sort }
 */
async function getMovies(opts = {}) {
  const r = await apiClient.get('/vod/movies', {
    params: {
      search: opts.search || undefined,
      sourceId: opts.sourceId || undefined,
      categoryId: opts.categoryId || undefined,
      page: opts.page || 1,
      pageSize: opts.pageSize || 50,
      sort: opts.sort || 'recent'
    }
  });
  return r.data;
}

async function getMovie(id) {
  const r = await apiClient.get(`/vod/movies/${encodeURIComponent(id)}`);
  return r.data;
}

async function enrichMovie(id) {
  const r = await apiClient.post(`/vod/movies/${encodeURIComponent(id)}/enrich`);
  return r.data;
}

async function enrichSeries(id) {
  const r = await apiClient.post(`/vod/series/${encodeURIComponent(id)}/enrich`);
  return r.data;
}

async function getSeriesList(opts = {}) {
  const r = await apiClient.get('/vod/series', {
    params: {
      search: opts.search || undefined,
      sourceId: opts.sourceId || undefined,
      categoryId: opts.categoryId || undefined,
      page: opts.page || 1,
      pageSize: opts.pageSize || 50,
      sort: opts.sort || 'recent'
    }
  });
  return r.data;
}

async function getSeries(id) {
  const r = await apiClient.get(`/vod/series/${encodeURIComponent(id)}`);
  return r.data;
}

/**
 * Lazy episode fetcher. Backend lazy-fetches + caches 24h. The
 * `sourceId` param picks which provider to lazy-fetch from when a
 * series exists on multiple sources (default: most-recently-updated).
 */
async function getSeriesEpisodes(id, { sourceId } = {}) {
  const r = await apiClient.get(`/vod/series/${encodeURIComponent(id)}/episodes`, {
    params: { source_id: sourceId || undefined }
  });
  return r.data;
}

/**
 * Build a playable URL for a movie or episode. Token rides as a
 * query param because <video> elements can't carry Authorization
 * headers.
 */
function buildMovieStreamUrl(movieStreamId) {
  const token = getAuthToken();
  const base = `/api/vod-stream/movie/${encodeURIComponent(movieStreamId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function buildEpisodeStreamUrl(episodeStreamId) {
  const token = getAuthToken();
  const base = `/api/vod-stream/episode/${encodeURIComponent(episodeStreamId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export default {
  getCategories,
  getMovies,
  getMovie,
  enrichMovie,
  getSeriesList,
  getSeries,
  enrichSeries,
  getSeriesEpisodes,
  buildMovieStreamUrl,
  buildEpisodeStreamUrl
};
