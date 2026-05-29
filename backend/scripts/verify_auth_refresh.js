/**
 * Verifies the silent token-refresh flow + that auth runs on Postgres.
 *
 * Covers:
 *  1. authService.refreshToken grace-window boundaries (unit)
 *  2. POST /api/auth/refresh over HTTP (expired→fresh, garbage→401,
 *     beyond-grace→401)
 *  3. The session-migration contract: a freshly-refreshed token must
 *     authenticate on a protected route (/api/auth/me). This is the
 *     bug that bit during development — a new JWT is useless until
 *     it's registered in user_sessions.
 *  4. The session row created by refresh lives in POSTGRES (auth was
 *     migrated off sqlite).
 *
 * Run (backend must be up on :5001):
 *   node backend/scripts/verify_auth_refresh.js
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

// Load the same .env the server uses so JWT_SECRET matches — otherwise
// tokens we mint here are signed with a different secret and the
// backend rejects them as "Invalid token".
require('dotenv').config();

const jwt = require('jsonwebtoken');
const authService = require('../services/authService');
const userService = require('../services/userService');
const postgresService = require('../services/postgresService');

const BASE = 'http://localhost:5001';
const SECRET = process.env.JWT_SECRET || 'iptv-epg-matcher-secret-change-in-production';

const createdTokens = []; // session tokens to clean up at the end

function check(label, cond, detail) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

const mintToken = (userId, username, email, expOffsetSec) => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ userId, username, email, iat: now - 1, exp: now + expOffsetSec }, SECRET);
};

async function main() {
  console.log('verify_auth_refresh starting');

  // Use a real PG user so /me's findUserById succeeds.
  const u = await postgresService.query('SELECT id, username, email FROM users ORDER BY id LIMIT 1');
  if (u.rows.length === 0) { console.log('No users in PG — cannot test'); process.exit(1); }
  const { id: userId, username, email } = u.rows[0];
  console.log(`  using PG user id=${userId} (${username})`);

  let allPass = true;

  // ── Test 1: refreshToken boundaries (unit) ──────────────────────
  console.log('\n[test 1] authService.refreshToken grace-window boundaries');
  try {
    const r = authService.refreshToken(mintToken(userId, username, email, -3600)); // expired 1h
    allPass = check('expired within grace → refreshes', !!r.token) && allPass;
  } catch (e) { allPass = check('expired within grace → refreshes', false, e.message) && allPass; }

  let beyondRejected = false;
  try { authService.refreshToken(mintToken(userId, username, email, -20 * 86400)); }
  catch (_) { beyondRejected = true; }
  allPass = check('expired beyond 14d grace → rejected', beyondRejected) && allPass;

  let badRejected = false;
  try { authService.refreshToken('a.b.c'); } catch (_) { badRejected = true; }
  allPass = check('bad signature → rejected', badRejected) && allPass;

  // ── Test 2: HTTP /api/auth/refresh ──────────────────────────────
  console.log('\n[test 2] POST /api/auth/refresh');
  const expired = mintToken(userId, username, email, -3600);
  const resp = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expired}` }
  });
  const body = await resp.json().catch(() => ({}));
  allPass = check('expired token → 200 + fresh token', resp.status === 200 && !!body.token,
    `status=${resp.status}`) && allPass;
  const freshToken = body.token;
  if (freshToken) createdTokens.push(freshToken);

  const garbage = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST', headers: { Authorization: 'Bearer not.a.jwt' }
  });
  allPass = check('garbage token → 401', garbage.status === 401, `status=${garbage.status}`) && allPass;

  const ancient = mintToken(userId, username, email, -30 * 86400);
  const ancientResp = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST', headers: { Authorization: `Bearer ${ancient}` }
  });
  allPass = check('expired-beyond-grace token → 401', ancientResp.status === 401,
    `status=${ancientResp.status}`) && allPass;

  // ── Test 3: fresh token authenticates on a protected route ──────
  console.log('\n[test 3] fresh token authenticates on /api/auth/me (session migration)');
  if (freshToken) {
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${freshToken}` } });
    allPass = check('GET /api/auth/me → 200 with fresh token', me.status === 200,
      `status=${me.status}`) && allPass;
  } else {
    allPass = check('GET /api/auth/me → 200 with fresh token', false, 'no fresh token to test') && allPass;
  }

  // ── Test 4: session row is in Postgres ──────────────────────────
  console.log('\n[test 4] refreshed session persisted in Postgres (not sqlite)');
  if (freshToken) {
    const sess = await postgresService.query(
      'SELECT user_id, expires_at > NOW() AS valid FROM user_sessions WHERE token = $1',
      [freshToken]
    );
    allPass = check('session row exists in PG user_sessions', sess.rows.length === 1,
      `rows=${sess.rows.length}`) && allPass;
    allPass = check('session is valid (not expired)', sess.rows[0]?.valid === true) && allPass;
    allPass = check('session bound to correct user', sess.rows[0]?.user_id === userId) && allPass;
  }

  // Cleanup any session rows this test created.
  for (const t of createdTokens) {
    try { await userService.deleteSession(t); } catch (_) {}
  }
  console.log(`  cleaned up ${createdTokens.length} test session(s)`);

  console.log('\n' + (allPass ? 'ALL PASS' : 'FAILED'));
  await postgresService.pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('[verify] fatal:', e); process.exit(1); });
