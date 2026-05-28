/**
 * One-shot: re-trigger bundled-EPG ingest for every iptv_source
 * stuck in `bundled_epg_status = 'pending'`. After the 11:27 SAX
 * crash interrupted the in-flight ingest, these rows never had
 * their finalizer write 'ok'/'failed' back. ingestBundledEpgForSource
 * resets status to 'pending' at start and writes the correct end
 * state on completion or failure.
 *
 * Run: `node backend/scripts/requeue_stuck_bundled_epg.js`
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool } = require('../services/postgresService');
const bundledEpgService = require('../services/bundledEpgService');

const CONCURRENCY = 3;

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name
      FROM iptv_sources
     WHERE bundled_epg_status = 'pending'
     ORDER BY id
  `);
  console.log(`[requeue] ${rows.length} stuck sources to re-ingest:`);
  rows.forEach((r) => console.log(`  - ${r.id}  ${r.name}`));

  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async (_, w) => {
    while (cursor < rows.length) {
      const idx = cursor++;
      const r = rows[idx];
      const t0 = Date.now();
      try {
        console.log(`[w${w}] start id=${r.id} (${r.name})`);
        const result = await bundledEpgService.ingestBundledEpgForSource(r.id, { force: false });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        if (result.success) {
          console.log(`[w${w}] OK    id=${r.id} (${dt}s) ${result.channelCount} ch / ${result.programCount} prog`);
        } else {
          console.log(`[w${w}] FAIL  id=${r.id} (${dt}s) reason=${result.reason} error=${result.error || ''}`);
        }
      } catch (e) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[w${w}] THROW id=${r.id} (${dt}s) ${e.message}`);
      }
    }
  });

  await Promise.all(workers);
  console.log('[requeue] done.');
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('[requeue] fatal:', e);
  process.exit(1);
});
