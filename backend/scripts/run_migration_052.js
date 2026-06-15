#!/usr/bin/env node
/**
 * Runner for migration 052 (trigram index on iptv_channels_search.name).
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and the
 * build can exceed the pool's default statement_timeout, so we grab a
 * dedicated client, disable the timeout on it, and issue each statement
 * separately (autocommit). Safe to run while the app is up — CONCURRENTLY
 * does not block reads or writes.
 *
 *   node scripts/run_migration_052.js
 */
require('dotenv').config();
const pg = require('../services/postgresService');

(async () => {
  const client = await pg.pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    console.log('Ensuring pg_trgm extension…');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    console.log('Building trigram index CONCURRENTLY (can take ~tens of seconds on 900k+ rows)…');
    const t0 = Date.now();
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_iptv_channels_search_name_trgm
         ON iptv_channels_search USING gin (name gin_trgm_ops)`
    );
    console.log(`Index ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const check = await pg.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename='iptv_channels_search'
          AND indexname='idx_iptv_channels_search_name_trgm'`
    );
    console.log('Post-migration:', { index_exists: check.rows.length > 0 });
  } finally {
    client.release();
  }
  process.exit(0);
})().catch((e) => { console.error('Migration 052 failed:', e.message); process.exit(1); });
