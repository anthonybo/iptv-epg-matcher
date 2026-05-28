/**
 * Top-level runner. Invokes each verify_* script as a separate
 * subprocess (each script has its own process.exit semantics and
 * its own pool/event-loop lifecycle, so isolating them keeps one
 * failure from poisoning the others). Reports aggregate PASS/FAIL.
 *
 * Run: `node backend/scripts/verify_all.js`
 */

const { spawn } = require('child_process');
const path = require('path');

const SCRIPTS = [
  'verify_vod_upsert_resilience.js',
  'verify_save_channels.js',
  'verify_xmltv_sax_recovery.js',
  'verify_startup_reconciler.js',
  'verify_enrichment_pause.js'
];

function runOne(scriptPath) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('node', [scriptPath], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ script: scriptPath, code, stdout, stderr, durationMs: Date.now() - t0 });
    });
  });
}

(async () => {
  console.log('===========================================');
  console.log(' verify_all — refresh-flow resilience suite');
  console.log('===========================================\n');

  const results = [];
  for (const s of SCRIPTS) {
    process.stdout.write(`▶ ${s} ... `);
    const r = await runOne(path.join(__dirname, s));
    results.push(r);
    const passLine = r.stdout.split('\n').reverse().find((l) => l.includes('ALL PASS') || l.includes('FAILED'));
    console.log(`exit=${r.code} (${(r.durationMs / 1000).toFixed(1)}s)  →  ${passLine || '(no summary line)'}`);
  }

  // Print per-script PASS/FAIL/note lines so you can drill in
  console.log('\n--- per-script detail ---');
  for (const r of results) {
    console.log(`\n[${r.script}]`);
    const interestingLines = r.stdout
      .split('\n')
      .filter((l) => /\[(PASS|FAIL)\]|^\[test|^ALL PASS|^FAILED|^  \(note|UNCAUGHT/.test(l));
    interestingLines.forEach((l) => console.log(l));
    if (r.code !== 0) {
      console.log('  >>> stderr:');
      r.stderr.split('\n').slice(0, 30).forEach((l) => console.log('     ' + l));
    }
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log('\n===========================================');
  if (failed.length === 0) {
    console.log(` ALL ${SCRIPTS.length} SUITES PASSED`);
    console.log('===========================================');
    process.exit(0);
  } else {
    console.log(` FAILED: ${failed.map((r) => r.script).join(', ')}`);
    console.log(`        (${failed.length}/${SCRIPTS.length} suites)`);
    console.log('===========================================');
    process.exit(1);
  }
})();
