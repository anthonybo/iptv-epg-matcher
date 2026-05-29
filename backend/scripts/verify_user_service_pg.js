/**
 * Verifies userService runs correctly on Postgres (migrated off the
 * legacy sqlite iptv.db). Exercises the full surface against a
 * throwaway test user that's deleted at the end:
 *
 *   - createUser (+ duplicate username/email rejection)
 *   - findUserByUsername / findUserByEmail / findUserById
 *   - authenticateUser (correct + wrong password)
 *   - updateLastLogin
 *   - createUserSession / findSessionByToken
 *   - updateSessionToken (the refresh session-migration path)
 *   - deleteSession / deleteExpiredSessions
 *
 * Run: node backend/scripts/verify_user_service_pg.js
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const userService = require('../services/userService');
const postgresService = require('../services/postgresService');

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

const SUFFIX = Date.now().toString(36);
const TEST_USERNAME = `verifyuser_${SUFFIX}`;
const TEST_EMAIL = `verify_${SUFFIX}@example.com`;
const TEST_PASSWORD = 'Verify1234!';

let createdUserId = null;
const createdTokens = [];

async function cleanup() {
  try {
    for (const t of createdTokens) await postgresService.query('DELETE FROM user_sessions WHERE token = $1', [t]);
    if (createdUserId) {
      await postgresService.query('DELETE FROM user_sessions WHERE user_id = $1', [createdUserId]);
      await postgresService.query('DELETE FROM users WHERE id = $1', [createdUserId]);
    }
  } catch (e) {
    console.warn('  cleanup warning:', e.message);
  }
}

async function main() {
  console.log('verify_user_service_pg starting');
  let allPass = true;

  try {
    // ── createUser ──────────────────────────────────────────────
    console.log('\n[test 1] createUser + lookups');
    const created = await userService.createUser({
      username: TEST_USERNAME, email: TEST_EMAIL, password: TEST_PASSWORD
    });
    createdUserId = created.id;
    allPass = check('createUser returns an id', Number.isInteger(created.id)) && allPass;

    const byUsername = await userService.findUserByUsername(TEST_USERNAME);
    allPass = check('findUserByUsername finds it', byUsername && byUsername.id === createdUserId) && allPass;
    allPass = check('password hash present (not leaked to plain)', !!byUsername.passwordHash && byUsername.passwordHash !== TEST_PASSWORD) && allPass;

    const byEmail = await userService.findUserByEmail(TEST_EMAIL);
    allPass = check('findUserByEmail finds it', byEmail && byEmail.id === createdUserId) && allPass;

    const byId = await userService.findUserById(createdUserId);
    allPass = check('findUserById returns no passwordHash', byId && byId.passwordHash === undefined) && allPass;

    // ── duplicate rejection ─────────────────────────────────────
    console.log('\n[test 2] duplicate username/email rejected');
    let dupUser = false, dupEmail = false;
    try { await userService.createUser({ username: TEST_USERNAME, email: `other_${SUFFIX}@x.com`, password: TEST_PASSWORD }); }
    catch (e) { dupUser = /username already exists/i.test(e.message); }
    allPass = check('duplicate username → "Username already exists"', dupUser) && allPass;
    try { await userService.createUser({ username: `other_${SUFFIX}`, email: TEST_EMAIL, password: TEST_PASSWORD }); }
    catch (e) { dupEmail = /email already exists/i.test(e.message); }
    allPass = check('duplicate email → "Email already exists"', dupEmail) && allPass;

    // ── authenticate ────────────────────────────────────────────
    console.log('\n[test 3] authenticateUser');
    const authOk = await userService.authenticateUser(TEST_USERNAME, TEST_PASSWORD);
    allPass = check('correct password authenticates', authOk && authOk.id === createdUserId) && allPass;
    let authFail = false;
    try { await userService.authenticateUser(TEST_USERNAME, 'WrongPassword9!'); }
    catch (e) { authFail = /invalid username or password/i.test(e.message); }
    allPass = check('wrong password rejected', authFail) && allPass;
    // authenticate by email too
    const authByEmail = await userService.authenticateUser(TEST_EMAIL, TEST_PASSWORD);
    allPass = check('authenticate by email works', authByEmail && authByEmail.id === createdUserId) && allPass;

    // ── sessions ────────────────────────────────────────────────
    console.log('\n[test 4] sessions: create / find / migrate / delete');
    const sid = `verify_sess_${SUFFIX}`;
    const tokenA = `tokenA_${SUFFIX}`;
    const tokenB = `tokenB_${SUFFIX}`;
    createdTokens.push(tokenA, tokenB);

    await userService.createUserSession(createdUserId, sid, tokenA);
    const foundA = await userService.findSessionByToken(tokenA);
    allPass = check('createUserSession + findSessionByToken', foundA && foundA.userId === createdUserId) && allPass;

    const mig = await userService.updateSessionToken(createdUserId, tokenA, tokenB);
    allPass = check('updateSessionToken migrates existing row (updated=true)', mig.updated === true) && allPass;
    const foundB = await userService.findSessionByToken(tokenB);
    allPass = check('new token now resolves to the session', foundB && foundB.sessionId === sid) && allPass;
    const oldGone = await userService.findSessionByToken(tokenA);
    allPass = check('old token no longer resolves', oldGone === null) && allPass;

    // updateSessionToken with an unknown old token → creates fresh session
    const tokenC = `tokenC_${SUFFIX}`;
    createdTokens.push(tokenC);
    const migNew = await userService.updateSessionToken(createdUserId, 'nonexistent_old_token', tokenC);
    allPass = check('updateSessionToken with unknown old token creates new (updated=false)', migNew.updated === false && !!migNew.sessionId) && allPass;
    allPass = check('that new token authenticates', (await userService.findSessionByToken(tokenC)) !== null) && allPass;

    const del = await userService.deleteSession(tokenB);
    allPass = check('deleteSession removes the row', del === true && (await userService.findSessionByToken(tokenB)) === null) && allPass;

    // ── expired-session cleanup ─────────────────────────────────
    console.log('\n[test 5] deleteExpiredSessions');
    const expiredToken = `expired_${SUFFIX}`;
    await postgresService.query(
      `INSERT INTO user_sessions (user_id, session_id, token, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', CURRENT_TIMESTAMP)`,
      [createdUserId, `verify_expired_${SUFFIX}`, expiredToken]
    );
    createdTokens.push(expiredToken);
    const deletedCount = await userService.deleteExpiredSessions();
    allPass = check('deleteExpiredSessions removes expired rows', deletedCount >= 1, `deleted=${deletedCount}`) && allPass;
    allPass = check('expired token gone', (await userService.findSessionByToken(expiredToken)) === null) && allPass;
  } catch (err) {
    console.error('  [FAIL] unexpected error:', err.message);
    allPass = false;
  } finally {
    await cleanup();
    console.log('  cleaned up test user + sessions');
  }

  console.log('\n' + (allPass ? 'ALL PASS' : 'FAILED'));
  await postgresService.pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('[verify] fatal:', e); process.exit(1); });
