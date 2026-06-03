/**
 * AI match stats writer + reader.
 *
 * Append-only event log of AI-assisted matching calls (see migration 044).
 * Writes are fire-and-forget on the search-channel hot path — a stats DB
 * error must never block or fail a user's search (modelled on
 * broadcasterMatchStats.js). Reads back aggregates + a recent feed for the
 * dashboard's "AI Matching" panel.
 */

const logger = require('../config/logger');
const postgresService = require('./postgresService');

const INSERT_SQL = `
  INSERT INTO ai_match_stats (
    feature, event_id, sport_type, league_name, query,
    candidates, latency_ms, outcome, changed_outcome, agreed,
    top_choice, confidence
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
`;

/**
 * Record one AI matching call. Fire-and-forget — never awaited on the hot
 * path, never throws to the caller.
 * @param {object} row
 * @param {'picker'|'broadcaster'} row.feature
 * @param {string} row.outcome  'ok'|'llm_null'|'error'|'not_ready'|'no_candidates'|'cache_hit'
 */
function record(row = {}) {
  const params = [
    row.feature || 'picker',
    row.eventId || null,
    row.sportType || null,
    row.leagueName || null,
    row.query ? String(row.query).slice(0, 500) : null,
    Number.isFinite(row.candidates) ? row.candidates : 0,
    Number.isFinite(row.latencyMs) ? Math.round(row.latencyMs) : null,
    row.outcome || 'ok',
    typeof row.changedOutcome === 'boolean' ? row.changedOutcome : null,
    typeof row.agreed === 'boolean' ? row.agreed : null,
    row.topChoice ? String(row.topChoice).slice(0, 300) : null,
    Number.isFinite(row.confidence) ? row.confidence : null,
  ];
  // Don't await — let it settle in the background. Swallow errors.
  postgresService.query(INSERT_SQL, params).catch((err) => {
    logger.warn(`[AiMatchStats] insert failed: ${err.message}`);
  });
}

/**
 * Time-window aggregates for the dashboard.
 * @param {object} opts
 * @param {number} [opts.sinceHours=168]
 */
async function getAggregates({ sinceHours = 168 } = {}) {
  const sql = `
    SELECT
      COUNT(*)::int                                                   AS total_calls,
      COUNT(*) FILTER (WHERE feature = 'picker')::int                 AS picker_calls,
      COUNT(*) FILTER (WHERE feature = 'broadcaster')::int            AS broadcaster_calls,
      COUNT(*) FILTER (WHERE outcome = 'ok')::int                     AS ok_calls,
      COUNT(*) FILTER (WHERE outcome IN ('llm_null','error'))::int    AS error_calls,
      COUNT(*) FILTER (WHERE changed_outcome IS TRUE)::int            AS overrides,
      COUNT(*) FILTER (WHERE agreed IS TRUE)::int                     AS agreements,
      COUNT(*) FILTER (WHERE agreed IS NOT NULL)::int                 AS decided,
      ROUND(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms,
      MAX(created_at)                                                 AS last_call_at
    FROM ai_match_stats
    WHERE created_at >= NOW() - ($1 || ' hours')::interval
  `;
  try {
    const { rows } = await postgresService.query(sql, [String(sinceHours)]);
    const r = rows[0] || {};
    const decided = r.decided || 0;
    return {
      windowHours: sinceHours,
      totalCalls: r.total_calls || 0,
      pickerCalls: r.picker_calls || 0,
      broadcasterCalls: r.broadcaster_calls || 0,
      okCalls: r.ok_calls || 0,
      errorCalls: r.error_calls || 0,
      overrides: r.overrides || 0,
      agreements: r.agreements || 0,
      agreementRate: decided > 0 ? Math.round((r.agreements / decided) * 100) : null,
      avgLatencyMs: r.avg_latency_ms || null,
      lastCallAt: r.last_call_at || null,
    };
  } catch (err) {
    logger.warn(`[AiMatchStats] getAggregates failed: ${err.message}`);
    return null;
  }
}

/** Recent decisions feed for the dashboard. */
async function getRecent(limit = 12) {
  const sql = `
    SELECT id, created_at, feature, sport_type, league_name, query,
           candidates, latency_ms, outcome, changed_outcome, agreed,
           top_choice, confidence
    FROM ai_match_stats
    ORDER BY created_at DESC
    LIMIT $1
  `;
  try {
    const { rows } = await postgresService.query(sql, [Math.min(50, Math.max(1, limit))]);
    return rows;
  } catch (err) {
    logger.warn(`[AiMatchStats] getRecent failed: ${err.message}`);
    return [];
  }
}

module.exports = { record, getAggregates, getRecent };
