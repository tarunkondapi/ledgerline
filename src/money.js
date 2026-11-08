// The money engine. EVERY movement (deposit, withdrawal, transfer, adjustment, reversal) goes through run().
//
// One DB transaction per request:
//   1. authorize (ownership lookup)            -> forbidden is recorded as an attempt, nothing else happens
//   2. claim idempotency key (insert-first)    -> a concurrent duplicate BLOCKS here until we commit/rollback
//   3. lock every touched account row, in ascending id order (no deadlocks between opposite transfers)
//   4. check status + floor UNDER THE LOCK     -> refusal is stored as the idempotent response and committed
//   5. insert transaction + entries (hash-chained), update balances, store response, record attempt
//   6. COMMIT  (deferred DB triggers re-verify: entries net to zero, balance == ledger)
import crypto from 'node:crypto';
import { HttpError, Refusal } from './errors.js';

export const MAX_AMOUNT = Number(process.env.MAX_AMOUNT_PAISE || 10_000_000_000); // Rs 10 crore
export const LARGE_AMOUNT = Number(process.env.LARGE_AMOUNT_PAISE || 10_000_000); // Rs 1 lakh -> flagged
const GENESIS = '0'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashEntry({ prev_hash, txn_id, account_id, amount, balance_after, created_at }) {
  return sha([prev_hash, txn_id, account_id, amount, balance_after, new Date(created_at).toISOString()].join('|'));
}
export const requestHash = (obj) => sha(JSON.stringify(obj));

export function validAmount(a) {
  return typeof a === 'number' && Number.isSafeInteger(a) && a > 0 && a <= MAX_AMOUNT;
}
export function validKey(k) { return typeof k === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(k); }

let externalId = null;
async function getExternalId(client) {
  if (externalId == null) externalId = (await client.query("SELECT id FROM accounts WHERE kind='external'")).rows[0]?.id;
  if (externalId == null) throw new Error('external account missing: run npm run seed');
  return externalId;
}
export const resetExternalCache = () => { externalId = null; };

