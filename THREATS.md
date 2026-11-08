# THREATS.md

Format: **threat → defence → test that proves it → residual risk.** Tests are in `tests/`; `npm run mutation` removes the row lock, the floor check, the idempotency claim and the lock ordering one at a time and proves the suite fails each time.

## Money
| # | Threat | Defence | Test | Residual |
|---|---|---|---|---|
| 1 | Two withdrawals race past the balance | `SELECT … FOR UPDATE` on the account, balance checked **under the lock** in the same transaction as the debit; `CHECK (balance >= -overdraft_limit)` as a backstop | `no overdraw under race` (50×₹10 vs ₹100 → exactly 10 succeed), `overdraft limit honoured` | none known |
| 2 | Check-then-act (read, decide in app, write later) | Check and write are one transaction holding the row lock | same | none |
| 3 | A→B and B→A deadlock | Locks taken one row at a time in ascending id order; whole request is retried on SQLSTATE 40P01/40001 | `deadlock-prone traffic` | Retry is bounded (5×). Verified: removing the ordering makes the deadlock test fail, so the retry does not hide a regression (mutation 4) |
| 4 | Credit lost / debit without credit | Deferred constraint trigger: entries of a transaction must sum to 0 at COMMIT; app also asserts before writing | `database itself refuses … unbalanced` | none |
| 5 | Balance edited without ledger entry | Deferred trigger: `accounts.balance` must equal latest entry's `balance_after` | same test | none |
| 6 | Crash halfway through a transfer | One transaction: debit, credit, key record commit together or not at all | atomicity by construction; fuzz test | none |
| 7 | Negative/zero/float/huge/string amounts, negative transfer | `amount` must be a safe positive integer ≤ ₹10 crore; entries `amount <> 0`; integer paise everywhere | `input validation` | none |
| 8 | Transfer to self | Rejected 400 | `input validation` | none |
| 9 | Money created through reversal/adjustment | They use the same engine: zero-sum, floor, lock, idempotency. A txn can be reversed once (unique index + check under lock) | `reversal` | An admin can adjust (flagged, reason mandatory, logged) — see accepted risks |
| 10 | Account frozen/closed still moves money | Status checked under the lock | `frozen account` | none |

## Exactly-once
| # | Threat | Defence | Test | Residual |
|---|---|---|---|---|
| 11 | Sequential retry | Stored response returned, header `Idempotent-Replay: true` | `sequential replay` (also asserts the duplicate is visible as a `replay` attempt) | none |
| 12 | Same key fired in parallel | Insert-first claim `ON CONFLICT DO NOTHING`; the loser **blocks on the unique index** until the winner commits, then reads its result. `UNIQUE(initiated_by, idempotency_key)` on `transactions` is a second wall | `parallel replay ×20` | holds a pool connection while waiting; a flood of duplicates could exhaust the pool (no per-user rate limit on money endpoints) |
| 13 | Same key, different body (change amount on replay) | Request hash compared → 422, recorded as `key_conflict` | `different body` | none |
| 14 | Using another user's key | Key scoped `(user_id, key)` | `keys are scoped per user` | none |
| 15 | Server succeeded, client timed out | Retry returns original result | replay tests | none |
| 16 | Refusal lost / refusal turns into success on retry | Refusal is committed with the key; replay returns the same refusal | `refused request replays as the same refusal` | A client wanting to retry after funds arrive must use a **new** key (documented) |
| 17 | Missing/garbage key | 400 | `input validation` | none |
| 18 | Key expiry reopening a double-pay window | Keys never expire | — | table grows without bound (accepted; purge job not built) |

