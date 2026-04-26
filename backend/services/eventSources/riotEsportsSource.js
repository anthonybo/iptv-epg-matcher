/**
 * Riot Esports adapter — League of Legends pro schedules.
 *
 * Free with API key registration at https://developer.riotgames.com/.
 * The relevant endpoint is the lolesports/persisted/gw/getSchedule API
 * which lists events from LCS / LEC / LCK / LPL / Worlds / MSI etc.
 *
 * Set RIOT_ESPORTS_API_KEY in backend/.env to enable. Until then this
 * adapter is a no-op stub so the orchestrator can include it without
 * blowing up.
 *
 * Esports landscape: LoL is well-served by this. Dota2/Valorant/CS2/
 * Overwatch each have their own splintered APIs — easier to ingest
 * via Liquipedia (see liquipediaSource.js) which aggregates all of
 * them with a single MediaWiki API.
 */

const logger = require('../../config/logger');

const API_KEY = process.env.RIOT_ESPORTS_API_KEY;

async function fetchEvents() {
    if (!API_KEY) return [];
    logger.warn('[RiotEsports] Adapter is a stub. Set RIOT_ESPORTS_API_KEY and implement fetchEvents().');
    return [];
}

module.exports = {
    name: 'riot',
    sports: ['Esports'],
    enabled: () => Boolean(API_KEY),
    fetchEvents,
};