async function recordAttempt(q, a) {
  await q.query(
    `INSERT INTO attempts (user_id, idempotency_key, request_hash, type, account_id, counterparty_id, amount, outcome, reason, txn_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [a.user_id, a.key ?? null, a.request_hash ?? null, a.type, a.account_id ?? null, a.counterparty_id ?? null,
     a.amount ?? null, a.outcome, a.reason ?? null, a.txn_id ?? null]);
}

/** Lock accounts one at a time in ascending id order. */
async function lockAccounts(client, ids) {
  const locked = new Map();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const { rows } = await client.query(
      `SELECT id, kind, balance, overdraft_limit, status, last_hash FROM accounts WHERE id = $1 FOR UPDATE /*M:LOCK*/`, [id]);
    if (!rows[0]) throw new Refusal(404, 'account_not_found', `account ${id} not found`);
    locked.set(id, rows[0]);
  }
  return locked;
}

/**
 * ctx = { pool, user, key, type, request, authorize(client), build(client, externalId) -> plan }
 * plan = { entries:[{account_id, amount}], memo, reverses_txn_id, flags:[...], attempt:{account_id,counterparty_id,amount}, extra }
 * Returns { status, body, replay }.
 */
export async function run(ctx) {
  for (let attempt = 1; ; attempt++) {
    try { return await runOnce(ctx); }
    catch (e) {
      if ((e.code === '40P01' || e.code === '40001') && attempt < 6) { // deadlock / serialization: safe to retry whole request
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 25 * attempt));
        continue;
      }
      throw e;
    }
  }
}

async function runOnce({ pool, user, key, type, request, authorize, build }) {
  const reqHash = requestHash({ type, ...request });
  const base = { user_id: user.id, key, request_hash: reqHash, type };
  const client = await pool.connect();
  let inTx = false;
  try {
    // 1. authorization (never trusts request-supplied identity; ownership is looked up server-side)
    try { await authorize(client); }
    catch (e) {
      if (e instanceof HttpError) {
        await recordAttempt(client, { ...base, ...(e.attemptInfo || {}), outcome: 'forbidden', reason: e.code });
      }
      throw e;
    }

    await client.query('BEGIN'); inTx = true;
    // 2. insert-first idempotency claim. On conflict, Postgres waits for the other transaction to finish.
    const claim = await client.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status) VALUES ($1,$2,$3,'in_progress')
       ON CONFLICT (user_id, key) DO NOTHING /*M:IDEM*/ RETURNING 1`, [user.id, key, reqHash]);

    if (claim.rowCount === 0) {
      const { rows: [prev] } = await client.query(
        `SELECT request_hash, response_status, response_json FROM idempotency_keys WHERE user_id=$1 AND key=$2`, [user.id, key]);
      if (prev.request_hash !== reqHash) {
        await recordAttempt(client, { ...base, outcome: 'key_conflict', reason: 'same key, different request' });
        await client.query('COMMIT'); inTx = false;
        return { status: 422, replay: false, body: { error: 'idempotency_key_reuse', message: 'This Idempotency-Key was already used with a different request.' } };
      }
      await recordAttempt(client, { ...base, ...(prev.response_json?.attempt || {}), outcome: 'replay',
        txn_id: prev.response_json?.transaction?.id ?? null, reason: 'duplicate of earlier request' });
      await client.query('COMMIT'); inTx = false;
      return { status: prev.response_status, replay: true, body: prev.response_json.body };
    }

    const ext = await getExternalId(client);
    let info = {};
    try {
      const plan = await build(client, ext);
      info = plan.attempt || {};
      // 3. lock all touched accounts in id order
      const locked = await lockAccounts(client, plan.entries.map((e) => e.account_id));
      // 4. checks under the lock
      const net = plan.entries.reduce((s, e) => s + e.amount, 0);
      if (net !== 0) throw new Error('internal: entries do not net to zero'); // programmer error, never a user error
      if (plan.reverses_txn_id) {
        const { rowCount } = await client.query('SELECT 1 FROM transactions WHERE reverses_txn_id=$1', [plan.reverses_txn_id]);
        if (rowCount) throw new Refusal(409, 'already_reversed', 'transaction already reversed');
      }
      for (const [id, acc] of locked) {
        if (acc.kind === 'external') continue;
        if (acc.status !== 'active') throw new Refusal(409, 'account_not_active', `account ${id} is ${acc.status}`);
        const delta = plan.entries.filter((e) => e.account_id === id).reduce((s, e) => s + e.amount, 0);
        if (/*M:FLOOR*/ acc.balance + delta < -acc.overdraft_limit) {
          throw new Refusal(422, 'insufficient_funds', `account ${id} would go below its limit`);
        }
      }

      // 5. write
      const { rows: [txn] } = await client.query(
        `INSERT INTO transactions (type, initiated_by, idempotency_key, memo, reverses_txn_id, flagged, flag_reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
        [type, user.id, key, plan.memo ?? null, plan.reverses_txn_id ?? null, plan.flags?.length > 0, plan.flags?.join(',') || null]);
      const state = new Map([...locked].map(([id, a]) => [id, { balance: a.balance, hash: a.last_hash }]));
      for (const e of plan.entries) {
        const s = state.get(e.account_id);
        const created_at = new Date();
        const row = { prev_hash: s.hash, txn_id: txn.id, account_id: e.account_id, amount: e.amount,
                      balance_after: s.balance + e.amount, created_at };
        const row_hash = hashEntry(row);
        await client.query(
          `INSERT INTO ledger_entries (txn_id, account_id, amount, balance_after, prev_hash, row_hash, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.txn_id, row.account_id, row.amount, row.balance_after, row.prev_hash, row_hash, created_at]);
        s.balance = row.balance_after; s.hash = row_hash;
      }
      for (const [id, s] of state) {
        await client.query('UPDATE accounts SET balance=$2, last_hash=$3 WHERE id=$1', [id, s.balance, s.hash]);
      }
      const body = { transaction: { id: txn.id, type, memo: plan.memo ?? null, flagged: plan.flags?.length > 0,
        created_at: txn.created_at, entries: plan.entries }, ...(plan.extra || {}) };
      const stored = { status: 201, body, attempt: info, transaction: { id: txn.id } };
      await client.query(`UPDATE idempotency_keys SET status='completed', response_status=201, response_json=$3 WHERE user_id=$1 AND key=$2`,
        [user.id, key, JSON.stringify(stored)]);
      await recordAttempt(client, { ...base, ...info, outcome: 'success', txn_id: txn.id });
      await client.query('COMMIT'); inTx = false; // deferred triggers run here
      return { status: 201, replay: false, body };
    } catch (e) {
      if (e instanceof Refusal) {
        // nothing but the key claim has been written: store the refusal as the idempotent answer and commit it
        const body = { error: e.code, message: e.message };
        const stored = { status: e.status, body, attempt: info };
        await client.query(`UPDATE idempotency_keys SET status='completed', response_status=$3, response_json=$4 WHERE user_id=$1 AND key=$2`,
          [user.id, key, e.status, JSON.stringify(stored)]);
        await recordAttempt(client, { ...base, ...info, outcome: 'refused', reason: e.code });
        await client.query('COMMIT'); inTx = false;
        return { status: e.status, replay: false, body };
      }
      throw e;
    }
  } catch (e) {
    if (inTx) { await client.query('ROLLBACK').catch(() => {}); inTx = false; }
    if (!(e instanceof HttpError) && e.code !== '40P01' && e.code !== '40001') {
      // unexpected failure: nothing was committed (key claim rolled back too), so a retry is safe. Record it.
      await recordAttempt(pool, { ...base, outcome: 'error', reason: String(e.code || e.message).slice(0, 200) }).catch(() => {});
    }
    throw e;
  } finally { client.release(); }
}
