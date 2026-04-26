/**
 * Canonical event-key generation. Different data sources (ESPN, MLB
 * Stats, NHL, TheSportsDB) emit the same MLB or NHL game under their
 * own IDs — without a deterministic dedup key the ticker would show
 * the same matchup multiple times.
 *
 * The key is a SHA1 of the lowercased + scrubbed (sport | home | away
 * | start-rounded-to-hour). All adapters use the same generator so
 * they collide cleanly.
 */

const crypto = require('crypto');

function scrub(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // strip accents
        .replace(/[^a-z0-9 ]+/g, ' ')      // strip non-alphanumeric
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Round an ISO date down to the hour. Different sources can disagree
 * by a few minutes on start time (scheduling drift, rounding). Hour
 * granularity is loose enough to merge those without folding genuinely
 * different games together.
 */
function startHour(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
}

/**
 * sport: e.g. 'Baseball', 'Soccer'
 * home / away: team display names (we scrub them — no need to
 *   pre-normalise)
 * startTime: ISO string
 *
 * Returns a 16-char hex prefix of the SHA1 of the canonical tuple.
 * 16 hex chars = 64 bits, plenty for collision-free dedup at our scale.
 */
function canonicalKey({ sport, home, away, startTime }) {
    const tuple = [scrub(sport), scrub(home), scrub(away), startHour(startTime)].join('|');
    return crypto.createHash('sha1').update(tuple).digest('hex').slice(0, 16);
}

module.exports = { canonicalKey, scrub, startHour };
