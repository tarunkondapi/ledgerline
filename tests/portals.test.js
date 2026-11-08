import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { SEED_PASSWORD } from '../scripts/seed.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });
const reg = { full_name: 'Test Person', phone: '+91 90000 11111', password: 'Sup3rSecret' };
const call = (portal, method, path, o = {}) => t.api(method, path, { portal, ...o });
const signin = (portal, email, password = SEED_PASSWORD) => call(portal, 'POST', '/api/login', { body: { email, password } });

test('each portal only signs in its own role, and tokens do not cross portals', async () => {
  assert.equal((await signin('admin', 'alice@ledgerline.test')).status, 403);
  assert.equal((await signin('holder', 'admin@ledgerline.test')).status, 403);
  assert.equal((await signin('auditor', 'alice@ledgerline.test')).status, 403);
  const a = await signin('admin', 'admin@ledgerline.test'), h = await signin('holder', 'alice@ledgerline.test');
  assert.equal(a.status, 200); assert.equal(h.status, 200);
  assert.equal((await call('admin', 'GET', '/api/me', { token: h.body.token })).status, 401, 'holder token on admin portal');
  assert.equal((await call('holder', 'GET', '/api/me', { token: a.body.token })).status, 401, 'admin token on holder portal');
  assert.equal((await call('auditor', 'GET', '/api/audit/verify', { token: a.body.token })).status, 401);
  assert.equal((await call('holder', 'GET', '/api/audit/verify', { token: h.body.token })).status, 404, 'holder portal has no audit API at all');
});

test('holder self-registration creates a user with their own account only', async () => {
  const r = await call('holder', 'POST', '/api/register', { body: { ...reg, email: 'newbie@example.com', account_name: 'Newbie Main', account_type: 'savings', role: 'admin', status: 'active' } });
  assert.equal(r.status, 201); assert.equal(r.body.user.role, 'holder', 'role in body ignored');
  const s = await signin('holder', 'newbie@example.com', reg.password);
  assert.equal(s.status, 200);
  const list = await call('holder', 'GET', '/api/accounts', { token: s.body.token });
  assert.equal(list.body.accounts.length, 1); assert.equal(list.body.accounts[0].name, 'Newbie Main');
  const dup = { ...reg, email: 'newbie@example.com', account_name: 'x', account_type: 'savings' };
  assert.equal((await call('holder', 'POST', '/api/register', { body: dup })).status, 409);
  assert.equal((await call('holder', 'POST', '/api/register', { body: { ...dup, email: 'weak@example.com', password: 'password' } })).status, 400);
  assert.equal((await call('holder', 'POST', '/api/register', { body: { ...dup, email: 'bad@example.com', account_type: 'gold' } })).status, 400);
  assert.equal((await call('admin', 'POST', '/api/register', { body: { ...dup, email: 'x@example.com' } })).status, 404, 'no registration on the admin portal');
  assert.equal((await call('auditor', 'POST', '/api/register', { body: { ...dup, email: 'y@example.com' } })).status, 404);
});

test('auditor applications stay pending until an admin approves; auditors stay read-only', async () => {
  const body = { ...reg, email: 'newaud@example.com', organisation: 'Test LLP', credential_id: 'ICAI-000111', purpose: 'Independent review of ledger' };
  assert.equal((await call('auditor', 'POST', '/api/register/auditor', { body })).status, 202);
  assert.equal((await call('holder', 'POST', '/api/register/auditor', { body: { ...body, email: 'z@example.com' } })).status, 404, 'only on the auditor portal');
  const early = await signin('auditor', body.email, reg.password);
  assert.equal(early.status, 403); assert.equal(early.body.error, 'pending_approval');
  const admin = (await signin('admin', 'admin@ledgerline.test')).body.token;
  const apps = (await call('admin', 'GET', '/api/admin/applications', { token: admin })).body.applications;
  const id = apps.find((u) => u.email === body.email).id;
  assert.equal((await call('admin', 'POST', `/api/admin/applications/${id}/decision`, { token: admin, body: { decision: 'approve' } })).status, 200);
  const ok = await signin('auditor', body.email, reg.password);
  assert.equal(ok.status, 200);
  assert.equal((await call('auditor', 'GET', '/api/audit/verify', { token: ok.body.token })).status, 200);
  assert.equal((await call('auditor', 'POST', '/api/deposits', { token: ok.body.token, body: { account_id: 2, amount: 100 } })).status, 404, 'no money endpoints on the auditor portal');
  const alice = (await signin('holder', 'alice@ledgerline.test')).body.token;
  assert.equal((await call('holder', 'POST', `/api/admin/applications/${id}/decision`, { token: alice, body: { decision: 'reject' } })).status, 404);
});

test('a disabled user is locked out immediately, even with a valid token', async () => {
  const admin = (await signin('admin', 'admin@ledgerline.test')).body.token;
  const tok = (await signin('holder', 'rahul@ledgerline.test')).body.token;
  const users = (await call('admin', 'GET', '/api/admin/users', { token: admin })).body.users;
  const id = users.find((u) => u.email === 'rahul@ledgerline.test').id, meId = users.find((u) => u.email === 'admin@ledgerline.test').id;
  assert.equal((await call('holder', 'GET', '/api/me', { token: tok })).status, 200);
  await call('admin', 'PATCH', `/api/admin/users/${id}`, { token: admin, body: { disabled: true } });
  assert.equal((await call('holder', 'GET', '/api/me', { token: tok })).status, 401);
  assert.equal((await signin('holder', 'rahul@ledgerline.test')).status, 403);
  assert.equal((await call('admin', 'PATCH', `/api/admin/users/${meId}`, { token: admin, body: { disabled: true } })).status, 400, 'admin cannot lock themselves out');
});

test('account limit holds under a race; seeded ledger verifies; sign-ins are logged', async () => {
  const tok = (await signin('holder', 'meera@ledgerline.test')).body.token;
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('holder', 'POST', '/api/me/accounts', { token: tok, body: { name: `Extra ${i}`, account_type: 'current' } })));
  assert.equal(rs.filter((r) => r.status === 201).length, 4, 'meera had 1, limit is 5');
  const aud = (await signin('auditor', 'auditor@ledgerline.test')).body.token;
  assert.equal((await call('auditor', 'GET', '/api/audit/verify', { token: aud })).body.ok, true);
  const ov = await call('auditor', 'GET', '/api/audit/overview', { token: aud });
  assert.ok(ov.body.holders >= 8 && ov.body.transactions > 10);
  const ev = await call('auditor', 'GET', '/api/audit/auth-events', { token: aud });
  assert.ok(ev.body.events.some((e) => e.outcome === 'wrong_portal'));
});
