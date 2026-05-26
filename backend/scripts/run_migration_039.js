#!/usr/bin/env node
/**
 * Runner for migration 039 (composite recency index on movie_streams).
 *
 *   node scripts/run_migration_039.js
 *
 * Same shape as run_migration_038 but for movies. Builds the index
 * non-CONCURRENTLY; on the 1.4M-row movie_streams table this takes
 * ~30-90s under load (the movie-enrichment background job contends
 * for I/O on the same table). The lock is SHARE — reads + the
 * enrichment SELECTs proceed normally during the build; only DML
 * (INSERT/UPDATE/DELETE) on movie_streams waits briefly.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'migrations', '039_movie_streams_recency_index.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 039 (movie_streams recency index)…');
  const t0 = Date.now();
  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
  console.log(`Migration 039 applied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
