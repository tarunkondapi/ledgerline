-- LedgerLine schema. Money is BIGINT paise (1 INR = 100 paise). Double-entry ledger.
-- Applied by scripts/migrate.js (skipped if already applied).

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','holder','auditor')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('customer','external')),
  balance         BIGINT NOT NULL DEFAULT 0,
  overdraft_limit BIGINT NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0 AND overdraft_limit <= 100000000000),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  last_hash       TEXT NOT NULL DEFAULT repeat('0', 64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The floor, enforced by the database itself even if application code is wrong.
  CONSTRAINT no_overdraw CHECK (kind = 'external' OR balance >= -overdraft_limit),
  CONSTRAINT balance_range CHECK (balance BETWEEN -9000000000000000 AND 9000000000000000)
);
CREATE UNIQUE INDEX one_external_account ON accounts (kind) WHERE kind = 'external';

CREATE TABLE account_owners (
  account_id INT NOT NULL REFERENCES accounts(id),
  user_id    INT NOT NULL REFERENCES users(id),
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE transactions (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','transfer','adjustment','reversal')),
  initiated_by    INT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  memo            TEXT,
  reverses_txn_id BIGINT REFERENCES transactions(id),
  flagged         BOOLEAN NOT NULL DEFAULT false,
  flag_reasons    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (initiated_by, idempotency_key),
  CONSTRAINT reversal_link CHECK ((type = 'reversal') = (reverses_txn_id IS NOT NULL))
);
-- A transaction can be reversed at most once.
CREATE UNIQUE INDEX one_reversal_per_txn ON transactions (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;

CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  txn_id        BIGINT NOT NULL REFERENCES transactions(id),
  account_id    INT NOT NULL REFERENCES accounts(id),
  amount        BIGINT NOT NULL CHECK (amount <> 0),  -- signed: credit > 0, debit < 0
  balance_after BIGINT NOT NULL,
  prev_hash     TEXT NOT NULL,
  row_hash      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, prev_hash)  -- the per-account hash chain can never fork
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_txn ON ledger_entries (txn_id);

-- Every request that reached the money engine, plus refusals worth recording.
CREATE TABLE attempts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INT REFERENCES users(id),
  idempotency_key TEXT,
  request_hash    TEXT,
  type            TEXT NOT NULL,
  account_id      INT,
  counterparty_id INT,
  amount          BIGINT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','refused','replay','key_conflict','forbidden','error')),
  reason          TEXT,
  txn_id          BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attempts_account ON attempts (account_id, id);

CREATE TABLE idempotency_keys (
  user_id         INT NOT NULL REFERENCES users(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress','completed')),
  response_status INT,
  response_json   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE admin_log (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   INT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Append-only enforcement ----------
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table: % is not allowed on %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_entries','transactions','attempts','admin_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t || '_no_mutate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------- Ledger integrity triggers ----------
-- 1) Each new entry must continue its account's chain and running balance exactly.
--    (Callers hold the account row lock, so "latest entry" is stable; UNIQUE(account_id, prev_hash) backstops it.)
CREATE FUNCTION check_entry_chain() RETURNS trigger AS $$
DECLARE last_bal BIGINT; last_hash TEXT;
BEGIN
  SELECT balance_after, row_hash INTO last_bal, last_hash
    FROM ledger_entries WHERE account_id = NEW.account_id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN last_bal := 0; last_hash := repeat('0', 64); END IF;
  IF NEW.prev_hash <> last_hash THEN RAISE EXCEPTION 'ledger chain break on account %', NEW.account_id; END IF;
  IF NEW.balance_after <> last_bal + NEW.amount THEN RAISE EXCEPTION 'running balance mismatch on account %', NEW.account_id; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_chain BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION check_entry_chain();

-- 2) Every transaction's entries must sum to zero (checked at COMMIT): money is never created or lost.
CREATE FUNCTION check_txn_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE txn_id = NEW.txn_id) <> 0 THEN
    RAISE EXCEPTION 'transaction % does not net to zero', NEW.txn_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();

-- 3) A stored balance must equal the latest ledger entry's balance_after (checked at COMMIT).
CREATE FUNCTION check_balance_matches_ledger() RETURNS trigger AS $$
DECLARE expected BIGINT;
BEGIN
  SELECT COALESCE((SELECT balance_after FROM ledger_entries WHERE account_id = NEW.id ORDER BY id DESC LIMIT 1), 0) INTO expected;
  IF NEW.balance <> expected THEN
    RAISE EXCEPTION 'account % balance % does not match ledger %', NEW.id, NEW.balance, expected;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER accounts_balance_matches AFTER INSERT OR UPDATE OF balance ON accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balance_matches_ledger();

CREATE TABLE schema_meta (applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO schema_meta DEFAULT VALUES;
