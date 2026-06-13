#!/usr/bin/env node
/**
 * Runner for migration 051 (social_feed_posts — multiview live-chatter feed).
 *
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Fast (no backfill).
 * Safe to run while the app is up — only creates a new table + indexes.
 *
 *   node scripts/run_migration_051.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '051_social_feed.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 051 (social_feed_posts)…');
  const t0 = Date.now();
  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration 051 failed — Postgres should have rolled back.');
    console.error(err);
    process.exit(1);
  }
  console.log(`Migration 051 applied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  const summary = await pg.query(`
    SELECT
      EXISTS(SELECT 1 FROM information_schema.tables
              WHERE table_name = 'social_feed_posts') AS table_exists,
      EXISTS(SELECT 1 FROM pg_indexes
              WHERE indexname = 'idx_social_feed_tag_posted') AS tag_idx,
      EXISTS(SELECT 1 FROM pg_indexes
              WHERE indexname = 'idx_social_feed_ingested') AS ingest_idx
  `);
  console.log('Post-migration:', summary.rows[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
