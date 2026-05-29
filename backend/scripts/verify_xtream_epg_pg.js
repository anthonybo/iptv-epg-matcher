/**
 * Verifies the XTREAM API's EPG read works against Postgres
 * (migrated off the legacy sqlite epg.db). Reproduces the exact query
 * routes/xtream.js now runs and asserts:
 *
 *   - it executes against PG epg_programs without error
 *   - start/stop come back as 14-digit XMLTV strings (YYYYMMDDHHMMSS)
 *     so the route's downstream regex→ISO conversion keeps working
 *   - the stop_time >= NOW() filter excludes already-ended programs
 *
 * Seeds one future + one past program under an existing epg_channels
 * row (FK target), runs the query, then cleans up.
 *
 * Run: node backend/scripts/verify_xtream_epg_pg.js
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const postgresService = require('../services/postgresService');

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

const SUFFIX = Date.now().toString(36);

// Mirrors the pruned query routes/xtream.js runs: resolve source_id(s)
// for the channels first, then filter epg_programs by both channel_id
// and source_id so the planner prunes to the relevant partition(s).
async function runRouteQuery(channelIds, programLimit) {
  const srcRes = await postgresService.query(
    `SELECT DISTINCT source_id FROM epg_channels WHERE id = ANY($1::text[])`,
    [channelIds]
  );
  const sourceIds = srcRes.rows.map((r) => r.source_id).filter(Boolean);

  const params = [channelIds, programLimit];
  let sourceClause = '';
  if (sourceIds.length > 0) {
    params.push(sourceIds);
    sourceClause = `AND source_id = ANY($${params.length}::text[])`;
  }
  const result = await postgresService.query(`
    SELECT channel_id, title,
           to_char(start_time, 'YYYYMMDDHH24MISS') AS start,
           to_char(stop_time,  'YYYYMMDDHH24MISS') AS stop, description
      FROM epg_programs
     WHERE channel_id = ANY($1::text[])
       ${sourceClause}
       AND stop_time >= NOW()
     ORDER BY channel_id, start_time
     LIMIT $2
  `, params);
  return { rows: result.rows, prunedToSources: sourceIds.length };
}

async function main() {
  console.log('verify_xtream_epg_pg starting');
  let allPass = true;

  // Use an existing epg_channels row as the FK target + partition.
  const ch = await postgresService.query('SELECT id, source_id FROM epg_channels LIMIT 1');
  if (ch.rows.length === 0) { console.log('No epg_channels — cannot test'); process.exit(1); }
  const { id: channelId, source_id: sourceId } = ch.rows[0];
  console.log(`  using epg_channel ${channelId} (source ${sourceId})`);

  const futureId = `vxtream_future_${SUFFIX}`;
  const pastId = `vxtream_past_${SUFFIX}`;

  try {
    // Seed a future program (should appear) and a past one (filtered out).
    await postgresService.query(
      `INSERT INTO epg_programs (id, channel_id, source_id, title, start_time, stop_time)
       VALUES ($1, $2, $3, 'Verify Future Show', NOW() - INTERVAL '10 min', NOW() + INTERVAL '1 hour')`,
      [futureId, channelId, sourceId]
    );
    await postgresService.query(
      `INSERT INTO epg_programs (id, channel_id, source_id, title, start_time, stop_time)
       VALUES ($1, $2, $3, 'Verify Past Show', NOW() - INTERVAL '3 hour', NOW() - INTERVAL '1 hour')`,
      [pastId, channelId, sourceId]
    );

    console.log('\n[test] route EPG query against Postgres (with partition pruning)');
    const { rows, prunedToSources } = await runRouteQuery([channelId], 100);
    allPass = check('query executes against PG', Array.isArray(rows)) && allPass;
    allPass = check('resolved source_id for partition pruning', prunedToSources >= 1,
      `sources=${prunedToSources}`) && allPass;

    const future = rows.find((r) => r.title === 'Verify Future Show');
    const past = rows.find((r) => r.title === 'Verify Past Show');
    allPass = check('future (live) program returned', !!future) && allPass;
    allPass = check('past program filtered out by stop_time >= NOW()', !past) && allPass;

    allPass = check('start is a 14-digit XMLTV string',
      future && /^\d{14}$/.test(future.start), `start=${future?.start}`) && allPass;
    allPass = check('stop is a 14-digit XMLTV string',
      future && /^\d{14}$/.test(future.stop), `stop=${future?.stop}`) && allPass;

    // Sanity: the downstream regex the route applies should yield ISO.
    if (future) {
      const iso = future.start.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6Z');
      allPass = check('downstream regex → valid ISO date',
        !Number.isNaN(Date.parse(iso)), `iso=${iso}`) && allPass;
    }
  } catch (err) {
    console.error('  [FAIL] unexpected error:', err.message);
    allPass = false;
  } finally {
    try {
      await postgresService.query('DELETE FROM epg_programs WHERE id IN ($1, $2)', [futureId, pastId]);
    } catch (_) {}
    console.log('  cleaned up test programs');
  }

  console.log('\n' + (allPass ? 'ALL PASS' : 'FAILED'));
  await postgresService.pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('[verify] fatal:', e); process.exit(1); });
