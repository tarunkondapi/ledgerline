-- OPTIONAL, recommended in production: run the app as a least-privilege role.
-- Run as the DB owner after migrate; change the password; point DATABASE_URL at ledger_app.
-- Then even SQL injection or an app bug cannot UPDATE/DELETE ledger rows (triggers are a second layer).
CREATE ROLE ledger_app LOGIN PASSWORD 'change-me';
GRANT USAGE ON SCHEMA public TO ledger_app;
GRANT SELECT, INSERT ON ledger_entries, transactions, attempts, admin_log TO ledger_app;
GRANT SELECT, INSERT, UPDATE ON accounts, idempotency_keys TO ledger_app;
GRANT SELECT, INSERT ON users, account_owners TO ledger_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ledger_app;
GRANT SELECT, INSERT ON auth_events TO ledger_app;
GRANT SELECT, INSERT, DELETE ON payees TO ledger_app;
GRANT UPDATE ON users TO ledger_app;
GRANT SELECT, INSERT ON applied_migrations TO ledger_app;
