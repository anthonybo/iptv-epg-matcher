#!/usr/bin/env node
/**
 * Deliberate runner for migration 033 (iptv_channels_search shadow).
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING.
 * The one-shot backfill scans iptv_channels once and INSERTs into the
 * new shadow table; on a ~1M-row catalog this takes 30-90s, dominated
 * by the GIN index build.
 *
 *   node scripts/run_migration_033.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '033_add_iptv_channels_search.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 033 (iptv_channels_search shadow table)…');
  const t0 = Date.now();

  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed — Postgres should have rolled back the transaction.');
    console.error(err);
    process.exit(1);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Migration 033 applied in ${elapsedSec}s.`);

  const summary = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM iptv_channels_search) AS shadow_rows,
      (SELECT COUNT(*)::int FROM iptv_channels)        AS source_rows
  `);
  console.log('Post-migration:', summary.rows[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
