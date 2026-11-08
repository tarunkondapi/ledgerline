# LedgerLine — money movement with a ledger you can prove

Node 22 + Express + **PostgreSQL**. Double-entry ledger in integer paise. The database enforces the invariants; the app is a thin layer on top.

## What guarantees what
* **Atomicity / isolation**: one DB transaction per request. Every touched account row is locked (`FOR UPDATE`) in ascending id order; the balance check and the debit happen under that lock. Deadlocks are retried.
* **Floor**: app check under the lock **and** `CHECK (balance >= -overdraft_limit)`. Default overdraft is 0; admins can set a per-account limit.
* **Conservation**: double entry. A deferred constraint trigger rejects any transaction whose entries do not sum to 0; another rejects any balance that does not equal the latest ledger `balance_after`. Deposits/withdrawals post against an `EXTERNAL` account, so all balances always sum to 0 and customer balances = net external inflow.
* **Idempotency**: `Idempotency-Key` required; insert-first claim `(user_id,key)` inside the money transaction; duplicates block on the unique index and get the stored response; same key + different body = 422. Duplicates are visible as `replay` rows in `attempts`.
* **Provable history**: `ledger_entries`, `transactions`, `attempts`, `admin_log` are append-only (triggers on UPDATE/DELETE/TRUNCATE). Each entry is hash-chained per account; `GET /api/audit/verify` recomputes everything. Corrections are linked reversals, never edits.
* **Refused attempts** (insufficient funds, frozen, key reuse, forbidden) are recorded and shown on the statement.

See `THREATS.md` (what can break, what stops it, what is accepted), `API.md` (who may call what), `WRITEUP.md`.

## Roles
| | Admin | Holder | Auditor |
|---|---|---|---|
| View accounts/statements | all | own only | all (read-only) |
| Deposit / withdraw / transfer | any account (flagged) | own accounts (transfer: source must be own) | no |
| Create accounts/users, freeze, set overdraft | yes (logged) | no | no |
| Adjust / reverse (reason mandatory, flagged) | yes | no | no |
| Verify ledger, flags, attempts, admin log | yes | no | yes |

## Three portals, three ports
Each role has its **own portal, port and API surface**. A portal only signs in users of its own role, its tokens are rejected by the other portals, and each exposes only the endpoints that role needs (the holder portal has no audit or admin API at all).

| Portal | Local URL | Who | Binds to |
|---|---|---|---|
| Customer portal | http://localhost:3000 | account holders (can **Register**) | all interfaces |
| Admin console | http://localhost:3001 | administrators | 127.0.0.1 only (set `ADMIN_HOST` to expose) |
| Audit desk | http://localhost:3002 | auditors (can **Apply for access**) | 127.0.0.1 only (set `AUDITOR_HOST` to expose) |

On hosts that provide a single `PORT` (Render, Railway), the server mounts the same three portals by path: `/holder/`, `/admin/`, `/auditor/`. They remain separate apps with separate token audiences. In production, put the admin portal behind a VPN or IP allow-list.

**Registration.** Holders register themselves (full name, email, phone, password, first account name and type) and get a working ₹0 account immediately. Auditors can read every account, so an auditor application (name, organisation, licence id, purpose) is **pending** until an administrator approves it under *People*.

**Features by portal.** Holder: accounts and statements, move money, saved payees, activity chart, profile, change password, open up to 5 accounts. Admin: operations dashboard, people (approve auditor applications, disable/enable users, reset holder passwords), open/freeze accounts, adjustments, reversals, full audit tools. Auditor: ledger overview, verify hash chains, transaction browser, flagged items, duplicates and refusals, sign-in events, ledger CSV export. All read-only.

## Demo credentials (seeded)
Password for every demo user: `Passw0rd!demo` (override with `SEED_PASSWORD`).

| Portal | Users |
|---|---|
| Admin | admin@ledgerline.test |
| Customer | alice@, bob@, carol@, david@, priya@, rahul@, meera@, karthik@ `ledgerline.test` (varied balances, some with overdraft/current accounts, with transfer history) |
| Auditor | auditor@, auditor2@ `ledgerline.test` |
| Pending auditor application (approve it in Admin → People) | applicant@ledgerline.test |

## Run locally
```bash
git clone <your-repo> && cd ledgerline
npm install
docker compose up -d db                      # or use any PostgreSQL 14+
cp .env.example .env                         # then export the vars, e.g.:  set -a; source .env; set +a
npm start                                    # migrates, seeds, serves the 3 portals on :3000 / :3001 / :3002
```
## Tests
```bash
docker compose exec db createdb -U ledger ledgerline_test   # once
export TEST_DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledgerline_test
npm test               # 25 tests: races, replays, deadlock, fuzz conservation, IDOR, roles, append-only, tamper detection
npm run mutation       # removes lock / floor check / idempotency claim / lock ordering one at a time; each must make the suite FAIL
```
`TEST_DATABASE_URL` must name a database containing "test": it is **wiped** on every run.

## Deploy (Render, ~5 minutes)
1. Push to GitHub. Render → **New → Blueprint** → select the repo (`render.yaml` creates Postgres + web service; `npm start` migrates and seeds).
2. Open the service URL; log in with the demo users. Put that URL here: `https://<your-app>.onrender.com`.
3. Production hardening (recommended): run `db/hardening.sql` as the DB owner (creates `ledger_app` with no UPDATE/DELETE on ledger tables), set the service `DATABASE_URL` to that role, and change `SEED_PASSWORD` **before the first deploy** if the URL is public.
Railway/Fly/Neon/Supabase work the same: set `DATABASE_URL`, `JWT_SECRET`, `PGSSL=true`, `TRUST_PROXY=1`, start command `npm start`. A `Dockerfile` is included. Free Render instances sleep; open the URL once before a demo.

## Layout
`db/schema.sql` schema+triggers · `src/money.js` the engine (read this first) · `src/app.js` routes/authz · `src/audit.js` verifier · `scripts/` migrate, seed, tests, mutation · `tests/` · `public/` minimal UI.
