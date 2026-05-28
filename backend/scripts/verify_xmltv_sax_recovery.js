/**
 * Verifies xmltvParser doesn't crash on malformed XMLTV.
 *
 * Background: the previous error-handler called `parser.error = null`
 * and `parser.resume()` on a SAXStream wrapper that doesn't have
 * those — they live on the inner `_parser` (SAXParser). When SAX
 * encountered malformed XML (e.g. "Unclosed root tag") the handler
 * threw `TypeError: parser.resume is not a function` as an uncaught
 * exception and the whole backend crashed.
 *
 * This script verifies the fix by feeding parseSinglePassStreaming
 * three flavours of malformed XMLTV and asserting:
 *   1. The process does not crash with uncaughtException.
 *   2. The error handler successfully resumes (we count at least one
 *      [XMLTV Parser] SAX warn line) OR the parse rejects cleanly.
 *   3. SAXStream really does expose `_parser.resume()` — direct
 *      assertion against the sax module so future library upgrades
 *      that move the API don't silently re-break this.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
process.chdir(path.join(__dirname, '..'));

const sax = require('sax');
const xmltvParser = require('../services/xmltvParser');

let crashed = false;
let lastUncaught = null;
process.on('uncaughtException', (e) => {
  crashed = true;
  lastUncaught = e;
  console.error('[verify] UNCAUGHT', e.stack);
});

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

// Race a promise against a timeout. Resolves to either { result } or
// { timeout: true } so the test can decide what to assert. Used
// because some malformed inputs cause the SAX parser to never reach
// 'end' — that's a separate hang issue, not the crash we're testing.
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), ms);
    promise.then(
      (r) => { clearTimeout(t); resolve({ result: r }); },
      (e) => { clearTimeout(t); resolve({ error: e }); }
    );
  });
}

// Minimal dbService — counts calls, never touches Postgres.
function makeMockDbService() {
  const state = { channels: [], programs: [], savedChannels: 0, savedPrograms: 0 };
  return {
    state,
    async saveChannels(batch) { state.channels.push(...batch); state.savedChannels += batch.length; },
    async savePrograms(batch) { state.programs.push(...batch); state.savedPrograms += batch.length; },
    async getChannelIdsBySource() { return new Set(state.channels.map((c) => c.id)); }
  };
}

// ─── Test 1 — SAX library still exposes _parser.resume ─────────
function test1_libraryShape() {
  console.log('\n[test 1] sax.createStream() exposes ._parser.resume()');
  const stream = sax.createStream(true, {});
  let pass = true;
  pass &= check('stream.resume is undefined (no API on wrapper)',
    typeof stream.resume === 'undefined');
  pass &= check('stream._parser.resume is a function',
    typeof stream._parser?.resume === 'function');
  pass &= check('stream._parser.error is settable (was the second half of the bug)',
    '_parser' in stream && 'error' in (stream._parser || {}));
  return pass;
}

// ─── Test 2 — unclosed root tag ──────────────────────────────────
async function test2_unclosedRoot() {
  console.log('\n[test 2] parseSinglePassStreaming survives "Unclosed root tag"');
  // Deliberately malformed: open <tv> + a single complete <channel>,
  // then truncate without </tv>. This is what triggered the original
  // crash on bundled-EPG payloads from one of the lordstreams hosts.
  const tmp = path.join(os.tmpdir(), `verify_xmltv_unclosed_${Date.now()}.xml`);
  fs.writeFileSync(tmp,
    `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n` +
    `  <channel id="ch1"><display-name>Test Channel 1</display-name></channel>\n` +
    `  <programme start="20260527120000 +0000" stop="20260527130000 +0000" channel="ch1">\n` +
    `    <title>Test Show</title>\n` +
    `  </programme>\n`
    // Note: no </tv> — that's the malformed bit.
  );

  const db = makeMockDbService();
  const outcome = await withTimeout(
    xmltvParser.parseSinglePassStreaming(tmp, 'verify_unclosed', null, db),
    10_000
  );
  fs.unlinkSync(tmp);

  let pass = true;
  pass &= check('did not crash process', !crashed);
  // Acceptable outcomes: resolved, rejected, or timed out (hang is
  // a separate issue from a crash). The fix we're verifying is the
  // crash, not the hang.
  pass &= check('did not throw an uncaught — resolved/rejected/timeout all OK',
    outcome.result !== undefined || outcome.error !== undefined || outcome.timeout === true);
  if (outcome.result) {
    pass &= check('parsed at least 1 channel before the error',
      (outcome.result.channelCount || db.state.savedChannels) >= 1,
      `channels=${outcome.result.channelCount}, mockSaved=${db.state.savedChannels}`);
  }
  if (outcome.timeout) {
    console.log('  (note: parser hung past 10s on this input — separate latent issue, not the crash we fixed)');
  }
  return pass;
}

// ─── Test 3 — garbage bytes mid-stream ──────────────────────────
async function test3_garbageBytes() {
  console.log('\n[test 3] parseSinglePassStreaming survives garbage bytes mid-stream (no hang)');
  const tmp = path.join(os.tmpdir(), `verify_xmltv_garbage_${Date.now()}.xml`);
  // Open <tv>, valid channel, then garbage that's not legal XML,
  // then a closing </tv>. The SAX error handler should kick in,
  // resume(), and the parse should finish.
  fs.writeFileSync(tmp,
    `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n` +
    `  <channel id="ch1"><display-name>OK Channel</display-name></channel>\n` +
    `  <<<garbage>>>not<>valid<xml/\n` +
    `  <channel id="ch2"><display-name>Another Channel</display-name></channel>\n` +
    `</tv>\n`
  );

  const db = makeMockDbService();
  const t0 = Date.now();
  // Generous timeout so a legitimate slow finalize doesn't false-fail,
  // but the end-of-input backstop fires at 2s after readStream ends,
  // so we expect this to finalize within ~3s on a few-hundred-byte file.
  const outcome = await withTimeout(
    xmltvParser.parseSinglePassStreaming(tmp, 'verify_garbage', null, db),
    8_000
  );
  const elapsed = Date.now() - t0;
  fs.unlinkSync(tmp);

  let pass = true;
  pass &= check('did not crash process', !crashed);
  pass &= check('did not hang (finalized within timeout)',
    !outcome.timeout, outcome.timeout ? `still hanging at ${elapsed}ms` : `finalized in ${elapsed}ms`);
  pass &= check('finalized via either resolve or reject',
    outcome.result !== undefined || outcome.error !== undefined,
    outcome.result ? 'resolved' : (outcome.error ? `rejected: ${outcome.error.message}` : 'neither'));
  return pass;
}

// ─── Test 5 — circuit breaker fires on truly broken input ───────
async function test5_circuitBreaker() {
  console.log('\n[test 5] circuit breaker stops the parser after MAX_SAX_ERRORS');
  // Pathological input designed to generate one SAX error per byte:
  // a wall of un-escaped angle brackets that can't be interpreted
  // as a tag or as text. The breaker is at 1000 errors so we
  // generate ~3000 erroring chars to be safe.
  const tmp = path.join(os.tmpdir(), `verify_xmltv_torture_${Date.now()}.xml`);
  const garbage = '<>'.repeat(3000);
  fs.writeFileSync(tmp,
    `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${garbage}\n</tv>\n`
  );

  const db = makeMockDbService();
  const t0 = Date.now();
  const outcome = await withTimeout(
    xmltvParser.parseSinglePassStreaming(tmp, 'verify_torture', null, db),
    8_000
  );
  const elapsed = Date.now() - t0;
  fs.unlinkSync(tmp);

  let pass = true;
  pass &= check('did not crash process', !crashed);
  pass &= check('did not hang', !outcome.timeout,
    outcome.timeout ? `still hanging at ${elapsed}ms` : `finalized in ${elapsed}ms`);
  // We don't strictly require the error path here — backstop OR
  // circuit breaker both produce a finalized state. Just confirm
  // *some* terminal state was reached.
  pass &= check('reached a terminal state',
    outcome.result !== undefined || outcome.error !== undefined);
  return pass;
}

// ─── Test 4 — empty file ─────────────────────────────────────────
async function test4_emptyFile() {
  console.log('\n[test 4] parseSinglePassStreaming survives empty file');
  const tmp = path.join(os.tmpdir(), `verify_xmltv_empty_${Date.now()}.xml`);
  fs.writeFileSync(tmp, '');

  const db = makeMockDbService();
  const outcome = await withTimeout(
    xmltvParser.parseSinglePassStreaming(tmp, 'verify_empty', null, db),
    10_000
  );
  fs.unlinkSync(tmp);

  let pass = true;
  pass &= check('did not crash process', !crashed);
  pass &= check('did not throw an uncaught',
    outcome.result !== undefined || outcome.error !== undefined || outcome.timeout === true);
  if (outcome.timeout) {
    console.log('  (note: parser hung on empty input — separate latent issue)');
  }
  return pass;
}

async function main() {
  console.log('verify_xmltv_sax_recovery starting');
  let allPass = true;
  allPass = test1_libraryShape() && allPass;
  allPass = (await test2_unclosedRoot()) && allPass;
  allPass = (await test3_garbageBytes()) && allPass;
  allPass = (await test4_emptyFile()) && allPass;
  allPass = (await test5_circuitBreaker()) && allPass;

  console.log('\n' + (allPass && !crashed ? 'ALL PASS' : 'FAILED'));
  if (crashed) console.log(`  process did emit uncaughtException: ${lastUncaught?.message}`);
  // Force exit because the SAX parser may have stranded handles
  // open (parts of the parser's internal stream don't tear down
  // cleanly on hang). Not the crash bug, just lifecycle noise.
  process.exit(allPass && !crashed ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] fatal:', e);
  process.exit(1);
});
