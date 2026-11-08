-- Self-registration: profile fields, application status (pending auditors), account type.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organisation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active','pending','rejected','disabled'));
  END IF;
END $$;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'savings' CHECK (account_type IN ('savings','current'));
