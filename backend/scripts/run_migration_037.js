#!/usr/bin/env node
/**
 * Runner for migration 037 (youtube_favorites table).
 *
 *   node scripts/run_migration_037.js
 *
 * Pure table creation — safe to run live, no locking concerns.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '037_youtube_favorites.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 037 (youtube_favorites)…');
  const t0 = Date.now();

  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }

  const after = await pg.query(`
    SELECT COUNT(*)::int AS rows FROM youtube_favorites
  `);
  console.log(`Migration 037 applied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log('Post-migration row count:', after.rows[0].rows);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
