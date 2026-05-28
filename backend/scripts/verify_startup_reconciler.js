/**
 * Verifies the startup reconciler in server.js flips orphaned
 * `bundled_epg_status = 'pending'` rows to 'failed' on backend boot.
 *
 * Without this, a crash mid-ingest leaves the UI showing forever-
 * pulsing cyan dots (the cause of "why is the EPG icon still
 * refreshing after an hour").
 *
 * The reconciler is a single SQL statement inlined into server.js
 * rather than a service we can import. The test rebuilds the exact
 * statement and runs it against synthetic test rows; if server.js
 * ever drifts, this test will at least confirm the SQL semantics
 * are still correct.
 */

const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));

const { pool } = require('../services/postgresService');

let crashed = false;
process.on('uncaughtException', (e) => {
  crashed = true;
  console.error('[verify] UNCAUGHT', e.stack);
});

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

// Reconciler SQL — must stay byte-identical to server.js. Read it
// from disk and grep it out so the test catches drift.
function extractReconcilerSql() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Match the SET ... WHERE pending block we wrote earlier.
  const m = src.match(/UPDATE iptv_sources[\s\S]*?WHERE bundled_epg_status\s*=\s*'pending'/);
  if (!m) throw new Error('Reconciler SQL not found in server.js — has it been moved/renamed?');
  return m[0];
}

async function makeRow(userId, name, status) {
  const r = await pool.query(
    `INSERT INTO iptv_sources (user_id, name, type, url, username, password, channel_count, bundled_epg_status)
     VALUES ($1, $2, 'xtream', 'http://verify.test', $3, 'x', 0, $4)
     RETURNING id, bundled_epg_status`,
    [userId, name, `__verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status]
  );
  return r.rows[0];
}

async function main() {
  console.log('verify_startup_reconciler starting');
  const u = await pool.query(`SELECT id FROM users LIMIT 1`);
  if (u.rows.length === 0) throw new Error('No users in DB');
  const userId = u.rows[0].id;

  // Insert 4 rows: 2 stuck-pending (should flip), 1 ok (untouched),
  // 1 failed (untouched). Also a NULL row for sanity.
  const ids = [];
  ids.push((await makeRow(userId, 'verify-reconciler-pending-1', 'pending')).id);
  ids.push((await makeRow(userId, 'verify-reconciler-pending-2', 'pending')).id);
  ids.push((await makeRow(userId, 'verify-reconciler-ok', 'ok')).id);
  ids.push((await makeRow(userId, 'verify-reconciler-failed', 'failed')).id);
  ids.push((await makeRow(userId, 'verify-reconciler-null', null)).id);
  console.log(`  inserted test rows: ${ids.join(', ')}`);

  let allPass = true;
  try {
    // Snapshot before
    const before = await pool.query(
      `SELECT id, bundled_epg_status, bundled_epg_error
         FROM iptv_sources WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids]
    );
    const byIdBefore = Object.fromEntries(before.rows.map(r => [r.id, r]));
    allPass = check('2 pending rows exist before reconcile',
      [byIdBefore[ids[0]].bundled_epg_status, byIdBefore[ids[1]].bundled_epg_status].every(s => s === 'pending'))
      && allPass;

    // Run the actual server.js statement
    const sql = extractReconcilerSql();
    console.log('  reconciler SQL extracted from server.js');
    const upd = await pool.query(sql);
    console.log(`  UPDATE returned rowCount=${upd.rowCount}`);

    // Snapshot after
    const after = await pool.query(
      `SELECT id, bundled_epg_status, bundled_epg_error
         FROM iptv_sources WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids]
    );
    const byIdAfter = Object.fromEntries(after.rows.map(r => [r.id, r]));

    // Pending rows should now be failed
    allPass = check(`pending row #1 (id=${ids[0]}) → failed`,
      byIdAfter[ids[0]].bundled_epg_status === 'failed',
      `got ${byIdAfter[ids[0]].bundled_epg_status}`) && allPass;
    allPass = check(`pending row #2 (id=${ids[1]}) → failed`,
      byIdAfter[ids[1]].bundled_epg_status === 'failed',
      `got ${byIdAfter[ids[1]].bundled_epg_status}`) && allPass;
    allPass = check(`error message set on pending #1`,
      typeof byIdAfter[ids[0]].bundled_epg_error === 'string' &&
      byIdAfter[ids[0]].bundled_epg_error.includes('interrupted'),
      `got: ${byIdAfter[ids[0]].bundled_epg_error}`) && allPass;

    // Non-pending rows should be untouched
    allPass = check(`ok row (id=${ids[2]}) untouched`,
      byIdAfter[ids[2]].bundled_epg_status === 'ok') && allPass;
    allPass = check(`failed row (id=${ids[3]}) untouched`,
      byIdAfter[ids[3]].bundled_epg_status === 'failed' &&
      byIdAfter[ids[3]].bundled_epg_error === null,
      `error=${byIdAfter[ids[3]].bundled_epg_error}`) && allPass;
    allPass = check(`null row (id=${ids[4]}) untouched`,
      byIdAfter[ids[4]].bundled_epg_status === null) && allPass;

    allPass = check('rowCount reflects only the 2 pending rows changed',
      upd.rowCount === 2, `got ${upd.rowCount}`) && allPass;
  } finally {
    // Always clean up test rows
    await pool.query(`DELETE FROM iptv_sources WHERE id = ANY($1::int[])`, [ids]);
    console.log('  cleaned up test rows');
  }

  console.log('\n' + (allPass && !crashed ? 'ALL PASS' : 'FAILED'));
  await pool.end();
  process.exit(allPass && !crashed ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] fatal:', e);
  process.exit(1);
});
