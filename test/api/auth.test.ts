import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { setPasswordByUsername, MAX_FAILED_LOGINS } from '../../src/auth/lis-auth.js';
import { pool } from '../helpers/db.js';
import { createDxWorld } from '../helpers/dxworld.js';
import { createTestLab } from '../helpers/lab.js';
import { dxAuth } from '../helpers/auth.js';

let app: FastifyInstance;
before(() => { app = buildApp({ db: pool }); });
after(() => app.close());

const labCode = async (labId: string) => (await pool.query('SELECT code FROM lis.labs WHERE id = $1', [labId])).rows[0].code as string;

async function req(method: 'GET' | 'POST' | 'PUT', url: string, opts: { token?: string; body?: object } = {}) {
  const res = await app.inject({
    method, url, payload: opts.body,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function login(labId: string, username: string, password: string) {
  return req('POST', `/labs/${labId}/auth/login`, { body: { username, password } });
}

const events = async (subjectId: string) => (await pool.query(
  'SELECT event FROM auth_events WHERE subject_id = $1 ORDER BY id', [subjectId])).rows.map((r) => r.event as string);

// ---------------------------------------------------------------------------
// LIS staff
// ---------------------------------------------------------------------------

test('staff sign in with a password, use the session, and sign out', async () => {
  const lab = await createTestLab();
  await setPasswordByUsername(pool, await labCode(lab.labId), 'reception', 'correct horse 1');

  const ok = await login(lab.labId, 'Reception', 'correct horse 1'); // username is not case-sensitive
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.token, /^mrxs_[A-Za-z0-9_-]{43}$/);
  assert.equal(ok.body.staff.role, 'receptionist');
  assert.ok(new Date(ok.body.expires_at).getTime() > Date.now() + 11 * 3600_000, 'a session lasts a lab shift');
  const token = ok.body.token as string;

  assert.equal((await req('GET', `/labs/${lab.labId}/auth/me`, { token })).body.id, lab.reception);
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token })).status, 200);

  // Only hashes are stored, never the password or the token.
  const { rows: [u] } = await pool.query('SELECT password_hash FROM lis.staff_users WHERE id = $1', [lab.reception]);
  assert.match(u.password_hash, /^scrypt\$/);
  const { rows: leaked } = await pool.query(
    `SELECT 1 FROM lis.staff_sessions WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'`, [token.slice(5, 20)]);
  assert.equal(leaked.length, 0);

  assert.equal((await req('POST', `/labs/${lab.labId}/auth/logout`, { token })).status, 204);
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token })).status, 401, 'signed out');
  assert.deepEqual(await events(lab.reception), ['password_set', 'login_succeeded', 'logout']);
});

test('wrong passwords lock the account; unknown users get the same answer', async () => {
  const lab = await createTestLab();
  await setPasswordByUsername(pool, await labCode(lab.labId), 'tech', 'right password');

  const unknown = await login(lab.labId, 'nobody', 'whatever1');
  const wrong = await login(lab.labId, 'tech', 'wrong password');
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, wrong.body, 'no hint whether the username exists');

  for (let i = 1; i < MAX_FAILED_LOGINS; i++) assert.equal((await login(lab.labId, 'tech', 'wrong password')).status, 401);
  const locked = await login(lab.labId, 'tech', 'right password');
  assert.equal(locked.status, 429, 'locked even with the right password');
  assert.ok((await events(lab.tech)).includes('account_locked'));

  // An admin reset unlocks the account.
  await setPasswordByUsername(pool, await labCode(lab.labId), 'tech', 'a new password');
  assert.equal((await login(lab.labId, 'tech', 'a new password')).status, 200);
});

test('a staff member without a password, or who has left, cannot sign in', async () => {
  const lab = await createTestLab();
  assert.equal((await login(lab.labId, 'path', '')).status, 400);
  assert.equal((await login(lab.labId, 'path', 'anything at all')).status, 401, 'no password set yet');

  await setPasswordByUsername(pool, await labCode(lab.labId), 'path', 'pathologist pw');
  const { token } = (await login(lab.labId, 'path', 'pathologist pw')).body;
  await pool.query('UPDATE lis.staff_users SET active = false WHERE id = $1', [lab.path]);
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token })).status, 401, 'existing session stops working');
  assert.equal((await login(lab.labId, 'path', 'pathologist pw')).status, 401);
});

