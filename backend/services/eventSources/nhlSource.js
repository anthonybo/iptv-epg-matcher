/**
 * NHL official API adapter (api-web.nhle.com — official, free, no auth).
 *
 * ESPN gets NHL right for regular season but the playoff tracking is
 * weak — period detail, live state lag, sometimes missing intermission
 * info. NHL's own API is real-time and includes tvBroadcasts per game.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const BASE_URL = 'https://api-web.nhle.com/v1';

// gameState (NHL): FUT (future), PRE (pregame), LIVE, CRIT, OFF (final)
function mapState(state, period, clock) {
    if (state === 'LIVE' || state === 'CRIT') {
        const periodLabel = period ? `P${period}` : '';
        const clockLabel = clock?.timeRemaining || '';
        return {
            isLive: true,
            statusType: 'STATUS_IN_PROGRESS',
            gameStatus: 'In Progress',
            gameClock: [clockLabel, periodLabel].filter(Boolean).join(' - ') || null,
        };
    }
    if (state === 'OFF' || state === 'FINAL') {
        return { isLive: false, statusType: 'STATUS_FINAL', gameStatus: 'Final', gameClock: null };
    }
    if (state === 'FUT' || state === 'PRE') {
        return { isLive: false, statusType: 'STATUS_SCHEDULED', gameStatus: 'Scheduled', gameClock: null };
    }
    return { isLive: false, statusType: null, gameStatus: null, gameClock: null };
}

function normaliseGame(game) {
    const home = game.homeTeam?.name?.default
        || game.homeTeam?.placeName?.default
        || '';
    const away = game.awayTeam?.name?.default
        || game.awayTeam?.placeName?.default
        || '';
    if (!home || !away || !game.startTimeUTC) return null;

    const startTime = game.startTimeUTC;
    const endTime = new Date(new Date(startTime).getTime() + 3.5 * 60 * 60 * 1000).toISOString();

    const state = mapState(game.gameState, game.period, game.clock);

    // Per-game broadcasters — much better than ESPN's metadata for NHL.
    const broadcasts = (game.tvBroadcasts || [])
        .map((b) => b.network)
        .filter(Boolean);

    return {
        sourceEventId: `nhl_${game.id}`,
        canonicalId: canonicalKey({
            sport: 'Hockey',
            home,
            away,
            startTime,
        }),
        sourceName: 'nhl',
        eventName: `${away} at ${home}`,
        sportType: 'Hockey',
        leagueName: 'NHL',
        homeTeam: home,
        awayTeam: away,
        eventStart: startTime,
        eventEnd: endTime,
        homeScore: game.homeTeam?.score ?? null,
        awayScore: game.awayTeam?.score ?? null,
        broadcasts,
        isLive: state.isLive,
        statusType: state.statusType,
        gameClock: state.gameClock,
        gameStatus: state.gameStatus,
    };
}

async function fetchEvents() {
    // /scoreboard/now is a rolling window — yesterday's finals, today's
    // live, tomorrow's scheduled. Single call, no need to glue dates.
    const url = `${BASE_URL}/scoreboard/now`;
    try {
        const resp = await axios.get(url, { timeout: 10000 });
        const dates = resp.data?.gamesByDate || [];
        const games = dates.flatMap((d) => d.games || []);
        const events = games.map(normaliseGame).filter(Boolean);
        logger.info(`[NHL] Fetched ${events.length} events (${games.length} raw)`);
        return events;
    } catch (e) {
        logger.warn(`[NHL] fetchEvents failed: ${e.message}`);
        return [];
    }
}

module.exports = {
    name: 'nhl',
    sports: ['Hockey'],
    enabled: () => true,
    fetchEvents,
};
