#!/usr/bin/env node
/**
 * Deliberate runner for migration 034 (partition epg_programs).
 *
 * Why this is gated behind a runner instead of auto-applied: the
 * migration holds an AccessExclusiveLock on epg_programs for the
 * duration (~2-8 min in dev) while it copies ~919k rows into the new
 * partitioned structure. You want to run it knowing the backend is
 * up but NO EPG REFRESH is in flight (refresh would block until the
 * migration releases the lock).
 *
 *   node scripts/run_migration_034.js
 *
 * The migration itself is idempotent — if the table is already
 * partitioned it bails early via the DO block at the top.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  // Sanity check — refuse to run while an EPG refresh is in flight.
  const inFlight = await pg.query(`
    SELECT pid, query_start, state, LEFT(query, 80) AS q
      FROM pg_stat_activity
     WHERE state <> 'idle'
       AND (query ILIKE '%epg_programs%' OR query ILIKE '%epg_channels%')
       AND pid <> pg_backend_pid()
  `);
  if (inFlight.rows.length > 0) {
    console.error('Refusing to run — found active queries against epg tables:');
    inFlight.rows.forEach(r => console.error(`  pid=${r.pid} state=${r.state} q=${r.q}…`));
    console.error('Wait for the in-flight EPG refresh to finish, then retry.');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'migrations', '034_partition_epg_programs.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 034 (partition epg_programs by source_id)…');
  const t0 = Date.now();

  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed — Postgres should have rolled back the transaction.');
    console.error(err);
    process.exit(1);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Migration 034 applied in ${elapsedSec}s.`);

  const summary = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_inherits WHERE inhparent = 'epg_programs'::regclass) AS partition_count,
      (SELECT COUNT(*)::int FROM epg_programs)                                            AS total_rows,
      (SELECT COUNT(DISTINCT source_id)::int FROM epg_programs)                           AS distinct_sources
  `);
  console.log('Post-migration:', summary.rows[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
