/**
 * MLB Stats API adapter (statsapi.mlb.com — official, free, no auth).
 *
 * ESPN's MLB scoreboard is fine for the casual ticker but MLB Stats
 * has richer per-game data: pitch-by-pitch state, accurate live flag,
 * spring training + minor league + exhibition games ESPN drops.
 *
 * Why also use ESPN for MLB then? Two reasons: ESPN gives broadcaster
 * names (we use them for channel matching) and we already have it.
 * The orchestrator dedupes by canonicalKey so the same game from both
 * sources gets merged — MLB Stats wins the score / live state, ESPN
 * keeps providing the broadcaster.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const BASE_URL = 'https://statsapi.mlb.com/api/v1';

function todayDateRange() {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

// abstractGameState: 'Live' | 'Final' | 'Preview'
// codedGameState: a single-letter ESPN-like code we map to STATUS_*
function mapStatus(abstractGameState, codedGameState, detailedState) {
    if (abstractGameState === 'Live') {
        return { isLive: true, statusType: 'STATUS_IN_PROGRESS', gameStatus: detailedState || 'In Progress' };
    }
    if (abstractGameState === 'Final') {
        return { isLive: false, statusType: 'STATUS_FINAL', gameStatus: detailedState || 'Final' };
    }
    if (codedGameState === 'P' || abstractGameState === 'Preview') {
        return { isLive: false, statusType: 'STATUS_SCHEDULED', gameStatus: detailedState || 'Scheduled' };
    }
    return { isLive: false, statusType: null, gameStatus: detailedState || null };
}

function normaliseGame(game) {
    const home = game.teams?.home?.team?.name || '';
    const away = game.teams?.away?.team?.name || '';
    if (!home || !away || !game.gameDate) return null;

    const startTime = game.gameDate;
    // MLB games are wildly variable in length. 4h is a generous cap that
    // matches our query window in liveScoresService.
    const endTime = new Date(new Date(startTime).getTime() + 4 * 60 * 60 * 1000).toISOString();

    const status = mapStatus(
        game.status?.abstractGameState,
        game.status?.codedGameState,
        game.status?.detailedState
    );

    // Derive a useful clock string. Linescore has currentInning + half.
    const linescore = game.linescore || {};
    let gameClock = null;
    if (status.isLive && linescore.currentInning) {
        const half = linescore.inningHalf === 'Top' ? '↑' : linescore.inningHalf === 'Bottom' ? '↓' : '';
        gameClock = `${half}${linescore.currentInning}`;
    }

    return {
        sourceEventId: `mlbstats_${game.gamePk}`,
        canonicalId: canonicalKey({
            sport: 'Baseball',
            home,
            away,
            startTime,
        }),
        sourceName: 'mlbstats',
        eventName: `${away} at ${home}`,
        sportType: 'Baseball',
        leagueName: 'MLB',
        homeTeam: home,
        awayTeam: away,
        eventStart: startTime,
        eventEnd: endTime,
        homeScore: game.teams?.home?.score ?? null,
        awayScore: game.teams?.away?.score ?? null,
        broadcasts: [], // MLB Stats has tv listings under /broadcast — fetched only on demand
        isLive: status.isLive,
        statusType: status.statusType,
        gameClock,
        gameStatus: status.gameStatus,
    };
}

async function fetchEvents() {
    const [start, end] = todayDateRange();
    // sportId=1 = MLB. hydrate=linescore brings inning/half into the
    // schedule response so we don't need a second call per live game.
    const url = `${BASE_URL}/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=linescore`;
    try {
        const resp = await axios.get(url, { timeout: 10000 });
        const dates = resp.data?.dates || [];
        const games = dates.flatMap((d) => d.games || []);
        const events = games.map(normaliseGame).filter(Boolean);
        logger.info(`[MLBStats] Fetched ${events.length} events (${games.length} raw)`);
        return events;
    } catch (e) {
        logger.warn(`[MLBStats] fetchEvents failed: ${e.message}`);
        return [];
    }
}

module.exports = {
    name: 'mlbstats',
    sports: ['Baseball'],
    enabled: () => true,
    fetchEvents,
};
