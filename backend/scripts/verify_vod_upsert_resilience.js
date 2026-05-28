/**
 * Verifies that the recent vodIngestService changes actually survive
 * the two crash modes we hit earlier:
 *
 *   1. Duplicate provider_stream_id in input — used to violate the
 *      staging table PK mid-COPY and raced pg-copy-streams' _final
 *      into a null-deref uncaught exception.
 *   2. Server-side ErrorResponse during COPY — used to crash the
 *      process via the same _final race.
 *
 * Strategy: invoke upsertMovieStreams against a throwaway test
 * source_id. Synthetic data includes 3 duplicate stream_ids out of
 * 10 rows. Expected outcome: no uncaught exceptions, no process
 * exit, the 7 unique rows land in movie_streams.
 *
 * Then separately exercises streamRowsToCopy against a COPY into a
 * table with a CHECK constraint that the input violates — proves
 * the destroy()-on-error guard prevents the pg-copy-streams crash
 * even if a server-side COPY error sneaks past our dedup.
 *
 * Runs entirely against a temporary test source row that's deleted
 * at the end; safe to run repeatedly.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool } = require('../services/postgresService');
const { from: copyFrom } = require('pg-copy-streams');
const vodIngestService = require('../services/vodIngestService');

const TEST_SOURCE_USERNAME = `__verify_vod_${Date.now()}`;

let crashed = false;
let lastUncaught = null;
process.on('uncaughtException', (e) => {
  crashed = true;
  lastUncaught = e;
  console.error('[verify] UNCAUGHT', e.stack);
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
     VALUES ($1, 'verify-vod-upsert', 'xtream', 'http://verify.test', $2, 'x', 0)
     RETURNING id`,
    [userId, TEST_SOURCE_USERNAME]
  );
  return ins.rows[0].id;
}

async function cleanupTestSource(sourceId) {
  // CASCADE handles movie_streams, series_sources, etc.
  await pool.query(`DELETE FROM iptv_sources WHERE id = $1`, [sourceId]);
}

// ─── Test 1 — dedup path on real upsertMovieStreams ──────────────
async function test1_dedupeInput(sourceId) {
  console.log('\n[test 1] upsertMovieStreams with duplicate provider_stream_ids');

  const movies = [
    // 7 unique stream_ids, but stream "alpha", "bravo", "charlie" each
    // appear twice — totals 10 rows, expected 7 in DB.
    { providerStreamId: 'alpha',   rawName: 'Alpha v1',   categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: 7.0, raw: { v: 1 } },
    { providerStreamId: 'bravo',   rawName: 'Bravo',      categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: null, raw: null },
    { providerStreamId: 'alpha',   rawName: 'Alpha v2',   categoryId: '2', containerExtension: 'mkv', addedAt: null, rating: 7.5, raw: { v: 2 } }, // dup
    { providerStreamId: 'charlie', rawName: 'Charlie',    categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: 8.1, raw: null },
    { providerStreamId: 'delta',   rawName: 'Delta',      categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: null, raw: null },
    { providerStreamId: 'echo',    rawName: 'Echo',       categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: null, raw: null },
    { providerStreamId: 'bravo',   rawName: 'Bravo v2',   categoryId: '2', containerExtension: 'mkv', addedAt: null, rating: 9.0, raw: null }, // dup
    { providerStreamId: 'foxtrot', rawName: 'Foxtrot',    categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: null, raw: null },
    { providerStreamId: 'golf',    rawName: 'Golf',       categoryId: '1', containerExtension: 'mp4', addedAt: null, rating: null, raw: null },
    { providerStreamId: 'charlie', rawName: 'Charlie v2', categoryId: '2', containerExtension: 'mkv', addedAt: null, rating: 8.7, raw: null }, // dup
  ];

  const t0 = Date.now();
  let result;
  try {
    result = await vodIngestService.upsertMovieStreams(sourceId, movies);
  } catch (e) {
    return check(`upsertMovieStreams threw: ${e.message}`, false);
  }
  const dt = Date.now() - t0;

  let pass = true;
  pass &= check('did not crash process', !crashed);
  pass &= check(`returned upserted count = 7 (dedup last-wins)`, result.upserted === 7, `got ${result.upserted}`);

  const rows = await pool.query(
    `SELECT provider_stream_id, provider_name, provider_category_id
       FROM movie_streams
      WHERE source_id = $1
      ORDER BY provider_stream_id`,
    [sourceId]
  );
  pass &= check(`DB has 7 unique rows`, rows.rowCount === 7, `got ${rows.rowCount}`);

  // Confirm last-wins: alpha should have "Alpha v2", bravo "Bravo v2", charlie "Charlie v2"
  const byId = Object.fromEntries(rows.rows.map(r => [r.provider_stream_id, r]));
  pass &= check(`alpha last-wins: "Alpha v2"`, byId.alpha?.provider_name === 'Alpha v2', `got ${byId.alpha?.provider_name}`);
  pass &= check(`bravo last-wins: "Bravo v2"`, byId.bravo?.provider_name === 'Bravo v2', `got ${byId.bravo?.provider_name}`);
  pass &= check(`charlie last-wins: "Charlie v2"`, byId.charlie?.provider_name === 'Charlie v2', `got ${byId.charlie?.provider_name}`);

  console.log(`  duration: ${dt}ms`);
  return pass;
}

// ─── Test 2 — streamRowsToCopy survives server-side COPY error ──
async function test2_serverSideCopyError() {
  console.log('\n[test 2] streamRowsToCopy guards against pg-copy-streams crash race');

  // Use the REAL production helper, not a copy, so the verification
  // exercises the actual code path and catches future drift.
  const { streamRowsToCopy } = require('../utils/pgCopyHelpers');

  const client = await pool.connect();
  let caughtError = null;
  try {
    await client.query('BEGIN');
    // Table with a CHECK constraint our test rows will violate
    await client.query(`
      CREATE TEMP TABLE _verify_copy_check (
        x INTEGER CHECK (x < 1000)
      ) ON COMMIT DROP
    `);

    const copyStream = client.query(copyFrom(
      `COPY _verify_copy_check (x) FROM STDIN WITH (FORMAT text)`
    ));

    try {
      // Row #3 violates CHECK (x < 1000) — pg will send ErrorResponse
      // mid-COPY. Without our destroy() guard, the .end() that
      // streamRowsToCopy schedules would crash the process.
      await streamRowsToCopy(copyStream, [1, 2, 9999, 3, 4], (v) => `${v}\n`);
    } catch (e) {
      caughtError = e;
    }

    // Must rollback because the txn is poisoned after a COPY error.
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  // Give event loop a tick in case any leftover 'error' or async
  // callback was queued. If pg-copy-streams' _final race was still
  // alive, the uncaught handler above would have flipped `crashed`.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  let pass = true;
  pass &= check('did not crash process', !crashed);
  pass &= check('streamRowsToCopy surfaced the error (did not swallow)', caughtError !== null,
    `errMsg=${caughtError?.message}`);
  pass &= check('error mentions check / constraint',
    /check|constraint|violates/i.test(String(caughtError?.message)),
    `got: ${caughtError?.message}`);

  return pass;
}

// ─── Test 3 — also exercise upsertSeriesSources path ────────────
async function test3_seriesDedupe(sourceId) {
  console.log('\n[test 3] upsertSeriesSources with duplicate provider_series_ids');

  const seriesList = [
    { providerSeriesId: 's1', rawName: 'Series Alpha',   categoryId: '1', raw: null },
    { providerSeriesId: 's2', rawName: 'Series Bravo',   categoryId: '1', raw: null },
    { providerSeriesId: 's1', rawName: 'Series Alpha 2', categoryId: '2', raw: { v: 2 } }, // dup
    { providerSeriesId: 's3', rawName: 'Series Charlie', categoryId: '1', raw: null },
    { providerSeriesId: 's2', rawName: 'Series Bravo 2', categoryId: '2', raw: null }, // dup
  ];

  let result;
  try {
    result = await vodIngestService.upsertSeriesSources(sourceId, seriesList);
  } catch (e) {
    return check(`upsertSeriesSources threw: ${e.message}`, false);
  }

  let pass = true;
  pass &= check('did not crash process', !crashed);
  pass &= check(`returned upserted count = 3 (dedup)`, result.upserted === 3, `got ${result.upserted}`);

  const rows = await pool.query(
    `SELECT provider_series_id, provider_name FROM series_sources WHERE source_id = $1 ORDER BY provider_series_id`,
    [sourceId]
  );
  pass &= check(`DB has 3 unique series`, rows.rowCount === 3, `got ${rows.rowCount}`);
  const byId = Object.fromEntries(rows.rows.map(r => [r.provider_series_id, r]));
  pass &= check(`s1 last-wins`, byId.s1?.provider_name === 'Series Alpha 2');
  pass &= check(`s2 last-wins`, byId.s2?.provider_name === 'Series Bravo 2');
  return pass;
}

async function main() {
  console.log('verify_vod_upsert_resilience starting');
  const sourceId = await ensureTestSource();
  console.log(`  created test source id=${sourceId}`);

  let allPass = true;
  try {
    allPass = (await test1_dedupeInput(sourceId)) && allPass;
    allPass = (await test2_serverSideCopyError()) && allPass;
    allPass = (await test3_seriesDedupe(sourceId)) && allPass;
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
