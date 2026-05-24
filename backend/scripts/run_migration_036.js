#!/usr/bin/env node
/**
 * Deliberate runner for migration 036 (epg_channels composite PK).
 *
 *   node scripts/run_migration_036.js
 *
 * Brief AccessExclusiveLock on epg_channels (1-3s) while the PK is
 * swapped. The orphan-row cleanup may delete a meaningful chunk of
 * epg_programs (hundreds of thousands) — that data is reclaimable
 * from the providers' EPG feeds via the existing
 * POST /api/iptv/sources/refresh-all-bundled-epg endpoint, which
 * the runner reminds you to invoke at the end.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pg = require('../services/postgresService');

(async () => {
  // Sanity: refuse to run while an EPG refresh is in flight. Same
  // belt-and-braces check we use for migrations 033/034.
  const inFlight = await pg.query(`
    SELECT pid, LEFT(query, 80) AS q
      FROM pg_stat_activity
     WHERE state <> 'idle'
       AND (query ILIKE '%epg_channels%' OR query ILIKE '%epg_programs%' OR query ILIKE 'autovacuum%epg%')
       AND pid <> pg_backend_pid()
  `);
  if (inFlight.rows.length > 0) {
    console.error('Refusing to run — found active queries against epg tables:');
    inFlight.rows.forEach((r) => console.error(`  pid=${r.pid} q=${r.q}…`));
    console.error('Wait for the in-flight EPG refresh / autovacuum to finish, then retry.');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'migrations', '036_epg_channels_composite_pk.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Running migration 036 (epg_channels composite PK)…');
  const t0 = Date.now();

  // Capture before-state counts so we can report what got cleaned.
  const before = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM epg_channels)                                   AS channels,
      (SELECT COUNT(*)::int FROM epg_programs)                                   AS programs,
      (SELECT COUNT(*)::int
         FROM epg_programs p
         LEFT JOIN epg_channels c ON c.id = p.channel_id AND c.source_id = p.source_id
        WHERE c.id IS NULL)                                                      AS orphans
  `);
  console.log('Pre-migration:', before.rows[0]);

  try {
    await pg.query(sql);
  } catch (err) {
    console.error('Migration failed — Postgres should have rolled back the transaction.');
    console.error(err);
    process.exit(1);
  }

  const after = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM epg_channels) AS channels,
      (SELECT COUNT(*)::int FROM epg_programs) AS programs
  `);
  console.log(`Migration 036 applied in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log('Post-migration:', after.rows[0]);
  console.log(`  programs removed (orphans): ${before.rows[0].programs - after.rows[0].programs}`);

  console.log('\nNext step: re-run the bundled EPG ingest to backfill the channels');
  console.log('that were stolen by other sources before this migration. Either:');
  console.log('  - hit POST /api/iptv/sources/refresh-all-bundled-epg, or');
  console.log('  - hit "Refresh All" in the My IPTVs page.');
  console.log('Public-EPG sources will repopulate fully on their next scheduled run.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
