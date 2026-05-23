#!/usr/bin/env node
/**
 * Deliberate runner for migration 035 (bundled-EPG columns).
 *
 * Adds:
 *   - epg_sources.owner_iptv_source_id (FK + partial index)
 *   - iptv_sources.bundled_epg_* metadata columns + CHECK constraint
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS). Fast (no data backfill;
 * defaults handle existing rows). Safe to run while the app is up —
 * the locks are brief (catalog-only).
 *
 *   node scripts/run_migration_035.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '035_add_bundled_epg_columns.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 035 (bundled-EPG schema)…');
  const t0 = Date.now();
  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed — Postgres should have rolled back the transaction.');
    console.error(err);
    process.exit(1);
  }
  console.log(`Migration 035 applied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  // Confirm the columns and the FK landed as expected.
  const summary = await pg.query(`
    SELECT
      EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name = 'epg_sources' AND column_name = 'owner_iptv_source_id') AS epg_owner_col,
      EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name = 'iptv_sources' AND column_name = 'bundled_epg_url') AS iptv_url_col,
      EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name = 'iptv_sources' AND column_name = 'bundled_epg_status') AS iptv_status_col,
      EXISTS(SELECT 1 FROM pg_indexes
              WHERE indexname = 'idx_epg_sources_owner_iptv_source_id') AS owner_idx,
      EXISTS(SELECT 1 FROM pg_constraint
              WHERE conname = 'iptv_sources_bundled_epg_status_check') AS status_check
  `);
  console.log('Post-migration:', summary.rows[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
