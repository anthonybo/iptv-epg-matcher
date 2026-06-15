#!/usr/bin/env node
/**
 * Runner for migration 054 (partial index for the VOD enrichment query).
 * CREATE INDEX CONCURRENTLY can't run in a transaction and can exceed the
 * pool statement_timeout, so use a dedicated client with the timeout off.
 *   node scripts/run_migration_054.js
 */
require('dotenv').config();
const pg = require('../services/postgresService');

(async () => {
  const client = await pg.pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    console.log('Building idx_movie_streams_unenriched CONCURRENTLY (non-blocking)…');
    const t0 = Date.now();
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movie_streams_unenriched
         ON movie_streams (updated_at DESC NULLS LAST)
         WHERE movie_id IS NULL`
    );
    console.log(`Index ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const check = await pg.query(
      `SELECT indexname FROM pg_indexes WHERE indexname='idx_movie_streams_unenriched'`
    );
    console.log('Post-migration:', { index_exists: check.rows.length > 0 });
  } finally {
    client.release();
  }
  process.exit(0);
})().catch((e) => { console.error('Migration 054 failed:', e.message); process.exit(1); });
