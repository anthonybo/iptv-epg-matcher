/**
 * API-Sports adapter (RapidAPI / api-sports.io family — paid).
 *
 * The "gold standard for breadth" data source. Real-time scores for:
 *   - api-football.com (every soccer league worldwide)
 *   - api-cricket.com (IPL + every other cricket league)
 *   - api-basketball.com
 *   - api-rugby.com
 *   - api-baseball.com
 *
 * Free tier exists (100 req/day per service) but is too tight for our
 * 3h refresh × ~6 sports — only useful for cricket where ESPN gaps out.
 * Paid tiers are $10-30/month per service.
 *
 * To enable: get an API key at https://dashboard.api-football.com/ (or
 * the relevant sport), set API_SPORTS_KEY in backend/.env. Choose
 * which sports to enable per-service via API_SPORTS_ENABLE_FOOTBALL=1,
 * API_SPORTS_ENABLE_CRICKET=1, etc.
 *
 * For cricket especially: this is the only realistic path to live IPL /
 * BBL / SA20 / WPL coverage in this app. ESPN doesn't have it,
 * TheSportsDB free tier has schedules but no live scores.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const { canonicalKey } = require('./canonical');

const API_KEY = process.env.API_SPORTS_KEY;
const ENABLE_FOOTBALL = process.env.API_SPORTS_ENABLE_FOOTBALL === '1';
const ENABLE_CRICKET = process.env.API_SPORTS_ENABLE_CRICKET === '1';

// TODO: implement service-specific fetchers when a key is provided.
// The shape of each api-sports.io service differs slightly so we'll
// add them on demand. For now this stub keeps the orchestrator wiring
// consistent without making any HTTP calls.
async function fetchEvents() {
    if (!API_KEY) return [];
    logger.warn('[ApiSports] Adapter is a stub. See file header for which env vars to set when implementing.');
    return [];
}

module.exports = {
    name: 'apisports',
    sports: ['Soccer', 'Cricket', 'Basketball', 'Rugby', 'Baseball'],
    enabled: () => Boolean(API_KEY) && (ENABLE_FOOTBALL || ENABLE_CRICKET),
    fetchEvents,
};
