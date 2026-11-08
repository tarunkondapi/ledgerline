# Write-up (edit to match what you actually did)

**Built**: accounts, deposits/withdrawals/transfers, per-account statements with running balance and refused attempts, three roles, admin adjustments and reversals, per-account overdraft limit, freeze/close, flagging of large/admin-on-behalf actions, hash-chained append-only ledger with verifier, minimal UI.

**Deliberately not built**: multi-currency, holds, scheduled/batch transfers, maker-checker approval, AI anomaly flagging (the brief allows it only as a suggestion that a person approves and that is itself ledgered), idempotency-key purge, external hash anchoring. Each would add surface area before the core is provably right.

**Integrity model**: see README "What guarantees what". The balance is checked and the debit written in `src/money.js` `runOnce`, inside one transaction, after `lockAccounts`. Two racing requests serialise on the account row lock; the second then sees the updated balance. The same key twice serialises on the `(user_id,key)` unique index; the second returns the stored response. Even if application code were wrong, the CHECK constraint, zero-sum trigger, balance-matches-ledger trigger, chain uniqueness and append-only triggers still hold.

**Ledger model**: double entry with an `EXTERNAL` counter-account so "total changes only by external deposits/withdrawals" is a checkable sum, not a convention.

**AI use**: see PROMPTS.md (write your own account of where it was wrong).

**Unfinished / honest gaps**: see "Knowingly accepted" in THREATS.md. Notably: a superuser who recomputes the whole hash chain is undetectable without external anchoring; EXTERNAL is a hot row.
