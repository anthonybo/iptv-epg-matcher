/**
 * CricAPI / Cricbuzz adapter — cricket-specific filler.
 *
 * Two reasonable paths:
 *
 *   - cricapi.com — paid SaaS, 100 req/day free, 25 req/min on paid.
 *     Has live scores for IPL/PSL/CPL/SA20/T20/ODI/Test. Set
 *     CRICAPI_KEY env var to enable.
 *
 *   - rapidapi.com cricbuzz-cricket — alternative wrapper around
 *     Cricbuzz scoreboards. Set RAPIDAPI_CRICBUZZ_KEY to enable.
 *
 * Use this only if API-Sports cricket is too pricey but you still
 * need IPL coverage. Otherwise prefer apiSportsSource for cricket.
 *
 * This is a stub — wiring is in place so the orchestrator picks it up
 * when an env var is set; the actual HTTP calls are TODO until a key
 * is configured and we know which provider to commit to.
 */

const logger = require('../../config/logger');

const CRICAPI_KEY = process.env.CRICAPI_KEY;
const RAPIDAPI_CRICBUZZ_KEY = process.env.RAPIDAPI_CRICBUZZ_KEY;

async function fetchEvents() {
    if (!CRICAPI_KEY && !RAPIDAPI_CRICBUZZ_KEY) return [];
    logger.warn('[CricAPI] Adapter is a stub. Pick provider (CRICAPI_KEY or RAPIDAPI_CRICBUZZ_KEY) and implement fetchEvents().');
    return [];
}

module.exports = {
    name: 'cricapi',
    sports: ['Cricket'],
    enabled: () => Boolean(CRICAPI_KEY || RAPIDAPI_CRICBUZZ_KEY),
    fetchEvents,
};
