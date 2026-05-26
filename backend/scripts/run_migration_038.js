#!/usr/bin/env node
/**
 * Runner for migration 038 (composite index on series_sources for the
 * user-scoped recency sort used by /api/vod/series).
 *
 *   node scripts/run_migration_038.js
 *
 * Builds the index CONCURRENTLY-style via CREATE INDEX IF NOT EXISTS.
 * On the 300k-row series_sources table this takes ~10-30s. Safe to run
 * while the app is up; reads and writes proceed normally during the
 * build because CREATE INDEX (non-CONCURRENTLY) only takes a SHARE lock
 * on series_sources — selects work, inserts wait briefly. If write
 * latency during the build is unacceptable, switch to `CONCURRENTLY`
 * in the SQL (slower but lockless).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '038_series_sources_recency_index.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 038 (series_sources recency index)…');
  const t0 = Date.now();
  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
  console.log(`Migration 038 applied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
