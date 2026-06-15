#!/usr/bin/env node
/**
 * Runner for migration 053 (commercial ad-creative catalog).
 *
 *   node scripts/run_migration_053.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '053_commercial_ad_catalog.sql'),
    'utf8'
  );
  console.log('Applying migration 053 (commercial ad catalog)…');
  await pg.query(sql);

  const check = await pg.query(
    `SELECT tablename FROM pg_tables
      WHERE tablename IN ('commercial_ad_creatives','commercial_ad_fingerprints')
      ORDER BY tablename`
  );
  console.log('Tables present:', check.rows.map((r) => r.tablename));
  process.exit(0);
})().catch((e) => { console.error('Migration 053 failed:', e.message); process.exit(1); });
