/**
 * Runs every Postgres-migration verification suite in sequence and
 * reports an aggregate PASS/FAIL. Each suite runs in its own process
 * (separate PG pool lifecycle + process.exit). Backend must be up on
 * :5001 for the auth-refresh HTTP checks.
 *
 *   node backend/scripts/verify_all_db.js
 */

const { spawn } = require('child_process');
const path = require('path');

const SUITES = [
  'verify_user_service_pg.js',   // auth users + sessions on PG
  'verify_auth_refresh.js',      // /api/auth/refresh + session migration
  'verify_metrics_pg.js',        // metrics writes on PG (BIGINT timestamps)
  'verify_xtream_epg_pg.js'      // XTREAM EPG read from PG (XMLTV format)
];

function runOne(scriptPath) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('node', [scriptPath], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ script: path.basename(scriptPath), code, out, ms: Date.now() - t0 }));
  });
}

(async () => {
  console.log('===========================================');
  console.log(' verify_all_db — sqlite→Postgres migration suite');
  console.log('===========================================\n');

  const results = [];
  for (const s of SUITES) {
    process.stdout.write(`▶ ${s} ... `);
    const r = await runOne(path.join(__dirname, s));
    results.push(r);
    const summary = r.out.split('\n').reverse().find((l) => l.includes('ALL PASS') || l.includes('FAILED'));
    console.log(`exit=${r.code} (${(r.ms / 1000).toFixed(1)}s) → ${summary || '(no summary)'}`);
  }

  console.log('\n--- per-suite assertions ---');
  for (const r of results) {
    console.log(`\n[${r.script}]`);
    r.out.split('\n').filter((l) => /\[(PASS|FAIL)\]/.test(l)).forEach((l) => console.log(l));
    if (r.code !== 0) {
      console.log('  >>> output tail:');
      r.out.split('\n').slice(-12).forEach((l) => console.log('     ' + l));
    }
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log('\n===========================================');
  if (failed.length === 0) {
    console.log(` ALL ${SUITES.length} SUITES PASSED`);
    process.exit(0);
  } else {
    console.log(` FAILED: ${failed.map((r) => r.script).join(', ')}`);
    process.exit(1);
  }
})();
