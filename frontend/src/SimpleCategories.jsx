import React, { useState, useEffect, useContext } from 'react';
import { SessionContext } from './App';

const normalizeCategory = (category) => {
  if (typeof category === 'string') {
    return { name: category, count: null };
  }

  return {
    name: category?.name || category?.group || 'Unknown',
    count:
      category?.count ??
      category?.channelCount ??
      category?.channel_count ??
      category?.channels ??
      null,
  };
};

const SimpleCategories = () => {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [inputSessionId, setInputSessionId] = useState('');

  const sessionContext = useContext(SessionContext);
  const contextSessionId = sessionContext?.sessionId;

  const getSessionId = () => {
    if (contextSessionId) {
      return contextSessionId;
    }

    const keys = ['sessionId', 'currentSession', 'session', 'iptv-session-id'];
    for (const key of keys) {
      const savedSession = localStorage.getItem(key);
      if (savedSession) {
        return savedSession;
      }
    }

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.toLowerCase().includes('session')) {
        const value = localStorage.getItem(key);
        if (value) {
          return value;
        }
      }
    }

    return null;
  };

  const manualFetch = async (sid) => {
    if (!sid) {
      setError('No session ID provided');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/channels/${sid}/categories`);

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);

      if (Array.isArray(data)) {
        setCategories(data);
      } else {
        setError('Invalid data format - expected an array of categories');
      }
    } catch (fetchError) {
      setError(`Network error: ${fetchError.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const fetchCategories = async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        setError('No session ID found in any storage location');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/channels/${sessionId}/categories`);

        if (!response.ok) {
          throw new Error(`Error fetching categories: ${response.status}`);
        }

        const text = await response.text();
        const data = JSON.parse(text);

        if (Array.isArray(data)) {
          setCategories(data);
        } else {
          setError('Invalid categories format received from server');
        }
      } catch (err) {
        setError(`Failed to load categories: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchCategories();
  }, [contextSessionId]);

  const normalizedCategories = categories.map(normalizeCategory);
  const displayedCategories =
    selectedCategory === 'all'
      ? normalizedCategories
      : normalizedCategories.filter((category) => category.name === selectedCategory);

  const SessionIdInput = () => (
    <div className="mb-6 rounded-2xl border border-slate-800/70 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/20">
      <h3 className="text-sm font-semibold text-slate-200">Test with Custom Session ID</h3>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          value={inputSessionId}
          onChange={(e) => setInputSessionId(e.target.value)}
          placeholder="Enter session ID to test"
          className="flex-1 rounded-lg border border-slate-800/80 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
        />
        <button
          type="button"
          onClick={() => manualFetch(inputSessionId)}
          className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-950 hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Fetch
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center bg-slate-950 text-slate-100">
        <div className="flex flex-col items-center gap-3">
          <span className="h-10 w-10 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"></span>
          <p className="text-sm text-slate-400">Loading categories…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-slate-100">
        <SessionIdInput />
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-200">
          {error}
        </div>
        <button
          type="button"
          onClick={() => {
            window.location.href = '/';
          }}
          className="mt-6 inline-flex items-center justify-center rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 transition-all hover:bg-slate-700"
        >
          Go to Home
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 text-slate-100">
      <SessionIdInput />

      <section className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-8 shadow-2xl shadow-slate-950/40">
        <header className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-blue-400/70">Categories</p>
          <h2 className="text-3xl font-semibold text-slate-100">Channel Categories</h2>
          <p className="text-sm text-slate-400">
            Select a category to focus the list below or browse all available groups from your provider.
          </p>
        </header>

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
          <label className="flex-1 text-sm text-slate-300">
            <span className="mb-2 block font-semibold text-slate-200">Filter Categories</span>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full rounded-xl border border-slate-800/80 bg-slate-900/70 px-4 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
            >
              <option value="all">All Categories</option>
              {normalizedCategories.map((category) => (
                <option key={category.name} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
            <span className="font-semibold text-slate-100">Total:</span> {normalizedCategories.length}
          </div>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {displayedCategories.length === 0 ? (
            <div className="rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6 text-sm text-slate-400">
              No categories match the selected filter.
            </div>
          ) : (
            displayedCategories.map((category) => (
              <article
                key={`${category.name}-${category.count ?? 'unknown'}`}
                className={`rounded-2xl border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-slate-950/20 transition-colors hover:border-slate-700 hover:bg-slate-900 ${
                  selectedCategory !== 'all' && category.name === selectedCategory
                    ? 'ring-2 ring-blue-500/60'
                    : ''
                }`}
              >
                <h3 className="text-lg font-semibold text-slate-100">{category.name}</h3>
                <p className="mt-2 text-sm text-slate-400">
                  {category.count !== null ? (
                    <>
                      {category.count.toLocaleString()} channel{category.count === 1 ? '' : 's'}
                    </>
                  ) : (
                    'Channel count unavailable'
                  )}
                </p>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
};

export default SimpleCategories;
