const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (p) => (p < 0 ? '−' : '') + '₹' + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const S = { token: sessionStorage.getItem('t'), user: null, accounts: [], tab: 'accounts', sel: null, kind: 'withdrawals', last: null };

const P = window.PORTAL || 'holder', BASE = window.BASE || '';
S.payees = [];
// ---------- plumbing ----------
async function api(method, path, body, key) {
  const h = { 'content-type': 'application/json' };
  if (S.token) h.authorization = 'Bearer ' + S.token;
  if (key) h['idempotency-key'] = key;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && path !== '/api/login') signOut();
  return { ok: r.ok, status: r.status, j, replay: r.headers.get('idempotent-replay') === 'true' };
}
function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 6500 : 3800);
}
const reply = (r, ok) => toast(r.ok ? ok + (r.replay ? ' · replay: nothing moved twice' : '') : `${r.j.message || 'Request failed'} (${r.j.error || r.status})`, !r.ok);
// Parse a rupee string strictly -> integer paise (or null)
function paise(v, { signed = false } = {}) {
  const m = String(v).replace(/[₹,\s]/g, '').match(signed ? /^[+-]?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/);
  if (!m) return null; const n = Math.round(parseFloat(m[0]) * 100);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}
const opts = (accts, sel) => accts.map((a) => `<option value="${a.id}" ${a.id == sel ? 'selected' : ''}>#${a.id} · ${esc(a.name)} · ${inr(a.balance)}</option>`).join('');

// ---------- auth ----------
const META = { holder: ['Customer portal', 'Open accounts, move money, track every rupee.'], admin: ['Admin console', 'People, accounts, corrections and oversight.'], auditor: ['Audit desk', 'Read-only proof of every posting.'] }[P];
const DEMO = { holder: [['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol'], ['david', 'David'], ['priya', 'Priya']], admin: [['admin', 'Admin']], auditor: [['auditor', 'Auditor'], ['auditor2', 'Auditor 2']] }[P];
document.documentElement.dataset.portal = P; document.title = 'LedgerLine · ' + META[0];
$('#heroTitle').textContent = META[0]; $('#heroTag').textContent = META[1]; $('#portalTag').textContent = META[0];
$('#demo').innerHTML = DEMO.map(([e, l]) => `<button type="button" class="chip" data-e="${e}@ledgerline.test">${l}</button>`).join('');
$('#demo').onclick = (e) => { const b = e.target.closest('[data-e]'); if (b) { $('#email').value = b.dataset.e; $('#pw').value = 'Passw0rd!demo'; } };
const MODES = { login: '#loginForm', register: '#regForm', apply: '#audForm' };
function mode(m) { Object.entries(MODES).forEach(([k, sel]) => ($(sel).hidden = k !== m)); document.querySelectorAll('#authSeg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); }
const extra = { holder: ['register', 'Register'], auditor: ['apply', 'Apply for access'] }[P];
if (extra) { $('#authSeg').hidden = false; $('#authSeg').innerHTML = `<button data-m="login">Sign in</button><button data-m="${extra[0]}">${extra[1]}</button>`; $('#authSeg').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) mode(b.dataset.m); }; }
mode('login');
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#pw').value });
  if (!r.ok) return toast(r.j.message || 'Sign-in failed', true);
  S.token = r.j.token; sessionStorage.setItem('t', S.token); start();
};
const registered = (email, msg) => { toast(msg); $('#email').value = email; $('#pw').value = ''; mode('login'); };
$('#regForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/register', { full_name: $('#rName').value, email: $('#rEmail').value, phone: $('#rPhone').value, password: $('#rPw').value, account_name: $('#rAcct').value, account_type: $('#rType').value });
  if (!r.ok) return toast(r.j.message || 'Registration failed', true);
  registered($('#rEmail').value, `Welcome, ${r.j.user.full_name}! Account #${r.j.account.id} is open. Sign in to continue.`);
};
$('#audForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/register/auditor', { full_name: $('#aName').value, email: $('#aEmail').value, phone: $('#aPhone').value, organisation: $('#aOrg').value, credential_id: $('#aCred').value, purpose: $('#aWhy').value, password: $('#aPw').value });
  if (!r.ok) return toast(r.j.message || 'Application failed', true);
  registered($('#aEmail').value, r.j.message);
};
function signOut() { sessionStorage.removeItem('t'); S.token = null; location.reload(); }
$('#out').onclick = signOut;
$('#theme').onclick = () => {
  const cur = document.documentElement.dataset.t || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.t = cur === 'dark' ? 'light' : 'dark';
};

