-- Portals, account security, saved payees, login audit trail.
ALTER TABLE users
  ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN last_login_at TIMESTAMPTZ,
  ADD COLUMN password_changed_at TIMESTAMPTZ;

CREATE TABLE payees (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id),
  account_id INT NOT NULL REFERENCES accounts(id),
  label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_id)
);

CREATE TABLE auth_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT,
  email      TEXT,
  portal     TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('success','bad_credentials','wrong_portal','disabled')),
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER auth_events_no_mutate BEFORE UPDATE OR DELETE ON auth_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER auth_events_no_truncate BEFORE TRUNCATE ON auth_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
