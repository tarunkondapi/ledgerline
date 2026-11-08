// Seeds the external account, demo users (every role) and demo accounts/activity. Safe to re-run:
// users that already exist are skipped, so existing databases just gain the new demo users.
// Every rupee goes through the real money engine, so it is ledgered like everything else.
import { fileURLToPath } from 'node:url';
import { makePool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { run } from '../src/money.js';

export const SEED_PASSWORD = process.env.SEED_PASSWORD || 'Passw0rd!demo';
// [email, role, full name, phone, extra, accounts: [name, type, opening paise, overdraft paise]]
const USERS = [
  ['admin@ledgerline.test', 'admin', 'Asha Verma', '+91 98480 10001', {}, []],
  ['alice@ledgerline.test', 'holder', 'Alice Reddy', '+91 98480 10002', {}, [['Alice - Main', 'savings', 1_000_000, 0], ['Alice - Savings', 'savings', 0, 0]]],
  ['bob@ledgerline.test', 'holder', 'Bob Kumar', '+91 98480 10003', {}, [['Bob - Main', 'savings', 500_000, 0]]],
  ['carol@ledgerline.test', 'holder', 'Carol Fernandes', '+91 98480 10004', {}, [['Carol - Salary', 'savings', 2_500_000, 0], ['Carol - Business', 'current', 800_000, 200_000]]],
  ['david@ledgerline.test', 'holder', 'David Singh', '+91 98480 10005', {}, [['David - Main', 'savings', 750_000, 0]]],
  ['priya@ledgerline.test', 'holder', 'Priya Nair', '+91 98480 10006', {}, [['Priya - Main', 'savings', 1_800_000, 0], ['Priya - Boutique', 'current', 300_000, 500_000]]],
  ['rahul@ledgerline.test', 'holder', 'Rahul Mehta', '+91 98480 10007', {}, [['Rahul - Main', 'savings', 420_000, 0]]],
  ['meera@ledgerline.test', 'holder', 'Meera Iyer', '+91 98480 10008', {}, [['Meera - Main', 'savings', 960_000, 0]]],
  ['karthik@ledgerline.test', 'holder', 'Karthik Rao', '+91 98480 10009', {}, [['Karthik - Main', 'savings', 610_000, 0]]],
  ['auditor@ledgerline.test', 'auditor', 'Arjun Sharma', '+91 98480 10010', { organisation: 'Sharma & Co. Auditors', credential_id: 'ICAI-204518', purpose: 'Quarterly ledger review' }, []],
  ['auditor2@ledgerline.test', 'auditor', 'Neha Kapoor', '+91 98480 10011', { organisation: 'Kapoor Risk Advisory', credential_id: 'ICAI-311702', purpose: 'Fraud and anomaly review' }, []],
  ['applicant@ledgerline.test', 'auditor', 'Nikhil Joshi', '+91 98480 10012', { status: 'pending', organisation: 'Joshi Assurance LLP', credential_id: 'ICAI-488120', purpose: 'Annual statutory audit support' }, []],
];

export async function seed(pool) {
  const hash = await hashPassword(SEED_PASSWORD);
  await pool.query("INSERT INTO accounts (name, kind) SELECT 'EXTERNAL (world)', 'external' WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE kind='external')");
  const ids = {}, acct = {}, fresh = new Set();
  for (const [email, role, name, phone, x] of USERS) {
    const ins = await pool.query(`INSERT INTO users (email, password_hash, role, status, full_name, phone, organisation, credential_id, purpose)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, hash, role, x.status || 'active', name, phone, x.organisation ?? null, x.credential_id ?? null, x.purpose ?? null]);
    if (ins.rowCount) fresh.add(email);
    ids[email] = ins.rows[0]?.id ?? (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
    await pool.query('UPDATE users SET full_name = COALESCE(full_name,$2), phone = COALESCE(phone,$3) WHERE id=$1', [ids[email], name, phone]);
  }
  const admin = { id: ids['admin@ledgerline.test'], role: 'admin' };
  const post = (user, key, type, request, entries, memo) => run({ pool, user, key, type, request: { ...request, memo }, authorize: async () => {},
    build: async () => ({ entries, memo, flags: [], attempt: { account_id: entries[0].account_id, amount: Math.abs(entries[0].amount) } }) });
  const ext = (await pool.query("SELECT id FROM accounts WHERE kind='external'")).rows[0].id;

  for (const [email, , , , , accounts] of USERS) {
    if (!fresh.has(email)) continue;
    for (const [name, type, opening, od] of accounts) {
      const { rows: [a] } = await pool.query("INSERT INTO accounts (name, kind, account_type, overdraft_limit) VALUES ($1,'customer',$2,$3) RETURNING id", [name, type, od]);
      await pool.query('INSERT INTO account_owners VALUES ($1,$2)', [a.id, ids[email]]);
      acct[name] = a.id;
      if (opening) await post(admin, `seed-opening-${a.id}`, 'deposit', { account_id: a.id, amount: opening }, [{ account_id: a.id, amount: opening }, { account_id: ext, amount: -opening }], 'opening balance');
    }
  }
  if (fresh.has('carol@ledgerline.test')) { // a little history so statements and dashboards look alive
    const as = (e) => ({ id: ids[e], role: 'holder' });
    const tr = (e, n, from, to, amount, memo) => post(as(e), `seed-tr-${n}`, 'transfer', { from, to, amount }, [{ account_id: acct[from], amount: -amount }, { account_id: acct[to], amount }], memo);
    await tr('carol@ledgerline.test', 1, 'Carol - Salary', 'David - Main', 150_000, 'Rent share');
    await tr('priya@ledgerline.test', 2, 'Priya - Main', 'Carol - Business', 220_000, 'Invoice 1042');
    await tr('david@ledgerline.test', 3, 'David - Main', 'Rahul - Main', 45_000, 'Dinner split');
    await tr('meera@ledgerline.test', 4, 'Meera - Main', 'Priya - Boutique', 80_000, 'Fabric order');
    await tr('karthik@ledgerline.test', 5, 'Karthik - Main', 'Bob - Main', 120_000, 'Loan repayment');
    await post({ id: ids['rahul@ledgerline.test'], role: 'holder' }, 'seed-wd-1', 'withdrawal', { account_id: acct['Rahul - Main'], amount: 30_000 },
      [{ account_id: acct['Rahul - Main'], amount: -30_000 }, { account_id: ext, amount: 30_000 }], 'ATM cash');
  }
  console.log(`seed ok (${fresh.size} new users). Demo password: ${SEED_PASSWORD}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = makePool();
  seed(pool).then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
