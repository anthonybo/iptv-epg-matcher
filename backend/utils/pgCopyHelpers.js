/**
 * Shared helpers for streaming rows into Postgres via pg-copy-streams.
 *
 * Why a separate module: both postgresService.saveChannels and
 * vodIngestService.upsert* hit COPY paths that need identical
 * defensive plumbing. Keeping a single implementation prevents the
 * VOD-side bug we just fixed from re-emerging in the channels-side
 * code (which had the same latent race).
 *
 * The two non-obvious bits this module gets right:
 *
 *   1. Listener cleanup on backpressure. `copyStream.write()` returns
 *      false under load. The naive `once('drain', resolve)` +
 *      `once('error', reject)` pair leaks the unfired listener every
 *      time drain wins — and saveChannels on a 30k-row source can
 *      easily accumulate 11+ undisposed error listeners, tripping
 *      MaxListenersExceededWarning. We cross-remove so listener
 *      count stays bounded at <=2 per concurrent write.
 *
 *   2. pg-copy-streams crash-on-mid-COPY-error. When PG rejects the
 *      COPY mid-stream (e.g. CHECK constraint or PK violation), the
 *      library's `handleError` nulls `this.connection`. If we'd
 *      already called `.end()`, the queued `_final()` then crashes
 *      with `Cannot read properties of null (reading 'stream')`.
 *      We work around it by:
 *        a) Capturing the first 'error' event in a closure-scoped
 *           variable, never removing that listener (the stream is
 *           single-use and GC'd right after).
 *        b) Calling `destroy(err)` on any throw path. destroy sends
 *           CopyFail which triggers a SECOND 'error' emit — the
 *           never-removed captureErr absorbs it instead of letting
 *           it bubble up as uncaughtException.
 *
 * Verified by backend/scripts/verify_vod_upsert_resilience.js.
 */

/**
 * Postgres text-COPY escape rules.
 *   backslash → \\
 *   tab       → \t
 *   newline   → \n
 *   CR        → \r
 *   NULL      → literal two-character \N sentinel
 */
function tabEscape(v) {
  if (v == null) return '\\N';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Write one row to a COPY writable. Resolves immediately if the
 * stream accepted the row synchronously; otherwise waits for drain.
 * Cross-removes the loser listener so neither leaks across many
 * backpressure events (see note #1 in module header).
 */
function writeCopyRow(copyStream, row) {
  return new Promise((resolve, reject) => {
    if (copyStream.write(row)) {
      resolve();
      return;
    }
    const onDrain = () => {
      copyStream.removeListener('error', onError);
      resolve();
    };
    const onError = (err) => {
      copyStream.removeListener('drain', onDrain);
      reject(err);
    };
    copyStream.once('drain', onDrain);
    copyStream.once('error', onError);
  });
}

/**
 * Stream rows into a COPY writable with crash-safe error handling.
 * Iterates `rows`, mapping each to a COPY-encoded line via `toRow`,
 * and writes them sequentially with backpressure. On any error:
 *   - The error is surfaced through the returned promise rejection
 *   - The stream is destroy()'d to bypass pg-copy-streams' _final path
 *   - The captureErr listener (intentionally never removed) absorbs
 *     the second error emit that destroy() triggers
 *
 * See note #2 in module header for the full rationale.
 *
 * @param {Writable} copyStream - From `client.query(copyFrom(...))`
 * @param {Iterable} rows       - Source rows
 * @param {Function} toRow      - row → COPY-encoded string (with trailing \n)
 */
async function streamRowsToCopy(copyStream, rows, toRow) {
  let copyErr = null;
  const captureErr = (e) => { if (!copyErr) copyErr = e; };
  copyStream.on('error', captureErr); // intentionally permanent
  try {
    for (const r of rows) {
      if (copyErr) throw copyErr;
      await writeCopyRow(copyStream, toRow(r));
    }
    if (copyErr) throw copyErr;
    await new Promise((resolve, reject) => {
      copyStream.once('finish', resolve);
      copyStream.once('error', reject);
      copyStream.end();
    });
  } catch (e) {
    if (copyStream && !copyStream.destroyed) {
      try { copyStream.destroy(e); } catch (_) {}
    }
    throw e;
  }
}

/**
 * Dedupe an array by a key extractor, last-value-wins. Used to
 * pre-dedupe provider catalogs before COPY into a staging table,
 * because some Xtream providers list the same stream_id under
 * multiple categories and a server-side PK violation mid-COPY is
 * exactly the failure mode we're working around.
 */
function dedupeBy(arr, keyFn) {
  const seen = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (k != null) seen.set(k, item);
  }
  return Array.from(seen.values());
}

module.exports = { tabEscape, writeCopyRow, streamRowsToCopy, dedupeBy };
