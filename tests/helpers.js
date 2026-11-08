import crypto from 'node:crypto';
import { migrate } from '../scripts/migrate.js';
import { seed, SEED_PASSWORD } from '../scripts/seed.js';
import { makePool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { resetExternalCache } from '../src/money.js';

export const uuid = () => crypto.randomUUID();

export async function boot() {
  await migrate({ reset: true });
  resetExternalCache();
  const pool = makePool();
  await seed(pool);
  const base = {}, servers = [];
  for (const p of ['holder', 'admin', 'auditor']) {
    const srv = createApp(pool, p).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    base[p] = `http://127.0.0.1:${srv.address().port}`; servers.push(srv);
  }
  const portalOf = (email) => (email.startsWith('admin@') ? 'admin' : /^auditor\d*@/.test(email) ? 'auditor' : 'holder');
  const tokens = {}, tokenPortal = {};
  const api = async (method, path, { token, body, key, portal } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const res = await fetch(base[portal || tokenPortal[token] || 'holder'] + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, replay: res.headers.get('idempotent-replay') === 'true' };
  };
  const loginAt = (email, password, portal) => api('POST', '/api/login', { body: { email, password }, portal });
  const as = async (email) => {
    if (!tokens[email]) {
      const portal = portalOf(email);
      const r = await loginAt(email, SEED_PASSWORD, portal);
      tokens[email] = r.body.token; tokenPortal[r.body.token] = portal;
    }
    return tokens[email];
  };
  const post = (path, token, body, key = uuid()) => api('POST', path, { token, body, key });
  const balance = async (id) => Number((await pool.query('SELECT balance FROM accounts WHERE id=$1', [id])).rows[0].balance);
  /** create a holder-owned account and fund it through the real API */
  const account = async (ownerEmail, funds = 0, overdraft = 0) => {
    const admin = await as('admin@ledgerline.test');
    const r = await api('POST', '/api/accounts', { token: admin, body: { name: 'acct', owner_email: ownerEmail, overdraft_limit: overdraft } });
    if (funds) await post('/api/deposits', admin, { account_id: r.body.id, amount: funds });
    return r.body.id;
  };
  const conservation = async () => {
    const [{ s }] = (await pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM ledger_entries')).rows;
    const bad = (await pool.query(`SELECT a.id FROM accounts a WHERE a.balance <> COALESCE((SELECT SUM(amount) FROM ledger_entries e WHERE e.account_id=a.id),0)`)).rows;
    const unbal = (await pool.query('SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING SUM(amount)<>0')).rows;
    const neg = (await pool.query("SELECT id FROM accounts WHERE kind='customer' AND balance < -overdraft_limit")).rows;
    return { total: s, mismatched: bad, unbalanced: unbal, negative: neg };
  };
  const close = async () => { servers.forEach((x) => x.close()); await pool.end(); };
  return { api, as, post, pool, balance, account, conservation, close, loginAt, portalOf, tokenPortal };
}
