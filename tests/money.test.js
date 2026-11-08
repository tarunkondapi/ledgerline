import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, uuid } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });
const ALICE = 'alice@ledgerline.test', BOB = 'bob@ledgerline.test';

test('no overdraw under race: 50 concurrent withdrawals of 10 against balance 100', async () => {
  const alice = await t.as(ALICE);
  const acct = await t.account(ALICE, 10_000);
  const rs = await Promise.all(Array.from({ length: 50 }, () => t.post('/api/withdrawals', alice, { account_id: acct, amount: 1_000 })));
  const ok = rs.filter((r) => r.status === 201).length, refused = rs.filter((r) => r.status === 422).length;
  assert.equal(ok, 10); assert.equal(refused, 40);
  assert.equal(await t.balance(acct), 0);
  const { rows } = await t.pool.query("SELECT count(*)::int n FROM attempts WHERE account_id=$1 AND outcome='refused'", [acct]);
  assert.equal(rows[0].n, 40, 'every refused attempt is on the ledger');
  assert.deepEqual(await t.conservation(), { total: 0, mismatched: [], unbalanced: [], negative: [] });
});

test('overdraft limit is honoured exactly under race', async () => {
  const alice = await t.as(ALICE);
  const acct = await t.account(ALICE, 1_000, 2_000); // can go to -2000
  const rs = await Promise.all(Array.from({ length: 20 }, () => t.post('/api/withdrawals', alice, { account_id: acct, amount: 500 })));
  assert.equal(rs.filter((r) => r.status === 201).length, 6);
  assert.equal(await t.balance(acct), -2_000);
});

test('sequential replay moves money once and returns the same answer', async () => {
  const alice = await t.as(ALICE);
  const acct = await t.account(ALICE, 5_000), key = uuid();
  const a = await t.post('/api/withdrawals', alice, { account_id: acct, amount: 1_000 }, key);
  const b = await t.post('/api/withdrawals', alice, { account_id: acct, amount: 1_000 }, key);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(a.replay, false); assert.equal(b.replay, true);
  assert.deepEqual(a.body, b.body);
  assert.equal(await t.balance(acct), 4_000);
  const { rows } = await t.pool.query(`SELECT outcome FROM attempts WHERE idempotency_key=$1 ORDER BY id`, [key]);
  assert.deepEqual(rows.map((r) => r.outcome), ['success', 'replay'], 'duplicate is visible in the data');
  assert.equal((await t.pool.query('SELECT count(*)::int n FROM transactions WHERE idempotency_key=$1', [key])).rows[0].n, 1);
});

test('parallel replay: same key x20 at once moves money exactly once', async () => {
  const alice = await t.as(ALICE);
  const acct = await t.account(ALICE, 5_000), key = uuid();
  const rs = await Promise.all(Array.from({ length: 20 }, () => t.post('/api/withdrawals', alice, { account_id: acct, amount: 700 }, key)));
  assert.ok(rs.every((r) => r.status === 201));
  assert.equal(new Set(rs.map((r) => r.body.transaction.id)).size, 1);
  assert.equal(rs.filter((r) => !r.replay).length, 1);
  assert.equal(await t.balance(acct), 4_300);
});

test('same key with a different body is rejected (422) and moves nothing', async () => {
  const alice = await t.as(ALICE);
  const acct = await t.account(ALICE, 5_000), key = uuid();
  await t.post('/api/withdrawals', alice, { account_id: acct, amount: 100 }, key);
  const r = await t.post('/api/withdrawals', alice, { account_id: acct, amount: 4_000 }, key);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'idempotency_key_reuse');
  assert.equal(await t.balance(acct), 4_900);
});

test('a refused request replays as the same refusal, even after funds arrive', async () => {
  const alice = await t.as(ALICE), admin = await t.as('admin@ledgerline.test');
  const acct = await t.account(ALICE, 100), key = uuid();
  const a = await t.post('/api/withdrawals', alice, { account_id: acct, amount: 500 }, key);
  assert.equal(a.status, 422);
  await t.post('/api/deposits', admin, { account_id: acct, amount: 10_000 });
  const b = await t.post('/api/withdrawals', alice, { account_id: acct, amount: 500 }, key);
  assert.equal(b.status, 422); assert.equal(b.replay, true);
  assert.equal(await t.balance(acct), 10_100);
});

test('keys are scoped per user: another user cannot replay or collide with my key', async () => {
  const alice = await t.as(ALICE), bob = await t.as(BOB);
  const a = await t.account(ALICE, 5_000), b = await t.account(BOB, 5_000), key = uuid();
  await t.post('/api/withdrawals', alice, { account_id: a, amount: 100 }, key);
  const r = await t.post('/api/withdrawals', bob, { account_id: b, amount: 100 }, key);
  assert.equal(r.status, 201); assert.equal(r.replay, false);
  assert.equal(await t.balance(b), 4_900);
});

test('deadlock-prone traffic: 50 A->B and 50 B->A at once all complete, money conserved', async () => {
  const alice = await t.as(ALICE), bob = await t.as(BOB);
  const A = await t.account(ALICE, 100_000), B = await t.account(BOB, 100_000);
  const rs = await Promise.all([
    ...Array.from({ length: 50 }, () => t.post('/api/transfers', alice, { from_account_id: A, to_account_id: B, amount: 100 })),
    ...Array.from({ length: 50 }, () => t.post('/api/transfers', bob, { from_account_id: B, to_account_id: A, amount: 100 })),
  ]);
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.find((r) => r.status !== 201)));
  assert.equal((await t.balance(A)) + (await t.balance(B)), 200_000);
  assert.deepEqual(await t.conservation(), { total: 0, mismatched: [], unbalanced: [], negative: [] });
});

