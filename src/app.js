import express from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.js';
import { authenticate, requireRole, login, hashPassword } from './auth.js';
import { registerExtra } from './extra.js';
import { run, validAmount, validKey, LARGE_AMOUNT, MAX_AMOUNT } from './money.js';
import { verifyLedger } from './audit.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const pid = (s) => { const n = Number(s); if (!isId(n)) throw new HttpError(400, 'bad_request', 'invalid id'); return n; };
const str = (v, min, max, name) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new HttpError(400, 'bad_request', `${name} must be a string of ${min}-${max} chars`);
  return v.trim();
};

export function createApp(pool, portal, { base = '' } = {}) {
  if (!['holder', 'admin', 'auditor'].includes(portal)) throw new Error('portal must be holder, admin or auditor');
  const app = express();
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" });
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  const pub = (d) => fileURLToPath(new URL('../public/' + d, import.meta.url));
  app.use('/shared', express.static(pub('shared')));
  app.get('/portal.js', (_req, res) => res.type('js').send(`window.PORTAL=${JSON.stringify(portal)};window.BASE=${JSON.stringify(base)};`));
  app.use(express.static(pub(portal)));
  const auth = authenticate(pool, portal);
  // Each portal exposes ONLY its own API surface; everything else is 404 (smaller attack surface than one big API).
  const allowed = {
    holder: (m, p) => /^\/(login|me|health|payees|activity|deposits|withdrawals|transfers|profile)(\/|$)/.test(p) || (m === 'POST' && p === '/register') || (m === 'GET' && /^\/accounts(\/|$)/.test(p)),
    admin: (m, p) => /^\/(login|me|health|profile|deposits|withdrawals|transfers|accounts|admin|audit)(\/|$)/.test(p),
    auditor: (m, p) => /^\/(login|me|health|profile)(\/|$)/.test(p) || (m === 'POST' && p === '/register/auditor') || (m === 'GET' && /^\/(accounts|audit)(\/|$)/.test(p)),
  }[portal];
  app.use('/api', (req, _res, next) => (allowed(req.method, req.path) ? next() : next(new HttpError(404, 'not_found', 'No such endpoint'))));

  app.get('/api/health', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

  app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT || 30),
      standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many login attempts' } }),
    wrap(async (req, res) => res.json(await login(pool, req.body?.email, req.body?.password, portal, req.ip))));
  app.get('/api/me', auth, (req, res) => res.json({ ...req.user, portal }));

  // ---------- access helper: holders only see/touch accounts in account_owners; admin/auditor see all ----------
  async function accountAccess(q, user, accountId, { write = false } = {}) {
    const { rows: [a] } = await q.query(
      `SELECT a.id, a.name, a.kind, a.balance, a.overdraft_limit, a.status,
              EXISTS (SELECT 1 FROM account_owners o WHERE o.account_id = a.id AND o.user_id = $2) AS owned
         FROM accounts a WHERE a.id = $1 AND a.kind = 'customer'`, [accountId, user.id]);
    const deny = () => Object.assign(new HttpError(404, 'account_not_found', 'Account not found'), { attemptInfo: { account_id: accountId } });
    if (!a) throw deny();
    if (user.role === 'admin') return a;
    if (user.role === 'holder' && a.owned) return a;
    if (user.role === 'auditor' && !write) return a;
    throw deny(); // 404, not 403: do not reveal which ids exist
  }

  // ---------- accounts ----------
  app.get('/api/accounts', auth, wrap(async (req, res) => {
    const sql = `SELECT a.id, a.name, a.balance, a.overdraft_limit, a.status FROM accounts a WHERE a.kind='customer'`;
    const { rows } = req.user.role === 'holder'
      ? await pool.query(sql + ' AND EXISTS (SELECT 1 FROM account_owners o WHERE o.account_id=a.id AND o.user_id=$1) ORDER BY a.id', [req.user.id])
      : await pool.query(sql + ' ORDER BY a.id');
    res.json({ accounts: rows });
  }));

  app.get('/api/accounts/:id', auth, wrap(async (req, res) => {
    const a = await accountAccess(pool, req.user, pid(req.params.id));
    const { owned, ...rest } = a; res.json(rest);
  }));

  app.get('/api/accounts/:id/statement', auth, wrap(async (req, res) => {
    const id = pid(req.params.id);
    const a = await accountAccess(pool, req.user, id);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);
    const showForbidden = req.user.role !== 'holder';
    const postings = (await pool.query(
      `SELECT e.id, e.txn_id, e.amount, e.balance_after, e.created_at, t.type, t.memo, t.flagged, t.reverses_txn_id, u.email AS initiated_by
         FROM ledger_entries e JOIN transactions t ON t.id = e.txn_id JOIN users u ON u.id = t.initiated_by
        WHERE e.account_id = $1 ORDER BY e.id DESC LIMIT $2`, [id, limit])).rows
      .map((r) => ({ kind: 'posting', ...r, at: r.created_at }));
    const refused = (await pool.query(
      `SELECT a.id, a.type, a.amount, a.outcome, a.reason, a.idempotency_key, a.txn_id, a.created_at, u.email AS initiated_by
         FROM attempts a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.account_id = $1 AND a.outcome IN ('refused','replay','key_conflict'${showForbidden ? ",'forbidden'" : ''})
        ORDER BY a.id DESC LIMIT $2`, [id, limit])).rows
      .map((r) => ({ kind: 'attempt', ...r, at: r.created_at }));
    const items = [...postings, ...refused].sort((x, y) => new Date(x.at) - new Date(y.at) || (x.kind === 'posting' ? -1 : 1));
    const { owned, ...acct } = a;
    res.json({ account: acct, items });
  }));

  app.post('/api/accounts', auth, requireRole('admin'), wrap(async (req, res) => {
    const name = str(req.body?.name, 1, 80, 'name');
    const ownerEmail = str(req.body?.owner_email, 3, 200, 'owner_email').toLowerCase();
    const od = req.body?.overdraft_limit ?? 0;
    if (!Number.isSafeInteger(od) || od < 0 || od > 1e11) throw new HttpError(400, 'bad_request', 'overdraft_limit must be an integer in paise >= 0');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [owner] } = await c.query("SELECT id FROM users WHERE email=$1 AND role='holder'", [ownerEmail]);
      if (!owner) throw new HttpError(404, 'owner_not_found', 'No holder user with that email');
      const { rows: [acc] } = await c.query(`INSERT INTO accounts (name, kind, overdraft_limit) VALUES ($1,'customer',$2) RETURNING id, name, balance, overdraft_limit, status`, [name, od]);
      await c.query('INSERT INTO account_owners VALUES ($1,$2)', [acc.id, owner.id]);
      await c.query('INSERT INTO admin_log (admin_id, action, detail) VALUES ($1,$2,$3)', [req.user.id, 'create_account', { account_id: acc.id, owner: ownerEmail, overdraft_limit: od }]);
      await c.query('COMMIT'); res.status(201).json(acc);
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  app.post('/api/admin/users', auth, requireRole('admin'), wrap(async (req, res) => {
    const email = str(req.body?.email, 3, 200, 'email').toLowerCase();
    const password = str(req.body?.password, 8, 100, 'password');
    const role = req.body?.role === 'auditor' ? 'auditor' : 'holder'; // allowlist: an admin can never mint another admin
    const hash = await hashPassword(password);
    const { rows: [u] } = await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role', [email, hash, role])
      .catch((e) => { if (e.code === '23505') throw new HttpError(409, 'email_taken', 'Email already registered'); throw e; });
    await pool.query('INSERT INTO admin_log (admin_id, action, detail) VALUES ($1,$2,$3)', [req.user.id, 'create_user', { user_id: u.id, email }]);
    res.status(201).json(u);
  }));

  app.patch('/api/admin/accounts/:id', auth, requireRole('admin'), wrap(async (req, res) => {
    const id = pid(req.params.id); const { status, overdraft_limit } = req.body || {};
    if (status === undefined && overdraft_limit === undefined) throw new HttpError(400, 'bad_request', 'status or overdraft_limit required');
    if (status !== undefined && !['active', 'frozen', 'closed'].includes(status)) throw new HttpError(400, 'bad_request', 'bad status');
    if (overdraft_limit !== undefined && (!Number.isSafeInteger(overdraft_limit) || overdraft_limit < 0 || overdraft_limit > 1e11)) throw new HttpError(400, 'bad_request', 'bad overdraft_limit');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [cur] } = await c.query("SELECT status, overdraft_limit FROM accounts WHERE id=$1 AND kind='customer' FOR UPDATE", [id]);
      if (!cur) throw new HttpError(404, 'account_not_found', 'Account not found');
      const { rows: [acc] } = await c.query('UPDATE accounts SET status=COALESCE($2,status), overdraft_limit=COALESCE($3,overdraft_limit) WHERE id=$1 RETURNING id, name, balance, overdraft_limit, status', [id, status ?? null, overdraft_limit ?? null]);
      await c.query('INSERT INTO admin_log (admin_id, action, detail) VALUES ($1,$2,$3)', [req.user.id, 'update_account', { account_id: id, before: cur, after: { status: acc.status, overdraft_limit: acc.overdraft_limit } }]);
      await c.query('COMMIT'); res.json(acc);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e.code === '23514') throw new HttpError(409, 'would_violate_floor', 'Change would put the balance below the overdraft floor');
      throw e;
    } finally { c.release(); }
  }));

  // ---------- money movement ----------
  async function money(req, res, spec) {
    const key = req.get('Idempotency-Key');
    if (!key) throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
    if (!validKey(key)) throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-128 chars of A-Za-z0-9_.:-');
    const r = await run({ pool, user: req.user, key, ...spec });
    if (r.replay) res.set('Idempotent-Replay', 'true');
    res.status(r.status).json(r.body);
  }
  const amountOf = (b) => { if (!validAmount(b?.amount)) throw new HttpError(400, 'invalid_amount', `amount must be a positive integer number of paise <= ${MAX_AMOUNT}`); return b.amount; };
  const memoOf = (b) => (b?.memo == null ? null : str(b.memo, 0, 200, 'memo'));
  const flagsFor = (user, owned, amount) => [
    ...(amount >= LARGE_AMOUNT ? ['large_amount'] : []),
    ...(user.role === 'admin' && !owned ? ['admin_on_behalf'] : [])];
  const noAuditor = requireRole('admin', 'holder');

  const single = (type, sign) => [auth, noAuditor, wrap(async (req, res) => {
    const account_id = req.body?.account_id; const amount = amountOf(req.body); const memo = memoOf(req.body);
    if (!isId(account_id)) throw new HttpError(400, 'bad_request', 'account_id required');
    let acct;
    await money(req, res, {
      type, request: { account_id, amount, memo },
      authorize: async (c) => { acct = await accountAccess(c, req.user, account_id, { write: true }); },
      build: async (_c, ext) => ({
        entries: [{ account_id, amount: sign * amount }, { account_id: ext, amount: -sign * amount }], memo,
        flags: flagsFor(req.user, acct.owned, amount), attempt: { account_id, amount } }),
    });
  })];
  app.post('/api/deposits', ...single('deposit', +1));
  app.post('/api/withdrawals', ...single('withdrawal', -1));

  app.post('/api/transfers', auth, noAuditor, wrap(async (req, res) => {
    const { from_account_id: from, to_account_id: to } = req.body || {};
    const amount = amountOf(req.body); const memo = memoOf(req.body);
    if (!isId(from) || !isId(to)) throw new HttpError(400, 'bad_request', 'from_account_id and to_account_id required');
    if (from === to) throw new HttpError(400, 'same_account', 'Cannot transfer to the same account');
    let src;
    await money(req, res, {
      type: 'transfer', request: { from, to, amount, memo },
      authorize: async (c) => {
        src = await accountAccess(c, req.user, from, { write: true }); // must own the SOURCE
        const { rowCount } = await c.query("SELECT 1 FROM accounts WHERE id=$1 AND kind='customer'", [to]);
        if (!rowCount) throw Object.assign(new HttpError(404, 'account_not_found', 'Destination account not found'), { attemptInfo: { account_id: from, counterparty_id: to, amount } });
      },
      build: async () => ({
        entries: [{ account_id: from, amount: -amount }, { account_id: to, amount }], memo,
        flags: flagsFor(req.user, src.owned, amount), attempt: { account_id: from, counterparty_id: to, amount } }),
    });
  }));

  app.post('/api/admin/adjustments', auth, requireRole('admin'), wrap(async (req, res) => {
    const { account_id, amount } = req.body || {};
    const reason = str(req.body?.reason, 5, 200, 'reason');
    if (!isId(account_id)) throw new HttpError(400, 'bad_request', 'account_id required');
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_AMOUNT) throw new HttpError(400, 'invalid_amount', 'amount must be a non-zero signed integer in paise');
    await money(req, res, {
      type: 'adjustment', request: { account_id, amount, reason },
      authorize: async (c) => { await accountAccess(c, req.user, account_id, { write: true }); },
      build: async (_c, ext) => ({ entries: [{ account_id, amount }, { account_id: ext, amount: -amount }], memo: reason,
        flags: ['admin_adjustment'], attempt: { account_id, amount } }),
    });
  }));

  app.post('/api/admin/transactions/:id/reverse', auth, requireRole('admin'), wrap(async (req, res) => {
    const txnId = pid(req.params.id); const reason = str(req.body?.reason, 5, 200, 'reason');
    await money(req, res, {
      type: 'reversal', request: { txnId, reason },
      authorize: async (c) => {
        const { rowCount } = await c.query('SELECT 1 FROM transactions WHERE id=$1', [txnId]);
        if (!rowCount) throw new HttpError(404, 'transaction_not_found', 'Transaction not found');
      },
      build: async (c, ext) => {
        const { rows: [orig] } = await c.query('SELECT type FROM transactions WHERE id=$1', [txnId]);
        if (orig.type === 'reversal') throw new (await import('./errors.js')).Refusal(409, 'cannot_reverse_reversal', 'A reversal cannot be reversed; post a new transaction');
        const { rows } = await c.query('SELECT account_id, amount FROM ledger_entries WHERE txn_id=$1 ORDER BY id', [txnId]);
        const first = rows.find((r) => r.account_id !== ext) || rows[0];
        return { entries: rows.map((r) => ({ account_id: r.account_id, amount: -r.amount })), memo: reason, reverses_txn_id: txnId,
          flags: ['admin_reversal'], attempt: { account_id: first.account_id, amount: Math.abs(first.amount) } };
      },
    });
  }));

  // ---------- audit (admin + auditor, read-only) ----------
  const audit = [auth, requireRole('admin', 'auditor')];
  app.get('/api/audit/verify', ...audit, wrap(async (_req, res) => res.json(await verifyLedger(pool))));
  app.get('/api/audit/flags', ...audit, wrap(async (_req, res) => {
    const { rows } = await pool.query(`SELECT t.id, t.type, t.flag_reasons, t.memo, t.created_at, u.email AS initiated_by,
      (SELECT json_agg(json_build_object('account_id', e.account_id, 'amount', e.amount)) FROM ledger_entries e WHERE e.txn_id=t.id) AS entries
      FROM transactions t JOIN users u ON u.id=t.initiated_by WHERE t.flagged ORDER BY t.id DESC LIMIT 200`);
    res.json({ flagged: rows });
  }));
  app.get('/api/audit/attempts', ...audit, wrap(async (req, res) => {
    const outcome = req.query.outcome;
    const { rows } = await pool.query(`SELECT a.*, u.email FROM attempts a LEFT JOIN users u ON u.id=a.user_id
      WHERE ($1::text IS NULL OR a.outcome=$1) ORDER BY a.id DESC LIMIT 500`, [typeof outcome === 'string' ? outcome : null]);
    res.json({ attempts: rows });
  }));
  app.get('/api/audit/admin-log', ...audit, wrap(async (_req, res) => {
    const { rows } = await pool.query('SELECT l.*, u.email FROM admin_log l JOIN users u ON u.id=l.admin_id ORDER BY l.id DESC LIMIT 200');
    res.json({ log: rows });
  }));

  registerExtra(app, { pool, auth, wrap, portal });

  // ---------- registration (self-service) ----------
  const regLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.REGISTER_RATE_LIMIT || 30), standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many registrations from this address' } });
  const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;
  function person(b) { // explicit allowlist: role/status/balance in the body are never read
    const email = str(b?.email, 5, 200, 'email').toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'bad_request', 'email is not valid');
    const password = str(b?.password, 8, 100, 'password');
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new HttpError(400, 'weak_password', 'Password needs at least 8 characters with a letter and a digit');
    const phone = str(b?.phone, 7, 20, 'phone'); if (!/^[+0-9\s-]{7,20}$/.test(phone)) throw new HttpError(400, 'bad_request', 'phone is not valid');
    return { email, password, phone, full_name: str(b?.full_name, 2, 80, 'full_name') };
  }
  const only = (...ps) => (_req, _res, next) => (ps.includes(portal) ? next() : next(new HttpError(404, 'not_found', 'No such endpoint')));
  const taken = (e) => { if (e.code === '23505') throw new HttpError(409, 'email_taken', 'That email is already registered'); throw e; };

  app.post('/api/register', only('holder'), regLimit, wrap(async (req, res) => {
    const p = person(req.body);
    const accName = str(req.body?.account_name, 1, 80, 'account_name');
    const accType = req.body?.account_type;
    if (!['savings', 'current'].includes(accType)) throw new HttpError(400, 'bad_request', 'account_type must be savings or current');
    const hash = await hashPassword(p.password);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [u] } = await c.query("INSERT INTO users (email, password_hash, role, full_name, phone) VALUES ($1,$2,'holder',$3,$4) RETURNING id, email, role, full_name", [p.email, hash, p.full_name, p.phone]);
      const { rows: [a] } = await c.query("INSERT INTO accounts (name, kind, account_type) VALUES ($1,'customer',$2) RETURNING id, name, account_type, balance", [accName, accType]);
      await c.query('INSERT INTO account_owners VALUES ($1,$2)', [a.id, u.id]);
      await c.query('COMMIT'); res.status(201).json({ user: u, account: a });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); taken(e); } finally { c.release(); }
  }));

  app.post('/api/register/auditor', only('auditor'), regLimit, wrap(async (req, res) => {
    const p = person(req.body);
    const org = str(req.body?.organisation, 2, 120, 'organisation'), cred = str(req.body?.credential_id, 3, 60, 'credential_id'), purpose = str(req.body?.purpose, 10, 300, 'purpose');
    const hash = await hashPassword(p.password);
    // Auditors can read EVERY account, so applications start 'pending' and cannot sign in until an admin approves.
    await pool.query("INSERT INTO users (email, password_hash, role, status, full_name, phone, organisation, credential_id, purpose) VALUES ($1,$2,'auditor','pending',$3,$4,$5,$6,$7)",
      [p.email, hash, p.full_name, p.phone, org, cred, purpose]).catch(taken);
    res.status(202).json({ status: 'pending', message: 'Application received. An administrator must approve it before you can sign in.' });
  }));

  // ---------- profile + self-service accounts ----------
  app.get('/api/profile', auth, wrap(async (req, res) => {
    const { rows: [u] } = await pool.query('SELECT id, email, role, full_name, phone, organisation, created_at FROM users WHERE id=$1', [req.user.id]);
    res.json(u);
  }));
  app.post('/api/me/accounts', auth, requireRole('holder'), wrap(async (req, res) => {
    const name = str(req.body?.name, 1, 80, 'name');
    if (!['savings', 'current'].includes(req.body?.account_type)) throw new HttpError(400, 'bad_request', 'account_type must be savings or current');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [req.user.id]); // serialises concurrent opens: limit cannot be raced
      const { rows: [{ n }] } = await c.query('SELECT count(*)::int n FROM account_owners WHERE user_id=$1', [req.user.id]);
      if (n >= 5) throw new HttpError(409, 'account_limit', 'You can hold at most 5 accounts');
      const { rows: [a] } = await c.query("INSERT INTO accounts (name, kind, account_type) VALUES ($1,'customer',$2) RETURNING id, name, account_type, balance, status", [name, req.body.account_type]);
      await c.query('INSERT INTO account_owners VALUES ($1,$2)', [a.id, req.user.id]);
      await c.query('COMMIT'); res.status(201).json(a);
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- admin: auditor applications ----------
  app.get('/api/admin/applications', auth, requireRole('admin'), wrap(async (_req, res) => {
    const { rows } = await pool.query("SELECT id, email, full_name, phone, organisation, credential_id, purpose, created_at FROM users WHERE role='auditor' AND status='pending' ORDER BY id");
    res.json({ applications: rows });
  }));
  app.post('/api/admin/applications/:id/decision', auth, requireRole('admin'), wrap(async (req, res) => {
    const id = pid(req.params.id), d = req.body?.decision;
    if (!['approve', 'reject'].includes(d)) throw new HttpError(400, 'bad_request', 'decision must be approve or reject');
    const { rows: [u] } = await pool.query("UPDATE users SET status=$2 WHERE id=$1 AND role='auditor' AND status='pending' RETURNING id, email, status", [id, d === 'approve' ? 'active' : 'rejected']);
    if (!u) throw new HttpError(409, 'invalid_transition', 'No pending application with that id');
    await pool.query('INSERT INTO admin_log (admin_id, action, detail) VALUES ($1,$2,$3)', [req.user.id, d + '_auditor_application', { user_id: id, email: u.email }]);
    res.json(u);
  }));

  // ---------- admin + auditor: dashboards ----------
  app.get('/api/audit/overview', auth, requireRole('admin', 'auditor'), wrap(async (_req, res) => {
    const q = async (s) => (await pool.query(s)).rows[0];
    const [a, t, f, u, p] = await Promise.all([
      q("SELECT count(*)::int accounts, COALESCE(sum(balance),0) total FROM accounts WHERE kind='customer'"),
      q("SELECT count(*)::int transactions, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int last24h FROM transactions"),
      q('SELECT count(*)::int flagged FROM transactions WHERE flagged'),
      q("SELECT count(*) FILTER (WHERE role='holder')::int holders, count(*) FILTER (WHERE role='auditor' AND status='active')::int auditors, count(*) FILTER (WHERE status='pending')::int pending FROM users"),
      q("SELECT count(*) FILTER (WHERE outcome='refused')::int refused, count(*) FILTER (WHERE outcome='replay')::int replays, count(*) FILTER (WHERE outcome='forbidden')::int forbidden FROM attempts")]);
    res.json({ ...a, ...t, ...f, ...u, ...p });
  }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint')));
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'bad_request', message: 'Invalid JSON body' });
    if (err.code === '23514') return res.status(409).json({ error: 'constraint_violation', message: 'Refused by database integrity constraint' });
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Internal error. Nothing was committed; it is safe to retry with the same Idempotency-Key.' });
  });
  return app;
}
