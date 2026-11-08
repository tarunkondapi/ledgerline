import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, uuid } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });
const ALICE = 'alice@ledgerline.test', BOB = 'bob@ledgerline.test';

test("one user cannot move or read another user's money (IDOR)", async () => {
  const alice = await t.as(ALICE), bob = await t.as(BOB);
  const A = await t.account(ALICE, 10_000), B = await t.account(BOB, 0);
  const w = await t.post('/api/withdrawals', bob, { account_id: A, amount: 100 });
  const tr = await t.post('/api/transfers', bob, { from_account_id: A, to_account_id: B, amount: 5_000 });
  const dep = await t.post('/api/deposits', bob, { account_id: A, amount: 100 });
  const st = await t.api('GET', `/api/accounts/${A}/statement`, { token: bob });
  const bal = await t.api('GET', `/api/accounts/${A}`, { token: bob });
  for (const r of [w, tr, dep, st, bal]) assert.equal(r.status, 404);
  assert.equal(await t.balance(A), 10_000); assert.equal(await t.balance(B), 0);
  // refusing is indistinguishable from "does not exist"
  assert.deepEqual((await t.api('GET', '/api/accounts/999999', { token: bob })).body, (await t.api('GET', `/api/accounts/${A}`, { token: bob })).body);
  // the attempt is on the record (visible to auditor, not leaked to holders' statements)
  const aud = await t.api('GET', '/api/audit/attempts?outcome=forbidden', { token: await t.as('auditor@ledgerline.test') });
  assert.ok(aud.body.attempts.some((a) => a.account_id === A));
  const aliceStmt = await t.api('GET', `/api/accounts/${A}/statement`, { token: alice });
  assert.ok(!aliceStmt.body.items.some((i) => i.outcome === 'forbidden'));
});

test('roles: write/admin routes do not exist on the auditor and holder portals; unauthenticated is refused', async () => {
  const auditor = await t.as('auditor@ledgerline.test'), alice = await t.as(ALICE);
  const A = await t.account(ALICE, 1_000);
  assert.equal((await t.post('/api/deposits', auditor, { account_id: A, amount: 100 })).status, 404);
  assert.equal((await t.post('/api/withdrawals', auditor, { account_id: A, amount: 100 })).status, 404);
  assert.equal((await t.post('/api/transfers', auditor, { from_account_id: A, to_account_id: A + 1, amount: 100 })).status, 404);
  assert.equal((await t.post('/api/admin/adjustments', alice, { account_id: A, amount: 100, reason: 'free money' })).status, 404);
  assert.equal((await t.post('/api/admin/transactions/1/reverse', alice, { reason: 'undo please' })).status, 404);
  assert.equal((await t.api('POST', '/api/accounts', { token: alice, body: { name: 'x', owner_email: ALICE } })).status, 404);
  assert.equal((await t.api('PATCH', `/api/admin/accounts/${A}`, { token: alice, body: { overdraft_limit: 1e9 } })).status, 404);
  assert.equal((await t.api('GET', '/api/audit/verify', { token: alice })).status, 404);
  assert.equal((await t.api('GET', `/api/accounts/${A}`)).status, 401);
  assert.equal((await t.api('GET', `/api/accounts/${A}`, { token: 'garbage' })).status, 401);
  assert.equal(await t.balance(A), 1_000);
});

test('mass assignment: role / owner / balance in request bodies are ignored', async () => {
  const bob = await t.as(BOB), alice = await t.as(ALICE);
  const A = await t.account(ALICE, 1_000), B = await t.account(BOB, 1_000);
  const r = await t.post('/api/withdrawals', bob, { account_id: A, amount: 10, role: 'admin', user_id: 2, owner_id: 3, balance: 1e9 });
  assert.equal(r.status, 404);
  const ok = await t.post('/api/withdrawals', bob, { account_id: B, amount: 10, balance: 1e9, role: 'admin' });
  assert.equal(ok.status, 201); assert.equal(await t.balance(B), 990);
  const login = await t.api('POST', '/api/login', { body: { email: BOB, password: 'Passw0rd!demo', role: 'admin' } });
  assert.equal(login.body.user.role, 'holder');
  assert.equal((await t.post('/api/admin/adjustments', bob, { account_id: B, amount: 1e6, reason: 'self service' })).status, 404);
  assert.equal(alice.length > 10, true);
});

