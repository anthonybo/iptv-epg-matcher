/**
 * Verifies metricsService persists to Postgres (migrated off the
 * legacy sqlite metrics DB). Drives the singleton's public tracking
 * methods, forces a queue flush, and asserts rows land in the right
 * PG tables. All test rows use unique keys and are deleted at the end.
 *
 *   - trackSession        → metrics_sessions
 *   - trackPageView       → metrics_page_views
 *   - trackStreamStart/End→ metrics_streams (with end_time + bytes)
 *   - sampleAndPersistMetrics → metrics_bandwidth/requests/system
 *   - getActiveSessions returns the tracked session from cache
 *   - BIGINT timestamps round-trip (Date.now() doesn't overflow)
 *
 * Run: node backend/scripts/verify_metrics_pg.js
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const postgresService = require('../services/postgresService');
const metrics = require('../services/metricsService');

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUFFIX = Date.now().toString(36);
const SESSION_ID = `vmetrics_sess_${SUFFIX}`;
const STREAM_KEY = `vmetrics_stream_${SUFFIX}`;

async function rowsFor(table, col, val) {
  const r = await postgresService.query(`SELECT * FROM ${table} WHERE ${col} = $1`, [val]);
  return r.rows;
}

async function cleanup() {
  try {
    await postgresService.query('DELETE FROM metrics_page_views WHERE session_id = $1', [SESSION_ID]);
    await postgresService.query('DELETE FROM metrics_sessions   WHERE session_id = $1', [SESSION_ID]);
    await postgresService.query('DELETE FROM metrics_streams     WHERE stream_key = $1', [STREAM_KEY]);
  } catch (e) { console.warn('  cleanup warning:', e.message); }
}

async function main() {
  console.log('verify_metrics_pg starting');
  let allPass = true;

  // metricsService.initDatabase() is async in the constructor; give it
  // a moment to set this.ready before we drive it.
  await sleep(500);

  try {
    // ── sessions ────────────────────────────────────────────────
    console.log('\n[test 1] trackSession → metrics_sessions (PG)');
    metrics.trackSession(SESSION_ID, 2, 'verifybot', 'multiview', '127.0.0.1', 'verify-agent');
    await metrics.flushWriteQueue();
    const sessRows = await rowsFor('metrics_sessions', 'session_id', SESSION_ID);
    allPass = check('session row persisted', sessRows.length === 1) && allPass;
    allPass = check('first_seen is a BIGINT ms timestamp (no overflow)',
      sessRows[0] && Number(sessRows[0].first_seen) > 1.5e12, `first_seen=${sessRows[0]?.first_seen}`) && allPass;
    allPass = check('is_active stored as boolean TRUE', sessRows[0]?.is_active === true) && allPass;

    const active = metrics.getActiveSessions();
    allPass = check('getActiveSessions includes the tracked session',
      active.some((s) => s.session_id === SESSION_ID)) && allPass;

    // ── page views ──────────────────────────────────────────────
    console.log('\n[test 2] trackPageView → metrics_page_views (PG)');
    metrics.trackPageView(SESSION_ID, 2, 'multiview');
    await metrics.flushWriteQueue();
    const pvRows = await rowsFor('metrics_page_views', 'session_id', SESSION_ID);
    allPass = check('page view row persisted', pvRows.length === 1, `rows=${pvRows.length}`) && allPass;
    allPass = check('page recorded', pvRows[0]?.page === 'multiview') && allPass;

    // ── streams ─────────────────────────────────────────────────
    console.log('\n[test 3] trackStreamStart/Bandwidth/End → metrics_streams (PG)');
    metrics.trackStreamStart(STREAM_KEY, {
      channel: 'Verify Channel', channelId: 'vch1', source: 'VerifySrc', sourceId: 1,
      user: 'verifybot', userId: 2, ip: '127.0.0.1', type: 'stream'
    });
    await metrics.flushWriteQueue();
    let streamRows = await rowsFor('metrics_streams', 'stream_key', STREAM_KEY);
    allPass = check('stream start row persisted', streamRows.length === 1) && allPass;
    allPass = check('start_time BIGINT (no overflow)',
      streamRows[0] && Number(streamRows[0].start_time) > 1.5e12) && allPass;
    allPass = check('end_time null while active', streamRows[0]?.end_time === null) && allPass;

    metrics.trackBandwidth(STREAM_KEY, 5_000_000, 0); // 5MB sent
    metrics.trackStreamEnd(STREAM_KEY);
    await metrics.flushWriteQueue();
    streamRows = await rowsFor('metrics_streams', 'stream_key', STREAM_KEY);
    allPass = check('stream end recorded (end_time set)', streamRows[0]?.end_time !== null) && allPass;
    allPass = check('bytes_transferred persisted (BIGINT, 5MB)',
      Number(streamRows[0]?.bytes_transferred) === 5_000_000, `bytes=${streamRows[0]?.bytes_transferred}`) && allPass;

    // ── time-series sampling ────────────────────────────────────
    console.log('\n[test 4] sampleAndPersistMetrics → bandwidth/requests/system (PG)');
    const before = {};
    for (const t of ['metrics_bandwidth', 'metrics_requests', 'metrics_system']) {
      before[t] = (await postgresService.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
    }
    await metrics.sampleAndPersistMetrics();
    await metrics.flushWriteQueue();
    for (const t of ['metrics_bandwidth', 'metrics_requests', 'metrics_system']) {
      const after = (await postgresService.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      allPass = check(`${t} gained a row`, after === before[t] + 1, `before=${before[t]} after=${after}`) && allPass;
    }
  } catch (err) {
    console.error('  [FAIL] unexpected error:', err.message);
    allPass = false;
  } finally {
    await cleanup();
    console.log('  cleaned up test metric rows');
  }

  console.log('\n' + (allPass ? 'ALL PASS' : 'FAILED'));
  await postgresService.pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('[verify] fatal:', e); process.exit(1); });
