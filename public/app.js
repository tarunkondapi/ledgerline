const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (p) => (p < 0 ? '−' : '') + '₹' + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const S = { token: sessionStorage.getItem('t'), user: null, accounts: [], tab: 'accounts', sel: null, kind: 'withdrawals', last: null };

// ---------- plumbing ----------
async function api(method, path, body, key) {
  const h = { 'content-type': 'application/json' };
  if (S.token) h.authorization = 'Bearer ' + S.token;
  if (key) h['idempotency-key'] = key;
  const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
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
const DEMO = [['admin@ledgerline.test', 'Admin'], ['alice@ledgerline.test', 'Alice (holder)'], ['bob@ledgerline.test', 'Bob (holder)'], ['auditor@ledgerline.test', 'Auditor']];
$('#demo').innerHTML = DEMO.map(([e, l]) => `<button type="button" class="chip" data-e="${e}">${l}</button>`).join('');
$('#demo').onclick = (e) => { const b = e.target.closest('[data-e]'); if (b) { $('#email').value = b.dataset.e; $('#pw').value = 'Passw0rd!demo'; } };
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#pw').value });
  if (!r.ok) return toast(r.j.message || 'Sign-in failed', true);
  S.token = r.j.token; sessionStorage.setItem('t', S.token); start();
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
  const tabs = [['accounts', 'Accounts'], ...(S.user.role !== 'auditor' ? [['move', 'Move money']] : []),
    ...(S.user.role === 'admin' ? [['admin', 'Admin']] : []), ...(S.user.role !== 'holder' ? [['audit', 'Audit']] : [])];
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button class="tab" data-k="${k}">${l}</button>`).join('');
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) go(b.dataset.k); };
  go('accounts');
}
async function loadAccounts() { S.accounts = (await api('GET', '/api/accounts')).j.accounts || []; }
async function go(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.k === tab));
  await loadAccounts();
  ({ accounts: viewAccounts, move: viewMove, admin: viewAdmin, audit: viewAudit })[tab]();
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
    <div id="stmt"></div>`;
  $('#view .grid').onclick = (e) => { const c = e.target.closest('[data-id]'); if (c) { S.sel = +c.dataset.id; viewAccounts(); } };
  if (S.sel) statement(S.sel);
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
    ${k === 'transfers' ? `<label>To account (id)<input id="mTo" type="number" min="1" placeholder="e.g. 3" list="ownIds"><datalist id="ownIds">${own.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</datalist></label>` : ''}
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
    <div class="card"><h3>Admin actions</h3><div id="lOut" class="tw"></div></div>`;
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
  $('#lOut').innerHTML = tbl(['When', 'Admin', 'Action', 'Detail'], (l.j.log || []).map((x) => `<tr><td>${when(x.created_at)}</td><td>${esc(x.email)}</td><td>${esc(x.action)}</td><td class="mono sub">${esc(JSON.stringify(x.detail))}</td></tr>`));
}
start();
