/**
 * Landmark fingerprint matcher — Shazam-style offset-histogram alignment.
 *
 * The fingerprinter (stream-audio-fingerprint / codegen_landmark) emits
 * { hcode, t } pairs, where hcode is an integer landmark hash and t is the
 * codegen frame index (~11.6 ms per frame at 22050 Hz / 256 step).
 *
 * Two recordings of the SAME audio produce the same hcodes at the same
 * relative spacing, so when you line up a query against a reference, the
 * matching hashes all share a CONSTANT time offset (off = refT - queryT).
 * A genuine match shows up as a tall spike in the histogram of offsets; noise
 * is spread thin across many offsets. This is the entire trick behind both:
 *   - cross-channel repetition detection (query = one channel's recent audio,
 *     reference = other channels' recent audio), and
 *   - live ad matching (query = a channel's recent audio, reference = the
 *     catalogued ad creatives).
 *
 * The same recording decoded twice can jitter by ±1 frame at the FFT window
 * boundary, so we merge each offset bin with its immediate neighbours
 * (OFFSET_TOLERANCE) when scoring, and score by the number of DISTINCT query
 * landmarks aligned (not raw pair count) so duplicate hashes can't inflate it.
 */

const FRAME_MS = (256 / 22050) * 1000; // ≈ 11.61 ms per codegen frame index

/**
 * Build a lookup index from a flat list of reference fingerprints.
 * @param {Array<{id:(string|number), hcode:number, t:number}>} entries
 * @returns {Map<number, Array<{id:(string|number), t:number}>>} hcode -> refs
 */
function buildIndex(entries) {
  const index = new Map();
  for (const e of entries) {
    let arr = index.get(e.hcode);
    if (!arr) { arr = []; index.set(e.hcode, arr); }
    arr.push({ id: e.id, t: e.t });
  }
  return index;
}

/**
 * Align a query fingerprint set against a prebuilt reference index.
 *
 * @param {Array<{hcode:number, t:number}>} queryFps
 * @param {Map<number, Array<{id, t}>>} index  (from buildIndex)
 * @param {object} [opts]
 * @param {number} [opts.offsetTolerance=1]  merge ±N adjacent offset bins
 * @returns {Array<{id, offset, count, qtMinFrames, qtMaxFrames, spanMs,
 *                   matchedQueryIdx:number[]}>}  best match per id, count-desc
 */
function match(queryFps, index, opts = {}) {
  const tol = opts.offsetTolerance != null ? opts.offsetTolerance : 1;
  if (!queryFps.length || index.size === 0) return [];

  // raw bins: id -> Map<offset, Set<queryIdx>>
  const bins = new Map();
  for (let qi = 0; qi < queryFps.length; qi++) {
    const q = queryFps[qi];
    const refs = index.get(q.hcode);
    if (!refs) continue;
    for (const r of refs) {
      const offset = r.t - q.t;
      let byOff = bins.get(r.id);
      if (!byOff) { byOff = new Map(); bins.set(r.id, byOff); }
      let qset = byOff.get(offset);
      if (!qset) { qset = new Set(); byOff.set(offset, qset); }
      qset.add(qi);
    }
  }

  const results = [];
  for (const [id, byOff] of bins) {
    const offsets = Array.from(byOff.keys());
    let best = null;
    for (const center of offsets) {
      // Merge this offset with its neighbours (±tol) to absorb frame jitter.
      const merged = new Set();
      for (let o = center - tol; o <= center + tol; o++) {
        const s = byOff.get(o);
        if (s) for (const qi of s) merged.add(qi);
      }
      if (!best || merged.size > best.count) {
        let qMin = Infinity, qMax = -Infinity;
        for (const qi of merged) {
          const t = queryFps[qi].t;
          if (t < qMin) qMin = t;
          if (t > qMax) qMax = t;
        }
        best = {
          id,
          offset: center,
          count: merged.size,
          qtMinFrames: qMin,
          qtMaxFrames: qMax,
          spanMs: (qMax - qMin) * FRAME_MS,
          matchedQueryIdx: Array.from(merged).sort((a, b) => a - b)
        };
      }
    }
    if (best) results.push(best);
  }

  results.sort((a, b) => b.count - a.count);
  return results;
}

/**
 * Decide whether a match result clears the strength bar: enough aligned
 * landmarks AND covering a long-enough span (a few colliding hashes over
 * 200ms is noise; 30+ landmarks aligned over 4s+ is a real repeat).
 */
function isStrong(m, { minCount = 20, minSpanMs = 3000 } = {}) {
  return !!m && m.count >= minCount && m.spanMs >= minSpanMs;
}

module.exports = { buildIndex, match, isStrong, FRAME_MS };
