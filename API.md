# API reference

All endpoints are JSON. Auth: `Authorization: Bearer <token>` from `POST /api/login`. Money is **integer paise** (₹1 = 100). Every money-moving endpoint **requires** an `Idempotency-Key` header (8–128 chars of `A-Za-z0-9_.:-`, use a UUID).

Roles: **A**=admin, **H**=account holder, **U**=auditor (read-only). "own" = listed in `account_owners`, decided by the server on every request. A holder touching an account they do not own gets **404** (indistinguishable from "does not exist").

| Method & path | Who | Effect on money |
|---|---|---|
| `POST /api/login` `{email,password}` | anyone (rate-limited) | none |
| `GET /api/me` | any | none |
| `GET /api/accounts` | A,U: all · H: own | none |
| `GET /api/accounts/:id` | A,U: any · H: own | none |
| `GET /api/accounts/:id/statement?limit=` | A,U: any · H: own | none. Postings (running balance, initiator) + refused/replayed/conflicting attempts. A/U also see `forbidden` attempts |
| `POST /api/accounts` `{name,owner_email,overdraft_limit?}` | A | none (opens a ₹0 account; logged in `admin_log`) |
| `POST /api/admin/users` `{email,password}` | A | none. Always creates role `holder` |
| `PATCH /api/admin/accounts/:id` `{status?,overdraft_limit?}` | A | none. Freeze/close/limit. Refused (409) if it would break the floor. Logged |
| `POST /api/deposits` `{account_id,amount,memo?}` | A: any · H: own | **+amount** to account, **−amount** to EXTERNAL |
| `POST /api/withdrawals` `{account_id,amount,memo?}` | A: any (flagged) · H: own | **−amount** from account (floor enforced), **+amount** to EXTERNAL |
| `POST /api/transfers` `{from_account_id,to_account_id,amount,memo?}` | A: any (flagged) · H: **source** must be own | **−amount** source, **+amount** destination; nets to zero, EXTERNAL untouched |
| `POST /api/admin/adjustments` `{account_id,amount(±),reason}` | A | signed correction vs EXTERNAL; floor enforced; always flagged; `reason` mandatory |
| `POST /api/admin/transactions/:id/reverse` `{reason}` | A | new linked transaction negating the original; once per original; floor enforced; never edits history |
| `GET /api/audit/verify` | A,U | none. Recomputes hash chains, running balances, per-txn zero-sum, global zero-sum |
| `GET /api/audit/flags` | A,U | none. Large (≥ ₹1 lakh), admin-on-behalf, adjustments, reversals |
| `GET /api/audit/attempts?outcome=` | A,U | none. `success, refused, replay, key_conflict, forbidden, error` — duplicates are `replay` |
| `GET /api/audit/admin-log` | A,U | none |
| `GET /api/health` | anyone | none |

## Money-endpoint responses
* `201` `{transaction:{id,type,memo,flagged,created_at,entries:[{account_id,amount}]}}`
* `Idempotent-Replay: true` header when the answer is a stored replay (money did **not** move again).
* `400` validation (`invalid_amount`, `missing_idempotency_key`, `same_account`, …) · `401` · `403` wrong role · `404` not yours / not found
* `422 insufficient_funds` (recorded in ledger as a refused attempt; replaying the key returns the same refusal)
* `422 idempotency_key_reuse` same key, different request · `409 account_not_active | already_reversed | cannot_reverse_reversal`
* `500` nothing was committed; safe to retry with the same key.

Idempotency semantics: key is scoped per user; the request is hashed (type + fields); a retry that arrives while the first is in flight **waits** on the database unique index and then receives the first result. Keys are kept forever (no expiry), so there is no "replay after expiry pays twice" window.

## Portals and registration
Every endpoint above exists only on the portals listed in the roles column; elsewhere it returns **404**. Tokens carry their portal and are rejected on any other.

| Method & path | Portal | Who | Effect |
|---|---|---|---|
| `POST /api/register` `{full_name,email,phone,password,account_name,account_type}` | holder | anyone (rate-limited) | creates a holder and a ₹0 account they own. `role` in the body is ignored |
| `POST /api/register/auditor` `{full_name,email,phone,organisation,credential_id,purpose,password}` | auditor | anyone (rate-limited) | creates a **pending** auditor; cannot sign in until approved |
| `GET /api/admin/applications` · `POST /api/admin/applications/:id/decision {decision: approve\|reject}` | admin | A | review auditor applications (logged in `admin_log`) |
| `GET /api/admin/users` · `PATCH /api/admin/users/:id {disabled}` · `POST /api/admin/users/:id/reset-password` | admin | A | people management; disabling takes effect on the next request |
| `GET /api/admin/dashboard` · `GET /api/audit/overview` | admin / admin+auditor | | read-only counters |
| `GET /api/audit/transactions?type=&flagged=1` · `/api/audit/auth-events` · `/api/audit/export/ledger.csv` | admin, auditor | | read-only |
| `GET /api/profile` · `POST /api/me/password` | all | any signed-in user | change password invalidates older tokens |
| `POST /api/me/accounts {name,account_type}` | holder | H | opens another ₹0 account (max 5, race-safe) |
| `GET/POST/DELETE /api/payees` · `GET /api/activity` | holder | H | saved payees and recent activity (own accounts only) |
