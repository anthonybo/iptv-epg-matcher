#!/usr/bin/env node
/**
 * Deliberate runner for migration 032 (partition iptv_channels).
 *
 * Why this is gated behind a runner instead of auto-applied: the
 * migration holds an AccessExclusiveLock on iptv_channels for the
 * duration (~1-5 min on our dev DB) while it copies ~866k rows
 * into the new partitioned structure. You want to run it knowing
 * the backend is up but no refresh is in flight.
 *
 *   node scripts/run_migration_032.js
 *
 * The migration itself is idempotent — if the table is already
 * partitioned it bails early via the DO block at the top.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '032_partition_iptv_channels.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 032 (partition iptv_channels by source_id)…');
  const t0 = Date.now();

  // Single statement to the server — Postgres parses the whole file,
  // including the wrapping BEGIN/COMMIT, as one batch. node-postgres
  // forwards it intact via the simple query protocol.
  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed — Postgres should have rolled back the transaction.');
    console.error(err);
    process.exit(1);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Migration 032 applied in ${elapsedSec}s.`);

  // Quick post-state report
  const summary = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pg_inherits WHERE inhparent = 'iptv_channels'::regclass) AS partition_count,
      (SELECT COUNT(*)::int FROM iptv_channels) AS total_rows,
      (SELECT COUNT(DISTINCT source_id)::int FROM iptv_channels) AS distinct_sources
  `);
  console.log('Post-migration:', summary.rows[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
