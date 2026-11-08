# PROMPTS.md  — REWRITE THIS IN YOUR OWN WORDS

> This is a **template pre-filled with real issues found while this codebase was produced**. The brief scores *your* evidence of directing the tool and catching it being wrong. Before submitting: (1) re-run each scenario yourself so you can explain it in the interview, (2) replace the dates and commit links with your real ones, (3) add every genuine problem *you* hit with the tool during your own changes. Do not submit entries you did not verify. You need ≥5 entries, ≥2 about money integrity/concurrency/idempotency (entries 1–4 qualify).

Entry format: **Date · Asked · Produced · What was wrong · What I did (commit)**

## 1. <date> — Row locking order (concurrency)
* Asked: "Design the transfer so two accounts are locked without deadlock."
* Produced: `SELECT … WHERE id IN ($from,$to) ORDER BY id FOR UPDATE`.
* Wrong: PostgreSQL does not guarantee rows are *locked* in `ORDER BY` order (locking happens as rows are scanned; sorting comes after), so opposite transfers can still deadlock.
* Did instead: lock one row per query in ascending id (`lockAccounts` in `src/money.js`) **and** retry on 40P01/40001. Verified with the 50×A→B / 50×B→A test. Commit: <link>

## 2. <date> — Where to record refused attempts (integrity)
* Asked: "Record refused withdrawals but roll back the money."
* Produced: roll back, then write the refusal in a *separate* transaction.
* Wrong: leaves a window where the refusal is recorded but the idempotency key is not (or vice-versa), so a retry in that window could succeed after a recorded refusal.
* Did instead: refusals are detected under the lock **before any write**, so the refusal, the idempotency response and the attempt row commit together in one transaction. Test: `refused request replays as the same refusal`. Commit: <link>

## 3. <date> — Order of checks in reversal (found by my own test)
* Asked: "Add reversals as new linked transactions."
* Produced: floor check first, then "already reversed" check.
* Wrong: a second reversal of the same transaction returned `422 insufficient_funds` instead of `409 already_reversed` (money was safe, but the answer was misleading and hid the real reason). Caught by the `reversal` test.
* Did instead: check `already_reversed` before the floor check. Commit: <link>

## 4. <date> — Would the deadlock test notice a lock-order regression? (testing)
* Asked: "Write a deadlock test."
* Produced: a test firing opposite transfers and asserting conservation.
* Concern: the engine retries on deadlock, so I suspected the test could pass even with lock ordering removed (a test that cannot fail proves nothing). Rather than assume, I removed the ordering and ran it.
* Result: it fails (retries are bounded and run out), so the test is meaningful. I then added that case to `npm run mutation` alongside removing the row lock, the floor check and the idempotency claim; all four are caught. (If your own run shows something different, write what you actually saw.) Commit: <link>

## 5. <date> — (add yours)
