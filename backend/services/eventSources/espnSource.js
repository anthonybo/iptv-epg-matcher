/**
 * ESPN scoreboard adapter — primary discovery source for North-American
 * + major-international sports.
 *
 * The big sports list (SPORTS_TO_FETCH) lives here; liveScoresService
 * imports it for its score-update tick. ~100 endpoints across 23 sports.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const ESPN_BASE_URL = 'http://site.api.espn.com/apis/site/v2/sports';

const SPORTS_TO_FETCH = [
    // American Football
    { sport: 'football', league: 'nfl', name: 'NFL' },
    { sport: 'football', league: 'college-football', name: 'NCAAF' },

    // Basketball
    { sport: 'basketball', league: 'nba', name: 'NBA' },
    { sport: 'basketball', league: 'wnba', name: 'WNBA' },
    { sport: 'basketball', league: 'mens-college-basketball', name: 'NCAAB' },
    { sport: 'basketball', league: 'womens-college-basketball', name: 'WCAAB' },
    { sport: 'basketball', league: 'nbl', name: 'NBL (Australia)' },
    { sport: 'basketball', league: 'euroleague', name: 'EuroLeague' },
    { sport: 'basketball', league: 'eurocup', name: 'EuroCup' },

    // Hockey
    { sport: 'hockey', league: 'nhl', name: 'NHL' },
    { sport: 'hockey', league: 'mens-college-hockey', name: 'NCAA Men\'s Hockey' },
    { sport: 'hockey', league: 'womens-college-hockey', name: 'NCAA Women\'s Hockey' },
    { sport: 'hockey', league: 'ahl', name: 'AHL' },

    // Baseball / Softball
    { sport: 'baseball', league: 'mlb', name: 'MLB' },
    { sport: 'baseball', league: 'college-baseball', name: 'College Baseball' },
    { sport: 'baseball', league: 'college-world-series', name: 'College World Series' },
    { sport: 'baseball', league: 'world-baseball-classic', name: 'World Baseball Classic' },
    { sport: 'softball', league: 'college-softball', name: 'College Softball' },
    { sport: 'softball', league: 'college-womens-college-world-series', name: 'WCWS' },
    { sport: 'softball', league: 'usssa-pro', name: 'USSSA Pro Softball' },

    // Soccer — Domestic top flights
    { sport: 'soccer', league: 'usa.1', name: 'MLS' },
    { sport: 'soccer', league: 'usa.2', name: 'USL Championship' },
    { sport: 'soccer', league: 'usa.nwsl', name: 'NWSL' },
    { sport: 'soccer', league: 'usa.ncaa.m.1', name: 'NCAA Men\'s Soccer' },
    { sport: 'soccer', league: 'usa.ncaa.w.1', name: 'NCAA Women\'s Soccer' },
    { sport: 'soccer', league: 'usa.open', name: 'US Open Cup' },
    { sport: 'soccer', league: 'eng.1', name: 'Premier League' },
    { sport: 'soccer', league: 'eng.2', name: 'EFL Championship' },
    { sport: 'soccer', league: 'eng.3', name: 'EFL League One' },
    { sport: 'soccer', league: 'eng.fa', name: 'FA Cup' },
    { sport: 'soccer', league: 'eng.league_cup', name: 'EFL Cup' },
    { sport: 'soccer', league: 'esp.1', name: 'La Liga' },
    { sport: 'soccer', league: 'esp.2', name: 'La Liga 2' },
    { sport: 'soccer', league: 'esp.copa_del_rey', name: 'Copa del Rey' },
    { sport: 'soccer', league: 'ger.1', name: 'Bundesliga' },
    { sport: 'soccer', league: 'ger.2', name: '2. Bundesliga' },
    { sport: 'soccer', league: 'ger.dfb_pokal', name: 'DFB Pokal' },
    { sport: 'soccer', league: 'ita.1', name: 'Serie A' },
    { sport: 'soccer', league: 'ita.2', name: 'Serie B' },
    { sport: 'soccer', league: 'ita.coppa_italia', name: 'Coppa Italia' },
    { sport: 'soccer', league: 'fra.1', name: 'Ligue 1' },
    { sport: 'soccer', league: 'fra.2', name: 'Ligue 2' },
    { sport: 'soccer', league: 'fra.coupe_de_france', name: 'Coupe de France' },
    { sport: 'soccer', league: 'ned.1', name: 'Eredivisie' },
    { sport: 'soccer', league: 'por.1', name: 'Primeira Liga' },
    { sport: 'soccer', league: 'sco.1', name: 'Scottish Premiership' },
    { sport: 'soccer', league: 'bel.1', name: 'Belgian Pro League' },
    { sport: 'soccer', league: 'aut.1', name: 'Austrian Bundesliga' },
    { sport: 'soccer', league: 'swi.1', name: 'Swiss Super League' },
    { sport: 'soccer', league: 'turkey.1', name: 'Turkish Süper Lig' },
    { sport: 'soccer', league: 'rus.1', name: 'Russian Premier League' },
    { sport: 'soccer', league: 'mex.1', name: 'Liga MX' },
    { sport: 'soccer', league: 'mex.2', name: 'Ascenso MX' },
    { sport: 'soccer', league: 'arg.1', name: 'Argentine Primera' },
    { sport: 'soccer', league: 'bra.1', name: 'Brasileirão Série A' },
    { sport: 'soccer', league: 'bra.2', name: 'Brasileirão Série B' },
    { sport: 'soccer', league: 'aus.1', name: 'A-League' },
    { sport: 'soccer', league: 'jpn.1', name: 'J League' },
    { sport: 'soccer', league: 'kor.1', name: 'K League' },
    { sport: 'soccer', league: 'chn.1', name: 'Chinese Super League' },
    { sport: 'soccer', league: 'sau.1', name: 'Saudi Pro League' },
    { sport: 'soccer', league: 'uae.1', name: 'UAE Pro League' },
    { sport: 'soccer', league: 'qat.1', name: 'Qatar Stars League' },

    // Soccer — Continental / international
    { sport: 'soccer', league: 'uefa.champions', name: 'Champions League' },
    { sport: 'soccer', league: 'uefa.europa', name: 'Europa League' },
    { sport: 'soccer', league: 'uefa.europa.conf', name: 'Europa Conference League' },
    { sport: 'soccer', league: 'uefa.nations', name: 'UEFA Nations League' },
    { sport: 'soccer', league: 'uefa.euro', name: 'UEFA Euro' },
    { sport: 'soccer', league: 'fifa.world', name: 'FIFA World Cup' },
    { sport: 'soccer', league: 'fifa.womens.world', name: 'FIFA Women\'s World Cup' },
    { sport: 'soccer', league: 'fifa.cwc', name: 'FIFA Club World Cup' },
    { sport: 'soccer', league: 'conmebol.libertadores', name: 'Copa Libertadores' },
    { sport: 'soccer', league: 'conmebol.sudamericana', name: 'Copa Sudamericana' },
    { sport: 'soccer', league: 'concacaf.champions', name: 'Concacaf Champions Cup' },
    { sport: 'soccer', league: 'concacaf.gold', name: 'Gold Cup' },

    // Combat Sports
    { sport: 'mma', league: 'ufc', name: 'UFC' },
    { sport: 'mma', league: 'pfl', name: 'PFL' },
    { sport: 'mma', league: 'bellator', name: 'Bellator' },
    { sport: 'boxing', league: '', name: 'Boxing' },
    { sport: 'wrestling', league: '', name: 'Wrestling' },

    // Golf
    { sport: 'golf', league: 'pga', name: 'PGA Tour' },
    { sport: 'golf', league: 'lpga', name: 'LPGA Tour' },
    { sport: 'golf', league: 'european-tour', name: 'DP World Tour' },
    { sport: 'golf', league: 'champions-tour', name: 'PGA Champions Tour' },
    { sport: 'golf', league: 'korn-ferry', name: 'Korn Ferry Tour' },
    { sport: 'golf', league: 'liv-golf', name: 'LIV Golf' },
    { sport: 'golf', league: 'the-masters', name: 'The Masters' },
    { sport: 'golf', league: 'the-open', name: 'The Open Championship' },
    { sport: 'golf', league: 'us-open', name: 'US Open Golf' },
    { sport: 'golf', league: 'pga-championship', name: 'PGA Championship' },

    // Tennis
    { sport: 'tennis', league: 'atp', name: 'ATP' },
    { sport: 'tennis', league: 'wta', name: 'WTA' },
    { sport: 'tennis', league: 'atp-doubles', name: 'ATP Doubles' },
    { sport: 'tennis', league: 'wta-doubles', name: 'WTA Doubles' },
    { sport: 'tennis', league: 'mens-grand-slam', name: 'Men\'s Grand Slam' },
    { sport: 'tennis', league: 'womens-grand-slam', name: 'Women\'s Grand Slam' },

    // Motorsports
    { sport: 'racing', league: 'f1', name: 'Formula 1' },
    { sport: 'racing', league: 'irl', name: 'IndyCar' },
    { sport: 'racing', league: 'nascar-premier', name: 'NASCAR Cup' },
    { sport: 'racing', league: 'nascar-secondary', name: 'NASCAR Xfinity' },
    { sport: 'racing', league: 'nascar-truck', name: 'NASCAR Truck' },
    { sport: 'racing', league: 'nhra', name: 'NHRA' },
    { sport: 'racing', league: 'motogp', name: 'MotoGP' },
    { sport: 'racing', league: 'formula-e', name: 'Formula E' },

    // Lacrosse
    { sport: 'lacrosse', league: 'mens-college-lacrosse', name: 'NCAA Men\'s Lacrosse' },
    { sport: 'lacrosse', league: 'womens-college-lacrosse', name: 'NCAA Women\'s Lacrosse' },
    { sport: 'lacrosse', league: 'pll', name: 'Premier Lacrosse League' },
    { sport: 'lacrosse', league: 'nll', name: 'National Lacrosse League' },

    // Volleyball
    { sport: 'volleyball', league: 'mens-college-volleyball', name: 'NCAA Men\'s Volleyball' },
    { sport: 'volleyball', league: 'womens-college-volleyball', name: 'NCAA Women\'s Volleyball' },
    { sport: 'volleyball', league: 'pvf', name: 'Pro Volleyball Federation' },
    { sport: 'volleyball', league: 'lovb', name: 'League One Volleyball' },

    // Rugby
    { sport: 'rugby', league: 'super-rugby', name: 'Super Rugby' },
    { sport: 'rugby', league: 'world-rugby', name: 'World Rugby' },
    { sport: 'rugby', league: '180659', name: 'Six Nations' },
    { sport: 'rugby-league', league: 'nrl', name: 'NRL' },

    // Cricket
    { sport: 'cricket', league: 'ipl', name: 'IPL' },
    { sport: 'cricket', league: 'big-bash', name: 'Big Bash' },
    { sport: 'cricket', league: 'world-cup', name: 'Cricket World Cup' },
    { sport: 'cricket', league: 'eng.county-championship', name: 'County Championship' },

    // Australian Rules
    { sport: 'australian-football', league: 'afl', name: 'AFL' },
    { sport: 'australian-football', league: 'aflw', name: 'AFLW' },

    // Field Hockey
    { sport: 'field-hockey', league: 'mens-college-field-hockey', name: 'NCAA Men\'s Field Hockey' },
    { sport: 'field-hockey', league: 'womens-college-field-hockey', name: 'NCAA Women\'s Field Hockey' },

    // Olympics
    { sport: 'olympics', league: 'summer', name: 'Summer Olympics' },
    { sport: 'olympics', league: 'winter', name: 'Winter Olympics' },

    // Horse Racing
    { sport: 'horse-racing', league: 'horse-racing', name: 'Horse Racing' },
    { sport: 'horse-racing', league: 'triple-crown', name: 'Triple Crown' },

    // Esports
    { sport: 'esports', league: 'esports', name: 'Esports' },
];

const SPORT_DISPLAY_MAP = {
    'football': 'Football',
    'basketball': 'Basketball',
    'hockey': 'Hockey',
    'soccer': 'Soccer',
    'baseball': 'Baseball',
    'softball': 'Softball',
    'mma': 'MMA',
    'boxing': 'Boxing',
    'wrestling': 'Wrestling',
    'golf': 'Golf',
    'tennis': 'Tennis',
    'racing': 'Racing',
    'lacrosse': 'Lacrosse',
    'volleyball': 'Volleyball',
    'rugby': 'Rugby',
    'rugby-league': 'Rugby League',
    'cricket': 'Cricket',
    'australian-football': 'Australian Football',
    'field-hockey': 'Field Hockey',
    'olympics': 'Olympics',
    'horse-racing': 'Horse Racing',
    'esports': 'Esports'
};

function getSportDisplayName(sport) {
    return SPORT_DISPLAY_MAP[sport] || sport;
}

async function fetchScoreboard(sport, league) {
    try {
        const url = league
            ? `${ESPN_BASE_URL}/${sport}/${league}/scoreboard`
            : `${ESPN_BASE_URL}/${sport}/scoreboard`;
        const resp = await axios.get(url, { timeout: 10000 });
        return resp.data?.events || [];
    } catch (e) {
        if (e.response?.status !== 404) {
            logger.debug(`[ESPN] ${sport}/${league}: ${e.message}`);
        }
        return [];
    }
}

function normaliseEvent(event, sportKey, leagueDisplayName) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    const homeTeam = competitors.find((c) => c.homeAway === 'home');
    const awayTeam = competitors.find((c) => c.homeAway === 'away');
    const home = homeTeam?.team?.displayName || 'Unknown';
    const away = awayTeam?.team?.displayName || 'Unknown';

    const startTime = event.date;
    const endTime = event.endDate
        ? event.endDate
        : new Date(new Date(startTime).getTime() + 3 * 60 * 60 * 1000).toISOString();

    // Broadcasters airing the game.
    const broadcasts = new Set();
    for (const b of competition?.broadcasts || []) {
        for (const n of b.names || []) {
            if (n) broadcasts.add(String(n).trim());
        }
    }
    for (const g of competition?.geoBroadcasts || []) {
        const name = g?.media?.shortName || g?.media?.callLetters;
        if (name) broadcasts.add(String(name).trim());
    }

    const sportType = getSportDisplayName(sportKey);

    return {
        sourceEventId: `espn_${event.id}`,
        // Don't compute canonicalKey for events with Unknown teams
        // (golf tournaments, races, ufc cards) — they aren't really
        // dedupable across sources by team signature.
        canonicalId: (home !== 'Unknown' && away !== 'Unknown')
            ? canonicalKey({ sport: sportType, home, away, startTime })
            : null,
        sourceName: 'espn',
        eventName: event.name || `${home} vs ${away}`,
        sportType,
        leagueName: leagueDisplayName,
        homeTeam: home,
        awayTeam: away,
        eventStart: startTime,
        eventEnd: endTime,
        broadcasts: Array.from(broadcasts),
        // ESPN's scoreboard shows score+state at fetch time too; capture
        // it so we don't have to wait for the score updater's first tick.
        homeScore: homeTeam?.score != null ? parseInt(homeTeam.score, 10) || null : null,
        awayScore: awayTeam?.score != null ? parseInt(awayTeam.score, 10) || null : null,
        isLive: competition?.status?.type?.state === 'in',
        statusType: competition?.status?.type?.name || null,
        gameClock: competition?.status?.type?.shortDetail || null,
        gameStatus: competition?.status?.type?.description || null,
    };
}

async function fetchEvents() {
    const all = [];
    const batchSize = 5;
    for (let i = 0; i < SPORTS_TO_FETCH.length; i += batchSize) {
        const batch = SPORTS_TO_FETCH.slice(i, i + batchSize);
        const results = await Promise.all(
            batch.map(async ({ sport, league, name }) => {
                const events = await fetchScoreboard(sport, league);
                if (events.length > 0) {
                    logger.debug(`[ESPN] ${name}: ${events.length} events`);
                }
                return events.map((e) => normaliseEvent(e, sport, name));
            })
        );
        for (const arr of results) all.push(...arr);
    }
    return all;
}

module.exports = {
    name: 'espn',
    sports: Array.from(new Set(SPORTS_TO_FETCH.map((s) => getSportDisplayName(s.sport)))),
    enabled: () => true,
    fetchEvents,
    SPORTS_TO_FETCH,
    getSportDisplayName,
};