test('ledger is append-only: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
  await t.account(ALICE, 1_000);
  for (const tbl of ['ledger_entries', 'transactions', 'attempts', 'admin_log', 'auth_events']) {
    await assert.rejects(t.pool.query(`UPDATE ${tbl} SET id = id`), /append-only/, `${tbl} UPDATE`);
    await assert.rejects(t.pool.query(`DELETE FROM ${tbl}`), /append-only/, `${tbl} DELETE`);
    await assert.rejects(t.pool.query(`TRUNCATE ${tbl} CASCADE`), /append-only/, `${tbl} TRUNCATE`);
  }
});

test('database itself refuses overdraw and unbalanced/forged ledger writes', async () => {
  const A = await t.account(ALICE, 1_000);
  await assert.rejects(t.pool.query('UPDATE accounts SET balance = -1 WHERE id=$1', [A]), /no_overdraw/);
  // balance edited without a ledger entry -> rejected at commit
  await assert.rejects(t.pool.query('UPDATE accounts SET balance = balance + 5 WHERE id=$1', [A]), /does not match ledger/);
  // an unbalanced transaction (credit with no matching debit) -> rejected at commit
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [tx] } = await c.query(`INSERT INTO transactions (type, initiated_by, idempotency_key) VALUES ('deposit',1,'forged-0001') RETURNING id`);
    const { rows: [a] } = await c.query('SELECT balance, last_hash FROM accounts WHERE id=$1 FOR UPDATE', [A]);
    await c.query(`INSERT INTO ledger_entries (txn_id, account_id, amount, balance_after, prev_hash, row_hash, created_at) VALUES ($1,$2,500,$3,$4,'x',now())`, [tx.id, A, a.balance + 500, a.last_hash]);
    await c.query('UPDATE accounts SET balance = balance + 500, last_hash=$2 WHERE id=$1', [A, 'x']);
    await assert.rejects(c.query('COMMIT'), /does not net to zero/);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  assert.equal(await t.balance(A), 1_000);
});

test('tampering with a ledger row is detected by the hash chain (even by a privileged editor)', async () => {
  const auditor = await t.as('auditor@ledgerline.test');
  const A = await t.account(ALICE, 7_000);
  assert.equal((await t.api('GET', '/api/audit/verify', { token: auditor })).body.ok, true);
  const { rows: [e] } = await t.pool.query('SELECT id, amount FROM ledger_entries WHERE account_id=$1 ORDER BY id LIMIT 1', [A]);
  const c = await t.pool.connect();
  try {
    await c.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER'); // simulates a superuser bypassing the triggers
    await c.query('UPDATE ledger_entries SET amount = amount - 1000 WHERE id=$1', [e.id]);
    const v = await t.api('GET', '/api/audit/verify', { token: auditor });
    assert.equal(v.body.ok, false);
    assert.ok(v.body.problems.some((p) => p.entry_id === e.id && /row_hash_mismatch/.test(p.problem)), JSON.stringify(v.body.problems));
  } finally {
    await c.query('UPDATE ledger_entries SET amount = $2 WHERE id=$1', [e.id, e.amount]);
    await c.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
    c.release();
  }
  assert.equal((await t.api('GET', '/api/audit/verify', { token: auditor })).body.ok, true);
});

test('statement lists postings and refused attempts with running balance and initiator', async () => {
  const alice = await t.as(ALICE);
  const A = await t.account(ALICE, 2_000);
  await t.post('/api/withdrawals', alice, { account_id: A, amount: 500 });
  await t.post('/api/withdrawals', alice, { account_id: A, amount: 9_999 }); // refused
  const s = await t.api('GET', `/api/accounts/${A}/statement`, { token: alice });
  const posts = s.body.items.filter((i) => i.kind === 'posting');
  assert.deepEqual(posts.map((p) => p.balance_after), [2_000, 1_500]);
  assert.ok(posts.every((p) => p.initiated_by));
  assert.ok(s.body.items.some((i) => i.kind === 'attempt' && i.outcome === 'refused' && i.reason === 'insufficient_funds'));
});

test('admin actions on others\' accounts and large amounts are flagged', async () => {
  const admin = await t.as('admin@ledgerline.test'), auditor = await t.as('auditor@ledgerline.test');
  const A = await t.account(ALICE, 0);
  await t.post('/api/deposits', admin, { account_id: A, amount: 20_000_000 });
  await t.post('/api/admin/adjustments', admin, { account_id: A, amount: -100, reason: 'fee correction' });
  const f = await t.api('GET', '/api/audit/flags', { token: auditor });
  assert.ok(f.body.flagged.some((x) => /admin_on_behalf/.test(x.flag_reasons) && /large_amount/.test(x.flag_reasons)));
  assert.ok(f.body.flagged.some((x) => x.type === 'adjustment'));
});