## Authorisation
| # | Threat | Defence | Test |
|---|---|---|---|
| 19 | Move/read another user's money (IDOR) | Ownership looked up from `account_owners` on every request; request-body identity ignored; 404 not 403 | `one user cannot move or read another user's money` |
| 20 | Auditor/holder calls privileged writes | `requireRole` per route; role re-read from DB each request, never from token/body | `roles: auditor is read-only…` |
| 21 | Mass assignment (`role`, `balance`, `owner_id`) | Explicit field picking; user creation hard-codes role `holder` | `mass assignment` |
| 22 | Forged/expired JWT | HS256 only, 1 h expiry, user must still exist | `roles` test (garbage token) |
| 23 | Credential stuffing | bcrypt, constant-time dummy compare for unknown emails, rate limit on `/api/login` | — (manual) |
| 24 | SQL injection | Parameterised queries only; no string-built values | review |

## Ledger tampering
| # | Threat | Defence | Test | Residual |
|---|---|---|---|---|
| 25 | UPDATE/DELETE/TRUNCATE a ledger row, transaction, attempt or admin_log row | `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers raise; optional least-privilege role (`db/hardening.sql`) | `append-only` | A DB superuser/owner can drop triggers |
| 26 | Superuser alters a row anyway | Per-account SHA-256 hash chain; `/api/audit/verify` recomputes hashes, running balances, chain heads, zero-sums | `tampering … detected` (disables triggers, edits a row, verify flags it) | **A superuser who recomputes the whole chain consistently is not detected** — the hash has no secret and the head is not anchored outside the DB. Mitigation (not built): HMAC with an app-held key, or periodically publish chain heads externally |
| 27 | Fork the chain / concurrent writers | `UNIQUE(account_id, prev_hash)` + BEFORE INSERT trigger checking prev_hash and running balance | schema | none |
| 28 | Delete a refused attempt to hide it | `attempts` append-only | `append-only` | same superuser caveat |

## Portals and registration
| # | Threat | Defence | Test |
|---|---|---|---|
| 29 | Privilege escalation by self-registering as admin/auditor | Registration endpoints exist only on the holder/auditor portals and read an explicit field allowlist (no role/status); there is **no** admin registration; auditor sign-ups are `pending` until an admin approves | `holder self-registration…`, `auditor applications…` |
| 30 | Using a token from one portal on another | Tokens carry their portal; portal and role are re-checked against the database on every request; each portal has an endpoint allowlist | `each portal only signs in its own role…` |
| 31 | Disabled/pending user keeps access | Status and `disabled` re-read on every request; password change invalidates older tokens | `a disabled user is locked out immediately` |
| 32 | Racing past the 5-account limit | Per-user row lock inside the opening transaction | `account limit holds under a race` |
| 33 | Mass registration / enumeration | Per-IP rate limit; duplicate email returns 409 (reveals that an email exists — accepted) | — |
| 34 | CSV formula injection in ledger export | Text cells starting with `= + - @` are neutralised | review |

## Knowingly accepted
0. **Holders may deposit to their own accounts** to simulate external funding for the demo. It cannot break conservation (the counter-entry is EXTERNAL) but a real product would credit deposits only from a payment-gateway callback.
0. **Separate ports are network segmentation, not the security boundary**: authorisation is still decided server-side on every request. In single-port hosting the admin portal is publicly reachable at `/admin/`; protect it with a VPN/IP allow-list in production.
1. **EXTERNAL account is a hot row**: every deposit/withdrawal serialises on it (correctness unaffected, throughput limited). Transfers do not touch it. Fix would be sharded external accounts.
2. **Admin is trusted** but constrained: every admin action is flagged/logged with a reason; no maker-checker (two-person approval) built.
3. **JWTs cannot be revoked** before expiry (1 h). Role and existence are re-checked each request.
4. **Login rate-limit is in-memory per instance**; no account lockout.
5. Destination account id existence is revealed to a user who tries to transfer to it (needed for the feature).
6. `/api/audit/verify` loads all entries into memory; fine for demo volumes, not for millions of rows.
7. INR only, no holds, scheduled transfers, or AI flagging. A small system that is right beats a large one that is not.
8. Failed attempts from attackers grow the append-only `attempts` table (no rate limit on money endpoints).
