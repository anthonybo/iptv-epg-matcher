/**
 * Football-Data.org adapter (free tier, requires registration).
 *
 * Free tier: 10 req/min, soccer leagues including Premier League,
 * Bundesliga, La Liga, Serie A, Ligue 1, Champions League, Eredivisie,
 * Primeira Liga, plus Brazil/Argentina/MLS in some plans.
 *
 * To enable: register at https://www.football-data.org/client/register
 * for a free API key, set FOOTBALL_DATA_API_KEY in backend/.env, restart.
 *
 * What this fills: ESPN already covers most major soccer leagues, but
 * Football-Data has cleaner score timing on European leagues and
 * occasionally catches matches ESPN misses.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

// Competition codes that come with the free tier. Add more if your
// plan covers them.
const COMPETITIONS = [
    { code: 'PL', name: 'Premier League' },
    { code: 'BL1', name: 'Bundesliga' },
    { code: 'PD', name: 'La Liga' },
    { code: 'SA', name: 'Serie A' },
    { code: 'FL1', name: 'Ligue 1' },
    { code: 'DED', name: 'Eredivisie' },
    { code: 'PPL', name: 'Primeira Liga' },
    { code: 'CL', name: 'UEFA Champions League' },
    { code: 'EL', name: 'UEFA Europa League' },
    { code: 'WC', name: 'FIFA World Cup' },
    { code: 'EC', name: 'European Championship' },
    { code: 'CLI', name: 'Copa Libertadores' },
    { code: 'BSA', name: 'Brasileirão Série A' },
];

// Football-Data status: SCHEDULED, TIMED, IN_PLAY, PAUSED, FINISHED, etc.
function mapStatus(status) {
    if (status === 'IN_PLAY' || status === 'PAUSED') {
        return { isLive: true, statusType: 'STATUS_IN_PROGRESS', gameStatus: status };
    }
    if (status === 'FINISHED') {
        return { isLive: false, statusType: 'STATUS_FINAL', gameStatus: 'Final' };
    }
    return { isLive: false, statusType: 'STATUS_SCHEDULED', gameStatus: 'Scheduled' };
}

function normaliseMatch(match, competitionName) {
    const home = match.homeTeam?.name || '';
    const away = match.awayTeam?.name || '';
    if (!home || !away || !match.utcDate) return null;

    const startTime = match.utcDate;
    const endTime = new Date(new Date(startTime).getTime() + 2.5 * 60 * 60 * 1000).toISOString();
    const status = mapStatus(match.status);

    return {
        sourceEventId: `footdata_${match.id}`,
        canonicalId: canonicalKey({ sport: 'Soccer', home, away, startTime }),
        sourceName: 'footdata',
        eventName: `${away} at ${home}`,
        sportType: 'Soccer',
        leagueName: competitionName,
        homeTeam: home,
        awayTeam: away,
        eventStart: startTime,
        eventEnd: endTime,
        homeScore: match.score?.fullTime?.home ?? null,
        awayScore: match.score?.fullTime?.away ?? null,
        broadcasts: [],
        isLive: status.isLive,
        statusType: status.statusType,
        gameClock: match.minute ? `${match.minute}'` : null,
        gameStatus: status.gameStatus,
    };
}

async function fetchEvents() {
    const all = [];
    for (const { code, name } of COMPETITIONS) {
        try {
            const resp = await axios.get(`${BASE_URL}/competitions/${code}/matches`, {
                headers: { 'X-Auth-Token': API_KEY },
                params: { dateFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
                          dateTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) },
                timeout: 10000,
            });
            const matches = resp.data?.matches || [];
            const events = matches.map((m) => normaliseMatch(m, name)).filter(Boolean);
            if (events.length) {
                logger.info(`[FootballData] ${name}: ${events.length} events`);
            }
            all.push(...events);
        } catch (e) {
            // 429 = rate limit; just back off — next refresh tick will retry.
            if (e.response?.status !== 404) {
                logger.debug(`[FootballData] ${name}: ${e.message}`);
            }
        }
    }
    return all;
}

module.exports = {
    name: 'footdata',
    sports: ['Soccer'],
    enabled: () => Boolean(API_KEY),
    fetchEvents,
};