async function start() {
  if (!S.token) return;
  const me = await api('GET', '/api/me');
  if (!me.ok) return;
  S.user = me.j;
  $('#auth').hidden = true; $('#shell').hidden = false;
  $('#whoEmail').textContent = S.user.email; $('#whoRole').textContent = S.user.role;
  const TABS = { holder: [['accounts', 'Accounts'], ['move', 'Move money'], ['payees', 'Payees'], ['profile', 'Profile']],
    admin: [['dash', 'Dashboard'], ['accounts', 'Accounts'], ['move', 'Move money'], ['people', 'People'], ['admin', 'Manage'], ['audit', 'Audit'], ['profile', 'Profile']],
    auditor: [['overview', 'Overview'], ['accounts', 'Accounts'], ['audit', 'Audit'], ['profile', 'Profile']] };
  const tabs = TABS[S.user.role];
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button class="tab" data-k="${k}">${l}</button>`).join('');
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) go(b.dataset.k); };
  go(tabs[0][0]);
}
async function loadAccounts() { S.accounts = (await api('GET', '/api/accounts')).j.accounts || []; }
async function go(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.k === tab));
  await loadAccounts();
  if (S.user.role === 'holder') S.payees = (await api('GET', '/api/payees')).j.payees || [];
  $('#view').onclick = null;
  ({ accounts: viewAccounts, move: viewMove, admin: viewAdmin, audit: viewAudit, dash: viewDash, overview: viewOverview, people: viewPeople, payees: viewPayees, profile: viewProfile })[tab]();
}

// ---------- accounts + statement ----------
function viewAccounts() {
  const total = S.accounts.reduce((s, a) => s + a.balance, 0);
  $('#view').innerHTML = `<div class="stats"><div class="stat"><span>${S.user.role === 'holder' ? 'Your total balance' : 'Total in customer accounts'}</span><b class="mono">${inr(total)}</b></div>
    <div class="stat"><span>Accounts</span><b>${S.accounts.length}</b></div></div>
    <div class="grid">${S.accounts.map((a) => `<div class="card acct ${a.id === S.sel ? 'sel' : ''}" data-id="${a.id}" tabindex="0">
      <div class="nm"><span>#${a.id} · ${esc(a.name)}</span><span class="pill ${a.status === 'active' ? '' : 'bad'}">${a.status}</span></div>
      <div class="bal ${a.balance < 0 ? 'neg' : ''}">${inr(a.balance)}</div>
      <div class="sub">${a.overdraft_limit ? 'Overdraft limit ' + inr(a.overdraft_limit) : 'No overdraft'}</div></div>`).join('') || '<div class="empty">No accounts yet.</div>'}</div>
    <div id="stmt"></div><div id="act"></div>`;
  $('#view .grid').onclick = (e) => { const c = e.target.closest('[data-id]'); if (c) { S.sel = +c.dataset.id; viewAccounts(); } };
  if (S.sel) statement(S.sel);
  if (S.user.role === 'holder') activity();
}
async function statement(id) {
  const r = await api('GET', `/api/accounts/${id}/statement`);
  if (!r.ok) return toast(r.j.message, true);
  const rows = [...r.j.items].reverse().map((i) => i.kind === 'posting'
    ? `<tr><td>${when(i.at)}</td><td>${esc(i.type)} <span class="mono sub">#${i.txn_id}</span>${i.flagged ? ' <span class="pill gold">flagged</span>' : ''}${i.reverses_txn_id ? ` <span class="sub">reverses #${i.reverses_txn_id}</span>` : ''}</td>
       <td class="n mono ${i.amount > 0 ? 'cr' : ''}">${i.amount > 0 ? '+' : ''}${inr(i.amount)}</td><td class="n mono">${inr(i.balance_after)}</td><td>${esc(i.initiated_by)}</td><td>${esc(i.memo)}</td></tr>`
    : `<tr class="ref"><td>${when(i.at)}</td><td><span class="pill bad">${esc(i.outcome.replace('_', ' '))}</span> ${esc(i.type)}</td>
       <td class="n mono">${i.amount ? inr(i.amount) : ''}</td><td class="n">—</td><td>${esc(i.initiated_by)}</td><td>${esc(i.reason)}</td></tr>`).join('');
  $('#stmt').innerHTML = `<div class="card"><h3>Statement · #${id} ${esc(r.j.account.name)}<span class="pill">${inr(r.j.account.balance)}</span></h3>
    <div class="tw"><table><tr><th>When</th><th>Entry</th><th class="n">Amount</th><th class="n">Balance</th><th>By</th><th>Note</th></tr>${rows || '<tr><td colspan="6" class="empty">No activity.</td></tr>'}</table></div>
    <p class="hint">Refused and replayed attempts are part of the record. Entries are append-only and hash-chained.</p></div>`;
}

// ---------- move money ----------
function viewMove() {
  const own = S.accounts, k = S.kind, dflt = S.sel || own[0]?.id;
  $('#view').innerHTML = `<div class="card"><h3>Move money</h3>
    <div class="seg" id="seg">${[['withdrawals', 'Withdraw'], ['deposits', 'Deposit'], ['transfers', 'Transfer']].map(([v, l]) => `<button data-k="${v}" class="${v === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="row"><label>${k === 'transfers' ? 'From account' : 'Account'}<select id="mFrom">${opts(own, dflt)}</select></label>
    ${k === 'transfers' ? `<label>To account (id)<input id="mTo" type="number" min="1" placeholder="e.g. 3" value="${S.toPre || ''}" list="ownIds"><datalist id="ownIds">${[...own.map((a) => [a.id, a.name]), ...S.payees.map((p) => [p.account_id, p.label + ' (payee)'])].map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</datalist></label>` : ''}
    <label>Amount (₹)<input id="mAmt" inputmode="decimal" placeholder="500.00"></label>
    <label>Memo (optional)<input id="mMemo" maxlength="200"></label></div>
    <p style="margin:14px 0 0"><button class="btn" id="mGo">Submit</button> <button class="btn ghost" id="mAgain" ${S.last ? '' : 'disabled'}>Resend last request (replay test)</button></p>
    <div class="key" id="mKey">${S.last ? 'Last Idempotency-Key: ' + esc(S.last.key) : 'Each submit gets a fresh Idempotency-Key; “Resend” reuses the last one and must never move money twice.'}</div></div>`;
  $('#seg').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) { S.kind = b.dataset.k; viewMove(); } };
  $('#mGo').onclick = () => {
    const amount = paise($('#mAmt').value);
    if (!amount) return toast('Enter a positive amount like 500 or 99.50', true);
    const from = +$('#mFrom').value, memo = $('#mMemo').value.trim() || undefined;
    if (k === 'transfers') {
      const to = +$('#mTo').value; if (!to) return toast('Enter the destination account id', true);
      return send('/api/transfers', { from_account_id: from, to_account_id: to, amount, memo }, crypto.randomUUID());
    }
    send('/api/' + k, { account_id: from, amount, memo }, crypto.randomUUID());
  };
  $('#mAgain').onclick = () => S.last && send(S.last.path, S.last.body, S.last.key);
}
async function send(path, body, key) {
  S.last = { path, body, key };
  const r = await api('POST', path, body, key);
  reply(r, 'Done · transaction #' + (r.j.transaction?.id ?? ''));
  await loadAccounts(); if (S.tab === 'move') viewMove(); else go(S.tab);
}

// ---------- admin ----------
function viewAdmin() {
  const form = (id, title, fields, btn) => `<div class="card"><h3>${title}</h3><div class="row">${fields}</div><p style="margin:14px 0 0"><button class="btn" id="${id}">${btn}</button></p></div>`;
  $('#view').innerHTML = `<div class="two">
    ${form('aUser', 'New account holder', '<label>Email<input id="uE" type="email"></label><label>Password (min 8)<input id="uP" type="password"></label>', 'Create holder')}
    ${form('aAcct', 'Open an account', '<label>Name<input id="cN" placeholder="Alice - Joint"></label><label>Owner email<input id="cO" type="email"></label><label>Overdraft limit (₹)<input id="cD" inputmode="decimal" value="0"></label>', 'Open account')}
    ${form('aCtl', 'Freeze / overdraft', `<label>Account<select id="kA">${opts(S.accounts)}</select></label><label>Status<select id="kS"><option value="">(unchanged)</option><option>active</option><option>frozen</option><option>closed</option></select></label><label>Overdraft (₹)<input id="kO" inputmode="decimal" placeholder="unchanged"></label>`, 'Apply')}
    ${form('aAdj', 'Adjustment (flagged)', `<label>Account<select id="jA">${opts(S.accounts)}</select></label><label>± Amount (₹)<input id="jV" inputmode="decimal" placeholder="-25.00"></label><label>Reason (required)<input id="jR"></label>`, 'Post adjustment')}
    ${form('aRev', 'Reverse a transaction', '<label>Transaction id<input id="rT" type="number" min="1"></label><label>Reason (required)<input id="rR"></label>', 'Reverse')}</div>`;
  const done = async (r, ok) => { reply(r, ok); await loadAccounts(); viewAdmin(); };
  $('#aUser').onclick = async () => done(await api('POST', '/api/admin/users', { email: $('#uE').value, password: $('#uP').value }), 'Holder created');
  $('#aAcct').onclick = async () => { const od = paise($('#cD').value || '0.01'); done(await api('POST', '/api/accounts', { name: $('#cN').value, owner_email: $('#cO').value, overdraft_limit: Number($('#cD').value) > 0 ? od : 0 }), 'Account opened'); };
  $('#aCtl').onclick = async () => {
    const body = {}; if ($('#kS').value) body.status = $('#kS').value;
    if ($('#kO').value !== '') body.overdraft_limit = Number($('#kO').value) === 0 ? 0 : paise($('#kO').value);
    done(await api('PATCH', `/api/admin/accounts/${$('#kA').value}`, body), 'Account updated');
  };
  $('#aAdj').onclick = () => { const a = paise($('#jV').value, { signed: true }); if (!a) return toast('Enter a non-zero amount like -25 or 100', true);
    send('/api/admin/adjustments', { account_id: +$('#jA').value, amount: a, reason: $('#jR').value }, crypto.randomUUID()); };
  $('#aRev').onclick = () => send(`/api/admin/transactions/${+$('#rT').value}/reverse`, { reason: $('#rR').value }, crypto.randomUUID());
}

// ---------- audit ----------
async function viewAudit() {
  $('#view').innerHTML = `<div class="card"><h3>Ledger integrity <button class="btn" id="vGo">Verify now</button></h3><div id="vOut" class="hint">Recomputes every hash chain, running balance, per-transaction zero-sum and the global invariant.</div></div>
    <div class="card"><h3>Flagged transactions</h3><div id="fOut" class="tw"></div></div>
    <div class="two"><div class="card"><h3>Duplicate requests (replays)</h3><div id="dOut" class="tw"></div></div><div class="card"><h3>Refused &amp; forbidden</h3><div id="rOut" class="tw"></div></div></div>
    <div class="card"><h3>Admin actions</h3><div id="lOut" class="tw"></div></div>
    <div class="card"><h3>Transaction browser <span><select id="tType" style="width:auto"><option value="">all types</option><option>deposit</option><option>withdrawal</option><option>transfer</option><option>adjustment</option><option>reversal</option></select> <label style="display:inline">flagged only <input id="tFlag" type="checkbox" style="width:auto"></label> <button class="btn sm" id="tGo">Search</button></span></h3><div id="tOut" class="tw"></div></div>
    <div class="card"><h3>Sign-in events <button class="btn ghost sm" id="csv">Export ledger CSV</button></h3><div id="eOut" class="tw"></div></div>`;
  $('#vGo').onclick = async () => {
    const r = await api('GET', '/api/audit/verify'); if (!r.ok) return toast(r.j.message, true);
    const s = r.j.summary;
    $('#vOut').innerHTML = `<div class="verdict ${r.j.ok ? 'ok' : 'bad'}">${r.j.ok ? '✓ Ledger verified — books balance, no tampering found' : '✗ Problems found'}</div>
      <div class="stats"><div class="stat"><span>Accounts</span><b>${s.accounts}</b></div><div class="stat"><span>Ledger entries</span><b>${s.entries}</b></div><div class="stat"><span>Sum of all balances</span><b class="mono">${s.sum_all_balances}</b></div><div class="stat"><span>Customer total = net external</span><b class="mono">${inr(s.sum_customer_balances)}</b></div></div>
      ${r.j.problems.map((p) => `<p class="bad mono">${esc(JSON.stringify(p))}</p>`).join('')}`;
  };
  const tbl = (head, rows) => rows.length ? `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>` : '<div class="empty">Nothing yet.</div>';
  const [f, d, ref, forb, l] = await Promise.all(['/api/audit/flags', '/api/audit/attempts?outcome=replay', '/api/audit/attempts?outcome=refused', '/api/audit/attempts?outcome=forbidden', '/api/audit/admin-log'].map((p) => api('GET', p)));
  $('#fOut').innerHTML = tbl(['When', 'Txn', 'Type', 'Flags', 'By', 'Memo'], (f.j.flagged || []).map((x) => `<tr><td>${when(x.created_at)}</td><td class="mono">#${x.id}</td><td>${esc(x.type)}</td><td><span class="pill gold">${esc(x.flag_reasons)}</span></td><td>${esc(x.initiated_by)}</td><td>${esc(x.memo)}</td></tr>`));
  const at = (x) => `<tr><td>${when(x.created_at)}</td><td>${esc(x.email)}</td><td>${esc(x.type)}</td><td class="mono">${x.amount ? inr(x.amount) : ''}</td><td>${esc(x.reason)}</td></tr>`;
  $('#dOut').innerHTML = tbl(['When', 'User', 'Type', 'Amount', 'Note'], (d.j.attempts || []).map(at));
  $('#rOut').innerHTML = tbl(['When', 'User', 'Type', 'Amount', 'Reason'], [...(ref.j.attempts || []), ...(forb.j.attempts || [])].sort((a, b) => b.id - a.id).slice(0, 100).map(at));
  auditExtra();
  $('#lOut').innerHTML = tbl(['When', 'Admin', 'Action', 'Detail'], (l.j.log || []).map((x) => `<tr><td>${when(x.created_at)}</td><td>${esc(x.email)}</td><td>${esc(x.action)}</td><td class="mono sub">${esc(JSON.stringify(x.detail))}</td></tr>`));
}
const statGrid = (items) => `<div class="stats">${items.map(([l, v]) => `<div class="stat"><span>${l}</span><b class="mono">${v}</b></div>`).join('')}</div>`;
async function activity() {
  const r = await api('GET', '/api/activity'); const a = r.j.activity || [];
  const max = Math.max(1, ...a.map((x) => Math.abs(x.amount)));
  $('#act').innerHTML = `<div class="card"><h3>Recent activity</h3><div class="tw"><table><tr><th>When</th><th>Account</th><th>What</th><th class="n">Amount</th><th style="width:22%"></th></tr>${a.slice(0, 12).map((x) =>
    `<tr><td>${when(x.created_at)}</td><td>${esc(x.account_name)}</td><td>${esc(x.type)}${x.memo ? ' · ' + esc(x.memo) : ''}</td><td class="n mono ${x.amount > 0 ? 'cr' : ''}">${x.amount > 0 ? '+' : ''}${inr(x.amount)}</td><td><div class="bar" style="width:${Math.max(4, Math.round(Math.abs(x.amount) / max * 100))}%;${x.amount < 0 ? 'background:var(--bad)' : ''}"></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No activity yet. Make a deposit to get started.</td></tr>'}</table></div></div>`;
}
async function viewDash() {
  const d = (await api('GET', '/api/admin/dashboard')).j;
  $('#view').innerHTML = `<div class="card"><h3>Operations · last 24 hours</h3>${statGrid([['Customer funds', inr(d.customer_total)], ['Accounts', d.accounts], ['Inactive accounts', d.inactive_accounts], ['Active users', d.active_users], ['Disabled users', d.disabled_users], ['Transactions', d.txns_24h], ['Transfer volume', inr(d.transfer_volume_24h)], ['Flagged', d.flagged_24h], ['Refused', d.refused_24h], ['Replays blocked', d.replays_24h], ['Forbidden', d.forbidden_24h], ['Failed sign-ins', d.failed_logins_24h]])}</div>
    <p class="hint">Open <b>People</b> to approve auditor applications, <b>Manage</b> to freeze accounts or post corrections, <b>Audit</b> to verify the ledger.</p>`;
}
async function viewOverview() {
  const d = (await api('GET', '/api/audit/overview')).j;
  $('#view').innerHTML = `<div class="card"><h3>Ledger overview</h3>${statGrid([['Customer funds', inr(d.total)], ['Accounts', d.accounts], ['Transactions', d.transactions], ['Last 24 hours', d.last24h], ['Flagged', d.flagged], ['Holders', d.holders], ['Auditors', d.auditors], ['Refused attempts', d.refused], ['Replays blocked', d.replays], ['Forbidden attempts', d.forbidden]])}</div><p class="hint">Use the <b>Audit</b> tab to verify the hash chains, review flagged items and export the ledger.</p>`;
}
async function viewPeople() {
  const [ap, us] = await Promise.all([api('GET', '/api/admin/applications'), api('GET', '/api/admin/users')]);
  const apps = ap.j.applications || [], users = us.j.users || [];
  $('#view').innerHTML = `<div class="card"><h3>Auditor applications <span class="pill gold">${apps.length} pending</span></h3><div class="tw">${apps.length ? `<table><tr><th>Applicant</th><th>Organisation</th><th>Credential</th><th>Purpose</th><th></th></tr>${apps.map((a) =>
    `<tr><td>${esc(a.full_name)}<br><span class="sub">${esc(a.email)} · ${esc(a.phone)}</span></td><td>${esc(a.organisation)}</td><td class="mono">${esc(a.credential_id)}</td><td>${esc(a.purpose)}</td><td><button class="btn sm" data-act="approve" data-id="${a.id}">Approve</button><button class="btn ghost sm" data-act="reject" data-id="${a.id}">Reject</button></td></tr>`).join('')}</table>` : '<div class="empty">No pending applications.</div>'}</div></div>
    <div class="card"><h3>All users</h3><div class="tw"><table><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr>${users.map((u) =>
    `<tr><td>${esc(u.full_name || '')}<br><span class="sub">${esc(u.email)}</span></td><td>${u.role}</td><td><span class="pill ${u.disabled || u.status !== 'active' ? 'bad' : ''}">${u.disabled ? 'disabled' : u.status}</span></td><td>${u.last_login_at ? when(u.last_login_at) : '—'}</td><td>${u.role === 'admin' ? '' : `<button class="btn ghost sm" data-act="toggle" data-id="${u.id}" data-d="${!u.disabled}">${u.disabled ? 'Enable' : 'Disable'}</button>${u.role === 'holder' ? `<button class="btn ghost sm" data-act="reset" data-id="${u.id}" data-e="${esc(u.email)}">Reset password</button>` : ''}`}</td></tr>`).join('')}</table></div></div>`;
  $('#view').onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; const id = b.dataset.id; let r;
    if (b.dataset.act === 'toggle') r = await api('PATCH', `/api/admin/users/${id}`, { disabled: b.dataset.d === 'true' });
    else if (b.dataset.act === 'reset') { const pw = prompt(`New password for ${b.dataset.e} (8+ characters)`); if (!pw) return; r = await api('POST', `/api/admin/users/${id}/reset-password`, { password: pw }); }
    else r = await api('POST', `/api/admin/applications/${id}/decision`, { decision: b.dataset.act });
    reply(r, 'Done'); viewPeople();
  };
}
async function viewPayees() {
  S.payees = (await api('GET', '/api/payees')).j.payees || [];
  $('#view').innerHTML = `<div class="card"><h3>Saved payees</h3><div class="row"><label>Account id<input id="pA" type="number" min="1"></label><label>Label<input id="pL" maxlength="60" placeholder="e.g. Landlord"></label><button class="btn" id="pAdd">Save payee</button></div></div>
    <div class="card"><div class="tw"><table><tr><th>Label</th><th>Account</th><th></th></tr>${S.payees.map((p) => `<tr><td>${esc(p.label)}</td><td class="mono">#${p.account_id}</td><td><button class="btn sm" data-pay="${p.account_id}">Pay</button><button class="btn ghost sm" data-del="${p.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No payees yet.</td></tr>'}</table></div></div>`;
  $('#pAdd').onclick = async () => { reply(await api('POST', '/api/payees', { account_id: Number($('#pA').value), label: $('#pL').value }), 'Payee saved'); viewPayees(); };
  $('#view').onclick = async (e) => {
    const b = e.target.closest('[data-pay],[data-del]'); if (!b) return;
    if (b.dataset.pay) { S.toPre = b.dataset.pay; S.kind = 'transfers'; document.querySelector('[data-k="move"]').click(); }
    else { reply(await api('DELETE', `/api/payees/${b.dataset.del}`), 'Payee removed'); viewPayees(); }
  };
}
async function viewProfile() {
  const u = (await api('GET', '/api/profile')).j;
  $('#view').innerHTML = `<div class="two"><div class="card"><h3>Your profile</h3><table><tr><td>Name</td><td>${esc(u.full_name || '—')}</td></tr><tr><td>Email</td><td>${esc(u.email)}</td></tr><tr><td>Role</td><td>${esc(u.role)}</td></tr>${u.organisation ? `<tr><td>Organisation</td><td>${esc(u.organisation)}</td></tr>` : ''}<tr><td>Member since</td><td>${new Date(u.created_at).toLocaleDateString('en-IN')}</td></tr></table></div>
    <div class="card"><h3>Change password</h3><div class="fm"><label>Current password<input id="cp" type="password"></label><label>New password (8+, letter and digit)<input id="np" type="password"></label><button class="btn" id="cpGo">Update password</button><p class="hint">Changing it signs out every other session.</p></div></div></div>
    ${u.role === 'holder' ? `<div class="card"><h3>Open another account <span class="sub">(up to 5)</span></h3><div class="row"><label>Name<input id="oN" placeholder="e.g. Holiday fund"></label><label>Type<select id="oT"><option value="savings">Savings</option><option value="current">Current</option></select></label><button class="btn" id="oGo">Open account</button></div></div>` : ''}`;
  $('#cpGo').onclick = async () => { const r = await api('POST', '/api/me/password', { current_password: $('#cp').value, new_password: $('#np').value }); if (r.ok) { S.token = r.j.token; sessionStorage.setItem('t', S.token); } reply(r, 'Password updated'); };
  if ($('#oGo')) $('#oGo').onclick = async () => { const r = await api('POST', '/api/me/accounts', { name: $('#oN').value, account_type: $('#oT').value }); reply(r, 'Account opened'); if (r.ok) go('accounts'); };
}
async function auditExtra() {
  const load = async () => {
    const q = new URLSearchParams(); if ($('#tType').value) q.set('type', $('#tType').value); if ($('#tFlag').checked) q.set('flagged', '1');
    const t = (await api('GET', '/api/audit/transactions?' + q)).j.transactions || [];
    $('#tOut').innerHTML = t.length ? `<table><tr><th>When</th><th>Txn</th><th>Type</th><th>Entries</th><th>By</th><th>Flags</th><th></th></tr>${t.map((x) => `<tr><td>${when(x.created_at)}</td><td class="mono">#${x.id}</td><td>${esc(x.type)}</td><td class="mono sub">${(x.entries || []).map((e) => `#${e.account_id} ${e.amount > 0 ? '+' : ''}${(e.amount / 100).toFixed(2)}`).join(' · ')}</td><td>${esc(x.initiated_by)}</td><td>${x.flagged ? `<span class="pill gold">${esc(x.flag_reasons)}</span>` : ''}</td><td>${S.user.role === 'admin' && x.type !== 'reversal' ? `<button class="btn ghost sm" data-rev="${x.id}">Reverse</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No matching transactions.</div>';
  };
  $('#tGo').onclick = load; load();
  $('#tOut').onclick = (e) => { const b = e.target.closest('[data-rev]'); if (!b) return; const reason = prompt(`Reason for reversing #${b.dataset.rev} (required)`); if (reason) send(`/api/admin/transactions/${b.dataset.rev}/reverse`, { reason }, crypto.randomUUID()); };
  $('#csv').onclick = async () => {
    const r = await fetch(BASE + '/api/audit/export/ledger.csv', { headers: { authorization: 'Bearer ' + S.token } });
    if (!r.ok) return toast('Export failed', true);
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'ledger.csv'; a.click();
  };
  const ev = (await api('GET', '/api/audit/auth-events')).j.events || [];
  $('#eOut').innerHTML = `<table><tr><th>When</th><th>Email</th><th>Portal</th><th>Outcome</th><th>IP</th></tr>${ev.slice(0, 40).map((x) => `<tr class="${x.outcome === 'success' ? '' : 'ref'}"><td>${when(x.created_at)}</td><td>${esc(x.email)}</td><td>${esc(x.portal)}</td><td>${esc(x.outcome.replace('_', ' '))}</td><td class="mono sub">${esc(x.ip)}</td></tr>`).join('')}</table>`;
}
start();