test('conservation fuzz: 300 random concurrent deposits/withdrawals/transfers', async () => {
  const alice = await t.as(ALICE), bob = await t.as(BOB), admin = await t.as('admin@ledgerline.test');
  const accts = [await t.account(ALICE, 50_000), await t.account(ALICE, 50_000), await t.account(BOB, 50_000)];
  const owner = (id) => (id === accts[2] ? bob : alice);
  const pick = () => accts[Math.floor(Math.random() * 3)];
  const before = (await Promise.all(accts.map(t.balance))).reduce((a, b) => a + b, 0);
  let netExternal = 0;
  for (let batch = 0; batch < 12; batch++) {
    const rs = await Promise.all(Array.from({ length: 25 }, async () => {
      const amount = 1 + Math.floor(Math.random() * 30_000), x = pick(), kind = Math.random();
      if (kind < 0.25) { const r = await t.post('/api/deposits', admin, { account_id: x, amount }); if (r.status === 201) netExternal += amount; return r; }
      if (kind < 0.5) { const r = await t.post('/api/withdrawals', owner(x), { account_id: x, amount }); if (r.status === 201) netExternal -= amount; return r; }
      let y = pick(); if (y === x) y = accts.find((a) => a !== x);
      return t.post('/api/transfers', owner(x), { from_account_id: x, to_account_id: y, amount });
    }));
    assert.ok(rs.every((r) => [201, 422].includes(r.status)), JSON.stringify(rs.find((r) => ![201, 422].includes(r.status))));
  }
  const after = (await Promise.all(accts.map(t.balance))).reduce((a, b) => a + b, 0);
  assert.equal(after, before + netExternal, 'total changes only by external deposits/withdrawals');
  assert.deepEqual(await t.conservation(), { total: 0, mismatched: [], unbalanced: [], negative: [] });
  const v = await t.api('GET', '/api/audit/verify', { token: await t.as('auditor@ledgerline.test') });
  assert.equal(v.body.ok, true, JSON.stringify(v.body.problems));
});

test('reversal: restores balances once; second reversal refused; funds floor still applies', async () => {
  const alice = await t.as(ALICE), admin = await t.as('admin@ledgerline.test');
  const A = await t.account(ALICE, 5_000), B = await t.account(BOB, 0);
  const tr = await t.post('/api/transfers', alice, { from_account_id: A, to_account_id: B, amount: 3_000 });
  const rev = await t.post(`/api/admin/transactions/${tr.body.transaction.id}/reverse`, admin, { reason: 'sent in error' });
  assert.equal(rev.status, 201);
  assert.equal(await t.balance(A), 5_000); assert.equal(await t.balance(B), 0);
  const again = await t.post(`/api/admin/transactions/${tr.body.transaction.id}/reverse`, admin, { reason: 'second try' });
  assert.equal(again.status, 409);
  // reversal that would overdraw the recipient is refused, not forced
  const tr2 = await t.post('/api/transfers', alice, { from_account_id: A, to_account_id: B, amount: 2_000 });
  const bob = await t.as(BOB);
  await t.post('/api/withdrawals', bob, { account_id: B, amount: 2_000 });
  const rev2 = await t.post(`/api/admin/transactions/${tr2.body.transaction.id}/reverse`, admin, { reason: 'too late, funds gone' });
  assert.equal(rev2.status, 422);
  assert.deepEqual(await t.conservation(), { total: 0, mismatched: [], unbalanced: [], negative: [] });
});

test('input validation: bad amounts, same-account, missing/bad key', async () => {
  const alice = await t.as(ALICE);
  const A = await t.account(ALICE, 5_000), A2 = await t.account(ALICE, 0);
  for (const amount of [-100, 0, 1.5, '100', null, 1e15, NaN, undefined]) {
    const r = await t.post('/api/withdrawals', alice, { account_id: A, amount });
    assert.equal(r.status, 400, `amount ${amount}`);
    const r2 = await t.post('/api/transfers', alice, { from_account_id: A, to_account_id: A2, amount });
    assert.equal(r2.status, 400, `transfer amount ${amount}`);
  }
  assert.equal((await t.post('/api/transfers', alice, { from_account_id: A, to_account_id: A, amount: 100 })).status, 400);
  assert.equal((await t.api('POST', '/api/withdrawals', { token: alice, body: { account_id: A, amount: 100 } })).status, 400, 'missing key');
  assert.equal((await t.post('/api/withdrawals', alice, { account_id: A, amount: 100 }, 'short')).status, 400, 'bad key');
  assert.equal(await t.balance(A), 5_000);
});

test('frozen account cannot move money', async () => {
  const alice = await t.as(ALICE), admin = await t.as('admin@ledgerline.test');
  const A = await t.account(ALICE, 5_000);
  await t.api('PATCH', `/api/admin/accounts/${A}`, { token: admin, body: { status: 'frozen' } });
  const r = await t.post('/api/withdrawals', alice, { account_id: A, amount: 100 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'account_not_active');
  assert.equal(await t.balance(A), 5_000);
});
