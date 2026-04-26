/**
 * OpenLigaDB adapter (free, no auth).
 *
 * Public German-focused sports data: Bundesliga (men + women), 2.
 * Bundesliga, NFL, Formula 1, Handball Bundesliga, Basketball
 * Bundesliga, Eishockey DEL, more. Operated by community/openliga.
 *
 * Coverage gap fills primarily for German sports — DEL hockey, BBL
 * basketball, Handball — that ESPN doesn't track.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const BASE_URL = 'https://api.openligadb.de';

const LEAGUES = [
    { shortcut: 'bl1', sport: 'Soccer', name: 'Bundesliga' },
    { shortcut: 'bl2', sport: 'Soccer', name: '2. Bundesliga' },
    { shortcut: 'fblw', sport: 'Soccer', name: 'Frauen-Bundesliga' },
    { shortcut: 'del', sport: 'Hockey', name: 'DEL' },
    { shortcut: 'bbl', sport: 'Basketball', name: 'Basketball Bundesliga' },
    { shortcut: 'hbl', sport: 'Handball', name: 'Handball Bundesliga' },
];

function currentSeason() {
    // OpenLigaDB seasons start in summer for many sports. Use current
    // year; the API returns matches across the season regardless.
    return new Date().getUTCFullYear().toString();
}

function normaliseMatch(match, leagueSport, leagueName) {
    const home = match.team1?.teamName || '';
    const away = match.team2?.teamName || '';
    if (!home || !away || !match.matchDateTimeUTC) return null;
    const startTime = match.matchDateTimeUTC;
    const endTime = new Date(new Date(startTime).getTime() + 2.5 * 60 * 60 * 1000).toISOString();

    const finalResult = (match.matchResults || []).find((r) => r.resultName === 'Endergebnis')
        || (match.matchResults || [])[0];
    const homeScore = finalResult?.pointsTeam1 ?? null;
    const awayScore = finalResult?.pointsTeam2 ?? null;

    const isFinished = match.matchIsFinished === true;
    const startMs = new Date(startTime).getTime();
    const isLive = !isFinished && Date.now() >= startMs && Date.now() <= startMs + 2.5 * 60 * 60 * 1000;

    return {
        sourceEventId: `openliga_${match.matchID}`,
        canonicalId: canonicalKey({ sport: leagueSport, home, away, startTime }),
        sourceName: 'openliga',
        eventName: `${away} at ${home}`,
        sportType: leagueSport,
        leagueName,
        homeTeam: home,
        awayTeam: away,
        eventStart: startTime,
        eventEnd: endTime,
        homeScore,
        awayScore,
        broadcasts: [],
        isLive,
        statusType: isFinished ? 'STATUS_FINAL' : (isLive ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED'),
        gameClock: null,
        gameStatus: isFinished ? 'Final' : (isLive ? 'In Progress' : 'Scheduled'),
    };
}

async function fetchEvents() {
    const season = currentSeason();
    const all = [];
    for (const { shortcut, sport, name } of LEAGUES) {
        try {
            const resp = await axios.get(`${BASE_URL}/getmatchdata/${shortcut}/${season}`, { timeout: 10000 });
            const matches = Array.isArray(resp.data) ? resp.data : [];
            const events = matches.map((m) => normaliseMatch(m, sport, name)).filter(Boolean);
            if (events.length) {
                logger.info(`[OpenLigaDB] ${name}: ${events.length} events`);
            }
            all.push(...events);
        } catch (e) {
            logger.debug(`[OpenLigaDB] ${name}: ${e.message}`);
        }
    }
    return all;
}

module.exports = {
    name: 'openliga',
    sports: ['Soccer', 'Hockey', 'Basketball', 'Handball'],
    enabled: () => true,
    fetchEvents,
};
