import { hashEntry } from './money.js';

/** Recompute everything from the ledger and compare with stored state. Read-only, consistent snapshot. */
export async function verifyLedger(pool) {
  const c = await pool.connect();
  const problems = [];
  const add = (p) => { if (problems.length < 50) problems.push(p); };
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: accounts } = await c.query('SELECT id, kind, balance, last_hash FROM accounts ORDER BY id');
    const { rows: entries } = await c.query('SELECT * FROM ledger_entries ORDER BY account_id, id');
    const byAcc = new Map(accounts.map((a) => [a.id, { acc: a, bal: 0, hash: '0'.repeat(64), n: 0 }]));
    for (const e of entries) {
      const s = byAcc.get(e.account_id);
      if (e.prev_hash !== s.hash) add({ account_id: e.account_id, entry_id: e.id, problem: 'chain_break (prev_hash mismatch)' });
      s.bal += e.amount;
      if (e.balance_after !== s.bal) add({ account_id: e.account_id, entry_id: e.id, problem: 'running_balance_mismatch' });
      const h = hashEntry(e);
      if (h !== e.row_hash) add({ account_id: e.account_id, entry_id: e.id, problem: 'row_hash_mismatch (row was altered)' });
      s.hash = e.row_hash; s.n++;
    }
    for (const s of byAcc.values()) {
      if (s.acc.balance !== s.bal) add({ account_id: s.acc.id, problem: `stored balance ${s.acc.balance} != sum(entries) ${s.bal}` });
      if (s.acc.last_hash !== s.hash) add({ account_id: s.acc.id, problem: 'last_hash does not match chain head (entries removed or appended)' });
    }
    const { rows: unbalanced } = await c.query('SELECT txn_id, SUM(amount) AS s FROM ledger_entries GROUP BY txn_id HAVING SUM(amount) <> 0 LIMIT 20');
    unbalanced.forEach((r) => add({ txn_id: r.txn_id, problem: `transaction nets to ${r.s}, not 0` }));
    const { rows: empty } = await c.query('SELECT t.id FROM transactions t LEFT JOIN ledger_entries e ON e.txn_id = t.id WHERE e.id IS NULL LIMIT 20');
    empty.forEach((r) => add({ txn_id: r.id, problem: 'transaction has no entries' }));
    const total = accounts.reduce((s, a) => s + a.balance, 0);
    const customers = accounts.filter((a) => a.kind === 'customer').reduce((s, a) => s + a.balance, 0);
    const external = accounts.find((a) => a.kind === 'external')?.balance ?? 0;
    if (total !== 0) add({ problem: `sum of all balances is ${total}, expected 0` });
    if (customers !== -external) add({ problem: 'customer balances != net external deposits - withdrawals' });
    await c.query('COMMIT');
    return {
      ok: problems.length === 0, problems,
      summary: { accounts: accounts.length, entries: entries.length, sum_all_balances: total,
                 sum_customer_balances: customers, net_external_inflow: -external },
    };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
