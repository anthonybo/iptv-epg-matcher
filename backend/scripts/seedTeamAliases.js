#!/usr/bin/env node
/**
 * One-shot importer: fetch every league in teamAliasesService.SPORT_LEAGUES
 * from ESPN's public API, upsert into the team_aliases table.
 *
 * Run:
 *   node backend/scripts/seedTeamAliases.js
 *
 * Safe to re-run. Idempotent — upserts by (league, espn_team_id).
 */

const teamAliases = require('../services/teamAliasesService');
const logger = require('../config/logger');

(async () => {
  try {
    await teamAliases.initialize();
    const result = await teamAliases.seedFromEspn();
    logger.info(
      `[SeedTeamAliases] Done. ${result.inserted} rows upserted, ${result.failed} leagues failed`
    );
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (err) {
    logger.error(`[SeedTeamAliases] Fatal: ${err.message}`);
    process.exit(1);
  }
})();
