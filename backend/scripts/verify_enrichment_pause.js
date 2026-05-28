/**
 * Verifies tmdbEnrichmentService.pause()/isPaused() works the way
 * we depend on in routes/iptvSources.js delete and
 * vodIngestService.ingestVodForSource.
 *
 * Doesn't run the actual worker (that hits external APIs); just
 * exercises the pause-counter semantics that gate it.
 */

const tmdb = require('../services/tmdbEnrichmentService');

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

let allPass = true;

console.log('\n[test 1] no pause active by default');
allPass = check('isPaused() === false', tmdb.isPaused() === false) && allPass;

console.log('\n[test 2] single pause + release');
const r1 = tmdb.pause();
allPass = check('isPaused() === true after pause()', tmdb.isPaused() === true) && allPass;
r1();
allPass = check('isPaused() === false after release', tmdb.isPaused() === false) && allPass;

console.log('\n[test 3] nested pauses (multiple concurrent ops)');
const r2 = tmdb.pause();
const r3 = tmdb.pause();
const r4 = tmdb.pause();
allPass = check('still paused with 3 outstanding holds', tmdb.isPaused() === true) && allPass;
r2();
allPass = check('still paused after 1st release (2 left)', tmdb.isPaused() === true) && allPass;
r3();
allPass = check('still paused after 2nd release (1 left)', tmdb.isPaused() === true) && allPass;
r4();
allPass = check('unpaused after all releases', tmdb.isPaused() === false) && allPass;

console.log('\n[test 4] double-release is a no-op (idempotent)');
const r5 = tmdb.pause();
r5();
r5(); // intentionally call twice
allPass = check('still unpaused (counter clamped at 0, not negative)', tmdb.isPaused() === false) && allPass;
// Acquire again — should work normally
const r6 = tmdb.pause();
allPass = check('pause acquires cleanly after double-release', tmdb.isPaused() === true) && allPass;
r6();

console.log('\n[test 5] runTick honors pause');
// Call runTick while paused — it should bail with reason:'paused'
const r7 = tmdb.pause();
tmdb.runTick().then((result) => {
  allPass = check('runTick returns skipped=true when paused', result.skipped === true && result.reason === 'paused',
    `got: ${JSON.stringify(result)}`) && allPass;
  r7();
  console.log('\n' + (allPass ? 'ALL PASS' : 'FAILED'));
  process.exit(allPass ? 0 : 1);
});
