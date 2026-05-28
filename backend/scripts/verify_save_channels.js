/**
 * Verifies postgresService.saveChannels survives the same crash
 * modes that hit vodIngest:
 *
 *   1. Happy path — n channels in, n rows in partition + shadow.
 *   2. Input-side dedup — saveChannels dedupes by `channel.id` before
 *      COPY; duplicate inputs must not crash and the final row count
 *      should equal the unique-id count.
 *   3. Listener leak — saving enough rows to trip many backpressure
 *      events must NOT emit MaxListenersExceededWarning (the symptom
 *      of the pre-existing once('error', reject) leak we fixed).
 *   4. Cancellation — isCancelled() returning true mid-stream must
 *      ROLLBACK cleanly without crashing the process.
 *
 * Runs against a throwaway iptv_sources row that's deleted at the
 * end. Safe to run repeatedly.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool, saveChannels } = require('../services/postgresService');

let crashed = false;
let lastUncaught = null;
process.on('uncaughtException', (e) => {
  crashed = true;
  lastUncaught = e;
  console.error('[verify] UNCAUGHT', e.stack);
});

// Track MaxListenersExceededWarning specifically — the symptom of
// the pre-fix listener leak under heavy backpressure.
let listenerWarning = null;
process.on('warning', (w) => {
  if (w.name === 'MaxListenersExceededWarning') {
    listenerWarning = w;
  }
});

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

async function ensureTestSource() {
  const u = await pool.query(`SELECT id FROM users LIMIT 1`);
  if (u.rows.length === 0) throw new Error('No users in DB');
  const userId = u.rows[0].id;
  const ins = await pool.query(
    `INSERT INTO iptv_sources (user_id, name, type, url, username, password, channel_count)
     VALUES ($1, 'verify-save-channels', 'xtream', 'http://verify.test', $2, 'x', 0)
     RETURNING id`,
    [userId, `__verify_${Date.now()}`]
  );
  return ins.rows[0].id;
}

async function cleanupTestSource(sourceId) {
  await pool.query(`DELETE FROM iptv_sources WHERE id = $1`, [sourceId]);
}

// Synthetic channel factory. Mirrors the shape the Xtream/M3U
// loaders hand to saveChannels.
function makeChannel(i, sourceId) {
  return {
    id: `xtream_verify_${i}`,
    name: `Verify Channel ${i}`,
    url: `http://verify.test/live/x/x/${i}.ts`,
    logo: `http://verify.test/logo/${i}.png`,
    category: i % 5 === 0 ? 'News' : 'Entertainment',
    groupTitle: 'Verify',
    tvgId: `vrfy.${i}`,
    tvgName: `Verify ${i}`,
    source_type: 'xtream',
    source_username: 'verify',
    source_password: 'x',
    source_url: 'http://verify.test',
    source_mac: null
  };
}

// ─── Test 1 — happy path ─────────────────────────────────────────
async function test1_happy(sourceId) {
  console.log('\n[test 1] saveChannels happy path (100 channels)');
  const channels = Array.from({ length: 100 }, (_, i) => makeChannel(i, sourceId));
  const result = await saveChannels(channels, sourceId);

  let pass = true;
  pass &= check('did not crash', !crashed);
  pass &= check('returned saved=100', result.saved === 100, `got ${result.saved}`);

  const partRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iptv_channels_p_${parseInt(sourceId, 10)}`
  );
  pass &= check('partition has 100 rows', partRows.rows[0].n === 100, `got ${partRows.rows[0].n}`);

  const shadowRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iptv_channels_search WHERE source_id = $1`,
    [sourceId]
  );
  pass &= check('shadow has 100 rows', shadowRows.rows[0].n === 100, `got ${shadowRows.rows[0].n}`);

  const src = await pool.query(
    `SELECT channel_count FROM iptv_sources WHERE id = $1`,
    [sourceId]
  );
  pass &= check('iptv_sources.channel_count = 100', src.rows[0].channel_count === 100);

  return pass;
}

// ─── Test 2 — input-side dedup ────────────────────────────────────
async function test2_inputDedup(sourceId) {
  console.log('\n[test 2] saveChannels dedupes duplicate channel.id values');
  // 80 unique IDs + 20 dupes of IDs 0..19 = 100 total rows in, 80 unique
  const channels = [];
  for (let i = 0; i < 80; i++) channels.push(makeChannel(i, sourceId));
  for (let i = 0; i < 20; i++) channels.push(makeChannel(i, sourceId)); // duplicates
  const result = await saveChannels(channels, sourceId);

  let pass = true;
  pass &= check('did not crash', !crashed);
  pass &= check('returned saved=80 (deduped)', result.saved === 80, `got ${result.saved}`);

  const partRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iptv_channels_p_${parseInt(sourceId, 10)}`
  );
  pass &= check('partition has 80 rows (TRUNCATE replaced previous 100)',
    partRows.rows[0].n === 80, `got ${partRows.rows[0].n}`);
  return pass;
}

// ─── Test 3 — no listener leak under heavy backpressure ─────────
async function test3_noListenerLeak(sourceId) {
  console.log('\n[test 3] no MaxListenersExceededWarning on 10k-row save');
  listenerWarning = null;
  const channels = Array.from({ length: 10_000 }, (_, i) => makeChannel(i + 100000, sourceId));
  const t0 = Date.now();
  const result = await saveChannels(channels, sourceId);
  const dt = Date.now() - t0;
  console.log(`  duration: ${dt}ms`);

  let pass = true;
  pass &= check('did not crash', !crashed);
  pass &= check('saved 10000', result.saved === 10_000, `got ${result.saved}`);
  pass &= check('no MaxListenersExceededWarning emitted',
    listenerWarning === null,
    listenerWarning ? `got: ${listenerWarning.message}` : '');
  return pass;
}

// ─── Test 4 — cancellation ────────────────────────────────────────
async function test4_cancellation(sourceId) {
  console.log('\n[test 4] saveChannels handles isCancelled() cleanly');
  // Save a small set first so the partition has known state to
  // verify ROLLBACK preserved.
  await saveChannels(Array.from({ length: 5 }, (_, i) => makeChannel(900 + i, sourceId)), sourceId);
  const beforeRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iptv_channels_p_${parseInt(sourceId, 10)}`
  );
  if (beforeRows.rows[0].n !== 5) {
    console.log(`  [WARN] expected 5 baseline rows, got ${beforeRows.rows[0].n} — proceeding anyway`);
  }

  // Now trigger cancellation after the first ~200 rows are written.
  const channels = Array.from({ length: 1000 }, (_, i) => makeChannel(8000 + i, sourceId));
  let writeCount = 0;
  const isCancelled = () => {
    writeCount += 1;
    return writeCount > 200; // flip to true after row 200
  };

  let result;
  let threw = false;
  try {
    result = await saveChannels(channels, sourceId, { isCancelled });
  } catch (e) {
    threw = true;
    console.log(`  saveChannels threw (acceptable for cancellation): ${e.message}`);
  }

  let pass = true;
  pass &= check('did not crash process', !crashed);
  // Acceptable outcomes: returned { saved: 0, cancelled: true } OR threw the
  // __SAVE_CHANNELS_CANCELLED__ marker. Both leave the partition rolled back.
  const cancelledResult = !threw && result && result.cancelled === true;
  pass &= check('cancellation signal honored (returned cancelled OR threw)',
    threw || cancelledResult, `result=${JSON.stringify(result)}`);

  // The partition should still hold the 5 baseline rows — ROLLBACK
  // means the partial COPY in this txn was discarded.
  const afterRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iptv_channels_p_${parseInt(sourceId, 10)}`
  );
  // Important: TRUNCATE inside the cancelled txn was also rolled back,
  // so the original 5 rows should be preserved. If they're gone we
  // have a real bug.
  pass &= check('partition baseline preserved after rollback (5 rows expected)',
    afterRows.rows[0].n === 5,
    `got ${afterRows.rows[0].n}`);
  return pass;
}

async function main() {
  console.log('verify_save_channels starting');
  const sourceId = await ensureTestSource();
  console.log(`  created test source id=${sourceId}`);

  let allPass = true;
  try {
    allPass = (await test1_happy(sourceId)) && allPass;
    allPass = (await test2_inputDedup(sourceId)) && allPass;
    allPass = (await test3_noListenerLeak(sourceId)) && allPass;
    allPass = (await test4_cancellation(sourceId)) && allPass;
  } finally {
    await cleanupTestSource(sourceId);
    console.log(`  cleaned up test source id=${sourceId}`);
  }

  console.log('\n' + (allPass && !crashed ? 'ALL PASS' : 'FAILED'));
  if (crashed) console.log(`  process did emit uncaughtException: ${lastUncaught?.message}`);
  await pool.end();
  process.exit(allPass && !crashed ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] fatal:', e);
  process.exit(1);
});
