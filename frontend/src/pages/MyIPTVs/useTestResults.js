import { useCallback, useEffect, useRef, useState } from 'react';

// Key includes a version so we can change the shape later without stale data
// tripping consumers. Per-browser scope is fine — tests are transient enough
// that syncing them across devices would be overkill.
const STORAGE_KEY = 'myiptv:test-results:v1';

const readStorage = () => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeStorage = (value) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked — silently degrade to in-memory only.
  }
};

export const useTestResults = () => {
  const [results, setResults] = useState(() => readStorage());
  const writeTimerRef = useRef(null);

  // Debounce writes so a flurry of updates (e.g. a 10-account "Test all"
  // flipping rows from 'testing' → 'passed' in quick succession) coalesce
  // into one localStorage write.
  useEffect(() => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => writeStorage(results), 200);
    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [results]);

  const setResult = useCallback((sourceId, result) => {
    setResults((prev) => ({ ...prev, [sourceId]: { ...result, testedAt: Date.now() } }));
  }, []);

  // Mutator version for the 'testing' transition that shouldn't overwrite
  // an existing testedAt (it's not a completion).
  const setPendingResult = useCallback((sourceId, result) => {
    setResults((prev) => ({ ...prev, [sourceId]: result }));
  }, []);

  const removeResults = useCallback((ids) => {
    if (!ids || ids.length === 0) return;
    setResults((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => setResults({}), []);

  return { results, setResult, setPendingResult, removeResults, clearAll };
};

export default useTestResults;