test('expired sessions and sessions from another lab are refused', async () => {
  const lab = await createTestLab();
  const other = await createTestLab();
  await setPasswordByUsername(pool, await labCode(lab.labId), 'reception', 'reception pw');
  const { token } = (await login(lab.labId, 'reception', 'reception pw')).body;

  assert.equal((await req('GET', `/labs/${other.labId}/tests`, { token })).status, 403);
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token: 'mrxs_made-up' })).status, 401);

  await pool.query(
    `UPDATE lis.staff_sessions SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour'
     WHERE staff_id = $1`, [lab.reception]);
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token })).status, 401);
});

test('changing your own password signs out your other sessions', async () => {
  const lab = await createTestLab();
  await setPasswordByUsername(pool, await labCode(lab.labId), 'tech', 'first password');
  const desk = (await login(lab.labId, 'tech', 'first password')).body.token;
  const phone = (await login(lab.labId, 'tech', 'first password')).body.token;
  const url = `/labs/${lab.labId}/auth/password`;

  assert.equal((await req('PUT', url, { token: desk, body: { current_password: 'nope', new_password: 'second password' } })).status, 403);
  assert.equal((await req('PUT', url, { token: desk, body: { current_password: 'first password', new_password: 'short' } })).status, 400);
  assert.equal((await req('PUT', url, { token: desk, body: { current_password: 'first password', new_password: 'second password' } })).status, 204);

  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token: desk })).status, 200, 'this session stays');
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token: phone })).status, 401, 'other sessions end');
  assert.equal((await login(lab.labId, 'tech', 'first password')).status, 401);
  assert.equal((await login(lab.labId, 'tech', 'second password')).status, 200);
});

test('only a lab admin can set another staff member\'s password, and only in their own lab', async () => {
  const lab = await createTestLab();
  const other = await createTestLab();
  const code = await labCode(lab.labId);
  const { rows: [adm] } = await pool.query(
    `INSERT INTO lis.staff_users (lab_id, username, full_name, role) VALUES ($1, 'admin', 'Admin', 'admin') RETURNING id`, [lab.labId]);
  await setPasswordByUsername(pool, code, 'admin', 'admin password');
  await setPasswordByUsername(pool, code, 'reception', 'reception pw');
  const admin = (await login(lab.labId, 'admin', 'admin password')).body.token;
  const desk = (await login(lab.labId, 'reception', 'reception pw')).body.token;

  const set = (token: string, staffId: string) =>
    req('PUT', `/labs/${lab.labId}/staff/${staffId}/password`, { token, body: { new_password: 'reset by admin' } });
  assert.equal((await set(desk, lab.tech)).status, 403);
  assert.equal((await set(admin, other.tech)).status, 404, 'another lab\'s staff are not visible');
  assert.equal((await set(admin, lab.reception)).status, 204);
  assert.equal((await req('GET', `/labs/${lab.labId}/tests`, { token: desk })).status, 401, 'reset signs the person out');
  assert.equal((await login(lab.labId, 'reception', 'reset by admin')).status, 200);
  const { rows } = await pool.query(`SELECT actor_ref FROM auth_events WHERE subject_id = $1 AND event = 'password_set' ORDER BY id`, [lab.reception]);
  assert.deepEqual(rows.map((r) => r.actor_ref), ['cli', adm.id]);
});

// ---------------------------------------------------------------------------
// MyRx DX API keys
// ---------------------------------------------------------------------------

