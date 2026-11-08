// Portal-specific features: holder (payees, activity), admin (users, dashboard), audit (trace, login history, exports), everyone (password).
import { HttpError } from './errors.js';
import { requireRole, changePassword, hashPassword } from './auth.js';

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const pid = (s) => { const n = Number(s); if (!isId(n)) throw new HttpError(400, 'bad_request', 'invalid id'); return n; };
// CSV with spreadsheet-formula-injection protection (text cells starting with = + - @ are neutralised)
const cell = (v) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';

export function registerExtra(app, { pool, auth, wrap, portal }) {
  // ----- everyone: change own password (invalidates every older token) -----
  app.post('/api/me/password', auth, wrap(async (req, res) => {
    res.json(await changePassword(pool, req.user, portal, req.body?.current_password, req.body?.new_password));
  }));

  // ----- holder -----
  const holder = [auth, requireRole('holder')];
  app.get('/api/payees', ...holder, wrap(async (req, res) => {
    res.json({ payees: (await pool.query('SELECT id, account_id, label FROM payees WHERE user_id=$1 ORDER BY label', [req.user.id])).rows });
  }));
  app.post('/api/payees', ...holder, wrap(async (req, res) => {
    const { account_id, label } = req.body || {};
    if (!isId(account_id) || typeof label !== 'string' || !label.trim() || label.length > 60) throw new HttpError(400, 'bad_request', 'account_id and a label (1-60 chars) required');
    if (!(await pool.query("SELECT 1 FROM accounts WHERE id=$1 AND kind='customer'", [account_id])).rowCount) throw new HttpError(404, 'account_not_found', 'Account not found');
    const { rows: [p] } = await pool.query(`INSERT INTO payees (user_id, account_id, label) VALUES ($1,$2,$3)
      ON CONFLICT (user_id, account_id) DO UPDATE SET label=EXCLUDED.label RETURNING id, account_id, label`, [req.user.id, account_id, label.trim()]);
    res.status(201).json(p);
  }));
  app.delete('/api/payees/:id', ...holder, wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM payees WHERE id=$1 AND user_id=$2', [pid(req.params.id), req.user.id]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Payee not found');
    res.json({ deleted: true });
  }));
  app.get('/api/activity', ...holder, wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT e.id, e.account_id, a.name AS account_name, e.txn_id, t.type, t.memo, e.amount, e.balance_after, e.created_at
      FROM ledger_entries e JOIN accounts a ON a.id=e.account_id JOIN transactions t ON t.id=e.txn_id
      WHERE e.account_id IN (SELECT account_id FROM account_owners WHERE user_id=$1) ORDER BY e.id DESC LIMIT 50`, [req.user.id]);
    res.json({ activity: rows });
  }));

  // ----- admin -----
  const admin = [auth, requireRole('admin')];
  app.get('/api/admin/users', ...admin, wrap(async (_req, res) => {
    res.json({ users: (await pool.query(`SELECT u.id, u.email, u.role, u.disabled, u.status, u.full_name, u.phone, u.last_login_at, u.created_at,
      (SELECT count(*) FROM account_owners o WHERE o.user_id=u.id) AS accounts FROM users u ORDER BY u.id`)).rows });
  }));
  async function targetUser(req, { holdersOnly = false } = {}) {
    const id = pid(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'bad_request', 'You cannot do this to your own account');
    const { rows: [u] } = await pool.query('SELECT id, email, role FROM users WHERE id=$1', [id]);
    if (!u) throw new HttpError(404, 'not_found', 'User not found');
    if (holdersOnly && u.role !== 'holder') throw new HttpError(409, 'not_allowed', 'Only account holders can be changed this way');
    return u;
  }
  app.patch('/api/admin/users/:id', ...admin, wrap(async (req, res) => {
    const u = await targetUser(req);
    if (typeof req.body?.disabled !== 'boolean') throw new HttpError(400, 'bad_request', 'disabled (boolean) required');
    await pool.query('UPDATE users SET disabled=$2 WHERE id=$1', [u.id, req.body.disabled]);
    await pool.query('INSERT INTO admin_log (admin_id, action, detail) VALUES ($1,$2,$3)', [req.user.id, req.body.disabled ? 'disable_user' : 'enable_user', { user_id: u.id, email: u.email }]);
    res.json({ id: u.id, disabled: req.body.disabled });
  }));
  app.post('/api/admin/users/:id/reset-password', ...admin, wrap(async (req, res) => {
    const u = await targetUser(req, { holdersOnly: true });
    const pw = req.body?.password;
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 100) throw new HttpError(400, 'bad_request', 'password must be 8-100 characters');
    await pool.query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [u.id, await hashPassword(pw)]);
    await pool.query('INSERT INTO admin_log (admin_id, action, detail) VALUES ($1,$2,$3)', [req.user.id, 'reset_password', { user_id: u.id, email: u.email }]);
    res.json({ reset: true });
  }));
  app.get('/api/admin/dashboard', ...admin, wrap(async (_req, res) => {
    const { rows: [d] } = await pool.query(`SELECT
      (SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind='customer') AS customer_total,
      (SELECT count(*) FROM accounts WHERE kind='customer') AS accounts,
      (SELECT count(*) FROM accounts WHERE kind='customer' AND status<>'active') AS inactive_accounts,
      (SELECT count(*) FROM users WHERE NOT disabled) AS active_users,
      (SELECT count(*) FROM users WHERE disabled) AS disabled_users,
      (SELECT count(*) FROM transactions WHERE created_at > now() - interval '24 hours') AS txns_24h,
      (SELECT COALESCE(SUM(e.amount),0) FROM ledger_entries e JOIN transactions t ON t.id=e.txn_id WHERE t.type='transfer' AND e.amount>0 AND t.created_at > now() - interval '24 hours') AS transfer_volume_24h,
      (SELECT count(*) FROM transactions WHERE flagged AND created_at > now() - interval '24 hours') AS flagged_24h,
      (SELECT count(*) FROM attempts WHERE outcome='refused' AND created_at > now() - interval '24 hours') AS refused_24h,
      (SELECT count(*) FROM attempts WHERE outcome='replay' AND created_at > now() - interval '24 hours') AS replays_24h,
      (SELECT count(*) FROM attempts WHERE outcome='forbidden' AND created_at > now() - interval '24 hours') AS forbidden_24h,
      (SELECT count(*) FROM auth_events WHERE outcome<>'success' AND created_at > now() - interval '24 hours') AS failed_logins_24h`);
    res.json(d);
  }));

  // ----- audit (admin + auditor, strictly read-only) -----
  const audit = [auth, requireRole('admin', 'auditor')];
  app.get('/api/audit/transactions', ...audit, wrap(async (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const flagged = req.query.flagged === '1';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const { rows } = await pool.query(`SELECT t.id, t.type, t.memo, t.flagged, t.flag_reasons, t.reverses_txn_id, t.created_at, u.email AS initiated_by,
      (SELECT json_agg(json_build_object('account_id', e.account_id, 'amount', e.amount) ORDER BY e.id) FROM ledger_entries e WHERE e.txn_id=t.id) AS entries
      FROM transactions t JOIN users u ON u.id=t.initiated_by
      WHERE ($1::text IS NULL OR t.type=$1) AND (NOT $2 OR t.flagged) ORDER BY t.id DESC LIMIT $3`, [type, flagged, limit]);
    res.json({ transactions: rows });
  }));
  app.get('/api/audit/transactions/:id', ...audit, wrap(async (req, res) => {
    const id = pid(req.params.id);
    const { rows: [t] } = await pool.query('SELECT t.*, u.email AS initiated_by_email FROM transactions t JOIN users u ON u.id=t.initiated_by WHERE t.id=$1', [id]);
    if (!t) throw new HttpError(404, 'not_found', 'Transaction not found');
    const entries = (await pool.query('SELECT e.id, e.account_id, a.name AS account_name, e.amount, e.balance_after, e.prev_hash, e.row_hash, e.created_at FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE e.txn_id=$1 ORDER BY e.id', [id])).rows;
    const attempts = (await pool.query('SELECT id, user_id, outcome, reason, created_at FROM attempts WHERE txn_id=$1 ORDER BY id', [id])).rows;
    const reversedBy = (await pool.query('SELECT id FROM transactions WHERE reverses_txn_id=$1', [id])).rows[0]?.id ?? null;
    const { initiated_by, ...rest } = t;
    res.json({ transaction: rest, entries, attempts, reversed_by: reversedBy, net: entries.reduce((s, e) => s + e.amount, 0) });
  }));
  app.get('/api/audit/auth-events', ...audit, wrap(async (_req, res) => {
    res.json({ events: (await pool.query('SELECT id, email, portal, outcome, ip, created_at FROM auth_events ORDER BY id DESC LIMIT 300')).rows });
  }));
  app.get('/api/audit/export/ledger.csv', ...audit, wrap(async (_req, res) => {
    const { rows } = await pool.query(`SELECT e.id AS entry_id, e.txn_id, t.type, e.account_id, e.amount, e.balance_after, u.email AS initiated_by,
      t.flagged, t.memo, e.created_at, e.row_hash FROM ledger_entries e JOIN transactions t ON t.id=e.txn_id JOIN users u ON u.id=t.initiated_by ORDER BY e.id LIMIT 50000`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ledger.csv"' });
    res.send(toCsv(['entry_id', 'txn_id', 'type', 'account_id', 'amount', 'balance_after', 'initiated_by', 'flagged', 'memo', 'created_at', 'row_hash'], rows));
  }));
}