test('DX calls need a valid API key for the organisation in the URL', async () => {
  const w = await createDxWorld();
  const feed = (headers: Record<string, string>, org = w.clinic) =>
    app.inject({ method: 'GET', url: `/dx/orgs/${org}/results/feed`, headers }).then((r) => r.statusCode);

  assert.equal(await feed({}), 401);
  assert.equal(await feed({ authorization: 'Bearer mrxk_nope_nope' }), 401);
  assert.equal(await feed({ 'x-dx-user': w.clinician }), 401, 'the old test header no longer works');
  const auth = await dxAuth(w.clinician);
  assert.equal(await feed(auth), 200);
  assert.equal(await feed(auth, w.otherClinic), 403, 'a key only works for its own organisation');
  assert.equal((await app.inject({ method: 'GET', url: `/dx/offers?code=GLU-${w.tag}` })).statusCode, 401);

  // A suspended membership stops the key at once.
  await pool.query(`UPDATE organisation_memberships SET status = 'suspended' WHERE user_id = $1`, [w.clinician]);
  assert.equal(await feed(auth), 403);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM auth_events WHERE event = 'api_key_rejected' AND at > now() - interval '1 minute'`);
  assert.ok(rows[0].n >= 1, "unknown keys are recorded");
});

test('an organisation admin issues, lists and revokes API keys', async () => {
  const w = await createDxWorld();
  const one = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows[0].id as string;
  const adminUser = await one(`INSERT INTO users (display_name) VALUES ('Clinic admin') RETURNING id`, []);
  await pool.query(`INSERT INTO organisation_memberships (organisation_id, user_id, role_code) VALUES ($1, $2, 'org_admin')`, [w.clinic, adminUser]);
  const emrUser = await one(`INSERT INTO users (display_name) VALUES ('MyRx EMR') RETURNING id`, []);
  await pool.query(`INSERT INTO organisation_memberships (organisation_id, user_id, role_code) VALUES ($1, $2, 'integration_service')`, [w.clinic, emrUser]);

  const admin = await dxAuth(adminUser);
  const base = `/dx/orgs/${w.clinic}/api-keys`;
  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: object) =>
    app.inject({ method, url, headers, payload }).then((r) => ({ status: r.statusCode, body: r.json() }));

  assert.equal((await call('POST', base, await dxAuth(w.clinician), { user_id: emrUser, name: 'x' })).status, 403, 'clinicians cannot issue keys');
  assert.equal((await call('POST', base, admin, { user_id: w.labAUser, name: 'x' })).status, 400, 'only for members of this organisation');

  const created = await call('POST', base, admin, { user_id: emrUser, name: 'MyRx EMR production' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.key, /^mrxk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
  const emr = { authorization: `Bearer ${created.body.key}` };
  assert.equal((await call('GET', `/dx/orgs/${w.clinic}/results/feed`, emr)).status, 200);

  const list = await call('GET', base, admin);
  const listed = list.body.find((k: { id: string }) => k.id === created.body.id);
  assert.equal(listed.key_prefix, created.body.key_prefix);
  assert.ok(listed.last_used_at, 'last use is shown');
  assert.ok(!JSON.stringify(list.body).includes(created.body.key), 'the key value is never shown again');
  assert.ok(!('key_hash' in listed));

  assert.equal((await call('POST', `${base}/${created.body.id}/revoke`, admin)).status, 200);
  assert.equal((await call('GET', `/dx/orgs/${w.clinic}/results/feed`, emr)).status, 401);

  // The database keeps revocation final and keys on their owner.
  await assert.rejects(pool.query('UPDATE dx_api_keys SET revoked_at = NULL WHERE id = $1', [created.body.id]), /cannot be restored/);
  await assert.rejects(pool.query('UPDATE dx_api_keys SET user_id = $2 WHERE id = $1', [created.body.id, adminUser]), /cannot be reassigned/);
  await assert.rejects(pool.query('DELETE FROM dx_api_keys WHERE id = $1', [created.body.id]), /revoked, not deleted/);
  await assert.rejects(pool.query('DELETE FROM auth_events WHERE subject_id = $1', [created.body.id]), /append-only/);
});

test('expired API keys are refused', async () => {
  const w = await createDxWorld();
  const auth = await dxAuth(w.labAUser);
  const work = () => app.inject({ method: 'GET', url: `/dx/orgs/${w.labA}/work`, headers: auth }).then((r) => r.statusCode);
  assert.equal(await work(), 200);
  await pool.query(
    `UPDATE dx_api_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE user_id = $1`,
    [w.labAUser]);
  assert.equal(await work(), 401);
});
